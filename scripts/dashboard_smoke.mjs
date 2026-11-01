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
  return { kind: "page", url, title: "Reader copy", html, links, truncated: false, reader_version: "2026-10-27" };
}
// The live view of a small portal: a choice, a field and a button, for recording steps.
function fakeReaderLive(url) {
  const html = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><h1>Portal " + url + "</h1>" +
    "<select id=\"report\"><option value=\"\">Choose</option><option value=\"FFIEC 031\">FFIEC 031</option></select>" +
    "<input id=\"year\" name=\"year\"><button id=\"go\" type=\"button\">Search</button>" +
    "<a id=\"doc\" href=\"https://www.example.gov/forms/a.pdf\">Form A</a></body></html>";
  return { kind: "live", url, html, reader_version: "2026-10-27" };
}
async function openDashboard(viewport, options = {}) {
  const context = await browser.newContext({
    viewport, hasTouch: !!options.touch, isMobile: !!options.touch,
    ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {})
  });
  await context.route(/\/functions\/v1\/page-reader/, async route => {
    const body = JSON.parse(route.request().postData() || "{}");
    const answer = body.mode === "live" ? fakeReaderLive(body.url || "") : fakeReaderPage(body.url || "");
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(answer) });
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

  // Exercise both common and awkward dimensions. A viewport just two pixels
  // beyond a grid boundary used to leave the right/bottom tile mostly off-frame.
  const edgeViewports = [
    { width: 1422, height: 722 },
    { width: 1438, height: 718 },
    { width: 1441, height: 901 },
    { width: 1459, height: 899 },
    { width: 1281, height: 721 },
    { width: 1440, height: 900 }
  ];
  for (const viewport of edgeViewports) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(50);
    const edgeGrid = await page.evaluate(() => {
      const canvas = document.querySelector("canvas.frame-glints");
      const ctx = canvas && canvas.getContext("2d");
      if (!ctx) return { error: "frame canvas unavailable" };
      const cell = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cell")) || 20;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = window.innerWidth, H = window.innerHeight;
      const alpha = (x, y) => ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data[3];
      // The ring (1px in from the screen edge, cell - 1 thick) is painted edge to
      // edge with no transparent seams; the screen's outer pixel and the
      // workspace inside the ring are left alone.
      let seams = 0;
      for (let x = 1.5; x < W - 1; x += 1) { if (alpha(x, cell / 2) !== 255) seams++; if (alpha(x, H - cell / 2) !== 255) seams++; }
      for (let y = 1.5; y < H - 1; y += 1) { if (alpha(cell / 2, y) !== 255) seams++; if (alpha(W - cell / 2, y) !== 255) seams++; }
      // Equal tiles: the same cut the painter uses, every tile within one device pixel.
      const cuts = length => {
        const span = length - 2, count = Math.max(1, Math.round(span / cell)), step = span / count;
        return Array.from({ length: count + 1 }, (_, i) => Math.round((1 + i * step) * dpr) / dpr);
      };
      const sizes = list => list.slice(1).map((value, i) => value - list[i]);
      const xs = sizes(cuts(W)), ys = sizes(cuts(H));
      const spread = list => Math.max(...list) - Math.min(...list);
      return {
        width: W, height: H, seams,
        outerEdgeClear: alpha(0, H / 2) === 0 && alpha(W / 2, 0) === 0,
        workspaceClear: alpha(cell + 2, cell + 2) === 0 && alpha(W - cell - 2, H - cell - 2) === 0,
        tileSpreadX: spread(xs), tileSpreadY: spread(ys), tileX: xs[0], tileY: ys[0]
      };
    });
    const edgePass = !edgeGrid.error &&
      edgeGrid.width === viewport.width && edgeGrid.height === viewport.height &&
      edgeGrid.seams === 0 && edgeGrid.outerEdgeClear && edgeGrid.workspaceClear &&
      edgeGrid.tileSpreadX <= 1 && edgeGrid.tileSpreadY <= 1 &&
      Math.abs(edgeGrid.tileX - 20) <= 1.5 && Math.abs(edgeGrid.tileY - 20) <= 1.5;
    check(edgePass, "edge tiles cover all four frame sides without seams, in equal sizes, at " + viewport.width + "x" + viewport.height + " (" + JSON.stringify(edgeGrid) + ")");
    if (viewport.width === 1441 && viewport.height === 901) {
      await page.screenshot({ path: path.join(OUT, "edge-irregular-viewport.png") });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // A separate reduced-motion context verifies that the canvas stops changing
  // after its initial frame rather than only checking the source-level guard.
  const reducedWave = await openDashboard({ width: 1441, height: 901 }, { reducedMotion: "reduce" });
  const sampleFrameEdge = () => reducedWave.page.evaluate(() => {
    const canvas = document.querySelector("canvas.frame-glints");
    const ctx = canvas && canvas.getContext("2d");
    if (!ctx) return "missing-canvas";
    const cell = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cell")) || 20;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixel = (x, y) => Array.from(ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data).slice(0, 3).join(",");
    const samples = [];
    for (let y = 1; y < window.innerHeight; y += cell) {
      for (let x = 1; x < window.innerWidth; x += cell) {
        if (x < cell || x >= window.innerWidth - cell || y < cell || y >= window.innerHeight - cell) {
          samples.push(pixel(x, y));
        }
      }
    }
    return samples.join("|");
  });
  const reducedBefore = await sampleFrameEdge();
  await reducedWave.page.waitForTimeout(220);
  const reducedAfter = await sampleFrameEdge();
  check(reducedBefore !== "missing-canvas" && reducedBefore === reducedAfter,
    "edge wave freezes after one frame when Reduce Motion is enabled");
  await reducedWave.context.close();

  // The locked screen paints its own wall; the dashboard's edge ring must not sit on top of it.
  {
    const lockedContext = await browser.newContext({ viewport: { width: 1441, height: 901 } });
    const locked = await lockedContext.newPage();
    await locked.goto(base);
    await locked.waitForTimeout(400);
    const lockState = await locked.evaluate(() => ({
      locked: document.documentElement.classList.contains("cs-locked"),
      frame: getComputedStyle(document.querySelector("canvas.frame-glints")).display
    }));
    check(lockState.locked && lockState.frame === "none", "the edge ring is hidden on the locked screen (" + JSON.stringify(lockState) + ")");
    await locked.screenshot({ path: path.join(OUT, "locked-screen.png") });
    await lockedContext.close();
  }

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

  for (const view of ["changes", "monitors", "runs", "health", "notifications", "scout", "calendar", "overview"]) {
    await page.click('.rail [data-view="' + view + '"]');
    await page.waitForTimeout(400);
    const visible = await page.evaluate(name => {
      const id = { overview: "overviewView", changes: "changesView", monitors: "monitorsView", runs: "runsView", health: "healthView", notifications: "notificationsView", scout: "scoutView", calendar: "calendarView" }[name];
      const section = document.getElementById(id);
      return !!section && !section.hidden && section.getBoundingClientRect().height > 0;
    }, view);
    check(visible, "the " + view + " view renders");
    if (view === "health") {
      const health = await page.evaluate(() => ({
        rows: document.querySelectorAll("#healthItems .row").length,
        detail: (document.getElementById("healthDetail") || {}).textContent || ""
      }));
      check(health.rows > 0 && health.detail.length > 0, "Health lists monitors and shows a detail pane (" + health.rows + " rows)");
    }
    if (view === "notifications") {
      check(await page.isVisible("#channelBar"), "Alerts shows the delivery channels");
    }
    if (view === "monitors") {
      // An alert condition can be opened from a single-page monitor's header.
      const editable = await page.$("#detailHeader [data-edit-condition]");
      if (editable) {
        await editable.click();
        check(await page.evaluate(() => document.getElementById("conditionDialog").open), "the alert condition dialog opens from a page");
        await page.evaluate(() => document.getElementById("conditionDialog").close());
      } else {
        console.log("skip the first page belongs to a multi-page source");
      }
    }
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
  // Monitoring data changes between runs. The newest row may be a fetch or
  // extraction error, which intentionally has no before/after evidence panel.
  // Select a rendered non-problem event with a stored evidence file instead.
  const firstChangeId = await page.evaluate(() => {
    const byId = new Map(changeLogEntries().map(entry => [entry.event_id, entry]));
    const row = Array.from(document.querySelectorAll("#changeItems [data-select-change]")).find(button => {
      const entry = byId.get(button.dataset.selectChange);
      return entry && entry.evidence_location && L.eventTone(entry.event_type) !== "problem";
    });
    return row ? row.dataset.selectChange : "";
  });
  if (firstChangeId) {
    await page.click('#changeItems [data-select-change="' + firstChangeId + '"]');
    await page.waitForSelector("#change-evidence", { timeout: 15000 });
    const compare = await page.$('[data-diff-mode="compare"]');
    if (compare) {
      await compare.click();
      // Page and PDF comparisons report progress in a status line; workbook and
      // XML comparisons (the review queue can open on an XSD) draw their table
      // directly. Either way the comparison is done when nothing is loading.
      const done = await page.waitForFunction(() => {
        const box = document.querySelector("#change-evidence");
        if (!box) return false;
        const statusLine = box.querySelector(".cmp-status");
        if (statusLine) return !!statusLine.textContent && !/Loading both versions|Comparing the words|Reading both versions/.test(statusLine.textContent);
        return !box.querySelector(".loading") && !/Loading|Comparing|Reading both/.test((document.querySelector("#change-evidence-summary") || {}).textContent || "") && box.textContent.trim().length > 40;
      }, null, { timeout: 60000 }).then(() => true, () => false);
      check(done, "a before/after comparison finishes");
    } else {
      await page.waitForSelector("#change-evidence .redline, #change-evidence .rl-empty", { timeout: 20000 });
      check(true, "a redline renders");
    }
    await page.screenshot({ path: path.join(OUT, "change-detail.png"), fullPage: false });
  } else {
    console.log("skip no recorded non-problem change with stored evidence to open");
  }

  // A new edition (NEW_URL compared with its predecessor, e.g. OSFI's BCAR workbooks) opens in
  // Compare, and Compare stays reachable after another view is chosen.
  const editions = await page.evaluate(() => changeLogEntries().filter(entry => entry.event_type === "NEW_URL" && entry.evidence_location)
    .map(entry => ({ id: entry.event_id, location: entry.evidence_location })));
  const readEvidence = location => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, location), "utf8")); } catch (_) { return null; } };
  const edition = editions.find(candidate => ((readEvidence(candidate.location) || {}).before || {}).snapshot_location);
  const editionId = edition ? edition.id : "";
  if (editionId) {
    await page.evaluate(id => select("changes", id), editionId);
    await page.waitForSelector("#change-evidence", { timeout: 15000 });
    const pressed = () => page.evaluate(() => Array.from(document.querySelectorAll("#changeDetail [data-diff-mode]"))
      .filter(button => button.getAttribute("aria-pressed") === "true").map(button => button.dataset.diffMode));
    await page.waitForFunction(() => { const s = document.getElementById("change-evidence-summary"); return s && !/Loading/.test(s.textContent); }, null, { timeout: 30000 }).catch(() => {});
    const opened = await pressed();
    await page.click('#changeDetail [data-diff-mode="redline"]');
    await page.waitForFunction(() => document.querySelector('#changeDetail [data-diff-mode="redline"][aria-pressed="true"]'), null, { timeout: 15000 }).catch(() => {});
    const back = await page.$('#changeDetail [data-diff-mode="compare"]');
    if (back) await back.click();
    await page.waitForFunction(() => document.querySelector('#changeDetail [data-diff-mode="compare"][aria-pressed="true"]'), null, { timeout: 15000 }).catch(() => {});
    const returned = await pressed();
    check(opened.join() === "compare" && !!back && returned.join() === "compare",
      "a new edition opens in Compare and Compare is offered again after Redline (" + JSON.stringify({ opened, back: !!back, returned }) + ")");
  } else {
    console.log("skip no new edition with a stored predecessor to compare");
  }

  // Registry → Import a mapping: a 500-row code → consumer sheet is read in the
  // browser and sent as ONE prefilled request (packed when the plain JSON is too long).
  await page.evaluate(() => { window.__opened = []; window.open = url => { window.__opened.push(String(url)); return {}; }; setView("registry"); });
  await page.click("#importRegistryBtn");
  const mapping = ["code,form,schedule,consumer,kind,owner,path"].concat(Array.from({ length: 500 }, (_, n) =>
    "BHCK" + String(1000 + n * 7).padStart(4, "0") + ",FR Y-9C,HC-" + "ABCDEFGH"[n % 8] + "," + ["GL warehouse", "Capital model", "Y-9C load", "Liquidity mart"][n % 4] + "," +
    ["table", "model", "pipeline", "view"][n % 4] + ",Reg Reporting," + ["sql/gl.sql", "models/cap.py", "dags/y9c.py", "sql/liq.sql"][n % 4])).join("\n");
  await page.setInputFiles("#registryImportFile", { name: "mapping.csv", mimeType: "text/csv", buffer: Buffer.from(mapping) });
  await page.waitForFunction(() => !document.getElementById("submitRegistryImport").disabled, null, { timeout: 15000 }).catch(() => {});
  const importPreview = await page.textContent("#registryImportPreview");
  await page.click("#submitRegistryImport");
  const opened = await page.evaluate(() => window.__opened.slice());
  const importBody = opened.length === 1 ? new URL(opened[0]).searchParams.get("body") || "" : "";
  check(/500 items/.test(importPreview || "") && opened.length === 1 && opened[0].length <= 7000 && /```packed/.test(importBody) && /Request SHA-256: [0-9a-f]{64}/.test(importBody),
    "a 500-row mapping imports as one prefilled request (" + JSON.stringify({ preview: importPreview, requests: opened.length, length: opened[0] ? opened[0].length : 0 }) + ")");

  // Your checks (Phase 4.2-4.3): a check that implements a rule a change retires shows on the change.
  const controls = await page.evaluate(() => {
    const id = Object.keys((state.changeFacts || {}).events || {}).find(eventId => changeLogEntries().some(entry => entry.event_id === eventId));
    if (!id) return { skipped: true };
    const facts = state.changeFacts.events[id];
    const form = (facts.forms[0] || {}).form || "FR Y-9C";
    facts.rules = [["SMOKE-1", "retired", "", "Q1 2027"], ["SMOKE-2", "logic", "blocking", "Q1 2027"], ["SMOKE-3", "added", "", ""]];
    state.registry = Object.assign({}, state.registry || { schema_version: 1 }, { consumers: ((state.registry || {}).consumers || []).concat([
      { id: "smoke-check", kind: "check", name: "Smoke check suite", implements: [form + " | SMOKE-1", "SMOKE-2"] }]) });
    state.registryModel = L.registryModel(state.registry, state.lineage);
    state.assessments = null;
    select("changes", id);
    const slot = document.getElementById("change-controls");
    return { text: slot ? slot.innerText : "", consumer: (() => { select("registry", "consumer:smoke-check"); return (document.getElementById("registryControls") || {}).innerText || ""; })() };
  });
  check(controls.skipped || (/1 retired rule still implemented/.test(controls.text) && /SMOKE-2/.test(controls.text) && /New rule, no check/.test(controls.text) && /SMOKE-1/.test(controls.consumer)),
    "a change shows Your checks for the rules a check implements (" + JSON.stringify(controls).slice(0, 300) + ")");

  // Suggested updates (Phase 4.4): the brief and the AI draft show under the rule, and
  // Approve opens a prefilled decision request (nothing is applied).
  if (!controls.skipped) {
    const eventId = await page.evaluate(() => state.selectedChangeId || Object.keys(state.changeFacts.events).find(id => (state.changeFacts.events[id].rules || []).length));
    await page.route(/\/data\/suggestions\/[0-9a-f]+\.json/, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      schema_version: 1, event_id: eventId, briefs: [{ id: "SMOKE-2", finding: "differs", change: "logic", quarter: "Q1 2027", action: "Update Smoke check suite so SMOKE-2 tests what the regulator now states from Q1 2027.",
        checks: [{ id: "smoke-check", name: "Smoke check suite", language: "SQL" }], columns: [{ column: "Formula", before: "a >= 0", after: "a >= 0 and b >= 0" }] }],
      ai: { status: "ok", model: "openrouter/free", provider_model: "smoke:free", drafts: { "SMOKE-2": { language: "SQL", draft: "select 1 where a < 0 or b < 0", notes: "n", hash: "0123456789abcdef" } } } }) }));
    const suggestion = await page.evaluate(async id => {
      window.__opened = []; window.open = url => { window.__opened.push(String(url)); return {}; }; window.prompt = () => "ok";
      state.pagesJson = new Map();
      select("changes", id);
      for (let i = 0; i < 50 && !document.querySelector("#change-controls .suggestion-draft"); i += 1) await new Promise(r => setTimeout(r, 100));
      const draft = document.querySelector("#change-controls .suggestion-draft");
      const approve = document.querySelector('#change-controls [data-suggest-decide="approved"]');
      if (approve) approve.click();
      const url = window.__opened[0] || "";
      return { draft: draft ? draft.textContent : "", body: url ? new URL(url).searchParams.get("body") : "" };
    }, eventId);
    check(/select 1 where/.test(suggestion.draft) && /suggestion-decision:v1/.test(suggestion.body) && /"decision": "approved"/.test(suggestion.body) && /0123456789abcdef/.test(suggestion.body),
      "a suggested update shows its AI draft and Approve opens a decision request (" + JSON.stringify(suggestion).slice(0, 200) + ")");
    await page.unroute(/\/data\/suggestions\/[0-9a-f]+\.json/);
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
      // Two Shift-drags, one around each link: two areas, both kept and numbered.
      const frameBox = await (await explorePage.$("#exploreFrame")).boundingBox();
      const drawAround = async (ids, shift) => {
        const boxes = [];
        for (const id of ids) boxes.push(await (await frame.$(id)).boundingBox());
        const x0 = Math.min(...boxes.map(r => r.x)) - 6, y0 = Math.min(...boxes.map(r => r.y)) - 6;
        const x1 = Math.max(...boxes.map(r => r.x + r.width)) + 6, y1 = Math.max(...boxes.map(r => r.y + r.height)) + 6;
        if (shift) await explorePage.keyboard.down("Shift");
        await explorePage.mouse.move(x0, y0);
        await explorePage.mouse.down();
        await explorePage.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 });
        await explorePage.mouse.move(x1, y1, { steps: 3 });
        await explorePage.mouse.up();
        if (shift) await explorePage.keyboard.up("Shift");
        await explorePage.waitForTimeout(250);
      };
      const numbers = () => frame.evaluate(() => Array.from(document.querySelectorAll(".cs-area-box .cs-area-num")).map(el => el.textContent));
      for (const id of ["#l0", "#l1"]) await drawAround([id], true);
      const areas = await explorePage.evaluate(() => state.add.areas.map(area => area.indexes.length));
      check(areas.length === 2 && areas.every(count => count === 1) && !!frameBox, "two Shift-drags keep two areas (" + JSON.stringify(areas) + ")");
      check(JSON.stringify(await numbers()) === '["1","2"]', "the areas are numbered 1 and 2 on the page");
      check(await frame.evaluate(() => document.querySelectorAll("[data-cs-area]").length) === 2, "both areas stay marked in the page");
      // Removing one and drawing another numbers them 1, 2 again (not 3).
      await explorePage.click('.area-row [data-area-remove]');
      await explorePage.waitForTimeout(150);
      await drawAround(["#l0"], true);
      check(JSON.stringify(await numbers()) === '["1","2"]' && await explorePage.evaluate(() => Array.from(document.querySelectorAll(".area-row .area-num")).map(el => el.textContent).join()) === "1,2",
        "after removing an area the next one is numbered 2, not 3 (" + JSON.stringify(await numbers()) + ")");
      // Resizing a box from its corner takes in the second link.
      const firstId = await explorePage.evaluate(() => (state.add.areas.find(area => area.indexes.join() === "0") || {}).id);
      const handle = await frame.$('.cs-area-box[data-area="' + firstId + '"] .cs-h-se');
      const l1 = await (await frame.$("#l1")).boundingBox();
      if (handle) {
        const hb = await handle.boundingBox();
        const before = await explorePage.evaluate(() => state.add.areas.map(area => area.indexes.length).join());
        await explorePage.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
        await explorePage.mouse.down();
        await explorePage.mouse.move(l1.x + l1.width + 30, l1.y + l1.height + 30, { steps: 6 });
        await explorePage.mouse.up();
        await explorePage.waitForTimeout(300);
        const after = await explorePage.evaluate(() => state.add.areas.map(area => area.indexes.length));
        check(after.length === 2 && after.some(count => count === 2), "resizing a box from its corner takes in more links (" + before + " → " + after.join() + ")");
      } else check(false, "an area box has resize handles");
      // "Box an area" draws without holding Shift.
      await explorePage.click("[data-explore-box]");
      await explorePage.waitForTimeout(150);
      const fb = await (await explorePage.$("#exploreFrame")).boundingBox();
      await explorePage.mouse.move(fb.x + fb.width * 0.45, fb.y + fb.height * 0.45);
      await explorePage.mouse.down();
      await explorePage.mouse.move(fb.x + fb.width * 0.55, fb.y + fb.height * 0.52, { steps: 4 });
      await explorePage.mouse.move(fb.x + fb.width * 0.65, fb.y + fb.height * 0.6, { steps: 4 });
      await explorePage.mouse.up();
      await explorePage.waitForTimeout(300);
      const boxed = await explorePage.evaluate(() => ({ areas: state.add.areas.length, boxing: state.add.boxing }));
      check(boxed.areas === 3, "Box an area draws an area without Shift (" + JSON.stringify(boxed) + ")");
      await explorePage.click("[data-explore-box]");
      await explorePage.evaluate(() => { const shift = state.add.picked; shift.clear(); exploreMarkPicked(); renderExploreSide(); });
      await explorePage.click('[data-area-select="all"]');
      check(await explorePage.evaluate(() => state.add.picked.size) === 2, "one click selects the links in every area");
      await explorePage.screenshot({ path: path.join(OUT, "explore-areas.png") });
      check(await explorePage.isVisible("#exploreViewBar") && await explorePage.isVisible('[data-explore-view="live"]'), "the page, live and reading views can be switched");
      await frame.click("#l1");
      const navigated = await explorePage.waitForFunction(() => /guidance/.test(document.getElementById("exploreAddress").textContent), null, { timeout: 10000 }).then(() => true, () => false);
      check(navigated, "a plain click opens the linked page in the explorer");
      // Recording steps: the live page; a choice, typing and a click become steps.
      await explorePage.click("[data-explore-record]");
      const liveFrame = await explorePage.waitForFunction(() => state.add.view === "live", null, { timeout: 10000 }).then(() => true, () => false);
      check(liveFrame, "Record steps opens the live page");
      if (liveFrame) {
        await explorePage.waitForTimeout(400);
        const portal = await (await explorePage.$("#exploreFrame")).contentFrame();
        await portal.waitForSelector("#report", { timeout: 10000 });
        await portal.selectOption("#report", "FFIEC 031");
        await portal.fill("#year", "2026");
        await portal.press("#year", "Tab");
        await portal.click("#go");
        await portal.click("#doc");
        await explorePage.waitForTimeout(400);
        const steps = await explorePage.evaluate(() => (exploreStepsFor(addPageKey()).actions || []).map(step => step.action + " " + (step.selector || "")));
        check(JSON.stringify(steps) === JSON.stringify(["select #report", "type #year", "click #go", "click #doc"]), "choices, typing and clicks are recorded as steps (" + JSON.stringify(steps) + ")");
        check(/guidance/.test(await explorePage.textContent("#exploreAddress")), "a link clicked while recording is written down, not followed");
        await explorePage.click("[data-explore-record]");
        const rows = await explorePage.evaluate(() => addRequestRows(Array.from(state.add.picked.values())));
        const own = rows.find(row => /guidance/.test(row.url));
        check(!!own && own.browser_actions && own.browser_actions.length === 4, "the page is selected and its request carries the recorded steps");
        check(rows.some(row => row.listed_on === "https://www.example.gov/start"), "each link's request names the page it was found on (listed_on)");
        await explorePage.screenshot({ path: path.join(OUT, "explore-steps.png") });
      }
    }
    await explorePage.evaluate(() => { const dialog = document.getElementById("addMonitorDialog"); if (dialog.open) dialog.close(); });
    // Lineage: a monitored document listed on a monitored page shows where it is
    // listed (from the published record) and checks that page again now.
    {
      const target = await explorePage.evaluate(async () => {
        const lineage = await loadLinkLineage();
        // A document still listed somewhere: one whose every listing was removed
        // has no "Right now" row to check (OSFI dropped five on 30 Oct 2026).
        const item = state.items.find(candidate => candidate.extraction_type !== "html" &&
          L.linkListings(lineage, candidate.canonical_url).some(row => !row.removedAt));
        if (!item) return null;
        select("monitors", item.url_id, { tab: "links" });
        return item.url_id;
      });
      check(!!target, "the lineage record lists at least one monitored document");
      if (target) {
        const shown = await explorePage.waitForFunction(() => /Recorded by the scans/.test((document.getElementById("detailBody") || {}).textContent || "") &&
          /Lineage/.test((document.querySelector('[data-detail-tab="links"]') || {}).textContent || ""), null, { timeout: 10000 }).then(() => true, () => false);
        check(shown, "the Lineage tab shows where a document is listed");
        const live = await explorePage.waitForFunction(() => !/Checking…/.test((document.querySelector("[data-lineage-live]") || {}).textContent || "Checking…"), null, { timeout: 10000 }).then(() => true, () => false);
        check(live, "the Lineage tab checks the listing page again on open");
        await explorePage.screenshot({ path: path.join(OUT, "lineage.png") });
      }
    }
    // The scan history: hovering a light shows its tip and clicking through removes it.
    await explorePage.click('.rail [data-view="overview"]');
    await explorePage.click("[data-field-lens=all]");
    await explorePage.waitForTimeout(600);
    // The newest light of the first page row: in view, since the field opens on the newest scan.
    // The field redraws while page titles load, which can detach a light between
    // finding it and scrolling to it; find it again rather than fail on the race.
    let box = null;
    for (let attempt = 0; attempt < 4 && !box; attempt += 1) {
      const firstRow = await explorePage.$eval("#signalVisual .led[data-monitor-id]:not(.s-none):not(.s-pending)", el => el.dataset.y).catch(() => null);
      const lights = firstRow === null ? [] : await explorePage.$$('#signalVisual .led[data-y="' + firstRow + '"][data-monitor-id]:not(.s-none):not(.s-pending)');
      const light = lights[lights.length - 1];
      if (!light) break;
      try {
        await light.scrollIntoViewIfNeeded({ timeout: 3000 });
        box = await light.boundingBox();
      } catch (_) {
        await explorePage.waitForTimeout(400);
      }
    }
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
