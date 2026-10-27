#!/usr/bin/env node
/*
 * Browser smoke test for Sentinel (sentinel.js), run in CI with Playwright's
 * Chromium next to the dashboard smoke test.
 *
 * Serves the checkout on 127.0.0.1 and stands in for the ask-sentinel Edge
 * Function with a scripted agent, so the whole loop runs without a model:
 * the mascot orb, the unlock ripple, the workspace and its live copy of the
 * dashboard, Sentinel's cursor opening a change and pointing at it, the
 * person clicking in the same copy (and Sentinel being told), an approval
 * card that stops a consequential click, a question card, and the phone
 * layout. Screenshots go to SMOKE_ARTIFACTS (default ./smoke-artifacts).
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
  ".css": "text/css", ".ics": "text/calendar", ".pdf": "application/pdf", ".txt": "text/plain", ".png": "image/png" };
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
const annotate = (level, message) => { if (process.env.GITHUB_ACTIONS) console.log("::" + level + " title=Sentinel smoke::" + message.replace(/\r?\n/g, " ")); };
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log((condition ? "ok   " : "FAIL ") + message);
  annotate(condition ? "notice" : "error", (condition ? "ok: " : "FAIL: ") + message);
};

/* ---------- A scripted agent in place of the Edge Function ---------- */
// A long explanation on an item near the right edge: it must wrap and stay whole.
const LONG_NOTE = "This is the change I opened: the Central Bank of the Bahamas replaced its downloadable forms page, so every form link below moved to a new address and the old ones now return the archive page.";
const seen = [];
const call = (name, args) => ({ id: "c" + Math.random().toString(36).slice(2, 9), type: "function", function: { name, arguments: JSON.stringify(args || {}) } });
function toolCalls(calls, remaining) {
  return { type: "tool_calls", assistant: { role: "assistant", content: "", tool_calls: calls }, calls, server_results: [], server_messages: [], turn: { token: "smoke-turn", step: 1, max: 14 }, remaining, limit: 50, model: "smoke" };
}
const final = (answer, remaining) => ({ type: "final", answer, server_messages: [], turn: { token: "smoke-turn", step: 2, max: 14 }, remaining, limit: 50, model: "smoke" });
function fakeAgent(body) {
  seen.push(body);
  const messages = body.messages || [];
  let start = messages.length - 1;
  while (start >= 0 && !(messages[start].role === "user" && !/^Person, in the dashboard/.test(messages[start].content))) start -= 1;
  const question = start >= 0 ? messages[start].content : "";
  const since = messages.slice(start + 1);
  const results = since.filter(m => m.role === "tool").map(m => m.content);
  const n = results.length;
  if (/walk me through/i.test(question)) {
    if (n === 0) return toolCalls([call("get_overview"), call("list_changes", { days: 400, limit: 5 })], 49);
    if (n === 2) {
      const list = JSON.parse(results[1]);
      const first = list.changes && list.changes[0];
      return toolCalls([call("open_view", { view: "changes", item_id: first ? first.event_id : "" })]);
    }
    if (n === 3) return toolCalls([call("read_screen")]);
    if (n === 4) {
      const ref = (results[3].match(/\[(e\d+)\][^\n]*in detail/) || results[3].match(/\[(e\d+)\]/) || [])[1] || "e1";
      return toolCalls([call("point_at", { ref, note: LONG_NOTE })]);
    }
    const list = JSON.parse(results[1]);
    const first = list.changes && list.changes[0];
    return final("The latest change is on **" + (first ? first.page : "a page") + "**.\n\n| Field | Value |\n|:--|:--|\n| Type | " + (first ? first.type : "") + " |\n\n[Open it](#changes/" + (first ? first.event_id : "") + ")", 49);
  }
  if (/start a scan/i.test(question)) {
    if (n === 0) return toolCalls([call("open_view", { view: "overview" })], 48);
    if (n === 1) return toolCalls([call("read_screen", { filter: "Scan now" })]);
    if (n === 2) {
      const ref = (results[1].match(/\[(e\d+)\][^\n]*Scan now/) || [])[1] || "e1";
      return toolCalls([call("click", { ref, why: "Starting a scan" })]);
    }
    return final(/declined/.test(results[2]) ? "Understood — I did not start the scan." : "The scan has started.", 48);
  }
  if (/which regulator/i.test(question)) {
    if (n === 0) return toolCalls([call("ask_person", { question: "Which regulator should I check?", options: ["OSFI", "Federal Reserve"] })], 47);
    return final("Checking " + JSON.parse(results[0]).answer + " next.", 47);
  }
  return final("Hello from the smoke agent.", 46);
}

