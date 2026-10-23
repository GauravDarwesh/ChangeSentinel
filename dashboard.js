"use strict";

/*
 * ChangeSentinel review workspace.
 *
 * Data layer (unchanged contract): core JSON is read same-origin from Pages
 * with a raw-GitHub fallback, every asset is schema-checked, and incomplete or
 * stale scans are reported as such rather than as healthy. Every workflow that
 * commits state dispatches the Pages deploy, so the published copy is current
 * within a minute of each commit. Snapshot bytes and evidence are read from raw
 * GitHub, because Pages publishes the UI and the core JSON, not every snapshot.
 *
 * Background refreshes poll only the small files; the large ones (inventory,
 * history, Scout review) are re-read when the scan or sweep they describe has
 * moved on, and at least every ten minutes. A refresh that brings nothing new
 * re-renders nothing, so an open comparison or a long redline keeps its place.
 *
 * Review layer: a change also shows its reporting-item (MDRM) impact with the
 * downstream assets mapped in config/lineage.json, the dates it states
 * (data/calendar.json, also served as an .ics feed), and the human review
 * decision recorded in data/reviews/ledger.json. Decisions are recorded through
 * an owner-only issue workflow; the dashboard itself never writes. Saved copies
 * can be re-fingerprinted in the browser, and a change exports as one evidence pack.
 *
 * Interface: a rail, a list pane and a detail pane. Selecting a list row shows
 * it on the right without scrolling the page; on phones the list and detail are
 * separate screens. Pure helpers (redline diff, scan cycle, wording) live in
 * dashboard-lib.js so they can be tested without a browser.
 */
const L = window.CSLib;

// Derive the repository from the Pages address (<owner>.github.io/<repo>/) so a
// fork reads its own data; fall back to the upstream repository elsewhere.
function repositoryFromLocation() {
  try {
    const host = String(location.hostname || "");
    const repo = String(location.pathname || "").split("/").filter(Boolean)[0];
    if (/\.github\.io$/i.test(host) && repo) return { owner: host.split(".")[0], repo };
  } catch (_) {}
  return { owner: "GauravDarwesh", repo: "ChangeSentinel" };
}
const REPOSITORY = repositoryFromLocation();
const RAW = "https://raw.githubusercontent.com/" + REPOSITORY.owner + "/" + REPOSITORY.repo + "/main";
const REPO = "https://github.com/" + REPOSITORY.owner + "/" + REPOSITORY.repo;
const CHANGE_EVENT_TYPES = ["CHANGED_URL", "NEW_URL", "REMOVED_URL", "HTML_SOURCE_CHANGED"];
const ALERT_EVENT_TYPES = ["REMOVED_URL", "FETCH_ERROR", "EXTRACTION_ERROR"];
const RECENT_CHANGE_MS = 7 * 24 * 60 * 60 * 1000;
const DATA_PATHS = {
  report: "data/report.json",
  inventory: "data/latest.json",
  history: "data/history/index.json",
  notifications: "data/notifications.json",
  outbox: "data/notification-outbox.json",
  config: "config/sources.json",
  scoutLatest: "data/scout/latest.json",
  scoutReview: "data/scout/review.json",
  scoutConfig: "config/scout.json",
  calendar: "data/calendar.json",
  lineage: "config/lineage.json",
  reviews: "data/reviews/ledger.json"
};
// Load core state from the same origin as GitHub Pages first. Keep the raw GitHub
// URL as a fallback so older deployments can still recover while Pages publishes.
const ENDPOINTS = {
  report: new URL("./data/report.json", document.baseURI).href,
  inventory: new URL("./data/latest.json", document.baseURI).href,
  history: new URL("./data/history/index.json", document.baseURI).href,
  notifications: new URL("./data/notifications.json", document.baseURI).href,
  outbox: new URL("./data/notification-outbox.json", document.baseURI).href,
  config: new URL("./config/sources.json", document.baseURI).href,
  scoutLatest: new URL("./data/scout/latest.json", document.baseURI).href,
  scoutReview: new URL("./data/scout/review.json", document.baseURI).href,
  scoutConfig: new URL("./config/scout.json", document.baseURI).href,
  calendar: new URL("./data/calendar.json", document.baseURI).href,
  lineage: new URL("./config/lineage.json", document.baseURI).href,
  reviews: new URL("./data/reviews/ledger.json", document.baseURI).href
};
// The calendar feed is served from Pages so calendar apps can subscribe to it.
const CALENDAR_FEED = new URL("./data/calendar.ics", document.baseURI).href;
const VIEWS = ["overview", "changes", "monitors", "runs", "notifications", "scout", "calendar", "askSentinel"];
const HASH_NAMES = { overview: "overview", changes: "changes", monitors: "pages", runs: "runs", notifications: "alerts", scout: "scout", calendar: "cadence", askSentinel: "ask-sentinel" };
const $ = id => document.getElementById(id);
const esc = L.esc;
// Snapshot text, saved HTML and evidence are cached for the session, but only
// the most recently used entries: a long review session used to keep every
// multi-megabyte document it had ever opened in memory.
function boundedCache(limit) {
  const entries = new Map();
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return value;
    },
    delete(key) { entries.delete(key); },
    get size() { return entries.size; }
  };
}
const state = {
  report: {}, inventory: {}, history: [], notifications: {}, outbox: {}, config: {},
  items: [], view: "overview", loaded: false,
  selectedId: "", selectedChangeId: "", selectedRunId: "", selectedNotificationId: "",
  mobileDetail: false,
  filter: "ALL", changeFilter: "ALL", detailTab: "", diffMode: "compare", snapshotMode: "preview",
  docInfo: {}, titleQueue: [], titleWorkers: 0, titleTimer: null,
  snapshotCache: boundedCache(24), htmlCache: boundedCache(12), evidenceCache: boundedCache(80), pdfPreviewUrl: "", toastTimer: null,
  assetSignatures: {}, renderedSignature: "", lastFullLoad: 0, loading: null, detailKeys: {},
  workflowRuns: [], workflowSignature: "", scanColumns: null, pendingScan: null,
  scoutLatest: null, scoutReview: null, scoutConfig: null, scoutFilter: "REVIEW", scoutFormatFilter: "ALL", selectedScoutKey: "", scoutMonitored: null,
  // Add a link: the page being explored, links found by level, and the ticked links.
  add: { step: "start", method: "explore", url: "", history: [], at: -1, page: null, pages: new Map(), loading: 0,
    tab: "selected", selectMode: false, candidates: [], picked: new Map(), anchor: "", origin: "explore", notes: [], info: "",
    crawl: null, query: "", format: "ALL", show: "ALL", limit: 300, opened: {}, weekly: false, scope: "" },
  scoutSourceMode: "add",
  calendar: null, lineage: null, reviews: null, reviewTarget: "", integrity: {},
  cadenceEntries: [], cadenceMember: null, cadenceSession: null, cadenceStatus: "signed-out", cadenceError: "",
  cadenceLoading: null, cadenceMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  cadenceSelectedDate: L.localIsoDate(new Date()), cadenceSignInBusy: false,
  cadenceRecoveryMode: false, cadenceRecoveryBusy: false,
  cadenceSearch: "", cadenceFilter: "ALL", cadencePanel: "month"
};
const compactQuery = window.matchMedia ? window.matchMedia("(max-width: 980px)") : null;
function isCompact() { return !!(compactQuery && compactQuery.matches); }

/* ================= Data loading ================= */

function bust(url) { return url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now(); }
// FNV-1a over the response text: enough to tell whether a file changed between polls.
function textSignature(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return text.length + ":" + (hash >>> 0).toString(16);
}
async function fetchDataAsset(key, required) {
  const path = DATA_PATHS[key];
  const candidates = Array.from(new Set([ENDPOINTS[key], RAW + "/" + path].filter(Boolean)));
  const failures = [];
  for (const url of candidates) {
    let host = url;
    try { host = new URL(url).host; } catch (_) {}
    try {
      const response = await fetch(bust(url), { cache: "no-store" });
      if (!response.ok) {
        failures.push(host + " returned HTTP " + response.status);
        continue;
      }
      const text = await response.text();
      let value;
      try { value = JSON.parse(text); } catch (_) {
        failures.push(host + " returned invalid JSON");
        continue;
      }
      state.assetSignatures[key] = textSignature(text);
      if (!isValidDataAssetShape(key, value)) {
        failures.push(host + " returned JSON with invalid schema");
        continue;
      }
      return value;
    } catch (error) {
      failures.push(host + " request failed: " + String(error.message || error));
    }
  }
  if (!required) return null;
  throw new Error(path + " could not be loaded (" + failures.join("; ") + ")");
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isValidDataAssetShape(key, value) {
  switch (key) {
    case "report":
      return isPlainObject(value) && value.schema_version === 2 &&
        isPlainObject(value.counts) && Array.isArray(value.sources) &&
        Array.isArray(value.discovery) && typeof value.baseline_update_allowed === "boolean";
    case "inventory":
      return isPlainObject(value) && value.schema_version === 2 &&
        isPlainObject(value.sources);
    case "history":
      return Array.isArray(value);
    case "notifications":
      return isPlainObject(value) && isPlainObject(value.sent_events);
    case "outbox":
      return isPlainObject(value) && isPlainObject(value.pending_events);
    case "config":
      return isPlainObject(value) && Array.isArray(value.sources);
    // Scout's files are optional: a missing or malformed file shows Scout as
    // unavailable and never blocks the monitoring views.
    case "scoutLatest":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.regulators) && typeof value.status === "string";
    case "scoutReview":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.candidates) && Array.isArray(value.regulators);
    case "scoutConfig":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.regulators);
    // Dates, lineage and review decisions are optional too: before the first
    // scan that writes a calendar, or the first recorded review, they are absent.
    case "calendar":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.entries);
    case "lineage":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.mappings);
    case "reviews":
      return isPlainObject(value) && value.schema_version === 1 && isPlainObject(value.reviews) && Array.isArray(value.log);
    default:
      return false;
  }
}
function validateDataAssets(assets) {
  const values = {
    report: assets.report,
    inventory: assets.inventory,
    history: assets.historyData,
    notifications: assets.notifications,
    outbox: assets.outbox,
    config: assets.config
  };
  const invalid = Object.entries(values)
    .filter(([key, value]) => !isValidDataAssetShape(key, value))
    .map(([key]) => DATA_PATHS[key]);
  if (invalid.length) {
    throw new Error("Invalid monitoring data schema: " + invalid.join(", "));
  }
}
// Snapshots and evidence are immutable: every file name carries its content
// hash, so a cached copy never goes stale and no cache-busting is needed.
function snapshotURL(path) { return path ? RAW + "/" + path : ""; }
// A file committed moments ago can briefly 404 on the raw CDN; that answer is
// retried once past every cache rather than trusted.
async function fetchImmutable(path) {
  const url = snapshotURL(path);
  const response = await fetch(url);
  return response.ok ? response : fetch(bust(url), { cache: "no-store" });
}
async function readSnapshotFile(path, cache) {
  if (!path) throw new Error("Snapshot path is not available");
  const cached = cache.get(path);
  if (cached != null) return cached;
  const response = await fetchImmutable(path);
  if (!response.ok) throw new Error("Snapshot request returned HTTP " + response.status);
  const content = await response.text();
  cache.set(path, content);
  return content;
}
function loadEvidence(location) {
  if (!location) return Promise.reject(new Error("No evidence file is attached to this event"));
  const cached = state.evidenceCache.get(location);
  if (cached) return cached;
  return state.evidenceCache.set(location, fetchImmutable(location).then(response => {
    if (!response.ok) throw new Error("Evidence request returned HTTP " + response.status);
    return response.json();
  }).catch(error => {
    state.evidenceCache.delete(location);
    throw error;
  }));
}

/* ================= Formatting ================= */

// One clock format across the dashboard ("8:06 am"). Every stamp is cut to the
// minute the same way, so a change and the scan behind it never disagree.
function clock(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])M$/i, (_, m) => " " + m.toLowerCase() + "m");
}
function dateLabel(d, withYear) {
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: withYear ? "numeric" : undefined });
}
// "Today, 8:06 am", "Yesterday, 10:02 am", "Mon 19 Oct, 6:21 pm".
function when(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const heading = L.dayHeading(value);
  const day = heading === "Today" || heading === "Yesterday" ? heading : dateLabel(d, d.getFullYear() !== new Date().getFullYear());
  return day + ", " + clock(d);
}
function fmt(value) {
  if (!value) return "Not recorded";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : dateLabel(d, true) + ", " + clock(d);
}
function timeOnly(value) { return clock(value); }
function shortDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { day: "numeric", month: "short" });
}
function rowTime(value) {
  const heading = L.dayHeading(value);
  return heading === "Today" || heading === "Yesterday" ? timeOnly(value) : shortDate(value);
}
const relativeTime = value => L.relativeTime(value);
function plural(count, one, many) { return count + " " + (count === 1 ? one : many); }
function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch (_) {
    return "";
  }
}
function displayUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/$/, "") + (url.search || "");
  } catch (_) {
    return String(value || "");
  }
}
function icon(name) { return '<svg class="ext" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
// Text colour and LED square for an event: amber for changes, red for problems.
function toneClass(event) {
  const tone = L.eventTone(event.event_type);
  return "tone-" + tone + (event.event_type === "NEW_URL" ? " tone-new" : "");
}
function externalLink(href, label, cls) {
  const url = safeHttpUrl(href);
  if (!url) return "";
  return '<a class="' + (cls || "btn") + '" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + icon("external") + '</a>';
}
function emptyState(title, copy, action) {
  return '<div class="empty"><div class="empty-inner"><div class="empty-title">' + esc(title) +
    '</div><div class="empty-copy">' + esc(copy) + '</div>' + (action || "") + '</div></div>';
}

/* ================= Inventory model ================= */

function allEvents() { return Array.isArray(state.report.events) ? state.report.events : []; }
function reportSources() { return Array.isArray(state.report.sources) ? state.report.sources : []; }
function configuredSources() { return Array.isArray(state.config.sources) ? state.config.sources : []; }
function activeSources() { return configuredSources().filter(source => source && source.active !== false); }
function activeSourceIds() { return activeSources().map(source => source.id).filter(Boolean); }
function sourceForItem(item) {
  return configuredSources().find(source => source.id === item.source_id)
    || reportSources().find(source => source.id === item.source_id)
    || {};
}
function sourceLabel(source) {
  return String(source.name || source.regulator || source.id || "Monitored source").replace(/\s*\((?:Exact URL Allowlist)\)\s*$/i, "");
}
function shortSourceLabel(source) {
  const full = sourceLabel(source);
  const parts = full.split(/\s+[—–]\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : full;
}
function itemKind(item) {
  const type = String(item.extraction_type || "").toLowerCase();
  if (type === "pdf" || /pdf/i.test(String(item.content_type || ""))) return "pdf";
  if (type === "zip" || /zip/i.test(String(item.content_type || ""))) return "zip";
  return "page";
}
function baseTitle(item) {
  const source = sourceForItem(item);
  if (String(item.source_id || "").startsWith("manual-") && source.name) return source.name;
  const url = String(item.canonical_url || "");
  if (url.indexOf("/apps/reportingforms/review") >= 0) return "Information collections under review";
  if (url.indexOf("/apps/reportingforms/recentupdates") >= 0) return "Recent reporting form updates";
  const path = url.split("?")[0].split("#")[0].replace(/\/+$/, "");
  let last = path.split("/").pop();
  if (!last) {
    try { last = new URL(url).hostname; } catch (_) { last = url || "Monitored page"; }
  }
  if (/^DownloadAttachment$/i.test(last)) {
    let guid = "";
    try { guid = new URL(url).searchParams.get("guid") || ""; } catch (_) {}
    const token = String(guid || item.url_id || "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase();
    const kind = itemKind(item);
    const label = kind === "zip" ? "ZIP archive" : kind === "pdf" ? "PDF attachment" : "Attachment";
    return label + (token ? " " + token : "");
  }
  const formPage = last.match(/^FR[_ ]/i) ? last.replace(/_/g, " ") : "";
  if (formPage) return formPage + " reporting form";
  return last.replace(/\.(html?|pdf|json|xml|csv|txt)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
}
function itemTitle(item) { return (state.docInfo[item.url_id] && state.docInfo[item.url_id].title) || baseTitle(item); }
function itemSubtitle(item) { return (state.docInfo[item.url_id] && state.docInfo[item.url_id].subtitle) || ""; }

function normalizeHeadText(text) { return String(text || "").replace(/\r/g, "").replace(/\s+/g, " ").trim(); }
function normalizeFormCode(raw) {
  const code = String(raw || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const match = code.match(/^FR\s+([A-Z])-?\s?(\d.*)$/i);
  return match ? "FR " + match[1].toUpperCase() + "-" + match[2].replace(/\s+/g, "") : code.replace(/^FR\s*/i, "FR ");
}
function extractFormCodes(text) {
  const codes = [];
  String(text || "").replace(/\bFR[ _]([A-Z])-?[_ ]?(\d{1,3})([A-Z]?)(?![A-Za-z0-9])/g, (_, a, b, c) => { codes.push("FR " + a.toUpperCase() + "-" + b + c.toUpperCase()); return _; });
  String(text || "").replace(/\bFR[ _](\d{3,4}[A-Za-z]?)(?![A-Za-z0-9])/g, (_, a) => { codes.push("FR " + a.toUpperCase()); return _; });
  return codes;
}
// Read a document's own heading so attachments get names like "FR Y-9C
// instructions" instead of an opaque download GUID.
function deriveDocumentTitle(text, type) {
  try {
    const kind = String(type || "").toLowerCase();
    const raw = String(text || "");
    if (kind === "zip") {
      const files = raw.split(/\r?\n/).filter(line => line.startsWith("[FILE]")).map(line => line.slice(6).replace(/\s*\([a-z0-9]+\)\s*$/i, "").trim());
      if (!files.length) return null;
      const counts = {};
      files.forEach(name => extractFormCodes(name).forEach(code => { counts[code] = (counts[code] || 0) + 1; }));
      const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      const joined = files.join(" ").toLowerCase();
      const noun = /instruction/.test(joined) ? "instructions" : /form/.test(joined) ? "report forms" : "documents";
      return { title: top ? top + " " + noun : files[0].replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " "), subtitle: plural(files.length, "file in this archive", "files in this archive") };
    }
    const head = normalizeHeadText(raw).slice(0, 2400);
    const stripped = head.replace(/Board of Governors of the Federal Reserve System/gi, " ");
    const isInstructions = /\bInstructions for\b/i.test(head.slice(0, 700));
    let code = "", name = "", m;
    if (isInstructions) {
      m = stripped.match(/Instructions for (?:the )?(?:Preparation of )?(.+?)\s*\(?\s*Reporting Form\s+(FR\s+[A-Z]?-?\d[A-Za-z0-9\/-]*)/i);
      if (m) { name = m[1]; code = m[2]; }
    }
    if (!code) { m = stripped.match(/\b(FR\s+[A-Z]?-?\d[A-Za-z0-9\/-]*)/); if (m) code = m[1]; }
    if (!name) { m = stripped.match(/([A-Z][A-Za-z,&'’ ]{8,90}?)\s*[—–-]\s*FR\s+[A-Z]?-?\d/); if (m) name = m[1]; }
    if (code) {
      name = name.replace(/^#+\s*/, "").replace(/\s+information collection$/i, "").replace(/\s+/g, " ").trim();
      return { title: normalizeFormCode(code) + (isInstructions ? " instructions" : " report form"), subtitle: name };
    }
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(lines.length - 1, 10); i++) {
      if (/^FR\s+[A-Z]?-?\d[A-Za-z0-9\/-]*$/.test(lines[i])) return { title: normalizeFormCode(lines[i]) + (isInstructions ? " instructions" : " report form"), subtitle: (lines[i + 1] || "").replace(/^#+\s*/, "") };
    }
    return null;
  } catch (_) { return null; }
}
function titleCacheKey(item) { return "cs-title:v5:" + (item.normalized_hash || item.url_id); }
function hydrateDocumentTitles() {
  state.items.forEach(item => {
    if (state.docInfo[item.url_id] || !item.snapshot_location || item.pending_registration || !["pdf", "zip"].includes(itemKind(item))) return;
    try { const cached = localStorage.getItem(titleCacheKey(item)); if (cached) { state.docInfo[item.url_id] = JSON.parse(cached); return; } } catch (_) {}
    if (!state.titleQueue.some(entry => entry.url_id === item.url_id)) state.titleQueue.push(item);
  });
  pumpTitleQueue();
}
function pumpTitleQueue() {
  while (state.titleWorkers < 3 && state.titleQueue.length) {
    const item = state.titleQueue.shift();
    state.titleWorkers++;
    readSnapshotTextHead(item.snapshot_location, 9000).then(text => {
      const info = deriveDocumentTitle(text, itemKind(item));
      if (info && info.title) {
        state.docInfo[item.url_id] = info;
        try { localStorage.setItem(titleCacheKey(item), JSON.stringify(info)); } catch (_) {}
      }
    }).catch(() => {}).finally(() => {
      state.titleWorkers--;
      if (!state.titleTimer) state.titleTimer = setTimeout(() => {
        state.titleTimer = null;
        renderLists();
      }, 150);
      pumpTitleQueue();
    });
  }
}
async function readSnapshotTextHead(path, maxBytes) {
  const response = await fetchImmutable(path);
  if (!response.ok) throw new Error("Snapshot title read failed with HTTP " + response.status);
  if (!response.body || !response.body.getReader) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader(), chunks = [];
  let count = 0;
  while (count < maxBytes) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); count += part.value.length; }
  try { await reader.cancel(); } catch (_) {}
  const merged = new Uint8Array(Math.min(count, maxBytes));
  let offset = 0;
  chunks.forEach(chunk => { const take = Math.min(chunk.length, merged.length - offset); if (take > 0) { merged.set(chunk.subarray(0, take), offset); offset += take; } });
  return new TextDecoder("utf-8").decode(merged);
}

function matchingEvents(item) {
  const url = item.canonical_url || "";
  return allEvents().filter(event =>
    event.url === url || event.canonical_url === url || (event.url_id && event.url_id === item.url_id)
  );
}
// The change log spans runs: each inventory record keeps its own timeline
// (change_history), and the latest report adds removals and errors. Parser-only
// BASELINE_MIGRATION events are not changes and are counted separately.
function itemChangeEntries(item) {
  const entries = [];
  const seen = new Set();
  matchingEvents(item).forEach(event => {
    if (event.event_type === "BASELINE_MIGRATION" || seen.has(event.event_id)) return;
    seen.add(event.event_id);
    entries.push(event);
  });
  (Array.isArray(item.change_history) ? item.change_history : []).forEach(entry => {
    if (!entry || seen.has(entry.event_id)) return;
    seen.add(entry.event_id);
    entries.push(Object.assign({ url: item.canonical_url, url_id: item.url_id, fromHistory: true }, entry));
  });
  return entries.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}
function isSuppressedMarkupOnly(entry) {
  if (!entry || entry.event_type !== "HTML_SOURCE_CHANGED") return false;
  const reviews = state.reviews && isPlainObject(state.reviews.reviews) ? state.reviews.reviews : {};
  return Object.values(reviews).some(review => isPlainObject(review)
    && review.decision === "not_material"
    && review.event_type === "HTML_SOURCE_CHANGED"
    && review.url && review.url === entry.url);
}
function changeLogEntries() {
  const entries = [];
  const seen = new Set();
  state.items.forEach(item => itemChangeEntries(item).forEach(entry => {
    if (seen.has(entry.event_id)) return;
    if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0 && ALERT_EVENT_TYPES.indexOf(entry.event_type) < 0) return;
    if (isSuppressedMarkupOnly(entry)) return;
    seen.add(entry.event_id);
    entries.push(entry);
  }));
  allEvents().forEach(event => {
    if (seen.has(event.event_id) || ALERT_EVENT_TYPES.indexOf(event.event_type) < 0) return;
    seen.add(event.event_id);
    entries.push(event);
  });
  return entries.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}
function migrationCount() {
  return allEvents().filter(event => event.event_type === "BASELINE_MIGRATION").length;
}
function aiResultForEvent(event) {
  const results = Array.isArray(state.report.ai_results) ? state.report.ai_results : [];
  if (!event || !event.event_id) return null;
  return results.find(result => result && result.event_id === event.event_id) || null;
}
// One verdict per change, whether it came from this run's full AI result or
// from the condensed copy kept in the page's change history.
function verdictFor(event) {
  const result = aiResultForEvent(event);
  const ai = result && result.ai && typeof result.ai === "object" ? result.ai : null;
  if (ai && ai.status === "ok" && ai.analysis && typeof ai.analysis === "object") {
    return { state: ai.analysis.relevant === true ? "relevant" : "irrelevant", analysis: ai.analysis };
  }
  if (event && typeof event.ai_relevant === "boolean") {
    return { state: event.ai_relevant ? "relevant" : "irrelevant", analysis: { relevant: event.ai_relevant, topic: event.ai_topic, summary: event.ai_summary } };
  }
  if (ai) return { state: "unavailable", status: String(ai.status || "unknown"), reason: ai.reason || "" };
  return { state: "unreviewed" };
}
function verdictTag(verdict, event) {
  if (L.eventTone(event.event_type) === "problem") return "";
  if (verdict.state === "relevant") return '<span class="tag is-relevant">Relevant</span>';
  if (verdict.state === "irrelevant") return '<span class="tag is-irrelevant">Not relevant</span>';
  if (event.event_type === "CHANGED_URL" || event.event_type === "NEW_URL") return '<span class="tag is-unreviewed">Not reviewed</span>';
  return "";
}
function eventHeadline(event) {
  const verdict = verdictFor(event);
  if (verdict.analysis && verdict.analysis.summary) return verdict.analysis.summary;
  if (event.evidence && event.evidence.error) return event.evidence.error;
  if (event.event_type === "HTML_SOURCE_CHANGED") return "The page markup changed; the extracted text is the same.";
  if (event.event_type === "REMOVED_URL") return "This page was no longer found in a complete scan.";
  if (event.event_type === "NEW_URL") return "A new page entered the monitored scope.";
  return "The extracted text changed since the previous saved copy.";
}
function itemStatus(item) {
  if (item.pending_registration) return { label: "Awaiting first scan", tone: "pending", kind: "pending" };
  if (item.fetch_error || item.extraction_error || (item.http_status && Number(item.http_status) >= 400)) {
    return { label: item.fetch_error ? "Couldn't fetch" : item.extraction_error ? "Couldn't read content" : "HTTP " + item.http_status, tone: "problem", kind: "error" };
  }
  const latestChange = (Array.isArray(item.change_history) ? item.change_history : [])
    .find(entry => entry && (entry.event_type === "CHANGED_URL" || entry.event_type === "NEW_URL"));
  if (latestChange && Date.now() - new Date(latestChange.timestamp || 0).getTime() < RECENT_CHANGE_MS) {
    return { label: (latestChange.event_type === "NEW_URL" ? "New " : "Changed ") + shortDate(latestChange.timestamp), tone: "change", kind: "change" };
  }
  const events = matchingEvents(item)
    .filter(event => event.event_type !== "BASELINE_MIGRATION")
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  const newest = events[0];
  if (newest && (newest.event_type === "CHANGED_URL" || newest.event_type === "NEW_URL" || newest.event_type === "HTML_SOURCE_CHANGED")) {
    return { label: L.eventLabel(newest.event_type), tone: "change", kind: "change" };
  }
  if (newest && (newest.event_type === "FETCH_ERROR" || newest.event_type === "EXTRACTION_ERROR")) {
    return { label: L.eventLabel(newest.event_type), tone: "problem", kind: "error" };
  }
  if (item.first_seen && item.last_checked && new Date(item.first_seen).getTime() === new Date(item.last_checked).getTime()) {
    return { label: "Baseline saved", tone: "ok", kind: "ok" };
  }
  return { label: "No change", tone: "ok", kind: "ok" };
}
// Same canonical form as the engine (regmon/discovery.py), shared via dashboard-lib.js.
function canonicalForDashboard(value) { return L.canonicalUrl(value); }
function statusPriority(item) {
  const status = itemStatus(item);
  return status.kind === "error" ? 0 : status.kind === "change" ? 1 : status.kind === "pending" ? 2 : 3;
}
function makeItems() {
  const groups = state.inventory.sources || {};
  const activeIds = new Set(activeSourceIds());
  const items = [];
  Object.keys(groups).forEach(sourceId => {
    if (!activeIds.has(sourceId)) return;
    const group = groups[sourceId] || {};
    Object.values(group).forEach(item => {
      if (item && item.canonical_url && item.active !== false) items.push(item);
    });
  });
  const knownUrls = new Set(items.map(item => canonicalForDashboard(item.canonical_url)));
  activeSources().forEach(source => {
    (source.seed_urls || []).forEach((seedUrl, index) => {
      const url = canonicalForDashboard(seedUrl);
      if (!url || knownUrls.has(url)) return;
      knownUrls.add(url);
      let hostname = "";
      try { hostname = new URL(url).hostname; } catch (_) {}
      items.push({
        schema_version: 2, url_id: "pending-" + String(source.id || "source") + "-" + index,
        source_id: source.id, regulator: source.regulator || hostname, canonical_url: url, active: true,
        pending_registration: true, first_seen: null, last_seen: null, last_checked: null, last_full_fetch: null,
        http_status: null, content_type: null, extraction_type: null, fetch_error: null, extraction_error: null,
        snapshot_location: null, html_snapshot_location: null, file_snapshot_location: null
      });
    });
  });
  return items.sort((a, b) => statusPriority(a) - statusPriority(b) || itemTitle(a).localeCompare(itemTitle(b)));
}
function selectedItem() { return state.items.find(item => item.url_id === state.selectedId) || null; }
function itemForEvent(event) {
  return state.items.find(candidate => candidate.url_id === event.url_id || candidate.canonical_url === event.url) || null;
}
function eventTitle(event) {
  const item = itemForEvent(event);
  return item ? itemTitle(item) : displayUrl(event.url) || L.eventLabel(event.event_type);
}

/* ================= Status ================= */

function setStatus(value, failed, warning) {
  $("connectionStatus").textContent = value;
  const dot = $("statusDot");
  dot.className = "status-dot " + (failed ? "is-error" : warning ? "is-warn" : "is-ok");
  dot.parentElement.title = value;
}
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, 5600);
}

/* ================= Overview ================= */

function statusTotals() {
  const statuses = state.items.map(item => ({ item, status: itemStatus(item) }));
  return {
    statuses,
    stable: statuses.filter(entry => entry.status.kind === "ok").length,
    changed: statuses.filter(entry => entry.status.kind === "change").length,
    issue: statuses.filter(entry => entry.status.kind === "error").length,
    waiting: statuses.filter(entry => entry.status.kind === "pending").length
  };
}
function numberWord(count) {
  return ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][count] || String(count);
}
function regulatorPhrase(sources) {
  const regulators = Array.from(new Set(sources.map(source => source.regulator || "").filter(Boolean)));
  if (regulators.length === 1 && /Federal Reserve/i.test(regulators[0])) return "Federal Reserve";
  return regulators.length === 1 ? regulators[0] : "regulator";
}
// One sentence that answers "is anything happening?" before any number.
function overviewStatement(totals, recentChanges) {
  const sources = activeSources();
  const pages = state.items.length;
  const subject = "Watching <strong>" + esc(pages) + " " + esc(regulatorPhrase(sources)) + " " + (pages === 1 ? "page" : "pages") + "</strong>" +
    " across " + esc(numberWord(sources.length)) + " " + (sources.length === 1 ? "source" : "sources") + ". ";
  const changes = recentChanges.length
    ? "<em>" + esc(numberWord(recentChanges.length).replace(/^\w/, ch => ch.toUpperCase())) + " " + (recentChanges.length === 1 ? "change" : "changes") + "</em> in the last 7 days"
    : "No content changes in the last 7 days";
  const problems = totals.issue
    ? ", and <em>" + esc(numberWord(totals.issue)) + " " + (totals.issue === 1 ? "page needs" : "pages need") + " attention</em>."
    : ", and nothing needs attention.";
  return subject + changes + problems;
}
function renderOverview() {
  const totals = statusTotals();
  const sources = activeSources();
  const recentChanges = changeLogEntries().filter(entry =>
    CHANGE_EVENT_TYPES.indexOf(entry.event_type) >= 0 && Date.now() - new Date(entry.timestamp || 0).getTime() < RECENT_CHANGE_MS
  );
  $("overviewLede").innerHTML = overviewStatement(totals, recentChanges);

  const recent = changeLogEntries().slice(0, 5);
  $("recentChanges").innerHTML = recent.length
    ? '<ul class="link-list">' + recent.map(entry => {
        const tone = L.eventTone(entry.event_type);
        return '<li><button class="link-row" type="button" data-select-change="' + esc(entry.event_id) + '"><span class="link-title">' + esc(eventTitle(entry)) +
          '</span><span class="row-time">' + esc(when(entry.timestamp)) + '</span><span class="row-sub"><span class="tag ' + toneClass(entry) + '">' +
          esc(L.eventLabel(entry.event_type)) + "</span>" + verdictTag(verdictFor(entry), entry) + "</span></button></li>";
      }).join("") + "</ul>"
    : '<p class="block-value"><small>Nothing yet. A change shows up here, with a redline, the scan after a page differs from its saved copy.</small></p>';

  const discovery = Array.isArray(state.report.discovery) ? state.report.discovery : [];
  const sourceRuns = isPlainObject(state.report.source_runs) ? state.report.source_runs : {};
  $("sourceTable").innerHTML = sources.map(source => {
    const own = totals.statuses.filter(entry => entry.item.source_id === source.id);
    const run = sourceRuns[source.id] || {};
    const disco = discovery.find(entry => entry && entry.source_id === source.id) || {};
    const complete = String(disco.state || "").toUpperCase() === "COMPLETE";
    const changed = own.filter(entry => entry.status.kind === "change").length;
    const problems = own.filter(entry => entry.status.kind === "error").length;
    const parts = [plural(own.length, "page", "pages")];
    if (changed) parts.push(changed + " changed");
    if (problems) parts.push(plural(problems, "problem", "problems"));
    parts.push(run.generated_at ? "scanned " + relativeTime(run.generated_at).toLowerCase() : "not scanned yet");
    if (!complete && disco.state) parts.push("coverage " + String(disco.state).toLowerCase());
    return '<div class="source-line-row"><div class="source-line-name">' + esc(shortSourceLabel(source)) + '</div><div class="source-line-meta">' + esc(parts.join(", ")) + "</div></div>";
  }).join("") || '<p class="block-value"><small>No active sources. Add a page to start.</small></p>';

  renderUpcomingDates();
  renderMonitoringSignal();
  renderLatestPreview();
}
// Deadlines and effective dates read from recorded changes, soonest first.
function renderUpcomingDates() {
  const today = L.localIsoDate();
  const dates = L.upcomingDates(state.calendar, today, 5);
  if (!dates.length) {
    $("upcomingDates").innerHTML = '<p class="block-value"><small>' + (state.calendar
      ? "No dates ahead. When a change states a comment deadline, report date or effective date, it shows up here and in the calendar feed."
      : "The calendar is written by the next scan. Comment deadlines, report dates and effective dates found in changes show up here.") + "</small></p>";
    return;
  }
  $("upcomingDates").innerHTML = '<ul class="link-list">' + dates.map(entry =>
    '<li><button class="link-row" type="button" data-select-change="' + esc(entry.event_id) + '" title="' + esc(dateBasis(entry) + (entry.quote ? ": \u201c" + entry.quote + "\u201d" : "")) + '">' +
    '<span class="link-title">' + esc(entry.title || displayUrl(entry.url)) + '</span><span class="row-time">' + esc(calendarDay(entry.date, entry.date.slice(0, 4) !== today.slice(0, 4))) + "</span>" +
    '<span class="row-sub"><span class="tag is-warn">' + esc(entry.label || "Date") + '</span><span class="row-host">' + esc(L.dueLabel(entry.date, today)) + "</span></span></button></li>"
  ).join("") + "</ul>";
}
async function copyCalendarFeed() {
  try {
    await navigator.clipboard.writeText(CALENDAR_FEED);
    showToast("Calendar feed address copied. Add it in your calendar app as a subscription by URL; it updates after every scan.");
  } catch (_) {
    window.prompt("Copy the calendar feed address:", CALENDAR_FEED);
  }
}

// The newest content change, previewed as a redline under the field, so the
// overview itself answers "what changed?".
function renderLatestPreview() {
  const entry = changeLogEntries().find(candidate => CHANGE_EVENT_TYPES.indexOf(candidate.event_type) >= 0 && candidate.evidence_location);
  const section = $("latestPreview");
  if (!entry) { section.hidden = true; return; }
  section.hidden = false;
  $("previewOpen").innerHTML = '<button class="sheet-link" type="button" data-select-change="' + esc(entry.event_id) + '">Open the full change</button>';
  $("previewHead").innerHTML = '<span class="preview-title">' + esc(eventTitle(entry)) + "</span>" +
    '<span class="row-sub"><span class="tag ' + toneClass(entry) + '">' + esc(L.eventLabel(entry.event_type)) + "</span>" + verdictTag(verdictFor(entry), entry) +
    '<span class="row-time">' + esc(fmt(entry.timestamp)) + "</span></span>";
  if ($("previewBody").dataset.eventId === entry.event_id) return;
  $("previewBody").dataset.eventId = entry.event_id;
  loadEvidence(entry.evidence_location).then(evidence => {
    if ($("previewBody").dataset.eventId !== entry.event_id) return;
    const redline = L.renderRedline(evidence.diff || "");
    $("previewBody").innerHTML = '<div class="redline">' + redline.html + "</div>";
  }).catch(error => {
    $("previewBody").innerHTML = '<p class="rl-empty">Couldn\'t load the evidence: ' + esc(String(error.message || error)) + "</p>";
  });
}

// The LED change field: one row per page, one column per saved scan, newest on
// the right, then one empty column for the next scan. Scheduled and manual
// scans each add a column, so the field grows a block at a time.
function fieldGeometry() {
  const field = $("signalVisual");
  const width = (field && (field.clientWidth || field.parentElement.clientWidth)) || 800;
  const labelWidth = Math.round(Math.min(220, Math.max(104, width * (isCompact() ? .36 : .3))));
  const gap = 3;
  const room = Math.max(120, width - labelWidth);
  const scans = new Set((state.history || []).map(run => run && run.run_id)).size + 1;
  const tile = Math.max(11, Math.min(26, Math.floor((room + gap) / Math.max(22, scans)) - gap));
  const capacity = Math.max(6, Math.floor((room + gap) / (tile + gap)));
  return { capacity, labelWidth, tile, gap, key: capacity + "x" + tile };
}
function renderMonitoringSignal() {
  const field = $("signalVisual");
  const items = state.items || [];
  if (!items.length) {
    field.innerHTML = emptyState("No pages yet", "Each monitored page gets a row of lights here, one per scan.");
    ledField.measure();
    return;
  }
  const geometry = fieldGeometry();
  const columns = L.runColumns(state.history, { workflowRuns: state.workflowRuns, limit: geometry.capacity - 1 });
  const pending = L.pendingScan(new Date(), columns, state.workflowRuns);
  state.scanColumns = columns;
  state.pendingScan = pending;
  field.style.setProperty("--cols", columns.length + 1);
  field.style.setProperty("--tile", geometry.tile + "px");
  field.style.setProperty("--gap", geometry.gap + "px");
  field.style.setProperty("--label-w", geometry.labelWidth + "px");
  field.dataset.geometry = geometry.key;
  const reportEvents = allEvents();
  const merged = {};
  items.forEach(item => { (merged[item.source_id] = merged[item.source_id] || []).push(item); });
  const sourceIds = Object.keys(merged).sort((a, b) => String(a).localeCompare(String(b)));
  const pendingTip = pendingWords(pending);
  let html = "";
  let y = 0;
  sourceIds.forEach(sourceId => {
    const source = configuredSources().find(candidate => candidate.id === sourceId) || { id: sourceId };
    if (sourceIds.length > 1) html += '<div class="field-group" role="row"><span role="rowheader">' + esc(shortSourceLabel(source)) + "</span></div>";
    merged[sourceId].slice().sort((a, b) => itemTitle(a).localeCompare(itemTitle(b))).forEach(item => {
      const page = {
        sourceId: item.source_id,
        firstSeen: item.first_seen,
        events: itemChangeEntries(item).concat(reportEvents.filter(event => (event.url_id === item.url_id || event.url === item.canonical_url) &&
          (event.event_type === "FETCH_ERROR" || event.event_type === "EXTRACTION_ERROR"))),
        problemAt: item.fetch_error || item.extraction_error ? item.last_checked : null
      };
      const title = itemTitle(item);
      html += '<button class="field-label" type="button" data-monitor-id="' + esc(item.url_id) + '" data-row="' + y + '" title="' + esc(title) + '">' + esc(title) + "</button>";
      columns.forEach((column, x) => {
        const s = L.columnCellState(column, page);
        html += '<span class="led s-' + s + '" role="gridcell" data-x="' + x + '" data-y="' + y + '" data-col="' + esc(column.id) + '" data-source="' + esc(item.source_id) + '"' +
          (s === "none" ? "" : ' data-monitor-id="' + esc(item.url_id) + '"') +
          ' data-tip="' + esc(title) + '" data-state="' + s + '" aria-label="' + esc(title + ", " + columnLabel(column, item.source_id) + ": " + stateWords(s)) + '"></span>';
      });
      html += '<span class="led s-pending" role="gridcell" data-x="' + columns.length + '" data-y="' + y + '" data-col="pending" data-tip="' + esc(title) +
        '" data-state="pending" aria-label="' + esc(title + ", " + pendingTip.title) + '"></span>';
      y++;
    });
  });
  // Manual and continuation runs are marked under their column.
  html += '<div class="field-marks" aria-hidden="true">' + columns.map(column =>
    '<i class="' + (column.trigger === "manual" ? "m-manual" : column.trigger === "continuation" ? "m-continuation" : "") + '"></i>').join("") + "<i></i></div>";
  // Day labels under the first scan of each local day.
  let lastDay = "";
  html += '<div class="field-axis" aria-hidden="true">' + columns.map(column => {
    const day = new Date(column.at).toLocaleDateString([], { weekday: "short" });
    const label = day !== lastDay ? day : "";
    lastDay = day;
    return "<span>" + esc(label) + "</span>";
  }).join("") + "<span></span></div>";
  field.innerHTML = html;
  const lit = field.querySelectorAll(".led.s-on, .led.s-new").length;
  const bad = field.querySelectorAll(".led.s-bad").length;
  const manual = columns.filter(column => column.trigger === "manual").length;
  $("fieldNote").textContent = "Each column is one saved scan, newest on the right: the scheduled scan every six hours (" + scheduleTimes() +
    " your time) plus any manual run" + (manual ? " (" + plural(manual, "manual run", "manual runs") + " here, marked underneath)" : "") +
    ". The outlined column is the next scan. " +
    (lit || bad
      ? plural(lit, "light", "lights") + (lit === 1 ? " shows" : " show") + " a change" + (bad ? " and " + plural(bad, "light", "lights") + " a problem" : "") + " in this window."
      : "No scan in this window found a change.");
  const manualLegend = document.querySelector(".field-legend .manual");
  if (manualLegend) manualLegend.parentElement.hidden = !columns.some(column => column.trigger === "manual");
  ledField.measure();
  updateNextRunCountdown();
}
function timeOnlyShort(date) { return clock(date); }
// The four scheduled slot times (00, 06, 12, 18 UTC) in the viewer's time zone.
function scheduleTimes() {
  const base = Date.UTC(2026, 0, 1);
  return [0, 6, 12, 18].map(hour => new Date(base + hour * 3600000))
    .sort((a, b) => (a.getHours() * 60 + a.getMinutes()) - (b.getHours() * 60 + b.getMinutes()))
    .map(timeOnlyShort).join(", ");
}
function triggerWords(trigger) {
  return { scheduled: "Scheduled scan", manual: "Manual scan", continuation: "Crawl continuation" }[trigger] || "Scan";
}
function columnLabel(column, sourceId) {
  const at = new Date((sourceId && column.sources[sourceId]) || column.at);
  const ran = when(at);
  if (column.trigger === "scheduled" && column.at - column.slot > 20 * 60000) {
    return "Scheduled " + timeOnlyShort(new Date(column.slot)) + " scan, ran " + ran;
  }
  return triggerWords(column.trigger) + ", " + ran;
}
function stateWords(s) {
  return { on: "content changed", new: "new page", bad: "couldn't fetch or read", dim: "checked, no change", none: "not scanned", pending: "next scan" }[s] || s;
}
// How the next-scan column and the countdown describe the scan that is coming.
function pendingWords(pending) {
  const due = timeOnlyShort(pending.due);
  const day = pending.due.toLocaleDateString([], { weekday: "short" });
  const since = pending.startedAt ? L.formatDuration((Date.now() - pending.startedAt.getTime()) / 60000) : "";
  const who = pending.trigger === "manual" ? "Manual scan" : pending.trigger === "continuation" ? "Crawl continuation" : "Scan";
  switch (pending.phase) {
    case "running": return { title: who + " running now", time: "Scanning now", note: "started " + since + " ago", countdown: "in progress" };
    case "queued": return { title: who + " queued on GitHub", time: "Queued on GitHub", note: "waiting " + since, countdown: "starting" };
    case "publishing": return { title: "Scan finished, saving results", time: "Saving results", note: "publishing to the dashboard", countdown: "almost done" };
    case "late": return { title: "Scheduled " + due + " scan, not started by GitHub yet", time: due, note: day + " · GitHub hasn't started it yet", countdown: L.formatDuration(pending.lateMinutes) + " late" };
    case "due": return { title: "Scheduled " + due + " scan, due now", time: due, note: day + " · due now", countdown: "due now" };
    default: return { title: "Next scheduled scan, " + day + " " + due, time: due, note: day, countdown: "in " + L.formatDuration(pending.remainingMinutes) };
  }
}
function nextScheduledScan(reference = new Date()) { return L.nextScheduledScan(reference); }
// Updates the countdown and the six-hour cycle bar; called every 30 seconds.
function updateNextRunCountdown() {
  const pending = L.pendingScan(new Date(), state.scanColumns || L.runColumns(state.history, { workflowRuns: state.workflowRuns }), state.workflowRuns);
  if (state.pendingScan && state.pendingScan.phase !== pending.phase && state.loaded && state.view === "overview") {
    state.pendingScan = pending;
    renderMonitoringSignal();
    return;
  }
  state.pendingScan = pending;
  const words = pendingWords(pending);
  const timeNode = $("nextRunTime");
  if (timeNode) timeNode.innerHTML = esc(words.time) + " <small>" + esc(words.note) + "</small>";
  const countdown = $("nextRunCountdown");
  if (countdown) countdown.textContent = words.countdown;
  const bar = $("cycleBar");
  if (bar) {
    const waiting = pending.phase === "waiting";
    const period = L.SCAN_INTERVAL_HOURS * 3600000;
    const lit = waiting ? Math.floor(Math.min(1, Math.max(0, 1 - pending.remainingMinutes / (L.SCAN_INTERVAL_HOURS * 60))) * 24) : 24;
    // The bar spans the six hours leading to the scan it counts down to; a manual
    // run saved inside that window is marked under its cell, as in the field.
    const windowStart = (waiting ? pending.due.getTime() : pending.slot + period) - period;
    const manualCells = new Map();
    (state.scanColumns || []).forEach(column => {
      if (column.trigger !== "manual" || column.at < windowStart || column.at >= windowStart + period) return;
      manualCells.set(Math.min(23, Math.floor((column.at - windowStart) / period * 24)), column);
    });
    bar.dataset.phase = pending.phase;
    bar.innerHTML = Array.from({ length: 24 }, (_, i) => {
      const manual = manualCells.get(i);
      return '<i class="' + (i < lit ? "on" : i === lit ? "now" : "") + (manual ? " m-manual" : "") + '" style="--i:' + i + '"' +
        (manual ? ' title="Manual scan, ' + esc(when(manual.at)) + '"' : "") + "></i>";
    }).join("");
  }
  const last = state.report.generated_at;
  if ($("lastScanTime")) {
    const latest = (state.scanColumns || []).slice(-1)[0];
    $("lastScanTime").textContent = last ? relativeTime(last) : "None saved yet";
    const stale = last && Date.now() - new Date(last).getTime() > 8 * 3600 * 1000;
    $("lastScanNote").textContent = last
      ? (stale ? "later than the six-hour schedule" : timeOnly(last) + (latest && latest.trigger === "manual" ? " · manual" : ""))
      : "";
  }
}
function showFieldTip(target, x, y) {
  const tip = $("fieldTip");
  ledField.hover(target);
  if (!target) { tip.hidden = true; return; }
  let label = "";
  if (target.dataset.state === "pending") {
    label = pendingWords(state.pendingScan || L.pendingScan(new Date(), [], [])).title;
  } else {
    const column = (state.scanColumns || []).find(candidate => candidate.id === target.dataset.col);
    label = column ? columnLabel(column, target.dataset.source) : "";
  }
  tip.innerHTML = esc(target.dataset.tip) + "<small>" + esc(label) + "</small>" +
    (target.dataset.state === "pending" ? "" : "<small>" + esc(stateWords(target.dataset.state).replace(/^\w/, ch => ch.toUpperCase())) + "</small>");
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - box.width - 12, x + 14) + "px";
  tip.style.top = Math.max(12, y - box.height - 12) + "px";
}

/* ---------- LED field painter ----------
 * The cells in #signalVisual are transparent hit areas; this paints the lights
 * on a canvas behind them. Scanned cells carry a slow drifting wave of warm
 * light; changes, new pages and problems glow in their own colour on top of it.
 * A new scan column drops in as a block. The next-scan column is an empty,
 * colourless box with a small 3x3 LED scan head running down it, faster while a
 * scan is actually running. Paused whenever the field is off screen.
 */
const ledField = (() => {
  const canvas = $("fieldCanvas");
  const stage = $("fieldStage");
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SNAKE = [0, 1, 2, 5, 4, 3, 6, 7, 8];
  let cells = [], rows = 0, colors = null, dpr = 1, born = {}, seen = null, hoverEl = null;
  let frame = 0, lastPaint = 0, sleepTimer = 0, revealed = false;

  function parseColor(value) {
    const v = String(value || "").trim();
    let m = v.match(/^#([0-9a-f]{6})$/i);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
    m = v.match(/rgba?\(([^)]+)\)/i);
    if (m) { const p = m[1].split(",").map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    return [128, 128, 128, 1];
  }
  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const get = name => parseColor(css.getPropertyValue(name));
    colors = {
      on: get("--state-change"), new: get("--state-new"), bad: get("--state-bad"),
      lo: get("--idle-lo"), hi: get("--idle-hi"), ink: get("--ink"),
      light: document.documentElement.getAttribute("data-theme") === "light"
    };
  }
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgba = (c, a) => "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

  function measure() {
    if (!ctx || !stage) return;
    const box = stage.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    const now = performance.now();
    const ids = new Set();
    cells = [];
    rows = 0;
    stage.querySelectorAll(".led").forEach(el => {
      if (el.classList.contains("s-none")) return;
      const r = el.getBoundingClientRect();
      const cell = { el, x: r.left - box.left, y: r.top - box.top, s: r.width, state: el.dataset.state, col: Number(el.dataset.x), row: Number(el.dataset.y), id: el.dataset.col };
      cells.push(cell);
      rows = Math.max(rows, cell.row + 1);
      if (cell.id !== "pending") ids.add(cell.id);
    });
    // First paint builds the field left to right; afterwards only a scan that
    // wasn't on screen before drops in.
    let order = 0;
    Array.from(ids).forEach(id => {
      if (born[id] !== undefined) return;
      born[id] = reduced ? 0 : seen === null ? now + 120 + (order++) * 45 : now;
    });
    seen = ids;
    readColors();
    wake();
  }

  function paintLight(cell, t, now) {
    const delay = (born[cell.id] || 0) + cell.row * 22;
    const p = reduced ? 1 : clamp01((now - delay) / 560);
    if (p <= 0) return;
    const ease = 1 - Math.pow(1 - p, 3);
    const n = L.fbm(cell.col * .26 + t * .22, cell.row * .26 + t * .08, t * .11);
    const w = clamp01((n - .3) / .42);
    const hovered = cell.el === hoverEl;
    const grow = hovered ? 2 : 0;
    const x = cell.x - grow, y = cell.y - grow - (1 - ease) * 12, s = cell.s + grow * 2;
    let color, alpha = ease, glow = 0;
    if (cell.state === "dim") {
      color = mix(colors.lo, colors.hi, Math.pow(w, 1.5) * .92 + (hovered ? .25 : 0));
    } else {
      const base = colors[cell.state] || colors.on;
      const k = .74 + .26 * w;
      color = mix(base, [255, 255, 255], Math.max(0, w - .7) * .55);
      alpha *= colors.light ? .7 + .3 * k : k;
      glow = (hovered ? 16 : 9 + 6 * w) * dpr;
      ctx.shadowColor = rgba(base, colors.light ? .45 : .7);
    }
    if (p < 1) color = mix(color, [255, 255, 255], (1 - ease) * .5);
    ctx.shadowBlur = glow;
    ctx.fillStyle = rgba(color, alpha);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, s, s, 2); else ctx.rect(x, y, s, s);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function paintPending(cell, t) {
    const phase = (state.pendingScan && state.pendingScan.phase) || "waiting";
    const busy = phase === "running" || phase === "queued" || phase === "publishing";
    const speed = phase === "running" ? 30 : phase === "publishing" ? 22 : phase === "queued" ? 14 : phase === "late" ? 9 : 6;
    const tail = busy ? 6 : 3.6;
    const span = rows * 9 + (busy ? 10 : 30);
    const head = reduced ? -99 : (t * speed) % span;
    const ink = colors.ink;
    const pad = Math.max(2.5, cell.s * .2);
    const gap = Math.max(1, cell.s * .07);
    const dot = Math.max(1.5, (cell.s - pad * 2 - gap * 2) / 3);
    let boost = 0;
    for (let k = 0; k < 9; k++) {
      const order = SNAKE.indexOf(k);
      const d = head - (cell.row * 9 + order);
      const trail = d >= 0 && d < 40 ? Math.exp(-d / tail) : 0;
      boost = Math.max(boost, trail);
      const level = (busy ? .1 : .055) + (busy ? .85 : .6) * trail;
      ctx.fillStyle = rgba(ink, level);
      ctx.fillRect(cell.x + pad + (k % 3) * (dot + gap), cell.y + pad + Math.floor(k / 3) * (dot + gap), dot, dot);
    }
    ctx.strokeStyle = rgba(ink, (busy ? .3 : .2) + .3 * boost + (cell.el === hoverEl ? .2 : 0));
    ctx.lineWidth = 1;
    ctx.strokeRect(cell.x + .5, cell.y + .5, cell.s - 1, cell.s - 1);
  }

  function visible() {
    return !document.hidden && canvas && canvas.offsetParent !== null && cells.length > 0;
  }
  function paint(now) {
    frame = 0;
    if (!visible()) { sleep(); return; }
    if (now - lastPaint >= 32 || reduced) {
      lastPaint = now;
      if (!colors) readColors();
      const t = now / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cells.forEach(cell => cell.state === "pending" ? paintPending(cell, t) : paintLight(cell, t, now));
      revealed = true;
    }
    if (reduced) return;
    frame = requestAnimationFrame(paint);
  }
  function sleep() {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(wake, 600);
  }
  function wake() {
    if (!ctx || frame) return;
    clearTimeout(sleepTimer);
    frame = requestAnimationFrame(paint);
  }
  document.addEventListener("visibilitychange", wake);
  if (typeof MutationObserver === "function") {
    new MutationObserver(() => { colors = null; if (reduced) wake(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  return {
    measure,
    hover(el) { hoverEl = el || null; if (reduced) wake(); },
    get revealed() { return revealed; }
  };
})();

/* ---------- Live scan status from GitHub Actions ----------
 * The committed data only changes after a scan finishes. The public Actions API
 * says whether a scan is queued or running right now, and which saved scans
 * were scheduled or manual. Unauthenticated calls are limited to 60 an hour per
 * visitor, so this polls once a minute while a scan is active and every five
 * minutes otherwise, and backs off if GitHub refuses.
 */
const WORKFLOW_RUNS_API = "https://api.github.com/repos/" + REPOSITORY.owner + "/" + REPOSITORY.repo +
  "/actions/workflows/regulatory-monitor.yml/runs?per_page=40";
let workflowPollTimer = 0;
let workflowBackoffUntil = 0;
let workflowRefreshInFlight = null;
// One poll chain only: a call made while a request is in flight (the "Scan now"
// follow-ups, a visibility change) joins it instead of starting a second chain.
function refreshWorkflowRuns() {
  if (!workflowRefreshInFlight) {
    workflowRefreshInFlight = pollWorkflowRuns().finally(() => { workflowRefreshInFlight = null; });
  }
  return workflowRefreshInFlight;
}
async function pollWorkflowRuns() {
  clearTimeout(workflowPollTimer);
  if (document.hidden) { workflowPollTimer = setTimeout(refreshWorkflowRuns, 60000); return; }
  if (Date.now() >= workflowBackoffUntil) {
    try {
      const response = await fetch(WORKFLOW_RUNS_API, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
      if (response.status === 403 || response.status === 429) workflowBackoffUntil = Date.now() + 15 * 60000;
      else if (response.ok) {
        const body = await response.json();
        const runs = (Array.isArray(body.workflow_runs) ? body.workflow_runs : []).map(run => ({
          id: run.id, event: run.event, status: run.status, conclusion: run.conclusion,
          created_at: run.created_at, run_started_at: run.run_started_at, updated_at: run.updated_at,
          actor: run.actor && run.actor.login, triggering_actor: run.triggering_actor && run.triggering_actor.login,
          html_url: run.html_url
        }));
        const signature = JSON.stringify(runs.map(run => [run.id, run.status, run.conclusion]));
        const changed = signature !== state.workflowSignature;
        state.workflowRuns = runs;
        state.workflowSignature = signature;
        if (changed && state.loaded && state.view === "overview") renderMonitoringSignal();
      }
    } catch (_) {
      // Offline or blocked: the field still works from the committed data.
    }
  }
  const active = (state.pendingScan && ["running", "queued", "publishing"].indexOf(state.pendingScan.phase) >= 0);
  workflowPollTimer = setTimeout(refreshWorkflowRuns, active ? 60000 : 300000);
}

/* ================= Lists ================= */

function changeRow(entry, options) {
  const verdict = verdictFor(entry);
  const tone = L.eventTone(entry.event_type);
  const selected = !options.compact && entry.event_id === state.selectedChangeId;
  return '<button class="row" type="button" data-select-change="' + esc(entry.event_id) + '"' + (selected ? ' aria-selected="true"' : "") + ">" +
    '<span class="row-mark ' + toneClass(entry) + '" aria-hidden="true"></span>' +
    '<span class="row-title">' + esc(eventTitle(entry)) + "</span>" +
    '<span class="row-time">' + esc(rowTime(entry.timestamp)) + "</span>" +
    '<span class="row-sub"><span class="tag ' + toneClass(entry) + '">' + esc(L.eventLabel(entry.event_type)) + "</span>" + verdictTag(verdict, entry) + reviewTag(reviewFor(entry.event_id)) + "</span>" +
    '<span class="row-summary">' + esc(eventHeadline(entry)) + "</span></button>";
}
function filteredChanges() {
  return changeLogEntries().filter(entry => {
    if (state.changeFilter === "RELEVANT") return verdictFor(entry).state === "relevant";
    if (state.changeFilter === "PROBLEMS") return L.eventTone(entry.event_type) === "problem";
    if (state.changeFilter === "UNDECIDED") return CHANGE_EVENT_TYPES.indexOf(entry.event_type) >= 0 && !reviewFor(entry.event_id);
    return true;
  });
}
function renderChangeRoute() {
  const all = changeLogEntries();
  const events = filteredChanges();
  const migrations = migrationCount();
  $("changeCount").textContent = plural(all.length, "event", "events");
  if (!events.length) {
    $("changeItems").innerHTML = emptyState(
      all.length ? "Nothing matches this filter" : "No changes recorded yet",
      all.length ? "Choose All to see every recorded change."
        : "Changes appear here once a monitored page differs from its saved copy." +
          (migrations ? " This run also re-read " + plural(migrations, "page", "pages") + " with an updated parser; that is not a source change, so it isn't listed (parser re-baseline)." : "")
    );
    return;
  }
  const groups = [];
  events.forEach(entry => {
    const heading = L.dayHeading(entry.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.entries.push(entry);
    else groups.push({ heading, entries: [entry] });
  });
  $("changeItems").innerHTML = groups.map(group =>
    '<div class="list-group-label">' + esc(group.heading) + "</div>" + group.entries.map(entry => changeRow(entry, {})).join("")
  ).join("") + (migrations
    ? '<p class="note-strip">The latest run also re-read ' + plural(migrations, "page", "pages") + " with an updated parser. A parser re-baseline is not a source change, so it isn't listed here.</p>"
    : "");
}
function pageRow(item) {
  const status = itemStatus(item);
  const selected = item.url_id === state.selectedId;
  const subtitle = itemSubtitle(item);
  return '<button class="row monitor-row" type="button" data-monitor-id="' + esc(item.url_id) + '" data-status-kind="' + esc(status.kind) + '"' + (selected ? ' aria-selected="true"' : "") + ">" +
    '<span class="row-mark tone-' + esc(status.tone) + '" aria-hidden="true"></span>' +
    '<span class="row-title">' + esc(itemTitle(item)) + "</span>" +
    '<span class="row-time">' + esc(item.last_checked ? relativeTime(item.last_checked) : "") + "</span>" +
    '<span class="row-sub">' + (status.kind === "ok" ? "" : '<span class="tag tone-' + esc(status.tone) + '">' + esc(status.label) + "</span>") +
    '<span class="row-host">' + esc(subtitle || displayUrl(item.canonical_url)) + "</span></span></button>";
}
function renderMonitorList() {
  const query = $("monitorSearch").value.trim().toLowerCase();
  const all = state.items.filter(item => {
    const status = itemStatus(item);
    if (state.filter === "CHANGES" && status.kind !== "change") return false;
    if (state.filter === "ERRORS" && status.kind !== "error") return false;
    const source = sourceForItem(item);
    const haystack = [itemTitle(item), itemSubtitle(item), item.canonical_url, item.source_id, source.name, source.regulator].join(" ").toLowerCase();
    return !query || haystack.includes(query);
  });
  $("monitorCount").textContent = all.length === state.items.length ? plural(all.length, "page", "pages") : all.length + " of " + state.items.length;
  if (!all.length) {
    $("monitorList").innerHTML = emptyState(
      state.items.length ? "No pages match" : "No pages monitored yet",
      state.items.length ? "Try a different search or filter." : "Add a page to start monitoring it.",
      state.items.length ? "" : '<button class="btn btn-primary" type="button" data-add-monitor>Add page</button>'
    );
    return;
  }
  const groups = {};
  all.forEach(item => {
    const key = item.source_id || "other";
    (groups[key] = groups[key] || []).push(item);
  });
  const keys = Object.keys(groups);
  $("monitorList").innerHTML = keys.map(key => {
    const source = configuredSources().find(candidate => candidate.id === key) || { id: key };
    return (keys.length > 1 ? '<div class="list-group-label">' + esc(shortSourceLabel(source)) + "</div>" : "") + groups[key].map(pageRow).join("");
  }).join("");
}
function runKey(run) { return String(run.run_id || "") + "|" + String(run.source_id || ""); }
function runTriggerPrefix(run) {
  const column = (state.scanColumns || L.runColumns(state.history, { workflowRuns: state.workflowRuns })).find(candidate => candidate.id === String(run.run_id));
  const trigger = column ? column.trigger : L.normalizeTrigger(run.trigger);
  return trigger === "manual" ? "Manual · " : trigger === "continuation" ? "Continuation · " : trigger === "scheduled" ? "Scheduled · " : "";
}
function runSummary(counts) {
  const changed = Number(counts.changed || 0) + Number(counts.new || 0) + Number(counts.removed || 0);
  const problems = Number(counts.fetch_error || 0) + Number(counts.extraction_error || 0);
  const parts = [plural(Number(counts.discovered || 0), "page checked", "pages checked")];
  parts.push(changed ? plural(changed, "change", "changes") : "no changes");
  if (problems) parts.push(plural(problems, "problem", "problems"));
  if (Number(counts.baseline_migration || 0)) parts.push(plural(Number(counts.baseline_migration), "parser re-baseline", "parser re-baselines"));
  return parts.join(", ");
}
function renderRuns() {
  const runs = state.history.slice(0, 120);
  $("runCount").textContent = plural(state.history.length, "run", "runs");
  $("navRunCount").textContent = "";
  if (!runs.length) {
    $("runItems").innerHTML = emptyState("No runs recorded", "Scan history appears after the first scheduled or manual run.");
    return;
  }
  let lastHeading = "";
  $("runItems").innerHTML = runs.map(run => {
    const counts = run.counts || {};
    const source = configuredSources().find(candidate => candidate.id === run.source_id) || {};
    const heading = L.dayHeading(run.generated_at);
    const label = heading !== lastHeading ? '<div class="list-group-label">' + esc(heading) + "</div>" : "";
    lastHeading = heading;
    const problems = Number(counts.fetch_error || 0) + Number(counts.extraction_error || 0);
    const changed = Number(counts.changed || 0) + Number(counts.new || 0) + Number(counts.removed || 0);
    const tone = problems ? "problem" : changed ? "change" : "ok";
    return label + '<button class="row" type="button" data-select-run="' + esc(runKey(run)) + '"' + (runKey(run) === state.selectedRunId ? ' aria-selected="true"' : "") + ">" +
      '<span class="row-mark tone-' + tone + '" aria-hidden="true"></span>' +
      '<span class="row-title">' + esc(shortSourceLabel(source.id ? source : { name: run.regulator || run.source_id })) + "</span>" +
      '<span class="row-time">' + esc(timeOnly(run.generated_at)) + "</span>" +
      '<span class="row-summary">' + esc(runTriggerPrefix(run) + runSummary(counts)) + (run.superseded ? ". Superseded by a later correction." : "") + "</span></button>";
  }).join("");
}
function notificationMap(value, key) {
  const items = value && typeof value === "object" ? value[key] : null;
  return items && typeof items === "object" && !Array.isArray(items) ? items : {};
}
const NOTIFICATION_KINDS = {
  CHANGED_URL: "Content changed", NEW_URL: "New page", REMOVED_URL: "Page removed",
  FETCH_ERROR: "Couldn't fetch", EXTRACTION_ERROR: "Couldn't read content", AI_ASSESSMENT: "AI assessment",
  REMOVAL_HELD: "Removal held for review", DISCOVERY_DEGRADED: "Scan incomplete", DISCOVERY_FAILED: "Scan failed", TEST: "Test alert"
};
function notificationKind(kind) { return NOTIFICATION_KINDS[kind] || String(kind || "Alert"); }
function notificationLists() {
  const pending = Object.entries(notificationMap(state.outbox, "pending_events"))
    .map(([eventId, item]) => ({ ...(item && typeof item === "object" ? item : {}), eventId, queued: true }))
    .sort((a, b) => String(b.eventId).localeCompare(String(a.eventId)));
  const sent = Object.entries(notificationMap(state.notifications, "sent_events"))
    .map(([eventId, item]) => ({ ...(item && typeof item === "object" ? item : {}), eventId, queued: false }))
    .sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));
  return { pending, sent };
}
function renderNotifications() {
  const { pending, sent } = notificationLists();
  $("navNotificationCount").textContent = pending.length ? pending.length : "";
  $("navNotificationCount").classList.toggle("is-alert", pending.length > 0);
  $("notificationPendingCount").textContent = pending.length ? "(" + pending.length + ")" : "";
  $("notificationSentCount").textContent = sent.length ? "(" + sent.length + ")" : "";
  $("notificationCounts").textContent = pending.length ? pending.length + " waiting" : "Nothing waiting";

  $("notificationPendingItems").innerHTML = pending.length ? pending.map(item =>
    '<button class="row" type="button" data-select-notification="' + esc(item.eventId) + '"' + (item.eventId === state.selectedNotificationId ? ' aria-selected="true"' : "") + ">" +
    '<span class="row-mark tone-change" aria-hidden="true"></span>' +
    '<span class="row-title">' + esc(item.topic || notificationKind(item.kind)) + "</span><span class=\"row-time\">Queued</span>" +
    '<span class="row-summary">' + esc(item.summary || "Waiting for the next run to deliver it.") + "</span>" +
    (safeHttpUrl(item.url) ? '<span class="row-sub"><span class="row-host">' + esc(displayUrl(item.url)) + "</span></span>" : "") +
    "</button>"
  ).join("") : '<p class="note-strip">Nothing is waiting. Alerts that fail to send stay queued and are retried on the next run.</p>';

  $("notificationSentItems").innerHTML = sent.length ? sent.slice(0, 100).map(item => {
    const superseded = !!item.superseded;
    return '<button class="row" type="button" data-select-notification="' + esc(item.eventId) + '"' + (item.eventId === state.selectedNotificationId ? ' aria-selected="true"' : "") + ">" +
      '<span class="row-mark tone-' + (superseded ? "pending" : "ok") + '" aria-hidden="true"></span>' +
      '<span class="row-title">' + esc(item.topic || notificationKind(item.kind)) + "</span>" +
      '<span class="row-time">' + esc(rowTime(item.sent_at)) + "</span>" +
      '<span class="row-sub">' + (item.topic ? '<span class="tag">' + esc(notificationKind(item.kind)) + "</span>" : "") +
      (superseded ? '<span class="tag is-irrelevant">Superseded</span>' : "") +
      '<span class="row-host">' + esc(safeHttpUrl(item.url) ? displayUrl(item.url) : shortDate(item.sent_at) + ", no page recorded") + "</span></span></button>";
  }).join("") + (sent.length > 100 ? '<p class="note-strip">Showing the 100 most recent deliveries.</p>' : "")
    : '<p class="note-strip">No alerts have been delivered yet.</p>';
}
function renderLists() {
  if (!state.loaded) return;
  renderOverview();
  renderChangeRoute();
  renderMonitorList();
  renderRuns();
  renderNotifications();
  renderScout();
  renderCadenceView();
  renderNavCounts();
}
function renderNavCounts() {
  const changes = changeLogEntries().filter(entry => CHANGE_EVENT_TYPES.indexOf(entry.event_type) >= 0).length;
  $("navChangeCount").textContent = changes;
  $("navMonitorCount").textContent = state.items.length;
  const toReview = scoutBuckets().REVIEW.length;
  $("navScoutCount").textContent = toReview ? toReview : "";
  $("navScoutCount").classList.toggle("is-fresh", toReview > 0);
  const cadenceCount = $("navCadenceCount");
  if (cadenceCount) {
    const today = L.localIsoDate(new Date());
    const soon = cadenceEventsBetween(today, cadenceAddDays(today, 30)).length;
    cadenceCount.textContent = soon ? String(soon) : "";
    cadenceCount.classList.toggle("is-fresh", soon > 0);
  }
}

/* ================= Detail: a change ================= */

function detailHeading(options) {
  return (options.back ? '<button class="text-button detail-back" type="button" data-back>Back to the list</button>' : "") +
    (options.source ? '<div class="detail-source">' + esc(options.source) + "</div>" : "") +
    '<h2 class="detail-title">' + esc(options.title) + "</h2>" +
    (options.subtitle ? '<p class="detail-subtitle">' + esc(options.subtitle) + "</p>" : "") +
    (options.meta ? '<div class="detail-meta">' + options.meta + "</div>" : "") +
    (options.actions ? '<div class="detail-actions">' + options.actions + "</div>" : "");
}
function urlMeta(url) {
  const safe = safeHttpUrl(url);
  return safe ? '<a class="detail-url" href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer"><span>' + esc(displayUrl(safe)) + "</span>" + icon("external") + "</a>" : "";
}
function renderVerdict(event) {
  const verdict = verdictFor(event);
  const tone = L.eventTone(event.event_type);
  if (tone === "problem") {
    const error = (event.evidence && event.evidence.error) || "The scan could not process this resource.";
    return '<section class="sheet" aria-label="What went wrong"><div class="verdict"><div class="verdict-head"><span class="tag tone-problem">' + esc(L.eventLabel(event.event_type)) + "</span>" +
      '<span class="verdict-label">The previous saved copy was kept</span></div><p class="verdict-summary">' + esc(error) + "</p>" +
      '<p class="sheet-note">A problem on one scan never replaces the saved baseline. The next successful scan compares against the last good copy.</p></div></section>';
  }
  if (verdict.state === "relevant" || verdict.state === "irrelevant") {
    const a = verdict.analysis || {};
    const facts = [["Topic", a.topic], ["Kind of change", a.change_type], ["Impact", a.impact], ["Effective date", a.effective_date], ["Who it affects", a.affected_scope], ["Suggested action", a.actions]]
      .filter(([, value]) => value && String(value).trim() && !/^not stated$/i.test(String(value).trim()));
    return '<section class="sheet" aria-label="AI assessment"><div class="verdict">' +
      '<div class="verdict-head"><span class="verdict-label">AI assessment</span>' + (verdict.state === "relevant" ? '<span class="tag is-relevant">Relevant</span>' : '<span class="tag is-irrelevant">Not relevant</span>') + "</div>" +
      (a.summary ? '<p class="verdict-summary">' + esc(a.summary) + "</p>" : "") +
      // A relevant change shows impact, dates and actions straight away; for a
      // change judged not relevant they fold away so the redline stays in view.
      (facts.length || a.reason
        ? '<details class="verdict-why"' + (verdict.state === "relevant" ? " open" : "") + "><summary>" +
          (verdict.state === "relevant" ? "Impact, dates and suggested action" : "Why it was judged not relevant") + "</summary>" +
          (facts.length ? '<dl class="verdict-grid">' + facts.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl>" : "") +
          (a.reason ? "<p>" + esc(a.reason) + "</p>" : "") +
          '<p class="verdict-caveat">The AI reads the same redline shown below. Check the evidence before acting on its view.</p></details>'
        : "") +
      "</div></section>";
  }
  if (verdict.state === "unavailable") {
    const labels = { skipped: "AI review was skipped", error: "AI review failed", invalid: "AI returned an unusable answer", deferred: "AI review is queued for a later run" };
    return '<section class="sheet is-muted" aria-label="AI assessment"><div class="verdict is-muted"><div class="verdict-head"><span class="tag is-unreviewed">Not reviewed</span><span class="verdict-label">' +
      esc(labels[verdict.status] || "AI review unavailable") + '</span></div><p class="verdict-summary">' + esc(verdict.reason || "The change itself is recorded below regardless of the AI result.") + "</p></div></section>";
  }
  if (event.event_type === "CHANGED_URL" || event.event_type === "NEW_URL") {
    return '<section class="sheet" aria-label="AI assessment"><div class="verdict is-muted"><div class="verdict-head"><span class="tag is-unreviewed">Not reviewed</span><span class="verdict-label">No AI assessment is stored for this change</span></div>' +
      '<p class="verdict-summary">The redline below shows the full recorded difference.</p></div></section>';
  }
  return "";
}
function diffModes(event) {
  const modes = [["redline", "Redline"], ["text", "Text diff"]];
  if (event.event_type === "CHANGED_URL" || event.event_type === "HTML_SOURCE_CHANGED") modes.unshift(["compare", "Compare"]);
  if (event.event_type !== "REMOVED_URL") modes.push(["html", "HTML diff"]);
  return '<div class="segmented" role="group" aria-label="Diff view">' + modes.map(([key, label]) =>
    '<button type="button" data-diff-mode="' + key + '" aria-pressed="' + String(state.diffMode === key) + '">' + label + "</button>"
  ).join("") + "</div>";
}
function evidenceSheet(event, boxId) {
  if (L.eventTone(event.event_type) === "problem") return "";
  if (!event.evidence_location) {
    return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">What changed</h3></div>' +
      emptyState("No evidence file", "This event has no stored before-and-after evidence.") + "</section>";
  }
  return '<section class="sheet" aria-labelledby="' + boxId + '-title"><div class="sheet-head"><div><h3 class="sheet-title" id="' + boxId + '-title">What changed</h3>' +
    '<div class="sheet-note" id="' + boxId + '-summary">Loading the stored difference…</div></div>' + diffModes(event) + "</div>" +
    '<div class="sheet-body is-flush" id="' + boxId + '"><div class="loading">Loading evidence…</div></div>' +
    '<div class="sheet-foot"><div class="redline-legend"><span><span class="legend-del">struck</span> removed</span><span><span class="legend-ins">underlined</span> added</span></div>' +
    externalLink(REPO + "/blob/main/" + event.evidence_location, "Evidence file", "sheet-link") + "</div></section>";
}
async function fillEvidence(event, boxId, stillCurrent) {
  const box = document.getElementById(boxId);
  if (!box || !event.evidence_location) return;
  try {
    const evidence = await loadEvidence(event.evidence_location);
    if (!stillCurrent()) return;
    const target = document.getElementById(boxId);
    const summary = document.getElementById(boxId + "-summary");
    if (!target) return;
    const mode = state.diffMode === "compare" && !compareSources(evidence) ? "redline" : state.diffMode;
    if (mode !== state.diffMode) {
      // Older evidence has no saved versions to overlay: drop the Compare option for it.
      const group = target.parentElement && target.parentElement.querySelector('[data-diff-mode="compare"]');
      const scope = group ? group.parentElement : document;
      scope.querySelectorAll("[data-diff-mode]").forEach(button => {
        if (button.dataset.diffMode === "compare") button.remove();
        else button.setAttribute("aria-pressed", String(button.dataset.diffMode === mode));
      });
    }
    if (mode === "compare") {
      if (summary) summary.textContent = "Drag the divider to move between the previous and new version.";
      renderCompare(target, evidence, event, stillCurrent);
    } else if (mode === "html") {
      target.innerHTML = L.renderUnifiedDiff(evidence.html_diff || "");
      if (summary) summary.textContent = "Formatted HTML markup diff. The fetched response is saved separately.";
    } else if (mode === "text") {
      target.innerHTML = L.renderUnifiedDiff(evidence.diff || "");
      if (summary) summary.textContent = "Unified diff of the extracted text.";
    } else {
      const redline = L.renderRedline(evidence.diff || "");
      target.innerHTML = '<div class="redline">' + redline.html + "</div>";
      if (summary) summary.textContent = redline.summary + (redline.truncated ? " (stored diff is truncated)" : "");
    }
  } catch (error) {
    const target = document.getElementById(boxId);
    if (target && stillCurrent()) target.innerHTML = '<p class="rl-empty">Could not load the evidence: ' + esc(String(error.message || error)) + "</p>";
  }
}
function renderChangeDetail() {
  state.detailKeys.changes = detailRenderKey("changes");
  const pane = $("changeDetail");
  const entry = changeLogEntries().find(candidate => candidate.event_id === state.selectedChangeId);
  if (!entry) {
    pane.innerHTML = '<div class="detail-inner">' + emptyState("Select a change", "Choose a change on the left to see exactly what changed.") + "</div>";
    return;
  }
  const item = itemForEvent(entry);
  const source = item ? sourceLabel(sourceForItem(item)) : "";
  const tone = L.eventTone(entry.event_type);
  const meta = '<span class="tag ' + toneClass(entry) + '">' + esc(L.eventLabel(entry.event_type)) + "</span><span>" + esc(fmt(entry.timestamp)) + "</span>" + urlMeta(entry.url);
  const actions = externalLink(entry.url, "Open live page") +
    (item ? '<button class="btn" type="button" data-open-page="' + esc(item.url_id) + '">Page history and snapshots</button>' : "") +
    (tone === "problem" ? "" : '<button class="btn" type="button" data-evidence-pack="' + esc(entry.event_id) + '" title="Download this change, its evidence, assessment, dates and review as one JSON file">Evidence pack</button>');
  const boxId = "change-evidence";
  pane.innerHTML = '<div class="detail-inner">' +
    detailHeading({ back: true, source, title: eventTitle(entry), meta, actions }) +
    renderVerdict(entry) + reviewSheet(entry) + datesSheet(entry) + '<div id="change-items"></div>' + evidenceSheet(entry, boxId) + "</div>";
  const eventId = entry.event_id;
  const stillCurrent = () => state.view === "changes" && state.selectedChangeId === eventId;
  fillEvidence(entry, boxId, stillCurrent);
  fillReportingItems(entry, "change-items", stillCurrent);
}

/* ================= Review decisions, dates, reporting items ================= */

const REVIEW_TONES = { material: "is-relevant", action_required: "is-warn", not_material: "is-irrelevant", acknowledged: "" };
function reviewFor(eventId) {
  const reviews = state.reviews && isPlainObject(state.reviews.reviews) ? state.reviews.reviews : {};
  return isPlainObject(reviews[eventId]) ? reviews[eventId] : null;
}
// Every decision ever recorded for a change, newest first.
function reviewLog(eventId) {
  const log = state.reviews && Array.isArray(state.reviews.log) ? state.reviews.log : [];
  return log.filter(record => isPlainObject(record) && record.event_id === eventId)
    .sort((a, b) => String(b.reviewed_at || "").localeCompare(String(a.reviewed_at || "")));
}
function reviewTag(review) {
  if (!review) return "";
  const label = L.REVIEW_DECISIONS[review.decision] || review.label || "Reviewed";
  return '<span class="tag ' + (REVIEW_TONES[review.decision] || "") + '">' + esc(label) + "</span>";
}
function reviewRequestLink(review) {
  const number = String(review.request || "").match(/#(\d+)/);
  return number ? externalLink(REPO + "/issues/" + number[1], "Issue #" + number[1], "sheet-link") : "";
}
function reviewSheet(entry) {
  if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0) return "";
  const review = reviewFor(entry.event_id);
  const button = '<button class="btn" type="button" data-review-change="' + esc(entry.event_id) + '">' + (review ? "Record a new decision" : "Record review") + "</button>";
  if (!review) {
    return '<section class="sheet" aria-label="Review decision"><div class="verdict is-muted"><div class="verdict-head"><span class="tag is-unreviewed">No decision yet</span><span class="verdict-label">Human review</span></div>' +
      '<p class="verdict-summary">Record whether this change matters to you. The decision, its rationale and who made it are kept with the change.</p>' +
      '<div class="review-actions">' + button + "</div></div></section>";
  }
  const ticket = safeHttpUrl(review.ticket);
  const facts = [
    ["Decided by", review.reviewed_by], ["Recorded", fmt(review.reviewed_at)], ["Owner", review.owner],
  ].filter(([, value]) => value && String(value).trim());
  const earlier = reviewLog(entry.event_id).slice(1);
  return '<section class="sheet" aria-label="Review decision"><div class="verdict">' +
    '<div class="verdict-head"><span class="verdict-label">Review decision</span>' + reviewTag(review) + "</div>" +
    (review.rationale ? '<p class="verdict-summary">' + esc(review.rationale) + "</p>" : "") +
    '<dl class="verdict-grid">' + facts.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") +
    (ticket ? '<div><dt>Ticket</dt><dd><a class="detail-url" href="' + esc(ticket) + '" target="_blank" rel="noopener noreferrer"><span>' + esc(displayUrl(ticket)) + "</span>" + icon("external") + "</a></dd></div>" : "") +
    "</dl>" +
    (earlier.length
      ? '<details class="verdict-why"><summary>' + esc(plural(earlier.length, "earlier decision", "earlier decisions")) + "</summary>" +
        '<ul class="review-log">' + earlier.map(record => "<li>" + reviewTag(record) + '<span class="review-log-when">' + esc(fmt(record.reviewed_at)) +
          (record.reviewed_by ? " · " + esc(record.reviewed_by) : "") + "</span>" + (record.rationale ? "<p>" + esc(record.rationale) + "</p>" : "") + "</li>").join("") + "</ul></details>"
      : "") +
    '<div class="review-actions">' + button + reviewRequestLink(review) + "</div></div></section>";
}
function calendarDay(iso, withYear) {
  const day = L.isoDayToDate(iso);
  return day ? dateLabel(day, withYear) : String(iso || "");
}
function dateBasis(entry) { return entry.basis === "ai" ? "From the AI reading of the change" : "Stated in the text the change added"; }
function datesSheet(entry) {
  const dates = L.datesForChange(state.calendar, entry.event_id);
  if (!dates.length) return "";
  const today = L.localIsoDate();
  return '<section class="sheet" aria-labelledby="change-dates-title"><div class="sheet-head"><div><h3 class="sheet-title" id="change-dates-title">Dates in this change</h3>' +
    '<div class="sheet-note">Read from the change, not confirmed by anyone. Check each date against the source before relying on it.</div></div>' +
    '<button class="sheet-link" type="button" data-copy-calendar>Calendar feed</button></div>' +
    '<ul class="date-list">' + dates.map(date => '<li class="date-row"><span class="date-day">' + esc(calendarDay(date.date, true)) + "</span>" +
      '<span class="date-what"><span class="tag ' + (date.date >= today ? "is-warn" : "") + '">' + esc(date.label || "Date") + '</span><span class="date-due">' + esc(L.dueLabel(date.date, today)) + "</span></span>" +
      (date.quote ? '<q class="date-quote">' + esc(date.quote) + "</q>" : "") + '<span class="date-basis">' + esc(dateBasis(date)) + "</span></li>").join("") +
    "</ul></section>";
}
function hasLineage() { return !!(state.lineage && Array.isArray(state.lineage.mappings) && state.lineage.mappings.length); }
function itemAssets(code) {
  const assets = L.lineageFor(code, state.lineage);
  if (!assets.length) return "";
  const owners = Array.from(new Set(assets.map(asset => asset.owner).filter(Boolean)));
  return '<span class="item-assets">Feeds ' + assets.map(asset => '<span class="item-asset">' + esc(asset.asset) + "</span>").join(", ") +
    (owners.length ? " · " + esc(owners.join(", ")) : "") + "</span>";
}
const ITEM_GROUPS = [["added", "Added"], ["removed", "Removed"], ["amended", "Amended"]];
const ITEM_ROWS_SHOWN = 40;
function reportingItemsSheet(codes) {
  const counts = codes.counts || {};
  const affected = new Set();
  const groups = ITEM_GROUPS.map(([key, label]) => {
    const entries = Array.isArray(codes[key]) ? codes[key] : [];
    if (!entries.length) return "";
    entries.forEach(entry => L.lineageFor(entry.code, state.lineage).forEach(asset => affected.add(asset.asset)));
    return '<div class="items-group"><div class="items-group-label is-' + key + '">' + esc(label) + " <span>" + esc(counts[key] || entries.length) + "</span></div>" +
      '<ul class="items-list">' + entries.slice(0, ITEM_ROWS_SHOWN).map(entry => '<li class="item-row"><span class="item-code">' + esc(entry.code) + "</span>" +
        '<span class="item-text">' + (key === "amended" ? L.renderWordEdit(entry.before || "", entry.after || "") : esc(entry.context || "")) + "</span>" +
        itemAssets(entry.code) + "</li>").join("") + "</ul>" +
      (entries.length > ITEM_ROWS_SHOWN ? '<p class="note-strip">And ' + esc(entries.length - ITEM_ROWS_SHOWN) + " more in the evidence file.</p>" : "") + "</div>";
  }).join("");
  // An older change records only the counts and a few codes, not their context.
  const sampleOnly = !groups && Array.isArray(codes.codes) && codes.codes.length;
  const body = groups || (sampleOnly ? '<p class="note-strip">' + esc(L.describeItemCodes(codes)) + "</p>" : "");
  const before = Number(codes.before_count), after = Number(codes.after_count);
  const note = L.describeItemCodes({ counts, codes: [] }) + (Number.isFinite(before) && Number.isFinite(after) ? " · " + plural(before, "item", "items") + " before, " + after + " after" : "");
  const foot = hasLineage()
    ? '<span class="sheet-note">' + (affected.size ? esc(plural(affected.size, "mapped asset", "mapped assets")) + " affected" : "None of these items is mapped to a downstream asset") + "</span>" +
      externalLink(REPO + "/blob/main/config/lineage.json", "Lineage map", "sheet-link")
    : '<span class="sheet-note">Map item codes to the tables, models and reports that use them, and each change here names what it affects.</span>' +
      externalLink(REPO + "/blob/main/config/lineage.json", "config/lineage.json", "sheet-link");
  return '<section class="sheet" aria-labelledby="change-items-title"><div class="sheet-head"><div><h3 class="sheet-title" id="change-items-title">Reporting items</h3>' +
    '<div class="sheet-note">' + esc(note) + (codes.truncated ? " (lists are capped)" : "") + "</div></div></div>" +
    '<div class="items-body">' + body + "</div>" + '<div class="sheet-foot">' + foot + "</div></section>";
}
async function fillReportingItems(entry, slotId, stillCurrent) {
  const summary = isPlainObject(entry.item_codes) ? entry.item_codes : null;
  let codes = summary;
  if (entry.evidence_location) {
    try {
      const evidence = await loadEvidence(entry.evidence_location);
      if (isPlainObject(evidence.item_codes)) codes = evidence.item_codes;
    } catch (_) {
      // The evidence sheet below reports the failure; the summary still shows.
    }
  }
  const slot = document.getElementById(slotId);
  if (!slot || !stillCurrent() || !codes || !L.describeItemCodes(codes)) return;
  slot.innerHTML = reportingItemsSheet(codes);
}

/* ================= Detail: a page ================= */

function renderSnapshotText(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (!lines.some(line => line.trim())) return emptyState("Snapshot is empty", "A snapshot record exists, but no readable text was extracted from it.");
  const dateRe = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/i;
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed === "[TABLE]") { index += 1; continue; }
    if (trimmed.startsWith("|")) {
      const parsedRows = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        const cells = L.splitMarkdownTableRow(lines[index].trim());
        if (!L.isMarkdownTableSeparator(cells) && cells.some(Boolean)) parsedRows.push(cells);
        index += 1;
      }
      if (parsedRows.length >= 2) {
        const columnCount = Math.max(...parsedRows.map(row => row.length));
        const renderCells = (cells, tag) => {
          const padded = cells.concat(Array(Math.max(0, columnCount - cells.length)).fill(""));
          // Short values (item codes, line numbers, units) stay on one line.
          return "<tr>" + padded.map(cell => "<" + tag + (String(cell || "").length <= 14 ? ' class="is-short"' : "") + ">" + esc(cell || "") + "</" + tag + ">").join("") + "</tr>";
        };
        const header = parsedRows[0];
        output.push('<div class="doc-table-wrap"><table class="doc-table" style="min-width:' + Math.min(1500, Math.max(520, columnCount * 100)) + 'px"><thead>' +
          renderCells(header, "th") + "</thead><tbody>" + parsedRows.slice(1).map(row => renderCells(row, "td")).join("") + "</tbody></table></div>");
      } else {
        output.push(parsedRows.map(row => "<p>" + esc(row.join("  ")) + "</p>").join(""));
      }
      continue;
    }
    let cls = "";
    if (dateRe.test(trimmed)) cls = "doc-date";
    else if (index > 0 && trimmed.length < 72 && !/[.!?:,;]$/.test(trimmed) && trimmed.split(/\s+/).length < 9 && /^[A-Z]/.test(trimmed)) cls = "doc-heading";
    output.push("<p" + (cls ? ' class="' + cls + '"' : "") + ">" + esc(trimmed) + "</p>");
    index += 1;
  }
  return '<div class="doc-text">' + output.join("") + "</div>";
}
function renderSourceCode(source) {
  const lines = String(source || "").split(/\r?\n/);
  return '<div class="source-code" role="region" aria-label="Saved HTML source">' +
    lines.map((line, index) => '<div class="source-line"><span class="line-no">' + (index + 1) + "</span><code>" + (esc(line) || " ") + "</code></div>").join("") + "</div>";
}
// Saved pages render in a sandbox without scripts, so their <script> blocks
// are dropped up front rather than left to fill the console with blocked-script errors.
function previewSource(source, url) {
  source = String(source || "").replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*\/?>/gi, "");
  const baseTag = '<base href="' + esc(url) + '">';
  if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, match => match + baseTag);
  return '<!doctype html><html><head><meta charset="utf-8">' + baseTag + "</head><body>" + source + "</body></html>";
}
function setPdfViewerExpanded(expanded) {
  const shell = $("pdfViewerShell");
  if (!shell) return;
  shell.classList.toggle("is-expanded", expanded);
  document.body.classList.toggle("pdf-viewer-open", expanded);
  const expandButton = shell.querySelector('[data-pdf-action="expand"]');
  const closeButton = shell.querySelector('[data-pdf-action="close"]');
  if (expandButton) expandButton.hidden = expanded;
  if (closeButton) closeButton.hidden = !expanded;
  if (expanded && closeButton) closeButton.focus();
  if (!expanded && expandButton) expandButton.focus();
}
function defaultDetailTab(item) {
  return itemChangeEntries(item).length ? "changes" : "snapshot";
}
function renderDetailHeader(item) {
  const status = itemStatus(item);
  const source = sourceForItem(item);
  const filePath = item.file_snapshot_location || "";
  const htmlPath = item.html_snapshot_location || "";
  const textPath = item.snapshot_location || "";
  const snapshotPath = filePath || htmlPath || textPath;
  const savedFileLabel = filePath && item.extraction_type === "pdf" ? "Saved PDF" : filePath && item.extraction_type === "zip" ? "Saved ZIP" : "Saved file";
  const subtitle = itemSubtitle(item);
  const meta = '<span class="tag tone-' + esc(status.tone) + '">' + esc(status.label) + "</span>" +
    "<span>Checked " + esc(relativeTime(item.last_checked).toLowerCase()) + "</span>" + urlMeta(item.canonical_url);
  const actions = externalLink(item.canonical_url, "Open live page") +
    (snapshotPath ? externalLink(REPO + "/blob/main/" + snapshotPath, savedFileLabel) : "") +
    (item.source_id ? '<button class="btn" type="button" data-run-scan="' + esc(item.source_id) + '" title="Scan this page\'s source now">Scan this source</button>' : "") +
    (item.source_id ? '<button class="btn btn-quiet" type="button" data-stop-monitor="' + esc(item.url_id) +
      '" data-stop-url="' + esc(item.canonical_url) + '" data-stop-source="' + esc(item.source_id) +
      '" data-stop-name="' + esc(itemTitle(item)) + '" title="Stop monitoring this URL">Stop monitoring</button>' : "");
  $("detailHeader").innerHTML = detailHeading({
    back: true, source: sourceLabel(source), title: itemTitle(item), subtitle, meta, actions
  });
  document.querySelectorAll("[data-detail-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.detailTab === state.detailTab);
    button.setAttribute("aria-current", button.dataset.detailTab === state.detailTab ? "page" : "false");
  });
}
function renderPageChanges(item) {
  const events = itemChangeEntries(item).slice(0, 20);
  if (!events.length) {
    const baseline = item.first_seen && item.last_checked && new Date(item.first_seen).getTime() === new Date(item.last_checked).getTime();
    $("detailBody").innerHTML = '<section class="sheet">' + emptyState(baseline ? "Baseline saved" : "No changes recorded",
      baseline ? "The first scan saved this page's baseline. Later scans compare against it." : "This page hasn't changed since monitoring began.") + "</section>";
    return;
  }
  $("detailBody").innerHTML = '<section class="sheet history">' + events.map((event, index) => {
    const tone = L.eventTone(event.event_type);
    return '<details class="history-item" data-history-event="' + esc(event.event_id) + '"' + (index === 0 ? " open" : "") + ">" +
      '<summary><span class="history-head"><span class="tag ' + toneClass(event) + '">' + esc(L.eventLabel(event.event_type)) + "</span>" + verdictTag(verdictFor(event), event) + "</span>" +
      '<span class="history-time">' + esc(fmt(event.timestamp)) + '</span><span class="history-summary">' + esc(eventHeadline(event)) + "</span></summary>" +
      '<div class="history-body" id="history-' + esc(String(event.event_id).replace(/[^a-zA-Z0-9_-]/g, "")) + '"></div></details>';
  }).join("") + (itemChangeEntries(item).length > 20 ? '<p class="note-strip">Showing the 20 most recent events for this page.</p>' : "") + "</section>";
  const first = $("detailBody").querySelector(".history-item[open]");
  if (first) fillHistoryItem(item, first);
}
function fillHistoryItem(item, details) {
  const event = itemChangeEntries(item).find(candidate => candidate.event_id === details.dataset.historyEvent);
  const body = details.querySelector(".history-body");
  if (!event || !body || body.dataset.filled) return;
  body.dataset.filled = "1";
  const boxId = "hist-ev-" + String(event.event_id).replace(/[^a-zA-Z0-9_-]/g, "");
  body.innerHTML = (L.eventTone(event.event_type) === "problem" ? renderVerdict(event) : "") +
    (event.evidence_location
      ? '<div class="sheet-head"><div class="sheet-note" id="' + boxId + '-summary">Loading…</div>' + diffModes(event) + '</div><div id="' + boxId + '"><div class="loading">Loading evidence…</div></div>'
      : '<p class="note-strip">No evidence file is attached to this event.</p>');
  const id = item.url_id;
  fillEvidence(event, boxId, () => state.selectedId === id && state.detailTab === "changes");
}
async function loadSnapshot(item) {
  document.body.classList.remove("pdf-viewer-open");
  const body = $("detailBody");
  if (state.pdfPreviewUrl) {
    URL.revokeObjectURL(state.pdfPreviewUrl);
    state.pdfPreviewUrl = "";
  }
  const filePath = item.file_snapshot_location || "";
  const fileType = String(item.extraction_type || "").toLowerCase();
  const isFile = filePath && (fileType === "pdf" || fileType === "zip");
  const isPdf = fileType === "pdf";
  const previewLabel = isFile ? (isPdf ? "PDF" : "Archive") : "Rendered page";
  body.innerHTML = '<section class="sheet"><div class="snapshot-toolbar"><span class="snapshot-note">Saved ' + esc(fmt(item.last_full_fetch || item.last_checked)) + "</span>" +
    '<div class="segmented" role="group" aria-label="Snapshot view">' +
    '<button type="button" data-snapshot-mode="preview" aria-pressed="' + String(state.snapshotMode === "preview") + '">' + previewLabel + "</button>" +
    '<button type="button" data-snapshot-mode="text" aria-pressed="' + String(state.snapshotMode === "text") + '">Extracted text</button></div></div>' +
    '<div id="snapshotCanvas"><div class="loading">Loading the saved copy…</div></div></section>';
  const canvas = $("snapshotCanvas");
  const current = () => selectedItem() && selectedItem().url_id === item.url_id && state.detailTab === "snapshot";
  if (state.snapshotMode === "text") {
    if (!item.snapshot_location) { canvas.innerHTML = emptyState("No extracted text", "No text snapshot is linked to this page yet."); return; }
    try {
      const text = await readSnapshotFile(item.snapshot_location, state.snapshotCache);
      if (current()) canvas.innerHTML = renderSnapshotText(text);
    } catch (error) {
      if (current()) canvas.innerHTML = emptyState("Couldn't load the extracted text", String(error.message || error));
    }
    return;
  }
  if (isFile && isPdf) {
    try {
      // Fetch the original bytes (raw GitHub permits CORS) and render them
      // through an application/pdf Blob URL. Navigating directly to the raw
      // URL triggers GitHub's attachment download behavior, and Pages publishes
      // only the core JSON, not the saved originals under data/snapshots/.
      const response = await fetchImmutable(filePath);
      if (!response.ok) throw new Error("PDF snapshot request returned HTTP " + response.status);
      const bytes = await response.arrayBuffer();
      if (!current() || state.snapshotMode !== "preview") return;
      state.pdfPreviewUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      canvas.innerHTML =
        '<div class="pdf-viewer-shell" id="pdfViewerShell"><div class="pdf-viewer-toolbar"><span>The original PDF as fetched. Use its controls to zoom and search.</span>' +
        '<span><button class="btn" data-pdf-action="expand" type="button">Full screen</button>' +
        '<button class="btn" data-pdf-action="close" type="button" hidden>Close full screen</button></span></div>' +
        '<iframe class="snapshot-frame pdf-snapshot-frame" title="Saved PDF snapshot" src="' + esc(state.pdfPreviewUrl) + '"></iframe></div>';
    } catch (error) {
      if (current()) canvas.innerHTML = emptyState("Couldn't load the saved PDF", String(error.message || error) + ". The extracted text may still be available.");
    }
    return;
  }
  if (isFile) {
    canvas.innerHTML = emptyState("Original archive saved", "Archives can't be previewed in the browser. Download it from the saved file link, or read its extracted text.", externalLink(REPO + "/blob/main/" + filePath, "Saved ZIP"));
    return;
  }
  if (!item.html_snapshot_location) {
    canvas.innerHTML = item.snapshot_location
      ? emptyState("No page preview", "This resource returned structured or plain content. Its extracted text is available.", '<button class="btn" type="button" data-snapshot-mode="text">Show extracted text</button>')
      : emptyState("Not saved yet", "The first successful scan saves a copy of this page.");
    return;
  }
  try {
    const source = await readSnapshotFile(item.html_snapshot_location, state.htmlCache);
    if (!current()) return;
    canvas.innerHTML = '<p class="snapshot-note snapshot-caveat">Scripts are disabled. Images and styles load from the live site, so they can differ from what was captured.</p>' +
      '<iframe class="snapshot-frame" title="Saved HTML page preview" sandbox=""></iframe>';
    const frame = canvas.querySelector("iframe.snapshot-frame");
    if (frame) frame.srcdoc = previewSource(source, item.canonical_url || "");
  } catch (error) {
    if (current()) canvas.innerHTML = emptyState("Couldn't load the saved page", String(error.message || error));
  }
}
async function loadHtmlSource(item) {
  const path = item.html_snapshot_location || "";
  const body = $("detailBody");
  body.innerHTML = '<section class="sheet"><div class="snapshot-toolbar"><span class="snapshot-note">The response body as fetched, before any browser scripts run.</span>' +
    (path ? externalLink(REPO + "/blob/main/" + path, "Open file", "sheet-link") : "") + '</div><div id="htmlSourceCanvas"><div class="loading">Loading source…</div></div></section>';
  const canvas = $("htmlSourceCanvas");
  if (!path) { canvas.innerHTML = emptyState("No HTML saved", "This resource is a document or hasn't been fetched successfully yet."); return; }
  try {
    const source = await readSnapshotFile(path, state.htmlCache);
    if (selectedItem() && selectedItem().url_id === item.url_id && state.detailTab === "source") canvas.innerHTML = renderSourceCode(source);
  } catch (error) {
    canvas.innerHTML = emptyState("Couldn't load the HTML source", String(error.message || error));
  }
}
function renderDetails(item) {
  const source = sourceForItem(item);
  const rows = [
    ["Source", sourceLabel(source)], ["Source ID", item.source_id], ["HTTP status", item.http_status],
    ["Content type", item.content_type], ["Read as", item.extraction_type], ["Extractor", item.extractor_version],
    ["First seen", fmt(item.first_seen)], ["Last checked", fmt(item.last_checked)], ["Last full download", fmt(item.last_full_fetch)],
    ["ETag", item.etag || "Not supplied"], ["Last-Modified", item.last_modified || "Not supplied"],
    ["Compare only", source.include_selector || "Main content, detected automatically"],
    ["Ignore", (source.ignore_selectors || []).join(", ") || "Nothing"],
    ["Fetch error", item.fetch_error || "None"], ["Extraction error", item.extraction_error || "None"],
    ["Text fingerprint (SHA-256)", item.normalized_hash || "Not available", true], ["Saved HTML fingerprint", item.html_hash || "Not available", true],
    ["Response fingerprint", item.raw_hash || "Not available", true],
    ["Text snapshot", item.snapshot_location || "Not saved", true], ["HTML snapshot", item.html_snapshot_location || "Not saved", true],
    ["Original file", item.file_snapshot_location || "Not saved", true]
  ];
  $("detailBody").innerHTML = integritySheet(item) + '<section class="sheet"><dl class="facts">' + rows.map(([key, value, code]) =>
    "<div><dt>" + esc(key) + '</dt><dd class="' + (code ? "is-code" : "") + '">' + esc(value == null || value === "" ? "Not recorded" : value) + "</dd></div>"
  ).join("") + "</dl></section>";
}
function renderDetailBody() {
  state.detailKeys.monitors = detailRenderKey("monitors");
  const item = selectedItem();
  const pane = $("detailView");
  if (!item) {
    $("detailHeader").innerHTML = emptyState("Select a page", "Choose a page on the left to see its changes and saved copies.");
    $("detailTabs").hidden = true;
    $("detailBody").innerHTML = "";
    return;
  }
  $("detailTabs").hidden = false;
  if (!state.detailTab) state.detailTab = defaultDetailTab(item);
  renderDetailHeader(item);
  if (state.detailTab === "snapshot") loadSnapshot(item);
  else if (state.detailTab === "source") loadHtmlSource(item);
  else if (state.detailTab === "changes") renderPageChanges(item);
  else renderDetails(item);
  if (pane) pane.scrollTop = 0;
}

/* ================= Detail: a run, an alert ================= */

const COUNT_LABELS = [
  ["discovered", "Pages in scope"], ["changed", "Content changed"], ["new", "New pages"], ["removed", "Pages removed"],
  ["source_changed", "Markup-only changes"], ["unchanged", "Unchanged"], ["not_modified", "Not modified (server cache)"],
  ["baseline_migration", "Parser re-baselines"], ["extraction_drift", "Parser output drift"], ["fetch_error", "Couldn't fetch"],
  ["extraction_error", "Couldn't read content"], ["removal_held", "Removals held for review"],
  ["relevance_candidates", "Sent for AI review"], ["ai_ok", "AI reviews completed"], ["ai_invalid", "AI answers unusable"],
  ["ai_error", "AI reviews failed"], ["ai_backlog_pending", "AI reviews queued"]
];
function renderRunDetail() {
  state.detailKeys.runs = detailRenderKey("runs");
  const pane = $("runDetail");
  const run = state.history.find(candidate => runKey(candidate) === state.selectedRunId);
  if (!run) { pane.innerHTML = '<div class="detail-inner">' + emptyState("Select a run", "Choose a run to see what it checked and found.") + "</div>"; return; }
  const counts = run.counts || {};
  const source = configuredSources().find(candidate => candidate.id === run.source_id) || {};
  const always = new Set(["discovered", "changed", "new", "removed", "fetch_error", "extraction_error"]);
  const rows = COUNT_LABELS.filter(([key]) => key in counts && (always.has(key) || Number(counts[key] || 0)));
  const meta = "<span>" + esc(fmt(run.generated_at)) + "</span>" + (source.id && source.active === false ? '<span class="tag">Inactive source</span>' : "");
  pane.innerHTML = '<div class="detail-inner">' +
    detailHeading({ back: true, source: "Run " + (run.run_id || ""), title: sourceLabel(source.id ? source : { name: run.regulator || run.source_id }), meta }) +
    '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Results</h3><span class="sheet-note">' + esc(runSummary(counts)) + "</span></div>" +
    '<table class="count-table"><tbody>' + rows.map(([key, label]) => '<tr class="' + (Number(counts[key] || 0) ? "" : "is-zero") + '"><td>' + esc(label) + "</td><td>" + esc(counts[key] == null ? 0 : counts[key]) + "</td></tr>").join("") + "</tbody></table>" +
    (run.superseded ? '<p class="note-strip is-warning">Superseded. ' + esc(run.superseded_reason || "A later run corrected a parser-only false positive.") + (run.superseded_by_run_id ? " Corrected by run " + esc(run.superseded_by_run_id) + "." : "") + "</p>" : "") +
    "</section></div>";
}
function renderNotificationDetail() {
  state.detailKeys.notifications = detailRenderKey("notifications");
  const pane = $("notificationDetail");
  const { pending, sent } = notificationLists();
  const item = pending.concat(sent).find(candidate => candidate.eventId === state.selectedNotificationId);
  if (!item) {
    pane.innerHTML = '<div class="detail-inner">' + emptyState(
      pending.length || sent.length ? "Select an alert" : "No alerts yet",
      pending.length || sent.length ? "Choose an alert to see what was sent." : "Alerts are sent to your ntfy topic when a scan finds a change or a problem."
    ) + "</div>";
    return;
  }
  const fields = item.queued
    ? [["Summary", item.summary], ["Why", item.reason], ["Impact", item.impact]]
    : [["Summary", item.summary], ["Review note", item.superseded_reason]];
  const meta = '<span class="tag' + (item.queued ? " tone-change" : "") + '">' + esc(item.queued ? "Waiting to send" : item.superseded ? "Sent, later superseded" : "Sent") + "</span>" +
    "<span>" + esc(item.queued ? "Retried on the next run" : fmt(item.sent_at)) + "</span>" + urlMeta(item.url);
  pane.innerHTML = '<div class="detail-inner">' +
    detailHeading({ back: true, source: notificationKind(item.kind), title: item.topic || notificationKind(item.kind), meta, actions: externalLink(item.url, "Open page") }) +
    '<section class="sheet"><dl class="facts">' + fields.filter(([, value]) => value).map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") +
    '<div><dt>Event ID</dt><dd class="is-code">' + esc(item.eventId) + "</dd></div></dl></section></div>";
}

/* ================= Scout: new pages worth monitoring =================
 * Scout runs weekly on GitHub Actions and commits data/scout/. The dashboard
 * only reads it: "Monitor this page" opens the existing add-a-page dialog, and
 * "Not relevant" / "Restore" open a prefilled issue that an owner-only workflow
 * records. Nothing here can change monitoring on its own.
 */
const SCOUT_WORKFLOW_URL = REPO + "/actions/workflows/scout.yml";
const SCOUT_FILTER_COPY = {
  REVIEW: ["Nothing new to review", "Pages a regulator publishes after Scout's first sweep appear here, with the evidence Scout used to judge them."],
  BACKLOG: ["No backlog", "Pages that already existed when Scout started watching, and that look relevant, are listed here."],
  EXCLUDED: ["Nothing set aside", "New pages Scout judged not relevant are kept here so its judgement can be checked."],
  DONE: ["No decisions yet", "Pages you mark not relevant, or start monitoring, move here."]
};
function scoutCandidates() {
  return state.scoutReview && Array.isArray(state.scoutReview.candidates) ? state.scoutReview.candidates : [];
}
function scoutRegulator(id) {
  const fromLatest = state.scoutLatest && Array.isArray(state.scoutLatest.regulators) ? state.scoutLatest.regulators.find(item => item.id === id) : null;
  const fromReview = state.scoutReview && Array.isArray(state.scoutReview.regulators) ? state.scoutReview.regulators.find(item => item.id === id) : null;
  return Object.assign({ id, short_name: id, name: id }, fromReview || {}, fromLatest || {});
}
function scoutChannelLabel(regulatorId, channelId) {
  const regulator = state.scoutReview && Array.isArray(state.scoutReview.regulators) ? state.scoutReview.regulators.find(item => item.id === regulatorId) : null;
  const channel = regulator && Array.isArray(regulator.channels) ? regulator.channels.find(item => item.id === channelId) : null;
  return channel ? channel.label : channelId;
}
// Every configured or inventoried address, so a page registered since the last
// sweep shows as monitored straight away.
function scoutMonitoredKeys() {
  if (state.scoutMonitored) return state.scoutMonitored;
  const keys = new Set();
  configuredSources().forEach(source => [].concat(source.seed_urls || [], source.allowed_urls || []).forEach(url => keys.add(L.urlKey(url))));
  state.items.forEach(item => keys.add(L.urlKey(item.canonical_url)));
  state.scoutMonitored = keys;
  return keys;
}
function scoutBuckets() { return L.scoutBuckets(scoutCandidates(), scoutMonitoredKeys()); }
function scoutFiltered() {
  const query = ($("scoutSearch") ? $("scoutSearch").value : "").trim().toLowerCase();
  const formatFilter = ($("scoutFormatFilter") ? $("scoutFormatFilter").value : state.scoutFormatFilter) || "ALL";
  const items = scoutBuckets()[state.scoutFilter] || [];
  return items.filter(item => {
    const regulator = scoutRegulator(item.regulator_id);
    const evidence = item.evidence || {};
    const assessment = item.assessment || {};
    const format = String(assessment.format || "").toLowerCase();
    let path = "";
    try { path = new URL(item.url).pathname.toLowerCase(); } catch (_) {}
    const isPdf = format.includes("pdf") || path.endsWith(".pdf");
    const isOffice = /\.(doc|docx|xls|xlsx|ppt|pptx)$/i.test(path) || /word|excel|office document|powerpoint/.test(format);
    const hasFileExtension = /\.[a-z0-9]{2,6}$/.test(path);
    const isHtml = format.includes("html") || /web ?page/.test(format) || (!isPdf && !isOffice && !hasFileExtension);
    const typeMatches = formatFilter === "ALL" ||
      (formatFilter === "PDF" && isPdf) ||
      (formatFilter === "OFFICE" && isOffice) ||
      (formatFilter === "HTML" && isHtml) ||
      (formatFilter === "OTHER" && !isPdf && !isOffice && !isHtml);
    if (!typeMatches) return false;
    if (!query) return true;
    return [item.title, item.url, regulator.short_name, regulator.name, evidence.context, evidence.description,
      evidence.anchor_text, evidence.parent_url, ((assessment.publication_type || {}).label)].join(" ").toLowerCase().includes(query);
  });
}
function scoutSelected() { return scoutCandidates().find(item => item.key === state.selectedScoutKey) || null; }
function scoutIsMonitored(item) {
  return !!((item.monitored_by && item.monitored_by.length) || scoutMonitoredKeys().has(L.urlKey(item.url)));
}
function scoutPublished(item) {
  const evidence = item.evidence || {};
  if (evidence.published) return { value: evidence.published, source: "feed" };
  if (evidence.page_published) return { value: evidence.page_published, source: "page" };
  if (evidence.date_hint) return { value: evidence.date_hint, source: "listing" };
  return null;
}
function scoutSweepSummary() {
  const latest = state.scoutLatest;
  if (!latest) return { text: "Scout data isn't available yet", tone: "idle" };
  const status = L.SCOUT_STATUS[latest.status] || L.SCOUT_STATUS.NOT_RUN;
  if (latest.status === "NOT_RUN" || !latest.finished_at) return { text: "No sweep yet. Next " + dateLabel(L.nextScoutSweep(), false), tone: "idle" };
  return { text: "Swept " + when(latest.finished_at) + " · " + status.label, tone: status.tone };
}
function scoutRow(item) {
  const assessment = item.assessment || {};
  const outcome = L.SCOUT_OUTCOMES[assessment.outcome] || L.SCOUT_OUTCOMES.uncertain;
  const regulator = scoutRegulator(item.regulator_id);
  const monitored = scoutIsMonitored(item);
  const dismissed = item.decision && item.decision.decision === "dismissed";
  const type = assessment.publication_type ? assessment.publication_type.label : "";
  const published = scoutPublished(item);
  const time = state.scoutFilter === "BACKLOG" && published ? shortDate(published.value) : rowTime(item.first_seen);
  const statusTag = monitored ? '<span class="tag is-relevant">Monitoring</span>'
    : dismissed ? '<span class="tag is-irrelevant">Dismissed</span>'
    : '<span class="tag ' + outcome.tag + '">' + esc(outcome.label) + "</span>";
  return '<button class="row" type="button" data-scout-key="' + esc(item.key) + '"' + (item.key === state.selectedScoutKey ? ' aria-selected="true"' : "") + ">" +
    '<span class="row-mark ' + (monitored || dismissed ? "" : outcome.mark) + '" aria-hidden="true"></span>' +
    '<span class="row-title">' + esc(item.title || displayUrl(item.url)) + "</span>" +
    '<span class="row-time">' + esc(time) + "</span>" +
    '<span class="row-sub">' + statusTag + (type ? '<span class="tag">' + esc(type) + "</span>" : "") +
    '<span class="row-host">' + esc(regulator.short_name + " · " + (assessment.format || "Web page")) + "</span></span></button>";
}
function renderScout() {
  const buckets = scoutBuckets();
  const items = scoutFiltered();
  const sweep = scoutSweepSummary();
  $("scoutSweepText").textContent = sweep.text;
  $("scoutSweep").dataset.tone = sweep.tone;
  $("scoutSweep").setAttribute("aria-pressed", String(state.selectedScoutKey === "coverage"));
  document.querySelectorAll("[data-scout-filter]").forEach(button => {
    const count = (buckets[button.dataset.scoutFilter] || []).length;
    button.setAttribute("aria-pressed", String(button.dataset.scoutFilter === state.scoutFilter));
    button.dataset.count = String(count);
  });
  const toReview = buckets.REVIEW.length;
  $("scoutCount").textContent = state.scoutFilter === "REVIEW" ? (toReview ? toReview + " to review" : "")
    : plural(items.length, "page", "pages");
  if (!state.scoutReview) {
    $("scoutItems").innerHTML = emptyState("Scout data unavailable", "The Scout files could not be loaded. Monitoring is unaffected; press Reload to try again.");
    return;
  }
  if (!items.length) {
    const copy = SCOUT_FILTER_COPY[state.scoutFilter];
    const notRun = !state.scoutLatest || state.scoutLatest.status === "NOT_RUN";
    $("scoutItems").innerHTML = state.scoutFilter === "REVIEW" && notRun
      ? emptyState("Scout hasn't swept yet", "The first weekly sweep records what each regulator already publishes. Pages published after it appear here.",
        '<button class="btn" type="button" data-scout-coverage>See what Scout covers</button>')
      : emptyState(($("scoutSearch").value.trim() ? "No findings match" : copy[0]), ($("scoutSearch").value.trim() ? "Try a different search." : copy[1]));
    return;
  }
  let lastHeading = "";
  const omitted = state.scoutReview.omitted_backlog || {};
  $("scoutItems").innerHTML = items.map(item => {
    const heading = state.scoutFilter === "BACKLOG" ? scoutRegulator(item.regulator_id).short_name
      : state.scoutFilter === "DONE" ? L.dayHeading((item.decision || {}).decided_at || item.first_seen)
      : "Found " + L.dayHeading(item.first_seen).replace(/^(Today|Yesterday)$/, value => value.toLowerCase());
    const label = heading !== lastHeading ? '<div class="list-group-label">' + esc(heading) + "</div>" : "";
    lastHeading = heading;
    return label + scoutRow(item);
  }).join("") + (state.scoutFilter === "BACKLOG" && Object.keys(omitted).length
    ? '<p class="note-strip">The backlog shows the newest relevant pages per regulator. ' +
      esc(Object.entries(omitted).map(([id, count]) => scoutRegulator(id).short_name + " has " + count + " more").join("; ")) + " in Scout's registry.</p>"
    : "");
}
function scoutFact(label, value, isCode) {
  if (!value) return "";
  return "<div><dt>" + esc(label) + "</dt><dd" + (isCode ? ' class="is-code"' : "") + ">" + value + "</dd></div>";
}
function scoutLink(url, label) {
  const safe = safeHttpUrl(url);
  return safe ? '<a class="sheet-link" href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer">' + esc(label || displayUrl(safe)) + icon("external") + "</a>" : "";
}
function renderScoutAssessment(item) {
  const a = item.assessment || {};
  const outcome = L.SCOUT_OUTCOMES[a.outcome] || L.SCOUT_OUTCOMES.uncertain;
  const published = scoutPublished(item);
  const evidence = item.evidence || {};
  const dims = [
    ["Kind of page", a.publication_type ? a.publication_type.label : "Not recognised"],
    ["Topics", (a.topics || []).join(", ") || "None recognised"],
    ["Format", a.format || "Web page"],
    ["Dated", published ? shortDate(published.value) + " (" + (published.source === "listing" ? "listing text" : published.source === "page" ? "page metadata" : "feed") + ")" : "No date given"],
    ["Last modified", evidence.lastmod ? shortDate(evidence.lastmod) + " (site map)" : ""]
  ].filter(([, value]) => value);
  const reasons = (a.reasons || []).map(reason =>
    '<li class="' + (reason.effect === "+" ? "is-plus" : reason.effect === "-" ? "is-minus" : "is-neutral") + '">' + esc(reason.text) + "</li>").join("");
  return '<section class="sheet" aria-label="Scout assessment"><div class="verdict">' +
    '<div class="verdict-head"><span class="verdict-label">Scout assessment</span><span class="tag ' + outcome.tag + '">' + esc(outcome.label) + "</span>" +
    "<span>" + esc(L.SCOUT_CONFIDENCE[a.confidence] || "") + "</span></div>" +
    '<p class="verdict-summary">' + esc(L.scoutSentence(a)) + "</p>" +
    (reasons ? '<ul class="scout-reasons" aria-label="Signals">' + reasons + "</ul>" : "") +
    '<dl class="verdict-grid">' + dims.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl>" +
    '<p class="verdict-caveat">Scout judges from titles, link text, listing text and addresses, not the full document, and it never rejects a page for lack of evidence. Open the page before deciding.</p>' +
    "</div></section>";
}
function renderScoutEvidence(item) {
  const evidence = item.evidence || {};
  const channels = (item.channels || []).map(id => scoutChannelLabel(item.regulator_id, id));
  const firstSeen = fmt(item.first_seen) + (item.origin === "new" ? " · new since Scout's baseline" : " · already listed in Scout's first sweep");
  const facts = [
    scoutFact("Found via", esc(channels.join(", "))),
    scoutFact("First seen by Scout", esc(firstSeen)),
    scoutFact("Listed on", evidence.parent_url ? scoutLink(evidence.parent_url) : ""),
    scoutFact("Link text", esc(evidence.anchor_text || "")),
    scoutFact("Listing text", esc(evidence.context || "")),
    scoutFact("Feed title", esc(evidence.title && evidence.title !== item.title ? evidence.title : "")),
    scoutFact("Feed category", esc((evidence.categories || []).join(", "))),
    scoutFact("Description", esc(evidence.description || evidence.meta_description || "")),
    scoutFact("Page heading", esc(evidence.heading && evidence.heading !== item.title ? evidence.heading : "")),
    scoutFact("Near a monitored page", evidence.near_monitored ? scoutLink(evidence.near_monitored) : ""),
    scoutFact("Other languages", (item.translations || []).map(link => scoutLink(link.url, (link.language || "").toUpperCase() + " version")).join(" ")),
    scoutFact("robots.txt", evidence.robots_disallowed ? "Disallows fetching this address; Scout did not open it" : ""),
    scoutFact("Finding ID", esc(item.key), true)
  ].join("");
  return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Evidence</h3><span class="sheet-note">What the regulator’s channel said about this address</span></div>' +
    '<dl class="facts">' + facts + "</dl>" +
    '<p class="note-strip">“First seen” is when Scout first noticed the address. It is not proof of when the regulator published it.</p></section>';
}
// The listing's own words, minus what the title already says and button labels.
function scoutSubtitle(item) {
  const evidence = item.evidence || {};
  const strip = text => String(text || "")
    .replace(/\b(Download document|View press release|Read more|Not Available|N\/A)\b/gi, " ")
    .replace(/\b\d+(\.\d+)?\s?(KB|MB)\b/gi, " ");
  let text = strip(evidence.description || evidence.meta_description || evidence.context);
  const title = String(item.title || "");
  if (title && text.indexOf(title) >= 0) text = text.replace(title, " ");
  text = text.replace(/\s+/g, " ").trim();
  const withoutDates = text.replace(/\b\d{1,2} [A-Za-z]+ \d{4}\b/g, "").replace(/\s+/g, " ").trim();
  return withoutDates.length < 24 ? "" : text;
}
function renderScoutDetail() {
  state.detailKeys.scout = detailRenderKey("scout");
  const pane = $("scoutDetail");
  if (state.selectedScoutKey === "coverage") { renderScoutCoverage(pane); return; }
  const item = scoutSelected();
  if (!item) {
    pane.innerHTML = '<div class="detail-inner">' + emptyState("Select a finding", "Choose a page to see why Scout surfaced it.", '<button class="btn" type="button" data-scout-coverage>See what Scout covers</button>') + "</div>";
    return;
  }
  const regulator = scoutRegulator(item.regulator_id);
  const monitored = scoutIsMonitored(item);
  const decision = item.decision || null;
  const dismissed = decision && decision.decision === "dismissed";
  const inventoryItem = state.items.find(row => L.urlKey(row.canonical_url) === L.urlKey(item.url));
  const actions = [];
  if (!monitored && !dismissed) {
    actions.push('<button class="btn btn-primary" type="button" data-scout-monitor="' + esc(item.key) + '">Monitor this page</button>');
    actions.push('<button class="btn" type="button" data-scout-dismiss="' + esc(item.key) + '">Not relevant</button>');
  }
  if (dismissed) actions.push('<button class="btn" type="button" data-scout-restore="' + esc(item.key) + '">Restore to review</button>');
  if (inventoryItem) actions.push('<button class="btn" type="button" data-open-page="' + esc(inventoryItem.url_id) + '">Open in Pages</button>');
  actions.push(externalLink(item.url, "Open page"));
  const subtitle = scoutSubtitle(item);
  const meta = '<span>' + esc(item.origin === "new" ? "Found " + when(item.first_seen) : "In Scout's first sweep") + "</span>" + urlMeta(item.url);
  const status = monitored
    ? '<p class="note-strip">ChangeSentinel monitors this page' + (item.monitored_by && item.monitored_by.length ? " (source " + esc(item.monitored_by.join(", ")) + ")" : "") + ". Changes to it appear under Changes.</p>"
    : dismissed
      ? '<p class="note-strip is-warning">Marked not relevant' + (decision.decided_by ? " by " + esc(decision.decided_by) : "") + " on " + esc(fmt(decision.decided_at)) +
        (decision.reason ? ". Reason: " + esc(decision.reason) : "") + ". This applies to this address only.</p>"
      : "";
  pane.innerHTML = '<div class="detail-inner">' +
    detailHeading({ back: true, source: regulator.short_name + " · " + [regulator.jurisdiction, regulator.region].filter(Boolean).join(", "),
      title: item.title || displayUrl(item.url), subtitle: subtitle.length > 260 ? subtitle.slice(0, 259) + "…" : subtitle, meta, actions: actions.join("") }) +
    status + renderScoutAssessment(item) + renderScoutEvidence(item) + "</div>";
}
function scoutConfigRegulator(id) {
  return state.scoutConfig && Array.isArray(state.scoutConfig.regulators) ? state.scoutConfig.regulators.find(item => item.id === id) || null : null;
}
// What the profile tells Scout beyond its channels, so configured metadata is visible where coverage is read.
function scoutMetadataLine(id) {
  const profile = scoutConfigRegulator(id);
  if (!profile) return "";
  const keywords = profile.keywords || {};
  const parts = [
    "Languages " + ((profile.languages || ["en"]).join(", ")) + ((profile.review_languages || []).length ? " (review " + profile.review_languages.join(", ") + ")" : ""),
    plural((profile.path_hints || []).length, "path hint", "path hints"),
    plural((keywords.relevant || []).length, "relevant keyword", "relevant keywords"),
    plural((keywords.exclude || []).length, "exclusion keyword", "exclusion keywords")
  ];
  if (profile.active === false) parts.unshift("Inactive");
  return '<div class="scout-meta">' + parts.map(part => "<span>" + esc(part) + "</span>").join("") + "</div>";
}

/* Add a source / edit a regulator's details. The form builds a prefilled issue;
   the owner-only "Scout Source Request" workflow validates and applies it. */
const SCOUT_CHANNEL_HELP = {
  feed: "An RSS, Atom or RDF feed the regulator publishes.",
  sitemap: "An XML site map or site-map index. Every address in it is recorded on the first sweep as the baseline.",
  listing: "A page that lists publications (a “what's new”, circulars or press-release page). Scout records the links on it."
};
function scoutChannelType() {
  const checked = document.querySelector('input[name="scoutChannelType"]:checked');
  return checked ? checked.value : "feed";
}
function syncScoutSourceForm() {
  const isNew = $("scoutSourceRegulator").value === "__new";
  const editing = state.scoutSourceMode === "edit";
  $("scoutNewRegulator").hidden = !(isNew || editing);
  $("scoutSourceId").disabled = !isNew;
  $("scoutListingOptions").hidden = scoutChannelType() !== "listing";
  $("scoutChannelHelp").textContent = SCOUT_CHANNEL_HELP[scoutChannelType()];
  $("scoutChannelOptional").hidden = !editing;
  $("scoutActiveRow").hidden = !editing;
  $("scoutMetadata").hidden = !(isNew || editing);
}
function fillScoutMetadata(profile) {
  const keywords = (profile && profile.keywords) || {};
  $("scoutSourceName").value = profile ? profile.name || "" : "";
  $("scoutSourceShortName").value = profile ? profile.short_name || "" : "";
  $("scoutSourceId").value = profile ? profile.id : "";
  $("scoutSourceRegion").value = profile ? profile.region || "NAM" : "NAM";
  $("scoutSourceJurisdiction").value = profile ? profile.jurisdiction || "" : "";
  $("scoutLanguages").value = profile ? (profile.languages || []).join(", ") : "en";
  $("scoutReviewLanguages").value = profile ? (profile.review_languages || []).join(", ") : "en";
  $("scoutRelevantKeywords").value = (keywords.relevant || []).join("\n");
  $("scoutExcludeKeywords").value = (keywords.exclude || []).join("\n");
  $("scoutPathHints").value = L.pathHintsText(profile ? profile.path_hints : []);
  $("scoutKnownGaps").value = profile ? (profile.known_gaps || []).join("\n") : "";
  $("scoutActive").checked = !profile || profile.active !== false;
}
function openScoutSource(mode, regulatorId) {
  state.scoutSourceMode = mode;
  delete $("scoutSourceId").dataset.edited;
  const regulators = state.scoutConfig && Array.isArray(state.scoutConfig.regulators) ? state.scoutConfig.regulators : [];
  const select = $("scoutSourceRegulator");
  select.innerHTML = (mode === "edit" ? "" : '<option value="__new">A new regulator…</option>') +
    regulators.map(item => '<option value="' + esc(item.id) + '">' + esc((item.short_name || item.name) + (item.active === false ? " (inactive)" : "")) + "</option>").join("");
  select.value = regulatorId || "__new";
  select.disabled = mode === "edit";
  fillScoutMetadata(mode === "edit" ? scoutConfigRegulator(regulatorId) : null);
  ["scoutChannelUrl", "scoutChannelLabel", "scoutChannelSelector", "scoutChannelPrefix", "scoutChannelPageParam"].forEach(id => { $(id).value = ""; });
  $("scoutChannelMaxPages").value = "5";
  $("scoutChannelRequired").checked = true;
  const feed = document.querySelector('input[name="scoutChannelType"][value="feed"]');
  if (feed) feed.checked = true;
  $("scoutSourceHeading").textContent = mode === "edit" ? "Edit " + ((scoutConfigRegulator(regulatorId) || {}).short_name || regulatorId) : regulatorId ? "Add a channel" : "Add a Scout source";
  $("scoutSourceLede").textContent = mode === "edit"
    ? "Change how Scout describes and judges this regulator, and optionally add a channel. The owner-only workflow checks the request and updates config/scout.json."
    : "Tell Scout where a regulator publishes. The owner-only workflow checks the request, updates config/scout.json and runs a first sweep, which is a quiet baseline.";
  $("scoutMetadata").open = mode === "edit";
  $("scoutSourceStatus").hidden = true;
  $("scoutPathHintHelp").textContent = "Kinds: " + Object.keys(L.SCOUT_NOUNS).join(", ") + ". Topics: " + L.SCOUT_TOPIC_IDS.map(id => "topic:" + id).join(", ") + ". Or exclude.";
  syncScoutSourceForm();
  const dialog = $("scoutSourceDialog");
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    window.setTimeout(() => (mode === "edit" ? $("scoutSourceName") : regulatorId ? $("scoutChannelUrl") : $("scoutSourceName")).focus(), 30);
  } else {
    showToast("This browser can't open the form. Use a current browser.");
  }
}
function submitScoutSource(event) {
  event.preventDefault();
  const select = $("scoutSourceRegulator");
  const result = L.scoutSourceRequest({
    mode: state.scoutSourceMode, isNew: select.value === "__new", regulatorId: select.value,
    name: $("scoutSourceName").value, shortName: $("scoutSourceShortName").value, id: $("scoutSourceId").value,
    region: $("scoutSourceRegion").value, jurisdiction: $("scoutSourceJurisdiction").value,
    channelType: scoutChannelType(), channelUrl: $("scoutChannelUrl").value, channelLabel: $("scoutChannelLabel").value,
    contentSelector: $("scoutChannelSelector").value, linkPrefix: $("scoutChannelPrefix").value,
    pageParam: $("scoutChannelPageParam").value, maxPages: $("scoutChannelMaxPages").value, required: $("scoutChannelRequired").checked,
    languages: $("scoutLanguages").value, reviewLanguages: $("scoutReviewLanguages").value,
    relevantKeywords: $("scoutRelevantKeywords").value, excludeKeywords: $("scoutExcludeKeywords").value,
    pathHints: $("scoutPathHints").value, knownGaps: $("scoutKnownGaps").value, active: $("scoutActive").checked
  });
  if (result.errors.length) {
    $("scoutSourceStatus").textContent = result.errors.join(" ");
    $("scoutSourceStatus").hidden = false;
    return;
  }
  const params = new URLSearchParams();
  params.set("title", result.title);
  params.set("body", result.body);
  const target = REPO + "/issues/new?" + params.toString();
  $("scoutSourceDialog").close();
  showToast("Submit the prefilled request on GitHub. Scout updates its configuration and sweeps the regulator once it is accepted.");
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) { try { githubWindow.opener = null; } catch (_) {} } else { window.location.href = target; }
}
function scoutStatusTag(status) {
  return status.tone === "ok" ? "is-relevant" : status.tone === "warn" ? "is-warn" : status.tone === "bad" ? "tone-problem" : "is-unreviewed";
}
function renderScoutCoverage(pane) {
  const latest = state.scoutLatest;
  const next = L.nextScoutSweep();
  const nextText = "Next weekly sweep " + dateLabel(next, false) + ", " + clock(next) + ".";
  const runButton = '<button class="btn btn-primary" type="button" data-scout-add-source>Add a source</button>' +
    '<button class="btn" type="button" data-scout-run>Run a sweep now</button>';
  if (!latest) {
    pane.innerHTML = '<div class="detail-inner">' + emptyState("Scout data unavailable", "data/scout/latest.json could not be loaded. " + nextText, runButton) + "</div>";
    return;
  }
  const status = L.SCOUT_STATUS[latest.status] || L.SCOUT_STATUS.NOT_RUN;
  const totals = latest.totals || {};
  const meta = '<span class="tag ' + scoutStatusTag(status) + '">' + esc(status.label) + "</span>" +
    (latest.finished_at ? "<span>" + esc(fmt(latest.finished_at)) + "</span>" : "") +
    (latest.trigger ? "<span>" + esc(latest.trigger === "scheduled" ? "Scheduled sweep" : "Manual sweep") + "</span>" : "") +
    (totals.requests ? "<span>" + esc(plural(Number(totals.requests), "request", "requests")) + "</span>" : "");
  const sections = (latest.regulators || []).map(regulator => {
    const regStatus = L.SCOUT_STATUS[regulator.status] || L.SCOUT_STATUS.NOT_RUN;
    const counts = regulator.counts || {};
    const rows = (regulator.channels || []).map(channel => {
      const problem = ["failed", "blocked", "deferred"].includes(channel.status);
      const note = channel.error || channel.note || "";
      return "<tr><td><span class=\"scout-channel-name\">" + esc(channel.label) + "</span>" +
        '<span class="scout-channel-note' + (problem ? " is-problem" : "") + '">' + esc((L.SCOUT_CHANNEL_STATUS[channel.status] || channel.status) + (note ? ". " + note : "")) + "</span></td>" +
        "<td>" + esc(plural(Number(channel.observed || 0), "address", "addresses")) + (channel.new ? "<br>" + esc(channel.new + " new") : "") + "</td></tr>";
    }).join("");
    const summary = regulator.status === "NOT_RUN" ? regulator.status_reason || "Not swept yet"
      : plural(Number(counts.new || 0), "new page", "new pages") + " · " + plural(Number(regulator.requests || 0), "request", "requests") +
        (regulator.sweep_id && regulator.sweep_id !== latest.sweep_id ? " · from an earlier sweep" : "");
    const crawl = Object.values(regulator.robots || {}).find(entry => entry && entry.crawl_delay);
    const gaps = regulator.known_gaps || [];
    return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">' + esc(regulator.short_name || regulator.name) +
      ' <span class="sheet-note">' + esc([regulator.jurisdiction, regulator.region].filter(Boolean).join(", ")) + "</span></h3>" +
      '<span class="scout-sheet-actions"><span class="tag ' + scoutStatusTag(regStatus) + '">' + esc(regStatus.label) + "</span>" +
      (state.scoutConfig ? '<button class="sheet-link" type="button" data-scout-add-channel="' + esc(regulator.id) + '">Add channel</button>' +
        '<button class="sheet-link" type="button" data-scout-edit="' + esc(regulator.id) + '">Edit details</button>' : "") +
      "</span></div>" + scoutMetadataLine(regulator.id) +
      '<p class="note-strip">' + esc(summary + (regulator.status_reason && regulator.status !== "NOT_RUN" ? ". " + regulator.status_reason + "." : "")) +
      (crawl ? " " + esc("robots.txt asks for " + crawl.crawl_delay + " s between requests; Scout waits that long.") : "") + "</p>" +
      (rows ? '<table class="scout-channels"><tbody>' + rows + "</tbody></table>" : "") +
      (gaps.length ? '<ul class="scout-gaps">' + gaps.map(gap => "<li>" + esc(gap) + "</li>").join("") + "</ul>" : "") +
      "</section>";
  }).join("");
  pane.innerHTML = '<div class="detail-inner">' +
    detailHeading({ back: true, source: "Scout sources and coverage", title: latest.finished_at ? "Last sweep " + when(latest.finished_at) : "No sweep yet",
      subtitle: "Scout reads the channels each regulator publishes (feeds, site maps and listing pages) once a week and lists pages ChangeSentinel isn't monitoring yet. " + nextText,
      meta, actions: runButton + scoutLink(SCOUT_WORKFLOW_URL, "Sweep history on GitHub") }) +
    '<p class="note-strip">Complete means every declared channel was read as planned. It does not mean every page on a regulator’s site was seen; each regulator’s gaps are listed below.</p>' +
    sections + "</div>";
}
function openScoutMonitor(item) {
  openAddMonitor();
  $("newMonitorUrl").value = item.url;
  $("newMonitorName").value = String(item.title || "").replace(/[\r\n]+/g, " ").slice(0, 100);
  $("newMonitorIncludeSelector").value = "";
  $("newMonitorIgnoreSelectors").value = "";
  // A Scout finding is one known address: open the exact-address path directly.
  $("addExact").open = true;
}
function openScoutDecision(verb, item) {
  const request = L.scoutReviewIssue(verb, [item], "");
  const params = new URLSearchParams();
  params.set("title", request.title);
  params.set("body", request.body);
  const target = REPO + "/issues/new?" + params.toString();
  showToast(verb === "restore" ? "Submit the prefilled request on GitHub to return this page to review."
    : "Submit the prefilled request on GitHub. Add a reason first if you like; it applies to this address only.");
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) { try { githubWindow.opener = null; } catch (_) {} } else { window.location.href = target; }
}


/* ================= Cadence: shared regulatory calendar =================
 * Automatic change dates stay in the read-only JSON feed. Team entries use the
 * private calendar-api, which requires a confirmed Supabase Auth email that is
 * on the Cadence membership list. The dashboard never receives a service key.
 */
const CADENCE_ENDPOINT = window.CHANGESENTINEL_CALENDAR_ENDPOINT || "";
const CADENCE_SUPABASE_URL = window.CHANGESENTINEL_ASK_SUPABASE_URL || "";
const CADENCE_PUBLISHABLE_KEY = window.CHANGESENTINEL_ASK_SUPABASE_PUBLISHABLE_KEY || "";
const CADENCE_RECOVERY_REDIRECT_URL = "https://gauravdarwesh.github.io/ChangeSentinel/";
let cadenceClient = null;
function cadenceGetClient() {
  if (!window.supabase || typeof window.supabase.createClient !== "function") throw new Error("The secure calendar connection could not load. Refresh and retry.");
  if (!CADENCE_SUPABASE_URL || !CADENCE_PUBLISHABLE_KEY || !CADENCE_ENDPOINT) throw new Error("Cadence has not been configured yet.");
  if (!cadenceClient) {
    cadenceClient = window.supabase.createClient(CADENCE_SUPABASE_URL, CADENCE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "changesentinel-cadence-auth" }
    });
    cadenceClient.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        state.cadenceRecoveryMode = true;
        state.cadenceSession = session || state.cadenceSession;
        try { history.replaceState(null, "", location.pathname + location.search + "#cadence"); } catch (_) {}
        window.setTimeout(() => {
          cadenceSetMessage("Reset your password", "Choose a new password for your Cadence account below.", false);
          renderCadenceAccess();
          const field = $("cadenceRecoveryPassword");
          if (field) field.focus({ preventScroll: true });
        }, 0);
      } else if (event === "SIGNED_OUT") {
        state.cadenceRecoveryMode = false;
      }
    });
  }
  return cadenceClient;
}
function cadenceSetMessage(title, message, isError) {
  $("cadenceAccessTitle").textContent = title;
  $("cadenceAccessMessage").textContent = message;
  $("cadenceAccess").classList.toggle("is-error", !!isError);
}
async function cadenceApi(method, payload) {
  const client = cadenceGetClient();
  const result = await client.auth.getSession();
  const session = result.data && result.data.session;
  if (result.error || !session || !session.access_token) throw new Error("Sign in with your team email to load shared calendar entries.");
  state.cadenceSession = session;
  const url = method === "GET" ? CADENCE_ENDPOINT + "?action=list" : CADENCE_ENDPOINT;
  const headers = { Accept: "application/json", apikey: CADENCE_PUBLISHABLE_KEY, Authorization: "Bearer " + session.access_token };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, body: method === "GET" ? undefined : JSON.stringify(payload || {}), cache: "no-store" });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || ("Cadence returned HTTP " + response.status + "."));
  return data;
}
async function refreshCadence(force) {
  if (state.cadenceLoading) return state.cadenceLoading;
  if (state.view !== "calendar" && !force) return;
  state.cadenceLoading = (async () => {
    try {
      const client = cadenceGetClient();
      const sessionResult = await client.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      state.cadenceSession = sessionResult.data && sessionResult.data.session;
      if (state.cadenceRecoveryMode && state.cadenceSession && state.cadenceSession.access_token) {
        state.cadenceMember = null;
        state.cadenceEntries = [];
        state.cadenceStatus = "signed-out";
        cadenceSetMessage("Reset your password", "Choose a new password for your Cadence account below.", false);
        renderCadenceAccess();
        return;
      }
      if (!state.cadenceSession || !state.cadenceSession.access_token) {
        state.cadenceMember = null;
        state.cadenceEntries = [];
        state.cadenceStatus = "signed-out";
        state.cadenceError = "";
        cadenceSetMessage("Team calendar", "Sign in with an approved team email to load and edit shared entries. Regulatory dates derived from ChangeSentinel remain visible below.", false);
        renderCadenceView();
        return;
      }
      state.cadenceStatus = "loading";
      renderCadenceAccess();
      const data = await cadenceApi("GET");
      state.cadenceEntries = Array.isArray(data.entries) ? data.entries : [];
      state.cadenceMember = data.member || null;
      state.cadenceStatus = "ready";
      state.cadenceError = "";
      cadenceSetMessage("Connected to Cadence", "Shared team entries are loaded. Changes are saved centrally and email reminders run on the scheduled service.", false);
    } catch (error) {
      state.cadenceEntries = [];
      state.cadenceMember = null;
      state.cadenceStatus = "error";
      state.cadenceError = String(error.message || error);
      cadenceSetMessage("Calendar access needs attention", state.cadenceError, true);
    } finally {
      renderCadenceView();
    }
  })().finally(() => { state.cadenceLoading = null; });
  return state.cadenceLoading;
}
async function signInCadence(event) {
  event.preventDefault();
  if (state.cadenceSignInBusy) return;
  const email = $("cadenceSignInEmail").value.trim().toLowerCase();
  const password = $("cadenceSignInPassword").value;
  if (!email) { $("cadenceSignInEmail").focus(); return; }
  if (!password) { $("cadenceSignInPassword").focus(); return; }
  state.cadenceSignInBusy = true;
  $("cadenceSignInButton").disabled = true;
  try {
    const client = cadenceGetClient();
    const result = await client.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    state.cadenceSession = result.data && result.data.session;
    state.cadenceRecoveryMode = false;
    if (!state.cadenceSession || !state.cadenceSession.access_token) throw new Error("Sign-in did not return a valid session.");
    await refreshCadence(true);
    if (state.cadenceMember) showToast("Signed in to Cadence.");
  } catch (error) {
    cadenceSetMessage("Couldn't sign in", String(error.message || error), true);
  } finally {
    state.cadenceSignInBusy = false;
    $("cadenceSignInButton").disabled = false;
    renderCadenceAccess();
  }
}
async function signOutCadence() {
  try { const client = cadenceGetClient(); await client.auth.signOut(); } catch (_) {}
  state.cadenceRecoveryMode = false;
  state.cadenceSession = null;
  state.cadenceMember = null;
  state.cadenceEntries = [];
  state.cadenceStatus = "signed-out";
  state.cadenceError = "";
  cadenceSetMessage("Signed out", "Shared team entries are hidden until you sign in again. Publicly derived regulatory dates remain available.", false);
  renderCadenceView();
}
function renderCadenceAccess() {
  const session = state.cadenceSession;
  const member = state.cadenceMember;
  $("cadenceSignInForm").hidden = !!session || state.cadenceRecoveryMode;
  $("cadenceRecoveryForm").hidden = !state.cadenceRecoveryMode;
  $("cadenceSignedIn").hidden = !session || state.cadenceRecoveryMode;
  $("cadenceMemberLabel").textContent = member ? member.email + " · " + member.role : session ? "Signed in · not on the team list" : "";
  document.querySelectorAll("[data-calendar-test]").forEach(button => { button.hidden = !(member && (member.role === "admin" || member.role === "editor")); });
  document.querySelectorAll("[data-calendar-new]").forEach(button => {
    button.disabled = !!(member && member.role === "viewer");
    button.title = member && member.role === "viewer" ? "Your Cadence role is read-only" : "Add a regulatory date or team follow-up";
  });
}
async function requestCadencePasswordReset() {
  const emailInput = $("cadenceSignInEmail");
  if (!emailInput.reportValidity()) return;
  if (state.cadenceRecoveryBusy) return;
  const button = $("cadenceForgotPassword");
  state.cadenceRecoveryBusy = true;
  button.disabled = true;
  try {
    const client = cadenceGetClient();
    const { error } = await client.auth.resetPasswordForEmail(emailInput.value.trim().toLowerCase(), {
      redirectTo: CADENCE_RECOVERY_REDIRECT_URL
    });
    if (error) throw error;
    cadenceSetMessage("Check your inbox", "If this email belongs to a Cadence account, password-reset instructions have been sent. Open the newest message to finish on the deployed dashboard.", false);
  } catch (error) {
    cadenceSetMessage("Couldn't send reset email", String(error.message || error), true);
  } finally {
    state.cadenceRecoveryBusy = false;
    button.disabled = false;
  }
}
async function updateCadencePassword(event) {
  event.preventDefault();
  if (state.cadenceRecoveryBusy) return;
  const passwordInput = $("cadenceRecoveryPassword");
  const confirmInput = $("cadenceRecoveryPasswordConfirm");
  confirmInput.setCustomValidity(confirmInput.value === passwordInput.value ? "" : "The passwords do not match.");
  if (!passwordInput.reportValidity() || !confirmInput.reportValidity()) return;
  const button = $("cadenceRecoverySave");
  state.cadenceRecoveryBusy = true;
  button.disabled = true;
  try {
    const client = cadenceGetClient();
    const { error } = await client.auth.updateUser({ password: passwordInput.value });
    if (error) throw error;
    state.cadenceRecoveryMode = false;
    passwordInput.value = "";
    confirmInput.value = "";
    confirmInput.setCustomValidity("");
    cadenceSetMessage("Password updated", "Your new password has been saved. Loading your team calendar…", false);
    renderCadenceAccess();
    await refreshCadence(true);
    showToast("Cadence password updated.");
  } catch (error) {
    cadenceSetMessage("Couldn't update password", String(error.message || error), true);
  } finally {
    state.cadenceRecoveryBusy = false;
    button.disabled = false;
  }
}
function cadenceDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function cadenceDateISO(date) { return L.localIsoDate(date); }
function cadenceAddDays(dateIso, days) {
  const d = cadenceDate(dateIso);
  if (!d) return "";
  d.setDate(d.getDate() + days);
  return cadenceDateISO(d);
}
function cadenceDaysBetween(a, b) {
  const x = cadenceDate(a), y = cadenceDate(b);
  return x && y ? Math.round((Date.UTC(y.getFullYear(), y.getMonth(), y.getDate()) - Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())) / 86400000) : null;
}
function cadenceMonthShift(date, amount) { return new Date(date.getFullYear(), date.getMonth() + amount, 1); }
function cadenceOccurrenceDate(entry, index) {
  const start = cadenceDate(entry.start_date);
  if (!start) return "";
  const type = entry.recurrence || "none";
  if (!index || type === "none") return cadenceDateISO(start);
  if (type === "weekly") { start.setDate(start.getDate() + index * 7); return cadenceDateISO(start); }
  const step = type === "quarterly" ? 3 : type === "yearly" ? 12 : 1;
  const month = start.getMonth() + index * step;
  const targetYear = start.getFullYear() + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  return cadenceDateISO(new Date(targetYear, targetMonth, Math.min(start.getDate(), new Date(targetYear, targetMonth + 1, 0).getDate())));
}
function cadenceOccurrenceDates(entry, from, to) {
  if (!entry || !cadenceDate(entry.start_date) || from > to) return [];
  const type = entry.recurrence || "none";
  if (type === "none") return entry.start_date >= from && entry.start_date <= to ? [entry.start_date] : [];
  let index = 0;
  if (type === "weekly") index = Math.max(0, Math.floor((cadenceDaysBetween(entry.start_date, from) || 0) / 7) - 1);
  else {
    const a = cadenceDate(entry.start_date), b = cadenceDate(from);
    const step = type === "quarterly" ? 3 : type === "yearly" ? 12 : 1;
    index = Math.max(0, Math.floor(((b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth()) / step) - 1);
  }
  const dates = [];
  for (let n = 0; n < 1200; n += 1, index += 1) {
    const date = cadenceOccurrenceDate(entry, index);
    if (!date || date > to) break;
    if (date >= from) dates.push(date);
  }
  return dates;
}
function cadenceEventsBetween(from, to) {
  const events = [];
  const automatic = state.calendar && Array.isArray(state.calendar.entries) ? state.calendar.entries : [];
  for (const item of automatic) {
    const date = String(item && item.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) continue;
    events.push({ kind: "derived", date, title: String(item.title || "Regulatory date"), category: "derived", eventId: String(item.event_id || ""), sourceUrl: String(item.url || ""), item });
  }
  for (const entry of state.cadenceEntries || []) {
    if (!entry || entry.archived || !entry.start_date) continue;
    const duration = entry.end_date && cadenceDaysBetween(entry.start_date, entry.end_date) !== null
      ? Math.max(0, Math.min(30, cadenceDaysBetween(entry.start_date, entry.end_date))) : 0;
    const rangeStart = cadenceAddDays(from, -duration);
    for (const occurrence of cadenceOccurrenceDates(entry, rangeStart, to)) {
      const completed = new Set(Array.isArray(entry.completed_dates) ? entry.completed_dates.map(String) : []);
      for (let offset = 0; offset <= duration; offset += 1) {
        const date = cadenceAddDays(occurrence, offset);
        if (date < from || date > to) continue;
        events.push({
          kind: "manual", date, occurrenceDate: occurrence, title: String(entry.title || "Team entry"),
          category: String(entry.category || "other"), entry, entryId: String(entry.id || ""),
          completed: completed.has(occurrence), sourceUrl: String(entry.source_url || "")
        });
      }
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}
function cadenceTag(category) {
  return ({ expected_update: "Expected update", deadline: "Deadline", meeting: "Meeting", internal_task: "Team task", other: "Other", derived: "Detected date" })[category] || "Calendar entry";
}
function cadenceClass(event) {
  if (event.kind === "derived") return "is-derived";
  if (event.category === "expected_update" || event.category === "deadline") return "is-expected";
  return "is-team";
}
function cadenceEventLabel(event) {
  return event.kind === "derived" ? event.title : (event.category === "expected_update" && event.entry.regulator ? event.entry.regulator + " · " : "") + event.title;
}
function cadenceFilterEvents(allEvents) {
  const search = String(state.cadenceSearch || "").trim().toLocaleLowerCase();
  return allEvents.filter(event => {
    if (state.cadenceFilter === "DETECTED" && event.kind !== "derived") return false;
    if (state.cadenceFilter === "EXPECTED" && !(event.kind === "manual" && ["expected_update", "deadline"].includes(event.category))) return false;
    if (state.cadenceFilter === "TEAM" && !(event.kind === "manual" && !["expected_update", "deadline"].includes(event.category))) return false;
    if (!search) return true;
    // Include the same fields exposed in the agenda and upcoming rows, without
    // ever indexing private reminder-recipient addresses.
    const entry = event.entry || {};
    const item = event.item || {};
    const haystack = [
      event.title, event.date, event.occurrenceDate, event.category, cadenceTag(event.category),
      entry.title, entry.regulator, entry.owner_name, entry.description,
      entry.source_url, entry.recurrence, event.entryId,
      item.title, item.event_id, item.url, item.description,
      event.eventId, event.sourceUrl
    ].filter(value => value !== null && value !== undefined && String(value).trim() !== "")
      .map(value => String(value).toLocaleLowerCase()).join(" ");
    return haystack.includes(search);
  });
}
function renderCadenceView() {
  const grid = $("cadenceMonthGrid");
  if (!grid) return;
  renderCadenceAccess();
  const panel = state.cadencePanel === "upcoming" ? "upcoming" : "month";
  $("cadenceMonthView").hidden = panel !== "month";
  $("cadenceUpcomingView").hidden = panel !== "upcoming";
  document.querySelectorAll("[data-calendar-mode]").forEach(button => {
    button.setAttribute("aria-pressed", button.dataset.calendarMode === panel ? "true" : "false");
  });
  const month = state.cadenceMonth instanceof Date ? state.cadenceMonth : new Date();
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 41);
  const startISO = cadenceDateISO(gridStart), endISO = cadenceDateISO(gridEnd);
  const allEvents = cadenceEventsBetween(startISO, endISO);
  const events = cadenceFilterEvents(allEvents);
  const search = String(state.cadenceSearch || "").trim();
  const byDate = new Map();
  events.forEach(event => { if (!byDate.has(event.date)) byDate.set(event.date, []); byDate.get(event.date).push(event); });
  $("cadenceMonthLabel").textContent = month.toLocaleDateString([], { month: "long", year: "numeric" });
  const today = cadenceDateISO(new Date());
  if (!state.cadenceSelectedDate) state.cadenceSelectedDate = today;
  const thisMonthEvents = allEvents.filter(event => event.date.slice(0, 7) === cadenceDateISO(first).slice(0, 7));
  $("cadenceStatMonth").textContent = String(thisMonthEvents.filter(event => event.kind === "derived").length);
  $("cadenceStatExpected").textContent = String(thisMonthEvents.filter(event => event.kind === "manual" && event.category === "expected_update" && !event.completed).length);
  $("cadenceStatReminders").textContent = String((state.cadenceEntries || []).filter(entry => entry && !entry.archived && entry.reminder_enabled).length);
  let cells = "";
  for (let i = 0; i < 42; i += 1) {
    const day = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const iso = cadenceDateISO(day), dayEvents = byDate.get(iso) || [];
    const classes = ["cadence-day"];
    if (day.getMonth() !== month.getMonth()) classes.push("is-outside");
    if (iso === today) classes.push("is-today");
    if (iso === state.cadenceSelectedDate) classes.push("is-selected");
    const bars = dayEvents.slice(0, 3).map(event => '<span class="cadence-day-event ' + cadenceClass(event) + (event.completed ? " is-done" : "") + '" title="' + esc(cadenceEventLabel(event)) + '">' + esc(cadenceEventLabel(event)) + '</span>').join("");
    const more = dayEvents.length > 3 ? '<span class="cadence-day-more">+' + (dayEvents.length - 3) + " more</span>" : "";
    cells += '<button type="button" role="gridcell" class="' + classes.join(" ") + '" data-calendar-day="' + iso + '" aria-label="' + esc(day.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }) + ", " + dayEvents.length + " entries") + '"><span class="cadence-day-number">' + day.getDate() + '</span><span class="cadence-day-events">' + bars + more + "</span></button>";
  }
  grid.innerHTML = cells;
  const selectedDate = cadenceDate(state.cadenceSelectedDate);
  $("cadenceSelectedDay").textContent = selectedDate ? selectedDate.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }) : "Agenda";
  const dayEvents = byDate.get(state.cadenceSelectedDate) || [];
  $("cadenceAgendaCount").textContent = String(dayEvents.length);
  $("cadenceAgenda").innerHTML = dayEvents.length ? dayEvents.map(event => {
    if (event.kind === "derived") {
      const linked = event.eventId && changeLogEntries().some(change => change.event_id === event.eventId);
      return '<article class="cadence-agenda-item"><div class="cadence-agenda-row"><i class="cadence-agenda-dot is-derived"></i><div class="cadence-agenda-content"><span class="cadence-agenda-title">' + esc(event.title) + '</span><div class="cadence-agenda-meta"><span class="cadence-tag">Detected date</span><span>ChangeSentinel</span></div>' +
        (event.item && event.item.description ? '<p class="cadence-agenda-notes">' + esc(String(event.item.description)) + "</p>" : "") + '</div></div><div class="cadence-agenda-actions">' +
        (event.sourceUrl ? '<a href="' + esc(event.sourceUrl) + '" target="_blank" rel="noopener noreferrer">Open source ↗</a>' : "") +
        (linked ? '<button type="button" data-calendar-open-change="' + esc(event.eventId) + '">View change →</button>' : "") + "</div></article>";
    }
    const entry = event.entry, isEditor = state.cadenceMember && ["admin", "editor"].includes(state.cadenceMember.role);
    const isDone = !!event.completed;
    const reminder = entry.reminder_enabled ? '<span class="cadence-tag is-reminder">Email reminder</span>' : "";
    return '<article class="cadence-agenda-item"><div class="cadence-agenda-row"><i class="cadence-agenda-dot ' + cadenceClass(event) + '"></i><div class="cadence-agenda-content"><span class="cadence-agenda-title">' + esc(event.title) + '</span><div class="cadence-agenda-meta"><span class="cadence-tag">' + esc(cadenceTag(event.category)) + '</span>' +
      (entry.regulator ? '<span>' + esc(entry.regulator) + '</span>' : "") + (entry.owner_name ? '<span>Owner: ' + esc(entry.owner_name) + '</span>' : "") + reminder + (entry.recurrence && entry.recurrence !== "none" ? '<span>↻ ' + esc(entry.recurrence) + '</span>' : "") +
      '</div>' + (entry.description ? '<p class="cadence-agenda-notes">' + esc(entry.description) + "</p>" : "") + '</div></div><div class="cadence-agenda-actions">' +
      (event.sourceUrl ? '<a href="' + esc(event.sourceUrl) + '" target="_blank" rel="noopener noreferrer">Open source ↗</a>' : "") +
      (isEditor ? '<button type="button" data-calendar-complete="' + esc(event.entryId) + '" data-calendar-date="' + esc(event.occurrenceDate) + '" data-calendar-done="' + String(isDone) + '">' + (isDone ? "Reopen occurrence" : "Mark done") + '</button><button type="button" data-calendar-edit="' + esc(event.entryId) + '">Edit</button><button type="button" data-calendar-delete="' + esc(event.entryId) + '">Archive</button>' : (isDone ? '<span>Completed</span>' : "")) +
      "</div></article>";
  }).join("") : (search || state.cadenceFilter !== "ALL" ? '<div class="cadence-empty">No entries match these filters on this day. Try another date or clear the search and type filter.</div>' : '<div class="cadence-empty">Nothing is scheduled for this day.<br>Use <strong>New entry</strong> to log an expected release, filing deadline or internal follow-up.</div>');
  if (panel === "upcoming") renderCadenceUpcomingView(today);
  renderCadenceAccess();
}
function cadenceEntryDurationDays(entry) {
  const days = cadenceDaysBetween(entry && entry.start_date, entry && entry.end_date);
  return days === null ? 0 : Math.max(0, Math.min(30, days));
}
function cadenceUpcomingEvents(today, horizon) {
  const rows = new Map();
  const futureEvents = cadenceEventsBetween(today, horizon);

  // The month grid expands multi-day entries into one event per day. The
  // action list instead shows one row per occurrence, dated on its due/end day.
  for (const event of futureEvents) {
    if (event.kind === "manual") {
      const occurrenceDate = event.occurrenceDate || event.date;
      const dueDate = cadenceAddDays(occurrenceDate, cadenceEntryDurationDays(event.entry));
      if (!dueDate || dueDate < today) continue;
      const key = "manual|" + event.entryId + "|" + occurrenceDate;
      if (!rows.has(key)) rows.set(key, Object.assign({}, event, { date: dueDate, dueDate }));
    } else {
      const key = "derived|" + (event.eventId || "") + "|" + event.date + "|" + event.title;
      if (!rows.has(key)) rows.set(key, event);
    }
  }

  // Show a single actionable overdue occurrence per entry. For recurring
  // entries, older missed cycles do not flood the list; the most recent cycle
  // remains visible until completed or superseded by the next scheduled cycle.
  for (const entry of state.cadenceEntries || []) {
    if (!entry || entry.archived || !entry.start_date) continue;
    const completed = new Set(Array.isArray(entry.completed_dates) ? entry.completed_dates.map(String) : []);
    let occurrenceDate = "";
    if (!entry.recurrence || entry.recurrence === "none") {
      occurrenceDate = String(entry.start_date);
    } else {
      const recentPast = cadenceOccurrenceDates(entry, cadenceAddDays(today, -800), cadenceAddDays(today, -1));
      if (recentPast.length) occurrenceDate = recentPast[recentPast.length - 1];
    }
    if (!occurrenceDate || completed.has(occurrenceDate)) continue;
    const dueDate = cadenceAddDays(occurrenceDate, cadenceEntryDurationDays(entry));
    if (!dueDate || dueDate >= today) continue;
    const event = {
      kind: "manual", date: dueDate, dueDate, occurrenceDate,
      title: String(entry.title || "Team entry"),
      category: String(entry.category || "other"),
      entry, entryId: String(entry.id || ""),
      completed: false, sourceUrl: String(entry.source_url || ""), overdue: true
    };
    rows.set("manual|" + event.entryId + "|" + occurrenceDate, event);
  }
  return Array.from(rows.values()).sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}
function cadenceUpcomingItemMarkup(event, today) {
  const date = cadenceDate(event.date);
  const day = date ? String(date.getDate()) : "—";
  const month = date ? date.toLocaleDateString([], { month: "short" }) : "";
  const entry = event.entry || {};
  const manual = event.kind === "manual";
  const dayDelta = cadenceDaysBetween(today, event.date);
  const urgency = manual
    ? (dayDelta < 0 ? Math.abs(dayDelta) + (Math.abs(dayDelta) === 1 ? " day overdue" : " days overdue")
      : dayDelta === 0 ? "Due today" : "Due in " + dayDelta + (dayDelta === 1 ? " day" : " days"))
    : "";
  const statusClass = manual && dayDelta < 0 ? " is-overdue" : manual && dayDelta === 0 ? " is-due-today" : "";
  const category = manual ? cadenceTag(event.category) : "Detected date";
  const owner = manual && entry.owner_name ? '<span>Owner: ' + esc(entry.owner_name) + '</span>' : "";
  const regulator = manual && entry.regulator ? '<span>' + esc(entry.regulator) + '</span>' : "";
  const recurrence = manual && entry.recurrence && entry.recurrence !== "none" ? '<span>↻ ' + esc(entry.recurrence) + '</span>' : "";
  const notes = manual ? entry.description : event.item && event.item.description;
  const source = event.sourceUrl ? '<a href="' + esc(event.sourceUrl) + '" target="_blank" rel="noopener noreferrer">Open source ↗</a>' : "";
  const changeLinked = !manual && event.eventId && changeLogEntries().some(change => change.event_id === event.eventId);
  const editActions = manual && state.cadenceMember && ["admin", "editor"].includes(state.cadenceMember.role)
    ? '<button type="button" data-calendar-complete="' + esc(event.entryId) + '" data-calendar-date="' + esc(event.occurrenceDate) + '" data-calendar-done="' + String(!!event.completed) + '">' + (event.completed ? "Reopen occurrence" : "Mark done") + '</button><button type="button" data-calendar-edit="' + esc(event.entryId) + '">Edit</button><button type="button" data-calendar-delete="' + esc(event.entryId) + '">Archive</button>'
    : (manual && event.completed ? '<span class="cadence-upcoming-completed">Completed</span>' : "");
  const changeAction = changeLinked ? '<button type="button" data-calendar-open-change="' + esc(event.eventId) + '">View change →</button>' : "";
  return '<article class="cadence-upcoming-item' + statusClass + '">' +
    '<button class="cadence-upcoming-date" type="button" data-calendar-jump-date="' + esc(event.date) + '" aria-label="Show ' + esc(event.date) + ' in month view"><strong>' + esc(day) + '</strong><span>' + esc(month) + '</span></button>' +
    '<div class="cadence-upcoming-content"><div class="cadence-upcoming-title">' + esc(event.title) + '</div>' +
    '<div class="cadence-upcoming-meta"><span class="cadence-tag">' + esc(category) + '</span>' + regulator + owner + recurrence +
    (urgency ? '<span class="cadence-upcoming-urgency' + statusClass + '">' + esc(urgency) + '</span>' : "") + '</div>' +
    (notes ? '<p class="cadence-upcoming-notes">' + esc(String(notes)) + '</p>' : "") +
    '<div class="cadence-upcoming-actions">' + source + changeAction + editActions + '</div></div></article>';
}
function renderCadenceUpcomingView(today) {
  const list = $("cadenceUpcomingList");
  if (!list) return;
  const horizon = cadenceAddDays(today, 90);
  const events = cadenceFilterEvents(cadenceUpcomingEvents(today, horizon));
  $("cadenceUpcomingCount").textContent = events.length + (events.length === 1 ? " entry" : " entries");
  if (!events.length) {
    const narrowed = String(state.cadenceSearch || "").trim() || state.cadenceFilter !== "ALL";
    list.innerHTML = '<div class="cadence-empty">' +
      (narrowed ? "No entries match your search and type filters in the upcoming window." : "No upcoming or overdue entries in the next 90 days.") +
      '</div>';
    return;
  }
  const nextWeek = cadenceAddDays(today, 7);
  const groups = [
    { id: "overdue", title: "Overdue", hint: "Uncompleted team commitments", rows: events.filter(event => event.kind === "manual" && event.date < today && !event.completed) },
    { id: "today", title: "Today", hint: "Due or scheduled today", rows: events.filter(event => event.date === today) },
    { id: "week", title: "Next 7 days", hint: "Coming up through " + nextWeek, rows: events.filter(event => event.date > today && event.date <= nextWeek) },
    { id: "later", title: "Later · next 90 days", hint: "Further out on your calendar", rows: events.filter(event => event.date > nextWeek && event.date <= horizon) }
  ];
  list.innerHTML = groups.map(group =>
    '<section class="cadence-upcoming-group" aria-labelledby="cadenceUpcomingHeading-' + group.id + '">' +
    '<header class="cadence-upcoming-group-head"><div><h3 id="cadenceUpcomingHeading-' + group.id + '">' + esc(group.title) + '</h3><p>' + esc(group.hint) + '</p></div><span class="cadence-upcoming-count">' + group.rows.length + '</span></header>' +
    (group.rows.length ? group.rows.map(event => cadenceUpcomingItemMarkup(event, today)).join("") :
      '<div class="cadence-upcoming-empty">' + ({ overdue: "No overdue team entries.", today: "Nothing due today.", week: "No entries in the next 7 days.", later: "No other entries in the next 90 days." })[group.id] + '</div>') +
    '</section>'
  ).join("");
}
function jumpCadenceToDate(dateISO) {
  const date = cadenceDate(dateISO);
  if (!date) return;
  state.cadencePanel = "month";
  state.cadenceMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  state.cadenceSelectedDate = dateISO;
  renderCadenceView();
}
function shiftCadenceMonth(delta) {
  state.cadenceMonth = cadenceMonthShift(state.cadenceMonth, delta);
  const first = new Date(state.cadenceMonth.getFullYear(), state.cadenceMonth.getMonth(), 1);
  if (state.cadenceSelectedDate.slice(0, 7) !== cadenceDateISO(first).slice(0, 7)) state.cadenceSelectedDate = cadenceDateISO(first);
  renderCadenceView();
}
function openCadenceEntry(id) {
  if (!state.cadenceMember) {
    showToast(state.cadenceSession ? "This email is not on the Cadence team list yet." : "Sign in with your team email before adding shared entries.");
    $("cadenceSignInEmail").focus();
    return;
  }
  if (!["admin", "editor"].includes(state.cadenceMember.role)) { showToast("Your Cadence role is read-only."); return; }
  const entry = id ? state.cadenceEntries.find(item => item.id === id) : null;
  $("cadenceEntryId").value = entry ? entry.id : "";
  $("cadenceEntryTitle").value = entry ? entry.title || "" : "";
  $("cadenceEntryCategory").value = entry ? entry.category || "expected_update" : "expected_update";
  $("cadenceEntryRecurrence").value = entry ? entry.recurrence || "none" : "none";
  $("cadenceEntryStart").value = entry ? entry.start_date || "" : state.cadenceSelectedDate || L.localIsoDate(new Date());
  $("cadenceEntryEnd").value = entry ? entry.end_date || "" : "";
  $("cadenceEntryRegulator").value = entry ? entry.regulator || "" : "";
  $("cadenceEntryOwner").value = entry ? entry.owner_name || "" : "";
  $("cadenceEntrySource").value = entry ? entry.source_url || "" : "";
  $("cadenceEntryDescription").value = entry ? entry.description || "" : "";
  $("cadenceReminderEnabled").checked = !!(entry && entry.reminder_enabled);
  $("cadenceReminderDays").value = String(entry ? entry.reminder_days_before ?? 7 : 7);
  $("cadenceReminderEmails").value = entry
    ? (Array.isArray(entry.reminder_emails) ? entry.reminder_emails.join(", ") : "")
    : (state.cadenceMember.email || "");
  $("cadenceReminderEmails").placeholder = entry && entry.reminder_configured
    ? "Recipients already configured; enter replacements to change them"
    : "team@company.com, owner@company.com";
  $("cadenceReminderDays").disabled = !$("cadenceReminderEnabled").checked;
  $("cadenceReminderEmails").disabled = !$("cadenceReminderEnabled").checked;
  $("cadenceEntryError").hidden = true;
  $("cadenceEntryHeading").textContent = entry ? "Edit regulatory entry" : "New regulatory entry";
  $("cadenceEntrySave").textContent = entry ? "Save changes" : "Save entry";
  $("cadenceEntryDialog").showModal();
}
function cadenceFormValue() {
  return {
    title: $("cadenceEntryTitle").value.trim(),
    category: $("cadenceEntryCategory").value,
    recurrence: $("cadenceEntryRecurrence").value,
    start_date: $("cadenceEntryStart").value,
    end_date: $("cadenceEntryEnd").value || null,
    regulator: $("cadenceEntryRegulator").value.trim(),
    owner_name: $("cadenceEntryOwner").value.trim(),
    source_url: $("cadenceEntrySource").value.trim(),
    description: $("cadenceEntryDescription").value.trim(),
    reminder_enabled: $("cadenceReminderEnabled").checked,
    reminder_days_before: Number($("cadenceReminderDays").value),
    reminder_emails: $("cadenceReminderEmails").value.split(/[;,]/).map(value => value.trim().toLowerCase()).filter(Boolean)
  };
}
async function saveCadenceEntry(event) {
  event.preventDefault();
  if (!state.cadenceMember) { showToast("Sign in with your team email before saving entries."); return; }
  const save = $("cadenceEntrySave"), errorBox = $("cadenceEntryError");
  if (!$("cadenceEntryTitle").reportValidity() || !$("cadenceEntryStart").reportValidity()) return;
  const payload = cadenceFormValue(), id = $("cadenceEntryId").value;
  const existing = id ? state.cadenceEntries.find(item => item.id === id) : null;
  // A blank recipient field on an existing configured reminder means "keep
  // the existing private recipients", not "erase them". The API preserves the
  // server-side list when reminder_emails is omitted.
  if (existing && existing.reminder_configured && !payload.reminder_emails.length) delete payload.reminder_emails;
  if (existing && Array.isArray(existing.completed_dates)) payload.completed_dates = existing.completed_dates;
  if (payload.end_date && payload.end_date < payload.start_date) { errorBox.textContent = "The end date must be on or after the start date."; errorBox.hidden = false; return; }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const privateRecipientsPreserved = Boolean(existing && existing.reminder_configured && !Object.prototype.hasOwnProperty.call(payload, "reminder_emails"));
  if (payload.reminder_enabled && !privateRecipientsPreserved && (!payload.reminder_emails.length || payload.reminder_emails.some(email => !emailPattern.test(email)))) {
    errorBox.textContent = "Enter one or more valid email addresses for reminders, separated by commas.";
    errorBox.hidden = false; return;
  }
  // If this entry had private recipients, blank means preserve. Turning reminders
  // off is the explicit action that clears the server-side recipient list.
  if (!payload.reminder_enabled) payload.reminder_emails = [];
  else if (privateRecipientsPreserved) delete payload.reminder_emails;
  save.disabled = true; errorBox.hidden = true;
  try {
    const result = await cadenceApi("POST", { action: "save", id: id || undefined, entry: payload });
    $("cadenceEntryDialog").close();
    const saved = result.entry;
    if (saved && saved.start_date) { state.cadenceSelectedDate = saved.start_date; state.cadenceMonth = cadenceDate(saved.start_date); state.cadenceMonth.setDate(1); }
    await refreshCadence(true);
    showToast(id ? "Calendar entry updated." : "Calendar entry saved.");
  } catch (error) {
    errorBox.textContent = String(error.message || error);
    errorBox.hidden = false;
  } finally { save.disabled = false; }
}
async function archiveCadenceEntry(id) {
  const entry = state.cadenceEntries.find(item => item.id === id);
  if (!entry || !state.cadenceMember || !["admin", "editor"].includes(state.cadenceMember.role)) { showToast("You do not have access to archive this entry."); return; }
  if (!confirm("Archive “" + String(entry.title || "this entry") + "”? It will disappear from the calendar; its reminder history is retained.")) return;
  try {
    await cadenceApi("POST", { action: "delete", id });
    await refreshCadence(true);
    showToast("Calendar entry archived.");
  } catch (error) { showToast(String(error.message || error)); }
}
async function toggleCadenceOccurrence(id, occurrenceDate, currentlyDone) {
  if (!state.cadenceMember) return showToast("Sign in before changing an occurrence.");
  try {
    await cadenceApi("POST", { action: "complete", id, occurrence_date: occurrenceDate, completed: !currentlyDone });
    await refreshCadence(true);
    showToast(currentlyDone ? "Occurrence reopened." : "Occurrence marked complete.");
  } catch (error) { showToast(String(error.message || error)); }
}
async function sendCadenceTestEmail() {
  if (!state.cadenceMember || !["admin", "editor"].includes(state.cadenceMember.role)) return;
  try {
    await cadenceApi("POST", { action: "send-test" });
    showToast("Test reminder email sent to " + state.cadenceMember.email + ".");
  } catch (error) { cadenceSetMessage("Email test failed", String(error.message || error), true); }
}
function cadenceIcsEscape(value) { return String(value || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;"); }
function downloadTextFile(name, type, text) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.style.display = "none";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCadenceCalendar() {
  const now = new Date(), from = L.localIsoDate(now), to = cadenceAddDays(from, 365);
  const events = cadenceEventsBetween(from, to);
  if (!events.length) { showToast("No calendar entries in the next 12 months to export."); return; }
  const unique = new Map();
  events.forEach(event => {
    const identity = event.kind === "manual" ? event.entryId + "|" + event.occurrenceDate : "derived|" + event.date + "|" + event.title;
    if (!unique.has(identity)) unique.set(identity, event);
  });
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ChangeSentinel//Cadence Regulatory Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  unique.forEach(event => {
    const day = event.kind === "manual" ? event.occurrenceDate : event.date;
    const nextDay = cadenceAddDays(day, 1).replace(/-/g, "");
    const entry = event.entry || {};
    lines.push("BEGIN:VEVENT", "UID:" + cadenceIcsEscape((event.kind === "manual" ? event.entryId : "derived-" + event.eventId) + "-" + day + "@changesentinel"), "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""), "DTSTART;VALUE=DATE:" + day.replace(/-/g, ""), "DTEND;VALUE=DATE:" + nextDay, "SUMMARY:" + cadenceIcsEscape(event.title), "DESCRIPTION:" + cadenceIcsEscape(entry.description || (event.kind === "derived" ? "Detected by ChangeSentinel" : cadenceTag(event.category))), ...(event.sourceUrl ? ["URL:" + String(event.sourceUrl).replace(/[\r\n]/g, "")] : []), "END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  downloadTextFile("cadence-regulatory-calendar.ics", "text/calendar;charset=utf-8", lines.join("\r\n") + "\r\n");
  showToast("Exported the next 12 months of calendar entries.");
}


/* ================= Navigation ================= */

function viewSection(view) {
  return { overview: "overviewView", changes: "changesView", monitors: "monitorsView", runs: "runsView", notifications: "notificationsView", scout: "scoutView", calendar: "calendarView", askSentinel: "askSentinelView" }[view] || "overviewView";
}
function hasSelection(view) {
  return view === "changes" ? !!state.selectedChangeId : view === "monitors" ? !!state.selectedId
    : view === "runs" ? !!state.selectedRunId : view === "notifications" ? !!state.selectedNotificationId
    : view === "scout" ? !!state.selectedScoutKey : false;
}
function renderViews() {
  VIEWS.forEach(view => {
    const section = $(viewSection(view));
    section.hidden = view !== state.view;
    section.classList.toggle("has-selection", view === state.view && state.mobileDetail && hasSelection(view));
  });
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === state.view);
    button.setAttribute("aria-current", button.dataset.view === state.view ? "page" : "false");
  });
  const askLauncher = $("askSentinelLaunch");
  askLauncher.classList.toggle("active", state.view === "askSentinel");
  askLauncher.setAttribute("aria-current", state.view === "askSentinel" ? "page" : "false");
  const titles = { overview: "Overview", changes: "Changes", monitors: "Pages", runs: "Runs", notifications: "Alerts", scout: "Scout", calendar: "Cadence", askSentinel: "Ask Sentinel" };
  document.title = titles[state.view] + " | ChangeSentinel";
}
// On wide screens the first row is selected automatically, so opening a view
// shows content immediately. On phones the list is shown first.
function ensureSelection(view) {
  if (isCompact()) return;
  if (view === "changes" && !changeLogEntries().some(entry => entry.event_id === state.selectedChangeId)) {
    const first = filteredChanges()[0];
    state.selectedChangeId = first ? first.event_id : "";
  }
  if (view === "monitors" && !selectedItem()) {
    const first = state.items[0];
    state.selectedId = first ? first.url_id : "";
    state.detailTab = first ? defaultDetailTab(first) : "";
  }
  if (view === "runs" && !state.history.some(run => runKey(run) === state.selectedRunId)) {
    state.selectedRunId = state.history[0] ? runKey(state.history[0]) : "";
  }
  if (view === "notifications") {
    const { pending, sent } = notificationLists();
    if (!pending.concat(sent).some(item => item.eventId === state.selectedNotificationId)) {
      const first = pending[0] || sent[0];
      state.selectedNotificationId = first ? first.eventId : "";
    }
  }
  if (view === "scout" && state.selectedScoutKey !== "coverage" && !scoutFiltered().some(item => item.key === state.selectedScoutKey)) {
    // Nothing to review yet: show what the last sweep covered instead of an empty pane.
    const first = scoutFiltered()[0];
    state.selectedScoutKey = first ? first.key : "coverage";
  }
}
// What the open detail pane shows, so a background refresh can leave it alone
// when nothing it depends on changed (a redraw resets comparisons and scroll).
function detailRenderKey(view) {
  try {
    if (view === "changes") {
      const entry = changeLogEntries().find(candidate => candidate.event_id === state.selectedChangeId);
      return entry ? JSON.stringify([entry.event_id, entry.evidence_location, verdictFor(entry), state.diffMode, reviewLog(entry.event_id),
        L.datesForChange(state.calendar, entry.event_id), state.assetSignatures.lineage || ""]) : "none";
    }
    if (view === "monitors") {
      const item = selectedItem();
      return item ? JSON.stringify([item.url_id, item.snapshot_location, item.html_snapshot_location, item.file_snapshot_location,
        (item.change_history || []).map(entry => entry.event_id), state.detailTab, state.snapshotMode]) : "none";
    }
    if (view === "runs") {
      const run = state.history.find(candidate => runKey(candidate) === state.selectedRunId);
      return run ? JSON.stringify(run) : "none";
    }
    if (view === "notifications") {
      const { pending, sent } = notificationLists();
      const item = pending.concat(sent).find(candidate => candidate.eventId === state.selectedNotificationId);
      return item ? JSON.stringify(item) : "none";
    }
    if (view === "scout") {
      if (state.selectedScoutKey === "coverage") return "coverage|" + (state.assetSignatures.scoutLatest || "") + "|" + (state.assetSignatures.scoutConfig || "");
      const item = scoutSelected();
      return item ? JSON.stringify([item, scoutIsMonitored(item)]) : "none";
    }
  } catch (_) {}
  return "";
}
function refreshDetailIfChanged(view) {
  const key = detailRenderKey(view);
  if (key && key === state.detailKeys[view]) {
    // The page header carries "checked N ago"; it is cheap and never reloads a snapshot.
    if (view === "monitors" && selectedItem()) renderDetailHeader(selectedItem());
    return;
  }
  renderDetailFor(view);
}
function renderDetailFor(view) {
  if (view === "changes") renderChangeDetail();
  else if (view === "monitors") renderDetailBody();
  else if (view === "runs") renderRunDetail();
  else if (view === "notifications") renderNotificationDetail();
  else if (view === "scout") renderScoutDetail();
  else if (view === "calendar") { renderCadenceView(); refreshCadence(); }
}
function resetDetailScroll(view) {
  const pane = { changes: "changeDetail", monitors: "detailView", runs: "runDetail", notifications: "notificationDetail", scout: "scoutDetail", calendar: "calendarView" }[view];
  if (pane && $(pane)) $(pane).scrollTop = 0;
  if (view === "overview") $("overviewView").scrollTop = 0;
}
function writeHash() {
  const id = state.view === "changes" ? state.selectedChangeId : state.view === "monitors" ? state.selectedId
    : state.view === "runs" ? state.selectedRunId : state.view === "notifications" ? state.selectedNotificationId
    : state.view === "scout" ? state.selectedScoutKey : "";
  const hash = "#" + (HASH_NAMES[state.view] || (state.view === "askSentinel" ? "ask-sentinel" : "overview")) + (id ? "/" + encodeURIComponent(id) : "");
  try { history.replaceState(null, "", state.view === "overview" ? location.pathname + location.search : hash); } catch (_) {}
}
function isCadenceRecoveryRedirect() {
  const hashParams = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
  const searchParams = new URLSearchParams(String(location.search || ""));
  return hashParams.get("type") === "recovery" || searchParams.get("type") === "recovery";
}
function readHash() {
  const raw = String(location.hash || "").replace(/^#/, "");
  const legacy = raw.match(/^monitor=([^&]+)/);
  if (legacy) return { view: "monitors", id: decodeURIComponent(legacy[1]) };
  const [name, ...rest] = raw.split("/");
  const view = Object.keys(HASH_NAMES).find(key => HASH_NAMES[key] === name) || (name === "ask-sentinel" ? "askSentinel" : null);
  return view ? { view, id: rest.length ? decodeURIComponent(rest.join("/")) : "" } : null;
}
function setView(view, options) {
  options = options || {};
  showFieldTip(null);
  state.view = VIEWS.indexOf(view) >= 0 ? view : "overview";
  state.mobileDetail = !!options.detail;
  ensureSelection(state.view);
  renderLists();
  renderDetailFor(state.view);
  renderViews();
  resetDetailScroll(state.view);
  window.scrollTo({ top: 0, behavior: "auto" });
  if (!options.preserveHash) writeHash();
}
function select(view, id, options) {
  options = options || {};
  if (view === "changes") state.selectedChangeId = id;
  if (view === "monitors") {
    if (options.tab) state.detailTab = options.tab;
    else if (state.selectedId !== id) state.detailTab = "";
    state.selectedId = id;
    state.snapshotMode = "preview";
  }
  if (view === "runs") state.selectedRunId = id;
  if (view === "notifications") state.selectedNotificationId = id;
  if (view === "scout") state.selectedScoutKey = id;
  state.view = view;
  state.mobileDetail = true;
  renderLists();
  renderDetailFor(view);
  renderViews();
  resetDetailScroll(view);
  window.scrollTo({ top: 0, behavior: "auto" });
  writeHash();
}
function setSelected(id) { select("monitors", id); }

/* ================= Data refresh ================= */

// Review decisions arrive between scans, so the ledger is polled with the small files.
const SMALL_ASSETS = ["report", "notifications", "outbox", "config", "scoutLatest", "scoutConfig", "calendar", "lineage", "reviews"];
const LARGE_ASSETS = ["inventory", "history", "scoutReview"];
const OPTIONAL_ASSETS = new Set(["scoutLatest", "scoutReview", "scoutConfig", "calendar", "lineage", "reviews"]);
const FULL_REFRESH_MS = 10 * 60 * 1000;
function assetsSignature() {
  return SMALL_ASSETS.concat(LARGE_ASSETS).map(key => key + "=" + (state.assetSignatures[key] || "")).join("|");
}
function scanMarker(report) { return report ? String(report.run_id || "") + "|" + String(report.generated_at || "") : ""; }
function sweepMarker(latest) { return latest ? String(latest.sweep_id || "") + "|" + String(latest.finished_at || "") : ""; }
async function fetchAssets(keys) {
  const values = await Promise.all(keys.map(key => fetchDataAsset(key, !OPTIONAL_ASSETS.has(key))));
  const out = {};
  keys.forEach((key, index) => { out[key] = values[index]; });
  return out;
}
// Overlapping calls (the two-minute poll, Reload) share one load.
function loadData(showErrors) {
  if (state.loading) {
    if (showErrors !== false) state.loading = state.loading.then(() => loadDataOnce(true));
    return state.loading;
  }
  state.loading = loadDataOnce(showErrors).finally(() => { state.loading = null; });
  return state.loading;
}
async function loadDataOnce(showErrors) {
  const background = showErrors === false && state.loaded;
  if (!background) setStatus("Refreshing stored data…", false);
  if (showErrors !== false) $("loadError").hidden = true;
  try {
    const full = !background || Date.now() - state.lastFullLoad > FULL_REFRESH_MS;
    const values = await fetchAssets(full ? SMALL_ASSETS.concat(LARGE_ASSETS) : SMALL_ASSETS);
    if (!full) {
      // The large files only change with a new scan or sweep, which the small
      // report and sweep summary already show.
      const moved = scanMarker(values.report) !== scanMarker(state.report) || sweepMarker(values.scoutLatest) !== sweepMarker(state.scoutLatest);
      if (moved) Object.assign(values, await fetchAssets(LARGE_ASSETS));
      else LARGE_ASSETS.forEach(key => { values[key] = key === "history" ? state.history : key === "inventory" ? state.inventory : state.scoutReview; });
      if (moved) state.lastFullLoad = Date.now();
    } else {
      state.lastFullLoad = Date.now();
    }
    validateDataAssets({
      report: values.report, inventory: values.inventory, historyData: values.history,
      notifications: values.notifications, outbox: values.outbox, config: values.config
    });
    const signature = assetsSignature();
    if (background && signature === state.renderedSignature) {
      reportScanStatus();
      return;
    }
    state.renderedSignature = signature;
    state.report = values.report;
    state.inventory = values.inventory;
    state.history = values.history;
    state.notifications = values.notifications;
    state.outbox = values.outbox;
    state.config = values.config;
    state.scoutLatest = values.scoutLatest;
    state.scoutReview = values.scoutReview;
    state.scoutConfig = values.scoutConfig;
    state.calendar = values.calendar;
    state.lineage = values.lineage;
    state.reviews = values.reviews;
    state.items = makeItems();
    state.scoutMonitored = null;
    const firstLoad = !state.loaded;
    state.loaded = true;
    hydrateDocumentTitles();
    if (firstLoad) {
      const recoveryRedirect = isCadenceRecoveryRedirect();
      const route = recoveryRedirect ? { view: "calendar", id: "" } : readHash();
      if (route) {
        if (route.id) {
          if (route.view === "changes") state.selectedChangeId = route.id;
          if (route.view === "monitors" && state.items.some(item => item.url_id === route.id)) state.selectedId = route.id;
          if (route.view === "runs") state.selectedRunId = route.id;
          if (route.view === "notifications") state.selectedNotificationId = route.id;
          if (route.view === "scout") {
            state.selectedScoutKey = route.id;
            // A deep link to a finding outside the default list opens the list that holds it.
            const linked = scoutCandidates().find(item => item.key === route.id);
            const bucket = linked ? L.scoutBucket(linked, scoutMonitoredKeys()) : "";
            if (bucket) state.scoutFilter = bucket;
          }
        }
        setView(route.view, { detail: !!route.id, preserveHash: recoveryRedirect });
      } else {
        setView("overview");
      }
    } else {
      // A refresh keeps the current view and selection, and the open detail is
      // only redrawn when what it shows actually changed.
      renderLists();
      refreshDetailIfChanged(state.view);
    }
    reportScanStatus();
  } catch (error) {
    setStatus("Stored data unavailable", true);
    $("loadError").textContent = "Couldn't load the monitoring data: " + String(error.message || error) +
      ". The dashboard tried the published copy and the GitHub fallback. Press Refresh to try again.";
    $("loadError").hidden = false;
    if (!state.loaded) {
      $("overviewLede").textContent = "The monitoring data couldn't be loaded. Check the message above, then press Refresh.";
    }
  }
}
function reportScanStatus() {
  const generatedAt = state.report.generated_at ? new Date(state.report.generated_at) : null;
  const hasValidTimestamp = generatedAt && !Number.isNaN(generatedAt.getTime());
  const discoveryEntries = Array.isArray(state.report.discovery)
    ? state.report.discovery
    : state.report.discovery && typeof state.report.discovery === "object"
      ? [state.report.discovery] : [];
  // Missing scan coverage metadata is not evidence of a healthy scan.
  const incompleteDiscovery = discoveryEntries.length === 0 || discoveryEntries.some(entry =>
    !entry || String(entry.state || "UNKNOWN").toUpperCase() !== "COMPLETE"
  );
  const activeIds = activeSourceIds();
  const sourcesInReport = new Set(
    reportSources().map(source => source && source.id).filter(Boolean)
  );
  const missingActiveSources = activeIds.filter(id => !sourcesInReport.has(id));
  const coveredSourceCount = activeIds.length - missingActiveSources.length;
  const lastSavedScan = hasValidTimestamp ? relativeTime(generatedAt.toISOString()).toLowerCase() : "at an unknown time";
  const isStale = hasValidTimestamp &&
    Date.now() - generatedAt.getTime() > 8 * 60 * 60 * 1000;
  const noActiveSources = activeIds.length === 0;
  const incompleteScan = noActiveSources ||
    state.report.baseline_update_allowed !== true || incompleteDiscovery;
  const coverageNote = noActiveSources
    ? ", no active sources configured"
    : missingActiveSources.length
      ? ", " + coveredSourceCount + " of " + activeIds.length + " active sources represented"
      : "";
  if (!hasValidTimestamp) {
    setStatus("Monitoring report timestamp unavailable", false, true);
  } else if (incompleteScan) {
    setStatus("Latest scan incomplete" + coverageNote + (isStale ? ", data stale" : "") + ". Last saved scan " + lastSavedScan + ".", false, true);
  } else if (missingActiveSources.length) {
    setStatus((isStale ? "Monitoring data stale" : "Latest scan partial") + ", " + coveredSourceCount + " of " + activeIds.length +
      " active sources represented. Last saved scan " + lastSavedScan + ".", false, true);
  } else if (isStale) {
    setStatus("Monitoring data stale. Last saved scan " + lastSavedScan + ".", false, true);
  } else {
    setStatus("Latest saved scan " + lastSavedScan + ". All sources complete.", false, false);
  }
}

/* ================= Add a page / bulk spreadsheet upload ================= */

const BULK_REQUEST_MARKER = "<!-- changesentinel:add-monitor-bulk:v1 -->";
const MAX_BULK_LINKS = 25;
const MAX_BULK_REQUEST_URL_LENGTH = 7000;
let bulkImportRows = [];
let bulkImportErrors = [];

/* ================= Add a link: explore a page or follow its links, then confirm =================
 * Step 1 takes a page address and a method. "Explore" shows the page inside
 * the dialog: a script-free copy from the page-reader function, in a sandbox
 * that cannot run script. Clicking a link opens it in the frame; Shift-click
 * (or "Tap selects" on touch screens) selects it. "Follow links by level"
 * reads the page and the pages it links to, up to a bounded number, in this
 * browser. Both end in one checklist; only ticked links are submitted, through
 * the existing owner-only bulk request (25 links each). Nothing becomes a
 * monitor until that workflow registers it.
 */
const PAGE_READER_ENDPOINT = window.CHANGESENTINEL_PAGE_READER_ENDPOINT || "";
const ADD_DRAFT_STORAGE = "cs-add-link-draft-v1";
const LEGACY_SELECTION_STORAGE = "cs-guided-discovery-selection-v1";
const CRAWL_PAGE_LIMITS = { 1: 1, 2: 60, 3: 150 };
const CRAWL_WORKERS = 3;
const REVIEW_PAGE = 300;
const coarsePointer = window.matchMedia ? window.matchMedia("(pointer: coarse)") : null;

function addMonitoredKeys() {
  const keys = new Set();
  activeSources().forEach(source => [].concat(source.seed_urls || [], source.allowed_urls || []).forEach(url => keys.add(L.urlKey(url))));
  state.items.forEach(item => keys.add(L.urlKey(item.canonical_url)));
  return keys;
}
// A page whose monitor was stopped: a new request would not restart it, so it is left out and said so.
function addStoppedKeys(monitored) {
  const keys = new Set();
  configuredSources().filter(source => source && source.active === false)
    .forEach(source => (source.seed_urls || []).forEach(url => { const key = L.urlKey(url); if (!monitored.has(key)) keys.add(key); }));
  return keys;
}
function addItem(raw) {
  const url = safeHttpUrl(raw && raw.url);
  if (!url) return null;
  const text = (value, limit) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  return {
    key: L.urlKey(url), url, title: text(raw.title, 300) || L.pickSlug(url), format: text(raw.format, 20) || L.pickFormat(url),
    section: text(raw.section, 160), parentUrl: safeHttpUrl(raw.parentUrl || ""), parentTitle: text(raw.parentTitle, 200),
    depth: Number.isInteger(raw.depth) ? raw.depth : null
  };
}
function addLinkItem(link, page, depth) {
  return addItem({ url: link.url, title: link.text, format: link.format, section: link.section, parentUrl: page.url,
    parentTitle: page.title || displayUrl(page.url), depth });
}

/* ---------- Draft: the work survives closing the dialog or reloading ---------- */

function addSaveDraft() {
  const a = state.add;
  try {
    localStorage.setItem(ADD_DRAFT_STORAGE, JSON.stringify({
      url: a.url, method: a.method, origin: a.origin, scope: a.scope, notes: a.notes.slice(0, 6), info: a.info,
      candidates: a.candidates.slice(0, 6000), picked: Array.from(a.picked.keys()), opened: a.opened, savedAt: new Date().toISOString()
    }));
  } catch (_) {
    // Without browser storage the work is kept for this visit only.
  }
}
function addRestoreDraft() {
  const a = state.add;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(ADD_DRAFT_STORAGE) || "{}") || {}; } catch (_) { saved = {}; }
  const candidates = (Array.isArray(saved.candidates) ? saved.candidates : []).map(addItem).filter(Boolean);
  // Links selected with the earlier tray (this tab only) are carried over once.
  try {
    const legacy = JSON.parse(sessionStorage.getItem(LEGACY_SELECTION_STORAGE) || "{}");
    (Array.isArray(legacy.selection) ? legacy.selection : []).forEach(row => {
      const item = addItem({ url: row.url, title: row.name, parentUrl: row.parentUrl });
      if (item) { candidates.push(item); (saved.picked = saved.picked || []).push(item.key); }
    });
    sessionStorage.removeItem(LEGACY_SELECTION_STORAGE);
  } catch (_) {}
  const seen = new Set();
  a.candidates = candidates.filter(item => !seen.has(item.key) && seen.add(item.key));
  a.picked = new Map();
  (Array.isArray(saved.picked) ? saved.picked : []).forEach(key => {
    const item = a.candidates.find(candidate => candidate.key === key);
    if (item) a.picked.set(key, item);
  });
  a.url = safeHttpUrl(saved.url || "") || "";
  a.method = saved.method === "crawl" ? "crawl" : "explore";
  a.origin = saved.origin === "crawl" ? "crawl" : "explore";
  a.scope = typeof saved.scope === "string" ? saved.scope : "";
  a.notes = Array.isArray(saved.notes) ? saved.notes.map(String).slice(0, 6) : [];
  a.info = typeof saved.info === "string" ? saved.info.slice(0, 200) : "";
  a.opened = saved.opened && typeof saved.opened === "object" ? saved.opened : {};
}
function addClearDraft() {
  const a = state.add;
  a.candidates = []; a.picked = new Map(); a.opened = {}; a.notes = []; a.history = []; a.at = -1; a.page = null; a.anchor = "";
  try { localStorage.removeItem(ADD_DRAFT_STORAGE); } catch (_) {}
}

/* ---------- Steps ---------- */

const ADD_STEP_COPY = {
  start: ["Add a link", "Open a page and pick the links on it you want ChangeSentinel to monitor."],
  explore: ["Explore the page", "Click a link to open it here. Shift-click a link to select it for monitoring."],
  crawl: ["Following links", "Reading the page and the pages it links to. You choose what to monitor next."],
  review: ["Confirm the links to monitor", "Only ticked links are requested. Nothing is monitored until the owner workflow registers them."]
};
function addGoto(step) {
  const a = state.add;
  a.step = step;
  const dialog = $("addMonitorDialog");
  dialog.dataset.step = step;
  dialog.classList.toggle("is-wide", step !== "start");
  document.querySelectorAll("#addMonitorDialog [data-add-step-panel]").forEach(panel => { panel.hidden = panel.dataset.addStepPanel !== step; });
  $("addMonitorHeading").textContent = ADD_STEP_COPY[step][0];
  $("addMonitorLede").textContent = step === "explore" && coarsePointer && coarsePointer.matches
    ? "Tap a link to open it here. Turn on “Tap selects” to select links instead." : ADD_STEP_COPY[step][1];
  if (step === "start") renderAddStart();
  if (step === "explore") renderExploreSide();
  if (step === "review") { a.limit = REVIEW_PAGE; renderReview(); }
}
function openAddMonitor() {
  const dialog = $("addMonitorDialog");
  addGoto("start");
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => $("newMonitorUrl").focus(), 30);
  } else {
    showToast("This browser can't open the add-link dialog. Use a current browser.");
  }
}
function renderAddStart() {
  const a = state.add;
  if (a.url && !$("newMonitorUrl").value) $("newMonitorUrl").value = a.url;
  const method = document.querySelector('#addMonitorForm input[name="addMethod"][value="' + a.method + '"]');
  if (method) method.checked = true;
  syncAddMethod();
  const resume = $("addResume");
  const ticked = a.picked.size;
  if (a.candidates.length) {
    let host = "";
    try { host = new URL(a.url).hostname; } catch (_) {}
    resume.innerHTML = "<span>" + esc((ticked ? plural(ticked, "link", "links") + " ticked" : plural(a.candidates.length, "link", "links") + " found") +
      (host ? " from " + host : "") + ". Pick up where you left off?") + '</span><div><button class="btn" type="button" data-add-resume>Resume</button>' +
      '<button class="btn btn-quiet" type="button" data-add-discard>Start over</button></div>';
    resume.hidden = false;
  } else {
    resume.hidden = true;
    resume.innerHTML = "";
  }
}
function syncAddMethod() {
  const checked = document.querySelector('#addMonitorForm input[name="addMethod"]:checked');
  state.add.method = checked && checked.value === "crawl" ? "crawl" : "explore";
  const crawl = state.add.method === "crawl";
  $("addCrawlOptions").hidden = !crawl;
  $("addStartGo").textContent = crawl ? "Find links" : "Open the page";
  if (crawl) syncAddScope();
}
function syncAddScope() {
  const raw = $("newMonitorUrl").value.trim();
  const options = safeHttpUrl(raw) ? L.pickScopeOptions(raw) : [];
  const box = $("newPickScope");
  const previous = (box.querySelector("input:checked") || {}).value;
  if (!options.length) { box.innerHTML = '<p class="field-help">Enter the page address to see the choices.</p>'; return; }
  const chosen = options.some(option => option.id === previous) ? previous : (options.find(option => option.id === "section") || options[0]).id;
  box.innerHTML = options.map(option => '<label class="add-scope-option"><input type="radio" name="pickScope" value="' + esc(option.id) + '" data-prefix="' + esc(option.prefix) + '"' +
    (option.id === chosen ? " checked" : "") + "><span>" + esc(option.label) + "</span><code>" +
    esc(option.prefix ? displayUrl(option.prefix) : "No limit; it may wander into unrelated sections") + "</code></label>").join("");
}
function readAddUrl() {
  const input = $("newMonitorUrl");
  let parsed;
  try { parsed = new URL(input.value.trim()); } catch (_) {
    input.setCustomValidity("Enter a full address beginning with https:// or http://.");
    input.reportValidity();
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    input.setCustomValidity("Use a public http:// or https:// address without a user name or password.");
    input.reportValidity();
    return null;
  }
  input.setCustomValidity("");
  parsed.hash = "";
  return parsed;
}
function startAddLink(event) {
  event.preventDefault();
  const parsed = readAddUrl();
  if (!parsed) return;
  const a = state.add;
  const url = parsed.toString();
  if (a.url && L.urlKey(a.url) !== L.urlKey(url)) addClearDraft();
  a.url = url;
  syncAddMethod();
  if (a.method === "crawl") {
    const scope = $("newPickScope").querySelector("input:checked");
    const depth = Number.parseInt($("newMonitorDepth").value || "2", 10);
    return crawlStart(url, [1, 2, 3].indexOf(depth) >= 0 ? depth : 2, scope ? scope.dataset.prefix || "" : "");
  }
  a.origin = "explore";
  a.history = []; a.at = -1; a.page = null;
  addGoto("explore");
  exploreOpen(url, true);
  addSaveDraft();
}

/* ---------- Reading pages ---------- */

async function addReadPage(url) {
  const a = state.add;
  const key = L.urlKey(url);
  if (a.pages.has(key)) return a.pages.get(key);
  if (!PAGE_READER_ENDPOINT) throw new Error("The page reader isn't set up for this dashboard yet");
  const identity = await askSentinelIdentity();
  const headers = Object.assign(askSentinelIdentityHeaders(identity), { "Content-Type": "application/json" });
  let response;
  try {
    response = await fetch(PAGE_READER_ENDPOINT, { method: "POST", headers, body: JSON.stringify({ url }), signal: AbortSignal.timeout(40000) });
  } catch (error) {
    throw new Error(error && error.name === "TimeoutError" ? "The page took too long to read" : "The page reader could not be reached");
  }
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || "The page reader answered HTTP " + response.status);
  if (data.kind === "page" && (!Array.isArray(data.links) || typeof data.html !== "string")) throw new Error("The page reader returned an unexpected answer");
  a.pages.set(key, data);
  if (data.url) a.pages.set(L.urlKey(data.url), data);
  while (a.pages.size > 60) a.pages.delete(a.pages.keys().next().value);
  return data;
}

/* ---------- Explore ---------- */

function exploreStatus(html, tone) {
  $("exploreStatus").innerHTML = html || "";
  $("exploreLed").className = "explore-led" + (tone ? " is-" + tone : "");
}
async function exploreOpen(url, push) {
  const a = state.add;
  const token = ++a.loading;
  $("exploreAddress").textContent = displayUrl(url);
  $("exploreNewTab").href = safeHttpUrl(url) || "#";
  exploreStatus('<div class="loading">Reading ' + esc(displayUrl(url)) + "…</div>", "loading");
  let data;
  try {
    data = await addReadPage(url);
  } catch (error) {
    if (token !== a.loading) return;
    exploreStatus(emptyState("This page couldn't be shown here", String(error.message || error) +
      ". You can still open it in a new tab, or go back and use “Follow links by level”.",
      '<button class="btn" type="button" data-explore-retry="' + esc(url) + '">Try again</button>'), "bad");
    return;
  }
  if (token !== a.loading) return;
  if (data.kind === "document") {
    exploreStatus("", a.page ? "ok" : "");
    const item = addItem({ url: data.url || url, format: data.format, parentUrl: a.page ? a.page.url : "", parentTitle: a.page ? a.page.title : "" });
    if (item) { addToggle(item, true); showToast("That address is a document, so it can't be shown here. It was selected for monitoring."); }
    if (a.page) { $("exploreAddress").textContent = displayUrl(a.page.url); $("exploreNewTab").href = a.page.url; }
    return;
  }
  if (data.kind !== "page") {
    exploreStatus(emptyState("The site didn't return the page", (data.message || "No page came back") + " Open it in a new tab to check.",
      '<button class="btn" type="button" data-explore-retry="' + esc(url) + '">Try again</button>'), "bad");
    return;
  }
  if (push) {
    a.history = a.history.slice(0, a.at + 1).concat([data.url]);
    a.at = a.history.length - 1;
  }
  a.page = data;
  a.tab = a.picked.size ? a.tab : "page";
  $("exploreAddress").textContent = displayUrl(data.url);
  $("exploreNewTab").href = safeHttpUrl(data.url) || "#";
  $("exploreFrame").srcdoc = exploreDocument(data.html);
  exploreStatus("", "ok");
  renderExploreSide();
}
// The reader's copy, plus the marks for selected links. Shown with
// sandbox="allow-same-origin" and no allow-scripts: nothing in it can run.
function exploreDocument(html) {
  const style = "<style>a[data-cs-link]{cursor:pointer}" +
    "a[data-cs-picked]{outline:2px solid #e8890a!important;outline-offset:2px;background:rgba(232,137,10,.16)!important;border-radius:2px}" +
    "html.cs-shift a[data-cs-link],html.cs-select a[data-cs-link]{cursor:copy!important;outline:1px dashed rgba(232,137,10,.85);outline-offset:2px}</style>";
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, style + "</head>") : style + html;
}
function exploreWire() {
  const frame = $("exploreFrame");
  let doc = null;
  try { doc = frame.contentDocument; } catch (_) { doc = null; }
  if (!doc || !doc.documentElement || doc.__csWired) return;
  doc.__csWired = true;
  doc.addEventListener("click", exploreFrameClick, true);
  doc.addEventListener("auxclick", event => event.preventDefault(), true);
  doc.addEventListener("submit", event => event.preventDefault(), true);
  doc.addEventListener("keydown", event => exploreShift(event.shiftKey), true);
  doc.addEventListener("keyup", event => exploreShift(event.shiftKey), true);
  doc.addEventListener("mousemove", event => exploreShift(event.shiftKey), { passive: true });
  doc.documentElement.classList.toggle("cs-select", state.add.selectMode);
  exploreMarkPicked();
}
function exploreShift(on) {
  try { $("exploreFrame").contentDocument.documentElement.classList.toggle("cs-shift", !!on); } catch (_) {}
}
function exploreFrameClick(event) {
  const anchor = event.target && event.target.closest ? event.target.closest("a") : null;
  if (!anchor) return;
  event.preventDefault();
  event.stopPropagation();
  const a = state.add;
  const index = anchor.getAttribute("data-cs-link");
  const link = index != null && a.page ? a.page.links[Number(index)] : null;
  if (!link) return;
  const item = addLinkItem(link, a.page, null);
  if (!item) return;
  if (event.shiftKey || a.selectMode) { addToggle(item); return; }
  if (link.format !== "Web page") {
    addToggle(item, true);
    showToast("“" + item.title + "” is a " + link.format + ", so it can't be opened here. It was selected.");
    return;
  }
  exploreOpen(link.url, true);
}
function exploreMarkPicked() {
  const a = state.add;
  let doc = null;
  try { doc = $("exploreFrame").contentDocument; } catch (_) {}
  if (!doc || !a.page) return;
  doc.querySelectorAll("a[data-cs-link]").forEach(anchor => {
    const link = a.page.links[Number(anchor.getAttribute("data-cs-link"))];
    if (link && a.picked.has(L.urlKey(link.url))) anchor.setAttribute("data-cs-picked", "");
    else anchor.removeAttribute("data-cs-picked");
  });
}
function addToggle(item, force) {
  const a = state.add;
  if (!item) return;
  if (!a.candidates.some(candidate => candidate.key === item.key)) a.candidates.push(item);
  const on = typeof force === "boolean" ? force : !a.picked.has(item.key);
  if (on) a.picked.set(item.key, a.candidates.find(candidate => candidate.key === item.key) || item);
  else a.picked.delete(item.key);
  a.anchor = item.key;
  if (a.step === "explore") { exploreMarkPicked(); renderExploreSide(); }
  addSaveDraft();
}
function addPickRow(item, options) {
  const o = options || {};
  const on = state.add.picked.has(item.key);
  const tags = ['<span class="tag">' + esc(item.format) + "</span>"];
  if (o.monitored) tags.push('<span class="tag is-monitoring">Already monitored</span>');
  else if (o.stopped) tags.push('<span class="tag is-irrelevant">Monitoring stopped</span>');
  return '<div class="link-pick' + (on && !o.locked ? " is-on" : "") + '" data-link-row="' + esc(item.key) + '">' +
    '<label class="link-pick-check"><input type="checkbox" data-link-toggle="' + esc(item.key) + '"' + (on && !o.locked ? " checked" : "") + (o.locked ? " disabled" : "") +
      ' aria-label="' + esc((o.locked ? "Already monitored: " : "Select ") + item.title) + '"><i aria-hidden="true"></i></label>' +
    '<div class="link-pick-main" data-link-main="' + esc(item.key) + '"><span class="link-pick-title">' + esc(item.title) + "</span>" +
      '<span class="link-pick-meta">' + tags.join("") + '<span class="link-pick-url">' + esc(displayUrl(item.url)) + "</span></span></div>" +
    '<div class="link-pick-side">' + (o.open ? '<button type="button" data-explore-go="' + esc(item.url) + '">Open</button>' : externalLink(item.url, "View", "sheet-link")) + "</div></div>";
}
function renderExploreSide() {
  const a = state.add;
  const picked = Array.from(a.picked.values());
  $("exploreSelectedCount").textContent = String(picked.length);
  $("explorePageCount").textContent = a.page ? String(a.page.links.filter(link => !link.chrome).length) : "";
  document.querySelectorAll("[data-explore-tab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.exploreTab === a.tab)));
  $("exploreSelectMode").checked = a.selectMode;
  $("exploreHint").innerHTML = a.selectMode
    ? "Tap selects is on: clicking or tapping a link selects it. Turn it off to browse."
    : coarsePointer && coarsePointer.matches ? "Tap a link to open it here. Turn on <strong>Tap selects</strong> to select links."
      : "<kbd>Shift</kbd>-click a link to select it. Click it to open it here.";
  const thisPage = a.page ? a.picked.has(L.urlKey(a.page.url)) : false;
  const thisButton = document.querySelector("[data-explore-this]");
  thisButton.setAttribute("aria-pressed", String(thisPage));
  thisButton.textContent = thisPage ? "This page selected" : "Select this page";
  thisButton.disabled = !a.page;
  document.querySelector("[data-explore-back]").disabled = a.at <= 0;
  document.querySelector("[data-explore-forward]").disabled = a.at >= a.history.length - 1;
  const list = $("exploreList");
  if (a.tab === "selected") {
    list.innerHTML = picked.length ? picked.slice().reverse().map(item => addPickRow(item)).join("")
      : emptyState("Nothing selected yet", "Shift-click links on the page, or tick them under “On this page”.");
  } else if (!a.page) {
    list.innerHTML = '<div class="loading">Reading the page…</div>';
  } else if (!a.page.links.length) {
    list.innerHTML = emptyState("No links found", "This page has no links in its HTML. Some sites build their links with script, which the reader does not run.");
  } else {
    const content = a.page.links.filter(link => !link.chrome);
    const menus = a.page.links.length - content.length;
    list.innerHTML = L.pickSections(content.map(link => addLinkItem(link, a.page, null)).filter(Boolean)).map((group, index) =>
      '<div class="link-group"><span class="link-group-name"><strong>' + esc(group.section || "On this page") + "</strong> · " + group.items.length + "</span></div>" +
      group.items.map(item => addPickRow(item, { open: item.format === "Web page" })).join("")).join("") +
      (menus ? '<p class="note-strip">' + plural(menus, "link", "links") + " in the site’s menus, header and footer " + (menus === 1 ? "is" : "are") +
        " not listed. You can still Shift-click " + (menus === 1 ? "it" : "them") + " on the page.</p>" : "") +
      (a.page.truncated ? '<p class="note-strip">This page is very long; only its first links are listed.</p>' : "");
  }
  const button = $("exploreReview");
  button.disabled = !picked.length;
  button.textContent = picked.length ? "Review " + plural(picked.length, "link", "links") : "Review links";
  $("exploreFootNote").textContent = picked.length ? plural(picked.length, "link", "links") + " selected · " + plural(a.history.length, "page", "pages") + " visited" : "";
}

/* ---------- Follow links by level ---------- */

async function crawlStart(startUrl, level, prefix) {
  const a = state.add;
  const limit = CRAWL_PAGE_LIMITS[level] || 60;
  const crawl = { running: true, stop: false, level, prefix, limit, read: 0, failed: 0, failures: [], skipped: 0, chrome: 0,
    queue: [{ url: startUrl, depth: 0 }], queued: new Set([L.urlKey(startUrl)]), found: new Map(), current: "" };
  a.crawl = crawl;
  a.scope = prefix;
  a.origin = "crawl";
  a.picked = new Map();
  a.opened = {};
  addGoto("crawl");
  renderCrawl();
  let active = 0;
  await new Promise(resolve => {
    const pump = () => {
      if (crawl.stop || (!crawl.queue.length && !active)) { if (!active) resolve(); return; }
      while (active < CRAWL_WORKERS && crawl.queue.length && !crawl.stop) {
        const job = crawl.queue.shift();
        active += 1;
        crawl.current = job.url;
        addReadPage(job.url).then(data => {
          if (data.kind !== "page") {
            if (data.kind === "error") { crawl.failed += 1; crawl.failures.push(displayUrl(job.url) + " (" + (data.message || "error") + ")"); }
            return;
          }
          crawl.read += 1;
          data.links.forEach(link => {
            // Site menus, headers and footers repeat on every page: not listed, not followed.
            if (link.chrome) { crawl.chrome += 1; return; }
            const key = L.urlKey(link.url);
            if (key === L.urlKey(startUrl)) return;
            if (!crawl.found.has(key)) crawl.found.set(key, addLinkItem(link, data, job.depth + 1));
            if (job.depth + 1 < crawl.level && link.format === "Web page" && !crawl.queued.has(key) && L.pickInScope(link.url, startUrl, crawl.prefix)) {
              if (crawl.queued.size < crawl.limit) { crawl.queued.add(key); crawl.queue.push({ url: link.url, depth: job.depth + 1 }); }
              else crawl.skipped += 1;
            }
          });
        }).catch(error => {
          crawl.failed += 1;
          crawl.failures.push(displayUrl(job.url) + " (" + String(error.message || error) + ")");
        }).finally(() => {
          active -= 1;
          renderCrawl();
          pump();
        });
      }
    };
    pump();
  });
  crawl.running = false;
  a.candidates = Array.from(crawl.found.values()).filter(Boolean);
  a.notes = [];
  if (crawl.stop) a.notes.push("You stopped after " + plural(crawl.read, "page", "pages") + "; links on pages not yet read are missing.");
  if (crawl.skipped) a.notes.push("Stopped at the " + crawl.limit + "-page limit for level " + crawl.level + "; " + plural(crawl.skipped, "more page was", "more pages were") + " not read.");
  a.info = crawl.chrome ? "Links in site menus, headers and footers are left out." : "";
  if (crawl.failed) a.notes.push(plural(crawl.failed, "page", "pages") + " couldn't be read: " + crawl.failures.slice(0, 3).join("; ") + (crawl.failures.length > 3 ? "; …" : "") + ".");
  addSaveDraft();
  renderCrawl();
  if (!crawl.read && crawl.failed) {
    $("crawlTitle").textContent = "The page couldn't be read";
    $("crawlNow").textContent = crawl.failures[0] || "";
    return;
  }
  if (state.add.step === "crawl" && state.add.crawl === crawl) addGoto("review");
}
function renderCrawl() {
  const crawl = state.add.crawl;
  if (!crawl) return;
  const bar = $("crawlBar");
  if (!bar.children.length) bar.innerHTML = Array.from({ length: 40 }, (_, i) => '<i style="--i:' + i + '"></i>').join("");
  const total = Math.max(1, Math.min(crawl.limit, crawl.queued.size));
  const done = crawl.read + crawl.failed;
  Array.from(bar.children).forEach((cell, index) => cell.classList.toggle("on", index < Math.round(40 * done / total)));
  bar.dataset.phase = crawl.running ? "running" : "done";
  $("crawlTitle").textContent = crawl.running ? "Following links to level " + crawl.level + "…" : "Finished following links";
  $("crawlPages").textContent = crawl.read.toLocaleString() + (crawl.running ? " of " + total.toLocaleString() : "");
  $("crawlLinks").textContent = crawl.found.size.toLocaleString();
  $("crawlFailed").textContent = crawl.failed.toLocaleString();
  $("crawlNow").textContent = crawl.running && crawl.current ? displayUrl(crawl.current) : "";
  $("crawlNote").textContent = crawl.running ? "Pages are read one by one; you can stop at any time and review what was found." : "";
  $("crawlStop").disabled = !crawl.running;
  $("crawlReview").disabled = crawl.running || !crawl.found.size;
}

/* ---------- Confirm ---------- */

function addRequestRows(items) {
  return items.map(item => ({ url: item.url, name: L.pickMonitorName(item), include_selector: "", ignore_selectors: [] }));
}
function addPlan() {
  const a = state.add;
  const monitored = addMonitoredKeys();
  const stopped = addStoppedKeys(monitored);
  const picked = Array.from(a.picked.values());
  const summary = L.pickSummary(picked, monitored);
  const pending = summary.pending.filter(item => !stopped.has(item.key));
  const leftStopped = summary.pending.length - pending.length;
  const prepared = L.pickBatches(addRequestRows(pending), makeBulkGitHubIssueUrl, MAX_BULK_LINKS, MAX_BULK_REQUEST_URL_LENGTH);
  return { monitored, stopped, picked, summary, pending, leftStopped, prepared };
}
function renderReview() {
  const a = state.add;
  const plan = addPlan();
  const filters = { query: a.query, format: a.format, show: a.show, selectedKeys: new Set(a.picked.keys()) };
  const groups = L.pickGroupBy(a.candidates, filters);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const notes = a.origin === "crawl"
    ? ["Found " + plural(a.candidates.length, "link", "links") + (a.crawl ? " on " + plural(a.crawl.read, "page", "pages") : "") + ". Nothing is ticked yet: tick the ones to monitor. Historical and unrelated links are listed too, so you decide.", a.info || ""]
    : ["These are the links you selected while exploring. Untick any you don't want."];
  $("reviewNote").textContent = notes.concat(a.notes).filter(Boolean).join(" ");
  $("reviewNote").classList.toggle("is-warning", a.notes.length > 0);
  document.querySelectorAll("[data-review-show]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.reviewShow === a.show)));
  $("reviewFormat").value = a.format;
  if ($("reviewSearch").value !== a.query) $("reviewSearch").value = a.query;
  const list = $("reviewList");
  if (!a.candidates.length) {
    list.innerHTML = emptyState("No links yet", a.origin === "crawl" ? "Nothing was found. Go back and try another page or level." : "Go back and Shift-click the links you want.");
  } else if (!total) {
    list.innerHTML = emptyState("No links match", "Try a different search, or show all links.");
  } else {
    let shown = 0;
    let html = "";
    groups.forEach((group, index) => {
      if (shown >= a.limit) return;
      const rows = group.items.slice(0, a.limit - shown);
      const free = group.items.filter(item => !plan.monitored.has(item.key) && !plan.stopped.has(item.key));
      const all = free.length && free.every(item => a.picked.has(item.key));
      html += '<div class="link-group"><span class="link-group-name"><strong>' + esc(group.parentTitle || "Starting page") + "</strong>" +
        (group.section ? " · " + esc(group.section) : "") + " · " + group.items.length + "</span>" +
        (free.length ? '<button class="text-button" type="button" data-review-group="' + index + '">' + (all ? "Untick these" : "Tick these") + "</button>" : "") + "</div>" +
        rows.map(item => addPickRow(item, { monitored: plan.monitored.has(item.key), stopped: plan.stopped.has(item.key), locked: plan.monitored.has(item.key) || plan.stopped.has(item.key) })).join("");
      shown += rows.length;
    });
    if (shown < total) html += '<div class="link-more"><button class="btn" type="button" data-review-more>Show ' + Math.min(REVIEW_PAGE, total - shown) + " more · " + (total - shown).toLocaleString() + " not shown</button></div>";
    list.innerHTML = html;
  }
  state.add.groups = groups;
  renderReviewFoot(plan);
}
function renderReviewFoot(plan) {
  const a = state.add;
  const p = plan || addPlan();
  const batches = p.prepared.batches;
  const parts = ["<strong>" + p.summary.selected + "</strong> ticked"];
  if (p.summary.monitored) parts.push(p.summary.monitored + " already monitored, left out");
  if (p.leftStopped) parts.push(p.leftStopped + " stopped earlier, left out");
  parts.push("<strong>" + p.pending.length + "</strong> new " + (p.pending.length === 1 ? "monitor" : "monitors") +
    (batches.length ? " in " + plural(batches.length, "request", "requests") : ""));
  const tooLong = p.prepared.tooLong.length ? " " + esc(plural(p.prepared.tooLong.length, "address is", "addresses are")) + " too long for a GitHub request and left out." : "";
  const opened = batches.filter(batch => batch.every(row => a.opened[L.urlKey(row.url)])).length;
  $("reviewSummary").innerHTML = parts.join(" · ") + "." + tooLong +
    (opened ? " Submit each request on GitHub; the links are monitored once the owner workflow registers them." : "");
  const buttons = batches.map((batch, index) => {
    const isOpened = batch.every(row => a.opened[L.urlKey(row.url)]);
    const label = (isOpened ? "Open again " : "Open request ") + (batches.length > 1 ? (index + 1) + " of " + batches.length : "on GitHub");
    return '<button class="btn' + (isOpened ? "" : " btn-primary") + '" type="button" data-review-batch="' + index + '">' + esc(label) + "</button>";
  });
  if (!batches.length) buttons.push('<button class="btn btn-primary" type="button" disabled>' + (p.summary.selected ? "Nothing new to request" : "Tick links to continue") + "</button>");
  const weekly = a.origin === "crawl" && a.url
    ? '<label class="review-weekly" title="Scout re-reads this page every week and lists links it has not seen before, for you to review"><input type="checkbox" id="reviewWeekly"' + (a.weekly ? " checked" : "") + "> Also check weekly for new links</label>" +
      (a.weekly ? '<button class="btn" type="button" data-review-weekly>Open weekly-check request</button>' : "")
    : "";
  const done = opened && opened === batches.length ? '<button class="btn" type="button" data-review-done>Done</button>' : "";
  $("reviewRequests").innerHTML = weekly + buttons.join("") + done;
}
function reviewToggleRange(key) {
  const a = state.add;
  const rows = Array.from(document.querySelectorAll("#reviewList [data-link-row]")).map(row => row.dataset.linkRow);
  const from = rows.indexOf(a.anchor);
  const to = rows.indexOf(key);
  const want = !a.picked.has(key);
  const keys = from >= 0 && to >= 0 ? rows.slice(Math.min(from, to), Math.max(from, to) + 1) : [key];
  const plan = addPlan();
  keys.forEach(rowKey => {
    if (plan.monitored.has(rowKey) || plan.stopped.has(rowKey)) return;
    const item = a.candidates.find(candidate => candidate.key === rowKey);
    if (!item) return;
    if (want) a.picked.set(rowKey, item); else a.picked.delete(rowKey);
  });
  a.anchor = key;
}
function reviewOpenBatch(index) {
  const a = state.add;
  const plan = addPlan();
  const batch = plan.prepared.batches[index];
  if (!batch) return renderReviewFoot(plan);
  const target = makeBulkGitHubIssueUrl(batch);
  if (target.length > MAX_BULK_REQUEST_URL_LENGTH) { showToast("This request is too long for GitHub; nothing was opened."); return; }
  const now = new Date().toISOString();
  batch.forEach(row => { a.opened[L.urlKey(row.url)] = now; });
  addSaveDraft();
  renderReviewFoot();
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) {
    try { githubWindow.opener = null; } catch (_) {}
    showToast("Request " + (index + 1) + " of " + plan.prepared.batches.length + " opened on GitHub. Submit it there; nothing is registered until you do.");
  } else {
    showToast("Your browser blocked the new tab. Allow pop-ups for this dashboard and press the button again.");
  }
}
function reviewOpenWeekly() {
  const a = state.add;
  const hosts = new Set();
  let start = "";
  try { start = new URL(a.url).hostname; } catch (_) {}
  a.candidates.forEach(item => {
    try { const host = new URL(item.url).hostname; if (host !== start && item.format !== "Web page") hosts.add(host); } catch (_) {}
  });
  const request = L.pickDiscoveryRequest({ url: a.url, depth: a.crawl ? a.crawl.level : 2, explore: a.scope || "", documentHosts: Array.from(hosts).slice(0, 10) });
  const params = new URLSearchParams();
  params.set("title", request.title);
  params.set("body", request.body);
  const githubWindow = window.open(REPO + "/issues/new?" + params.toString(), "_blank");
  if (githubWindow) { try { githubWindow.opener = null; } catch (_) {} }
  showToast("Submit the weekly-check request on GitHub. New links Scout finds will appear in Scout for review; none is monitored automatically.");
}

/* ---------- Monitor only this exact address ---------- */

function submitExactAddress() {
  const parsed = readAddUrl();
  if (!parsed) return;
  const name = $("newMonitorName").value.replace(/[\r\n]+/g, " ").trim().slice(0, 100);
  const includeSelector = $("newMonitorIncludeSelector").value.replace(/[\r\n]+/g, " ").trim();
  const ignoreSelectors = $("newMonitorIgnoreSelectors").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (includeSelector.length > 500 || ignoreSelectors.length > 20 || ignoreSelectors.some(selector => selector.length > 500)) {
    showToast("Use one selector of up to 500 characters to compare, and up to 20 selectors to ignore.");
    return;
  }
  const target = makeGitHubIssueUrl(parsed.toString(), name, includeSelector, ignoreSelectors, 0, false);
  ["newMonitorName", "newMonitorIncludeSelector", "newMonitorIgnoreSelectors"].forEach(id => { $(id).value = ""; });
  $("newMonitorMetadataStatus").textContent = "";
  openGitHubRequest(target, "Submit the prefilled request on GitHub. The page is scanned once the request is accepted.");
}

function makeGitHubIssueUrl(url, name, includeSelector, ignoreSelectors, crawlDepth, scoutEnabled) {
  const bodyLines = [
    "<!-- changesentinel:add-monitor:v1 -->", "",
    "Please register this URL as a ChangeSentinel monitor.", "",
    "URL: " + url, "Name: " + (name || ""), "Crawl depth: " + String(Number.isInteger(Number(crawlDepth)) ? Math.max(0, Math.min(3, Number(crawlDepth))) : 0), "Scout discovery: " + (scoutEnabled ? "yes" : "no"), "Include selector: " + (includeSelector || ""), "Ignore selectors:"
  ];
  if (ignoreSelectors.length) ignoreSelectors.forEach(selector => bodyLines.push("- " + selector));
  else bodyLines.push("(none)");
  bodyLines.push("", "This request was created from the ChangeSentinel dashboard.");
  const params = new URLSearchParams();
  params.set("title", "[ChangeSentinel] Add monitor request");
  params.set("body", bodyLines.join("\n"));
  return REPO + "/issues/new?" + params.toString();
}
async function suggestMonitorMetadata() {
  const rawUrl = $("newMonitorUrl").value.trim();
  const status = $("newMonitorMetadataStatus");
  let parsed;
  try { parsed = new URL(rawUrl); } catch (_) { status.textContent = "Enter a full URL first."; return; }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) { status.textContent = "Use a public http:// or https:// URL."; return; }
  status.textContent = "Reading page metadata…";
  const button = $("autofillMonitorMetadata"); button.disabled = true;
  const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 6000);
  try {
    let title = "";
    try {
      const response = await fetch(parsed.toString(), { mode: "cors", credentials: "omit", redirect: "follow", signal: controller.signal, headers: { Accept: "text/html" } });
      if (response.ok && /html/i.test(response.headers.get("content-type") || "text/html")) {
        const html = await response.text();
        if (html.length <= 1024 * 1024) {
          const doc = new DOMParser().parseFromString(html, "text/html");
          const meta = selector => { const el = doc.querySelector(selector); return el ? String(el.getAttribute("content") || "").trim() : ""; };
          title = meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || (doc.title || "").trim();
        }
      }
    } catch (_) { /* CORS is commonly disabled; use an editable path-derived fallback. */ }
    if (title) {
      $("newMonitorName").value = title.replace(/[\r\n]+/g, " ").trim().slice(0, 100);
      status.textContent = "Name filled from page metadata. You can edit it.";
    } else {
      const nameInput = $("newMonitorName");
      if (!nameInput.value.trim()) {
        // Keep the field blank so registration performs its server-side metadata
        // lookup. Filling a URL slug here would make the backend treat it as a
        // user-supplied name and skip that more reliable lookup.
        nameInput.value = "";
        status.textContent = "Browser metadata is blocked on this site. Leave the name blank and registration will try the page title server-side; if unavailable, it will use the URL as a fallback.";
      } else {
        status.textContent = "Browser metadata is blocked on this site. Your existing display name was left unchanged.";
      }
    }
  } finally { window.clearTimeout(timeout); button.disabled = false; }
}
function openGitHubRequest(target, toastMessage) {
  const addDialog = $("addMonitorDialog");
  if (addDialog && addDialog.open) addDialog.close();
  showToast(toastMessage);
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) {
    try { githubWindow.opener = null; } catch (_) {}
  } else {
    window.location.href = target;
  }
}
function openDeleteMonitorRequest(target) {
  // Passing "noopener" to window.open makes browsers return null even when the
  // tab opened. Clear opener after opening so popup-block detection stays reliable.
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) {
    try { githubWindow.opener = null; } catch (_) {}
    showToast("GitHub opened in a new tab. Review the prefilled request and click Submit new issue; monitoring stops after the request is processed.");
  } else {
    showToast("Your browser blocked the new tab. Opening the request here.");
    window.location.href = target;
  }
}
function makeGitHubDeleteIssueUrl(sourceId, url, name) {
  const body = ["<!-- changesentinel:delete-monitor:v1 -->", "", "Please stop monitoring this URL in ChangeSentinel.", "", "Source ID: " + sourceId, "URL: " + url, "Name: " + (name || ""), "", "This request was created from the ChangeSentinel dashboard."];
  const params = new URLSearchParams(); params.set("title", "[ChangeSentinel] Delete monitor request"); params.set("body", body.join("\n"));
  return REPO + "/issues/new?" + params.toString();
}
function submitDeleteMonitor() {
  const pending = state.pendingDelete;
  const dialog = $("deleteMonitorDialog");
  if (!pending || !pending.sourceId || !pending.url) {
    if (dialog && dialog.open) dialog.close();
    showToast("Could not prepare the stop-monitor request. Refresh the dashboard and try again.");
    return;
  }
  if (dialog && dialog.open) dialog.close();
  openDeleteMonitorRequest(makeGitHubDeleteIssueUrl(pending.sourceId, pending.url, pending.name));
}
/* CSV and XLSX are both parsed locally (XLSX by the small reader in dashboard-lib.js),
   so no third-party script ever runs in the dashboard's origin for an upload. */
function parseCsvMatrix(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function bulkHeaderKey(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}
function bulkRowsFromMatrix(matrix) {
  const empty = row => !row || row.every(cell => !String(cell == null ? "" : cell).trim());
  const rows = (matrix || []).map(row => Array.isArray(row) ? row.map(value => String(value == null ? "" : value).trim()) : []).filter(row => !empty(row));
  if (!rows.length) throw new Error("The spreadsheet has no link rows.");
  const aliases = {
    url: ["url", "urls", "link", "links", "website", "website url", "webpage", "web page", "page url", "address"],
    name: ["name", "display name", "title", "monitor name", "label"],
    include_selector: ["include selector", "include css selector", "selector", "css selector"],
    ignore_selectors: ["ignore selectors", "ignore css selectors"]
  };
  const first = rows[0].map(bulkHeaderKey);
  const urlColumn = first.findIndex(value => aliases.url.includes(value));
  const hasHeader = urlColumn >= 0;
  const columns = {};
  if (hasHeader) {
    for (const key of Object.keys(aliases)) columns[key] = first.findIndex(value => aliases[key].includes(value));
    rows.shift();
  } else {
    columns.url = 0;
    columns.name = 1;
    columns.include_selector = 2;
    columns.ignore_selectors = 3;
  }
  const parsed = [];
  const errors = [];
  const seen = new Map();
  rows.forEach((row, index) => {
    const rowNumber = index + (hasHeader ? 2 : 1);
    const cell = column => column >= 0 && column < row.length ? row[column] : "";
    const rawUrl = cell(columns.url);
    if (!rawUrl) {
      if (!empty(row)) errors.push("Row " + rowNumber + ": missing URL.");
      return;
    }
    let url;
    try {
      const candidate = new URL(rawUrl);
      if (!["http:", "https:"].includes(candidate.protocol) || !candidate.hostname || candidate.username || candidate.password) throw new Error();
      // The engine's canonical form, so duplicates differing only in tracking
      // parameters or query order collapse to one request row.
      url = L.canonicalUrl(candidate.toString());
    } catch (_) {
      errors.push("Row " + rowNumber + ": enter a complete public http:// or https:// URL.");
      return;
    }
    const name = cell(columns.name).replace(/[\r\n]+/g, " ").trim().slice(0, 100);
    const includeSelector = cell(columns.include_selector).trim();
    const rawIgnore = cell(columns.ignore_selectors);
    const ignoreSelectors = rawIgnore ? rawIgnore.split(/[;\r\n]+/).map(value => value.trim()).filter(Boolean) : [];
    if (includeSelector.length > 500) errors.push("Row " + rowNumber + ": include selector exceeds 500 characters.");
    if (ignoreSelectors.length > 20 || ignoreSelectors.some(value => value.length > 500)) errors.push("Row " + rowNumber + ": use at most 20 ignore selectors, each at most 500 characters.");
    const previous = seen.get(url);
    if (previous) {
      if (previous.include_selector !== includeSelector || previous.ignore_selectors.join("\n") !== ignoreSelectors.join("\n")) {
        errors.push("Row " + rowNumber + ": duplicate URL has different selectors from an earlier row.");
      }
      return;
    }
    const item = { url, name, include_selector: includeSelector, ignore_selectors: ignoreSelectors };
    seen.set(url, item);
    parsed.push(item);
  });
  if (!parsed.length && !errors.length) errors.push("No valid URLs were found. Add a URL column or place one URL in the first column.");
  if (parsed.length > MAX_BULK_LINKS) errors.push("This request supports up to " + MAX_BULK_LINKS + " unique links. Split this file into smaller batches.");
  return { rows: parsed, errors, rowCount: rows.length, duplicateCount: Math.max(0, rows.length - parsed.length - errors.length) };
}
function setBulkStatus(message, isError) {
  const status = $("bulkImportStatus");
  status.textContent = message;
  status.classList.toggle("is-error", !!isError);
}
function renderBulkPreview() {
  const preview = $("bulkImportPreview");
  const actions = $("bulkImportActions");
  preview.replaceChildren();
  if (!bulkImportRows.length) {
    preview.hidden = true;
    actions.hidden = true;
    $("submitBulkMonitor").disabled = true;
    return;
  }
  preview.hidden = false;
  actions.hidden = false;
  bulkImportRows.slice(0, 5).forEach(item => {
    const line = document.createElement("div");
    line.className = "bulk-preview-row";
    const name = document.createElement("span");
    name.className = "bulk-preview-name";
    name.textContent = item.name || item.url;
    const url = document.createElement("span");
    url.className = "bulk-preview-url";
    try { url.textContent = new URL(item.url).hostname; } catch (_) { url.textContent = item.url; }
    line.append(name, url);
    preview.appendChild(line);
  });
  if (bulkImportRows.length > 5) {
    const more = document.createElement("div");
    more.className = "field-help";
    more.textContent = "+ " + (bulkImportRows.length - 5) + " more links";
    preview.appendChild(more);
  }
  $("submitBulkMonitor").disabled = !!bulkImportErrors.length;
}
async function readBulkFile(file) {
  bulkImportRows = [];
  bulkImportErrors = [];
  renderBulkPreview();
  if (!file) {
    setBulkStatus("Accepted columns: URL (required), Name, Include Selector, Ignore Selectors.", false);
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    bulkImportErrors = ["File exceeds the 5 MB limit."];
    setBulkStatus("This file is too large. Choose a file smaller than 5 MB.", true);
    renderBulkPreview();
    return;
  }
  const extension = file.name.toLowerCase().split(".").pop();
  try {
    let matrix;
    if (extension === "csv") {
      matrix = parseCsvMatrix(await file.text());
    } else if (extension === "xlsx") {
      matrix = await L.xlsxFirstSheetRows(await file.arrayBuffer());
    } else {
      throw new Error("Choose a .csv or .xlsx file.");
    }
    const result = bulkRowsFromMatrix(matrix);
    bulkImportRows = result.rows;
    bulkImportErrors = result.errors;
    if (bulkImportErrors.length) {
      setBulkStatus("Found " + bulkImportErrors.length + " issue(s): " + bulkImportErrors.slice(0, 3).join(" ") + (bulkImportErrors.length > 3 ? " …" : ""), true);
    } else {
      setBulkStatus("Ready to import " + bulkImportRows.length + " unique links" + (result.duplicateCount ? " (" + result.duplicateCount + " duplicate row(s) removed)" : "") + ". " + (extension === "xlsx" ? "Reading the first worksheet." : "CSV parsed locally."), false);
    }
  } catch (error) {
    bulkImportRows = [];
    bulkImportErrors = [String(error && error.message || error)];
    setBulkStatus(bulkImportErrors[0], true);
  }
  renderBulkPreview();
  if (!bulkImportErrors.length && bulkImportRows.length) {
    const target = makeBulkGitHubIssueUrl(bulkImportRows);
    if (target.length > MAX_BULK_REQUEST_URL_LENGTH) {
      bulkImportErrors.push("The prefilled GitHub request is too long. Split the spreadsheet into smaller batches.");
      setBulkStatus(bulkImportErrors[0], true);
      $("submitBulkMonitor").disabled = true;
    } else {
      $("submitBulkMonitor").textContent = "Continue with " + bulkImportRows.length + (bulkImportRows.length === 1 ? " link" : " links");
    }
  }
}
function makeBulkGitHubIssueUrl(rows) {
  const bodyLines = [
    BULK_REQUEST_MARKER, "",
    "Please register the URLs listed below as ChangeSentinel monitors.", "",
    "BULK_DATA_JSON:",
    JSON.stringify(rows),
    "",
    "This request was created from the ChangeSentinel dashboard bulk upload."
  ];
  const params = new URLSearchParams();
  params.set("title", "[ChangeSentinel] Add monitor bulk request");
  params.set("body", bodyLines.join("\n"));
  return REPO + "/issues/new?" + params.toString();
}
function submitBulkMonitor() {
  if (!bulkImportRows.length || bulkImportErrors.length) return;
  const target = makeBulkGitHubIssueUrl(bulkImportRows);
  if (target.length > MAX_BULK_REQUEST_URL_LENGTH) {
    setBulkStatus("The prefilled GitHub request is too long. Split the spreadsheet into smaller batches.", true);
    return;
  }
  openGitHubRequest(target, "Submit the prefilled bulk request on GitHub. The owner-only workflow will validate the links, register the sources and queue their first scans.");
}
function clearBulkImport() {
  $("bulkMonitorFile").value = "";
  bulkImportRows = [];
  bulkImportErrors = [];
  renderBulkPreview();
  setBulkStatus("Accepted columns: URL (required), Name, Include Selector, Ignore Selectors.", false);
}
/* ================= Review decisions, exports, saved-copy integrity ================= */

function changeById(eventId) { return changeLogEntries().find(entry => entry.event_id === eventId) || null; }
const REVIEW_HELP = {
  material: "It changes what you must do. Name an owner or ticket if there is work to track.",
  action_required: "Material, with work to do. An owner or a ticket link keeps it traceable.",
  not_material: "It doesn't affect you. A rationale of at least 10 characters is required.",
  acknowledged: "Seen; the assessment is still pending. Record the final decision later."
};
function syncReviewForm() {
  const choice = document.querySelector('input[name="reviewDecision"]:checked');
  const decision = choice ? choice.value : "";
  $("reviewDecisionHelp").textContent = REVIEW_HELP[decision] || "Choose the decision that fits. A later decision never erases this one.";
  $("reviewRationaleNote").textContent = decision === "not_material" ? "Required" : "Optional";
}
function openReview(eventId) {
  const entry = changeById(eventId);
  const dialog = $("reviewDialog");
  if (!entry || typeof dialog.showModal !== "function") {
    showToast(entry ? "This browser can't open the review dialog. Use a current browser." : "That change is no longer in the record.");
    return;
  }
  state.reviewTarget = eventId;
  const current = reviewFor(eventId);
  $("reviewLede").textContent = eventTitle(entry) + " \u00b7 " + L.eventLabel(entry.event_type) + " " + fmt(entry.timestamp);
  document.querySelectorAll('input[name="reviewDecision"]').forEach(input => { input.checked = false; });
  ["reviewRationale", "reviewOwner", "reviewTicket"].forEach(id => { $(id).value = ""; });
  // A new decision starts from the current owner and ticket; the rationale is always new.
  if (current) {
    $("reviewOwner").value = current.owner || "";
    $("reviewTicket").value = current.ticket || "";
  }
  $("reviewStatus").hidden = true;
  syncReviewForm();
  dialog.showModal();
  window.setTimeout(() => { const first = document.querySelector('input[name="reviewDecision"]'); if (first) first.focus(); }, 30);
}
function submitReview(event) {
  event.preventDefault();
  const entry = changeById(state.reviewTarget);
  const choice = document.querySelector('input[name="reviewDecision"]:checked');
  const request = L.changeReviewRequest({
    decision: choice ? choice.value : "",
    rationale: $("reviewRationale").value, owner: $("reviewOwner").value, ticket: $("reviewTicket").value,
    changes: entry ? [{ event_id: entry.event_id, url: entry.url }] : []
  });
  if (request.errors.length) {
    $("reviewStatus").textContent = request.errors.join(" ");
    $("reviewStatus").hidden = false;
    return;
  }
  const params = new URLSearchParams();
  params.set("title", request.title);
  params.set("body", request.body);
  $("reviewDialog").close();
  showToast("Submit the prefilled request on GitHub. The decision shows here about a minute after it is recorded.");
  const githubWindow = window.open(REPO + "/issues/new?" + params.toString(), "_blank");
  if (githubWindow) {
    try { githubWindow.opener = null; } catch (_) {}
  } else {
    window.location.href = REPO + "/issues/new?" + params.toString();
  }
}

function downloadFile(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function changeDashboardLink(entry) { return location.origin + location.pathname + "#changes/" + encodeURIComponent(entry.event_id); }
// The list as filtered, one row per change, for a spreadsheet or an audit file.
function exportChanges() {
  const entries = filteredChanges();
  if (!entries.length) { showToast("Nothing to export: the list is empty."); return; }
  const rows = [["Detected (UTC)", "Event", "Page", "URL", "Source", "AI assessment", "AI topic", "Review decision", "Reviewed by", "Reviewed at (UTC)",
    "Rationale", "Owner", "Ticket", "Reporting items", "Dates", "Dashboard link", "Evidence file", "Event ID"]];
  entries.forEach(entry => {
    const item = itemForEvent(entry);
    const verdict = verdictFor(entry);
    const review = reviewFor(entry.event_id);
    const analysis = verdict.analysis || {};
    rows.push([
      entry.timestamp || "", L.eventLabel(entry.event_type), eventTitle(entry), entry.url || "", item ? sourceLabel(sourceForItem(item)) : "",
      verdict.state === "relevant" ? "Relevant" : verdict.state === "irrelevant" ? "Not relevant" : L.eventTone(entry.event_type) === "problem" ? "" : "Not reviewed",
      analysis.topic || "", review ? L.REVIEW_DECISIONS[review.decision] || review.label || "" : "", review ? review.reviewed_by || "" : "", review ? review.reviewed_at || "" : "",
      review ? review.rationale || "" : "", review ? review.owner || "" : "", review ? review.ticket || "" : "",
      L.describeItemCodes(entry.item_codes),
      L.datesForChange(state.calendar, entry.event_id).map(date => date.date + " " + (date.label || "")).join("; "),
      changeDashboardLink(entry), entry.evidence_location ? REPO + "/blob/main/" + entry.evidence_location : "", entry.event_id || ""
    ]);
  });
  const filter = state.changeFilter === "ALL" ? "all" : state.changeFilter.toLowerCase();
  downloadFile("changesentinel-changes-" + filter + "-" + L.localIsoDate() + ".csv", "text/csv;charset=utf-8", "\ufeff" + L.toCsv(rows));
  showToast("Exported " + plural(entries.length, "change", "changes") + ".");
}
// One change with everything recorded about it, in a single file someone else
// can check: the evidence, the assessment, dates, reporting items, decisions,
// and where each saved file and its fingerprint live.
async function downloadEvidencePack(eventId) {
  const entry = changeById(eventId);
  if (!entry) { showToast("That change is no longer in the record."); return; }
  let evidence = null;
  if (entry.evidence_location) {
    try { evidence = await loadEvidence(entry.evidence_location); } catch (error) {
      showToast("Couldn't load the evidence file: " + String(error.message || error));
      return;
    }
  }
  const item = itemForEvent(entry);
  const result = aiResultForEvent(entry);
  const codes = evidence && isPlainObject(evidence.item_codes) ? evidence.item_codes : entry.item_codes || null;
  const codeList = codes ? [].concat(...ITEM_GROUPS.map(([key]) => (Array.isArray(codes[key]) ? codes[key] : []).map(row => row.code))) : [];
  const files = [];
  const addFile = (role, path, sha256) => { if (path) files.push({ role, path, url: snapshotURL(path), history: REPO + "/commits/main/" + path, sha256: sha256 || null }); };
  if (evidence) {
    const before = evidence.before || {}, after = evidence.after || {};
    addFile("evidence", entry.evidence_location, null);
    addFile("text before", before.snapshot_location, before.normalized_hash);
    addFile("text after", after.snapshot_location, after.normalized_hash);
    addFile("html before", before.html_snapshot_location, before.html_hash);
    addFile("html after", after.html_snapshot_location, after.html_hash);
    addFile("file before", before.file_snapshot_location, before.raw_hash);
    addFile("file after", after.file_snapshot_location, after.raw_hash);
  }
  const pack = {
    format: "changesentinel-evidence-pack/1",
    exported_at: new Date().toISOString(),
    repository: REPO,
    dashboard_link: changeDashboardLink(entry),
    change: entry,
    page: item ? { title: itemTitle(item), url: item.canonical_url, url_id: item.url_id, source_id: item.source_id, source: sourceLabel(sourceForItem(item)) } : { url: entry.url },
    ai_assessment: result && result.ai ? result.ai : verdictFor(entry),
    review: { current: reviewFor(entry.event_id), history: reviewLog(entry.event_id) },
    dates: L.datesForChange(state.calendar, entry.event_id),
    reporting_items: codes,
    lineage: codeList.length ? codeList.map(code => ({ code, assets: L.lineageFor(code, state.lineage) })).filter(row => row.assets.length) : [],
    files,
    verification: "Each sha256 is the fingerprint recorded when the file was saved; the file name carries it too. Recompute it (for example `shasum -a 256 <file>`) to confirm the saved copy is unchanged, and use the history link for when it was committed.",
    evidence
  };
  const name = "changesentinel-evidence-" + L.fileSlug(eventTitle(entry), 40) + "-" + String(entry.timestamp || "").slice(0, 10) + "-" + String(entry.event_id).slice(0, 8) + ".json";
  downloadFile(name, "application/json", JSON.stringify(pack, null, 2) + "\n");
}

// Saved copies are content-addressed: each file's SHA-256 was recorded when it
// was written and is part of its name. Recomputing it here shows the copy being
// reviewed is byte-for-byte what was fingerprinted at scan time.
function integrityFiles(item) {
  const kind = itemKind(item);
  return [
    ["Extracted text", item.snapshot_location, item.normalized_hash],
    ["Saved HTML", item.html_snapshot_location, item.html_hash],
    [kind === "pdf" ? "Original PDF" : kind === "zip" ? "Original archive" : "Original file", item.file_snapshot_location, item.raw_hash]
  ].filter(([, path, hash]) => path && hash).map(([label, path, hash]) => ({ label, path, hash }));
}
function integrityState(file) {
  const result = state.integrity[file.path];
  if (!result) return '<span class="integrity-state">Not checked</span>';
  if (result.state === "checking") return '<span class="integrity-state">Checking…</span>';
  if (result.state === "ok") return '<span class="integrity-state"><span class="tag is-relevant">Matches</span></span>';
  if (result.state === "bad") return '<span class="integrity-state"><span class="tag tone-problem">Does not match</span></span>';
  return '<span class="integrity-state"><span class="tag is-warn">Couldn\'t check</span></span>';
}
function integritySheet(item) {
  const files = integrityFiles(item);
  if (!files.length) return "";
  return '<section class="sheet" aria-labelledby="integrity-title"><div class="sheet-head"><div><h3 class="sheet-title" id="integrity-title">Saved-copy integrity</h3>' +
    '<div class="sheet-note">Recompute each saved file\'s SHA-256 in this browser and compare it with the fingerprint recorded at scan time.</div></div>' +
    '<button class="btn" type="button" data-verify-fingerprints="' + esc(item.url_id) + '">Verify fingerprints</button></div>' +
    '<ul class="integrity-list" id="integrityList">' + integrityRows(files) + "</ul></section>";
}
function integrityRows(files) {
  return files.map(file => {
    const result = state.integrity[file.path] || {};
    return '<li class="integrity-row"><span class="integrity-name">' + esc(file.label) + "</span>" + integrityState(file) +
      '<span class="integrity-path">' + esc(file.path) + "</span>" +
      '<span class="integrity-detail"><span>Recorded ' + esc(file.hash.slice(0, 16)) + "…</span>" +
      (result.computed && result.state === "bad" ? "<span>Computed " + esc(result.computed.slice(0, 16)) + "…</span>" : "") +
      (result.state === "error" ? "<span>" + esc(result.message || "") + "</span>" : "") +
      externalLink(REPO + "/commits/main/" + file.path, "File history", "sheet-link") + "</span></li>";
  }).join("");
}
function hex(buffer) { return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join(""); }
async function verifyFingerprints(urlId) {
  const item = state.items.find(candidate => candidate.url_id === urlId);
  if (!item) return;
  const files = integrityFiles(item);
  const redraw = () => {
    const list = $("integrityList");
    if (list && selectedItem() && selectedItem().url_id === urlId && state.detailTab === "details") list.innerHTML = integrityRows(files);
  };
  if (!(window.crypto && crypto.subtle)) {
    files.forEach(file => { state.integrity[file.path] = { state: "error", message: "This browser can't compute SHA-256 on this page (it needs HTTPS)." }; });
    redraw();
    return;
  }
  files.forEach(file => { state.integrity[file.path] = { state: "checking" }; });
  redraw();
  await Promise.all(files.map(async file => {
    try {
      const response = await fetchImmutable(file.path);
      if (!response.ok) throw new Error("the saved file returned HTTP " + response.status);
      const computed = hex(await crypto.subtle.digest("SHA-256", await response.arrayBuffer()));
      state.integrity[file.path] = { state: computed === String(file.hash).toLowerCase() ? "ok" : "bad", computed };
    } catch (error) {
      state.integrity[file.path] = { state: "error", message: String(error.message || error) };
    }
    redraw();
  }));
}

/* ================= Events ================= */

document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
$("workspace").addEventListener("click", event => {
  const target = event.target.closest("[data-review-change],[data-evidence-pack],[data-export-changes],[data-copy-calendar],[data-verify-fingerprints],[data-select-change],[data-monitor-id],[data-select-run],[data-select-notification],[data-go],[data-open-page],[data-back],[data-diff-mode],[data-detail-tab],[data-snapshot-mode],[data-pdf-action],[data-refresh],[data-add-monitor],[data-change-filter],[data-filter],[data-scout-key],[data-scout-filter],[data-scout-coverage],[data-scout-monitor],[data-scout-dismiss],[data-scout-restore],[data-scout-run],[data-scout-add-source],[data-scout-add-channel],[data-scout-edit],[data-calendar-mode],[data-calendar-jump-date],[data-calendar-prev],[data-calendar-next],[data-calendar-today],[data-calendar-new],[data-calendar-export],[data-calendar-day],[data-calendar-edit],[data-calendar-delete],[data-calendar-complete],[data-calendar-open-change],[data-calendar-test],[data-calendar-signout]");
  if (!target) return;
  const data = target.dataset;
  if (data.calendarMode) { state.cadencePanel = data.calendarMode === "upcoming" ? "upcoming" : "month"; return renderCadenceView(); }
  if (data.calendarJumpDate) return jumpCadenceToDate(data.calendarJumpDate);
  if (data.calendarPrev !== undefined) return shiftCadenceMonth(-1);
  if (data.calendarNext !== undefined) return shiftCadenceMonth(1);
  if (data.calendarToday !== undefined) { state.cadenceMonth = new Date(); state.cadenceMonth.setDate(1); state.cadenceSelectedDate = L.localIsoDate(new Date()); return renderCadenceView(); }
  if (data.calendarNew !== undefined) return openCadenceEntry();
  if (data.calendarExport !== undefined) return exportCadenceCalendar();
  if (data.calendarDay) { state.cadenceSelectedDate = data.calendarDay; return renderCadenceView(); }
  if (data.calendarOpenChange) {
    const entry = changeLogEntries().find(item => item.event_id === data.calendarOpenChange);
    if (entry) return select("changes", entry.event_id);
    showToast("This automatic date is no longer linked to a current change."); return;
  }
  if (data.calendarEdit) return openCadenceEntry(data.calendarEdit);
  if (data.calendarDelete) return archiveCadenceEntry(data.calendarDelete);
  if (data.calendarComplete) return toggleCadenceOccurrence(data.calendarComplete, data.calendarDate, data.calendarDone === "true");
  if (data.calendarTest !== undefined) return sendCadenceTestEmail();
  if (data.calendarSignout !== undefined) return signOutCadence();
  if (data.reviewChange) return openReview(data.reviewChange);
  if (data.evidencePack) return downloadEvidencePack(data.evidencePack);
  if (data.exportChanges !== undefined) return exportChanges();
  if (data.copyCalendar !== undefined) return copyCalendarFeed();
  if (data.verifyFingerprints) return verifyFingerprints(data.verifyFingerprints);
  if (data.scoutKey) return select("scout", data.scoutKey);
  if (data.scoutCoverage !== undefined) return select("scout", "coverage");
  if (data.scoutAddSource !== undefined) return openScoutSource("add", "");
  if (data.scoutAddChannel) return openScoutSource("add", data.scoutAddChannel);
  if (data.scoutEdit) return openScoutSource("edit", data.scoutEdit);
  if (data.scoutFilter) {
    state.scoutFilter = data.scoutFilter;
    if (!isCompact()) {
      const first = scoutFiltered()[0];
      state.selectedScoutKey = first ? first.key : "coverage";
      renderScout();
      renderScoutDetail();
      resetDetailScroll("scout");
      writeHash();
    } else {
      renderScout();
    }
    return;
  }
  if (data.scoutMonitor || data.scoutDismiss || data.scoutRestore) {
    const key = data.scoutMonitor || data.scoutDismiss || data.scoutRestore;
    const item = scoutCandidates().find(candidate => candidate.key === key);
    if (!item) return;
    if (data.scoutMonitor) return openScoutMonitor(item);
    return openScoutDecision(data.scoutRestore ? "restore" : "dismiss", item);
  }
  if (data.scoutRun !== undefined) {
    window.open(SCOUT_WORKFLOW_URL, "_blank", "noopener");
    showToast("Opened the Scout workflow. Press \u201cRun workflow\u201d to sweep every regulator now.");
    return;
  }
  if (data.selectChange) return select("changes", data.selectChange);
  if (data.monitorId) return select("monitors", data.monitorId);
  if (data.selectRun) return select("runs", data.selectRun);
  if (data.selectNotification) return select("notifications", data.selectNotification);
  if (data.go) return setView(data.go);
  if (data.openPage) return select("monitors", data.openPage, { tab: "changes" });
  if (data.back !== undefined) { state.mobileDetail = false; renderViews(); return; }
  if (data.refresh !== undefined) return loadData(true);
  if (data.addMonitor !== undefined) return openAddMonitor();
  if (data.pdfAction) return setPdfViewerExpanded(data.pdfAction === "expand");
  if (data.diffMode) {
    state.diffMode = data.diffMode;
    if (state.view === "changes") renderChangeDetail();
    else if (state.view === "monitors") renderDetailBody();
    return;
  }
  if (data.detailTab) {
    state.detailTab = data.detailTab;
    renderDetailBody();
    return;
  }
  if (data.snapshotMode) {
    state.snapshotMode = data.snapshotMode;
    state.detailKeys.monitors = detailRenderKey("monitors");
    const item = selectedItem();
    if (item && state.detailTab === "snapshot") loadSnapshot(item);
    return;
  }
  if (data.changeFilter) {
    state.changeFilter = data.changeFilter;
    document.querySelectorAll("[data-change-filter]").forEach(button => button.setAttribute("aria-pressed", String(button === target)));
    renderChangeRoute();
    return;
  }
  if (data.filter) {
    state.filter = data.filter;
    document.querySelectorAll("[data-filter]").forEach(button => button.setAttribute("aria-pressed", String(button === target)));
    renderMonitorList();
  }
});
// LED tooltips: which page, which scan, what happened.
$("signalVisual").addEventListener("pointermove", event => {
  if (event.pointerType !== "mouse") return;
  showFieldTip(event.target.closest(".led"), event.clientX, event.clientY);
});
$("signalVisual").addEventListener("pointerleave", event => { if (event.pointerType === "mouse") showFieldTip(null); });
let fieldTipTimer = 0;
document.addEventListener("pointerdown", event => {
  clearTimeout(fieldTipTimer);
  if (event.pointerType === "mouse") return;
  const pendingCell = event.target.closest && event.target.closest(".led.s-pending");
  showFieldTip(pendingCell, event.clientX, event.clientY);
  if (pendingCell) fieldTipTimer = setTimeout(() => showFieldTip(null), 2600);
}, true);
document.addEventListener("scroll", () => { if (!$("fieldTip").hidden) showFieldTip(null); }, true);
// Redraw the field when its width changes enough to fit a different number of
// columns, and re-measure the painted lights whenever it moves or resizes.
if (typeof ResizeObserver === "function") {
  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.loaded || state.view !== "overview") return;
      if (fieldGeometry().key !== $("signalVisual").dataset.geometry) renderMonitoringSignal();
      else ledField.measure();
    }, 120);
  }).observe($("signalVisual"));
}
// Theme: every visit opens in light (index.html sets it before first paint, by
// design); the toggle switches theme for the rest of the visit.
function currentTheme() { return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"; }
function syncThemeLabels() {
  document.querySelectorAll("[data-theme-toggle]").forEach(button => {
    button.textContent = currentTheme() === "dark" ? "Light theme" : "Dark theme";
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", currentTheme() === "dark" ? "#0b0705" : "#e4e0da");
}
document.addEventListener("click", event => {
  if (!event.target.closest("[data-theme-toggle]")) return;
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("cs-theme", next); } catch (_) {}
  syncThemeLabels();
});
syncThemeLabels();
// Opening an older event in a page's history loads its redline on demand.
$("detailBody").addEventListener("toggle", event => {
  const details = event.target;
  const item = selectedItem();
  if (item && details.matches && details.matches(".history-item") && details.open) fillHistoryItem(item, details);
}, true);
// Arrow keys move through the list in the focused pane.
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.body.classList.contains("pdf-viewer-open")) {
    setPdfViewerExpanded(false);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const row = event.target.closest && event.target.closest(".list-body .row");
  if (!row) return;
  const rows = Array.from(row.closest(".list-pane").querySelectorAll(".row"));
  const next = rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.click();
  const again = document.querySelector('.view:not([hidden]) .row[aria-selected="true"]');
  (again || next).focus();
});
$("monitorSearch").addEventListener("input", renderMonitorList);
$("scoutSearch").addEventListener("input", renderScout);
$("scoutFormatFilter").addEventListener("change", () => {
  state.scoutFormatFilter = $("scoutFormatFilter").value || "ALL";
  renderScout();
});
$("cadenceSearch").addEventListener("input", () => { state.cadenceSearch = $("cadenceSearch").value; renderCadenceView(); });
$("cadenceTypeFilter").addEventListener("change", () => { state.cadenceFilter = $("cadenceTypeFilter").value; renderCadenceView(); });
$("cadenceSignInForm").addEventListener("submit", signInCadence);
$("cadenceForgotPassword").addEventListener("click", requestCadencePasswordReset);
$("cadenceRecoveryForm").addEventListener("submit", updateCadencePassword);
$("cadenceRecoveryCancel").addEventListener("click", () => signOutCadence());
$("cadenceEntryForm").addEventListener("submit", saveCadenceEntry);
document.querySelectorAll("[data-calendar-close]").forEach(button => button.addEventListener("click", () => $("cadenceEntryDialog").close()));
$("cadenceEntryDialog").addEventListener("click", event => { if (event.target === $("cadenceEntryDialog")) $("cadenceEntryDialog").close(); });
$("cadenceReminderEnabled").addEventListener("change", () => { const enabled = $("cadenceReminderEnabled").checked; $("cadenceReminderDays").disabled = !enabled; $("cadenceReminderEmails").disabled = !enabled; });
$("scoutSourceForm").addEventListener("submit", submitScoutSource);
$("scoutSourceForm").addEventListener("change", syncScoutSourceForm);
$("closeScoutSource").addEventListener("click", () => $("scoutSourceDialog").close());
$("cancelScoutSource").addEventListener("click", () => $("scoutSourceDialog").close());
$("scoutSourceDialog").addEventListener("click", event => { if (event.target === $("scoutSourceDialog")) $("scoutSourceDialog").close(); });
// A new regulator's id follows its short name (or name) until it is typed by hand.
["scoutSourceName", "scoutSourceShortName"].forEach(id => $(id).addEventListener("input", () => {
  if ($("scoutSourceRegulator").value !== "__new" || $("scoutSourceId").dataset.edited === "true") return;
  $("scoutSourceId").value = L.scoutSlug($("scoutSourceShortName").value || $("scoutSourceName").value);
}));
$("scoutSourceId").addEventListener("input", () => { $("scoutSourceId").dataset.edited = "true"; });
$("refreshBtn").addEventListener("click", () => loadData(true));
$("addMonitorBtn").addEventListener("click", () => openAddMonitor());
// The rail sits outside #workspace, so its "Add link" button needs its own listener.
document.querySelectorAll(".rail [data-add-monitor]").forEach(button => button.addEventListener("click", () => openAddMonitor()));
$("closeAddMonitor").addEventListener("click", () => $("addMonitorDialog").close());
$("cancelAddMonitor").addEventListener("click", () => $("addMonitorDialog").close());
// Only the first step closes on a backdrop click; the larger steps hold work in progress.
$("addMonitorDialog").addEventListener("click", event => {
  if (event.target === $("addMonitorDialog") && state.add.step === "start") $("addMonitorDialog").close();
});
$("addMonitorDialog").addEventListener("close", () => {
  if (state.add.crawl && state.add.crawl.running) state.add.crawl.stop = true;
  state.add.loading += 1;
  addSaveDraft();
});
$("newMonitorUrl").addEventListener("input", () => {
  $("newMonitorUrl").setCustomValidity("");
  $("newMonitorMetadataStatus").textContent = "";
  if (state.add.method === "crawl") syncAddScope();
});
$("addMonitorForm").addEventListener("change", event => { if (event.target.name === "addMethod") syncAddMethod(); });
$("addMonitorForm").addEventListener("submit", startAddLink);
$("addExactSubmit").addEventListener("click", submitExactAddress);
$("autofillMonitorMetadata").addEventListener("click", suggestMonitorMetadata);
$("addResume").addEventListener("click", event => {
  if (event.target.closest("[data-add-discard]")) { addClearDraft(); $("newMonitorUrl").value = ""; renderAddStart(); return; }
  if (!event.target.closest("[data-add-resume]")) return;
  const a = state.add;
  $("newMonitorUrl").value = a.url;
  if (a.origin === "explore" && !a.candidates.length) return;
  addGoto("review");
});
$("exploreFrame").addEventListener("load", exploreWire);
document.querySelector(".add-explore").addEventListener("click", event => {
  const a = state.add;
  if (event.target.closest("[data-explore-back]") && a.at > 0) { a.at -= 1; return exploreOpen(a.history[a.at], false); }
  if (event.target.closest("[data-explore-forward]") && a.at < a.history.length - 1) { a.at += 1; return exploreOpen(a.history[a.at], false); }
  if (event.target.closest("[data-explore-this]") && a.page) {
    const previous = a.at > 0 ? a.pages.get(L.urlKey(a.history[a.at - 1])) : null;
    return addToggle(addItem({ url: a.page.url, title: a.page.title, parentUrl: previous ? previous.url : "", parentTitle: previous ? previous.title : "" }));
  }
  const retry = event.target.closest("[data-explore-retry]");
  if (retry) { a.pages.delete(L.urlKey(retry.dataset.exploreRetry)); return exploreOpen(retry.dataset.exploreRetry, !a.page || a.history[a.at] !== retry.dataset.exploreRetry); }
  const tab = event.target.closest("[data-explore-tab]");
  if (tab) { a.tab = tab.dataset.exploreTab === "page" ? "page" : "selected"; return renderExploreSide(); }
  const go = event.target.closest("[data-explore-go]");
  if (go) return exploreOpen(go.dataset.exploreGo, true);
  const toggle = event.target.closest("input[data-link-toggle]");
  const main = event.target.closest("[data-link-main]");
  if (toggle || main) {
    const key = toggle ? toggle.dataset.linkToggle : main.dataset.linkMain;
    const item = a.candidates.find(candidate => candidate.key === key) ||
      (a.page ? a.page.links.map(link => addLinkItem(link, a.page, null)).find(candidate => candidate && candidate.key === key) : null);
    if (item) addToggle(item, toggle ? toggle.checked : undefined);
    return;
  }
  const goto = event.target.closest("[data-add-goto]");
  if (goto) addGoto(goto.dataset.addGoto);
});
$("exploreSelectMode").addEventListener("change", () => {
  state.add.selectMode = $("exploreSelectMode").checked;
  try { $("exploreFrame").contentDocument.documentElement.classList.toggle("cs-select", state.add.selectMode); } catch (_) {}
  renderExploreSide();
});
document.addEventListener("keydown", event => { if (event.key === "Shift" && state.add.step === "explore") exploreShift(true); });
document.addEventListener("keyup", event => { if (event.key === "Shift") exploreShift(false); });
window.addEventListener("blur", () => exploreShift(false));
$("crawlStop").addEventListener("click", () => { if (state.add.crawl) state.add.crawl.stop = true; $("crawlStop").disabled = true; });
$("crawlReview").addEventListener("click", () => addGoto("review"));
document.querySelector(".add-review").addEventListener("click", event => {
  const a = state.add;
  const toggle = event.target.closest("input[data-link-toggle]");
  const main = event.target.closest("[data-link-main]");
  if (toggle || main) {
    const key = toggle ? toggle.dataset.linkToggle : main.dataset.linkMain;
    if (toggle && toggle.disabled) return;
    if (event.shiftKey && a.anchor) { event.preventDefault(); reviewToggleRange(key); }
    else {
      const item = a.candidates.find(candidate => candidate.key === key);
      const plan = addPlan();
      if (!item || plan.monitored.has(key) || plan.stopped.has(key)) return;
      const on = toggle ? toggle.checked : !a.picked.has(key);
      if (on) a.picked.set(key, item); else a.picked.delete(key);
      a.anchor = key;
    }
    addSaveDraft();
    renderReview();
    window.requestAnimationFrame(() => { const input = document.querySelector('#reviewList input[data-link-toggle="' + CSS.escape(key) + '"]'); if (input) input.focus({ preventScroll: true }); });
    return;
  }
  const group = event.target.closest("[data-review-group]");
  if (group) {
    const target = (a.groups || [])[Number(group.dataset.reviewGroup)];
    if (!target) return;
    const plan = addPlan();
    const free = target.items.filter(item => !plan.monitored.has(item.key) && !plan.stopped.has(item.key));
    const all = free.every(item => a.picked.has(item.key));
    free.forEach(item => { if (all) a.picked.delete(item.key); else a.picked.set(item.key, item); });
    addSaveDraft();
    return renderReview();
  }
  if (event.target.closest("[data-review-more]")) { a.limit += REVIEW_PAGE; return renderReview(); }
  const show = event.target.closest("[data-review-show]");
  if (show) { a.show = show.dataset.reviewShow === "SELECTED" ? "SELECTED" : "ALL"; a.limit = REVIEW_PAGE; return renderReview(); }
  const batch = event.target.closest("[data-review-batch]");
  if (batch) return reviewOpenBatch(Number(batch.dataset.reviewBatch));
  if (event.target.closest("[data-review-weekly]")) return reviewOpenWeekly();
  if (event.target.closest("[data-review-done]")) { addClearDraft(); $("newMonitorUrl").value = ""; $("addMonitorDialog").close(); return; }
});
document.querySelector(".add-review").addEventListener("change", event => {
  if (event.target.id === "reviewWeekly") { state.add.weekly = event.target.checked; renderReviewFoot(); }
});
document.querySelector(".add-review").addEventListener("mousedown", event => { if (event.shiftKey && event.target.closest(".link-pick")) event.preventDefault(); });
$("reviewSearch").addEventListener("input", () => { state.add.query = $("reviewSearch").value; state.add.limit = REVIEW_PAGE; renderReview(); });
$("reviewFormat").addEventListener("change", () => { state.add.format = $("reviewFormat").value; state.add.limit = REVIEW_PAGE; renderReview(); });
$("reviewBack").addEventListener("click", () => {
  const a = state.add;
  if (a.origin === "explore" && a.page) addGoto("explore");
  else addGoto("start");
});
$("closeDeleteMonitor").addEventListener("click", () => $("deleteMonitorDialog").close());
$("cancelDeleteMonitor").addEventListener("click", () => $("deleteMonitorDialog").close());
$("deleteMonitorDialog").addEventListener("click", event => { if (event.target === $("deleteMonitorDialog")) $("deleteMonitorDialog").close(); });
$("confirmDeleteMonitor").addEventListener("click", submitDeleteMonitor);
document.addEventListener("click", event => {
  const button = event.target.closest && event.target.closest("[data-stop-monitor]");
  if (!button) return;
  // Prefer the latest inventory entry, but retain the exact rendered context as
  // a fallback when a report/detail record is not present in the live inventory.
  const item = (state.items || []).find(row => row.url_id === button.dataset.stopMonitor);
  const url = (item && item.canonical_url) || button.dataset.stopUrl || "";
  const sourceId = (item && item.source_id) || button.dataset.stopSource || "";
  const name = item ? itemTitle(item) : (button.dataset.stopName || url);
  if (!url || !sourceId) {
    showToast("Could not identify this monitor. Refresh the dashboard and try again.");
    return;
  }
  const source = item ? sourceForItem(item) : {};
  const normalize = value => { try { const u = new URL(value); u.hash = ""; return u.toString().replace(/\/$/, ""); } catch (_) { return String(value || ""); } };
  state.pendingDelete = {
    url, sourceId, name,
    root: (source.seed_urls || []).some(seed => normalize(seed) === normalize(url))
  };
  $("deleteMonitorHeading").textContent = state.pendingDelete.root ? "Stop this monitor?" : "Stop monitoring this page?";
  $("deleteMonitorExplanation").textContent = state.pendingDelete.root ? "Stopping this root also stops pages discovered beneath it." : "This page will be excluded from future scans; the rest of the monitor continues.";
  $("deleteMonitorTarget").textContent = state.pendingDelete.name + " — " + state.pendingDelete.url;
  const dialog = $("deleteMonitorDialog");
  if (!dialog || typeof dialog.showModal !== "function") {
    openDeleteMonitorRequest(makeGitHubDeleteIssueUrl(sourceId, url, name));
    return;
  }
  try {
    dialog.showModal();
  } catch (_) {
    // A dialog state issue must not leave the Stop Monitoring control inert.
    openDeleteMonitorRequest(makeGitHubDeleteIssueUrl(sourceId, url, name));
  }
});

$("reviewForm").addEventListener("submit", submitReview);
$("reviewForm").addEventListener("change", event => { if (event.target.name === "reviewDecision") syncReviewForm(); });
$("closeReview").addEventListener("click", () => $("reviewDialog").close());
$("cancelReview").addEventListener("click", () => $("reviewDialog").close());
$("reviewDialog").addEventListener("click", event => {
  if (event.target === $("reviewDialog")) $("reviewDialog").close();
});
$("bulkMonitorFile").addEventListener("change", event => readBulkFile(event.target.files && event.target.files[0]));
$("submitBulkMonitor").addEventListener("click", submitBulkMonitor);
$("clearBulkImport").addEventListener("click", clearBulkImport);
if (compactQuery && typeof compactQuery.addEventListener === "function") {
  compactQuery.addEventListener("change", () => { if (state.loaded) setView(state.view, { detail: state.mobileDetail }); });
}



/* ================= Manual scans =================
 * Scans run on GitHub Actions. The dashboard is a static page with no write access,
 * so "Scan now" opens the Regulatory Monitor workflow, where the owner presses
 * "Run workflow"; the source to scan is copied for the source_id field.
 */
const MONITOR_WORKFLOW_URL = REPO + "/actions/workflows/regulatory-monitor.yml";
document.addEventListener("click", event => {
  const button = event.target.closest("[data-run-scan]");
  if (!button) return;
  const sourceId = button.dataset.runScan || "all";
  window.open(MONITOR_WORKFLOW_URL, "_blank", "noopener");
  // Look for the new run soon after the reviewer starts it on GitHub.
  [30000, 75000].forEach(delay => setTimeout(refreshWorkflowRuns, delay));
  const copy = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(sourceId).catch(() => {}) : Promise.resolve();
  copy.then(() => showToast(sourceId === "all"
    ? "Opened the Regulatory Monitor workflow. Press “Run workflow” to scan every active source."
    : "Opened the Regulatory Monitor workflow. Press “Run workflow” and paste “" + sourceId + "” (copied) as source_id."));
});

/* ================= Before / after comparison =================
 * Visualping-style overlay of the previous and new saved versions with a draggable
 * divider. Everything renders in the browser from files already committed: PDFs via
 * pdf.js (with a pixel-difference highlight), HTML in script-less sandboxed frames,
 * and older events without saved originals as their two text snapshots.
 */
// pdf.js renders saved PDFs inside the dashboard's own origin, so it is pinned
// to a patched release (the 3.x line allowed script execution from a crafted
// font, CVE-2024-4367) and both files are checked against their published
// SHA-384 (jsDelivr serves the npm release byte for byte). The worker is fetched
// with the same check and started from a local blob, so no unverified code runs.
const PDFJS_VERSION = "6.4.299";
const PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@" + PDFJS_VERSION + "/legacy/build/";
const PDFJS_INTEGRITY = {
  lib: "sha384-oPqHr8MeYfJpkh4zgHbWYiuwabTzthRiOS5tSWsWGmCVWlwqIkS9coGro5aa48OF",
  worker: "sha384-tINN5IYq7dFaoHBUBBc2yfxGwR38mZn9GhaX31UofKYNgAg/3y8A7IjUI3GuEg/8"
};
const COMPARE_PAGE_LIMIT = 400;
let pdfjsPromise = null;
let compareSerial = 0;
let activeCompare = { docs: [], observer: null };

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await new Promise((resolve, reject) => {
        if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
        const script = document.createElement("script");
        script.type = "module";
        script.src = PDFJS_BASE + "pdf.min.mjs";
        script.integrity = PDFJS_INTEGRITY.lib;
        script.crossOrigin = "anonymous";
        script.referrerPolicy = "no-referrer";
        script.onload = () => window.pdfjsLib ? resolve(window.pdfjsLib) : reject(new Error("The PDF renderer did not initialise"));
        script.onerror = () => reject(new Error("The PDF renderer could not load or failed its integrity check"));
        document.head.append(script);
      });
      const response = await fetch(PDFJS_BASE + "pdf.worker.min.mjs", { integrity: PDFJS_INTEGRITY.worker, credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error("The PDF renderer's worker could not load");
      const workerUrl = URL.createObjectURL(new Blob([await response.text()], { type: "text/javascript" }));
      lib.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: "module", name: "pdfjs" });
      return lib;
    })().catch(error => {
      pdfjsPromise = null;
      throw error;
    });
  }
  return pdfjsPromise;
}
let releasingPdfs = Promise.resolve();
async function openPdf(lib, bytes) {
  // A document being released still holds the shared worker port; opening the
  // next one before that finishes makes pdf.js refuse ("worker is being destroyed").
  await releasingPdfs;
  // isEvalSupported is the documented CVE-2024-4367 mitigation; patched
  // releases ignore it, and it keeps any future downgrade safe.
  return lib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false }).promise;
}
// pdf.js 5+ releases a document through its loading task (older releases had
// PDFDocumentProxy.destroy). The shared worker itself stays up for the next one.
function releasePdf(doc) {
  try {
    const task = doc && doc.loadingTask;
    return Promise.resolve(task && task.destroy ? task.destroy() : doc && doc.destroy ? doc.destroy() : null).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}
// Each comparison owns its PDF documents and lazy-render observer; they are
// released as soon as another comparison (or a refresh) replaces it.
function disposeCompare() {
  const previous = activeCompare;
  activeCompare = { docs: [], observer: null };
  if (previous.observer) previous.observer.disconnect();
  if (previous.docs.length) releasingPdfs = Promise.all([releasingPdfs].concat(previous.docs.map(releasePdf))).then(() => {});
}
function compareSources(evidence) {
  const before = (evidence && evidence.before) || {};
  const after = (evidence && evidence.after) || {};
  const text = before.snapshot_location && after.snapshot_location ? { before: before.snapshot_location, after: after.snapshot_location } : null;
  if (before.file_snapshot_location && after.file_snapshot_location && /\.pdf$/i.test(after.file_snapshot_location)) {
    return { kind: "pdf", before: before.file_snapshot_location, after: after.file_snapshot_location, text };
  }
  if (before.html_snapshot_location && after.html_snapshot_location) {
    return { kind: "html", before: before.html_snapshot_location, after: after.html_snapshot_location, text };
  }
  if (text) return { kind: "text", before: text.before, after: text.after, text };
  return null;
}
async function fetchSnapshotBytes(path) {
  const response = await fetchImmutable(path);
  if (!response.ok) throw new Error("Saved file request returned HTTP " + response.status);
  return new Uint8Array(await response.arrayBuffer());
}
function compareShell(kind, event) {
  const kindLabel = { pdf: "Saved PDFs", html: "Saved pages", text: "Extracted text" }[kind];
  return '<div class="cmp" data-kind="' + kind + '">' +
    '<div class="cmp-bar"><span class="cmp-label is-before"><i></i>Previous version</span>' +
    '<span class="cmp-meta"><span class="cmp-kind">' + esc(kindLabel) + "</span>" +
    '<label class="cmp-toggle"><input type="checkbox" data-cmp-highlight checked> Highlight changes</label>' +
    '<span class="cmp-presets" role="group" aria-label="Divider position">' +
    '<button type="button" data-cmp-pos="0">Before</button><button type="button" data-cmp-pos="50">Split</button><button type="button" data-cmp-pos="100">After</button></span></span>' +
    '<span class="cmp-label is-after">New · ' + esc(fmt(event.timestamp)) + "<i></i></span></div>" +
    '<div class="cmp-summary" hidden></div>' +
    '<div class="cmp-stage" style="--pos:50%"><div class="cmp-layer cmp-before"></div><div class="cmp-layer cmp-after"></div>' +
    '<div class="cmp-handle" role="slider" tabindex="0" aria-label="Divider between previous and new version" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">' +
    '<span class="cmp-grip" aria-hidden="true"><i></i><i></i></span></div></div>' +
    '<p class="cmp-status" role="status"></p></div>';
}
function wireCompareSlider(root) {
  const stage = root.querySelector(".cmp-stage");
  const handle = root.querySelector(".cmp-handle");
  const set = value => {
    const pos = Math.max(0, Math.min(100, value));
    stage.style.setProperty("--pos", pos + "%");
    handle.setAttribute("aria-valuenow", String(Math.round(pos)));
  };
  const fromPointer = clientX => {
    const rect = stage.getBoundingClientRect();
    set(((clientX - rect.left) / rect.width) * 100);
  };
  let dragging = false;
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("button, a, summary")) return;
    // On touch, only the handle drags so the page still scrolls vertically.
    if (event.pointerType !== "mouse" && !event.target.closest(".cmp-handle")) return;
    dragging = true;
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
    fromPointer(event.clientX);
  });
  stage.addEventListener("pointermove", event => { if (dragging) fromPointer(event.clientX); });
  const stop = () => { dragging = false; stage.classList.remove("is-dragging"); };
  stage.addEventListener("pointerup", stop);
  stage.addEventListener("pointercancel", stop);
  handle.addEventListener("keydown", event => {
    const now = Number(handle.getAttribute("aria-valuenow"));
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft") { set(now - step); event.preventDefault(); }
    if (event.key === "ArrowRight") { set(now + step); event.preventDefault(); }
    if (event.key === "Home") { set(0); event.preventDefault(); }
    if (event.key === "End") { set(100); event.preventDefault(); }
  });
  root.querySelectorAll("[data-cmp-pos]").forEach(button => button.addEventListener("click", () => {
    stage.classList.add("is-animating");
    set(Number(button.dataset.cmpPos));
    window.setTimeout(() => stage.classList.remove("is-animating"), 380);
  }));
  const highlight = root.querySelector("[data-cmp-highlight]");
  if (highlight) highlight.addEventListener("change", () => root.classList.toggle("hide-marks", !highlight.checked));
}
function compareSummary(root, removed, added, extra) {
  const box = root.querySelector(".cmp-summary");
  if (!box) return;
  const parts = [];
  if (removed) parts.push('<span class="cmp-chip is-del">' + esc(removed) + "</span>");
  if (added) parts.push('<span class="cmp-chip is-add">' + esc(added) + "</span>");
  if (!parts.length) parts.push('<span class="cmp-chip">No text differences found</span>');
  box.innerHTML = parts.join("") + (extra || "");
  box.hidden = false;
}
async function renderCompare(target, evidence, event, stillCurrent) {
  const sources = compareSources(evidence);
  disposeCompare();
  const serial = ++compareSerial;
  const alive = () => serial === compareSerial && stillCurrent() && target.isConnected;
  target.innerHTML = compareShell(sources.kind, event);
  const root = target.querySelector(".cmp");
  const before = root.querySelector(".cmp-before");
  const after = root.querySelector(".cmp-after");
  const status = root.querySelector(".cmp-status");
  wireCompareSlider(root);
  status.textContent = "Loading both versions…";
  try {
    if (sources.kind === "pdf") await compareFillPdf(root, before, after, status, sources, alive);
    else if (sources.kind === "html") await compareFillHtml(root, before, after, status, sources, event, alive);
    else await compareFillText(root, status, sources, alive);
  } catch (error) {
    if (alive()) status.textContent = "Couldn't load both versions: " + String(error.message || error);
  }
}

/* ----- Text: aligned rows, removed text red on the left, added text green on the right ----- */
const CMP_CONTEXT_LINES = 3;
function compareLineHtml(text, segments, side) {
  if (text == null) return "";
  const raw = String(text);
  const heading = !segments && raw.match(/^\s*(#{1,6})\s+(.*)$/);
  const isTable = /^\s*\|.*\|\s*$/.test(raw);
  if (isTable && /^\s*\|?[\s:|-]+\|?\s*$/.test(raw) && raw.includes("-")) return '<span class="cmp-rule"></span>';
  let html;
  if (segments) {
    html = segments.map(segment => {
      if (segment.type === "same") return esc(segment.text);
      if (side === "before" && segment.type === "del") return '<mark class="cmp-del">' + esc(segment.text) + "</mark>";
      if (side === "after" && segment.type === "add") return '<mark class="cmp-add">' + esc(segment.text) + "</mark>";
      return "";
    }).join("");
  } else {
    html = esc(heading ? heading[2] : raw);
  }
  if (isTable) {
    html = html.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(cell => '<span class="cmp-td">' + (cell.trim() || "&nbsp;") + "</span>").join("");
    return '<span class="cmp-tr">' + html + "</span>";
  }
  if (heading) return '<span class="cmp-h">' + html + "</span>";
  return html || "&nbsp;";
}
function compareRowHtml(row) {
  const before = row.type === "add" ? '<span class="cmp-spacer"></span>' : compareLineHtml(row.before, row.type === "edit" ? row.segments : null, "before");
  const after = row.type === "del" ? '<span class="cmp-spacer"></span>' : compareLineHtml(row.after, row.type === "edit" ? row.segments : null, "after");
  return '<div class="cmp-row is-' + row.type + '"><div class="cmp-cell is-b">' + before + '</div><div class="cmp-cell is-a">' + after + "</div></div>";
}
async function compareFillText(root, status, sources, alive) {
  const [a, b] = await Promise.all([
    readSnapshotFile(sources.before, state.snapshotCache),
    readSnapshotFile(sources.after, state.snapshotCache)
  ]);
  if (!alive()) return;
  const { rows, stats } = L.alignLines(a, b);
  const stage = root.querySelector(".cmp-stage");
  stage.classList.add("is-rows");
  stage.querySelectorAll(".cmp-layer").forEach(layer => layer.remove());
  const doc = document.createElement("div");
  doc.className = "cmp-rows";
  // Collapse long unchanged stretches, keeping a few lines of context around each change.
  const html = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].type !== "same") { html.push(compareRowHtml(rows[i])); i += 1; continue; }
    let j = i;
    while (j < rows.length && rows[j].type === "same") j += 1;
    const keepHead = i === 0 ? 0 : CMP_CONTEXT_LINES;
    const keepTail = j === rows.length ? 0 : CMP_CONTEXT_LINES;
    if (j - i <= keepHead + keepTail + 2) {
      for (let k = i; k < j; k += 1) html.push(compareRowHtml(rows[k]));
    } else {
      for (let k = i; k < i + keepHead; k += 1) html.push(compareRowHtml(rows[k]));
      const hidden = rows.slice(i + keepHead, j - keepTail);
      html.push('<details class="cmp-gap"><summary>' + hidden.length.toLocaleString() + " unchanged lines</summary>" + hidden.map(compareRowHtml).join("") + "</details>");
      for (let k = j - keepTail; k < j; k += 1) html.push(compareRowHtml(rows[k]));
    }
    i = j;
  }
  doc.innerHTML = html.join("");
  stage.prepend(doc);
  const removed = stats.removed + stats.edited, added = stats.added + stats.edited;
  compareSummary(root, removed ? plural(removed, "line with removed text", "lines with removed text") : "", added ? plural(added, "line with added text", "lines with added text") : "");
  status.textContent = "Extracted text of both versions, aligned line by line. Removed text is red on the left of the divider, added text green on the right.";
}

/* ----- HTML: the saved pages, with changed text marked inside each frame ----- */
const normalizeForMatch = L.normalizeForMatch;
function flattenTextContainer(container) {
  const doc = container.nodeType === 9 ? container : container.ownerDocument;
  const root = container.nodeType === 9 ? container.body : container;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      if (node.nodeType === 1) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return NodeFilter.FILTER_REJECT;
        // Keep structural separators in the flat text while skipping ordinary
        // wrappers; raw HTML may have neither whitespace between cells nor text
        // nodes for <br>, even though the visible/extracted text has both.
        return node.tagName === "BR" || node.tagName === "TD" || node.tagName === "TH"
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return node.parentElement && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.parentElement.tagName)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  let flat = "";
  const map = [];
  let lastSpace = true;
  let lastCell = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if (node.tagName === "BR") {
        if (flat && !lastSpace) { flat += " "; map.push(null); lastSpace = true; }
      } else if (node.tagName === "TD" || node.tagName === "TH") {
        if (node !== lastCell && flat && !lastSpace) { flat += " "; map.push(null); lastSpace = true; }
        lastCell = node;
      }
      continue;
    }
    const text = node.nodeValue.normalize("NFKC");
    for (let i = 0; i < text.length; i += 1) {
      const ch = /\s|\u00a0/.test(text[i]) ? " " : text[i];
      if (ch === " " && lastSpace) continue;
      flat += ch; map.push([node, i]); lastSpace = ch === " ";
    }
  }
  return { flat, map };
}
function flattenDocumentText(doc) {
  return flattenTextContainer(doc);
}
function markdownTableCells(line) {
  const value = String(line || "").trim();
  if (!value.startsWith("|") || !value.endsWith("|")) return null;
  const cells = L.splitMarkdownTableRow(value).map(normalizeForMatch);
  if (cells.length < 2 || L.isMarkdownTableSeparator(cells)) return null;
  return cells;
}
function matchingTableRow(doc, cells) {
  if (!Array.isArray(cells)) return null;
  const matches = Array.from(doc.querySelectorAll("tr")).filter(row => {
    const actual = Array.from(row.cells || []).map(cell => normalizeForMatch(flattenTextContainer(cell).flat || cell.textContent || ""));
    return L.tableCellsMatch(cells, actual);
  });
  // Duplicate or ambiguous rows are not safe to highlight by text alone.
  return matches.length === 1 ? matches[0] : null;
}
function markEntireTableRow(row, cls) {
  const doc = row.ownerDocument;
  const walker = doc.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.parentElement.tagName) && String(node.nodeValue || "").trim()
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  nodes.forEach(node => {
    if (!node.parentNode) return;
    const mark = doc.createElement("mark");
    mark.className = cls;
    node.parentNode.replaceChild(mark, node);
    mark.appendChild(node);
  });
  return nodes.length;
}
function wrapTextRanges(doc, index, ranges, cls) {
  // Wrap from the end so earlier offsets stay valid.
  ranges.sort((x, y) => y[0] - x[0]).forEach(([start, end]) => {
    const pieces = new Map();
    for (let k = start; k < end; k += 1) {
      const item = index.map[k];
      if (!item) continue;
      const [node, offset] = item;
      const piece = pieces.get(node) || [offset, offset + 1];
      piece[0] = Math.min(piece[0], offset); piece[1] = Math.max(piece[1], offset + 1);
      pieces.set(node, piece);
    }
    pieces.forEach(([from, to], node) => {
      if (!node.parentNode) return;
      const range = doc.createRange();
      range.setStart(node, from);
      range.setEnd(node, Math.min(to, node.nodeValue.length));
      const mark = doc.createElement("mark");
      mark.className = cls;
      try { range.surroundContents(mark); } catch (_) { /* range crosses an element boundary */ }
    });
  });
  return ranges.length;
}
function countOccurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}
function markTextInDocument(doc, index, targets, cls, otherFlat) {
  if (!doc || !doc.body) return 0;
  const style = doc.createElement("style");
  style.textContent = "mark.cs-del{background:rgba(255,92,72,.30);box-shadow:0 0 0 1px rgba(214,48,30,.55);color:inherit;border-radius:2px;text-decoration:line-through;text-decoration-color:rgba(214,48,30,.8)}" +
    "mark.cs-add{background:rgba(52,199,110,.30);box-shadow:0 0 0 1px rgba(28,140,70,.55);color:inherit;border-radius:2px}" +
    "body.cs-hide-marks mark.cs-del,body.cs-hide-marks mark.cs-add{background:none;box-shadow:none;text-decoration:inherit}";
  (doc.head || doc.documentElement).append(style);
  const { flat } = index;
  const ranges = [];
  let directMarked = 0;
  let cursor = 0;
  const find = (needle, from, to) => {
    let at = flat.indexOf(needle, from);
    if (at >= 0 && to != null && at + needle.length > to) at = -1;
    return at;
  };
  targets.forEach(target => {
    // Markdown table rows are anchored to their complete cell sequence. Searching
    // their contents globally is unsafe: "link", "N/A", and form identifiers
    // recur in other tables, so a deleted row can otherwise strike through an
    // unrelated row elsewhere on the page.
    if (Array.isArray(target.tableCells)) {
      const row = matchingTableRow(doc, target.tableCells);
      if (!row) return; // Fail closed instead of highlighting a plausible but wrong match.
      if (target.whole) {
        directMarked += markEntireTableRow(row, cls);
        return;
      }
      const rowIndex = flattenTextContainer(row);
      const expected = normalizeForMatch(target.tableCells.join(" "));
      if (normalizeForMatch(rowIndex.flat) !== expected) return;
      const rowRanges = [];
      let rowCursor = 0;
      target.parts.forEach(part => {
        const needle = normalizeForMatch(part.text);
        if (!needle) return;
        const exact = part.offset;
        let at = exact >= 0 && rowIndex.flat.substr(exact, needle.length) === needle
          ? exact : rowIndex.flat.indexOf(needle, rowCursor);
        if (at < 0) return;
        rowRanges.push([at, at + needle.length]);
        rowCursor = at + needle.length;
      });
      directMarked += wrapTextRanges(doc, rowIndex, rowRanges, cls);
      return;
    }
    const line = normalizeForMatch(target.line);
    if (target.whole) {
      // Text that also exists in the other version moved or re-wrapped; it was not removed or added.
      target.parts.forEach(part => {
        const needle = normalizeForMatch(part);
        if (needle.length < 3) return;
        // Text that is just as frequent in the other version moved or re-wrapped; a
        // repeated sentence that occurs fewer times there had one copy removed or added.
        if (otherFlat && countOccurrences(otherFlat, needle) >= countOccurrences(flat, needle)) return;
        let at = find(needle, cursor);
        if (at < 0) at = find(needle, 0);
        if (at < 0) return;
        ranges.push([at, at + needle.length]);
        cursor = at + needle.length;
      });
      return;
    }
    // Word-level edit: a line that exists whole in the other version was only re-wrapped.
    if (otherFlat && line.length >= 8 && otherFlat.includes(line)) return;
    // Otherwise locate the line first, then mark only the changed words inside it.
    // Each part carries its offset within the normalized line, so an edited word
    // that also appears earlier in the line ("Tier 1 ... Tier 2") is marked where
    // it changed, not at its first occurrence.
    const lineAt = line.length >= 8 ? (find(line, cursor) >= 0 ? find(line, cursor) : find(line, 0)) : -1;
    let lineCursor = lineAt;
    target.parts.forEach(part => {
      const needle = normalizeForMatch(part.text);
      if (!needle) return;
      let at = -1;
      if (lineAt >= 0) {
        const exact = lineAt + part.offset;
        if (part.offset >= 0 && flat.substr(exact, needle.length) === needle) at = exact;
        else at = find(needle, lineCursor, lineAt + line.length);
      } else if (needle.length >= 12 && !(otherFlat && otherFlat.includes(needle))) {
        at = find(needle, cursor) >= 0 ? find(needle, cursor) : find(needle, 0);
      }
      if (at < 0) return;
      ranges.push([at, at + needle.length]);
      if (lineAt >= 0) lineCursor = at + needle.length;
    });
    if (lineAt >= 0) cursor = lineAt + line.length;
  });
  return wrapTextRanges(doc, index, ranges, cls) + directMarked;
}
function htmlMarkTargets(rows, side) {
  const targets = [];
  rows.forEach(row => {
    const line = side === "before" ? row.before : row.after;
    if (line == null) return;
    const whole = side === "before" ? row.type === "del" : row.type === "add";
    const tableCells = markdownTableCells(line);
    if (whole) {
      targets.push({
        whole: true, line, tableCells,
        parts: String(line).replace(/^\s*(#+|[-*•]|\d+[.)])\s+/, "").split(/\s\|\s|^\||\|$/).map(s => s.trim()).filter(Boolean)
      });
    } else if (row.type === "edit") {
      const want = side === "before" ? "del" : "add";
      const parts = L.changedPartOffsets(row.segments, want);
      if (parts.length) targets.push({ whole: false, line: String(line).replace(/\|/g, " "), tableCells, parts });
    }
  });
  return targets;
}
async function compareFillHtml(root, before, after, status, sources, event, alive) {
  const [a, b, textA, textB] = await Promise.all([
    readSnapshotFile(sources.before, state.htmlCache),
    readSnapshotFile(sources.after, state.htmlCache),
    sources.text ? readSnapshotFile(sources.text.before, state.snapshotCache).catch(() => null) : null,
    sources.text ? readSnapshotFile(sources.text.after, state.snapshotCache).catch(() => null) : null
  ]);
  if (!alive()) return;
  const aligned = textA != null && textB != null ? L.alignLines(textA, textB) : null;
  let marked = 0;
  const frame = (layer, html, side) => new Promise(resolve => {
    const node = document.createElement("iframe");
    node.className = "cmp-frame";
    node.title = side === "before" ? "Previous saved page" : "New saved page";
    // Same-origin without allow-scripts: the saved page cannot run code, but its text
    // can be marked and its height measured so both versions scroll under the divider.
    node.setAttribute("sandbox", "allow-same-origin");
    node.addEventListener("load", () => resolve(node), { once: true });
    node.srcdoc = previewSource(html, event.url || "");
    layer.append(node);
  });
  const [frameA, frameB] = await Promise.all([frame(before, a, "before"), frame(after, b, "after")]);
  if (!alive()) return;
  try {
    if (aligned) {
      const indexA = flattenDocumentText(frameA.contentDocument), indexB = flattenDocumentText(frameB.contentDocument);
      marked += markTextInDocument(frameA.contentDocument, indexA, htmlMarkTargets(aligned.rows, "before"), "cs-del", indexB.flat);
      marked += markTextInDocument(frameB.contentDocument, indexB, htmlMarkTargets(aligned.rows, "after"), "cs-add", indexA.flat);
    }
  } catch (_) { /* marking is best effort */ }
  const measure = node => {
    try {
      const doc = node.contentDocument;
      return Math.min(40000, Math.max(600, doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0));
    } catch (_) { return 1600; }
  };
  const height = Math.max(measure(frameA), measure(frameB));
  frameA.style.height = frameB.style.height = height + "px";
  const highlight = root.querySelector("[data-cmp-highlight]");
  if (highlight) highlight.addEventListener("change", () => root.querySelectorAll("iframe.cmp-frame").forEach(f => {
    try { f.contentDocument.body.classList.toggle("cs-hide-marks", !highlight.checked); } catch (_) {}
  }));
  if (aligned) {
    const s = aligned.stats;
    compareSummary(root, s.removed + s.edited ? plural(s.removed + s.edited, "removed passage", "removed passages") : "", s.added + s.edited ? plural(s.added + s.edited, "added passage", "added passages") : "");
  }
  status.textContent = (aligned && !marked ? "No wording was added or removed on the page itself; the differences are line breaks or formatting, listed in the redline. " : "") +
    "Scripts are disabled. Images and styles load from the live site, so they can differ from what was captured.";
}

/* ----- PDF: rendered pages, with removed words boxed red and added words green ----- */
async function pdfWords(doc, limit, alive, onProgress) {
  const words = [];
  const last = Math.min(doc.numPages, limit);
  for (let number = 1; number <= last; number += 1) {
    if (!alive()) return words;
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    content.items.forEach(item => {
      const str = item.str || "";
      if (!str.trim()) return;
      const [a, b, c, d, e, f] = item.transform;
      const along = Math.hypot(a, b) || 1, up = Math.hypot(c, d) || 1;
      const ux = a / along, uy = b / along, vx = c / up, vy = d / up;
      const length = item.width || along * str.length * 0.5;
      const re = /\S+/g;
      let match;
      while ((match = re.exec(str))) {
        const t0 = length * (match.index / str.length), t1 = length * ((match.index + match[0].length) / str.length);
        const corners = [[t0, -0.22 * up], [t1, -0.22 * up], [t1, 0.92 * up], [t0, 0.92 * up]].map(([t, h]) =>
          viewport.convertToViewportPoint(e + ux * t + vx * h, f + uy * t + vy * h));
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        words.push({
          text: match[0], page: number,
          box: [Math.min(...xs) / viewport.width, Math.min(...ys) / viewport.height, Math.max(...xs) / viewport.width, Math.max(...ys) / viewport.height]
        });
      }
    });
    if (onProgress && (number % 10 === 0 || number === last)) onProgress(number);
  }
  return words;
}
function mergeWordBoxes(words, indexes) {
  // Join neighbouring changed words on the same line into one highlight.
  const out = [];
  indexes.forEach(index => {
    const w = words[index];
    const last = out[out.length - 1];
    const h = w.box[3] - w.box[1];
    if (last && last.page === w.page && Math.abs(last.box[1] - w.box[1]) < h * 0.5 && w.box[0] - last.box[2] < h * 1.6 && w.box[0] >= last.box[0] - h) {
      last.box = [Math.min(last.box[0], w.box[0]), Math.min(last.box[1], w.box[1]), Math.max(last.box[2], w.box[2]), Math.max(last.box[3], w.box[3])];
    } else {
      out.push({ page: w.page, box: w.box.slice() });
    }
  });
  return out;
}
async function compareFillPdf(root, before, after, status, sources, alive) {
  const [lib, bytesA, bytesB] = await Promise.all([loadPdfJs(), fetchSnapshotBytes(sources.before), fetchSnapshotBytes(sources.after)]);
  if (!alive()) return;
  const [docA, docB] = await Promise.all([openPdf(lib, bytesA), openPdf(lib, bytesB)]);
  activeCompare.docs.push(docA, docB);
  if (!alive()) { disposeCompare(); return; }
  const total = Math.min(COMPARE_PAGE_LIMIT, Math.max(docA.numPages, docB.numPages));
  const stage = root.querySelector(".cmp-stage");
  const width = Math.max(320, stage.clientWidth);
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const pageSize = async (doc, number) => {
    if (number > doc.numPages) return null;
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    return { page, scale: width / viewport.width, height: Math.round(viewport.height * width / viewport.width) };
  };
  const slots = [];
  for (let number = 1; number <= total; number += 1) {
    const [sa, sb] = await Promise.all([pageSize(docA, number), pageSize(docB, number)]);
    if (!alive()) return;
    const height = Math.max(sa ? sa.height : 0, sb ? sb.height : 0);
    const make = (layer, size, label) => {
      const slot = document.createElement("div");
      slot.className = "cmp-page" + (size ? "" : " is-missing");
      slot.style.height = height + "px";
      slot.dataset.page = String(number);
      if (size) {
        // Highlight boxes are positioned against the page's own rendered area.
        slot.innerHTML = '<div class="cmp-sheet" style="height:' + size.height + 'px"></div><span class="cmp-pageno">' + number + "</span>";
      } else {
        slot.innerHTML = "<span>" + label + "</span>";
      }
      layer.append(slot);
      return slot;
    };
    slots.push({ number, sa, sb, a: make(before, sa, "Not in the previous version"), b: make(after, sb, "Not in the new version") });
  }
  const draw = async (size, slot) => {
    const sheet = slot.querySelector(".cmp-sheet");
    const canvas = document.createElement("canvas");
    const viewport = size.page.getViewport({ scale: size.scale * ratio });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.style.width = width + "px";
    await size.page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    sheet.prepend(canvas);
  };
  const renderSlot = async slot => {
    if (slot.rendered) return;
    slot.rendered = true;
    await Promise.all([slot.sa ? draw(slot.sa, slot.a) : null, slot.sb ? draw(slot.sb, slot.b) : null]);
  };
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const slot = slots.find(candidate => candidate.a === entry.target);
      if (slot) { observer.unobserve(entry.target); renderSlot(slot); }
    });
  }, { root: root.closest(".detail-pane"), rootMargin: "900px 0px" });
  activeCompare.observer = observer;
  slots.forEach(slot => observer.observe(slot.a));

  status.textContent = "Comparing the words of both versions…";
  const pagesA = Math.min(docA.numPages, COMPARE_PAGE_LIMIT), pagesB = Math.min(docB.numPages, COMPARE_PAGE_LIMIT);
  const read = { a: 0, b: 0 };
  const progress = () => {
    if (alive()) status.textContent = "Reading both versions… page " + (read.a + read.b) + " of " + (pagesA + pagesB);
  };
  const [wordsA, wordsB] = await Promise.all([
    pdfWords(docA, COMPARE_PAGE_LIMIT, alive, n => { read.a = n; progress(); }),
    pdfWords(docB, COMPARE_PAGE_LIMIT, alive, n => { read.b = n; progress(); })
  ]);
  if (!alive()) return;
  // A bounded edit distance keeps a heavily rewritten document from stalling
  // the page; beyond it a stretch is marked as replaced rather than diffed.
  const { removed, added } = L.changedWords(wordsA, wordsB, { maxD: 1500 });
  const paint = (words, indexes, layer, cls) => {
    mergeWordBoxes(words, indexes).forEach(hit => {
      if (hit.page > total) return;
      const sheet = layer.querySelector('.cmp-page[data-page="' + hit.page + '"] .cmp-sheet');
      if (!sheet) return;
      const mark = document.createElement("i");
      mark.className = "cmp-hl " + cls;
      const [x0, y0, x1, y1] = hit.box;
      mark.style.cssText = "left:" + (x0 * 100).toFixed(3) + "%;top:" + (y0 * 100).toFixed(3) + "%;width:" + ((x1 - x0) * 100).toFixed(3) + "%;height:" + ((y1 - y0) * 100).toFixed(3) + "%";
      sheet.append(mark);
    });
  };
  paint(wordsA, removed, before, "is-del");
  paint(wordsB, added, after, "is-add");
  const pages = [...new Set(removed.map(i => wordsA[i].page).concat(added.map(i => wordsB[i].page)))].sort((x, y) => x - y);
  const jump = pages.length ? '<span class="cmp-pages">Changed pages ' + pages.slice(0, 30).map(p => '<button type="button" data-cmp-page="' + p + '">' + p + "</button>").join("") + (pages.length > 30 ? " …" : "") + "</span>" : "";
  compareSummary(root, removed.length ? plural(removed.length, "word removed", "words removed") : "", added.length ? plural(added.length, "word added", "words added") : "", jump);
  root.querySelectorAll("[data-cmp-page]").forEach(button => button.addEventListener("click", () => {
    const slot = before.querySelector('.cmp-page[data-page="' + button.dataset.cmpPage + '"]');
    if (slot) slot.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  status.textContent = (docA.numPages === docB.numPages ? docA.numPages + " pages" : "Previous " + docA.numPages + " pages, new " + docB.numPages + " pages") +
    (total < Math.max(docA.numPages, docB.numPages) ? " (showing the first " + total + ")" : "") +
    ". Pages render as you scroll. Text changes are compared word by word; changes to images or drawings alone are not highlighted.";
}

/* ================= Ask Sentinel =================
 * This UI deliberately talks only to a same-origin server endpoint.
 * It never contains an OpenRouter credential and does not implement a
 * client-side quota (which would be bypassable by clearing browser storage).
 */
const ASK_SENTINEL_ENDPOINT = window.CHANGESENTINEL_ASK_ENDPOINT || "";
const ASK_SENTINEL_MAX_TRANSCRIPT = 12;
// TEMPORARY: visible unlimited-query test mode, in sync with the Edge Function.
const ASK_SENTINEL_TEST_MODE_UNTIL = Date.parse("2026-10-25T15:30:00Z");
function askSentinelUnlimitedTestMode() { return Date.now() < ASK_SENTINEL_TEST_MODE_UNTIL; }
const askSentinelState = { messages: [], sending: false, remaining: askSentinelUnlimitedTestMode() ? 999 : 3, warmed: false, warmingPromise: null, warmError: "", identity: null, memoryVisitorId: "" };

const ASK_SENTINEL_SUPABASE_URL = window.CHANGESENTINEL_ASK_SUPABASE_URL || "";
const ASK_SENTINEL_SUPABASE_PUBLISHABLE_KEY = window.CHANGESENTINEL_ASK_SUPABASE_PUBLISHABLE_KEY || "";
let askSentinelSupabaseClient = null;

function askSentinelGetClient() {
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    throw new Error("The secure chat connection could not load. Please refresh the dashboard and retry.");
  }
  if (!ASK_SENTINEL_SUPABASE_URL || !ASK_SENTINEL_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("The Ask Sentinel connection has not been configured.");
  }
  if (!askSentinelSupabaseClient) {
    askSentinelSupabaseClient = window.supabase.createClient(
      ASK_SENTINEL_SUPABASE_URL,
      ASK_SENTINEL_SUPABASE_PUBLISHABLE_KEY,
      { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "changesentinel-ask-auth" } }
    );
  }
  return askSentinelSupabaseClient;
}
function askSentinelVisitorId() {
  const key = "changesentinel-ask-visitor-id";
  try {
    const existing = localStorage.getItem(key) || "";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
    const id = window.crypto.randomUUID();
    localStorage.setItem(key, id);
    return id;
  } catch (_) {
    if (!askSentinelState.memoryVisitorId) askSentinelState.memoryVisitorId = window.crypto.randomUUID();
    return askSentinelState.memoryVisitorId;
  }
}
async function askSentinelIdentity() {
  if (askSentinelState.identity) return askSentinelState.identity;
  try {
    const client = askSentinelGetClient();
    const current = await client.auth.getSession();
    if (current.error) throw current.error;
    let session = current.data && current.data.session;
    if (!session) {
      const created = await client.auth.signInAnonymously();
      if (created.error) throw created.error;
      session = created.data && created.data.session;
    }
    if (session && session.access_token) {
      askSentinelState.identity = { accessToken: session.access_token, visitorId: "" };
      return askSentinelState.identity;
    }
  } catch (_) {
    // Prototype fallback: clearing site storage resets this visitor identity.
  }
  askSentinelState.identity = { accessToken: "", visitorId: askSentinelVisitorId() };
  return askSentinelState.identity;
}
function askSentinelIdentityHeaders(identity) {
  const headers = { "Accept": "application/json", "apikey": ASK_SENTINEL_SUPABASE_PUBLISHABLE_KEY };
  if (identity.accessToken) headers["Authorization"] = "Bearer " + identity.accessToken;
  else headers["x-ask-sentinel-visitor-id"] = identity.visitorId;
  return headers;
}
function askSentinelWarmIndex() {
  if (askSentinelState.warmed) {
    return Promise.resolve({ ok: true, remaining: askSentinelState.remaining });
  }
  if (askSentinelState.warmingPromise) return askSentinelState.warmingPromise;
  askSentinelState.warmError = "";
  $("askSentinelQuota").textContent = "Connecting…";
  $("askSentinelQuota").classList.add("is-busy");
  askSentinelState.warmingPromise = (async () => {
    const identity = await askSentinelIdentity();
    const response = await fetch(ASK_SENTINEL_ENDPOINT + "?mode=warm", {
      method: "GET",
      headers: askSentinelIdentityHeaders(identity),
      credentials: "omit"
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok || payload.ok !== true) {
      throw new Error(typeof payload.error === "string" ? payload.error : "Could not prepare the monitoring archive. Please retry.");
    }
    askSentinelState.warmed = true;
    askSentinelUpdateQuota(payload.remaining);
    return payload;
  })().catch(error => {
    askSentinelState.warmError = String(error && error.message || "The monitoring archive could not be prepared.");
    $("askSentinelQuota").textContent = "Offline — retry by asking";
    $("askSentinelQuota").classList.remove("is-busy");
    $("askSentinelQuota").classList.add("is-empty");
    return null;
  }).finally(() => {
    askSentinelState.warmingPromise = null;
  });
  return askSentinelState.warmingPromise;
}

function askSentinelEscapedText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/* Small, safe Markdown renderer for model answers. All text is HTML-escaped first;
 * only a fixed set of formatting tags is produced, and links must be http(s). */
function askSentinelInline(text) { return L.inlineMarkdown(text); }
function askSentinelMarkdown(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;
  const isTableRow = line => /^\s*\|.*\|\s*$/.test(line);
  const cells = line => line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      html.push("<pre><code>" + askSentinelEscapedText(body.join("\n")) + "</code></pre>");
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      html.push('<div class="md-table"><table><thead><tr>' + head.map(c => "<th>" + askSentinelInline(c) + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map(r => "<tr>" + r.map(c => "<td>" + askSentinelInline(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>");
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) { html.push("<h" + (heading[1].length <= 2 ? 3 : 4) + ">" + askSentinelInline(heading[2]) + "</h" + (heading[1].length <= 2 ? 3 : 4) + ">"); i++; continue; }
    const listMatch = line.match(/^(\s*)([-*•]|\d+[.)])\s+/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const indent = listMatch[1].length;
      const bullet = /^(\s*)([-*•]|\d+[.)])\s+/;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(bullet);
        if (m && m[1].length <= indent && /\d/.test(m[2]) === ordered) {
          items.push([lines[i++].replace(bullet, "")]);
          continue;
        }
        // Indented lines (continuations, nested fences, sub-lists) belong to the current item.
        if (items.length && /^\s+\S/.test(lines[i])) { items[items.length - 1].push(lines[i++]); continue; }
        // A blank line keeps the list open only if the next non-blank line continues it.
        if (items.length && !lines[i].trim()) {
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = lines[j] || "";
          const nm = next.match(bullet);
          if ((nm && nm[1].length <= indent && /\d/.test(nm[2]) === ordered) || /^\s+\S/.test(next)) { items[items.length - 1].push(""); i = j; continue; }
        }
        break;
      }
      html.push((ordered ? "<ol>" : "<ul>") + items.map(item => {
        const [first, ...rest] = item;
        const body = rest.join("\n").replace(/^\n+|\n+$/g, "");
        if (!body) return "<li>" + askSentinelInline(first) + "</li>";
        const pad = Math.min(...rest.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length));
        const dedented = rest.map(l => l.slice(Math.min(pad, l.match(/^\s*/)[0].length))).join("\n");
        return "<li>" + askSentinelMarkdown(first + "\n" + dedented) + "</li>";
      }).join("") + (ordered ? "</ol>" : "</ul>"));
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|([-*•]|\d+[.)])\s)/.test(lines[i]) && !isTableRow(lines[i])) para.push(lines[i++]);
    if (para.length) html.push("<p>" + para.map(askSentinelInline).join("<br>") + "</p>");
    else i++;
  }
  return html.join("");
}
const ASK_SENTINEL_INTERNAL_SOURCE_PATHS = Object.freeze({
  "__current_report__": ["data/report.json"],
  "__recent_history__": ["data/history/index.json"],
  "__current_scope__": ["config/sources.json", "data/latest.json"],
  "__repo_overview__": ["README.md"],
  "__current_inventory__": ["data/latest.json"]
});
function askSentinelRepositoryFileUrl(path) {
  return REPO + "/blob/main/" + path.split("/").map(encodeURIComponent).join("/");
}
function askSentinelSourcePaths(path) {
  const value = String(path || "");
  if (Object.prototype.hasOwnProperty.call(ASK_SENTINEL_INTERNAL_SOURCE_PATHS, value)) return ASK_SENTINEL_INTERNAL_SOURCE_PATHS[value];
  return value && !value.startsWith("__") ? [value] : [];
}
function askSentinelSourceLinks(path) {
  return askSentinelSourcePaths(path).map(file => {
    const a = document.createElement("a");
    a.href = askSentinelRepositoryFileUrl(file);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = file;
    return a;
  });
}
function askSentinelLinkSourceCitations(answer) {
  return String(answer || "").replace(/\[Source:\s*(__[a-z0-9_-]+__)\s*\]/gi, (citation, internalPath) => {
    const paths = askSentinelSourcePaths(internalPath);
    if (!paths.length) return citation;
    return paths.map(file => "[" + file + "](" + askSentinelRepositoryFileUrl(file) + ")").join(" · ");
  });
}
function askSentinelMessageNode(role, content, extraClass) {
  const node = document.createElement("article");
  node.className = "ask-sentinel-message " + (role === "user" ? "user" : "assistant") + (extraClass ? " " + extraClass : "");
  const label = document.createElement("div");
  label.className = "ask-sentinel-role";
  label.textContent = role === "user" ? "You" : "Sentinel";
  const text = document.createElement("div");
  text.className = "ask-sentinel-text";
  text.textContent = content;
  node.append(label, text);
  return node;
}
function askSentinelRenderAnswer(node, answer, sources) {
  node.classList.remove("ask-sentinel-typing", "ask-sentinel-error");
  node.querySelector(".ask-sentinel-text").innerHTML = askSentinelMarkdown(askSentinelLinkSourceCitations(answer));
  const links = (Array.isArray(sources) ? sources : []).flatMap(askSentinelSourceLinks)
    .filter((a, idx, all) => all.findIndex(b => b.textContent === a.textContent) === idx).slice(0, 6);
  if (links.length) {
    const box = document.createElement("div");
    box.className = "ask-sentinel-sources";
    const lead = document.createElement("span");
    lead.textContent = "Evidence";
    box.append(lead, ...links);
    node.append(box);
  }
}
function askSentinelShowTyping(node) {
  node.classList.add("ask-sentinel-typing");
  node.querySelector(".ask-sentinel-text").innerHTML =
    '<span class="ask-sentinel-dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span>Reading the monitoring record…</span>';
}
function askSentinelAppendMessage(role, content, extraClass) {
  const transcript = $("askSentinelTranscript");
  const node = askSentinelMessageNode(role, content, extraClass);
  transcript.append(node);
  $("askSentinelMessages").scrollTop = $("askSentinelMessages").scrollHeight;
  return node;
}
function askSentinelUpdateQuota(remaining) {
  if (askSentinelUnlimitedTestMode()) askSentinelState.remaining = 999;
  else if (Number.isInteger(remaining) && remaining >= 0 && remaining <= 3) askSentinelState.remaining = remaining;
  const quota = $("askSentinelQuota");
  quota.textContent = askSentinelUnlimitedTestMode()
    ? "TEST MODE — unlimited questions until " + new Date(ASK_SENTINEL_TEST_MODE_UNTIL).toLocaleString()
    : askSentinelState.remaining + " of 3 questions left today";
  quota.classList.toggle("is-empty", !askSentinelUnlimitedTestMode() && askSentinelState.remaining <= 0);
  quota.classList.remove("is-busy");
}
function askSentinelOpen() {
  setView("askSentinel");
  $("askSentinelInput").focus({ preventScroll: true });
  void askSentinelWarmIndex();
}
function askSentinelSetSending(sending) {
  askSentinelState.sending = sending;
  const quotaEmpty = !askSentinelUnlimitedTestMode() && askSentinelState.remaining <= 0;
  $("askSentinelSend").disabled = sending || quotaEmpty;
  $("askSentinelInput").disabled = sending || quotaEmpty;
  $("askSentinelSend").setAttribute("aria-busy", String(sending));
}
/* Repository history and evidence are indexed server-side; client context is not sent as authoritative evidence. */
async function askSentinelSendQuestion(promptOverride) {
  if (askSentinelState.sending || (!askSentinelUnlimitedTestMode() && askSentinelState.remaining <= 0)) return;
  const input = $("askSentinelInput");
  const question = String(promptOverride == null ? input.value : promptOverride).trim();
  if (!question) { input.focus(); return; }
  if (!state.loaded) {
    askSentinelAppendMessage("assistant", "Monitoring data is still loading. Please wait until the dashboard finishes loading before asking a question.", "ask-sentinel-error");
    return;
  }
  if (!askSentinelUnlimitedTestMode() && question.length > 1200) {
    askSentinelAppendMessage("assistant", "Please keep each question to 1,200 characters or fewer.", "ask-sentinel-error");
    return;
  }
  if (!ASK_SENTINEL_ENDPOINT || !ASK_SENTINEL_SUPABASE_URL || !ASK_SENTINEL_SUPABASE_PUBLISHABLE_KEY) {
    askSentinelAppendMessage("assistant",
      "Ask Sentinel’s interface is ready, but its secure server endpoint has not been configured yet. No request was sent. Configure the server-side endpoint and keep the OpenRouter credential on the server; never expose provider keys in the browser.",
      "ask-sentinel-error");
    return;
  }
  $("askSentinelWelcome").hidden = true;
  input.value = "";
  askSentinelAppendMessage("user", question);
  const history = askSentinelState.messages.slice(-ASK_SENTINEL_MAX_TRANSCRIPT);
  input.style.height = "";
  const typing = askSentinelAppendMessage("assistant", "");
  askSentinelShowTyping(typing);
  askSentinelSetSending(true);
  try {
    const warmed = await askSentinelWarmIndex();
    if (!warmed) throw new Error(askSentinelState.warmError || "The monitoring archive could not be prepared. Please retry.");
    const identity = await askSentinelIdentity();
    const response = await fetch(ASK_SENTINEL_ENDPOINT, {
      method: "POST",
      headers: { ...askSentinelIdentityHeaders(identity), "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ question, conversation: history })
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (Number.isInteger(payload.remaining)) askSentinelUpdateQuota(payload.remaining);
    if (response.status === 429) {
      throw new Error("Daily limit reached. Ask Sentinel allows three requests per user per day. Your allowance resets according to the server’s daily reset time.");
    }
    if (!response.ok) {
      throw new Error(typeof payload.error === "string" ? payload.error : "Ask Sentinel could not answer this request. Please try again later.");
    }
    const answer = typeof payload.answer === "string" ? payload.answer.trim() : "";
    if (!answer) throw new Error("Ask Sentinel returned an empty answer. Please retry.");
    askSentinelRenderAnswer(typing, answer, payload.context_sources);
    $("askSentinelMessages").scrollTop = typing.offsetTop - 24;
    askSentinelState.messages.push({ role: "user", content: question }, { role: "assistant", content: answer });
    if (askSentinelState.messages.length > ASK_SENTINEL_MAX_TRANSCRIPT * 2) {
      askSentinelState.messages = askSentinelState.messages.slice(-ASK_SENTINEL_MAX_TRANSCRIPT * 2);
    }
  } catch (error) {
    typing.querySelector(".ask-sentinel-text").textContent = String(error && error.message || "A connection error occurred.");
    typing.classList.add("ask-sentinel-error");
    typing.classList.remove("ask-sentinel-typing");
  } finally {
    askSentinelSetSending(false);
    if (!askSentinelUnlimitedTestMode() && askSentinelState.remaining <= 0) {
      askSentinelUpdateQuota(0);
      $("askSentinelInput").placeholder = "Daily limit reached — resets at 00:00 UTC";
      document.querySelectorAll("[data-ask-prompt]").forEach(button => { button.disabled = true; });
    }
    input.focus({ preventScroll: true });
  }
}
$("askSentinelLaunch").addEventListener("click", askSentinelOpen);
$("askSentinelBack").addEventListener("click", () => setView("overview"));
$("askSentinelForm").addEventListener("submit", event => {
  event.preventDefault();
  askSentinelSendQuestion();
});
$("askSentinelInput").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    askSentinelSendQuestion();
  }
});
$("askSentinelInput").addEventListener("input", event => {
  const el = event.target;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
});
$("askSentinelMessages").addEventListener("click", event => {
  const prompt = event.target.closest("[data-ask-prompt]");
  if (prompt) askSentinelSendQuestion(prompt.dataset.askPrompt);
});

addRestoreDraft();
if ($("repoLink")) $("repoLink").href = REPO;
loadData(true);
refreshWorkflowRuns();
window.setInterval(() => loadData(false), 120000);
window.setInterval(updateNextRunCountdown, 30000);
