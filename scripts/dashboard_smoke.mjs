#!/usr/bin/env node
/*
 * Browser smoke test for the dashboard, run in CI with Playwright's Chromium.
 *
 * Serves the checkout on 127.0.0.1 (so the core JSON comes from this commit,
 * exactly as Pages would publish it), opens index.html past the development
 * gate, and checks what unit tests cannot: that every third-party script
 * actually loads under its pinned Subresource Integrity hash, that pdf.js
 * renders a saved PDF, that each view draws without a script error, that a
 * comparison finishes, and that the phone layout has no sideways scroll.
 * Screenshots go to the directory in SMOKE_ARTIFACTS (default ./smoke-artifacts).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.env.SMOKE_ARTIFACTS || "smoke-artifacts");
fs.mkdirSync(OUT, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".ics": "text/calendar", ".pdf": "application/pdf", ".txt": "text/plain" };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end("not found"); return;
  }
  response.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port + "/";

const failures = [];
// In GitHub Actions each result is also an annotation, readable without the log.
const annotate = (level, message) => { if (process.env.GITHUB_ACTIONS) console.log("::" + level + " title=Dashboard smoke::" + message.replace(/\r?\n/g, " ")); };
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log((condition ? "ok   " : "FAIL ") + message);
  annotate(condition ? "notice" : "error", (condition ? "ok: " : "FAIL: ") + message);
};

const browser = await chromium.launch();
async function openDashboard(viewport) {
  const context = await browser.newContext({ viewport });
  // The development gate only keeps casual visitors out; tests open it the way an unlocked tab is.
  await context.addInitScript(() => { try { sessionStorage.setItem("cs-dev-access-v1", "granted"); } catch (_) {} });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push("page error: " + error.message));
  page.on("console", message => {
    if (message.type() === "error" && /integrity|Refused to|SyntaxError|TypeError|ReferenceError/i.test(message.text())) errors.push("console: " + message.text());
  });
  await page.goto(base + "index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const lede = document.getElementById("overviewLede");
    return lede && !/Reading the latest stored scan/.test(lede.textContent);
  }, null, { timeout: 45000 });
  return { context, page, errors };
}

try {
  const { context, page, errors } = await openDashboard({ width: 1440, height: 900 });
  const status = await page.textContent("#connectionStatus");
  check(!/unavailable/i.test(status), "monitoring data loads (" + status.trim() + ")");
  check(await page.evaluate(() => !!(window.supabase && typeof window.supabase.createClient === "function")),
    "supabase-js loads under its integrity hash");
  await page.screenshot({ path: path.join(OUT, "overview-desktop.png") });

  const pdf = await page.evaluate(async () => {
    try {
      const lib = await loadPdfJs();
      const item = state.items.find(entry => entry.extraction_type === "pdf" && entry.file_snapshot_location);
      if (!item) return { skipped: "no saved PDF in the inventory" };
      const response = await fetchImmutable(item.file_snapshot_location);
      const doc = await openPdf(lib, new Uint8Array(await response.arrayBuffer()));
      const pdfPage = await doc.getPage(1);
      const viewport = pdfPage.getViewport({ scale: 0.6 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const text = await pdfPage.getTextContent();
      const pages = doc.numPages;
      await releasePdf(doc);
      return { version: lib.version, pages, items: text.items.length };
    } catch (error) {
      return { error: String(error && error.message || error) };
    }
  });
  if (pdf.skipped) console.log("skip " + pdf.skipped);
  else check(!pdf.error && pdf.pages > 0 && pdf.items > 0, "pdf.js " + (pdf.version || "") + " loads under its integrity hash and renders a saved PDF " + JSON.stringify(pdf));

  for (const view of ["changes", "monitors", "runs", "notifications", "scout", "overview"]) {
    await page.click('.rail [data-view="' + view + '"]');
    await page.waitForTimeout(400);
    const visible = await page.evaluate(name => {
      const id = { overview: "overviewView", changes: "changesView", monitors: "monitorsView", runs: "runsView", notifications: "notificationsView", scout: "scoutView" }[name];
      const section = document.getElementById(id);
      return !!section && !section.hidden && section.getBoundingClientRect().height > 0;
    }, view);
    check(visible, "the " + view + " view renders");
    await page.screenshot({ path: path.join(OUT, "view-" + view + ".png") });
  }

  await page.click('.rail [data-view="changes"]');
  const firstChange = await page.$("#changeItems [data-select-change]");
  if (firstChange) {
    await firstChange.click();
    await page.waitForSelector("#change-evidence", { timeout: 15000 });
    const compare = await page.$('[data-diff-mode="compare"]');
    if (compare) {
      await compare.click();
      const done = await page.waitForFunction(() => {
        const statusLine = document.querySelector("#change-evidence .cmp-status");
        return statusLine && statusLine.textContent && !/Loading both versions|Comparing the words|Reading both versions/.test(statusLine.textContent);
      }, null, { timeout: 60000 }).then(() => true, () => false);
      check(done, "a before/after comparison finishes");
    } else {
      await page.waitForSelector("#change-evidence .redline, #change-evidence .rl-empty", { timeout: 20000 });
      check(true, "a redline renders");
    }
    await page.screenshot({ path: path.join(OUT, "change-detail.png"), fullPage: false });
  } else {
    console.log("skip no recorded change to open");
  }
  errors.forEach(message => check(false, message));
  await context.close();

  const phone = await openDashboard({ width: 390, height: 844 });
  const layout = await phone.page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    nav: (() => { const nav = document.querySelector(".rail-nav"); const box = nav && nav.getBoundingClientRect(); return box ? { top: box.top, bottom: box.bottom } : null; })(),
    height: window.innerHeight
  }));
  check(layout.overflow <= 1, "the phone layout has no sideways scroll (" + layout.overflow + "px)");
  check(!!layout.nav && layout.nav.bottom <= layout.height + 1 && layout.nav.top > layout.height / 2, "the phone navigation sits at the bottom of the screen");
  await phone.page.screenshot({ path: path.join(OUT, "overview-phone.png") });
  phone.errors.forEach(message => check(false, message));
  await phone.context.close();
} catch (error) {
  check(false, "the smoke test itself failed: " + String(error && error.stack || error).slice(0, 600));
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error("\n" + failures.length + " dashboard smoke check(s) failed.");
  process.exit(1);
}
console.log("\nDashboard smoke test passed.");