const browser = await chromium.launch();
async function open(viewport, theme, options = {}) {
  const context = await browser.newContext({ viewport, hasTouch: !!options.touch, isMobile: !!options.touch });
  await context.route(/\/functions\/v1\/ask-sentinel/, async route => {
    const request = route.request();
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === "GET") { await route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify({ ok: true, remaining: 50, limit: 50, agent: true }) }); return; }
    const body = JSON.parse(request.postData() || "{}");
    const reply = fakeAgent(body);
    // The live dashboard redraws the open view when late data arrives (as it
    // does on CI, where evidence and the GitHub API load). Redraw it between
    // read_screen and point_at so the ref the model holds is a detached node.
    if (reply.calls && reply.calls.some(c => c.function.name === "point_at")) {
      await request.frame().page().evaluate(() => {
        const doc = document.querySelector(".sentinel-frame").contentDocument;
        const view = doc.querySelector(".view:not([hidden])");
        if (view) view.replaceWith(view.cloneNode(true));
      }).catch(() => {});
    }
    if (!body.stream) { await route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(reply) }); return; }
    // The Edge Function's stream: thinking, answer text in pieces, then "done".
    const events = [];
    const send = (event, data) => events.push("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
    send("step", { step: 1, max: 10 });
    send("reasoning", { delta: "Checking what the dashboard already shows. " });
    send("reasoning", { delta: "The snapshot has the latest changes." });
    if (reply.type === "final") for (let i = 0; i < reply.answer.length; i += 12) send("text", { delta: reply.answer.slice(i, i + 12) });
    send("done", { http_status: 200, ...reply });
    await route.fulfill({ status: 200, contentType: "text/event-stream", headers, body: events.join("") });
  });
  await context.route(/\/functions\/v1\/page-reader/, route => route.fulfill({ status: 503, body: "{}" }));
  await context.addInitScript(value => {
    try { sessionStorage.setItem("cs-dev-access-v1", "granted"); localStorage.setItem("cs-theme", value); } catch (_) {}
  }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push("page error: " + error.message));
  page.on("console", message => {
    if (message.type() === "error" && /SyntaxError|TypeError|ReferenceError/i.test(message.text())) errors.push("console: " + message.text());
  });
  await page.goto(base + "index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const lede = document.getElementById("overviewLede");
    return lede && !/Reading the latest stored scan/.test(lede.textContent);
  }, null, { timeout: 45000 });
  return { context, page, errors };
}
const frameReady = page => page.waitForFunction(() => {
  const frame = document.querySelector(".sentinel-frame");
  try { return !!(frame && frame.contentWindow.SentinelEmbed && frame.contentWindow.SentinelEmbed.ready()); } catch (_) { return false; }
}, null, { timeout: 45000 });
const idle = page => page.waitForFunction(() => document.getElementById("sentinelWorkspace").dataset.state !== "thinking" &&
  document.getElementById("sentinelWorkspace").dataset.state !== "acting" &&
  document.querySelector("#sentinelSend").getAttribute("aria-label") === "Send", null, { timeout: 45000 });
async function ask(page, text) {
  await page.fill("#sentinelInput", text);
  await page.press("#sentinelInput", "Enter");
}

