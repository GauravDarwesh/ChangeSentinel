#!/usr/bin/env node
/*
 * Real-browser check of recorded steps, run in CI next to the dashboard smoke
 * test (Playwright's Chromium). A local test portal hides its results behind a
 * report choice and a search button, like the regulator portals this is for.
 *
 * 1. The dashboard's recorder (dashboard-lib.js RECORDER_SOURCE) is run on the
 *    portal while a person chooses a report, types a query and searches; it
 *    must write down exactly those steps, and never a password.
 * 2. Those steps are replayed on a fresh load with the engine's own in-page
 *    script (regmon/browser_actions.py ACTION_SCRIPT), the way
 *    regmon/browser_fetch.py replays them, and the hidden results must appear.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright")); } catch (_) {
  console.log("SKIP playwright is not installed");
  process.exit(0);
}
const L = require(path.join(ROOT, "dashboard-lib.js"));
const python = fs.readFileSync(path.join(ROOT, "regmon", "browser_actions.py"), "utf8");
const ACTION_SCRIPT = python.split('ACTION_SCRIPT = r"""')[1].split('"""')[0].trim();

const PORTAL = `<!doctype html><html><head><meta charset="utf-8"><title>Portal</title></head><body>
<h1>Reporting portal</h1>
<label>Report <select id="report"><option value="">Choose…</option><option value="FFIEC 031">FFIEC 031</option><option value="FFIEC 041">FFIEC 041</option></select></label>
<input id="q" name="query" type="text"><input id="pw" type="password">
<label><input type="checkbox" id="archived"> Include archived</label>
<button id="search" type="button">Search</button>
<div id="out"></div>
<script>
document.getElementById("search").addEventListener("click", () => {
  const report = document.getElementById("report").value, q = document.getElementById("q").value;
  const archived = document.getElementById("archived").checked;
  setTimeout(() => { document.getElementById("out").innerHTML = '<table class="results"><tr><td>Result for ' + report + ' / ' + q + (archived ? " (with archived)" : "") + '</td></tr></table>'; }, 400);
});
</script></body></html>`;
const server = http.createServer((request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(PORTAL); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port + "/";

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); console.log((condition ? "ok   " : "FAIL ") + message); };

async function replay(page, steps) {
  for (const step of steps) {
    if (step.action === "wait") { await page.waitForTimeout(step.seconds * 1000); continue; }
    const expression = "(" + ACTION_SCRIPT + ")(" + JSON.stringify(step) + ")";
    if (step.action === "wait_for") {
      const deadline = Date.now() + step.seconds * 1000;
      for (;;) {
        const outcome = await page.evaluate(expression);
        if (outcome === "ok") break;
        if (String(outcome).startsWith("error") || Date.now() > deadline) return "wait_for failed: " + outcome;
        await page.waitForTimeout(250);
      }
      continue;
    }
    const outcome = await page.evaluate(expression);
    if (outcome !== "ok") return outcome;
    await page.waitForTimeout(100);
  }
  return "ok";
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(L.RECORDER_SOURCE);
  check(await page.locator("[data-cs-recorder]").count() === 1, "the recorder shows its panel");
  await page.selectOption("#report", "FFIEC 031");
  await page.fill("#q", "total assets");
  await page.fill("#pw", "secret-value");
  await page.check("#archived");
  await page.click("#search");
  const recorded = await page.evaluate(() => window.__csRec.steps());
  check(JSON.stringify(recorded) === JSON.stringify([
    { action: "select", selector: "#report", value: "FFIEC 031" },
    { action: "type", selector: "#q", text: "total assets" },
    { action: "check", selector: "#archived" },
    { action: "click", selector: "#search" }
  ]), "the recorder writes down the choice, the typing, the tick and the click: " + JSON.stringify(recorded));
  check(!JSON.stringify(recorded).includes("secret-value"), "a password is never recorded");
  const validated = L.validateBrowserSteps(recorded.concat([{ action: "wait_for", selector: "table.results", seconds: 5 }]));
  check(!validated.error, "the recorded steps pass the dashboard's validation " + validated.error);

  const fresh = await browser.newPage();
  await fresh.goto(url);
  const outcome = await replay(fresh, validated.steps);
  check(outcome === "ok", "the engine's step script replays them (" + outcome + ")");
  check((await fresh.textContent("#out")).includes("Result for FFIEC 031 / total assets (with archived)"), "the hidden results appear after the replay");

  const refused = await fresh.evaluate("(" + ACTION_SCRIPT + ")(" + JSON.stringify({ action: "type", selector: "#pw", text: "x" }) + ")");
  check(refused === "error: typing into a password field is not allowed", "typing into a password field is refused");
  const missing = await fresh.evaluate("(" + ACTION_SCRIPT + ")(" + JSON.stringify({ action: "click", selector: "#nope" }) + ")");
  check(missing === "error: nothing matches #nope", "a step whose element is missing says so");
  const option = await fresh.evaluate("(" + ACTION_SCRIPT + ")(" + JSON.stringify({ action: "select", selector: "#report", value: "FFIEC 041" }) + ")");
  check(option === "ok" && await fresh.inputValue("#report") === "FFIEC 041", "an option can be chosen by its text or value");
} finally {
  await browser.close();
  server.close();
}
if (failures.length) { console.error(failures.length + " failure(s)"); process.exit(1); }
