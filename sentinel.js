/*
 * Sentinel: the dashboard's agent.
 *
 * A Moai head on a glass plinth lives in the bottom-right corner. Clicking it
 * plays the dashboard's unlock ripple (the LED wall from the access gate) and
 * opens Sentinel's workspace: a conversation on the left and, on the right, a
 * second, fully interactive copy of the dashboard that Sentinel and the person
 * share. Sentinel drives that copy with its own cursor; the person can click
 * and type in it at the same time, and Sentinel sees what they did.
 *
 * The agent loop runs here. Each step posts the conversation and this file's
 * tool list to the ask-sentinel Edge Function (mode "agent"), which holds the
 * model key and the quota, runs its archive tools itself, and returns either
 * the tool calls to run here or the final answer.
 *
 * Read tools answer from the data this page has already loaded (the same
 * `state` the dashboard renders). UI tools act on the shared copy. Anything
 * that saves, submits, sends, deletes or starts a scan waits for the person's
 * approval first.
 *
 * Loaded after dashboard.js; it uses that file's globals (state, setView,
 * changeLogEntries, askSentinelIdentity, askSentinelMarkdown, ...).
 */
(() => {
  "use strict";

  const root = document.documentElement;
  const EMBED = /[?&]sentinel-embed=1(?:&|$)/.test(location.search) && window.parent !== window;

  /* ================= Embedded copy ================= */
  if (EMBED) {
    root.classList.add("cs-embed");
    try {
      const parentRoot = window.parent.document.documentElement;
      const sync = () => root.setAttribute("data-theme", parentRoot.getAttribute("data-theme") === "dark" ? "dark" : "light");
      sync();
      new window.parent.MutationObserver(sync).observe(parentRoot, { attributes: true, attributeFilter: ["data-theme"] });
    } catch (_) {}
    // The parent reads view state through this bridge instead of reaching into
    // this page's script scope.
    window.SentinelEmbed = {
      ready: () => typeof state !== "undefined" && !!state.loaded,
      view: () => (typeof state !== "undefined" ? state.view : ""),
      route(view, id) {
        if (typeof HASH_NAMES === "undefined") return;
        const name = HASH_NAMES[view] || "overview";
        if (id) location.hash = "#" + name + "/" + encodeURIComponent(id);
        else if (typeof setView === "function") setView(view);
      },
      reload: () => (typeof loadData === "function" ? loadData(false) : null)
    };
    // A same-site link (the brand, "./") would load the full dashboard, with
    // its own Sentinel, inside the stage. Keep it to an in-page route.
    document.addEventListener("click", event => {
      const link = event.target.closest && event.target.closest("a[href]");
      if (!link || link.target === "_blank") return;
      let url;
      try { url = new URL(link.getAttribute("href"), location.href); } catch (_) { return; }
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      event.preventDefault();
      if (url.hash) location.hash = url.hash;
      else if (typeof setView === "function") setView("overview");
    }, true);
    return;
  }
  if (typeof state === "undefined" || typeof setView !== "function" || !window.CSLib) return;

  const Lib = window.CSLib;
  const motion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const escHtml = value => String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const clampText = (value, max) => { const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim(); return text.length > max ? text.slice(0, max - 1) + "…" : text; };
  const STORE_KEY = "cs-sentinel-conversation-v1";
  const ENDPOINT = typeof ASK_SENTINEL_ENDPOINT === "string" ? ASK_SENTINEL_ENDPOINT : "";

  /* ================= The Moai ================= */
  // A friendly, Notion-style figure (ink outline, flat paper face) with a
  // nod to a Moai: long face and nose, a heavy brow line and a terracotta
  // topknot. The three LED dots on the topknot show what Sentinel is doing.
  function moaiMarkup() {
    const led = (x, k) => '<rect class="moai-led" x="' + x + '" y="6" width="1.7" height="1.7" rx=".35" style="--k:' + k + '"/>';
    return '<svg viewBox="0 0 50 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
      '<path class="mf-shirt mf-ink" d="M6 64.5C7 57.6 13 55 18.6 55H31.4C37 55 43 57.6 44 64.5"/>' +
      '<path class="mf-skin" d="M20 48.5H30V56H20Z"/>' +
      '<path class="mf-ink" d="M20 49.5V55.6M30 49.5V55.6"/>' +
      '<path class="mf-collar mf-ink" d="M19.4 55.2C21 57.6 29 57.6 30.6 55.2"/>' +
      '<path class="mf-skin mf-ink" d="M13.4 25C9.7 24.8 9 32.6 9.8 36.8C10.4 40 12 41.2 13.6 40.4"/>' +
      '<path class="mf-skin mf-ink" d="M36.6 25C40.3 24.8 41 32.6 40.2 36.8C39.6 40 38 41.2 36.4 40.4"/>' +
      '<path class="mf-ink" d="M11.8 29.4C11 31.6 11.2 34.6 12.2 36.4M38.2 29.4C39 31.6 38.8 34.6 37.8 36.4" style="stroke-width:1.1"/>' +
      '<path class="mf-skin mf-ink mf-head" d="M13.5 15C13.5 10.5 16.5 9 25 9C33.5 9 36.5 10.5 36.5 15L37 40C37 49 32 53.5 25 53.5C18 53.5 13 49 13 40Z"/>' +
      '<g class="moai-bun"><path class="mf-bun mf-ink" d="M16.6 10.4C16.2 5.2 19.5 3.4 25 3.4C30.5 3.4 33.8 5.2 33.4 10.4C30 11.7 20 11.7 16.6 10.4Z"/>' +
        led(20.9, 0) + led(24.15, 1) + led(27.4, 2) + "</g>" +
      '<circle class="mf-blush" cx="17.4" cy="34" r="2.5"/><circle class="mf-blush" cx="32.6" cy="34" r="2.5"/>' +
      '<g class="moai-brow-group"><path class="mf-ink mf-brow" d="M15.8 21.6C20 19.2 30 19.2 34.2 21.6"/></g>' +
      '<g class="moai-eyes"><ellipse class="moai-eye" cx="20.2" cy="26.4" rx="1.35" ry="1.75"/><ellipse class="moai-eye" cx="29.8" cy="26.4" rx="1.35" ry="1.75"/></g>' +
      '<path class="mf-ink" d="M25.3 22.6C24.9 27.2 23.7 32 22.6 35.2C23.8 36.7 26.1 36.9 27.7 35.6"/>' +
      '<path class="mf-ink moai-mouth" d="M21.3 42.2C23.5 44.4 26.5 44.4 28.7 42.2"/>' +
    "</svg>";
  }

  // Keep a Moai alive: breathing (CSS), eyes that follow the pointer, and an
  // idle gesture every few seconds.
  function animateMoai(el) {
    let timer = 0;
    const gestures = [["blink", 44], ["smile", 18], ["glance", 16], ["brow", 11], ["nod", 11]];
    const pick = () => {
      let roll = Math.random() * 100;
      for (const [name, weight] of gestures) { if ((roll -= weight) <= 0) return name; }
      return "blink";
    };
    const play = name => {
      if (motion.matches || document.hidden) return;
      if (name === "glance") {
        const eyes = el.querySelector(".moai-eyes");
        eyes.dataset.glancing = "1";
        eyes.style.setProperty("--look-x", "-1.4px");
        setTimeout(() => eyes.style.setProperty("--look-x", "1.4px"), 380);
        setTimeout(() => { eyes.style.removeProperty("--look-x"); delete eyes.dataset.glancing; }, 820);
        return;
      }
      const cls = "is-" + name;
      el.classList.remove(cls); void el.getBoundingClientRect(); el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), name === "smile" ? 1600 : name === "nod" ? 950 : name === "brow" ? 900 : 360);
      if (name === "blink" && Math.random() < .25) setTimeout(() => play("blink"), 420);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { play(pick()); schedule(); }, 3800 + Math.random() * 5200);
    };
    schedule();
    return { play };
  }

  // Both Moai look toward the pointer (rAF-throttled).
  let lookFrame = 0;
  let lookEvent = null;
  window.addEventListener("pointermove", event => {
    lookEvent = event;
    if (lookFrame || motion.matches) return;
    lookFrame = requestAnimationFrame(() => {
      lookFrame = 0;
      document.querySelectorAll(".sentinel-moai").forEach(moai => {
        const box = moai.getBoundingClientRect();
        if (!box.width) return;
        const dx = lookEvent.clientX - (box.left + box.width / 2);
        const dy = lookEvent.clientY - (box.top + box.height * .42);
        const dist = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, dist / 260);
        const eyes = moai.querySelector(".moai-eyes");
        if (!eyes.dataset.glancing) {
          eyes.style.setProperty("--look-x", (dx / dist * 1.5 * reach).toFixed(2) + "px");
          eyes.style.setProperty("--look-y", (dy / dist * .7 * reach).toFixed(2) + "px");
        }
      });
    });
  }, { passive: true });

  /* ================= Dock ================= */
  const dock = document.createElement("button");
  dock.type = "button";
  dock.className = "sentinel-dock";
  dock.id = "sentinelDock";
  dock.setAttribute("aria-label", "Open Sentinel, the dashboard agent");
  dock.dataset.state = "idle";
  dock.innerHTML =
    '<span class="sentinel-plinth" aria-hidden="true"></span>' +
    '<svg class="sentinel-ring" viewBox="0 0 78 78" aria-hidden="true"><rect x="1.5" y="1.5" width="75" height="75" rx="23"/></svg>' +
    '<span class="sentinel-moai" data-state="idle">' + moaiMarkup() + "</span>" +
    '<span class="sentinel-dock-tip" role="presentation"><span id="sentinelTipTitle">Sentinel</span><small id="sentinelTipSub">Ask, or hand it a task · Ctrl K</small></span>' +
    '<span class="sentinel-dock-badge" id="sentinelBadge" hidden>1</span>';
  document.body.append(dock);
  const dockMoai = dock.querySelector(".sentinel-moai");
  const dockLife = animateMoai(dockMoai);
  setTimeout(() => dockLife.play("smile"), 1400);

  /* ================= Unlock wall ================= */
  const wall = document.createElement("canvas");
  wall.className = "sentinel-wall";
  wall.setAttribute("aria-hidden", "true");
  wall.hidden = true;
  document.body.append(wall);

  function themeColors() {
    const dark = root.getAttribute("data-theme") === "dark";
    return dark
      ? { off: [31, 21, 14], palette: [[255, 84, 0], [255, 107, 26], [255, 133, 16], [255, 159, 28], [255, 176, 52], [255, 120, 45]], gap: "#0b0705", flash: [255, 236, 200] }
      : { off: [236, 231, 223], palette: [[232, 137, 10], [242, 160, 60], [196, 104, 0], [242, 182, 133], [226, 120, 30]], gap: "#e4e0da", flash: [255, 247, 232] };
  }

  // The access gate's ripple, played outward from (or back into) the dock:
  // a ring of lit tiles sweeps across the screen and the workspace is clipped
  // to the circle behind it.
  function playUnlock(direction, origin, onRadius) {
    return new Promise(resolve => {
      if (motion.matches) { onRadius(direction === "open" ? 1e5 : 0); resolve(); return; }
      const ctx = wall.getContext("2d");
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = window.innerWidth, H = window.innerHeight;
      wall.width = Math.round(W * dpr); wall.height = Math.round(H * dpr);
      wall.hidden = false;
      const cell = 20;
      const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
      const maxR = Math.hypot(Math.max(origin.x, W - origin.x), Math.max(origin.y, H - origin.y)) + cell * 4;
      const duration = direction === "open" ? 980 : 720;
      const band = cell * 5.5;
      const colors = themeColors();
      const fbm = typeof Lib.fbm === "function" ? Lib.fbm : () => .5;
      const start = performance.now();
      const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const frame = now => {
        const t = Math.min(1, (now - start) / duration);
        const p = direction === "open" ? ease(t) : 1 - ease(t);
        const r = p * maxR;
        onRadius(Math.max(0, r - band * .35));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const time = now / 1000;
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const cx = i * cell + cell / 2, cy = j * cell + cell / 2;
            const d = Math.hypot(cx - origin.x, cy - origin.y);
            const e = r - d;
            if (e < -cell * 1.2 || e > band) continue;
            // Brightest at the wave front, fading into the revealed workspace behind it.
            const front = e < 0 ? Math.max(0, 1 + e / (cell * 1.2)) : Math.max(0, 1 - e / band);
            let b = fbm(i * .09 + time * .2, j * .09, time * .3);
            b = Math.min(1, Math.max(0, (b - .25) / .55));
            const k = ((fbm(i * .05, j * .05 + time * .05, 7) * 1.7) % 1) * colors.palette.length;
            const c0 = colors.palette[Math.floor(k) % colors.palette.length], c1 = colors.palette[(Math.floor(k) + 1) % colors.palette.length];
            const lit = mixColor(c0, c1, k % 1);
            let color = mixColor(colors.off, lit, Math.min(1, .35 + b * .5 + front * .6));
            const flash = e > -cell && e < cell * 1.4 ? 1 - Math.abs(e - cell * .2) / (cell * 1.4) : 0;
            if (flash > 0) color = mixColor(color, colors.flash, flash * .55);
            ctx.globalAlpha = Math.min(1, front * 1.25);
            ctx.fillStyle = colors.gap;
            ctx.fillRect(i * cell, j * cell, cell, cell);
            ctx.fillStyle = "rgb(" + (color[0] | 0) + "," + (color[1] | 0) + "," + (color[2] | 0) + ")";
            ctx.fillRect(i * cell + .5, j * cell + .5, cell - 1, cell - 1);
          }
        }
        ctx.globalAlpha = 1;
        if (t < 1) { requestAnimationFrame(frame); return; }
        ctx.clearRect(0, 0, W, H);
        wall.hidden = true;
        onRadius(direction === "open" ? 1e5 : 0);
        resolve();
      };
      requestAnimationFrame(frame);
    });
  }
  function mixColor(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  /* ================= Workspace ================= */
  const ICONS = {
    send: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h10m-4-4 4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3.5" width="2.6" height="9" rx=".8" fill="currentColor"/><rect x="9.4" y="3.5" width="2.6" height="9" rx=".8" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>',
    fresh: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
  };
  const SUGGESTIONS = [
    ["What changed in the last 7 days, and what matters?", "Reads every recorded change and the AI verdicts"],
    ["Which monitors need attention right now, and why?", "Health, failures, bot checks and stale pages"],
    ["Open the most recent relevant change and walk me through the redline", "Uses the live dashboard with its cursor"],
    ["Show me Scout's new pages to review and point at the strongest one", "Scout findings, side by side with you"]
  ];

  const ws = document.createElement("section");
  ws.className = "sentinel-ws";
  ws.id = "sentinelWorkspace";
  ws.hidden = true;
  ws.setAttribute("role", "dialog");
  ws.setAttribute("aria-modal", "true");
  ws.setAttribute("aria-labelledby", "sentinelTitle");
  ws.dataset.layout = "split";
  ws.dataset.mtab = "chat";
  ws.dataset.state = "idle";
  ws.innerHTML =
    '<header class="sentinel-head">' +
      '<span class="sentinel-head-mark" aria-hidden="true"><span class="sentinel-moai" data-state="idle">' + moaiMarkup() + "</span></span>" +
      '<div class="sentinel-title"><h2 id="sentinelTitle">Sentinel</h2><p><span class="sentinel-status" id="sentinelStatus">Ready</span></p></div>' +
      '<div class="sentinel-head-tools">' +
        '<span class="sentinel-quota" id="sentinelQuota">Connecting…</span>' +
        '<span class="sn-seg" role="group" aria-label="Layout"><button type="button" data-sn-layout="split" aria-pressed="true">Chat + dashboard</button><button type="button" data-sn-layout="chat" aria-pressed="false">Chat only</button></span>' +
        '<button class="sn-btn" type="button" id="sentinelNew" title="Start a new conversation">' + ICONS.fresh + '<span class="sn-label">New</span></button>' +
        '<button class="sn-btn is-icon" type="button" id="sentinelClose" title="Close (Esc)" aria-label="Close Sentinel">' + ICONS.close + "</button>" +
      "</div>" +
    "</header>" +
    '<div class="sentinel-body">' +
      '<div class="sentinel-mtabs sn-seg" role="group" aria-label="Show"><button type="button" data-sn-mtab="chat" aria-pressed="true">Conversation</button><button type="button" data-sn-mtab="stage" aria-pressed="false">Live dashboard</button></div>' +
      '<section class="sentinel-chat" aria-label="Conversation with Sentinel">' +
        '<div class="sentinel-log" id="sentinelLog" aria-live="polite">' +
          '<div class="sentinel-welcome" id="sentinelWelcome">' +
            '<span class="sentinel-eyebrow">Sentinel · agent</span>' +
            "<h3>Ask about any change, or hand me a task.</h3>" +
            "<p>I read the monitoring record behind this dashboard, reason across it, and work in the live dashboard beside you with my own cursor. You can use it at the same time. I ask before anything that saves, sends or starts a scan.</p>" +
            '<div class="sentinel-suggest">' + SUGGESTIONS.map(([q, sub]) => '<button type="button" data-sn-suggest="' + escHtml(q) + '">' + escHtml(q) + "<small>" + escHtml(sub) + "</small></button>").join("") + "</div>" +
          "</div>" +
          '<div id="sentinelTranscript"></div>' +
        "</div>" +
        '<div class="sentinel-composer">' +
          '<form class="sentinel-form" id="sentinelForm" autocomplete="off">' +
            '<label class="visually-hidden" for="sentinelInput">Message Sentinel</label>' +
            '<textarea class="sentinel-input" id="sentinelInput" rows="1" maxlength="1200" placeholder="Ask Sentinel, or describe a task…"></textarea>' +
            '<button class="sn-btn is-primary sentinel-send" id="sentinelSend" type="submit" aria-label="Send">' + ICONS.send + "</button>" +
          "</form>" +
          '<div class="sentinel-foot"><span id="sentinelFootNote">Enter to send · Shift+Enter for a new line</span><button type="button" id="sentinelTakeover" hidden>Take over</button></div>' +
        "</div>" +
      "</section>" +
      '<section class="sentinel-stage" id="sentinelStage" aria-label="Live dashboard shared with Sentinel">' +
        '<div class="sentinel-stagebar">' +
          '<span class="sentinel-crumb"><span id="sentinelCrumb">Live dashboard</span></span>' +
          '<span class="sentinel-cowork" id="sentinelCowork">You and Sentinel share this copy</span>' +
          '<span class="sentinel-presence" aria-hidden="true"><span class="sn-avatar is-person" title="You"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.6" r="2.7" fill="currentColor"/><path d="M2.8 14c.6-2.9 2.6-4.4 5.2-4.4s4.6 1.5 5.2 4.4" fill="currentColor"/></svg></span><span class="sn-avatar is-agent" title="Sentinel"><span class="sn-mini"><i></i><i></i><i></i><i></i></span></span></span>' +
          '<button class="sn-btn" type="button" id="sentinelPause" title="Pause Sentinel and use the dashboard yourself">' + ICONS.pause + '<span class="sn-label">Pause</span></button>' +
        "</div>" +
        '<div class="sentinel-viewport" id="sentinelViewport">' +
          '<div class="sentinel-loading" id="sentinelLoading">Opening the live dashboard…</div>' +
          '<div class="sentinel-overlay" id="sentinelOverlay">' +
            '<div class="sn-cursor" id="sentinelCursor"><svg viewBox="0 0 24 26" aria-hidden="true"><path d="M3 2.5l16.5 9.2-7.3 1.6-3.6 6.9z" fill="var(--sn-cursor)" stroke="#140c08" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.6 6.4l9.2 5.1" stroke="rgba(255,255,255,.55)" stroke-width="1" stroke-linecap="round"/></svg>' +
              '<span class="sn-cursor-label"><span class="sn-mini"><i></i><i></i><i></i><i></i></span><span id="sentinelCursorText">Sentinel</span></span></div>' +
          "</div>" +
        "</div>" +
      "</section>" +
    "</div>";
  document.body.append(ws);
  const $s = id => document.getElementById(id);
  const headMoai = ws.querySelector(".sentinel-head-mark .sentinel-moai");
  animateMoai(headMoai);

  const ui = {
    log: $s("sentinelLog"), transcript: $s("sentinelTranscript"), welcome: $s("sentinelWelcome"),
    form: $s("sentinelForm"), input: $s("sentinelInput"), send: $s("sentinelSend"), quota: $s("sentinelQuota"),
    status: $s("sentinelStatus"), stage: $s("sentinelStage"), viewport: $s("sentinelViewport"), overlay: $s("sentinelOverlay"),
    cursor: $s("sentinelCursor"), cursorText: $s("sentinelCursorText"), loading: $s("sentinelLoading"),
    crumb: $s("sentinelCrumb"), cowork: $s("sentinelCowork"), pause: $s("sentinelPause"), takeover: $s("sentinelTakeover"),
    footNote: $s("sentinelFootNote")
  };

  /* ================= Agent state ================= */
  const agent = {
    open: false, animating: false, running: false, stopRequested: false, paused: false, resumeWaiters: [],
    messages: [], remaining: null, limit: 50, warmed: false,
    activity: [], humanBusyUntil: 0, acting: false, queued: [],
    frame: null, frameReady: null, scale: 1, cursor: { x: -60, y: -60, shown: false }, cursorHideTimer: 0,
    refs: new Map(), refOf: new WeakMap(), refSerial: 0, spot: null
  };

  function setAgentState(value, text) {
    ws.dataset.state = value;
    dock.dataset.state = value;
    dockMoai.dataset.state = value;
    headMoai.dataset.state = value;
    if (text) ui.status.textContent = text;
  }

  function updateQuota(remaining, limit) {
    if (Number.isInteger(limit) && limit > 0) agent.limit = limit;
    if (Number.isInteger(remaining) && remaining >= 0) agent.remaining = remaining;
    if (agent.remaining == null) { ui.quota.textContent = "Ready"; return; }
    ui.quota.textContent = agent.remaining + " of " + agent.limit + " questions left today";
    ui.quota.classList.toggle("is-low", agent.remaining > 0 && agent.remaining <= 5);
    ui.quota.classList.toggle("is-empty", agent.remaining <= 0);
    const sub = $s("sentinelTipSub");
    if (sub && !dock.classList.contains("has-note")) sub.textContent = agent.remaining + " of " + agent.limit + " questions left today · Ctrl K";
  }

  async function warm() {
    if (agent.warmed || !ENDPOINT) return;
    try {
      const identity = await askSentinelIdentity();
      const response = await fetch(ENDPOINT + "?mode=warm", { headers: askSentinelIdentityHeaders(identity), credentials: "omit" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.ok) { agent.warmed = true; updateQuota(payload.remaining, payload.limit); }
      else ui.quota.textContent = "Offline — retry by asking";
    } catch (_) {
      ui.quota.textContent = "Offline — retry by asking";
    }
  }

  /* ================= Open / close ================= */
  function dockCenter() {
    const box = dock.getBoundingClientRect();
    if (!box.width) return { x: window.innerWidth - 60, y: window.innerHeight - 60 };
    return { x: box.left + box.width / 2, y: box.top + box.height * .45 };
  }
  async function openWorkspace(options) {
    options = options || {};
    if (agent.animating) return;
    if (agent.open) { ui.input.focus({ preventScroll: true }); return; }
    if (root.classList.contains("cs-locked")) return;
    agent.animating = true;
    agent.open = true;
    dock.classList.remove("has-note");
    $s("sentinelBadge").hidden = true;
    dockLife.play("blink");
    const origin = dockCenter();
    ws.style.setProperty("--sn-x", origin.x + "px");
    ws.style.setProperty("--sn-y", origin.y + "px");
    ws.style.setProperty("--sn-r", "0px");
    ws.classList.add("is-revealing");
    ws.hidden = false;
    dock.classList.add("is-hidden");
    ensureFrame();
    await playUnlock("open", origin, r => ws.style.setProperty("--sn-r", r + "px"));
    ws.classList.remove("is-revealing");
    agent.animating = false;
    layoutFrame();
    void warm();
    if (options.prompt) { ui.input.value = options.prompt; void submit(); }
    else ui.input.focus({ preventScroll: true });
  }
  async function closeWorkspace() {
    if (!agent.open || agent.animating) return;
    agent.animating = true;
    const origin = dockCenter();
    ws.style.setProperty("--sn-x", origin.x + "px");
    ws.style.setProperty("--sn-y", origin.y + "px");
    ws.classList.add("is-revealing");
    await playUnlock("close", origin, r => ws.style.setProperty("--sn-r", r + "px"));
    ws.hidden = true;
    ws.classList.remove("is-revealing");
    dock.classList.remove("is-hidden");
    agent.open = false;
    agent.animating = false;
    dock.focus({ preventScroll: true });
  }
  window.Sentinel = { open: openWorkspace, close: closeWorkspace, ask: prompt => openWorkspace({ prompt }) };

  dock.addEventListener("click", () => openWorkspace());
  $s("sentinelClose").addEventListener("click", closeWorkspace);
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === "k") {
      if (root.classList.contains("cs-locked")) return;
      event.preventDefault();
      if (agent.open) ui.input.focus(); else openWorkspace();
      return;
    }
    if (event.key === "Escape" && agent.open && !event.defaultPrevented && !ws.querySelector(".sn-card:not(.is-done)")) {
      event.preventDefault();
      closeWorkspace();
    }
  });

  ws.addEventListener("click", event => {
    const layout = event.target.closest("[data-sn-layout]");
    if (layout) { setLayout(layout.dataset.snLayout); return; }
    const mtab = event.target.closest("[data-sn-mtab]");
    if (mtab) { setMobileTab(mtab.dataset.snMtab); return; }
    const suggestion = event.target.closest("[data-sn-suggest]");
    if (suggestion) { ui.input.value = suggestion.dataset.snSuggest; void submit(); return; }
    const route = event.target.closest("a[data-sn-route]");
    if (route) { event.preventDefault(); void openRouteInStage(route.getAttribute("href")); return; }
    const step = event.target.closest(".sn-step[data-has-detail]");
    if (step) { const detail = step.querySelector(".sn-step-detail"); if (detail) detail.hidden = !detail.hidden; }
  });
  function setLayout(value) {
    ws.dataset.layout = value === "chat" ? "chat" : "split";
    ws.querySelectorAll("[data-sn-layout]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.snLayout === ws.dataset.layout)));
    requestAnimationFrame(layoutFrame);
  }
  function setMobileTab(value) {
    ws.dataset.mtab = value === "stage" ? "stage" : "chat";
    ws.querySelectorAll("[data-sn-mtab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.snMtab === ws.dataset.mtab)));
    requestAnimationFrame(layoutFrame);
  }
  const isCompactScreen = () => window.matchMedia("(max-width: 980px)").matches;
  function showStage() {
    if (isCompactScreen()) setMobileTab("stage");
    else if (ws.dataset.layout !== "split") setLayout("split");
  }

  /* ================= Live dashboard (stage) ================= */
  function ensureFrame() {
    if (agent.frame) return agent.frameReady;
    const frame = document.createElement("iframe");
    frame.className = "sentinel-frame";
    frame.title = "Live dashboard shared with Sentinel";
    const url = new URL(location.href);
    url.searchParams.set("sentinel-embed", "1");
    url.hash = location.hash && !/ask-sentinel/.test(location.hash) ? location.hash : "";
    frame.src = url.toString();
    agent.frame = frame;
    ui.viewport.insertBefore(frame, ui.overlay);
    agent.frameReady = new Promise(resolve => {
      const check = () => {
        try {
          const b = frame.contentWindow && frame.contentWindow.SentinelEmbed;
          if (b && b.ready()) { ui.loading.hidden = true; wireFrame(); resolve(true); return; }
        } catch (_) {}
        setTimeout(check, 200);
      };
      frame.addEventListener("load", check);
    });
    if (window.ResizeObserver) new ResizeObserver(layoutFrame).observe(ui.viewport);
    window.addEventListener("resize", layoutFrame);
    return agent.frameReady;
  }
  // Render the copy at desktop width and scale it into the stage, so the
  // person sees the full dashboard rather than its phone layout.
  function layoutFrame() {
    const frame = agent.frame;
    if (!frame) return;
    const W = ui.viewport.clientWidth, H = ui.viewport.clientHeight;
    if (!W || !H) return;
    const base = isCompactScreen() ? W : Math.max(W, 1220);
    const scale = W / base;
    agent.scale = scale;
    frame.style.width = base + "px";
    frame.style.height = Math.ceil(H / scale) + "px";
    frame.style.transform = scale === 1 ? "" : "scale(" + scale + ")";
  }
  const frameWin = () => (agent.frame && agent.frame.contentWindow) || null;
  const frameDoc = () => { try { return agent.frame && agent.frame.contentDocument; } catch (_) { return null; } };
  const bridge = () => { try { return frameWin() && frameWin().SentinelEmbed; } catch (_) { return null; } };

  const VIEW_NAMES = { overview: "overview", changes: "changes", pages: "monitors", runs: "runs", health: "health", alerts: "notifications", registry: "registry", scout: "scout", cadence: "calendar", calendar: "calendar", monitors: "monitors", notifications: "notifications" };
  const VIEW_LABELS = { overview: "Overview", changes: "Changes", monitors: "Pages", runs: "Runs", health: "Health", notifications: "Alerts", registry: "Registry", scout: "Scout", calendar: "Cadence" };
  const ROW_SELECTORS = { changes: "data-select-change", monitors: "data-monitor-id", runs: "data-select-run", notifications: "data-select-notification", scout: "data-scout-key", registry: "data-select-registry", health: "data-select-health" };

  function updateCrumb() {
    const b = bridge();
    const doc = frameDoc();
    if (!b || !doc) return;
    const view = b.view();
    const heading = doc.querySelector(".view:not([hidden]) .detail h2, .view:not([hidden]) .detail-title, .view:not([hidden]) h1:not(.visually-hidden)");
    ui.crumb.textContent = (VIEW_LABELS[view] || "Dashboard") + (heading && heading.textContent.trim() ? " · " + clampText(heading.textContent, 70) : "");
  }

  // The person's own actions in the shared copy: shown in the stage bar and
  // passed to Sentinel with its next step.
  function wireFrame() {
    const doc = frameDoc();
    const win = frameWin();
    if (!doc || !win || doc.__sentinelWired) return;
    doc.__sentinelWired = true;
    const busy = () => { agent.humanBusyUntil = Date.now() + 1400; };
    ["pointerdown", "keydown", "wheel"].forEach(type => doc.addEventListener(type, event => { if (event.isTrusted) busy(); }, { capture: true, passive: true }));
    doc.addEventListener("click", event => {
      if (!event.isTrusted) return;
      const target = event.target.closest(INTERACTIVE) || event.target;
      noteHuman("clicked " + describeEl(target));
      clearSpot();
      ping(event.clientX * agent.scale, event.clientY * agent.scale);
      setTimeout(updateCrumb, 250);
    }, true);
    doc.addEventListener("change", event => {
      if (!event.isTrusted) return;
      const el = event.target;
      if (el.matches("select")) noteHuman("chose “" + clampText(el.selectedOptions[0] ? el.selectedOptions[0].textContent : el.value, 50) + "” in " + describeEl(el));
      else if (el.matches("input[type=checkbox], input[type=radio]")) noteHuman((el.checked ? "ticked " : "unticked ") + describeEl(el));
    }, true);
    let typingTimer = 0;
    doc.addEventListener("input", event => {
      if (!event.isTrusted) return;
      const el = event.target;
      if (!el.matches("input, textarea")) return;
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        const secret = el.type === "password";
        noteHuman("typed " + (secret ? "a password" : "“" + clampText(el.value, 60) + "”") + " into " + describeEl(el));
      }, 900);
    }, true);
    win.addEventListener("hashchange", () => setTimeout(updateCrumb, 200));
    updateCrumb();
  }
  function noteHuman(text) {
    agent.activity.push(text);
    if (agent.activity.length > 30) agent.activity.shift();
    ui.cowork.innerHTML = "<b>You</b> " + escHtml(text);
    clearTimeout(noteHuman.timer);
    noteHuman.timer = setTimeout(() => { ui.cowork.textContent = agent.running ? "Sentinel is working — you can keep using the dashboard" : "You and Sentinel share this copy"; }, 5000);
  }
  function ping(x, y) {
    const el = document.createElement("span");
    el.className = "sn-human-ping";
    el.style.left = x + "px"; el.style.top = y + "px";
    ui.overlay.append(el);
    setTimeout(() => el.remove(), 800);
  }

  ui.pause.addEventListener("click", () => setPaused(!agent.paused));
  ui.takeover.addEventListener("click", () => { setPaused(!agent.paused); if (agent.paused) showStage(); });
  function setPaused(value) {
    agent.paused = !!value;
    ui.stage.classList.toggle("is-paused", agent.paused);
    ui.pause.innerHTML = (agent.paused ? ICONS.play + '<span class="sn-label">Resume</span>' : ICONS.pause + '<span class="sn-label">Pause</span>');
    ui.pause.classList.toggle("is-on", agent.paused);
    ui.takeover.textContent = agent.paused ? "Resume Sentinel" : "Take over";
    if (agent.paused) {
      setAgentState("waiting", "Paused — the dashboard is yours");
      noteHuman("paused Sentinel");
    } else {
      if (agent.running) setAgentState("thinking", "Resuming…");
      else setAgentState("idle", "Ready");
      agent.resumeWaiters.splice(0).forEach(resolve => resolve());
    }
  }
  async function checkpoint() {
    if (agent.stopRequested) throw new StopSignal();
    if (agent.paused) await new Promise(resolve => agent.resumeWaiters.push(resolve));
    if (agent.stopRequested) throw new StopSignal();
  }
  class StopSignal extends Error {}
  // Never act while the person is in the middle of something.
  async function yieldToPerson() {
    let waited = false;
    while (Date.now() < agent.humanBusyUntil) {
      if (!waited) { cursorLabel("Waiting for you…", "yield"); waited = true; }
      await sleep(200);
    }
  }

  /* ================= Sentinel's cursor ================= */
  function cursorLabel(text, mode) {
    ui.cursorText.textContent = text || "Sentinel";
    ui.cursor.classList.toggle("is-waiting", mode === "waiting");
    ui.cursor.classList.toggle("is-yield", mode === "yield");
  }
  function placeCursor(x, y) {
    agent.cursor.x = x; agent.cursor.y = y;
    ui.cursor.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px)";
    ui.cursor.classList.toggle("is-flip-x", x > ui.viewport.clientWidth - 230);
    ui.cursor.classList.toggle("is-flip-y", y > ui.viewport.clientHeight - 56);
  }
  function showCursor() {
    clearTimeout(agent.cursorHideTimer);
    if (!agent.cursor.shown) {
      agent.cursor.shown = true;
      const w = ui.viewport.clientWidth, h = ui.viewport.clientHeight;
      if (agent.cursor.x < 0) placeCursor(w * .72, h * .82);
      ui.cursor.classList.add("is-on");
    }
  }
  function restCursor() {
    clearTimeout(agent.cursorHideTimer);
    agent.cursorHideTimer = setTimeout(() => { ui.cursor.classList.remove("is-on"); agent.cursor.shown = false; }, 5000);
  }
  function moveCursor(x, y) {
    showCursor();
    const sx = agent.cursor.x, sy = agent.cursor.y;
    const dist = Math.hypot(x - sx, y - sy);
    if (motion.matches || dist < 2) { placeCursor(x, y); return Promise.resolve(); }
    const duration = Math.max(260, Math.min(760, dist * 1.05));
    // A slight arc, like a hand moving a mouse.
    const nx = -(y - sy) / (dist || 1), ny = (x - sx) / (dist || 1);
    const bend = Math.min(60, dist * .18) * (Math.random() < .5 ? -1 : 1);
    const cx = (sx + x) / 2 + nx * bend, cy = (sy + y) / 2 + ny * bend;
    const start = performance.now();
    return new Promise(resolve => {
      const step = now => {
        const t = Math.min(1, (now - start) / duration);
        const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const px = (1 - e) * (1 - e) * sx + 2 * (1 - e) * e * cx + e * e * x;
        const py = (1 - e) * (1 - e) * sy + 2 * (1 - e) * e * cy + e * e * y;
        placeCursor(px, py);
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  async function pressCursor() {
    ui.cursor.classList.add("is-press");
    ripple(agent.cursor.x, agent.cursor.y);
    await sleep(140);
    ui.cursor.classList.remove("is-press");
  }
  // The LED click: a square ring of tiles bursting out of the pointer.
  function ripple(x, y) {
    if (motion.matches) return;
    const box = document.createElement("span");
    box.className = "sn-ripple";
    box.style.left = x + "px"; box.style.top = y + "px";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const tile = document.createElement("i");
      tile.style.setProperty("--dx", (Math.cos(a) * 18).toFixed(1) + "px");
      tile.style.setProperty("--dy", (Math.sin(a) * 18).toFixed(1) + "px");
      tile.style.animationDelay = (i % 3) * 20 + "ms";
      box.append(tile);
    }
    ui.overlay.append(box);
    setTimeout(() => box.remove(), 800);
  }
  function stageRect(el) {
    const r = el.getBoundingClientRect();
    const s = agent.scale;
    return { x: r.left * s, y: r.top * s, w: r.width * s, h: r.height * s };
  }
  function spotlight(el, note) {
    const r = stageRect(el);
    if (!agent.spot) {
      agent.spot = document.createElement("div");
      agent.spot.className = "sn-spot";
      agent.spot.style.opacity = "0";
      ui.overlay.append(agent.spot);
    }
    const pad = 4;
    // From hidden it appears in place; from another target it glides.
    const jump = getComputedStyle(agent.spot).opacity === "0";
    if (jump) agent.spot.style.transition = "none";
    Object.assign(agent.spot.style, { left: r.x - pad + "px", top: r.y - pad + "px", width: r.w + pad * 2 + "px", height: r.h + pad * 2 + "px" });
    if (jump) { void agent.spot.offsetWidth; agent.spot.style.transition = ""; }
    agent.spot.style.opacity = "1";
    agent.spot.classList.toggle("is-flip", r.y + r.h > ui.viewport.clientHeight - 70);
    // A pointer stays up long enough to be read, then fades by itself.
    clearTimeout(agent.spotTimer);
    agent.spotTimer = setTimeout(clearSpot, 9000);
    agent.spot.innerHTML = note ? '<span class="sn-spot-note">' + escHtml(note) + "</span>" : "";
  }
  function clearSpot() { clearTimeout(agent.spotTimer); if (agent.spot) agent.spot.style.opacity = "0"; }
  async function bringIntoView(el) {
    const r = el.getBoundingClientRect();
    const win = frameWin();
    if (!win) return;
    if (r.top < 60 || r.bottom > win.innerHeight - 30 || r.left < 0 || r.right > win.innerWidth) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: motion.matches ? "auto" : "smooth" });
      await sleep(motion.matches ? 60 : 420);
    }
  }
  async function aimAt(el, label) {
    await bringIntoView(el);
    const r = stageRect(el);
    cursorLabel(label);
    await moveCursor(r.x + Math.min(r.w * .5, Math.max(10, r.w - 12)), r.y + Math.min(r.h * .55, r.h - 4));
  }

  /* ================= Reading the screen ================= */
  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="checkbox"], [role="switch"], [role="option"], [contenteditable="true"]';
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("[hidden], [aria-hidden='true'], .cs-gate, .sentinel-dock")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const win = frameWin();
    if (r.bottom < 0 || r.top > win.innerHeight || r.right < 0 || r.left > win.innerWidth) return false;
    const style = win.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > .05;
  }
  function labelOf(el) {
    const doc = frameDoc();
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy && doc) {
      const text = labelledBy.split(/\s+/).map(id => (doc.getElementById(id) || {}).textContent || "").join(" ").trim();
      if (text) return text;
    }
    if (el.labels && el.labels.length) return el.labels[0].textContent;
    if (el.matches("input, textarea, select")) return el.getAttribute("placeholder") || el.getAttribute("name") || el.title || "";
    return el.innerText || el.textContent || el.title || el.getAttribute("value") || "";
  }
  function describeEl(el) {
    if (!el || !el.matches) return "the page";
    const name = clampText(labelOf(el), 60);
    const kind = el.matches("a") ? "link" : el.matches("select") ? "list" : el.matches("textarea, input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])") ? "field" : el.matches("input[type=checkbox]") ? "checkbox" : "button";
    return (name ? "“" + name + "” " : "") + kind;
  }
  function regionOf(el) {
    const dialog = el.closest("dialog[open], [role=dialog]");
    if (dialog) {
      const title = dialog.querySelector("h1, h2, h3, legend");
      return "dialog" + (title ? ": " + clampText(title.textContent, 40) : "");
    }
    if (el.closest(".rail")) return "navigation";
    if (el.closest(".list-pane, .list, [class*='-list']")) return "list";
    if (el.closest(".detail, [class*='detail']")) return "detail";
    return "page";
  }
  function refFor(el) {
    let ref = agent.refOf.get(el);
    if (!ref || agent.refs.get(ref) !== el) {
      ref = "e" + (++agent.refSerial);
      agent.refOf.set(el, ref);
      agent.refs.set(ref, el);
    }
    return ref;
  }
  function elementForRef(ref) {
    const el = agent.refs.get(String(ref || "").trim());
    return el && el.isConnected ? el : null;
  }
  async function readScreen(args) {
    await frameUsable();
    const doc = frameDoc();
    const b = bridge();
    const scopeDialog = doc.querySelector("dialog[open]");
    const scope = scopeDialog || doc.body;
    const lines = [];
    const view = b ? b.view() : "";
    lines.push("View: " + (VIEW_LABELS[view] || view || "dashboard") + "  (address " + (frameWin().location.hash || "#overview") + ")");
    if (scopeDialog) lines.push("A dialog is open; only its controls are listed. Close it to reach the page behind.");
    const headings = Array.from(scope.querySelectorAll("h1, h2, h3")).filter(isVisible).map(h => clampText(h.textContent, 80)).filter(Boolean).slice(0, 8);
    if (headings.length) lines.push("Headings: " + headings.join(" | "));
    const controls = Array.from(scope.querySelectorAll(INTERACTIVE)).filter(isVisible);
    const query = String(args && args.filter || "").toLowerCase();
    let shown = 0;
    lines.push("Controls on screen:");
    for (const el of controls) {
      const name = clampText(labelOf(el), 90);
      if (query && !(name.toLowerCase().includes(query))) continue;
      if (shown >= 90) { lines.push("… more controls; pass filter to narrow, or scroll."); break; }
      const kind = el.matches("a") ? "link" : el.matches("select") ? "select" : el.matches("textarea") ? "textarea" : el.matches("input") ? "input:" + (el.type || "text") : el.getAttribute("role") || "button";
      const bits = ["[" + refFor(el) + "]", kind, name ? "“" + name + "”" : "(no label)"];
      if (el.matches("input:not([type=checkbox]):not([type=radio]), textarea") && el.value && el.type !== "password") bits.push("value=“" + clampText(el.value, 50) + "”");
      if (el.matches("select")) bits.push("selected=“" + clampText(el.selectedOptions[0] ? el.selectedOptions[0].textContent : el.value, 40) + "” options: " + Array.from(el.options).slice(0, 12).map(o => clampText(o.textContent, 30)).join(" / "));
      if (el.matches("input[type=checkbox], input[type=radio]")) bits.push(el.checked ? "checked" : "unchecked");
      if (el.disabled) bits.push("disabled");
      if (el.getAttribute("aria-current") === "page" || el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-pressed") === "true") bits.push("current");
      if (el.getAttribute("aria-expanded")) bits.push("expanded=" + el.getAttribute("aria-expanded"));
      if (consequenceOf(el)) bits.push("needs approval");
      bits.push("in " + regionOf(el));
      lines.push(bits.join(" "));
      shown += 1;
    }
    // A bounded slice of the readable text the person is looking at.
    const textHost = scopeDialog || doc.querySelector(".view:not([hidden]) .detail") || doc.querySelector(".view:not([hidden])") || doc.body;
    const text = clampText(textHost.innerText || "", 2600);
    if (text) lines.push("Visible text: " + text);
    updateCrumb();
    return lines.join("\n");
  }

  /* ================= Consequential actions ================= */
  const SAFE_HINT = /^(cancel|close|back|done|dismiss tip|next|previous|more|less|show|hide|expand|collapse|copy|zoom|full ?screen|light theme|dark theme|reload)\b/i;
  const RISKY_WORDS = /\b(save|submit|send|register|start|scan now|run (?:a )?scan|delete|remove|archive|stop monitoring|approve|record|request|file|dispatch|confirm|apply|import|create|update|publish|monitor (?:this|these|selected|\d+)|add (?:\d+|this|these|selected|link|links|monitor|to)|dismiss|restore|sign (?:in|out)|reset|email|test alert|subscribe)\b/i;
  function consequenceOf(el) {
    if (!el || !el.matches) return "";
    const name = clampText(labelOf(el), 80);
    if (el.matches("[data-view], [data-select-change], [data-monitor-id], [data-select-run], [data-select-notification], [data-select-health], [data-scout-key], [data-select-registry], [data-detail-tab], [data-diff-mode], [data-snapshot-mode], [data-filter], [data-change-filter], [data-scout-filter], [data-go], [data-back], [data-sn-safe]")) return "";
    if (el.matches("[data-run-scan]")) return "start a scan on GitHub Actions";
    if (el.matches("a[href]")) {
      const href = el.getAttribute("href") || "";
      if (/^(#|javascript:)/i.test(href)) return "";
      try {
        const url = new URL(href, frameWin().location.href);
        if (url.origin !== frameWin().location.origin || el.target === "_blank") return "open an outside page (" + url.hostname + ")";
      } catch (_) { return ""; }
      return "";
    }
    if (SAFE_HINT.test(name)) return "";
    if (el.matches("button[type=submit], input[type=submit]") || (el.matches("button:not([type])") && el.closest("form"))) return "submit “" + (name || "this form") + "”";
    if (RISKY_WORDS.test(name)) return "press “" + name + "”";
    return "";
  }

  /* ================= Rendering the conversation ================= */
  function scrollLog() { ui.log.scrollTop = ui.log.scrollHeight; }
  function renderMarkdown(text) {
    let html = typeof askSentinelMarkdown === "function" ? askSentinelMarkdown(text) : "<p>" + escHtml(text) + "</p>";
    // Dashboard links ([title](#changes/<id>)) open in the live copy.
    html = html.replace(/\[([^\]<]{1,160})\]\((#(?:overview|changes|pages|runs|health|alerts|registry|scout|cadence)(?:\/[A-Za-z0-9%._|:~-]{1,200})?)\)/g,
      (_, label, href) => '<a href="' + href + '" data-sn-route>' + label + "</a>");
    return html;
  }
  function addMessage(kind, text, meta) {
    ui.welcome.hidden = true;
    const node = document.createElement("article");
    node.className = "sn-msg is-" + kind;
    const role = kind === "user" ? "You" : kind === "note" ? "Dashboard" : "Sentinel";
    node.innerHTML = '<div class="sn-msg-role">' + role + '</div><div class="sn-msg-text"></div>' + (meta ? '<div class="sn-msg-meta">' + escHtml(meta) + "</div>" : "");
    const body = node.querySelector(".sn-msg-text");
    if (kind === "agent") body.innerHTML = renderMarkdown(text);
    else body.textContent = text;
    ui.transcript.append(node);
    scrollLog();
    return node;
  }
  let stepsBox = null;
  function stepRow(label, status) {
    if (!stepsBox) {
      ui.welcome.hidden = true;
      stepsBox = document.createElement("div");
      stepsBox.className = "sn-steps";
      ui.transcript.append(stepsBox);
    }
    const row = document.createElement("div");
    row.className = "sn-step";
    row.dataset.status = status || "running";
    row.innerHTML = '<i aria-hidden="true"></i><span>' + label + '</span><em></em>';
    stepsBox.append(row);
    scrollLog();
    return {
      el: row,
      set(statusValue) { row.dataset.status = statusValue; },
      done(statusValue, note, detail) {
        row.dataset.status = statusValue;
        if (note) row.querySelector("em").textContent = note;
        if (detail) {
          row.dataset.hasDetail = "1";
          const box = document.createElement("div");
          box.className = "sn-step-detail";
          box.hidden = true;
          box.textContent = detail;
          row.append(box);
        }
      }
    };
  }
  function endSteps() { stepsBox = null; }

  function approvalCard(action, target, region) {
    return new Promise(resolve => {
      ui.welcome.hidden = true;
      const card = document.createElement("div");
      card.className = "sn-card is-approval";
      card.innerHTML = '<div class="sn-card-kicker">Approval needed</div>' +
        '<p class="sn-card-title">Sentinel wants to ' + escHtml(action) + ".</p>" +
        '<p class="sn-card-sub">' + escHtml(target) + (region ? " · " + escHtml(region) : "") + "</p>" +
        '<div class="sn-card-actions"><button class="sn-btn is-primary" type="button" data-answer="yes">Approve</button><button class="sn-btn" type="button" data-answer="no">Decline</button><button class="sn-btn" type="button" data-answer="look">Show me first</button></div>';
      ui.transcript.append(card);
      endSteps();
      scrollLog();
      card.addEventListener("click", event => {
        const button = event.target.closest("[data-answer]");
        if (!button) return;
        if (button.dataset.answer === "look") { showStage(); return; }
        const yes = button.dataset.answer === "yes";
        card.classList.add("is-done");
        card.insertAdjacentHTML("beforeend", '<div class="sn-card-result">' + (yes ? "Approved" : "Declined") + "</div>");
        resolve(yes);
      });
      card.querySelector("[data-answer=yes]").focus({ preventScroll: true });
    });
  }
  function questionCard(question, options) {
    return new Promise(resolve => {
      ui.welcome.hidden = true;
      const card = document.createElement("div");
      card.className = "sn-card is-question";
      const opts = Array.isArray(options) ? options.map(o => clampText(o, 80)).filter(Boolean).slice(0, 6) : [];
      card.innerHTML = '<div class="sn-card-kicker">Sentinel asks</div><p class="sn-card-title">' + escHtml(question) + "</p>" +
        (opts.length ? '<div class="sn-card-actions">' + opts.map(o => '<button class="sn-btn" type="button" data-option="' + escHtml(o) + '">' + escHtml(o) + "</button>").join("") + "</div>" : "") +
        '<input class="sn-card-input" type="text" maxlength="400" placeholder="' + (opts.length ? "Or type an answer…" : "Type your answer…") + '">';
      ui.transcript.append(card);
      endSteps();
      scrollLog();
      const input = card.querySelector("input");
      const finish = answer => {
        card.classList.add("is-done");
        card.insertAdjacentHTML("beforeend", '<div class="sn-card-result">You: ' + escHtml(answer) + "</div>");
        resolve(answer);
      };
      card.addEventListener("click", event => { const b = event.target.closest("[data-option]"); if (b) finish(b.dataset.option); });
      input.addEventListener("keydown", event => { if (event.key === "Enter" && input.value.trim()) { event.preventDefault(); finish(input.value.trim()); } });
      input.focus({ preventScroll: true });
    });
  }

  /* ================= Tools ================= */
  const fn = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: properties || {}, required: required || [] } } });
  const TOOL_SPECS = [
    fn("get_overview", "Snapshot of the whole dashboard: pages and sources monitored, status counts, the last scan and its counts, the next scheduled scan, changes in the last 7 days, fleet health, pending alerts, Scout findings to review and upcoming dates."),
    fn("list_changes", "Recorded changes and alerts, newest first, with page, regulator, type, AI relevance verdict and one-line summary. Filter by days, text, regulator or type.", {
      days: { type: "integer", description: "Look back this many days (default 7, max 400)." },
      query: { type: "string", description: "Text to match in page title, URL, regulator or summary." },
      type: { type: "string", enum: ["any", "content", "new", "removed", "markup", "visual", "errors"], description: "Kind of event (default any)." },
      relevant_only: { type: "boolean", description: "Only changes the AI judged relevant." },
      limit: { type: "integer", description: "Max rows (default 25, max 60)." }
    }),
    fn("get_change", "Full detail of one change: the page, timestamps, AI analysis, review decision, and the redline (removed and added lines) from its evidence file.", { event_id: { type: "string" } }, ["event_id"]),
    fn("find_pages", "Monitored pages and documents with status, regulator, kind, last check and last change. Filter by text, regulator or status.", {
      query: { type: "string" }, regulator: { type: "string" },
      status: { type: "string", enum: ["any", "changed", "problem", "ok", "pending"] },
      limit: { type: "integer", description: "Max rows (default 25, max 80)." }
    }),
    fn("get_page", "One monitored page: URL, status, source and scan schedule, health, saved snapshots and its last changes.", { url_id: { type: "string" }, url: { type: "string" } }),
    fn("list_runs", "Recent scan runs, newest first, with per-run counts.", { limit: { type: "integer", description: "Default 12, max 40." }, source_query: { type: "string" } }),
    fn("get_run", "All source results and counts for one run ID.", { run_id: { type: "string" } }, ["run_id"]),
    fn("get_health", "Fleet health: totals, failing, stale, bot-protected and year-bound monitors, 7-day check and failure volumes."),
    fn("list_alerts", "Alerts sent (kind, time, channels) and alerts still waiting in the outbox with their errors.", { limit: { type: "integer" } }),
    fn("list_scout", "Scout's findings of new regulator pages. Buckets: REVIEW (new, to decide), BACKLOG (older relevant), EXCLUDED, DONE.", { bucket: { type: "string", enum: ["REVIEW", "BACKLOG", "EXCLUDED", "DONE"] }, query: { type: "string" }, limit: { type: "integer" } }),
    fn("list_calendar", "Upcoming regulatory dates detected in monitored pages (effective dates, deadlines, comment periods).", { days: { type: "integer", description: "Days ahead (default 90)." } }),
    fn("find_registry", "Reporting items in the Registry and the changes that touched them.", { query: { type: "string" } }),
    fn("open_view", "Go to a view in the live dashboard (Sentinel's cursor clicks the navigation), optionally selecting one item by its ID.", {
      view: { type: "string", enum: ["overview", "changes", "pages", "runs", "health", "alerts", "registry", "scout", "cadence"] },
      item_id: { type: "string", description: "event_id for changes, url_id for pages, run key for runs, finding key for scout." }
    }, ["view"]),
    fn("read_screen", "List the controls visible in the live dashboard right now, each with a ref (e.g. e12) to use with click, type and select_option, plus the headings and visible text. Call after anything changes the screen.", { filter: { type: "string", description: "Only controls whose label contains this text." } }),
    fn("click", "Click a control in the live dashboard by its ref from read_screen. Consequential controls (save, submit, send, scan, delete…) wait for the person's approval.", { ref: { type: "string" }, why: { type: "string", description: "Short reason, shown on Sentinel's cursor." } }, ["ref"]),
    fn("type", "Type text into a field in the live dashboard by ref. Replaces the field's text unless append is true. submit presses Enter or submits the form (needs approval when it sends something).", { ref: { type: "string" }, text: { type: "string" }, append: { type: "boolean" }, submit: { type: "boolean" } }, ["ref", "text"]),
    fn("select_option", "Choose an option in a select list by ref, by its visible text or value.", { ref: { type: "string" }, option: { type: "string" } }, ["ref", "option"]),
    fn("scroll", "Scroll the live dashboard: a control into view by ref, or the area under the cursor up or down.", { ref: { type: "string" }, direction: { type: "string", enum: ["up", "down"] } }),
    fn("point_at", "Highlight a control or area for the person with a short note, without clicking it.", { ref: { type: "string" }, note: { type: "string" } }, ["ref"]),
    fn("ask_person", "Ask the person a question and wait for the answer, for a decision or missing detail. Give options when there are a few clear choices.", { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, ["question"])
  ];

  const MAX_RESULT = 8500;
  const out = value => { const text = typeof value === "string" ? value : JSON.stringify(value); return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + "…[truncated]" : text; };
  const iso = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d+Z$/, "Z"); };
  const daysAgo = value => { const t = new Date(value).getTime(); return Number.isFinite(t) ? Math.round((Date.now() - t) / 864e5 * 10) / 10 : null; };
  const lc = value => String(value || "").toLowerCase();
  async function dataReady() {
    for (let i = 0; i < 100 && !state.loaded; i++) await sleep(150);
    if (!state.loaded) throw new Error("The monitoring data has not loaded yet.");
  }
  const regulatorOf = item => { try { return typeof itemRegulator === "function" ? itemRegulator(item) : (item.regulator || ""); } catch (_) { return item.regulator || ""; } };
  const regulatorName = value => (value && typeof value === "object") ? (value.name || value.short_name || value.id || "") : String(value || "");
  function changeBrief(entry) {
    const item = typeof itemForEvent === "function" ? itemForEvent(entry) : null;
    const verdict = typeof verdictFor === "function" ? verdictFor(entry) : { state: "unreviewed" };
    return {
      event_id: entry.event_id,
      type: Lib.eventLabel(entry.event_type), event_type: entry.event_type,
      at: iso(entry.timestamp),
      page: item ? itemTitle(item) : clampText(entry.url, 120),
      url: entry.url || (item && item.canonical_url) || "",
      url_id: entry.url_id || (item && item.url_id) || "",
      regulator: item ? regulatorName(regulatorOf(item)) : "",
      ai: verdict.state,
      topic: verdict.analysis && verdict.analysis.topic || undefined,
      summary: clampText(typeof eventHeadline === "function" ? eventHeadline(entry) : "", 260),
      link: "#changes/" + entry.event_id
    };
  }
  const TYPE_FILTERS = {
    content: ["CHANGED_URL", "SOURCE_CHANGED"], new: ["NEW_URL"], removed: ["REMOVED_URL"], markup: ["HTML_SOURCE_CHANGED"],
    visual: ["VISUAL_CHANGED"], errors: ["FETCH_ERROR", "EXTRACTION_ERROR"]
  };
  function diffDigest(diff) {
    const lines = String(diff || "").split("\n");
    const removed = [], added = [];
    for (const line of lines) {
      if (/^(---|\+\+\+|@@)/.test(line)) continue;
      if (line.startsWith("-")) removed.push(line.slice(1));
      else if (line.startsWith("+")) added.push(line.slice(1));
    }
    const take = (list, n) => list.filter(l => l.trim()).slice(0, n).map(l => clampText(l, 220));
    return { removed_lines: removed.length, added_lines: added.length, removed: take(removed, 30), added: take(added, 30) };
  }

  const TOOLS = {
    async get_overview() {
      await dataReady();
      const totals = statusTotals();
      const changes = changeLogEntries();
      const recent = changes.filter(e => CHANGE_EVENT_TYPES.indexOf(e.event_type) >= 0 && Date.now() - new Date(e.timestamp || 0).getTime() < RECENT_CHANGE_MS);
      let scoutReview = null;
      try { scoutReview = Lib.scoutBuckets(scoutCandidates(), scoutMonitoredKeys()).REVIEW.length; } catch (_) {}
      const calendar = state.calendar && Array.isArray(state.calendar.entries) ? state.calendar.entries : [];
      const today = new Date().toISOString().slice(0, 10);
      const report = state.report || {};
      const counts = report.counts || {};
      return {
        pages_monitored: state.items.length, active_sources: activeSources().length,
        status: { ok: totals.stable, changed_recently: totals.changed, problems: totals.issue, waiting: totals.waiting },
        last_scan: { run_id: report.run_id, at: iso(report.generated_at), trigger: report.trigger,
          counts: { checked: counts.discovered, new: counts.new, changed: counts.changed, source_changed: counts.source_changed, removed: counts.removed, fetch_errors: counts.fetch_error, extraction_errors: counts.extraction_error, baseline_migrations: counts.baseline_migration } },
        next_scheduled_scan: iso(nextScheduledScan()),
        changes_last_7_days: recent.length,
        latest_changes: changes.slice(0, 5).map(changeBrief),
        health: state.health ? state.health.totals : null,
        alerts_waiting_in_outbox: Object.keys((state.outbox && state.outbox.pending_events) || {}).length,
        scout_findings_to_review: scoutReview,
        upcoming_dates_30_days: calendar.filter(e => e.date >= today && e.date <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)).length
      };
    },
    async list_changes(args) {
      await dataReady();
      const days = Math.max(1, Math.min(400, Number(args.days) || 7));
      const since = Date.now() - days * 864e5;
      const query = lc(args.query);
      const kinds = args.type && args.type !== "any" ? TYPE_FILTERS[args.type] || [] : null;
      const limit = Math.max(1, Math.min(60, Number(args.limit) || 25));
      const rows = changeLogEntries()
        .filter(e => new Date(e.timestamp || 0).getTime() >= since)
        .filter(e => !kinds || kinds.indexOf(e.event_type) >= 0)
        .map(changeBrief)
        .filter(row => !args.relevant_only || row.ai === "relevant")
        .filter(row => !query || lc(row.page + " " + row.url + " " + row.regulator + " " + row.summary + " " + row.type).includes(query));
      const byType = {};
      rows.forEach(row => { byType[row.type] = (byType[row.type] || 0) + 1; });
      return { days, total: rows.length, by_type: byType, changes: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
    },
    async get_change(args) {
      await dataReady();
      const id = String(args.event_id || "").trim();
      const entry = changeLogEntries().find(e => e.event_id === id) || allEvents().find(e => e.event_id === id);
      if (!entry) return { error: "No change with that event_id in the loaded record. Use list_changes to find one, or search_archive for older history." };
      const brief = changeBrief(entry);
      const verdict = verdictFor(entry);
      const reviews = state.reviews && state.reviews.reviews ? state.reviews.reviews : {};
      let evidence = entry.evidence || null;
      if (!evidence && entry.evidence_location) {
        try { evidence = await loadEvidence(entry.evidence_location); } catch (error) { evidence = { load_error: String(error.message || error) }; }
      }
      return {
        ...brief,
        ai_analysis: verdict.analysis || null,
        ai_condition: verdict.condition || null,
        review: reviews[id] ? { decision: reviews[id].decision, note: reviews[id].note || reviews[id].comment || "", at: reviews[id].recorded_at || reviews[id].at || "" } : null,
        spec: entry.spec && typeof entry.spec === "object" ? { headline: entry.spec.headline, counts: entry.spec.counts } : undefined,
        evidence_file: entry.evidence_location || null,
        error: evidence && evidence.error ? clampText(evidence.error, 400) : undefined,
        redline: evidence && evidence.diff ? diffDigest(evidence.diff) : undefined,
        load_error: evidence && evidence.load_error
      };
    },
    async find_pages(args) {
      await dataReady();
      const query = lc(args.query), regulator = lc(args.regulator);
      const status = args.status && args.status !== "any" ? args.status : "";
      const limit = Math.max(1, Math.min(80, Number(args.limit) || 25));
      const kindMap = { changed: "change", problem: "error", ok: "ok", pending: "pending" };
      const rows = state.items.map(item => {
        const s = itemStatus(item);
        const last = itemChangeEntries(item).find(e => CHANGE_EVENT_TYPES.indexOf(e.event_type) >= 0);
        return {
          url_id: item.url_id, title: itemTitle(item), url: item.canonical_url, regulator: regulatorName(regulatorOf(item)),
          source: sourceLabel(sourceForItem(item)), kind: itemKind(item), status: s.label, status_kind: s.kind,
          last_checked: iso(item.last_checked), last_change: last ? iso(last.timestamp) : null, link: "#pages/" + item.url_id
        };
      }).filter(row => !status || row.status_kind === kindMap[status])
        .filter(row => !regulator || lc(row.regulator + " " + row.source + " " + row.url).includes(regulator))
        .filter(row => !query || lc(row.title + " " + row.url + " " + row.regulator + " " + row.source).includes(query));
      return { total: rows.length, pages: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
    },
    async get_page(args) {
      await dataReady();
      const key = String(args.url_id || "").trim();
      const url = String(args.url || "").trim();
      const item = state.items.find(i => (key && i.url_id === key) || (url && (i.canonical_url === url || i.canonical_url === Lib.canonicalUrl(url))));
      if (!item) return { error: "No monitored page matches. Use find_pages first." };
      const monitor = typeof healthMonitorFor === "function" ? healthMonitorFor(item.source_id) : null;
      return {
        url_id: item.url_id, title: itemTitle(item), url: item.canonical_url, regulator: regulatorName(regulatorOf(item)), kind: itemKind(item),
        status: itemStatus(item).label, source: sourceLabel(sourceForItem(item)), source_id: item.source_id,
        first_seen: iso(item.first_seen), last_checked: iso(item.last_checked), http_status: item.http_status,
        fetch_error: item.fetch_error ? clampText(item.fetch_error, 300) : null, extraction_error: item.extraction_error ? clampText(item.extraction_error, 300) : null,
        schedule: monitor && monitor.cadence ? monitor.cadence.label : null, next_due: monitor ? iso(monitor.next_due) : null, monitor_status: monitor ? monitor.status : null,
        snapshot: item.snapshot_location || null,
        changes: itemChangeEntries(item).slice(0, 10).map(changeBrief),
        link: "#pages/" + item.url_id
      };
    },
    async list_runs(args) {
      await dataReady();
      const limit = Math.max(1, Math.min(40, Number(args.limit) || 12));
      const query = lc(args.source_query);
      const rows = (Array.isArray(state.history) ? state.history : [])
        .filter(run => !query || lc(run.source_id + " " + run.regulator).includes(query))
        .slice(0, limit)
        .map(run => {
          const c = run.counts || {};
          return { run_id: run.run_id, source_id: run.source_id, regulator: run.regulator, at: iso(run.generated_at), trigger: run.trigger,
            checked: c.discovered, new: c.new, changed: c.changed, source_changed: c.source_changed, removed: c.removed, fetch_errors: c.fetch_error, extraction_errors: c.extraction_error,
            link: "#runs/" + encodeURIComponent(runKey(run)) };
        });
      return { total_runs_recorded: (state.history || []).length, runs: rows };
    },
    async get_run(args) {
      await dataReady();
      const id = String(args.run_id || "").trim().split("|")[0];
      const rows = (state.history || []).filter(run => run.run_id === id);
      if (!rows.length) return { error: "That run ID is not in the loaded history. Try search_archive with the run ID." };
      const sum = {};
      rows.forEach(run => Object.entries(run.counts || {}).forEach(([k, v]) => { if (typeof v === "number") sum[k] = (sum[k] || 0) + v; }));
      return { run_id: id, at: iso(rows[0].generated_at), trigger: rows[0].trigger, sources: rows.map(run => ({ source_id: run.source_id, regulator: run.regulator, counts: run.counts, link: "#runs/" + encodeURIComponent(runKey(run)) })), totals: sum };
    },
    async get_health() {
      await dataReady();
      const h = state.health;
      if (!h) return { error: "Fleet health has not been written yet (it is rebuilt by every scan)." };
      const pick = list => (Array.isArray(list) ? list : []).slice(0, 15).map(m => typeof m === "object" ? { source_id: m.source_id, name: m.name, regulator: m.regulator, status: m.status, last_scan: iso(m.last_scan), failures_7d: m.failures_7d, reason: m.reason || m.error || undefined } : m);
      return { generated_at: iso(h.generated_at), totals: h.totals, last_7_days: h.last_7_days, failing: pick(h.failing), stale: pick(h.stale), protected: pick(h.protected), year_bound: pick(h.year_bound), link: "#health" };
    },
    async list_alerts(args) {
      await dataReady();
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      const changes = new Map(changeLogEntries().map(e => [e.event_id, e]));
      const sent = Object.entries((state.notifications && state.notifications.sent_events) || {})
        .map(([id, value]) => ({ event_id: id, kind: value.kind, sent_at: iso(value.sent_at), channels: value.channels, page: changes.has(id) ? changeBrief(changes.get(id)).page : undefined }))
        .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));
      const pending = Object.entries((state.outbox && state.outbox.pending_events) || {}).map(([id, value]) => ({ event_id: id, kind: value.kind || value.event_type, attempts: value.attempts, last_error: value.last_error ? clampText(value.last_error, 200) : undefined }));
      const byKind = {};
      sent.forEach(a => { byKind[a.kind] = (byKind[a.kind] || 0) + 1; });
      return { sent_total: sent.length, sent_by_kind: byKind, recent: sent.slice(0, limit), waiting_in_outbox: pending.slice(0, 20), link: "#alerts" };
    },
    async list_scout(args) {
      await dataReady();
      let buckets;
      try { buckets = Lib.scoutBuckets(scoutCandidates(), scoutMonitoredKeys()); } catch (_) { return { error: "Scout's findings are not available." }; }
      const bucket = buckets[args.bucket] ? args.bucket : "REVIEW";
      const query = lc(args.query);
      const limit = Math.max(1, Math.min(40, Number(args.limit) || 15));
      const rows = buckets[bucket].filter(c => !query || lc(c.title + " " + c.url + " " + c.regulator_id).includes(query)).map(c => {
        const a = c.assessment || {};
        return { key: c.key, title: clampText(c.title, 160), url: c.url, regulator: c.regulator_id, first_seen: iso(c.first_seen), outcome: a.outcome, confidence: a.confidence, publication_type: a.publication_type && a.publication_type.label, rank: a.rank, link: "#scout/" + encodeURIComponent(c.key) };
      });
      return { counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])), bucket, findings: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
    },
    async list_calendar(args) {
      await dataReady();
      const days = Math.max(1, Math.min(400, Number(args.days) || 90));
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
      const entries = (state.calendar && Array.isArray(state.calendar.entries) ? state.calendar.entries : [])
        .filter(e => e.date >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10) && e.date <= end)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map(e => ({ date: e.date, past: e.date < today, kind: e.label || e.kind, title: e.title, url: e.url, quote: e.quote ? clampText(e.quote, 200) : undefined, change: e.event_id ? "#changes/" + e.event_id : undefined }));
      return { today, days, dates: entries.slice(0, 40), link: "#cadence" };
    },
    async find_registry(args) {
      await dataReady();
      let items = [];
      try { items = registryItems(); } catch (_) {}
      const query = lc(args.query);
      const rows = items.filter(item => !query || lc(JSON.stringify(item)).includes(query)).slice(0, 25).map(item => ({ key: typeof registryItemKey === "function" ? registryItemKey(item) : item.code, code: item.code, name: item.name || item.title, scheme: item.scheme, jurisdiction: item.jurisdiction }));
      return { total: items.length, items: rows, note: items.length ? undefined : "The Registry is empty: no reporting items have been imported yet (config/registry.json)." };
    },

    /* ---------- UI tools: the live dashboard ---------- */
    async open_view(args, step) {
      const view = VIEW_NAMES[String(args.view || "").toLowerCase()];
      if (!view) return { error: "Unknown view. Use one of overview, changes, pages, runs, health, alerts, registry, scout, cadence." };
      await frameUsable();
      const doc = frameDoc();
      const nav = Array.from(doc.querySelectorAll('.rail [data-view="' + view + '"]')).find(isVisible);
      await yieldToPerson();
      if (nav) {
        await aimAt(nav, "Opening " + VIEW_LABELS[view]);
        await pressCursor();
        nav.click();
      } else {
        bridge().route(view, "");
      }
      await settle();
      const id = String(args.item_id || "").trim();
      if (id) {
        const attr = ROW_SELECTORS[view];
        const row = attr ? Array.from(doc.querySelectorAll("[" + attr + "]")).find(el => el.getAttribute(attr) === id && isVisible(el)) || Array.from(doc.querySelectorAll("[" + attr + "]")).find(el => el.getAttribute(attr) === id) : null;
        if (row) {
          await aimAt(row, "Opening the item");
          await pressCursor();
          row.click();
        } else {
          bridge().route(view, id);
        }
        await settle(500);
      }
      updateCrumb();
      step.note("in " + VIEW_LABELS[view]);
      return { ok: true, view: VIEW_LABELS[view], address: frameWin().location.hash || "#overview", next: "Call read_screen to see the controls." };
    },
    async read_screen(args) {
      return await readScreen(args);
    },
    async click(args, step) {
      await frameUsable();
      const el = elementForRef(args.ref);
      if (!el) return { error: "That ref is not on screen any more. Call read_screen again." };
      if (el.disabled) return { error: "That control is disabled." };
      await yieldToPerson();
      await aimAt(el, args.why ? clampText(args.why, 60) : "Clicking " + describeEl(el));
      const consequence = consequenceOf(el);
      if (consequence) {
        cursorLabel("Waiting for your approval", "waiting");
        spotlight(el);
        setAgentState("waiting", "Waiting for your approval");
        step.status("waiting");
        const approved = await approvalCard(consequence, describeEl(el), regionOf(el));
        clearSpot();
        if (!approved) { step.declined(); setAgentState("thinking", "Working…"); return { declined: true, note: "The person declined. Do not retry this action; ask what they want instead." }; }
        setAgentState("acting", "Working in the dashboard…");
        step.status("running");
        await checkpoint();
        await aimAt(el, "Clicking " + describeEl(el));
      }
      await pressCursor();
      el.focus({ preventScroll: true });
      el.click();
      await settle(450);
      updateCrumb();
      return { ok: true, clicked: describeEl(el), next: "The screen may have changed; call read_screen." };
    },
    async type(args, step) {
      await frameUsable();
      const el = elementForRef(args.ref);
      if (!el) return { error: "That ref is not on screen any more. Call read_screen again." };
      if (!el.matches("input, textarea, [contenteditable=true]")) return { error: "That control does not take text." };
      await yieldToPerson();
      await aimAt(el, "Typing");
      await pressCursor();
      el.focus({ preventScroll: true });
      const win = frameWin();
      const proto = el.matches("textarea") ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const text = String(args.text == null ? "" : args.text).slice(0, 2000);
      const startValue = args.append ? el.value : "";
      const fire = () => el.dispatchEvent(new win.Event("input", { bubbles: true }));
      if (!motion.matches && text.length <= 60) {
        for (let i = 1; i <= text.length; i++) {
          setter.call(el, startValue + text.slice(0, i));
          fire();
          await sleep(text.length > 30 ? 14 : 28);
        }
      } else {
        setter.call(el, startValue + text);
        fire();
      }
      if (!text.length) { setter.call(el, startValue); fire(); }
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      if (args.submit) {
        const form = el.form;
        const submitter = form && (form.querySelector("button[type=submit], input[type=submit]") || form.querySelector("button:not([type])"));
        const consequence = submitter ? consequenceOf(submitter) : form ? "submit this form" : "";
        if (consequence) {
          cursorLabel("Waiting for your approval", "waiting");
          setAgentState("waiting", "Waiting for your approval");
          step.status("waiting");
          const approved = await approvalCard(consequence, describeEl(submitter || el), regionOf(el));
          if (!approved) { step.declined(); setAgentState("thinking", "Working…"); return { typed: true, declined: true, note: "Typed, but the person declined submitting it." }; }
          setAgentState("acting", "Working in the dashboard…");
          step.status("running");
        }
        if (form && typeof form.requestSubmit === "function") form.requestSubmit(submitter || undefined);
        else el.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await settle(500);
      }
      return { ok: true, field: describeEl(el), value: el.type === "password" ? "(hidden)" : clampText(el.value, 120) };
    },
    async select_option(args) {
      await frameUsable();
      const el = elementForRef(args.ref);
      if (!el || !el.matches("select")) return { error: "That ref is not a select list on screen. Call read_screen." };
      const wanted = lc(args.option);
      const option = Array.from(el.options).find(o => lc(o.value) === wanted || lc(o.textContent.trim()) === wanted) || Array.from(el.options).find(o => lc(o.textContent).includes(wanted));
      if (!option) return { error: "No such option. Options: " + Array.from(el.options).map(o => o.textContent.trim()).slice(0, 20).join(" / ") };
      await yieldToPerson();
      await aimAt(el, "Choosing “" + clampText(option.textContent, 30) + "”");
      await pressCursor();
      el.value = option.value;
      el.dispatchEvent(new (frameWin().Event)("change", { bubbles: true }));
      el.dispatchEvent(new (frameWin().Event)("input", { bubbles: true }));
      await settle();
      return { ok: true, selected: option.textContent.trim() };
    },
    async scroll(args) {
      await frameUsable();
      const el = args.ref ? elementForRef(args.ref) : null;
      await yieldToPerson();
      if (el) { await aimAt(el, "Scrolling"); return { ok: true }; }
      const doc = frameDoc();
      const win = frameWin();
      const x = agent.cursor.x > 0 ? agent.cursor.x / agent.scale : win.innerWidth * .6;
      const y = agent.cursor.y > 0 ? agent.cursor.y / agent.scale : win.innerHeight * .5;
      let target = doc.elementFromPoint(x, y);
      while (target && target !== doc.body && !(target.scrollHeight > target.clientHeight + 4 && /(auto|scroll)/.test(win.getComputedStyle(target).overflowY))) target = target.parentElement;
      if (!target || target === doc.body) target = doc.querySelector(".view:not([hidden]) .detail") || doc.scrollingElement;
      const amount = (target.clientHeight || win.innerHeight) * .75 * (args.direction === "up" ? -1 : 1);
      cursorLabel(args.direction === "up" ? "Scrolling up" : "Scrolling down");
      showCursor();
      target.scrollBy({ top: amount, behavior: motion.matches ? "auto" : "smooth" });
      await settle(450);
      return { ok: true, next: "Call read_screen to see what is now visible." };
    },
    async point_at(args) {
      await frameUsable();
      const el = elementForRef(args.ref);
      if (!el) return { error: "That ref is not on screen any more. Call read_screen again." };
      await aimAt(el, "Look here");
      spotlight(el, args.note ? clampText(args.note, 160) : "");
      return { ok: true };
    },
    async ask_person(args, step) {
      setAgentState("waiting", "Waiting for your answer");
      step.status("waiting");
      const answer = await questionCard(clampText(args.question, 400) || "How would you like me to continue?", args.options);
      setAgentState("thinking", "Working…");
      return { answer };
    }
  };
  const UI_TOOLS = new Set(["open_view", "read_screen", "click", "type", "select_option", "scroll", "point_at"]);
  const q = (value, max) => escHtml(clampText(value, max));
  const STEP_LABELS = {
    get_overview: () => "Reading the overview",
    list_changes: a => "Reading changes" + (a.days ? " · last " + q(a.days, 6) + " days" : "") + (a.query ? " · “" + q(a.query, 30) + "”" : ""),
    get_change: () => "Opening a change’s evidence",
    find_pages: a => "Finding pages" + (a.query ? " · “" + q(a.query, 30) + "”" : ""),
    get_page: () => "Reading a page record",
    list_runs: () => "Reading recent runs",
    get_run: a => "Reading run " + q(a.run_id, 28),
    get_health: () => "Checking fleet health",
    list_alerts: () => "Reading alerts",
    list_scout: a => "Reading Scout findings" + (a.bucket ? " · " + q(String(a.bucket).toLowerCase(), 12) : ""),
    list_calendar: () => "Reading upcoming dates",
    find_registry: () => "Searching the Registry",
    search_archive: a => "Searching the archive · “" + q(a.query, 36) + "”",
    read_archive_record: a => "Reading " + q(a.path, 48),
    open_view: a => "Opening <b>" + q(VIEW_LABELS[VIEW_NAMES[lc(a.view)]] || a.view, 20) + "</b>" + (a.item_id ? " · one item" : ""),
    read_screen: () => "Looking at the screen",
    click: a => "Clicking" + (elementForRef(a.ref) ? " " + q(describeEl(elementForRef(a.ref)), 70) : ""),
    type: a => "Typing “" + q(a.text, 40) + "”",
    select_option: a => "Choosing “" + q(a.option, 30) + "”",
    scroll: a => "Scrolling" + (a.direction === "up" ? " up" : a.direction === "down" ? " down" : ""),
    point_at: a => "Pointing" + (a.note ? ": " + q(a.note, 50) : ""),
    ask_person: () => "Asking you"
  };
  function stepLabel(name, args) {
    const make = STEP_LABELS[name];
    return make ? make(args || {}) : q(String(name).replace(/_/g, " "), 40);
  }

  async function frameUsable() {
    showStage();
    await ensureFrame();
    layoutFrame();
  }
  async function settle(ms) {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await sleep(ms || 300);
  }

  async function runTool(call) {
    const name = call.function.name;
    let args = {};
    try { args = JSON.parse(call.function.arguments || "{}") || {}; } catch (_) { return { error: "The tool arguments were not valid JSON." }; }
    const impl = TOOLS[name];
    if (!impl) return { error: "Unknown tool " + name };
    const row = stepRow(stepLabel(name, args), "running");
    let status = "running";
    let note = "";
    const step = {
      note: text => { note = text; },
      status: value => { status = value; row.set(value); },
      declined: () => { status = "declined"; }
    };
    if (UI_TOOLS.has(name)) { setAgentState("acting", "Working in the dashboard…"); if (name !== "point_at" && name !== "read_screen") clearSpot(); }
    try {
      await checkpoint();
      const result = await impl(args, step);
      const text = out(result);
      const failed = result && typeof result === "object" && result.error;
      row.done(status === "declined" ? "declined" : failed ? "failed" : "done", note || (status === "declined" ? "declined" : failed ? "not possible" : ""), name === "read_screen" ? text.slice(0, 2400) : pretty(text));
      return text;
    } catch (error) {
      if (error instanceof StopSignal) { row.done("failed", "stopped"); throw error; }
      const text = out({ error: String(error && error.message || error) });
      row.done("failed", "error", text);
      return text;
    } finally {
      if (UI_TOOLS.has(name)) { restCursor(); }
    }
  }
  function pretty(text) { try { return JSON.stringify(JSON.parse(text), null, 1).slice(0, 3000); } catch (_) { return String(text).slice(0, 3000); } }

  /* ================= The loop ================= */
  function persist() {
    try {
      const keep = agent.messages.slice(-60);
      const transcript = keep.filter(m => (m.role === "user" && !/^Person, in the dashboard/.test(m.content)) || (m.role === "assistant" && m.content && !(m.tool_calls && m.tool_calls.length)));
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ messages: keep, transcript: transcript.map(m => ({ role: m.role, content: m.content })) }));
    } catch (_) {}
  }
  function restore() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
      if (!saved || !Array.isArray(saved.messages)) return;
      agent.messages = saved.messages;
      (saved.transcript || []).forEach(m => addMessage(m.role === "user" ? "user" : "agent", m.content));
    } catch (_) {}
  }
  function resetConversation() {
    if (agent.running) { agent.stopRequested = true; }
    agent.messages = [];
    ui.transcript.innerHTML = "";
    ui.welcome.hidden = false;
    endSteps();
    try { sessionStorage.removeItem(STORE_KEY); } catch (_) {}
    ui.input.focus();
  }
  $s("sentinelNew").addEventListener("click", resetConversation);

  function setRunning(running) {
    agent.running = running;
    ui.send.innerHTML = running ? ICONS.stop : ICONS.send;
    ui.send.setAttribute("aria-label", running ? "Stop" : "Send");
    ui.send.classList.toggle("is-primary", !running);
    ui.input.placeholder = running ? "Add guidance — Sentinel reads it at its next step…" : "Ask Sentinel, or describe a task…";
    ui.takeover.hidden = !running;
    ui.footNote.textContent = running ? "Sentinel is working. You can keep using the dashboard." : "Enter to send · Shift+Enter for a new line";
    if (!running) { setAgentState(agent.paused ? "waiting" : "idle", agent.paused ? "Paused" : "Ready"); }
  }

  async function post(body) {
    const identity = await askSentinelIdentity();
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { ...askSentinelIdentityHeaders(identity), "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (payload && (Number.isInteger(payload.remaining) || Number.isInteger(payload.limit))) updateQuota(payload.remaining, payload.limit);
    return { status: response.status, ok: response.ok, payload: payload || {} };
  }

  function contextForStep() {
    const b = bridge();
    const activity = agent.activity.splice(0).slice(-12);
    // Recorded in the conversation (after any tool results), so later steps
    // still know what the person did.
    if (activity.length) agent.messages.push({ role: "user", content: "Person, in the dashboard since your last step:\n- " + activity.join("\n- ") });
    return { view: b ? b.view() : state.view, page: ui.crumb.textContent || "" };
  }

  async function submit() {
    const text = ui.input.value.trim();
    if (agent.running) {
      if (!text) { agent.stopRequested = true; setAgentState("thinking", "Stopping…"); agent.resumeWaiters.splice(0).forEach(r => r()); return; }
      agent.queued.push(text);
      ui.input.value = "";
      addMessage("user", text, "Sentinel will read this at its next step");
      return;
    }
    if (!text) return;
    if (!ENDPOINT) { addMessage("error", "Sentinel's server endpoint is not configured for this copy of the dashboard."); return; }
    if (agent.remaining === 0) { addMessage("error", "You have used today's " + agent.limit + " questions. They reset at 00:00 UTC."); return; }
    ui.input.value = "";
    autosize();
    addMessage("user", text);
    agent.messages.push({ role: "user", content: text });
    persist();
    await runTurn();
  }

  async function runTurn() {
    setRunning(true);
    agent.stopRequested = false;
    setAgentState("thinking", "Thinking…");
    endSteps();
    let turn = null;
    let failures = 0;
    try {
      for (let guard = 0; guard < 40; guard++) {
        await checkpoint();
        while (agent.queued.length) agent.messages.push({ role: "user", content: agent.queued.shift() });
        setAgentState("thinking", "Thinking…");
        const context = contextForStep();
        const response = await post({ mode: "agent", messages: agent.messages, tools: TOOL_SPECS, turn, context });
        const data = response.payload;
        (Array.isArray(data.server_messages) ? data.server_messages : []).forEach(message => {
          agent.messages.push(message);
          if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
            message.tool_calls.forEach(call => {
              let args = {};
              try { args = JSON.parse(call.function.arguments || "{}"); } catch (_) {}
              stepRow(stepLabel(call.function.name, args), "done");
            });
          }
        });
        if (!response.ok) {
          if (data.turn && data.turn.token) turn = { token: data.turn.token };
          if ((data.error_code === "provider_rate_limited" || response.status >= 500) && failures < 1 && turn) {
            failures += 1;
            setAgentState("thinking", "The AI provider is busy — retrying…");
            await sleep(response.status === 503 && data.error_code === "provider_rate_limited" ? 8000 : 2500);
            continue;
          }
          throw new Error(data.error || "Sentinel could not complete this request (HTTP " + response.status + ").");
        }
        failures = 0;
        turn = data.turn && data.turn.token ? { token: data.turn.token } : turn;
        if (data.type === "final") {
          const answer = String(data.answer || "").trim() || "I could not produce an answer. Please try rephrasing.";
          agent.messages.push({ role: "assistant", content: answer });
          endSteps();
          addMessage("agent", answer, data.step_limit ? "Stopped at the step limit" : "");
          persist();
          announce();
          return;
        }
        if (data.type === "continue") { persist(); continue; }
        if (data.type !== "tool_calls" || !data.assistant) throw new Error("Sentinel returned an unexpected response.");
        agent.messages.push(data.assistant);
        if (data.assistant.content && data.assistant.content.trim() && !/^\s*[{<]/.test(data.assistant.content)) {
          endSteps();
          addMessage("agent", data.assistant.content.trim());
        }
        (Array.isArray(data.server_results) ? data.server_results : []).forEach(message => {
          agent.messages.push(message);
          const call = (data.assistant.tool_calls || []).find(c => c.id === message.tool_call_id);
          if (call) { let args = {}; try { args = JSON.parse(call.function.arguments || "{}"); } catch (_) {} stepRow(stepLabel(call.function.name, args), "done"); }
        });
        for (const call of data.calls || []) {
          const result = await runTool(call);
          agent.messages.push({ role: "tool", tool_call_id: call.id, content: result });
          persist();
        }
      }
      throw new Error("Sentinel took too many steps on this question.");
    } catch (error) {
      endSteps();
      if (error instanceof StopSignal) {
        addMessage("note", "Stopped. Ask again to continue from here.");
        agent.messages.push({ role: "assistant", content: "(Stopped by the person before finishing.)" });
      } else {
        setAgentState("error", "Something went wrong");
        addMessage("error", String(error && error.message || error));
        // Close the open tool calls so the next question starts cleanly.
        const last = agent.messages[agent.messages.length - 1];
        if (last && last.role !== "assistant") agent.messages.push({ role: "assistant", content: "(I could not finish that request.)" });
      }
      persist();
    } finally {
      agent.stopRequested = false;
      setRunning(false);
      restCursor();
      if (isCompactScreen() && ws.dataset.mtab === "stage") setTimeout(() => setMobileTab("chat"), 1200);
    }
  }
  // An answer that arrives while the workspace is closed shows on the dock.
  function announce() {
    if (agent.open) return;
    $s("sentinelBadge").hidden = false;
    $s("sentinelTipTitle").textContent = "Sentinel finished";
    $s("sentinelTipSub").textContent = "Your answer is ready — open to read it";
    dock.classList.add("has-note");
    dockLife.play("nod");
  }

  function autosize() {
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(ui.input.scrollHeight, 150) + "px";
  }
  ui.form.addEventListener("submit", event => { event.preventDefault(); void submit(); });
  ui.input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); }
  });
  ui.input.addEventListener("input", autosize);

  async function openRouteInStage(href) {
    showStage();
    await frameUsable();
    const match = String(href || "").match(/^#([a-z-]+)(?:\/(.+))?$/);
    if (!match) return;
    const view = VIEW_NAMES[match[1]] || (match[1] === "pages" ? "monitors" : match[1]);
    if (!VIEW_LABELS[view]) return;
    bridge().route(view, match[2] ? decodeURIComponent(match[2]) : "");
    setTimeout(updateCrumb, 400);
  }

  restore();

  // The rail's "Ask Sentinel" opens the workspace; the old page stays as a fallback.
  const launch = document.getElementById("askSentinelLaunch");
  if (launch) {
    launch.addEventListener("click", event => {
      event.stopImmediatePropagation();
      event.preventDefault();
      openWorkspace();
    }, true);
  }
  if (/^#ask-sentinel\b/.test(location.hash)) {
    const wait = () => (root.classList.contains("cs-open") && state.loaded ? openWorkspace() : setTimeout(wait, 300));
    wait();
  }
})();