try {
  for (const theme of ["light", "dark"]) {
    const { context, page, errors } = await open({ width: 1440, height: 900 }, theme);
    const launch = page.locator("#minimal-mascot-orb");
    check(await launch.isVisible(), theme + ": the mascot orb sits in the bottom-right corner");
    check(!(await page.locator("#askSentinelLaunch").isVisible()), theme + ": Ask Sentinel is no longer in the left rail");
    const addRule = await page.$eval(".rail .nav-add", el => { const cs = getComputedStyle(el); return cs.borderTopStyle === "solid" && parseFloat(cs.borderTopWidth) >= 1; });
    check(addRule, theme + ": a hairline separates Add a link from Cadence, as one separates Scout from Registry");
    const orbBox = await launch.boundingBox();
    check(orbBox && Math.round(orbBox.width) === 52 && orbBox.x + orbBox.width > 1440 - 30 && orbBox.y + orbBox.height > 900 - 30, theme + ": the orb is 52px at bottom-right");
    const faceBefore = await page.$eval("#minimal-mascot-orb [data-mo=nose]", el => el.getAttribute("d"));
    await page.mouse.move(80, 80);
    await page.waitForTimeout(500);
    check(faceBefore !== await page.$eval("#minimal-mascot-orb [data-mo=nose]", el => el.getAttribute("d")), theme + ": the mascot's face follows the pointer");
    await page.screenshot({ path: path.join(OUT, "sentinel-orb-" + theme + ".png"), clip: { x: 1440 - 200, y: 900 - 160, width: 200, height: 160 } });

    // Unlock ripple into the workspace.
    await page.evaluate(() => {
      const wall = document.querySelector(".sentinel-wall");
      window.__wallSeen = false;
      new MutationObserver(() => { if (!wall.hidden) window.__wallSeen = true; }).observe(wall, { attributes: true, attributeFilter: ["hidden"] });
    });
    await launch.click();
    await page.waitForTimeout(240);
    const midWall = await page.evaluate(() => window.__wallSeen);
    check(midWall, theme + ": opening plays the LED unlock ripple");
    const reveal = await page.evaluate(() => { const ws = document.getElementById("sentinelWorkspace"); const b = ws.getBoundingClientRect(); return { x: parseFloat(ws.style.getPropertyValue("--sn-x")) + b.left, y: parseFloat(ws.style.getPropertyValue("--sn-y")) + b.top }; });
    check(orbBox && Math.abs(reveal.x - (orbBox.x + orbBox.width / 2)) < 4 && Math.abs(reveal.y - (orbBox.y + orbBox.height / 2)) < 4, theme + ": the ripple spreads from the orb");
    await page.screenshot({ path: path.join(OUT, "sentinel-unlock-" + theme + ".png") });
    await page.waitForFunction(() => !document.getElementById("sentinelWorkspace").classList.contains("is-revealing"), null, { timeout: 5000 });
    check(await page.locator("#sentinelWorkspace").isVisible(), theme + ": the workspace opens");
    await frameReady(page);
    const embedded = await page.evaluate(() => {
      const doc = document.querySelector(".sentinel-frame").contentDocument;
      return { embed: doc.documentElement.classList.contains("cs-embed"), open: doc.documentElement.classList.contains("cs-open"),
        dock: !!doc.querySelector(".nav-ask") && getComputedStyle(doc.querySelector(".nav-ask")).display !== "none" };
    });
    check(embedded.embed && embedded.open && !embedded.dock, theme + ": the live dashboard loads unlocked, embedded, without a second Sentinel");
    await page.screenshot({ path: path.join(OUT, "sentinel-workspace-" + theme + ".png") });
    const look = await page.evaluate(() => {
      const ws = document.getElementById("sentinelWorkspace").getBoundingClientRect();
      const app = document.querySelector(".app").getBoundingClientRect();
      const fonts = [".sentinel-welcome-title", ".sentinel-suggest-title", ".sentinel-brand h2", ".sentinel-input"].map(s => getComputedStyle(document.querySelector(s)).fontFamily);
      return { same: ["left", "top", "right", "bottom"].every(k => Math.abs(ws[k] - app[k]) < 1), geist: fonts.every(f => /^"?Geist"?,/.test(f)),
        orbAway: !document.getElementById("minimal-mascot-orb").checkVisibility({ visibilityProperty: true }),
        glints: getComputedStyle(document.querySelector(".frame-glints")).display !== "none" };
    });
    check(look.same && look.glints, theme + ": the workspace sits where the dashboard does, inside the live LED frame");
    check(look.geist, theme + ": the workspace uses the dashboard's Geist type");
    check(look.orbAway, theme + ": the orb steps aside while the workspace is open");
    const head = await page.evaluate(() => ({ title: document.getElementById("sentinelTitle").textContent, mark: !!document.querySelector("#sentinelWorkspace .sentinel-brand .brand-mark, #sentinelWorkspace .sentinel-brand svg") }));
    check(head.title === "Ask Sentinel" && !head.mark, theme + ": the workspace header reads Ask Sentinel, with no logo");

    if (theme === "light") {
      // A walkthrough: read tools, then the cursor opens a change and points at it.
      await page.evaluate(() => {
        window.__spotSeen = false;
        const seenNow = () => { const spot = document.querySelector(".sn-spot"); if (spot && spot.style.opacity === "1") window.__spotSeen = true; };
        new MutationObserver(seenNow).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
      });
      await ask(page, "Open the most recent change and walk me through the redline");
      await page.waitForFunction(() => document.querySelector("#sentinelCursor.is-on"), null, { timeout: 20000 });
      check(true, "Sentinel's cursor appears in the live dashboard");
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, "sentinel-cursor-acting.png") });
      await idle(page);
      const hash = await page.evaluate(() => document.querySelector(".sentinel-frame").contentWindow.location.hash);
      check(/^#changes\/[0-9a-f]{16,}/.test(hash), "the cursor opened a change in the live dashboard (" + hash.slice(0, 24) + "…)");
      const steps = await page.locator(".sn-step[data-status=done]").count();
      check(steps >= 5, "each tool step is listed and completed (" + steps + ")");
      check(await page.locator(".sn-think.is-done").count() >= 1 && /Thought for \d+s/.test(await page.locator(".sn-think.is-done").last().textContent()), "the model's thinking streams in and folds away");
      check(seen.every(body => body.stream === true), "every step asks for a streamed reply");
      check(typeof seen[0].context.snapshot === "string" && /latest_changes/.test(seen[0].context.snapshot), "a dashboard snapshot goes with the question");
      const answer = await page.locator(".sn-msg.is-agent").last().innerHTML();
      check(/<table/.test(answer) && /data-sn-route/.test(answer), "the answer renders Markdown with a dashboard link");
      const noteFit = await page.evaluate(() => {
        const note = document.querySelector(".sn-spot-note"), view = document.querySelector(".sentinel-viewport");
        if (!note || !view) return { ok: false, why: "no note" };
        const n = note.getBoundingClientRect(), v = view.getBoundingClientRect();
        return { ok: n.left >= v.left && n.right <= v.right && n.top >= v.top && n.bottom <= v.bottom && n.height > 30, text: note.textContent, n: [n.left, n.top, n.right, n.bottom].map(Math.round), v: [v.left, v.top, v.right, v.bottom].map(Math.round) };
      });
      check(noteFit.ok && noteFit.text === LONG_NOTE, "a long spotlight note wraps, stays whole and inside the live dashboard " + JSON.stringify({ n: noteFit.n, v: noteFit.v, why: noteFit.why }));
      const pointResult = (seen[seen.length - 1].messages || []).filter(m => m.role === "tool").map(m => String(m.content)).pop() || "";
      check(await page.evaluate(() => window.__spotSeen), "point_at spotlights the item for the person (tool said " + pointResult.slice(0, 160) + ")");
      const sentTools = seen[seen.length - 1].tools.map(t => t.function.name);
      check(["read_screen", "click", "type", "open_view", "list_changes", "ask_person"].every(name => sentTools.includes(name)), "the dashboard's tools are offered to the agent");
      check(seen.every(body => body.mode === "agent"), "every step uses agent mode");
      await page.screenshot({ path: path.join(OUT, "sentinel-answer.png") });

      // Co-work: the person clicks in the same copy; Sentinel is told at its next step.
      const frameBox = await page.locator(".sentinel-frame").boundingBox();
      const target = await page.evaluate(() => {
        const doc = document.querySelector(".sentinel-frame").contentDocument;
        const nav = doc.querySelector('.rail [data-view="runs"]');
        const r = nav.getBoundingClientRect();
        const scale = parseFloat((document.querySelector(".sentinel-frame").style.transform.match(/scale\(([\d.]+)\)/) || [0, 1])[1]);
        return { x: (r.left + r.width / 2) * scale, y: (r.top + r.height / 2) * scale };
      });
      await page.mouse.click(frameBox.x + target.x, frameBox.y + target.y);
      await page.waitForTimeout(1600);
      const cowork = await page.textContent("#sentinelCowork");
      check(/You\s*clicked/i.test(cowork) && /Runs/i.test(cowork), "the person's own click is noticed (" + cowork.trim() + ")");
      await ask(page, "Hello");
      await idle(page);
      const last = seen[seen.length - 1];
      check(last.messages.some(m => m.role === "user" && /Person, in the dashboard/.test(m.content) && /Runs/.test(m.content)), "Sentinel receives what the person did in the dashboard");
      check(last.messages.some(m => m.role === "assistant" && /latest change is on/.test(m.content || "")), "earlier answers stay in the conversation");

      // A consequential click waits for approval; declining stops it.
      await ask(page, "Please start a scan now");
      await page.waitForSelector(".sn-card.is-approval:not(.is-done)", { timeout: 20000 });
      check(await page.$eval("#sentinelWorkspace", el => el.dataset.state) === "waiting", "Sentinel waits for approval before Scan now");
      await page.screenshot({ path: path.join(OUT, "sentinel-approval.png") });
      await page.click(".sn-card.is-approval [data-answer=no]");
      await idle(page);
      const declined = seen[seen.length - 1].messages.filter(m => m.role === "tool").pop();
      check(declined && /declined/.test(declined.content), "a declined click is reported back and not performed");
      check(/did not start the scan/.test(await page.locator(".sn-msg.is-agent").last().textContent()), "Sentinel answers after the decision");

      // A question card.
      await ask(page, "Which regulator should you check?");
      await page.waitForSelector(".sn-card.is-question:not(.is-done)", { timeout: 20000 });
      await page.click(".sn-card.is-question [data-option=OSFI]");
      await idle(page);
      check(/Checking OSFI next/.test(await page.locator(".sn-msg.is-agent").last().textContent()), "ask_person returns the person's answer to the agent");

      // Close back into the orb, then reopen with Ctrl+K; the conversation is kept.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("sentinelWorkspace").hidden, null, { timeout: 5000 });
      await page.waitForTimeout(400);
      check(await launch.isVisible(), "Esc closes the workspace back into the orb");
      await page.keyboard.press("Control+k");
      await page.waitForFunction(() => !document.getElementById("sentinelWorkspace").hidden && !document.getElementById("sentinelWorkspace").classList.contains("is-revealing"), null, { timeout: 5000 });
      check(await page.locator(".sn-msg.is-agent").count() >= 3, "Ctrl+K reopens Sentinel with the conversation kept");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("sentinelWorkspace").hidden, null, { timeout: 5000 });

      // An answer read in the workspace leaves no dot on the orb.
      await page.evaluate(() => window.Sentinel.ask("Hello"));
      await page.waitForFunction(() => !document.getElementById("sentinelWorkspace").classList.contains("is-revealing"), null, { timeout: 5000 });
      await idle(page);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("sentinelWorkspace").hidden, null, { timeout: 5000 });
      check(!(await page.locator("#sentinelOrbWrap").evaluate(el => el.classList.contains("has-note"))), "no answer dot after reading the answer in the workspace");
    }
    check(errors.length === 0, theme + ": no script errors" + (errors.length ? " — " + errors.slice(0, 3).join(" | ") : ""));
    await context.close();
  }

  // Phone: the bottom bar's Ask tab opens it; chat and the live dashboard are tabs.
  {
    const { context, page, errors } = await open({ width: 390, height: 844 }, "dark", { touch: true });
    const bar = await page.evaluate(() => {
      const shown = [...document.querySelectorAll(".rail-nav > li")].filter(li => getComputedStyle(li).display !== "none").map(li => li.textContent.replace(/\d+/g, "").trim());
      const orb = document.getElementById("minimal-mascot-orb").getBoundingClientRect();
      const nav = document.querySelector(".rail").getBoundingClientRect();
      return { shown, orbAboveBar: orb.width > 0 && orb.bottom <= nav.top - 4 && orb.right <= innerWidth - 8, dot: getComputedStyle(document.getElementById("navMoreDot")).display };
    });
    check(JSON.stringify(bar.shown) === JSON.stringify(["Overview", "Changes", "Pages", "Runs", "Alerts", "More"]), "phone: the bottom bar is Overview, Changes, Pages, Runs, Alerts, More (" + bar.shown.join(", ") + ")");
    check(bar.orbAboveBar, "phone: the orb sits just above the bottom bar");
    check(bar.dot === "none", "phone: no loose dot beside More");
    await page.screenshot({ path: path.join(OUT, "sentinel-phone-dock.png") });
    await page.locator("#minimal-mascot-orb").tap();
    await page.waitForFunction(() => !document.getElementById("sentinelWorkspace").classList.contains("is-revealing") && !document.getElementById("sentinelWorkspace").hidden, null, { timeout: 5000 });
    check(await page.locator(".sentinel-mtabs").isVisible(), "phone: conversation and live dashboard are tabs");
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!sideways, "phone: no sideways scroll");
    await page.screenshot({ path: path.join(OUT, "sentinel-phone-chat.png") });
    await page.tap("[data-sn-mtab=stage]");
    await frameReady(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, "sentinel-phone-stage.png") });
    const stage = await page.evaluate(() => {
      const crumb = document.getElementById("sentinelCrumb").getBoundingClientRect(), pause = document.getElementById("sentinelPause").getBoundingClientRect();
      const doc = document.querySelector(".sentinel-frame").contentDocument;
      const tabs = [...doc.querySelectorAll(".rail-nav > li")].filter(li => getComputedStyle(li).display !== "none").map(li => li.getBoundingClientRect());
      const bar = doc.querySelector(".rail-nav").getBoundingClientRect();
      return { sameRow: Math.abs((crumb.top + crumb.bottom) / 2 - (pause.top + pause.bottom) / 2) < 12 && pause.left > crumb.right, tabs: tabs.length, gapRight: Math.round(bar.right - tabs[tabs.length - 1].right) };
    });
    check(stage.sameRow, "phone: Pause sits on the live dashboard's header row");
    check(stage.tabs === 6 && stage.gapRight <= 6, "phone: the live copy's bottom bar is full width with six tabs (" + stage.tabs + " tabs, " + stage.gapRight + "px spare)");
    check(errors.length === 0, "phone: no script errors" + (errors.length ? " — " + errors.slice(0, 3).join(" | ") : ""));
    await context.close();
  }

  // Reduced motion: no ripple, the workspace still opens.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    await context.addInitScript(() => { try { sessionStorage.setItem("cs-dev-access-v1", "granted"); } catch (_) {} });
    await context.route(/\/functions\/v1\//, route => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{\"ok\":true,\"remaining\":50,\"limit\":50}" }));
    const page = await context.newPage();
    await page.goto(base + "index.html");
    await page.waitForFunction(() => window.Sentinel && document.getElementById("overviewLede") && !/Reading/.test(document.getElementById("overviewLede").textContent), null, { timeout: 45000 });
    await page.click("#minimal-mascot-orb");
    await page.waitForFunction(() => !document.getElementById("sentinelWorkspace").hidden && !document.getElementById("sentinelWorkspace").classList.contains("is-revealing"), null, { timeout: 3000 });
    check(await page.$eval(".sentinel-wall", el => el.hidden), "reduced motion: the workspace opens without the ripple");
    await context.close();
  }
} catch (error) {
  check(false, "Sentinel smoke run: " + (error && error.stack || error));
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.log("\n" + failures.length + " Sentinel check(s) failed.");
  process.exit(1);
}
console.log("\nSentinel smoke checks passed.");
