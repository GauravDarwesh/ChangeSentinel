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
// A stand-in for the page reader, so the explorer can be exercised without
// reading a real site or spending the deployed function's budget.
function fakeReaderPage(url) {
  const links = [{ url: "https://www.example.gov/forms/a.pdf", text: "Form A", section: "Forms", format: "PDF", chrome: false },
    { url: "https://www.example.gov/guidance", text: "Guidance", section: "Forms", format: "Web page", chrome: false }];
  const html = "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'\"></head><body>" +
    "<h1>Reader copy of " + url + "</h1><p><a id=\"l0\" data-cs-link=\"0\" href=\"https://www.example.gov/forms/a.pdf\">Form A</a></p>" +
    "<p><a id=\"l1\" data-cs-link=\"1\" href=\"https://www.example.gov/guidance\">Guidance</a></p></body></html>";
  return { kind: "page", url, title: "Reader copy", html, links, truncated: false };
}
async function openDashboard(viewport, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: !!options.touch, isMobile: !!options.touch });
  await context.route(/\/functions\/v1\/page-reader/, async route => {
    const body = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(fakeReaderPage(body.url || "")) });
  });
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

  for (const view of ["changes", "monitors", "runs", "notifications", "scout", "calendar", "overview"]) {
    await page.click('.rail [data-view="' + view + '"]');
    await page.waitForTimeout(400);
    const visible = await page.evaluate(name => {
      const id = { overview: "overviewView", changes: "changesView", monitors: "monitorsView", runs: "runsView", notifications: "notificationsView", scout: "scoutView", calendar: "calendarView" }[name];
      const section = document.getElementById(id);
      return !!section && !section.hidden && section.getBoundingClientRect().height > 0;
    }, view);
    check(visible, "the " + view + " view renders");
    await page.screenshot({ path: path.join(OUT, "view-" + view + ".png") });
    if (view === "overview") {
      // A closed dialog must not be drawn: it would cover the page and swallow clicks.
      const closedHidden = await page.evaluate(() => {
        const dialog = document.getElementById("addMonitorDialog");
        return !!dialog && !dialog.open && dialog.getBoundingClientRect().height === 0;
      });
      check(closedHidden, "the closed Add a link dialog is not drawn on the page");
      // Add a link opens on its first step with both ways to find links.
      await page.click('.rail [data-add-monitor]');
      const dialogReady = await page.evaluate(() => {
        const dialog = document.getElementById("addMonitorDialog");
        return !!dialog && dialog.open && !!dialog.querySelector('input[value="explore"]') && !!dialog.querySelector('input[value="crawl"]') &&
          (document.getElementById("exploreFrame").getAttribute("sandbox") || "") === "allow-scripts";
      });
      check(dialogReady, "Add a link offers Explore and Follow by level, with an opaque-origin frame");
      await page.keyboard.press("Escape");
    }
    if (view === "calendar") {
      await page.click('[data-calendar-mode="upcoming"]');
      const upcomingVisible = await page.waitForFunction(() => {
        const panel = document.getElementById("cadenceUpcomingView");
        const toggle = document.querySelector('[data-calendar-mode="upcoming"]');
        return panel && !panel.hidden && toggle && toggle.getAttribute("aria-pressed") === "true";
      }, null, { timeout: 10000 }).then(() => true, () => false);
      check(upcomingVisible, "Cadence Upcoming & overdue view switches on");
      const upcomingReady = await page.evaluate(() => {
        const list = document.getElementById("cadenceUpcomingList");
        return !!list && list.children.length > 0 && !!document.getElementById("cadenceUpcomingCount").textContent;
      });
      check(upcomingReady, "Cadence Upcoming & overdue list renders an empty state or entries");
      const scenario = await page.evaluate(() => {
        const previous = {
          entries: state.cadenceEntries, calendar: state.calendar,
          search: state.cadenceSearch, filter: state.cadenceFilter,
          panel: state.cadencePanel, month: state.cadenceMonth,
          selectedDate: state.cadenceSelectedDate,
          searchInput: $("cadenceSearch").value, typeInput: $("cadenceTypeFilter").value
        };
        const today = L.localIsoDate(new Date());
        const entry = (id, title, category, offset, owner) => ({
          id, title, category, recurrence: "none",
          start_date: cadenceAddDays(today, offset), end_date: null,
          regulator: "FR Y-14Q", owner_name: owner || "QA owner",
          source_url: "https://example.com/regulatory-form",
          description: "Synthetic Cadence smoke-test note",
          completed_dates: [], archived: false, reminder_enabled: false
        });
        try {
          state.cadenceEntries = [
            entry("smoke-overdue", "Cadence smoke overdue", "internal_task", -3, "QA owner"),
            entry("smoke-today", "Cadence smoke today", "deadline", 0, "Regulatory team"),
            entry("smoke-week", "Cadence smoke week", "internal_task", 4, "Regulatory team"),
            entry("smoke-later", "Cadence smoke later", "expected_update", 30, "Regulatory team")
          ];
          state.calendar = { schema_version: 1, entries: [{
            date: cadenceAddDays(today, 5), title: "Cadence smoke detected", event_id: "", url: "https://example.com/detected-date"
          }] };
          state.cadenceSearch = "";
          state.cadenceFilter = "ALL";
          state.cadencePanel = "upcoming";
          renderCadenceView();
          const sections = Array.from(document.querySelectorAll("#cadenceUpcomingList .cadence-upcoming-group"));
          const groups = Object.fromEntries(sections.map(section => [section.querySelector("h3").textContent, section.textContent]));
          const grouped = !!(groups.Overdue && groups.Overdue.includes("Cadence smoke overdue") &&
            groups.Today && groups.Today.includes("Cadence smoke today") &&
            groups["Next 7 days"] && groups["Next 7 days"].includes("Cadence smoke week") &&
            groups["Next 7 days"].includes("Cadence smoke detected") &&
            groups["Later · next 90 days"] && groups["Later · next 90 days"].includes("Cadence smoke later"));
          state.cadenceSearch = "QA owner";
          renderCadenceView();
          const searchWorks = $("cadenceUpcomingList").textContent.includes("Cadence smoke overdue") &&
            !$("cadenceUpcomingList").textContent.includes("Cadence smoke today");
          state.cadenceSearch = "";
          state.cadenceFilter = "TEAM";
          renderCadenceView();
          const typeFilterWorks = $("cadenceUpcomingList").textContent.includes("Cadence smoke overdue") &&
            $("cadenceUpcomingList").textContent.includes("Cadence smoke week") &&
            !$("cadenceUpcomingList").textContent.includes("Cadence smoke today") &&
            !$("cadenceUpcomingList").textContent.includes("Cadence smoke later") &&
            !$("cadenceUpcomingList").textContent.includes("Cadence smoke detected");
          return { grouped, searchWorks, typeFilterWorks };
        } finally {
          state.cadenceEntries = previous.entries;
          state.calendar = previous.calendar;
          state.cadenceSearch = previous.search;
          state.cadenceFilter = previous.filter;
          state.cadencePanel = previous.panel;
          state.cadenceMonth = previous.month;
          state.cadenceSelectedDate = previous.selectedDate;
          $("cadenceSearch").value = previous.searchInput;
          $("cadenceTypeFilter").value = previous.typeInput;
          renderCadenceView();
        }
      });
      check(scenario.grouped, "Cadence groups overdue, today, next-week and later entries correctly");
      check(scenario.searchWorks, "Cadence upcoming search filters owners/entries");
      check(scenario.typeFilterWorks, "Cadence upcoming type filters exclude unrelated entries");
      await page.click('[data-calendar-mode="month"]');
      const monthVisible = await page.waitForFunction(() => {
        const panel = document.getElementById("cadenceMonthView");
        const toggle = document.querySelector('[data-calendar-mode="month"]');
        return panel && !panel.hidden && toggle && toggle.getAttribute("aria-pressed") === "true";
      }, null, { timeout: 10000 }).then(() => true, () => false);
      check(monthVisible, "Cadence Month view remains available after switching back");
    }
  }

  const frbEvidence = JSON.parse(fs.readFileSync(path.join(ROOT,
    "data/evidence/c89216e3b00e847563d351357b43772920c29a2266cccb68a8a651736f928219.json"), "utf8"));
  const tableRedline = await page.evaluate(({ beforeHtml, afterHtml, beforeText, afterText }) => {
    const beforeDoc = new DOMParser().parseFromString(beforeHtml, "text/html");
    const afterDoc = new DOMParser().parseFromString(afterHtml, "text/html");
    const aligned = L.alignLines(beforeText, afterText);
    const beforeIndex = flattenDocumentText(beforeDoc), afterIndex = flattenDocumentText(afterDoc);
    const removedMarks = markTextInDocument(beforeDoc, beforeIndex, htmlMarkTargets(aligned.rows, "before"), "cs-del", afterIndex.flat);
    markTextInDocument(afterDoc, afterIndex, htmlMarkTargets(aligned.rows, "after"), "cs-add", beforeIndex.flat);
    const rowCells = row => Array.from(row.cells || []).map(cell => normalizeForMatch(flattenTextContainer(cell).flat || cell.textContent || ""));
    const expectedFfiec = L.splitMarkdownTableRow("| FFIEC 031 | link | FFIEC 031 | FFIEC 031 | N/A | link | link |").map(normalizeForMatch);
    const expected3033 = L.splitMarkdownTableRow("| FR 3033p FR 3033s | link | FR 3033p/s | N/A | N/A | link | link |").map(normalizeForMatch);
    const expectedY9c = L.splitMarkdownTableRow("| FR Y-9C R-1867 | link | N/A | FR Y-9C | Press Release 1 Press Release 2 | link | link |").map(normalizeForMatch);
    const beforeRows = Array.from(beforeDoc.querySelectorAll("tr"));
    const markedRows = beforeRows.filter(row => row.querySelector("mark.cs-del"));
    const isMarked = cells => markedRows.some(row => L.tableCellsMatch(cells, rowCells(row)));
    const otherMarkedRows = markedRows.filter(row => !L.tableCellsMatch(expectedFfiec, rowCells(row)) &&
      !L.tableCellsMatch(expectedY9c, rowCells(row))).map(row => rowCells(row).slice(0, 3));
    return {
      stats: aligned.stats,
      removedMarks,
      markedRowCount: markedRows.length,
      deletedFfiecMarked: isMarked(expectedFfiec),
      deletedY9cMarked: isMarked(expectedY9c),
      unchanged3033Marked: isMarked(expected3033),
      otherMarkedRows
    };
  }, {
    beforeHtml: fs.readFileSync(path.join(ROOT, frbEvidence.before.html_snapshot_location), "utf8"),
    afterHtml: fs.readFileSync(path.join(ROOT, frbEvidence.after.html_snapshot_location), "utf8"),
    beforeText: fs.readFileSync(path.join(ROOT, frbEvidence.before.snapshot_location), "utf8"),
    afterText: fs.readFileSync(path.join(ROOT, frbEvidence.after.snapshot_location), "utf8")
  });
  check(tableRedline.stats.removed === 2 &&
    tableRedline.stats.added === 0 &&
    tableRedline.deletedFfiecMarked &&
    tableRedline.deletedY9cMarked &&
    !tableRedline.unchanged3033Marked &&
    tableRedline.otherMarkedRows.length === 0 &&
    tableRedline.markedRowCount === 2,
    "saved FRB HTML redline marks exactly FFIEC 031 and FR Y-9C/R-1867, not FR 3033p/s or repeated labels (" + JSON.stringify(tableRedline) + ")");

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

  // The explorer: a Shift-click inside the opaque-origin frame selects a link and a
  // plain click opens it. Safari can't run parent-attached listeners in a script-less
  // frame, so this is the path every browser now takes.
  {
    const { context: exploreContext, page: explorePage, errors: exploreErrors } = await openDashboard({ width: 1280, height: 860 });
    await explorePage.evaluate(() => { try { localStorage.removeItem(ADD_DRAFT_STORAGE); } catch (_) {} addClearDraft(); });
    await explorePage.click('.rail [data-add-monitor]');
    await explorePage.fill("#newMonitorUrl", "https://www.example.gov/start");
    await explorePage.click("#addStartGo");
    const frame = await (await explorePage.waitForSelector("#exploreFrame")).contentFrame();
    const loaded = await frame.waitForSelector("#l1", { timeout: 15000 }).then(() => true, () => false);
    check(loaded, "the explorer shows the reader's copy");
    if (loaded) {
      check(await frame.evaluate(() => String(window.origin)) === "null", "the explored copy runs in an opaque origin");
      await explorePage.waitForTimeout(250);
      await frame.click("#l0", { modifiers: ["Shift"] });
      await explorePage.waitForTimeout(300);
      check(await explorePage.evaluate(() => state.add.picked.size) === 1, "Shift-click inside the explored page selects the link");
      check(await frame.evaluate(() => document.querySelectorAll("[data-cs-picked]").length) === 1, "the selected link is marked in the page");
      await frame.click("#l1");
      const navigated = await explorePage.waitForFunction(() => /guidance/.test(document.getElementById("exploreAddress").textContent), null, { timeout: 10000 }).then(() => true, () => false);
      check(navigated, "a plain click opens the linked page in the explorer");
    }
    await explorePage.evaluate(() => { const dialog = document.getElementById("addMonitorDialog"); if (dialog.open) dialog.close(); });
    // The scan history: hovering a light shows its tip and clicking through removes it.
    await explorePage.click('.rail [data-view="overview"]');
    await explorePage.click("[data-field-lens=all]");
    await explorePage.waitForTimeout(600);
    // The newest light of the first page row: in view, since the field opens on the newest scan.
    const firstRow = await explorePage.$eval("#signalVisual .led[data-monitor-id]:not(.s-none):not(.s-pending)", el => el.dataset.y).catch(() => null);
    const lights = firstRow === null ? [] : await explorePage.$$('#signalVisual .led[data-y="' + firstRow + '"][data-monitor-id]:not(.s-none):not(.s-pending)');
    const light = lights[lights.length - 1];
    if (light) await light.scrollIntoViewIfNeeded();
    const box = light ? await light.boundingBox() : null;
    if (box) {
      await explorePage.mouse.move(box.x + 3, box.y + 3);
      await explorePage.mouse.move(box.x + 5, box.y + 5);
      check(await explorePage.isVisible("#fieldTip"), "hovering a light shows what happened in that scan");
      await explorePage.mouse.click(box.x + 5, box.y + 5);
      await explorePage.waitForTimeout(300);
      check(!(await explorePage.isVisible("#fieldTip")) && await explorePage.evaluate(() => state.view) === "monitors", "clicking a light opens the page and clears the tip");
    } else {
      console.log("skip no scanned light to hover");
    }
    exploreErrors.forEach(message => check(false, message));
    await exploreContext.close();
  }

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
