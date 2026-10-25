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
  reviews: "data/reviews/ledger.json",
  regulators: "config/regulators.json",
  health: "data/health.json"
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
  reviews: new URL("./data/reviews/ledger.json", document.baseURI).href,
  regulators: new URL("./config/regulators.json", document.baseURI).href,
  health: new URL("./data/health.json", document.baseURI).href
};
// The calendar feed is served from Pages so calendar apps can subscribe to it.
const CALENDAR_FEED = new URL("./data/calendar.ics", document.baseURI).href;
const VIEWS = ["overview", "changes", "monitors", "runs", "health", "notifications", "scout", "calendar", "askSentinel"];
const HASH_NAMES = { overview: "overview", changes: "changes", monitors: "pages", runs: "runs", health: "health", notifications: "alerts", scout: "scout", calendar: "cadence", askSentinel: "ask-sentinel" };
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
  selectedId: "", selectedChangeId: "", selectedRunId: "", selectedNotificationId: "", selectedHealthKey: "", health: null, pendingCondition: null,
  mobileDetail: false,
  filter: "ALL", changeFilter: "ALL", detailTab: "", diffMode: "compare", snapshotMode: "preview",
  docInfo: {}, titleQueue: [], titleWorkers: 0, titleTimer: null,
  snapshotCache: boundedCache(24), htmlCache: boundedCache(12), evidenceCache: boundedCache(80), pdfPreviewUrl: "", toastTimer: null,
  assetSignatures: {}, renderedSignature: "", lastFullLoad: 0, loading: null, detailKeys: {},
  workflowRuns: [], workflowSignature: "", scanColumns: null, pendingScan: null,
  scoutLatest: null, scoutReview: null, scoutConfig: null, scoutFilter: "REVIEW", scoutFormatFilter: "ALL", selectedScoutKey: "", scoutMonitored: null,
  scoutGroupBy: "", scoutStrongOnly: false, scoutOpenGroups: new Set(), scoutPicked: new Map(),
  scoutPreview: { mode: "page", device: "desktop", expanded: false, key: "", serial: 0, token: "", page: null, locate: "", trail: [] },
  // Add a link: the page being explored, links found by level, and the ticked links.
  add: { step: "start", method: "explore", url: "", history: [], at: -1, page: null, pages: new Map(), loading: 0,
    tab: "selected", selectMode: false, candidates: [], picked: new Map(), anchor: "", origin: "explore", notes: [], info: "",
    crawl: null, query: "", format: "ALL", show: "ALL", limit: 300, opened: {}, weekly: false, scope: "",
    rules: {}, area: null, picking: false, showOlder: false, ruleDrafts: {}, ruleRequests: {}, ruleOpen: false, similar: [], hideOlder: true, reviewSimilar: [] },
  scoutSourceMode: "add",
  calendar: null, lineage: null, reviews: null, reviewTarget: "", integrity: {},
  cadenceEntries: [], cadenceMember: null, cadenceSession: null, cadenceStatus: "signed-out", cadenceError: "",
  cadenceLoading: null, cadenceMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  cadenceSelectedDate: L.localIsoDate(new Date()), cadenceSignInBusy: false,
  cadenceRecoveryMode: false, cadenceRecoveryBusy: false,
  cadenceSearch: "", cadenceFilter: "ALL", cadencePanel: "month", cadenceOwner: "ALL", cadenceLinkEvents: {}
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
    // Fleet health is rebuilt by every scan; before the first one it is absent.
    case "health":
      return isPlainObject(value) && value.schema_version === 1 && isPlainObject(value.totals) && Array.isArray(value.monitors);
    // Who publishes each host; without it pages are grouped by their domain.
    case "regulators":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.regulators);
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
    const condition = ai.condition && typeof ai.condition === "object" && typeof ai.condition.met === "boolean" ? ai.condition : null;
    return { state: ai.analysis.relevant === true ? "relevant" : "irrelevant", analysis: ai.analysis, condition };
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
  renderOverviewHealth();
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
function renderOverviewHealth() {
  const line = $("overviewHealth");
  if (!line) return;
  if (!state.health) { line.textContent = "Health appears after the next scan."; return; }
  const totals = healthTotals();
  const week = state.health.last_7_days || {};
  const parts = [healthNumber(totals.healthy) + " of " + healthNumber(totals.monitors) + " monitors healthy"];
  if (totals.failing) parts.push("<strong>" + esc(plural(totals.failing, "failing", "failing")) + "</strong>");
  if (totals.stale) parts.push(esc(totals.stale + " not scanned recently"));
  if (totals.inactive) parts.push(esc(totals.inactive + " quiet for weeks"));
  parts.push(esc(healthPercent(week.success_rate) + " of checks succeeded this week"));
  line.innerHTML = parts.map((part, index) => index === 0 ? esc(part) : part).join(" · ") + ".";
}
function renderUpcomingDates() {
  const today = L.localIsoDate();
  const dates = L.upcomingDates(state.calendar, today, 5);
  if (!dates.length) {
    $("upcomingDates").innerHTML = '<p class="block-value"><small>' + (state.calendar
      ? "None found. Deadlines and effective dates stated in a change appear here."
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

// The LED change field: one column per six-hour scan window (newest on the
// right), then one empty column for the next scan. Manual runs and crawl
// continuations fold into the window they ran in, so every column is the same
// span of time and a one-source run never leaves holes in other rows.
//
// It has to stay readable at hundreds of pages, so it opens on a lens: each page
// that changed or failed in the chosen range keeps its own row, and every other
// page folds into one summary row per kind ("New pages", "No change") that opens
// in place. Other lenses list just the changed, failing or new pages, or every
// page grouped by source. Labels and the day header stay pinned while the
// lights scroll under them.
const FIELD_STORAGE = "cs-field-v1";
const FIELD_LENS_WORDS = { activity: "Activity", changed: "Changed", problems: "Problems", new: "New", all: "All pages" };
const FIELD_GROUPS = { regulator: "Regulator", jurisdiction: "Jurisdiction", kind: "Kind of document", source: "Monitor", none: "No grouping" };
// The timeline filters events, not pages, and by default gives each page its
// own lane so one page's updates read left to right with the time between them.
const TL_SHOWS = ["changed", "problems", "new", "markup", "all"];
const TL_LANES = ["page", "regulator", "jurisdiction", "kind", "source", "none"];
const TL_LANE_LIMIT = 10;
function fieldPrefs() {
  if (state.field) return state.field;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(FIELD_STORAGE) || "{}") || {}; } catch (_) { saved = {}; }
  state.field = {
    lens: L.FIELD_LENSES.indexOf(saved.lens) >= 0 ? saved.lens : "activity",
    range: Object.prototype.hasOwnProperty.call(L.FIELD_RANGES, saved.range) ? saved.range : isCompact() ? "2d" : "7d",
    groupBy: Object.prototype.hasOwnProperty.call(FIELD_GROUPS, saved.groupBy) ? saved.groupBy : "regulator",
    view: saved.view === "timeline" ? "timeline" : "grid",
    tlShow: TL_SHOWS.indexOf(saved.tlShow) >= 0 ? saved.tlShow : "changed",
    tlLanes: TL_LANES.indexOf(saved.tlLanes) >= 0 ? saved.tlLanes : "page",
    query: "", open: new Set(), closed: new Set(), limit: 60, limits: {}, storyLimit: 60, tlLaneLimit: TL_LANE_LIMIT
  };
  return state.field;
}
function saveFieldPrefs() {
  const f = fieldPrefs();
  try { localStorage.setItem(FIELD_STORAGE, JSON.stringify({ lens: f.lens, range: f.range, groupBy: f.groupBy, view: f.view, tlShow: f.tlShow, tlLanes: f.tlLanes })); } catch (_) {}
}
// Lights keep a fixed size; the label column takes whatever width the lights
// leave, within limits, so long page names show in full when there is room.
function fieldGeometry(columnCount) {
  const viewport = $("fieldViewport");
  const width = (viewport && viewport.clientWidth) || 800;
  const compact = isCompact();
  const gap = compact ? 3 : 4;
  const tile = compact ? 14 : 16;
  const lights = ((columnCount || 0) + 1) * (tile + gap) + 18 + 16;
  const min = compact ? 116 : 180;
  const max = compact ? 168 : 380;
  const labelWidth = Math.round(Math.min(max, Math.max(min, width - lights)));
  return { labelWidth, tile, gap, key: labelWidth + "x" + tile + "x" + gap };
}
function fieldPage(item, reportEvents) {
  return {
    sourceId: item.source_id,
    pending: Boolean(item.pending_registration),
    firstSeen: item.first_seen,
    events: itemChangeEntries(item).concat(reportEvents.filter(event => (event.url_id === item.url_id || event.url === item.canonical_url) &&
      (event.event_type === "FETCH_ERROR" || event.event_type === "EXTRACTION_ERROR"))),
    problemAt: item.fetch_error || item.extraction_error ? item.last_checked : null
  };
}
function fieldCellSummary(states) {
  const order = ["bad", "on", "new", "markup", "dim", "skip"];
  const words = { bad: "couldn't be read", on: "changed", new: "new", markup: "markup only", dim: "no change", skip: "not scanned" };
  const counts = {};
  states.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
  return order.filter(s => counts[s]).map(s => counts[s] + " " + words[s]).join(", ");
}
// Regulators by host: config/regulators.json first, then Scout's profiles.
function regulatorProfiles() {
  if (state.regulatorProfiles) return state.regulatorProfiles;
  const own = state.regulators && Array.isArray(state.regulators.regulators) ? state.regulators.regulators : [];
  const scout = state.scoutConfig && Array.isArray(state.scoutConfig.regulators) ? state.scoutConfig.regulators : [];
  state.regulatorProfiles = own.concat(scout.map(profile => ({ id: profile.id, name: profile.name, short_name: profile.short_name,
    jurisdiction: profile.jurisdiction, region: profile.region, hosts: profile.hosts || [] })));
  return state.regulatorProfiles;
}
function itemRegulator(item) {
  const source = sourceForItem(item) || {};
  return L.regulatorFor(item.canonical_url, regulatorProfiles(), source.regulator || "");
}
function fieldGroupOf(item, groupBy, sourceLabelText) {
  if (groupBy === "none") return {};
  if (groupBy === "source") return { groupKey: "src:" + item.source_id, groupLabel: sourceLabelText, groupNote: "" };
  if (groupBy === "kind") {
    const kind = L.pageKind(itemTitle(item), item.canonical_url, item.extraction_type);
    return { groupKey: "kind:" + kind, groupLabel: kind, groupNote: "" };
  }
  const regulator = itemRegulator(item);
  if (groupBy === "jurisdiction") {
    return regulator.jurisdiction ? { groupKey: "j:" + regulator.jurisdiction, groupLabel: regulator.jurisdiction, groupNote: regulator.region || "" } : { groupKey: "other", groupLabel: "Other", groupNote: "" };
  }
  return { groupKey: "reg:" + regulator.id, groupLabel: regulator.short, groupNote: [regulator.short !== regulator.name ? regulator.name : "", regulator.jurisdiction].filter(Boolean).join(" · ") };
}
// A small lit monogram for each section, its colour fixed by its name.
const FIELD_BADGE_HUES = ["#e8890a", "#2f6fe0", "#179463", "#c4321f", "#8a5cf5", "#0e8fa3", "#b3541e", "#6b8f1a", "#d0447c", "#4a6fa5"];
function fieldBadge(label) {
  const text = String(label || "?").replace(/\(.*?\)/g, " ").trim();
  const words = text.split(/[\s/·-]+/).filter(word => /[A-Za-z0-9]/.test(word) && !/^(of|the|and|for|de|la|du|des|del)$/i.test(word));
  const acronym = /^[A-Z0-9&.]{2,5}$/.test(words[0] || "") ? words[0].replace(/\./g, "") : "";
  const initials = acronym || words.slice(0, 2).map(word => word.charAt(0).toUpperCase()).join("") || "?";
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  const hue = FIELD_BADGE_HUES[Math.abs(hash) % FIELD_BADGE_HUES.length];
  return '<span class="field-monogram" style="--badge:' + hue + '" aria-hidden="true">' + esc(initials.slice(0, 4)) + "</span>";
}
function renderMonitoringSignal() {
  const field = $("signalVisual");
  const viewport = $("fieldViewport");
  const prefs = fieldPrefs();
  // Follow the latest scan unless the user has moved left into older history.
  const followLatest = Boolean(viewport && (viewport.dataset.initialized !== "1" || viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft <= 24));
  const items = state.items || [];
  syncFieldTools();
  if (!items.length) {
    field.style.removeProperty("--cols");
    field.innerHTML = emptyState("No pages yet", "Each monitored page gets a row of lights here, one per scan.");
    ledField.measure();
    return;
  }
  // The countdown sees every saved scan; the field shows the six-hour windows in the chosen range.
  const scans = L.runColumns(state.history, { workflowRuns: state.workflowRuns });
  const allColumns = L.slotColumns(state.history, { workflowRuns: state.workflowRuns });
  const columns = L.fieldWindow(allColumns, prefs.range, new Date());
  const geometry = fieldGeometry(columns.length);
  const pending = L.pendingScan(new Date(), scans, state.workflowRuns);
  state.scanColumns = scans;
  state.fieldColumns = columns;
  state.pendingScan = pending;
  field.style.setProperty("--cols", columns.length + 1);
  field.style.setProperty("--windows", columns.length);
  field.style.setProperty("--tile", geometry.tile + "px");
  field.style.setProperty("--gap", geometry.gap + "px");
  field.style.setProperty("--label-w", geometry.labelWidth + "px");
  field.dataset.geometry = geometry.key;
  const reportEvents = allEvents();
  const itemById = new Map(items.map(item => [item.url_id, item]));
  const sourceById = new Map(configuredSources().map(source => [source.id, source]));
  const pages = items.map(item => {
    const source = sourceById.get(item.source_id) || { id: item.source_id };
    const page = fieldPage(item, reportEvents);
    const sourceLabelText = shortSourceLabel(source);
    return Object.assign({ id: item.url_id, url: item.canonical_url, title: itemTitle(item), sourceId: item.source_id, sourceLabel: sourceLabelText,
      pending: page.pending, states: columns.map(column => L.columnCellState(column, page)) }, fieldGroupOf(item, prefs.groupBy, sourceLabelText));
  });
  const layout = L.fieldRows(pages, { lens: prefs.lens, query: prefs.query, groupBy: prefs.groupBy, open: prefs.open, closed: prefs.closed, limit: prefs.limit, limits: prefs.limits });
  state.fieldLayout = layout;
  syncFieldTools(layout.counts);
  const pendingTip = pendingWords(pending);
  const rangeShort = { "2d": "Last 2 days", "7d": "Last 7 days", "30d": "Last 30 days", all: "All history" }[prefs.range];
  // Header: one label per day spanning that day's windows (weekday over date),
  // pinned while the rows scroll; a dash under a window marks a manual run in it.
  const todayKey = new Date().toDateString();
  let html = '<div class="field-corner" role="columnheader"><span>' + esc(rangeShort) + "</span><small>" + esc(columns.length ? plural(columns.length, "scan window", "scan windows") : "No scans in range") + "</small></div>";
  const days = [];
  columns.forEach(column => {
    const date = new Date(column.slot);
    const key = date.toDateString();
    if (!days.length || days[days.length - 1].key !== key) days.push({ key, date, columns: [] });
    days[days.length - 1].columns.push(column);
  });
  days.forEach((day, index) => {
    const span = day.columns.length;
    const weekday = day.date.toLocaleDateString([], { weekday: span >= 2 ? "short" : "narrow" });
    const marks = day.columns.map((column, k) => column.manual ? '<i class="field-manual" style="--k:' + k + '" title="' + esc(plural(column.manual, "manual run", "manual runs")) + '"></i>' : "").join("");
    html += '<span class="field-day' + (day.key === todayKey ? " is-today" : "") + (index % 2 ? " is-odd" : "") + '" role="columnheader" style="grid-column: span ' + span + '" title="' +
      esc(day.date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })) + '"><span class="field-day-week">' + esc(weekday) + '</span><span class="field-day-date">' +
      esc(span >= 2 || index === days.length - 1 ? day.date.getDate() : "") + "</span>" + marks + "</span>";
  });
  html += '<span class="field-day is-next" role="columnheader" title="The next scan"><span class="field-day-week">Next</span></span>';
  // Activity ribbon: how many pages in view changed, failed or were new in each window.
  const scope = pages.filter(fieldMatchesQuery);
  const tallies = columns.map((_, x) => {
    const tally = { on: 0, bad: 0, new: 0 };
    scope.forEach(page => { const s = page.states[x]; if (s === "on" || s === "bad" || s === "new") tally[s] += 1; });
    return tally;
  });
  const peak = Math.max(1, ...tallies.map(t => t.on + t.bad + t.new));
  html += '<div class="field-corner field-pulse-label" role="rowheader">Activity</div>';
  html += tallies.map((t, x) => {
    const total = t.on + t.bad + t.new;
    const bar = (count, cls) => count ? '<i class="' + cls + '" style="--h:' + Math.max(18, Math.round(Math.sqrt(count / peak) * 100)) + '%"></i>' : "";
    const words = [t.on ? plural(t.on, "change", "changes") : "", t.bad ? plural(t.bad, "problem", "problems") : "", t.new ? plural(t.new, "new page", "new pages") : ""].filter(Boolean).join(", ");
    return '<span class="field-pulse' + (total ? "" : " is-quiet") + '" role="gridcell" title="' + esc(windowSpan(columns[x]) + (words ? ": " + words : ": nothing changed")) + '">' +
      bar(t.bad, "is-bad") + bar(t.on, "is-on") + bar(t.new, "is-new") + "</span>";
  }).join("") + '<span class="field-pulse is-next" aria-hidden="true"></span>';
  let y = 0;
  const cells = (states, attrs, tipTitle, summaries) => states.map((s, x) =>
    '<span class="led s-' + s + '" role="gridcell" data-x="' + x + '" data-y="' + y + '" data-col="' + esc(columns[x].id) + '" data-state="' + s + '" data-tip="' + esc(tipTitle) + '"' +
      attrs(s) + (summaries ? ' data-summary="' + esc(summaries[x]) + '"' : "") +
      ' aria-label="' + esc(tipTitle + ", " + (attrs.source ? columnLabel(columns[x], attrs.source) : windowSpan(columns[x])) + ": " + (summaries ? summaries[x] : stateWords(s))) + '"></span>').join("");
  const summaryCells = (row, title) => {
    const summaries = columns.map((_, x) => fieldCellSummary(row.members.map(page => page.states[x]).filter(s => s !== "none")) || "not scanned");
    const attrs = s => (s === "none" ? "" : ' data-field-group="' + esc(row.key) + '"');
    attrs.source = "";
    return cells(row.states, attrs, title, summaries) +
      '<span class="led s-pending is-summary" role="gridcell" data-x="' + columns.length + '" data-y="' + y + '" data-col="pending" data-tip="' + esc(title) + '" data-state="pending" aria-label="' + esc(title + ", " + pendingTip.title) + '"></span>';
  };
  layout.rows.forEach(row => {
    if (row.type === "more") {
      html += '<button class="field-more" type="button" data-field-more="' + esc(row.key) + '">Show ' + esc(Math.min(60, row.hidden)) + " more · " + esc(plural(row.hidden, "page", "pages")) + " not shown</button>";
      return;
    }
    if (row.type === "section") {
      const title = row.label + " · " + plural(row.count, "page", "pages");
      const chips = [row.counts.problems ? '<i class="field-chip is-bad">' + esc(row.counts.problems) + "</i>" : "", row.counts.changed ? '<i class="field-chip is-on">' + esc(row.counts.changed) + "</i>" : "",
        row.counts.new ? '<i class="field-chip is-new">' + esc(row.counts.new) + "</i>" : ""].join("");
      html += '<button class="field-label field-section-label" type="button" data-field-group="' + esc(row.key) + '" data-row="' + y + '" aria-expanded="' + String(row.open) + '" title="' + esc(title + (row.note ? " · " + row.note : "")) + '">' +
        fieldBadge(row.label) + '<span class="field-section-text"><span class="field-name">' + esc(row.label) + '</span><small>' + esc([row.note, plural(row.count, "page", "pages")].filter(Boolean).join(" · ")) + "</small></span>" +
        '<span class="field-chips">' + chips + '</span><span class="field-chevron" aria-hidden="true"></span></button>';
      html += summaryCells(row, title);
      y++;
      return;
    }
    if (row.type === "group") {
      const title = row.label + " · " + plural(row.count, "page", "pages");
      html += '<button class="field-label field-group-label is-' + esc(row.kind) + '" type="button" data-field-group="' + esc(row.key) + '" data-row="' + y + '" aria-expanded="' + String(row.open) + '" title="' + esc(title) + '">' +
        '<span class="field-chevron" aria-hidden="true"></span><span class="field-name">' + esc(row.label) + '</span><span class="field-label-count num">' + esc(row.count) + "</span></button>";
      html += summaryCells(row, title);
      y++;
      return;
    }
    const page = row.page;
    const item = itemById.get(page.id);
    const a = page.activity || L.rowActivity(page.states);
    const badge = a.problems ? '<i class="field-badge is-bad" aria-hidden="true"></i>' : a.changed ? '<i class="field-badge is-on" aria-hidden="true"></i>' : "";
    html += '<button class="field-label' + (row.member ? " is-member" : "") + '" type="button" data-monitor-id="' + esc(page.id) + '" data-row="' + y + '" title="' + esc(page.title + " · " + page.sourceLabel) + '">' +
      badge + '<span class="field-name">' + esc(page.title) + "</span></button>";
    const attrs = s => (s === "none" ? "" : ' data-monitor-id="' + esc(page.id) + '" data-source="' + esc(page.sourceId) + '"');
    attrs.source = page.sourceId;
    html += cells(page.states, attrs, page.title);
    html += '<span class="led s-pending" role="gridcell" data-x="' + columns.length + '" data-y="' + y + '" data-col="pending" data-tip="' + esc(page.title) +
      '" data-state="pending"' + (item && item.pending_registration ? ' data-first="1"' : "") + ' aria-label="' + esc(page.title + ", " + (item && item.pending_registration ? "first scan in progress" : pendingTip.title)) + '"></span>';
    y++;
  });
  if (!layout.rows.length) {
    const words = prefs.query ? "No page matches “" + prefs.query + "”." : prefs.lens === "problems" ? "No page failed to scan in this range." :
      prefs.lens === "changed" ? "No page changed in this range." : prefs.lens === "new" ? "No page was added in this range." : "Nothing to show in this range.";
    html += '<div class="field-empty">' + esc(words) + ' <button class="text-button" type="button" data-field-lens="all">Show all pages</button></div>';
  }
  field.innerHTML = html;
  if (viewport) {
    viewport.dataset.initialized = "1";
    if (followLatest) requestAnimationFrame(() => { viewport.scrollLeft = viewport.scrollWidth; ledField.measure(); });
  }
  const c = layout.counts;
  const manual = columns.some(column => column.manual);
  const rangeWords = { "2d": "the last 2 days", "7d": "the last 7 days", "30d": "the last 30 days", all: "all saved history" }[prefs.range];
  $("fieldNote").textContent = "Each column is a six-hour scan window (starting " + scheduleTimes() + " your time), newest on the right" +
    (columns.length > 12 ? "; scroll sideways for older windows" : "") + (manual ? "; a dash under a day marks a window with a manual run" : "") + ". In " + rangeWords + ": " +
    ([c.changed ? plural(c.changed, "page changed", "pages changed") : "no content changes", c.problems ? plural(c.problems, "page had problems", "pages had problems") : "",
      c.new ? plural(c.new, "new page", "new pages") : ""].filter(Boolean).join(", ")) + ". Markup-only edits don't count as changes.";
  const manualLegend = document.querySelector(".field-legend .manual");
  if (manualLegend) manualLegend.parentElement.hidden = !manual;
  syncFieldView();
  if (prefs.view === "timeline") renderTimeline(columns);
  else { timelineCounts(columns); ledField.measure(); }
  updateNextRunCountdown();
}
/* ---------- Timeline view ----------
 * The same pages, range, grouping, search and lens as the field, laid on a
 * continuous time axis: one lane per section, a lit bead where something
 * happened, and below it the story of those events in words, newest first.
 */
const TIMELINE_KIND_OF = { CHANGED_URL: "on", NEW_URL: "new", REMOVED_URL: "removed", HTML_SOURCE_CHANGED: "markup", FETCH_ERROR: "bad", EXTRACTION_ERROR: "bad" };
const TIMELINE_KIND_WORDS = { on: ["change", "changes"], new: ["new page", "new pages"], bad: ["problem", "problems"], removed: ["removal", "removals"], markup: ["markup edit", "markup edits"] };
function syncFieldView() {
  const view = fieldPrefs().view;
  document.querySelectorAll("[data-field-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.fieldView === view)));
  $("fieldFrame").hidden = view === "timeline";
  $("timelineView").hidden = view !== "timeline";
  // The other view's legend keeps its space (see .field-legends) so nothing below moves.
  document.querySelectorAll("[data-legend-for]").forEach(legend => {
    const off = legend.dataset.legendFor !== view;
    legend.toggleAttribute("data-off", off);
    if (off) legend.setAttribute("aria-hidden", "true"); else legend.removeAttribute("aria-hidden");
  });
  document.querySelectorAll("[data-tools-for]").forEach(tool => {
    const off = tool.dataset.toolsFor !== view;
    tool.toggleAttribute("data-off", off);
    tool.inert = off;
    if (off) tool.setAttribute("aria-hidden", "true"); else tool.removeAttribute("aria-hidden");
  });
}
function timelineEntries(prefs) {
  const sourceById = new Map(configuredSources().map(source => [source.id, source]));
  const itemById = new Map((state.items || []).map(item => [item.url_id, item]));
  const out = [];
  const seenNew = new Set();
  const seenBad = new Set();
  const lane = item => {
    const source = sourceById.get(item.source_id) || { id: item.source_id };
    const label = shortSourceLabel(source);
    if (prefs.tlLanes === "page") {
      const regulator = fieldGroupOf(item, "regulator", label);
      return { laneKey: "p:" + item.url_id, laneLabel: itemTitle(item), laneNote: regulator.groupLabel || label, laneBadge: regulator.groupLabel || label, sourceLabel: label, regulatorLabel: regulator.groupLabel || label,
        burstKey: regulator.groupKey || "all", burstLabel: regulator.groupLabel || label };
    }
    const group = prefs.tlLanes === "none" ? {} : fieldGroupOf(item, prefs.tlLanes, label);
    const regulator = prefs.tlLanes === "regulator" ? group : fieldGroupOf(item, "regulator", label);
    return { laneKey: group.groupKey || "all", laneLabel: group.groupLabel || "All pages", laneNote: group.groupNote || "", laneBadge: group.groupLabel || "All pages", sourceLabel: label, regulatorLabel: regulator.groupLabel || label };
  };
  const matches = (item, place) => fieldMatchesQuery({ title: itemTitle(item), url: item.canonical_url, sourceLabel: place.sourceLabel, groupLabel: place.laneLabel });
  const add = (item, kind, at, extra) => {
    const time = new Date(at).getTime();
    if (!item || !Number.isFinite(time)) return;
    const place = lane(item);
    if (!matches(item, place)) return;
    out.push(Object.assign({ at: time, kind, pageId: item.url_id, title: itemTitle(item), url: item.canonical_url }, place, extra));
  };
  changeLogEntries().forEach(event => {
    const kind = TIMELINE_KIND_OF[event.event_type];
    const item = itemById.get(event.url_id) || itemForEvent(event);
    if (!kind || !item) return;
    if (kind === "new") seenNew.add(item.url_id);
    if (kind === "bad") seenBad.add(item.url_id);
    const verdict = verdictFor(event);
    const analysis = verdict && verdict.analysis ? verdict.analysis : null;
    add(item, kind, event.timestamp, {
      id: event.event_id, type: event.event_type,
      summary: analysis && analysis.summary ? String(analysis.summary) : "",
      relevant: verdict && (verdict.state === "relevant" || verdict.state === "irrelevant") ? verdict.state === "relevant" : null
    });
  });
  // Pages first saved without a NEW_URL event (a quiet first baseline) still
  // arrived on a day, and a page failing right now is a problem even before
  // its error event reaches the change log.
  (state.items || []).forEach(item => {
    if (item.first_seen && !seenNew.has(item.url_id)) add(item, "new", item.first_seen, { id: "first:" + item.url_id, type: "NEW_URL", summary: "", relevant: null });
    if ((item.fetch_error || item.extraction_error) && item.last_checked && !seenBad.has(item.url_id)) {
      add(item, "bad", item.last_checked, { id: "problem:" + item.url_id, type: item.fetch_error ? "FETCH_ERROR" : "EXTRACTION_ERROR", summary: String(item.fetch_error || item.extraction_error), relevant: null });
    }
  });
  return out;
}
function timelineBounds(prefs, columns, entries) {
  const now = Date.now();
  // The axis ends at the scan the Overview counts down to. While that scan is
  // late, queued or running it ends just past now, rather than at a later slot.
  const pending = state.pendingScan;
  const waiting = !pending || pending.phase === "waiting";
  const days = L.FIELD_RANGES[prefs.range];
  const due = waiting ? (pending ? pending.due.getTime() : L.nextScheduledScan(new Date(now)).getTime()) : 0;
  const end = waiting ? Math.max(now + 60000, due) : now + Math.max(30 * 60000, (days || 7) * 86400000 * .025);
  if (days) return { start: now - days * 86400000, end, now };
  const earliest = Math.min(columns.length ? columns[0].start : now, ...entries.map(entry => entry.at));
  return { start: Math.min(now - 86400000, Number.isFinite(earliest) ? earliest : now), end, now };
}
function timelineKindWords(kinds) {
  return L.TIMELINE_KINDS.filter(kind => kinds[kind]).map(kind => plural(kinds[kind], TIMELINE_KIND_WORDS[kind][0], TIMELINE_KIND_WORDS[kind][1])).join(", ");
}
const TL_SHOW_WORDS = { changed: "content changes", problems: "problems", new: "new pages", markup: "markup edits", all: "events" };
// The timeline's event filters show their counts in either view, so the
// filter row is the same size whichever view is open.
function timelineCounts(columns) {
  const prefs = fieldPrefs();
  const entries = timelineEntries(prefs);
  const bounds = timelineBounds(prefs, columns, entries);
  const showCounts = { changed: 0, problems: 0, new: 0, markup: 0, all: 0 };
  entries.forEach(entry => {
    if (entry.at < bounds.start || entry.at > bounds.end) return;
    showCounts.all += 1;
    if (entry.kind === "on" || entry.kind === "removed") showCounts.changed += 1;
    else if (entry.kind === "bad") showCounts.problems += 1;
    else if (entry.kind === "new") showCounts.new += 1;
    else if (entry.kind === "markup") showCounts.markup += 1;
  });
  document.querySelectorAll("[data-tl-count]").forEach(count => { count.textContent = String(showCounts[count.dataset.tlCount] || 0); });
  return { prefs, entries, bounds, showCounts };
}
function renderTimeline(columns) {
  const host = $("timelineView");
  const { prefs, entries, bounds, showCounts } = timelineCounts(columns);
  const compact = isCompact();
  const labelWidth = compact ? 0 : Math.round(Math.min(300, Math.max(220, (host.clientWidth || 900) * .3)));
  const trackPx = Math.max(240, (host.clientWidth || 900) - labelWidth - 40);
  // Beads closer than this share one, so neighbouring beads never overlap.
  const gapMs = (bounds.end - bounds.start) * (compact ? 22 : 30) / trackPx;
  const model = L.timelineModel(entries, { start: bounds.start, end: bounds.end, gapMs, lens: prefs.tlShow });
  // For the story: how long after the previous update of the same sort on the same page each one came.
  const afterById = new Map();
  const groupOfKind = kind => kind === "removed" ? "on" : kind;
  const byPage = new Map();
  entries.slice().sort((e1, e2) => e1.at - e2.at).forEach(entry => {
    const key = entry.pageId + "|" + groupOfKind(entry.kind);
    const prev = byPage.get(key);
    if (prev != null && entry.kind !== "new") afterById.set(entry.id, L.timelineGapWords(entry.at - prev) + " after the previous " + (groupOfKind(entry.kind) === "on" ? "change" : entry.kind === "bad" ? "problem" : "edit"));
    byPage.set(key, entry.at);
  });
  state.timeline = { model, entries: new Map(entries.map(entry => [entry.id, entry])), afterById };
  const span = bounds.end - bounds.start;
  const pct = at => ((Math.max(bounds.start, Math.min(bounds.end, at)) - bounds.start) / span * 100).toFixed(3) + "%";
  const dayStarts = [];
  const cursor = new Date(bounds.start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < bounds.end) { dayStarts.push(cursor.getTime()); cursor.setDate(cursor.getDate() + 1); }
  const pxPerDay = trackPx * 86400000 / span;
  const todayKey = new Date().toDateString();
  // Bands alternate by day when a day is wide enough to read, otherwise by
  // week (from Monday) or month, so long ranges don't turn into a barcode.
  const unit = pxPerDay >= 28 ? "day" : pxPerDay * 7 >= 28 ? "week" : "month";
  const bandStarts = dayStarts.filter((day, index) => unit === "day" || index === 0 || (unit === "week" ? new Date(day).getDay() === 1 : new Date(day).getDate() === 1));
  const bands = bandStarts.map((day, index) => {
    const from = Math.max(day, bounds.start);
    const to = Math.min(index + 1 < bandStarts.length ? bandStarts[index + 1] : bounds.end, bounds.end);
    const today = unit === "day" && new Date(day).toDateString() === todayKey;
    return to > from ? '<i class="tl-band' + (index % 2 ? " is-odd" : "") + (today ? " is-today" : "") + '" style="left:' + pct(from) + ";width:" + ((to - from) / span * 100).toFixed(3) + '%"></i>' : "";
  }).join("");
  // Labels sit at band starts (and on today), at least ~48 px apart; today wins
  // a collision. A label whose start falls before the range sits at its edge.
  const xOf = at => (Math.max(at, bounds.start) - bounds.start) / span * trackPx;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  let marks = bandStarts.map(day => ({ day, x: xOf(day), today: day === todayStart.getTime() }))
    .filter(mark => mark.day >= bounds.start || mark.x === 0 && (xOf(mark.day + 86400000) >= 40 || unit !== "day"));
  if (unit !== "day" && todayStart.getTime() >= bounds.start && !marks.some(mark => mark.today)) marks.push({ day: todayStart.getTime(), x: xOf(todayStart.getTime()), today: true });
  marks.sort((m1, m2) => m1.x - m2.x);
  const kept = [];
  marks.forEach(mark => {
    const last = kept[kept.length - 1];
    if (!last || mark.x - last.x >= 48) kept.push(mark);
    else if (mark.today) kept[kept.length - 1] = mark;
  });
  const labels = kept.map(mark => {
    const date = new Date(mark.day);
    const atEnd = trackPx - mark.x < 40;
    const top = unit === "day" ? date.toLocaleDateString([], { weekday: "short" }) : date.toLocaleDateString([], { month: "short" });
    return '<span class="tl-day' + (mark.today ? " is-today" : "") + (atEnd ? " is-end" : "") + '" style="' + (atEnd ? "right:0" : "left:" + pct(Math.max(mark.day, bounds.start))) + '"><span class="tl-day-week">' +
      esc(mark.today && !atEnd ? "Today" : top) + '</span><span class="tl-day-date">' + esc(date.getDate()) + "</span></span>";
  }).join("");
  const pendingNow = state.pendingScan;
  const nextWords = pendingNow ? pendingWords(pendingNow) : null;
  const nextWhen = !pendingNow || pendingNow.phase === "waiting" ? clock(new Date(bounds.end)) :
    pendingNow.phase === "late" ? nextWords.time + " · late" : pendingNow.phase === "due" ? nextWords.time + " · due now" : nextWords.time.toLowerCase();
  const nowMark = '<i class="tl-now" style="left:' + pct(bounds.now) + '"></i>';
  // From now to the next scheduled scan: the stretch nothing can have happened in yet.
  const upcoming = '<i class="tl-upcoming" style="left:' + pct(bounds.now) + ";width:" + ((bounds.end - Math.min(bounds.end, bounds.now)) / span * 100).toFixed(3) + '%"></i>';
  const nextAxis = '<span class="tl-next-label" title="' + esc("Next scheduled scan, " + nextWhen) + '"><i aria-hidden="true"></i>' + esc(!pendingNow || ["waiting", "late", "due"].indexOf(pendingNow.phase) >= 0 ? "Next scan " + nextWhen : nextWords.time) + "</span>";
  const nextMark = '<i class="tl-next" style="left:100%"></i>';
  const rangeShort = { "2d": "Last 2 days", "7d": "Last 7 days", "30d": "Last 30 days", all: "All history" }[prefs.range];
  const c = model.counts;
  const lanesShown = model.lanes.slice(0, prefs.tlLaneLimit || TL_LANE_LIMIT);
  let html = '<div class="tl-board" style="--label-w:' + labelWidth + 'px">' +
    '<div class="tl-row tl-head"><div class="tl-corner"><span>' + esc(rangeShort) + "</span><small>" + esc(c.total ? plural(c.total, TL_SHOW_WORDS[prefs.tlShow].replace(/s$/, ""), TL_SHOW_WORDS[prefs.tlShow]) : "Nothing in range") + "</small></div>" +
    '<div class="tl-track tl-axis">' + bands + upcoming + labels + nowMark + nextMark + nextAxis + "</div></div>";
  if (!model.lanes.length) {
    const what = TL_SHOW_WORDS[prefs.tlShow];
    const words = prefs.query ? "No " + what + " match “" + prefs.query + "” in this range." : "No " + what + " in " + rangeShort.toLowerCase() + ".";
    html += '<div class="tl-empty">' + esc(words) +
      (prefs.tlShow !== "all" && showCounts.all ? ' <button class="text-button" type="button" data-tl-show="all">Show all events</button>' : "") +
      (prefs.range !== "all" ? ' <button class="text-button" type="button" data-tl-range="all">Show all history</button>' : "") + "</div>";
  }
  lanesShown.forEach((lane, laneIndex) => {
    const chips = [lane.counts.bad ? '<i class="field-chip is-bad">' + esc(lane.counts.bad) + "</i>" : "", lane.counts.on + lane.counts.removed ? '<i class="field-chip is-on">' + esc(lane.counts.on + lane.counts.removed) + "</i>" : "",
      lane.counts.new ? '<i class="field-chip is-new">' + esc(lane.counts.new) + "</i>" : "", lane.counts.markup ? '<i class="field-chip is-markup">' + esc(lane.counts.markup) + "</i>" : ""].join("");
    // Each update is joined to the next one on its lane, labelled with the time
    // between them; a dashed tail runs on from the latest to the next scan.
    let links = "";
    lane.beads.forEach((bead, index) => {
      if (!index) return;
      const prev = lane.beads[index - 1];
      const width = bead.x - prev.x;
      const words = L.timelineGapWords(bead.after);
      links += '<i class="tl-link" style="left:' + (prev.x * 100).toFixed(3) + "%;width:" + (width * 100).toFixed(3) + '%">' +
        (width * trackPx >= (compact ? 54 : 62) ? '<span class="tl-gap">' + esc(words) + "</span>" : "") + "</i>";
    });
    const last = lane.beads[lane.beads.length - 1];
    if (last && last.x < 1) links += '<i class="tl-tail" style="left:' + (last.x * 100).toFixed(3) + "%;width:" + ((1 - last.x) * 100).toFixed(3) + '%"></i>';
    const beads = lane.beads.map((bead, beadIndex) => {
      const size = bead.count === 1 ? 1 : bead.count < 10 ? 2 : 3;
      const mixed = Object.keys(bead.kinds).filter(kind => kind !== bead.top);
      const when = new Date(bead.first).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) +
        (bead.count > 1 && bead.last - bead.first > 60000 ? " – " + clock(new Date(bead.last)) : "");
      return '<button class="tl-bead k-' + esc(bead.top) + " sz-" + size + (mixed.length ? " is-mixed k2-" + esc(L.TIMELINE_KINDS.find(kind => bead.kinds[kind] && kind !== bead.top)) : "") +
        '" type="button" style="left:' + (bead.x * 100).toFixed(3) + "%;--i:" + (laneIndex * 3 + beadIndex) + '" data-tl-bead="' + esc(bead.key) + '" aria-label="' + esc(lane.label + ", " + when + ": " + timelineKindWords(bead.kinds) + (bead.after != null ? ", " + L.timelineGapWords(bead.after) + " after the one before" : "")) + '">' +
        (bead.count > 1 ? '<span class="num">' + esc(bead.count > 99 ? "99+" : bead.count) + "</span>" : "") + "</button>";
    }).join("");
    html += '<div class="tl-row tl-lane" data-tl-lane="' + esc(lane.key) + '"><div class="tl-label" title="' + esc(lane.label + (lane.note ? " · " + lane.note : "")) + '">' + fieldBadge(lane.badge || lane.label) +
      '<span class="field-section-text"><span class="field-name">' + esc(lane.label) + "</span><small>" + esc(lane.note || timelineKindWords(lane.counts)) + '</small></span><span class="field-chips">' + chips + "</span></div>" +
      '<div class="tl-track">' + bands + upcoming + '<i class="tl-rail"></i>' + links + nowMark + nextMark + '<i class="tl-next-dot" title="' + esc("Next scan, " + nextWhen) + '"></i>' + beads + "</div></div>";
  });
  if (model.lanes.length > lanesShown.length) {
    const rest = model.lanes.length - lanesShown.length;
    html += '<button class="field-more tl-lanes-more" type="button" data-tl-lanes-more>Show ' + esc(Math.min(rest, TL_LANE_LIMIT * 2)) + " more · " +
      esc(plural(rest, prefs.tlLanes === "page" ? "page" : "lane", prefs.tlLanes === "page" ? "pages" : "lanes")) + " not shown</button>";
  }
  html += '<div class="tl-tip" id="tlTip" hidden></div></div>';
  html += renderTimelineStory(model, prefs);
  host.innerHTML = html;
  $("fieldNote").textContent = (prefs.tlLanes === "page" ? "One lane per page. " : "") +
    "Each bead is an update at the time it was found; the line to the next bead on a lane shows how long until the next update came, and the dashed tail runs to the next scan (" + nextWhen + ")." +
    (model.gapMs > 6 * 3600000 ? " At this zoom, updates less than " + timelineSpanWords(model.gapMs) + " apart share a bead." : "") +
    " Select a bead to find it in the story below." + (prefs.tlShow === "all" || prefs.tlShow === "markup" ? " Hollow beads are markup-only edits, which don't count as changes." : "");
}
function renderTimelineStory(model, prefs) {
  if (!model.days.length) return "";
  let budget = prefs.storyLimit || 60;
  let shown = 0, total = 0;
  model.days.forEach(day => { total += day.rows.length; });
  let html = '<section class="tl-story" aria-label="What happened, newest first">';
  model.days.forEach(day => {
    if (budget <= 0) return;
    const rows = day.rows.slice(0, budget);
    budget -= rows.length;
    shown += rows.length;
    const heading = L.dayHeading(day.at);
    html += '<div class="tl-story-day"><h3 class="tl-story-head">' + esc(heading) + (heading === "Today" || heading === "Yesterday" ? "<span>" + esc(new Date(day.at).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })) + "</span>" : "") + "</h3>";
    rows.forEach(row => {
      const time = '<time class="tl-time" datetime="' + esc(new Date(row.at).toISOString()) + '">' + esc(clock(new Date(row.at))) + "</time>";
      if (row.type === "burst") {
        html += '<details class="tl-item tl-burst" data-tl-row="' + esc(row.beadKeys.join(" ")) + '"><summary>' + time + '<i class="tl-dot k-new"></i><span class="tl-item-main"><span class="tl-item-title">' +
          esc(plural(row.count, "new page", "new pages")) + ' saved for the first time</span><span class="tl-item-meta">' + esc(row.laneLabel) + " · one scan · select to list them</span></span></summary>" +
          '<div class="tl-burst-list">' + row.members.map(member => '<button type="button" class="tl-burst-page" data-monitor-id="' + esc(member.pageId) + '" title="' + esc(member.url || "") + '">' + esc(member.title) + "</button>").join("") + "</div></details>";
        return;
      }
      const entry = row.entry;
      const verdict = entry.relevant === true ? '<span class="tl-verdict is-yes">Relevant</span>' : entry.relevant === false ? '<span class="tl-verdict">Not relevant</span>' : "";
      const what = row.repeat ? L.eventLabel(entry.type) + " " + row.repeat + " times this day" : L.eventLabel(entry.type);
      html += '<button type="button" class="tl-item' + (row.kind === "markup" ? " is-quiet" : "") + '" data-tl-row="' + esc(row.beadKeys.join(" ")) + '" data-monitor-id="' + esc(entry.pageId) + '">' + time + '<i class="tl-dot k-' + esc(row.kind) + '"></i>' +
        '<span class="tl-item-main"><span class="tl-item-title">' + esc(entry.title) + '</span><span class="tl-item-meta">' + esc(what) + (!row.repeat && state.timeline && state.timeline.afterById.get(entry.id) ? " · " + esc(state.timeline.afterById.get(entry.id)) : "") + " · " + esc(entry.regulatorLabel || entry.laneLabel) + "</span>" +
        (entry.summary ? '<span class="tl-item-sum">' + esc(entry.summary.length > 260 ? entry.summary.slice(0, 259) + "…" : entry.summary) + "</span>" : "") + "</span>" + verdict + "</button>";
    });
    html += "</div>";
  });
  if (shown < total) html += '<button class="field-more tl-more" type="button" data-tl-more>Show ' + esc(Math.min(60, total - shown)) + " more · " + esc(plural(total - shown, "event", "events")) + " not shown</button>";
  return html + "</section>";
}
function showTimelineTip(bead) {
  const tip = $("tlTip");
  const board = bead && bead.closest(".tl-board");
  if (!tip || !board || !state.timeline) return;
  const [laneKey] = bead.dataset.tlBead.split("|");
  const lane = state.timeline.model.lanes.find(item => item.key === laneKey);
  const found = lane && lane.beads.find(item => item.key === bead.dataset.tlBead);
  if (!found) return;
  const items = found.ids.map(id => state.timeline.entries.get(id)).filter(Boolean);
  const when = new Date(found.first).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + (found.last - found.first > 60000 ? " – " + clock(new Date(found.last)) : "");
  tip.innerHTML = '<div class="tl-tip-when">' + esc(when) + '</div><div class="tl-tip-what">' + esc(timelineKindWords(found.kinds)) + " · " + esc(lane.label) + "</div>" +
    '<ul class="tl-tip-list">' + items.slice(0, 4).map(item => '<li><i class="tl-dot k-' + esc(item.kind) + '"></i>' + esc(item.title) + "</li>").join("") +
    (items.length > 4 ? '<li class="tl-tip-more">and ' + esc(items.length - 4) + " more</li>" : "") + "</ul>";
  tip.hidden = false;
  const b = bead.getBoundingClientRect(), host = board.getBoundingClientRect();
  const width = tip.offsetWidth;
  const left = Math.max(8, Math.min(host.width - width - 8, b.left - host.left + b.width / 2 - width / 2));
  const above = b.top - host.top - tip.offsetHeight - 10;
  tip.style.left = left + "px";
  tip.style.top = (above > 4 ? above : b.bottom - host.top + 10) + "px";
}
function timelineSpanWords(ms) {
  const hours = Math.max(1, Math.round(ms / 3600000));
  if (hours < 36) return plural(hours, "hour", "hours");
  const days = Math.round(hours / 24);
  return days < 14 ? plural(days, "day", "days") : plural(Math.round(days / 7), "week", "weeks");
}
function hideTimelineTip() { const tip = $("tlTip"); if (tip) tip.hidden = true; }
function focusTimelineBead(key) {
  const host = $("timelineView");
  host.querySelectorAll(".tl-bead.is-active, [data-tl-row].is-hit").forEach(el => el.classList.remove("is-active", "is-hit"));
  const bead = host.querySelector('[data-tl-bead="' + CSS.escape(key) + '"]');
  if (bead) bead.classList.add("is-active");
  let rows = Array.from(host.querySelectorAll('[data-tl-row~="' + CSS.escape(key) + '"]'));
  if (!rows.length) {
    // The story is paged; open enough of it to reach these events.
    fieldPrefs().storyLimit = 100000;
    renderMonitoringSignal();
    rows = Array.from(host.querySelectorAll('[data-tl-row~="' + CSS.escape(key) + '"]'));
    const again = host.querySelector('[data-tl-bead="' + CSS.escape(key) + '"]');
    if (again) again.classList.add("is-active");
  }
  rows.forEach(row => row.classList.add("is-hit"));
  if (rows[0]) rows[0].scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
}
function syncFieldTools(counts) {
  const prefs = fieldPrefs();
  document.querySelectorAll("[data-field-lens]").forEach(button => {
    if (!button.closest(".field-lenses")) return;
    const lens = button.dataset.fieldLens;
    button.setAttribute("aria-pressed", String(lens === prefs.lens));
    const count = button.querySelector("[data-lens-count]");
    if (count && counts) count.textContent = String(counts[lens] == null ? "" : counts[lens]);
  });
  const range = $("fieldRange");
  if (range && range.value !== prefs.range) range.value = prefs.range;
  const group = $("fieldGroup");
  if (group && group.value !== prefs.groupBy) group.value = prefs.groupBy;
  document.querySelectorAll("[data-tl-show]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.tlShow === prefs.tlShow)));
  const lanes = $("tlLanes");
  if (lanes && lanes.value !== prefs.tlLanes) lanes.value = prefs.tlLanes;
}
function fieldMatchesQuery(page) {
  const q = String(fieldPrefs().query || "").trim().toLowerCase();
  return !q || [page.title, page.url, page.sourceLabel, page.groupLabel].join(" ").toLowerCase().indexOf(q) >= 0;
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
function windowSpan(column) {
  if (!Number.isFinite(column.start)) return when(new Date(column.at));
  return new Date(column.start).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + ", " + timeOnlyShort(new Date(column.start)) + "–" + timeOnlyShort(new Date(column.end));
}
function columnLabel(column, sourceId) {
  const at = new Date((sourceId && column.sources[sourceId]) || column.at);
  const ran = when(at);
  if (Number.isFinite(column.start)) {
    const span = new Date(column.start).toLocaleDateString([], { weekday: "short" }) + " " + timeOnlyShort(new Date(column.start)) + "–" + timeOnlyShort(new Date(column.end));
    const extras = [];
    if (column.manual) extras.push(plural(column.manual, "manual run", "manual runs"));
    const continuations = column.scans.filter(scan => scan.trigger === "continuation").length;
    if (continuations) extras.push(plural(continuations, "continuation", "continuations"));
    return span + " · " + (sourceId && column.sources[sourceId] ? "scanned " + timeOnlyShort(at) : "not scanned") + (extras.length ? " · " + extras.join(", ") : "");
  }
  if (column.trigger === "scheduled" && column.at - column.slot > 20 * 60000) {
    return "Scheduled " + timeOnlyShort(new Date(column.slot)) + " scan, ran " + ran;
  }
  return triggerWords(column.trigger) + ", " + ran;
}
function stateWords(s) {
  return { on: "content changed", new: "new page, first saved", bad: "couldn't fetch or read", dim: "checked, no change", skip: "no scan reached this source in this window", markup: "checked; markup changed, text the same", none: "not scanned", pending: "next scan" }[s] || s;
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
// The tip under the pointer (mouse), or pinned to a tapped light with its actions
// (touch). It is hidden whenever the field it describes is not on screen: Safari
// sends no pointerleave when the hovered cell is hidden by a view change, so the
// tip must never rely on that event alone.
function hideFieldTip() {
  const tip = $("fieldTip");
  ledField.hover(null);
  if (!tip || tip.hidden) return;
  tip.hidden = true;
  tip.classList.remove("is-pinned");
  tip.innerHTML = "";
}
function showFieldTip(target, x, y, pinned) {
  const tip = $("fieldTip");
  if (!target || state.view !== "overview" || !target.isConnected || !target.getClientRects().length) { hideFieldTip(); return; }
  ledField.hover(target);
  let label = "";
  let detail = "";
  const group = target.dataset.fieldGroup || "";
  if (target.dataset.state === "pending") {
    label = target.dataset.first ? "First scan in progress; it lights green once saved" : pendingWords(state.pendingScan || L.pendingScan(new Date(), [], [])).title;
  } else {
    const column = (state.fieldColumns || []).find(candidate => candidate.id === target.dataset.col);
    label = column ? (target.dataset.source ? columnLabel(column, target.dataset.source) : windowSpan(column)) : "";
    detail = target.dataset.summary || stateWords(target.dataset.state);
    // A monitor on a slower scan schedule is simply not due in most windows.
    if (target.dataset.state === "skip" && target.dataset.source && !L.scanScheduleIsDefault(sourceScanSchedule(target.dataset.source))) {
      detail = "not due in this window; scanned " + scanScheduleWords(target.dataset.source).toLowerCase();
    }
  }
  let actions = "";
  if (pinned) {
    if (target.dataset.monitorId) actions = '<button class="btn btn-primary" type="button" data-tip-open="' + esc(target.dataset.monitorId) + '">Open page</button>';
    else if (group) {
      const shown = group.indexOf("sec:") === 0 || group.indexOf("src:") === 0 ? !fieldPrefs().closed.has(group) : fieldPrefs().open.has(group);
      actions = '<button class="btn" type="button" data-tip-group="' + esc(group) + '">' + (shown ? "Hide these pages" : "Show these pages") + "</button>";
    }
    actions = '<div class="field-tip-actions">' + actions + '<button class="btn btn-quiet" type="button" data-tip-close>Close</button></div>';
  }
  tip.innerHTML = '<strong class="field-tip-title">' + esc(target.dataset.tip) + "</strong><small>" + esc(label) + "</small>" +
    (detail ? "<small>" + esc(detail.replace(/^\w/, ch => ch.toUpperCase())) + "</small>" : "") + actions;
  tip.classList.toggle("is-pinned", !!pinned);
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  if (pinned) {
    const cell = target.getBoundingClientRect();
    const left = Math.min(window.innerWidth - box.width - 10, Math.max(10, cell.left + cell.width / 2 - box.width / 2));
    const above = cell.top - box.height - 10;
    tip.style.left = left + "px";
    tip.style.top = (above > 10 ? above : Math.min(window.innerHeight - box.height - 10, cell.bottom + 10)) + "px";
    return;
  }
  tip.style.left = Math.max(8, Math.min(window.innerWidth - box.width - 12, x + 14)) + "px";
  tip.style.top = (y - box.height - 12 > 8 ? y - box.height - 12 : Math.min(window.innerHeight - box.height - 8, y + 18)) + "px";
}

/* ---------- LED field painter ----------
 * The cells in #signalVisual are transparent hit areas; this paints the lights
 * on a canvas the size of the visible viewport, behind the scrolling grid, and
 * draws only the cells in view. (A canvas as large as the whole grid would
 * exceed Safari's canvas size limit once there are a few hundred rows.) Scanned
 * cells carry a slow drifting wave of warm light; changes, new pages and
 * problems glow in their own colour on top of it. A new scan column drops in as
 * a block. The next-scan column is an empty box with a small 3x3 LED scan head
 * running down it, faster while a scan is actually running. Paused whenever the
 * field is off screen.
 */
const ledField = (() => {
  const canvas = $("fieldCanvas");
  const viewport = $("fieldViewport");
  const stage = $("fieldStage");
  const field = $("signalVisual");
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SNAKE = [0, 1, 2, 5, 4, 3, 6, 7, 8];
  let cells = [], rows = 0, colors = null, dpr = 1, born = {}, seen = null, hoverEl = null, hoverRow = -1, width = 0, height = 0;
  // Backdrop geometry: the pinned label column and header (lights are clipped to
  // the area they leave), one band per day, the section rows and each row's height.
  let clipLeft = 0, clipTop = 0, dayBands = [], sectionBands = [], rowBands = new Map(), gapPx = 3;
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
      lo: get("--idle-lo"), hi: get("--idle-hi"), ink: get("--ink"), accent: get("--accent"),
      light: document.documentElement.getAttribute("data-theme") === "light"
    };
  }
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgba = (c, a) => "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

  function measure() {
    if (!ctx || !viewport || !field) return;
    width = viewport.clientWidth;
    height = viewport.clientHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const now = performance.now();
    const ids = new Set();
    // Positions in the viewport's scrolled content: led -> field -> stage -> viewport.
    const ox = field.offsetLeft + (stage ? stage.offsetLeft : 0);
    const oy = field.offsetTop + (stage ? stage.offsetTop : 0);
    gapPx = parseFloat(getComputedStyle(field).columnGap) || 3;
    const corner = field.querySelector(".field-corner");
    const pulse = field.querySelector(".field-pulse-label");
    // The clip is in the canvas's own (viewport) coordinates. The header and
    // label column are sticky, and a sticky element's offsetTop includes how
    // far it is stuck, so measuring it while scrolled down (after "Show more",
    // say) put the clip below the visible area and blanked every light.
    // Their on-screen edges are where the lights stop, whatever the scroll.
    const frameBox = viewport.getBoundingClientRect();
    const head = pulse || corner;
    clipLeft = corner ? Math.max(0, corner.getBoundingClientRect().right - frameBox.left - viewport.clientLeft) : 0;
    clipTop = head ? Math.max(0, head.getBoundingClientRect().bottom - frameBox.top - viewport.clientTop) : 0;
    dayBands = Array.from(field.querySelectorAll(".field-day:not(.is-next)")).map((el, index) => ({
      x: el.offsetLeft + ox, w: el.offsetWidth, odd: index % 2 === 1, today: el.classList.contains("is-today")
    }));
    sectionBands = Array.from(field.querySelectorAll(".field-section-label")).map(el => ({ y: el.offsetTop + oy, h: el.offsetHeight }));
    rowBands = new Map();
    field.querySelectorAll(".field-label[data-row]").forEach(el => rowBands.set(Number(el.dataset.row), { y: el.offsetTop + oy, h: el.offsetHeight }));
    cells = [];
    rows = 0;
    field.querySelectorAll(".led").forEach(el => {
      if (el.classList.contains("s-none")) return;
      const cell = { el, x: el.offsetLeft + ox, y: el.offsetTop + oy, s: el.offsetWidth, state: el.dataset.state, col: Number(el.dataset.x), row: Number(el.dataset.y), id: el.dataset.col };
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
    wake(true);
  }

  function paintLight(cell, x0, y0, t, now) {
    const delay = (born[cell.id] || 0) + cell.row * 22;
    const p = reduced ? 1 : clamp01((now - delay) / 560);
    if (p <= 0) return;
    const ease = 1 - Math.pow(1 - p, 3);
    const n = L.fbm(cell.col * .26 + t * .22, cell.row * .26 + t * .08, t * .11);
    const w = clamp01((n - .3) / .42);
    const hovered = cell.el === hoverEl;
    const grow = hovered ? 2 : 0;
    const x = x0 - grow, y = y0 - grow - (1 - ease) * 12, s = cell.s + grow * 2;
    let color, alpha = ease, glow = 0;
    if (cell.state === "dim" || cell.state === "markup") {
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

  function paintPending(cell, x, y, t) {
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
      ctx.fillRect(x + pad + (k % 3) * (dot + gap), y + pad + Math.floor(k / 3) * (dot + gap), dot, dot);
    }
    ctx.strokeStyle = rgba(ink, (busy ? .3 : .2) + .3 * boost + (cell.el === hoverEl ? .2 : 0));
    ctx.lineWidth = 1;
    ctx.strokeRect(x + .5, y + .5, cell.s - 1, cell.s - 1);
  }

  // Days alternate in a faint band with a hairline where each starts (today in
  // the accent), section rows get a band of their own, and the hovered row is lit.
  function paintBackdrop(sx, sy) {
    const ink = colors.ink;
    dayBands.forEach(band => {
      const x = band.x - sx;
      if (x > width || x + band.w < clipLeft) return;
      const left = x - gapPx / 2;
      if (band.today) { ctx.fillStyle = rgba(colors.accent, colors.light ? .07 : .09); ctx.fillRect(left, clipTop, band.w + gapPx, height); }
      else if (band.odd) { ctx.fillStyle = rgba(ink, colors.light ? .028 : .035); ctx.fillRect(left, clipTop, band.w + gapPx, height); }
      // The same place as the header's hairline (.field-day::before).
      ctx.fillStyle = band.today ? rgba(colors.accent, .45) : rgba(ink, colors.light ? .09 : .12);
      ctx.fillRect(left - .5, clipTop, 1, height);
    });
    sectionBands.forEach(band => {
      const y = band.y - sy;
      if (y > height || y + band.h < clipTop) return;
      ctx.fillStyle = rgba(ink, colors.light ? .035 : .05);
      ctx.fillRect(clipLeft, y - 2, width, band.h + 4);
      ctx.fillStyle = rgba(ink, colors.light ? .08 : .12);
      ctx.fillRect(clipLeft, y - 2, width, 1);
    });
    const row = rowBands.get(hoverRow);
    if (row) {
      ctx.fillStyle = rgba(colors.accent, colors.light ? .08 : .1);
      ctx.fillRect(clipLeft, row.y - sy, width, row.h);
    }
  }

  // A window no scan reached: a small dot, so the row reads as continuous.
  function paintSkip(cell, x, y) {
    const d = Math.max(2, Math.round(cell.s * .18));
    ctx.fillStyle = rgba(colors.ink, colors.light ? .18 : .22);
    ctx.fillRect(x + (cell.s - d) / 2, y + (cell.s - d) / 2, d, d);
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
      const sx = viewport.scrollLeft, sy = viewport.scrollTop;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipLeft, clipTop, Math.max(0, width - clipLeft), Math.max(0, height - clipTop));
      ctx.clip();
      paintBackdrop(sx, sy);
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const x = cell.x - sx, y = cell.y - sy;
        if (x < -cell.s - 8 || y < -cell.s - 8 || x > width + 8 || y > height + 8) continue;
        if (cell.state === "pending") paintPending(cell, x, y, t);
        else if (cell.state === "skip") paintSkip(cell, x, y);
        else paintLight(cell, x, y, t, now);
      }
      ctx.restore();
      revealed = true;
    }
    if (reduced) return;
    frame = requestAnimationFrame(paint);
  }
  function sleep() {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(wake, 600);
  }
  function wake(force) {
    if (!ctx) return;
    if (frame) { if (!force || !reduced) return; cancelAnimationFrame(frame); frame = 0; }
    clearTimeout(sleepTimer);
    frame = requestAnimationFrame(paint);
  }
  document.addEventListener("visibilitychange", () => wake());
  if (viewport) viewport.addEventListener("scroll", () => { if (reduced) wake(true); }, { passive: true });
  if (typeof MutationObserver === "function") {
    new MutationObserver(() => { colors = null; if (reduced) wake(true); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  return {
    measure,
    hover(el) { hoverEl = el || null; hoverRow = el && el.dataset ? Number(el.dataset.y != null ? el.dataset.y : el.dataset.row) : -1; if (reduced) wake(true); },
    hoverRow(row) { hoverRow = Number.isFinite(row) ? row : -1; if (reduced) wake(true); },
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
  renderChannelBar();

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
  renderHealth();
  renderNotifications();
  renderScout();
  renderCadenceView();
  renderNavCounts();
}
function renderNavCounts() {
  const changes = changeLogEntries().filter(entry => CHANGE_EVENT_TYPES.indexOf(entry.event_type) >= 0).length;
  $("navChangeCount").textContent = changes;
  $("navMonitorCount").textContent = state.items.length;
  const healthCount = $("navHealthCount");
  if (healthCount) {
    const failing = healthTotals().failing || 0;
    healthCount.textContent = failing ? String(failing) : "";
    healthCount.classList.toggle("is-alert", failing > 0);
  }
  const toReview = scoutBuckets().REVIEW.length;
  syncMoreTab();
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
  return (options.back ? '<button class="text-button detail-back" type="button" data-back>' + esc(options.backLabel || "Back to the list") + "</button>" : "") +
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
    const condition = verdict.condition;
    const facts = [["Topic", a.topic], ["Kind of change", a.change_type], ["Impact", a.impact], ["Effective date", a.effective_date], ["Who it affects", a.affected_scope], ["Suggested action", a.actions],
      ["Alert condition", condition ? (condition.met ? "Met: " : "Not met: ") + String(condition.text || "") + (condition.reason ? " (" + String(condition.reason) + ")" : "") : ""]]
      .filter(([, value]) => value && String(value).trim() && !/^not stated$/i.test(String(value).trim()));
    return '<section class="sheet" aria-label="AI assessment"><div class="verdict">' +
      '<div class="verdict-head"><span class="verdict-label">AI assessment</span>' + (verdict.state === "relevant" ? '<span class="tag is-relevant">Relevant</span>' : '<span class="tag is-irrelevant">Not relevant</span>') +
      (condition ? (condition.met ? '<span class="tag is-relevant">Condition met</span>' : '<span class="tag is-irrelevant">Condition not met</span>') : "") + "</div>" +
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
// Saved copies are shown without script, so undo what a site's own script would
// have done on load: hide loading screens and reveal content waiting for an animation.
const SNAPSHOT_REVEAL_CSS = "<style data-cs-reveal>html,body{opacity:1!important;visibility:visible!important;overflow-y:auto!important}" +
  ".async-hide,[data-aos],.aos-init,.wow,.animate__animated,.animated,[data-animate],[data-animation],[data-scroll],[data-sal],.reveal-on-scroll,.js-reveal,.fade-in,.fadeIn,.lazyload,.lazyloading" +
  "{opacity:1!important;visibility:visible!important;transform:none!important;animation:none!important;transition:none!important}" +
  "[id*=preloader],[class*=preloader],[id*=page-loader],[class*=page-loader],[id*=pageloader],[class*=pageloader],[class*=loader-wrapper],[id*=loader-wrapper]," +
  "[class*=loading-overlay],[id*=loading-overlay],[class*=site-loader],[id*=site-loader],[class*=splash-screen],[id*=splash-screen],.pace,#loader,.loader-overlay{display:none!important}</style>";
function previewSource(source, url) {
  source = String(source || "").replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*\/?>/gi, "");
  const baseTag = '<base href="' + esc(url) + '">' + SNAPSHOT_REVEAL_CSS;
  if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, match => match + baseTag);
  return '<!doctype html><html><head><meta charset="utf-8">' + baseTag + "</head><body>" + source + "</body></html>";
}
// The PDF goes truly full screen where the browser allows it (the Fullscreen
// API puts it in the top layer, above every pane); elsewhere, such as iPhone
// Safari, it falls back to a fixed overlay covering the window.
function fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit || !fullscreenElement()) return;
  try { const pending = exit.call(document); if (pending && pending.catch) pending.catch(() => {}); } catch (_) {}
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
  if (expanded) {
    const request = shell.requestFullscreen || shell.webkitRequestFullscreen;
    if (request && fullscreenElement() !== shell) {
      try { const pending = request.call(shell); if (pending && pending.catch) pending.catch(() => {}); } catch (_) {}
    }
  } else if (fullscreenElement() === shell) {
    exitFullscreen();
  }
  if (expanded && closeButton) closeButton.focus();
  if (!expanded && expandButton) expandButton.focus();
}
// Leaving full screen with the browser's own Esc or gesture closes the viewer too.
["fullscreenchange", "webkitfullscreenchange"].forEach(name => document.addEventListener(name, () => {
  const shell = $("pdfViewerShell");
  if (shell && shell.classList.contains("is-expanded") && fullscreenElement() !== shell) setPdfViewerExpanded(false);
}));
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
    (source && source.alert_condition ? '<span class="tag" title="' + esc(conditionSummary(source)) + '">' + esc(source.alert_only_on_condition ? "Alerts only when: " : "Alert me when: ") + esc(String(source.alert_condition).length > 60 ? String(source.alert_condition).slice(0, 59) + "\u2026" : String(source.alert_condition)) + "</span>" : "") +
    (source && !L.scanScheduleIsDefault(sourceScanSchedule(source)) ? '<span class="tag" title="Scan schedule">' + esc(scanScheduleWords(source)) + "</span>" : "") +
    "<span>Checked " + esc(relativeTime(item.last_checked).toLowerCase()) + "</span>" + urlMeta(item.canonical_url);
  const actions = externalLink(item.canonical_url, "Open live page") +
    (snapshotPath ? externalLink(REPO + "/blob/main/" + snapshotPath, savedFileLabel) : "") +
    (item.source_id ? '<button class="btn" type="button" data-run-scan="' + esc(item.source_id) + '" title="Scan this page\'s source now">Scan this source</button>' : "") +
    (conditionEditable(source) ? '<button class="btn" type="button" data-edit-condition="' + esc(source.id) + '" title="Set what should raise an alert for this monitor">' + (source.alert_condition ? "Edit alert condition" : "Alert me when…") + "</button>" : "") +
    (source && source.id && source.active !== false ? '<button class="btn" type="button" data-edit-schedule="' + esc(source.id) + '" title="How often and when this monitor is scanned">Scan schedule</button>' : "") +
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
  exitFullscreen();
  const body = $("detailBody");
  if (state.pdfPreviewUrl) {
    URL.revokeObjectURL(state.pdfPreviewUrl);
    state.pdfPreviewUrl = "";
  }
  const filePath = item.file_snapshot_location || "";
  const fileType = String(item.extraction_type || "").toLowerCase();
  const isFile = filePath && (fileType === "pdf" || fileType === "zip" || fileType === "xlsx");
  const isPdf = fileType === "pdf";
  const previewLabel = isFile ? (isPdf ? "PDF" : fileType === "xlsx" ? "Workbook" : "Archive") : "Rendered page";
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
    // Workbooks and bundles open in the dashboard's own viewers.
    try {
      const bytes = await fetchSnapshotBytes(filePath);
      if (!current() || state.snapshotMode !== "preview") return;
      canvas.innerHTML = '<div class="doc-host doc-host-inline"></div>';
      await renderDocument(canvas.querySelector(".doc-host"), { bytes, name: filePath, title: "The original " + (fileType === "xlsx" ? "workbook" : "bundle") + " as fetched", url: item.canonical_url, alive: current });
    } catch (error) {
      if (current()) canvas.innerHTML = emptyState("Couldn't load the saved file", String(error.message || error) + ". The extracted text may still be available.", externalLink(REPO + "/blob/main/" + filePath, "Saved file"));
    }
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
    ["Alert me when", conditionSummary(source) || "No condition; AI relevance decides"],
    ["Scan schedule", scanScheduleWords(source) + (nextScanWords(item.source_id) ? " · next " + nextScanWords(item.source_id) : "")],
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
      pending.length || sent.length ? "Choose an alert to see what was sent." : "Alerts go to ntfy, Slack, Teams or a webhook when a scan finds a change or a problem."
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
    '<div><dt>' + esc(item.queued ? "Delivered so far" : "Delivered to") + "</dt><dd>" + esc(deliveredChannels(item).map(channelLabel).join(", ") || (item.queued ? "Not yet" : "ntfy")) + "</dd></div>" +
    (item.condition ? "<div><dt>Alert condition</dt><dd>" + esc(item.condition) + "</dd></div>" : "") +
    '<div><dt>Event ID</dt><dd class="is-code">' + esc(item.eventId) + "</dd></div></dl>" +
    (item.queued && deliveredChannels(item).length ? '<p class="note-strip">Already delivered to ' + esc(deliveredChannels(item).map(channelLabel).join(", ")) + ". The next run sends it only to the channels that missed it.</p>" : "") +
    "</section></div>";
}

/* ================= Health: is every monitor still working? =================
 * data/health.json is rebuilt by every scan from committed state (regmon/health.py).
 * The dashboard only reads it; before the first scan that writes it the view
 * explains that it is coming.
 */
const HEALTH_STATUS = {
  failing: { label: "Failing", tone: "problem", order: 0 },
  stale: { label: "Not scanned recently", tone: "pending", order: 1 },
  inactive: { label: "Quiet for weeks", tone: "pending", order: 2 },
  healthy: { label: "Healthy", tone: "ok", order: 3 }
};
function healthTotals() { return state.health && isPlainObject(state.health.totals) ? state.health.totals : {}; }
function healthMonitors() { return state.health && Array.isArray(state.health.monitors) ? state.health.monitors : []; }
function healthKeys() { return ["fleet"].concat(healthMonitors().map(monitor => String(monitor.source_id))); }
function healthYearFlag(sourceId) {
  const flags = state.health && Array.isArray(state.health.year_bound) ? state.health.year_bound : [];
  return flags.find(flag => String(flag.source_id) === String(sourceId)) || null;
}
function healthFailures(sourceId) {
  const rows = state.health && Array.isArray(state.health.failing) ? state.health.failing : [];
  return rows.filter(row => String(row.source_id) === String(sourceId));
}
function healthPercent(value) {
  return typeof value === "number" && isFinite(value) ? (Math.round(value * 1000) / 10).toLocaleString() + "%" : "—";
}
function healthNumber(value) { return typeof value === "number" && isFinite(value) ? value.toLocaleString() : "0"; }
// Days are counted from the last content change, or from when monitoring
// started for a monitor that has never changed.
function healthDays(monitor) {
  const days = monitor.days_without_change;
  if (!monitor.last_change) return typeof days === "number" && days > 0 ? "No change since it was added " + plural(days, "day", "days") + " ago" : "No change since it was added";
  return typeof days === "number" ? (days === 0 ? "Changed today" : "Last changed " + plural(days, "day", "days") + " ago") : "Last change not recorded";
}
function healthRowSummary(monitor, light) {
  if (monitor.status === "failing") { const f = healthFailures(String(monitor.source_id))[0]; return f ? f.error : "Failing"; }
  if (monitor.status === "stale") return "Overdue · last saved scan " + (monitor.last_scan ? relativeTime(monitor.last_scan).toLowerCase() : "not recorded") + (monitor.cadence && monitor.cadence.every_hours > 6 ? " · " + monitor.cadence.label.toLowerCase() : "");
  const checks = Number(monitor.checks_7d || 0), failed = Number(monitor.failures_7d || 0);
  const checkWords = failed ? failed + " of " + checks + " checks failed this week" : checks ? "All " + checks + " checks ok this week" : "Not checked this week";
  if (light === "on" || light === "warn") return checkWords + " · " + healthDays(monitor).replace(/^No change since it was added/, "never changed");
  return checkWords + " · " + (monitor.last_change ? healthDays(monitor).toLowerCase() : "never changed");
}
const HEALTH_LIST_GROUPS = [
  ["attention", "Needs attention", ["bad", "stale"]], ["recovered", "Recovered this week", ["warn"]],
  ["changed", "Changed this week", ["on"]], ["quiet", "Quiet for weeks", ["quiet"]], ["ok", "Healthy", ["ok"]]
];
function healthRow(monitor, light) {
  const key = String(monitor.source_id);
  const tone = { bad: "problem", stale: "pending", quiet: "pending", warn: "pending", on: "change", ok: "ok" }[light] || "ok";
  const year = healthYearFlag(key);
  return '<button class="row hx-row" type="button" data-select-health="' + esc(key) + '"' + (key === state.selectedHealthKey ? ' aria-selected="true"' : "") + ">" +
    '<span class="row-mark hx-row-mark l-' + esc(light) + ' tone-' + tone + '" aria-hidden="true"></span>' +
    '<span class="row-title">' + esc(healthName(monitor)) + "</span>" +
    '<span class="row-time">' + esc(monitor.last_scan ? relativeTime(monitor.last_scan).replace(/ ago$/, "") : "") + "</span>" +
    '<span class="row-summary">' + esc(healthRowSummary(monitor, light)) + "</span>" +
    ((year || monitor.alert_condition || Number(monitor.pages) > 1) ? '<span class="row-sub">' + (Number(monitor.pages) > 1 ? '<span class="tag">' + esc(plural(Number(monitor.pages), "page", "pages")) + "</span>" : "") +
      (year ? '<span class="tag">Year ' + esc(year.years.join(", ")) + " in address</span>" : "") +
      (monitor.alert_condition ? '<span class="tag">Alert condition</span>' : "") + "</span>" : "") +
    "</button>";
}
function renderHealth() {
  const list = $("healthItems");
  if (!list) return;
  const totals = healthTotals();
  $("healthCount").textContent = state.health ? (totals.failing ? totals.failing + " failing" : "All monitors working") : "";
  if (!state.health) {
    list.innerHTML = emptyState("Health appears after the next scan", "Every scan writes data/health.json. Once the first one has run, failing, stale and quiet monitors are listed here.");
    list.dataset.rendered = "";
    return;
  }
  const fleetSelected = state.selectedHealthKey === "fleet" || !state.selectedHealthKey;
  const week = state.health.last_7_days || {};
  let html = '<button class="row" type="button" data-select-health="fleet"' + (fleetSelected ? ' aria-selected="true"' : "") + ">" +
    '<span class="row-mark tone-' + (totals.failing ? "problem" : "ok") + '" aria-hidden="true"></span>' +
    '<span class="row-title">All monitors</span><span class="row-time">' + esc(healthPercent(week.success_rate)) + "</span>" +
    '<span class="row-summary">' + esc(healthNumber(totals.monitors) + " monitors, " + healthNumber(week.checks) + " checks and " + healthNumber(week.alerts_sent) + " alerts in 7 days") + "</span></button>";
  const now = Date.now();
  const lit = healthMonitors().map(monitor => ({ monitor, light: L.healthLight(monitor, now) }));
  HEALTH_LIST_GROUPS.forEach(([, label, lights]) => {
    const rows = lit.filter(entry => lights.indexOf(entry.light) >= 0).sort((a, b) => healthName(a.monitor).localeCompare(healthName(b.monitor)));
    if (!rows.length) return;
    html += '<div class="list-group-label">' + esc(label) + " <span>(" + rows.length + ")</span></div>" + rows.map(entry => healthRow(entry.monitor, entry.light)).join("");
  });
  // Lists are redrawn while page titles load; an unchanged list is left in
  // place so its rows do not replay their entrance animation.
  if (list.dataset.rendered !== html) { list.innerHTML = html; list.dataset.rendered = html; }
}
// Daily checks as bars (failed checks in red inside them), content changes
// as lit dots along the top. Hovering or focusing a day shows its numbers.
function healthChart(days) {
  if (!Array.isArray(days) || !days.length) return "";
  const compact = isCompact();
  const width = compact ? 360 : 640, height = compact ? 190 : 176, padX = compact ? 34 : 40, padTop = 34, padBottom = 22, gap = compact ? 3 : 4;
  const max = Math.max(1, ...days.map(day => Number(day.checks || 0)));
  const nice = Math.pow(10, Math.floor(Math.log10(max))) * ([1, 2, 2.5, 5, 10].find(step => step * Math.pow(10, Math.floor(Math.log10(max))) >= max) || 10);
  const bar = (width - padX * 2 - gap * (days.length - 1)) / days.length;
  const y = value => height - padBottom - (value / nice) * (height - padTop - padBottom);
  const grid = [0, .5, 1].map(f => '<line class="hc-grid" x1="' + padX + '" x2="' + (width - padX) + '" y1="' + y(nice * f).toFixed(1) + '" y2="' + y(nice * f).toFixed(1) + '"/>' +
    '<text class="hc-tick" x="' + (padX - 6) + '" y="' + (y(nice * f) + 3).toFixed(1) + '">' + esc(Math.round(nice * f).toLocaleString()) + "</text>").join("");
  const labelEvery = Math.max(1, Math.ceil(days.length / (compact ? 7 : 10)));
  const bars = days.map((day, index) => {
    const x = padX + index * (bar + gap);
    const checks = Number(day.checks || 0), failed = Number(day.failed_checks || 0), changes = Number(day.changes || 0);
    const last = index === days.length - 1;
    return '<g class="hc-day-group' + (last ? " is-today" : "") + '" data-hc-i="' + index + '" tabindex="0">' +
      '<rect class="hc-hit" x="' + (x - gap / 2).toFixed(1) + '" y="0" width="' + (bar + gap).toFixed(1) + '" height="' + height + '"/>' +
      '<rect class="hc-bar" x="' + x.toFixed(1) + '" y="' + y(checks).toFixed(1) + '" width="' + bar.toFixed(1) + '" height="' + Math.max(0, height - padBottom - y(checks)).toFixed(1) + '" rx="2"/>' +
      (failed ? '<rect class="hc-fail" x="' + x.toFixed(1) + '" y="' + y(failed).toFixed(1) + '" width="' + bar.toFixed(1) + '" height="' + Math.max(1.5, height - padBottom - y(failed)).toFixed(1) + '" rx="2"/>' : "") +
      (changes ? '<circle class="hc-change" cx="' + (x + bar / 2).toFixed(1) + '" cy="' + (padTop - 22) + '" r="' + Math.min(5.5, 2.5 + Math.log2(1 + changes)).toFixed(1) + '"/>' : "") +
      (failed ? '<rect class="hc-fail-mark" x="' + (x + bar / 2 - 3).toFixed(1) + '" y="' + (padTop - 12) + '" width="6" height="6" rx="1.2"/>' : "") +
      ((days.length - 1 - index) % labelEvery === 0 ? '<text class="hc-day" x="' + (x + bar / 2).toFixed(1) + '" y="' + (height - 6) + '">' + esc(String(day.date).slice(8).replace(/^0/, "")) + "</text>" : "") +
      "</g>";
  }).join("");
  return '<figure class="health-chart" data-hc-days="' + esc(JSON.stringify(days.map(day => [day.date, Number(day.checks || 0), Number(day.failed_checks || 0), Number(day.changes || 0), Number(day.alerts_sent || 0)]))) + '">' +
    '<svg viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="Checks per day for the last ' + days.length + ' days">' + grid +
    '<line class="hc-axis" x1="' + padX + '" x2="' + (width - padX) + '" y1="' + (height - padBottom) + '" y2="' + (height - padBottom) + '"/>' + bars + "</svg>" +
    '<div class="hx-tip hc-tip" hidden></div>' +
    '<figcaption><span><i class="hc-key-bar"></i>Checks</span><span><i class="hc-key-fail"></i>A day with failed checks</span><span><i class="hc-key-change"></i>Content changes</span></figcaption></figure>';
}
function showHealthChartTip(group) {
  const figure = group.closest(".health-chart");
  const tip = figure && figure.querySelector(".hc-tip");
  if (!tip) return;
  let days = [];
  try { days = JSON.parse(figure.dataset.hcDays || "[]"); } catch (_) { days = []; }
  const day = days[Number(group.dataset.hcI)];
  if (!day) return;
  const [date, checks, failed, changes, alerts] = day;
  figure.querySelectorAll(".hc-day-group.is-hot").forEach(el => el.classList.remove("is-hot"));
  group.classList.add("is-hot");
  const rate = checks ? Math.round((1 - failed / checks) * 1000) / 10 : null;
  tip.innerHTML = '<div class="hx-tip-when">' + esc(new Date(date + "T12:00:00Z").toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" })) + "</div>" +
    '<dl class="hx-tip-grid"><dt>Checks</dt><dd>' + esc(checks.toLocaleString()) + "</dd><dt>Succeeded</dt><dd>" + esc(rate == null ? "—" : rate + "%") + "</dd>" +
    '<dt><i class="hx-key is-bad"></i>Failed</dt><dd>' + esc(failed) + '</dd><dt><i class="hx-key is-on"></i>Changes</dt><dd>' + esc(changes) + "</dd><dt>Alerts sent</dt><dd>" + esc(alerts) + "</dd></dl>";
  tip.hidden = false;
  // Beside the day, not over it, so its bar and change dot stay visible.
  const fb = figure.getBoundingClientRect(), gb = group.getBoundingClientRect();
  const right = gb.right - fb.left + 8;
  const left = right + tip.offsetWidth <= fb.width - 4 ? right : Math.max(4, gb.left - fb.left - tip.offsetWidth - 8);
  tip.style.left = left + "px";
  tip.style.top = "8px";
}
// Expected page checks in each six-hour scan slot over the next week, from
// every monitor's scan schedule: the fleet's load before it happens.
function healthScheduleSheet(health) {
  const load = health && health.schedule_load;
  const slots = load && Array.isArray(load.slots) ? load.slots : [];
  if (!slots.length) return "";
  const compact = isCompact();
  const width = compact ? 360 : 640, height = compact ? 150 : 140, padX = compact ? 34 : 40, padTop = 14, padBottom = 22, gap = 2;
  const max = Math.max(1, ...slots.map(slot => Number(slot.pages || 0)));
  const bar = (width - padX * 2 - gap * (slots.length - 1)) / slots.length;
  const y = value => height - padBottom - (value / max) * (height - padTop - padBottom);
  const busiest = load.busiest && Number(load.busiest.pages) ? load.busiest : null;
  const bars = slots.map((slot, index) => {
    const x = padX + index * (bar + gap);
    const at = new Date(slot.at);
    const pages = Number(slot.pages || 0), monitors = Number(slot.monitors || 0);
    const label = at.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) + ": " + plural(monitors, "monitor", "monitors") + ", " + plural(pages, "page", "pages");
    return '<g class="hc-day-group' + (busiest && slot.at === busiest.at ? " is-today" : "") + '"><title>' + esc(label) + "</title>" +
      '<rect class="hc-bar" x="' + x.toFixed(1) + '" y="' + y(pages).toFixed(1) + '" width="' + bar.toFixed(1) + '" height="' + Math.max(pages ? 1.5 : 0, height - padBottom - y(pages)).toFixed(1) + '" rx="1.5"/>' +
      (at.getUTCHours() === 0 ? '<text class="hc-day" x="' + (x + bar * 2).toFixed(1) + '" y="' + (height - 6) + '">' + esc(at.toLocaleDateString([], { weekday: "short" })) + "</text>" : "") + "</g>";
  }).join("");
  const grid = [0, 1].map(f => '<line class="hc-grid" x1="' + padX + '" x2="' + (width - padX) + '" y1="' + y(max * f).toFixed(1) + '" y2="' + y(max * f).toFixed(1) + '"/>' +
    '<text class="hc-tick" x="' + (padX - 6) + '" y="' + (y(max * f) + 3).toFixed(1) + '">' + esc(Math.round(max * f).toLocaleString()) + "</text>").join("");
  const mix = (load.by_cadence || []).map(entry => '<span class="chip is-static">' + esc(entry.label) + " · " + esc(entry.monitors) + "</span>").join("");
  return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Scan schedule, next 7 days</h3><span class="sheet-note">' +
    esc(Math.round(Number(load.page_checks_per_day || 0)).toLocaleString() + " page checks a day · one bar per 6-hour scan slot") + "</span></div>" +
    '<figure class="health-chart"><svg viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + esc("Pages checked per scan slot over the next 7 days; busiest slot " + (busiest ? busiest.pages + " pages" : "empty")) + '">' + grid +
    '<line class="hc-axis" x1="' + padX + '" x2="' + (width - padX) + '" y1="' + (height - padBottom) + '" y2="' + (height - padBottom) + '"/>' + bars + "</svg>" +
    '<figcaption><span><i class="hc-key-bar"></i>Pages checked in the slot</span>' + (busiest ? '<span>Busiest: ' + esc(new Date(busiest.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) + ", " + plural(Number(busiest.pages), "page", "pages")) + "</span>" : "") + "</figcaption></figure>" +
    (mix ? '<div class="schedule-mix">' + mix + "</div>" : "") + "</section>";
}
function healthSameWindow(a, b) {
  return !!a && !!b && Number(a.checks) === Number(b.checks) && Number(a.changes) === Number(b.changes) && Number(a.alerts_sent) === Number(b.alerts_sent);
}
function healthTiles(window, label) {
  const w = window || {};
  const tiles = [
    ["Checks", healthNumber(w.checks), plural(Number(w.source_runs || 0), "monitor run", "monitor runs")],
    ["Success rate", healthPercent(w.success_rate), healthNumber(w.failed_checks) + " failed"],
    ["Content changes", healthNumber(w.changes), "Changed or removed pages"],
    ["Alerts sent", healthNumber(w.alerts_sent), "Test alerts excluded"]
  ];
  return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">' + esc(label) + '</h3></div><div class="health-tiles">' +
    tiles.map(([name, value, note]) => '<div class="health-tile"><div class="health-tile-label">' + esc(name) + '</div><div class="health-tile-value">' + esc(value) + '</div><div class="health-tile-note">' + esc(note) + "</div></div>").join("") +
    "</div></section>";
}
function itemForSource(sourceId) { return state.items.find(item => item.source_id === sourceId) || null; }
function renderHealthDetail() {
  state.detailKeys.health = detailRenderKey("health");
  const pane = $("healthDetail");
  if (!pane) return;
  if (!state.health) {
    pane.innerHTML = '<div class="detail-inner">' + emptyState("No health data yet", "The next scan writes data/health.json. Nothing about monitoring changes; this view only reads it.") + "</div>";
    return;
  }
  const health = state.health;
  const totals = healthTotals();
  const key = state.selectedHealthKey || "fleet";
  if (key === "fleet") {
    const failing = Array.isArray(health.failing) ? health.failing : [];
    pane.innerHTML = '<div class="detail-inner health-detail">' +
      detailHeading({ back: true, backLabel: "Every monitor, one by one", source: "Fleet health", title: "All monitors", meta: "<span>Updated " + esc(relativeTime(health.generated_at).toLowerCase()) + "</span>" }) +
      healthHero(health) +
      healthInsightSheet(health) +
      healthMatrix(health) +
      '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Daily activity</h3><span class="sheet-note">Last ' + esc(String((health.daily || []).length)) + " days, UTC · " + (isCompact() ? "tap" : "hover") + " a day</span></div>" + healthChart(health.daily) + "</section>" +
      healthScheduleSheet(health) +
      (failing.length ? '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Failing now</h3></div>' + failing.map(row =>
        '<button class="row" type="button" data-select-health="' + esc(row.source_id) + '"><span class="row-mark tone-problem" aria-hidden="true"></span>' +
        '<span class="row-title">' + esc(row.name || row.source_id) + '</span><span class="row-time">' + esc(row.since ? relativeTime(row.since) : "") + "</span>" +
        '<span class="row-summary">' + esc(row.error || "") + "</span></button>").join("") + "</section>" : "") +
      (healthSameWindow(health.last_7_days, health.last_30_days) ? "" : healthTiles(health.last_30_days, "Last 30 days")) +
      '<p class="note-strip">' + (healthSameWindow(health.last_7_days, health.last_30_days) ? "History so far covers under a week, so the 30-day totals match the 7-day ones. " : "") + 'An error alerts only after it has failed ' + esc(plural(Number((state.config.defaults || {}).error_alert_after_runs || 1), "scan", "consecutive scans")) +
      ". Health is rebuilt from the committed scan history after every scan and never changes what is monitored.</p></div>";
    return;
  }
  const monitor = healthMonitors().find(candidate => String(candidate.source_id) === key);
  if (!monitor) { pane.innerHTML = '<div class="detail-inner">' + emptyState("Select a monitor", "Choose a monitor to see its health.") + "</div>"; return; }
  const status = HEALTH_STATUS[monitor.status] || HEALTH_STATUS.healthy;
  const source = configuredSources().find(candidate => candidate.id === key) || {};
  const item = itemForSource(key);
  const year = healthYearFlag(key);
  const failures = healthFailures(key);
  const facts = [
    ["Pages and documents", healthNumber(monitor.pages)],
    ["Last saved scan", monitor.last_scan ? fmt(monitor.last_scan) : "Not recorded"],
    ["Last content change", monitor.last_change ? fmt(monitor.last_change) : "None recorded"],
    ["Alert me when", source.alert_condition ? source.alert_condition + (source.alert_only_on_condition ? " (alerts only when met)" : "") : "No condition; AI relevance decides"],
    ["Scan schedule", (monitor.cadence && monitor.cadence.label) || scanScheduleWords(source)],
    ["Next scan", nextScanWords(key) || "Not recorded"]
  ];
  const actions = (item ? '<button class="btn" type="button" data-monitor-id="' + esc(item.url_id) + '">Open page</button>' : "") +
    '<button class="btn" type="button" data-run-scan="' + esc(key) + '">Scan this source</button>' +
    (source.id && source.active !== false ? '<button class="btn" type="button" data-edit-schedule="' + esc(key) + '">Scan schedule</button>' : "") +
    (conditionEditable(source) ? '<button class="btn" type="button" data-edit-condition="' + esc(key) + '">' + (source.alert_condition ? "Edit alert condition" : "Add alert condition") + "</button>" : "");
  const failureSheet = failures.length ? '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">What is failing</h3></div><dl class="facts">' + failures.map(row =>
    "<div><dt>" + esc(row.kind === "FETCH_ERROR" ? "Couldn't fetch" : "Couldn't read content") + '</dt><dd>' + esc(row.error || "") +
    '<br><span class="health-sub">' + esc((row.since ? "Since " + fmt(row.since) : "") + (row.runs ? " · " + plural(row.runs, "failing scan", "failing scans") : "")) + "</span>" +
    (safeHttpUrl(row.url) ? '<br><span class="health-sub is-code">' + esc(displayUrl(row.url)) + "</span>" : "") + "</dd></div>").join("") +
    '</dl><p class="note-strip">The last good copy is kept as the baseline while this lasts.</p></section>' : "";
  const yearSheet = year ? '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Year in the address</h3></div><p class="note-strip">This address carries ' +
    esc(year.years.join(", ")) + " and has not changed for " + esc(typeof year.days_without_change === "number" ? plural(year.days_without_change, "day", "days") : "a while") +
    ". Regulators often publish the next year's list at a new address" + (healthNextYearUrl(year.url, year.years) ? ", for example <span class=\"is-code\">" + esc(displayUrl(healthNextYearUrl(year.url, year.years))) + "</span>" : "") +
    ". Check the regulator's site and add the new page if it exists.</p></section>" : "";
  pane.innerHTML = '<div class="detail-inner health-detail">' +
    detailHeading({ back: true, source: "Monitor health", title: healthName(monitor) || key, meta: '<span class="tag tone-' + status.tone + '">' + esc(status.label) + "</span>" +
      (monitor.status !== "failing" && Number(monitor.failures_7d) > 0 ? '<span class="tag tone-pending">Recovered · ' + esc(plural(Number(monitor.failures_7d), "failure", "failures")) + " this week</span>" : "") +
      "<span>" + esc(healthRegulator(monitor).name || monitor.regulator || "") + "</span>", actions }) +
    healthMonitorPulse(monitor, health) + failureSheet + yearSheet + healthPageStrip(key) +
    '<section class="sheet"><dl class="facts">' + facts.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl></section></div>";
}
// Monitor names carry file details ("(XLSX, 2.81 MB)") and scope notes that
// are noise in a sentence or a tooltip title.
function healthName(monitor) {
  return String((monitor && (monitor.name || monitor.source_id)) || "")
    .replace(/\s*\((?:PDF|XLSX?|ZIP|CSV|XML|DOCX?|HTML)[^)]*\)/gi, "").replace(/\s*\([^)]*allowlist[^)]*\)/gi, "").trim();
}
function healthRegulator(monitor) {
  const item = itemForSource(String(monitor.source_id));
  const regulator = item ? itemRegulator(item) : null;
  return regulator && regulator.short ? { key: regulator.id || regulator.short, short: regulator.short, name: regulator.name || regulator.short }
    : { key: String(monitor.regulator || "other"), short: String(monitor.regulator || "Other"), name: String(monitor.regulator || "Other") };
}
// A week dial: seven arcs round a ring, one per day clockwise from the top,
// today last. Each is lit in proportion to that day's count; a day whose
// checks failed is lit red. Hover an arc for its day.
function healthDial(days, field, cls, words) {
  const list = (days || []).slice(-7);
  if (!list.length) return "";
  const values = list.map(day => Number(day[field]) || 0);
  const max = Math.max(1, ...values);
  const c = 22, r = 17, step = 360 / list.length, gap = list.length > 1 ? 7 : 0;
  const point = deg => { const rad = (deg - 90) * Math.PI / 180; return (c + r * Math.cos(rad)).toFixed(2) + " " + (c + r * Math.sin(rad)).toFixed(2); };
  const arc = index => { const from = index * step + gap / 2, to = (index + 1) * step - gap / 2; return "M" + point(from) + " A" + r + " " + r + " 0 " + (to - from > 180 ? 1 : 0) + " 1 " + point(to); };
  const arcs = list.map((day, index) => {
    const value = values[index];
    const failed = field === "checks" && Number(day.failed_checks) > 0;
    const date = new Date(String(day.date) + "T12:00:00");
    const label = (Number.isFinite(date.getTime()) ? date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + ": " : "") + words(day);
    return '<path class="hx-dial-track" d="' + arc(index) + '"><title>' + esc(label) + "</title></path>" +
      (value ? '<path class="hx-dial-arc' + (failed ? " is-bad" : "") + (index === list.length - 1 ? " is-today" : "") + '" d="' + arc(index) + '" style="opacity:' + (.32 + .68 * value / max).toFixed(2) + '"><title>' + esc(label) + "</title></path>" : "");
  }).join("");
  return '<svg class="hx-dial ' + cls + '" viewBox="0 0 44 44" role="img" aria-label="' + esc("Last " + list.length + " days, " + list.map(words).join("; ")) + '">' + arcs + '<text class="hx-dial-text" x="22" y="22">' + esc(list.length + "d") + "</text></svg>";
}
// The headline: the week's success rate, what that means in words, and the
// three week numbers with a dial of their last seven days.
function healthHero(health) {
  const totals = healthTotals();
  const week = health.last_7_days || {};
  const daily = (health.daily || []).slice(-14);
  const rate = typeof week.success_rate === "number" ? week.success_rate : null;
  const tone = totals.failing ? "bad" : totals.stale || totals.inactive ? "warn" : "ok";
  const headline = totals.failing ? plural(totals.failing, "monitor failing", "monitors failing") + " of " + healthNumber(totals.monitors)
    : totals.stale ? plural(totals.stale, "monitor overdue", "monitors overdue") + " for a scan"
    : "All " + healthNumber(totals.monitors) + " monitors healthy";
  const pending = state.pendingScan ? pendingWords(state.pendingScan) : null;
  const scans = healthMonitors().map(m => new Date(m.last_scan).getTime()).filter(Number.isFinite);
  const lastScan = scans.length ? Math.max(...scans) : null;
  const stat = (label, value, dial, note) => '<div class="hx-stat">' + dial + '<div class="hx-stat-label">' + esc(label) + '</div><span class="hx-stat-value num">' + esc(value) + '</span><div class="hx-stat-note">' + esc(note) + "</div></div>";
  // The same lit squares as the scan cycle bar: one per thirtieth of the
  // week's checks, red for the share that failed (at least one if any did).
  const segments = 30;
  const failedShare = rate == null ? 0 : Number(week.failed_checks) > 0 ? Math.max(1, Math.round((1 - rate) * segments)) : 0;
  const leds = Array.from({ length: segments }, (_, i) => '<i class="' + (rate == null ? "" : i >= segments - failedShare ? "is-bad" : "is-ok") + '" style="--i:' + i + '"></i>').join("");
  return '<section class="hx-hero tone-' + tone + '">' +
    '<div class="hx-score"><div class="hx-score-label">Checks ok, last 7 days</div><div class="hx-score-value num">' + esc(rate == null ? "—" : (Math.round(rate * 1000) / 10).toString()) + "<small>%</small></div>" +
      '<div class="hx-score-leds" role="img" aria-label="' + esc((rate == null ? "No" : healthPercent(rate)) + " of checks succeeded in the last 7 days") + '">' + leds + "</div></div>" +
    '<div class="hx-hero-text"><div class="hx-kicker"><i class="hx-pulse"></i>Fleet status</div><div class="hx-headline">' + esc(headline) + "</div>" +
      '<div class="hx-sub">' + esc([lastScan ? "Last scan " + relativeTime(lastScan).toLowerCase() : "", healthNextScanWords(state.pendingScan), healthNumber(totals.pages) + " pages and documents"].filter(Boolean).join(" · ")) + "</div></div>" +
    '<div class="hx-stats">' +
      stat("Checks, 7 days", healthNumber(week.checks), healthDial(daily, "checks", "is-ink", d => plural(Number(d.checks) || 0, "check", "checks") + (Number(d.failed_checks) ? ", " + d.failed_checks + " failed" : "")), healthNumber(week.failed_checks) + " failed") +
      stat("Changes", healthNumber(week.changes), healthDial(daily, "changes", "is-on", d => plural(Number(d.changes) || 0, "change", "changes")), "pages changed") +
      stat("Alerts sent", healthNumber(week.alerts_sent), healthDial(daily, "alerts_sent", "is-accent", d => plural(Number(d.alerts_sent) || 0, "alert", "alerts")), "tests excluded") +
    "</div></section>";
}
function healthNextScanWords(pending) {
  if (!pending) return "";
  if (pending.phase === "waiting") return "next scan in " + L.formatDuration(pending.remainingMinutes);
  if (pending.phase === "late") return "next scan due " + timeOnlyShort(pending.due) + ", not started yet";
  if (pending.phase === "due") return "next scan due now";
  return pending.phase === "running" ? "a scan is running now" : pending.phase === "queued" ? "a scan is queued" : "saving the latest scan";
}
function healthInsightSheet(health) {
  const byId = new Map(healthMonitors().map(m => [String(m.source_id), m]));
  const insights = L.healthInsights(health, {
    nameOf: healthName,
    dayLabel: date => new Date(date + "T12:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })
  });
  if (!insights.length) return "";
  return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">What stands out</h3><span class="sheet-note">From this week\'s scans</span></div><ul class="hx-insights">' +
    insights.map(insight => {
      const target = (insight.targets || []).find(id => byId.has(id));
      const body = '<i class="hx-dot is-' + esc(insight.tone) + '" aria-hidden="true"></i><span>' + esc(insight.text) + "</span>";
      return "<li>" + (target ? '<button type="button" class="hx-insight" data-select-health="' + esc(target) + '">' + body + '<span class="hx-go" aria-hidden="true">›</span></button>' : '<div class="hx-insight">' + body + "</div>") + "</li>";
    }).join("") + "</ul></section>";
}
const HEALTH_LIGHT_WORDS = { bad: "Failing", stale: "Overdue for a scan", quiet: "Quiet for weeks", on: "Changed this week", warn: "Recovered from failures", ok: "Healthy" };
// Every monitor as one light, grouped by regulator: the whole fleet at a glance.
function healthMatrix(health) {
  const monitors = healthMonitors();
  if (!monitors.length) return "";
  const groups = new Map();
  monitors.forEach(monitor => {
    const regulator = healthRegulator(monitor);
    if (!groups.has(regulator.key)) groups.set(regulator.key, { regulator, monitors: [] });
    groups.get(regulator.key).monitors.push(monitor);
  });
  const rank = { bad: 0, stale: 1, warn: 2, quiet: 3, on: 4, ok: 5 };
  const now = Date.now();
  const used = new Set();
  const body = Array.from(groups.values()).sort((a, b) => b.monitors.length - a.monitors.length || a.regulator.short.localeCompare(b.regulator.short)).map(group => {
    const lights = group.monitors.map(monitor => ({ monitor, light: L.healthLight(monitor, now) }))
      .sort((a, b) => rank[a.light] - rank[b.light] || healthName(a.monitor).localeCompare(healthName(b.monitor)));
    lights.forEach(entry => used.add(entry.light));
    const pages = group.monitors.reduce((sum, m) => sum + Number(m.pages || 0), 0);
    const issues = lights.filter(entry => entry.light === "bad" || entry.light === "stale").length;
    const recovered = lights.filter(entry => entry.light === "warn").length;
    return '<div class="hx-group"><div class="hx-group-head">' + fieldBadge(group.regulator.short) + '<span class="hx-group-name" title="' + esc(group.regulator.name) + '">' + esc(group.regulator.short) + "</span>" +
      '<small>' + esc(plural(group.monitors.length, "monitor", "monitors") + " · " + plural(pages, "page", "pages")) + (issues ? ' · <b class="is-bad">' + esc(plural(issues, "needs a look", "need a look")) + "</b>" : "") + (recovered ? ' · <b class="is-warn">' + esc(recovered + " recovered") + "</b>" : "") + "</small></div>" +
      '<div class="hx-cells">' + lights.map((entry, index) => '<button type="button" class="hx-cell l-' + entry.light + '" style="--i:' + index + '" data-select-health="' + esc(entry.monitor.source_id) + '" data-hx="' + esc(entry.monitor.source_id) + '" aria-label="' +
        esc(healthName(entry.monitor) + ": " + HEALTH_LIGHT_WORDS[entry.light]) + '"></button>').join("") + "</div></div>";
  }).join("");
  const legend = ["bad", "stale", "warn", "quiet", "on", "ok"].filter(light => used.has(light) || light === "ok").map(light => '<span><i class="hx-cell l-' + light + ' is-key"></i>' + esc(HEALTH_LIGHT_WORDS[light]) + "</span>").join("");
  return '<section class="sheet hx-matrix-sheet"><div class="sheet-head"><h3 class="sheet-title">Every monitor</h3><span class="sheet-note">' + esc(plural(monitors.length, "light", "lights")) + ", one per monitor · " + (isCompact() ? "tap one to open it" : "hover for details") + "</span></div>" +
    '<div class="hx-matrix">' + body + '<div class="hx-tip hx-matrix-tip" hidden></div></div><div class="hx-legend">' + legend + "</div></section>";
}
function showHealthCellTip(cell) {
  const host = cell.closest(".hx-matrix");
  const tip = host && host.querySelector(".hx-matrix-tip");
  const monitor = healthMonitors().find(m => String(m.source_id) === cell.dataset.hx);
  if (!tip || !monitor) return;
  const light = L.healthLight(monitor);
  tip.innerHTML = '<div class="hx-tip-when"><i class="hx-dot is-' + esc(light === "quiet" || light === "stale" ? "warn" : light) + '"></i>' + esc(HEALTH_LIGHT_WORDS[light]) + "</div>" +
    '<div class="hx-tip-title">' + esc(healthName(monitor)) + "</div>" +
    '<dl class="hx-tip-grid"><dt>Pages</dt><dd>' + esc(healthNumber(monitor.pages)) + "</dd><dt>Last scan</dt><dd>" + esc(monitor.last_scan ? relativeTime(monitor.last_scan).toLowerCase() : "—") + "</dd>" +
    "<dt>Checks, 7 days</dt><dd>" + esc(healthNumber(monitor.checks_7d)) + (Number(monitor.failures_7d) ? ' <span class="is-bad">· ' + esc(monitor.failures_7d) + " failed</span>" : "") + "</dd>" +
    "<dt>Content</dt><dd>" + esc(healthDays(monitor)) + "</dd></dl>";
  tip.hidden = false;
  const hb = host.getBoundingClientRect(), cb = cell.getBoundingClientRect();
  const left = Math.max(4, Math.min(hb.width - tip.offsetWidth - 4, cb.left - hb.left + cb.width / 2 - tip.offsetWidth / 2));
  const above = cb.top - hb.top - tip.offsetHeight - 8;
  tip.style.left = left + "px";
  tip.style.top = (above >= 0 ? above : cb.bottom - hb.top + 8) + "px";
}
function hideHealthTips() { document.querySelectorAll("#healthDetail .hx-tip").forEach(tip => { tip.hidden = true; }); document.querySelectorAll("#healthDetail .hc-day-group.is-hot").forEach(el => el.classList.remove("is-hot")); }
// One monitor: checks this week as a success meter, and how close it is to
// the quiet mark.
function healthMonitorPulse(monitor, health) {
  const checks = Number(monitor.checks_7d || 0), failed = Number(monitor.failures_7d || 0);
  const rate = checks ? (checks - failed) / checks : null;
  const quietAfter = Number((health.thresholds || {}).inactive_after_days) || 45;
  const days = Number(monitor.days_without_change || 0);
  const quiet = Math.min(1, days / quietAfter);
  return '<section class="sheet hx-pulse-sheet"><div class="hx-meters">' +
    '<div class="hx-meter"><div class="hx-meter-head"><span>Checks ok, 7 days</span><b class="num">' + esc(rate == null ? "—" : healthPercent(rate)) + '</b></div>' +
      '<div class="hx-bar"><i class="hx-bar-ok" style="width:' + (rate == null ? 0 : rate * 100).toFixed(1) + '%"></i><i class="hx-bar-bad" style="width:' + (rate == null ? 0 : (1 - rate) * 100).toFixed(1) + '%"></i></div>' +
      '<div class="hx-meter-note">' + esc(healthNumber(checks) + " checks · " + plural(failed, "failure", "failures")) + "</div></div>" +
    '<div class="hx-meter"><div class="hx-meter-head"><span>Days unchanged</span><b class="num">' + esc(days) + '<small> / ' + esc(quietAfter) + '</small></b></div>' +
      '<div class="hx-bar"><i class="hx-bar-quiet' + (quiet >= 1 ? " is-full" : quiet >= .7 ? " is-near" : "") + '" style="width:' + (quiet * 100).toFixed(1) + '%"></i></div>' +
      '<div class="hx-meter-note">' + esc(quiet >= 1 ? "Counted as quiet; check the page still lives at this address" : "Flagged as quiet at " + quietAfter + " days") + "</div></div>" +
    "</div></section>";
}
// The monitor's pages over the last seven days, one light per scan window,
// in the same colours as the scan history.
function healthPageStrip(sourceId) {
  const items = (state.items || []).filter(item => item.source_id === sourceId);
  if (!items.length) return "";
  const columns = L.fieldWindow(L.slotColumns(state.history, { workflowRuns: state.workflowRuns }), "7d", new Date());
  if (!columns.length) return "";
  const events = allEvents();
  const shown = items.slice(0, 24);
  const rows = shown.map(item => {
    const page = fieldPage(item, events);
    const cells = columns.map(column => {
      const s = L.columnCellState(column, page);
      const words = s === "skip" && !L.scanScheduleIsDefault(sourceScanSchedule(sourceId)) ? "not due; scanned " + scanScheduleWords(sourceId).toLowerCase() : stateWords(s);
      return '<i class="hx-led s-' + esc(s) + '" title="' + esc(windowSpan(column) + ": " + words) + '"></i>';
    }).join("");
    return '<button type="button" class="hx-strip-row' + (shown.length === 1 ? " is-single" : "") + '" data-monitor-id="' + esc(item.url_id) + '"><span class="hx-strip-name">' + esc(shown.length === 1 ? "Open the page" : itemTitle(item)) + '</span><span class="hx-strip-cells" style="--n:' + columns.length + '">' + cells + "</span></button>";
  }).join("");
  return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Last 7 days, scan by scan</h3><span class="sheet-note">' + esc(plural(columns.length, "scan window", "scan windows")) + " · newest on the right</span></div>" +
    '<div class="hx-strip">' + rows + "</div>" + (items.length > shown.length ? '<p class="note-strip">' + esc(plural(items.length - shown.length, "more page", "more pages")) + " in this monitor; see Pages.</p>" : "") + "</section>";
}
function healthNextYearUrl(url, years) {
  const year = Math.max(...(years || []));
  if (!url || !isFinite(year)) return "";
  const next = String(new Date().getUTCFullYear());
  return String(url).replace(new RegExp("(^|[^0-9])" + year + "(?![0-9])", "g"), "$1" + next);
}

/* ================= Alert conditions ("Alert me when …") =================
 * Stored per monitor in config/sources.json. The dashboard cannot write config:
 * editing opens a prefilled request that the owner-only workflow applies.
 */
function conditionEditable(source) {
  if (!source || !source.id || source.active === false) return false;
  const seeds = Array.isArray(source.seed_urls) ? source.seed_urls : [];
  const depth = Number(source.crawl_depth == null ? 0 : source.crawl_depth);
  return seeds.length === 1 && depth >= 0 && depth <= 3;
}
function conditionSummary(source) {
  if (!source || !source.alert_condition) return "";
  return source.alert_condition + (source.alert_only_on_condition ? " (alerts only when met)" : "");
}
function openConditionDialog(sourceId) {
  const source = configuredSources().find(candidate => candidate.id === sourceId);
  if (!conditionEditable(source)) { showToast("Alert conditions can be set on monitors that watch one page."); return; }
  state.pendingCondition = sourceId;
  let host = "";
  try { host = new URL(source.seed_urls[0]).hostname.replace(/^www\./, ""); } catch (_) {}
  $("conditionTarget").textContent = (source.name || source.id) + (host ? " · " + host : "");
  $("conditionTarget").title = source.seed_urls[0];
  $("conditionText").value = source.alert_condition || "";
  $("conditionOnly").checked = !!source.alert_only_on_condition;
  $("conditionClear").hidden = !source.alert_condition;
  renderConditionSuggestions(source);
  $("conditionDialog").showModal();
}
// Starting points shaped like the requests regulatory reporting teams make;
// the owner edits or replaces them. Nothing is generated from the page itself.
function conditionSuggestions(source) {
  const url = String((source.seed_urls || [])[0] || "").toLowerCase();
  const list = [];
  if (/\.(pdf|docx?|xlsx?|zip)(\?|$)/.test(url)) list.push("A field, schedule, instruction or validation rule in this document changes", "The effective date or reporting period changes");
  else list.push("A new document, form or user guide is added to this page", "An existing document is replaced with a new version", "A reporting deadline or effective date changes");
  list.push("A requirement, threshold or reporting scope changes");
  return list;
}
function renderConditionSuggestions(source) {
  $("conditionSuggestions").innerHTML = conditionSuggestions(source).map(text => '<button class="chip" type="button" data-condition-suggestion="' + esc(text) + '">' + esc(text) + "</button>").join("");
}
function submitCondition(clear) {
  const source = configuredSources().find(candidate => candidate.id === state.pendingCondition);
  if (!conditionEditable(source)) { $("conditionDialog").close(); return; }
  const condition = clear ? "" : $("conditionText").value.replace(/\s+/g, " ").trim().slice(0, 500);
  const only = !clear && $("conditionOnly").checked;
  if (!clear && !condition) { showToast("Describe what should raise an alert, or use Remove condition."); return; }
  const target = makeGitHubIssueUrl(source.seed_urls[0], source.name || "", source.include_selector || "", (source.ignore_selectors || []).filter(Boolean),
    Number(source.crawl_depth || 0), false, { condition, only, clear: !!clear });
  $("conditionDialog").close();
  openGitHubRequest(target, clear
    ? "Submit the prefilled request on GitHub to remove this monitor's alert condition."
    : "Submit the prefilled request on GitHub. The condition applies from the next scan.");
}

/* ================= Scan schedule (per-monitor cadence) =================
 * Stored per monitor in config/sources.json (check_every_hours, check_days,
 * check_hours, check_timezone) and read by regmon/schedule.py. The dialog
 * edits one monitor or many (a preset); like every settings change it opens a
 * prefilled request that the owner-only Update Monitor Settings workflow applies.
 */
const SCAN_ZONES = ["UTC", "America/New_York", "America/Chicago", "America/Toronto", "America/Mexico_City", "America/Bogota", "America/Lima",
  "America/Santiago", "America/Sao_Paulo", "America/Argentina/Buenos_Aires", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin",
  "Europe/Madrid", "Europe/Zurich", "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo", "Australia/Sydney"];
const SCAN_DAY_WORDS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
function sourceScanSchedule(sourceOrId) {
  const source = typeof sourceOrId === "string" ? configuredSources().find(candidate => candidate.id === sourceOrId) : sourceOrId;
  return L.scanSchedule(source || {});
}
function scanScheduleWords(sourceOrId) { return L.scanScheduleLabel(sourceScanSchedule(sourceOrId)); }
function healthMonitorFor(sourceId) { return healthMonitors().find(monitor => String(monitor.source_id) === String(sourceId)) || null; }
// "Next scan 18:00 Tue" from the engine's own answer in health.json.
function nextScanWords(sourceId) {
  const monitor = healthMonitorFor(sourceId);
  if (!monitor || !monitor.next_due) return "";
  const due = new Date(monitor.next_due);
  if (!Number.isFinite(due.getTime())) return "";
  if (due.getTime() <= Date.now()) return "due in the current scan window";
  return due.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + ", " + timeOnlyShort(due) + " window";
}
function scanDialogState() {
  const mode = (document.querySelector("[data-scan-days][aria-pressed='true']") || {}).dataset || {};
  const picked = Array.from(document.querySelectorAll("[data-scan-day][aria-pressed='true']")).map(button => button.dataset.scanDay);
  const days = mode.scanDays === "weekdays" ? L.SCAN_BUSINESS_DAYS.slice() : mode.scanDays === "custom" ? L.SCAN_WEEKDAYS.filter(day => picked.indexOf(day) >= 0) : L.SCAN_WEEKDAYS.slice();
  const windowOn = $("scanWindowOn").checked;
  return {
    every: Number($("scanEvery").value) || 6,
    days,
    hours: windowOn ? [Number($("scanFrom").value), Number($("scanUntil").value)] : null,
    timezone: $("scanZone").value || "UTC"
  };
}
function setScanDayMode(mode) {
  document.querySelectorAll("[data-scan-days]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.scanDays === mode)));
  $("scanDayPicks").hidden = mode !== "custom";
}
function renderScanPreview() {
  const schedule = scanDialogState();
  const zoneNeeded = schedule.days.length !== 7 || !!schedule.hours;
  $("scanZoneRow").hidden = !zoneNeeded;
  $("scanWindow").hidden = !schedule.hours;
  const problems = [];
  if (!schedule.days.length) problems.push("Pick at least one day.");
  if (schedule.hours && schedule.hours[1] - schedule.hours[0] < 6) problems.push("A window must span at least six hours, or it could miss every scan slot.");
  const slots = problems.length ? [] : L.scanSlots(schedule, Date.now(), 7);
  const checks = slots.filter(slot => slot.due).length;
  const pages = (state.pendingScanSchedule || []).reduce((sum, id) => sum + Math.max(1, Number((healthMonitorFor(id) || {}).pages) || 1), 0);
  // One column per day, four lights per day (the 00, 06, 12 and 18 UTC slots),
  // lit where a scan would run: the scan field's LED language at week scale.
  const byDay = [];
  slots.forEach((slot, index) => { const day = Math.floor(index / 4); (byDay[day] = byDay[day] || []).push(slot); });
  const week = byDay.map(daySlots => {
    const label = new Date(daySlots[0].at).toLocaleDateString([], { weekday: "short" });
    return '<div class="scan-week-day"><span class="scan-week-slots">' + daySlots.map(slot => '<i class="' + (slot.due ? "is-on" : "") + '" title="' +
      esc(new Date(slot.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) + (slot.due ? ": scan" : ": not scheduled")) + '"></i>').join("") + "</span>" + esc(label) + "</div>";
  }).join("");
  $("scanPreview").innerHTML = problems.length
    ? '<div class="scan-preview-head"><b>' + esc(problems[0]) + "</b></div>"
    : '<div class="scan-preview-head"><b>' + esc(L.scanScheduleLabel(schedule)) + "</b><span>" + esc(plural(checks, "scan", "scans") + " in the next 7 days" +
        (pages > 1 ? " · about " + Math.round(checks * pages / 7).toLocaleString() + " page checks a day" : "")) + "</span></div>" +
      '<div class="scan-week" role="img" aria-label="' + esc(plural(checks, "scan", "scans") + " in the next 7 days") + '">' + week + "</div>";
  const submit = $("scanScheduleForm").querySelector("[type=submit]");
  if (submit) submit.disabled = !!problems.length;
}
function openScanSchedule(ids) {
  const list = Array.from(new Set((ids || []).filter(id => configuredSources().some(source => source.id === id && source.active !== false))));
  if (!list.length) { showToast("Choose at least one active monitor."); return; }
  state.pendingScanSchedule = list;
  const first = configuredSources().find(source => source.id === list[0]) || {};
  const schedules = list.map(id => sourceScanSchedule(id));
  const same = schedules.every(schedule => L.scanScheduleLabel(schedule) === L.scanScheduleLabel(schedules[0]));
  const schedule = same ? schedules[0] : L.scanSchedule({});
  $("scanScheduleTarget").textContent = list.length === 1 ? (first.name || first.id) + " · currently " + L.scanScheduleLabel(schedule).toLowerCase()
    : plural(list.length, "monitor", "monitors") + (same ? " · currently " + L.scanScheduleLabel(schedule).toLowerCase() : " with different schedules");
  $("scanEvery").value = String(schedule.every);
  const hourOptions = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => '<option value="' + (from + i) + '">' + String(from + i).padStart(2, "0") + ":00</option>").join("");
  $("scanFrom").innerHTML = hourOptions(0, 23);
  $("scanUntil").innerHTML = hourOptions(1, 24);
  $("scanFrom").value = String(schedule.hours ? schedule.hours[0] : 8);
  $("scanUntil").value = String(schedule.hours ? schedule.hours[1] : 18);
  $("scanWindowOn").checked = !!schedule.hours;
  const zones = SCAN_ZONES.indexOf(schedule.timezone) >= 0 ? SCAN_ZONES : [schedule.timezone].concat(SCAN_ZONES);
  $("scanZone").innerHTML = zones.map(zone => '<option value="' + esc(zone) + '">' + esc(zone.replace(/_/g, " ")) + "</option>").join("");
  $("scanZone").value = schedule.timezone;
  $("scanDayPicks").innerHTML = L.SCAN_WEEKDAYS.map(day => '<button class="chip" type="button" data-scan-day="' + day + '" aria-pressed="' + (schedule.days.indexOf(day) >= 0) + '">' + SCAN_DAY_WORDS[day] + "</button>").join("");
  setScanDayMode(schedule.days.length === 7 ? "all" : schedule.days.join() === L.SCAN_BUSINESS_DAYS.join() ? "weekdays" : "custom");
  renderScanPreview();
  $("scanScheduleDialog").showModal();
}
function submitScanSchedule(reset) {
  const ids = state.pendingScanSchedule || [];
  const schedule = reset ? L.scanSchedule({}) : scanDialogState();
  const requests = L.settingsRequests(L.scanSchedulePayload(ids, schedule), "scan schedule → " + L.scanScheduleLabel(schedule));
  if (!requests.length) return;
  $("scanScheduleDialog").close();
  requests.slice(1).forEach(request => {
    const params = new URLSearchParams(); params.set("title", request.title); params.set("body", request.body);
    window.open(REPO + "/issues/new?" + params.toString(), "_blank");
  });
  const params = new URLSearchParams(); params.set("title", requests[0].title); params.set("body", requests[0].body);
  openGitHubRequest(REPO + "/issues/new?" + params.toString(), (requests.length > 1 ? "Submit each of the " + requests.length + " prefilled requests on GitHub." : "Submit the prefilled request on GitHub.") +
    " The new schedule applies from the next scheduled scan.");
}

/* ================= Alert channels ================= */
const CHANNEL_LABELS = { ntfy: "ntfy", slack: "Slack", teams: "Microsoft Teams", webhook: "Webhook" };
function channelLabel(name) { return CHANNEL_LABELS[name] || String(name || ""); }
// Webhook URLs are GitHub secrets the dashboard never sees, so the channels in
// use are read from the delivery ledger: what recent alerts were delivered to.
function channelSummary() {
  const recent = Object.values(notificationMap(state.notifications, "sent_events"))
    .filter(item => item && typeof item === "object" && item.kind !== "TEST")
    .sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0)).slice(0, 25);
  const seen = new Set();
  recent.forEach(item => (Array.isArray(item.channels) && item.channels.length ? item.channels : ["ntfy"]).forEach(name => seen.add(name)));
  return Array.from(seen).sort((a, b) => Object.keys(CHANNEL_LABELS).indexOf(a) - Object.keys(CHANNEL_LABELS).indexOf(b));
}
function deliveredChannels(item) {
  if (item.queued) return isPlainObject(item.delivered_channels) ? Object.keys(item.delivered_channels) : [];
  return Array.isArray(item.channels) && item.channels.length ? item.channels : ["ntfy"];
}
function renderChannelBar() {
  const bar = $("channelBar");
  if (!bar) return;
  const channels = channelSummary();
  bar.innerHTML = '<span class="channel-label">Delivering to</span>' +
    (channels.length ? channels.map(name => '<span class="chip is-static">' + esc(channelLabel(name)) + "</span>").join("") : '<span class="channel-none">No delivery recorded yet</span>') +
    '<button class="chip chip-add" type="button" data-channel-guide title="Add Slack, Teams or a webhook">' + icon("plus") + "Add channel</button>";
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
    if (state.scoutStrongOnly && L.scoutStrength(assessment).level < 3) return false;
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
// Three small lights: how strongly Scout's evidence points the way it judged.
function scoutMeter(assessment) {
  const strength = L.scoutStrength(assessment);
  return '<span class="scout-meter is-' + strength.tone + '" title="' + esc(strength.label) + '" aria-label="' + esc(strength.label) + '">' +
    [1, 2, 3].map(level => "<i" + (level <= strength.level ? ' class="on"' : "") + "></i>").join("") + "</span>";
}
function scoutGroupBy() {
  if (state.scoutGroupBy) return state.scoutGroupBy;
  return state.scoutFilter === "BACKLOG" || state.scoutFilter === "EXCLUDED" ? "kind" : "date";
}
function scoutRow(item) {
  const assessment = item.assessment || {};
  const outcome = L.SCOUT_OUTCOMES[assessment.outcome] || L.SCOUT_OUTCOMES.uncertain;
  const regulator = scoutRegulator(item.regulator_id);
  const monitored = scoutIsMonitored(item);
  const dismissed = item.decision && item.decision.decision === "dismissed";
  const type = assessment.publication_type ? assessment.publication_type.label : "";
  const published = scoutPublished(item);
  const time = published ? shortDate(published.value) : rowTime(item.first_seen);
  const by = scoutGroupBy();
  const statusTag = monitored ? '<span class="tag is-relevant">Monitoring</span>'
    : dismissed ? '<span class="tag is-irrelevant">Dismissed</span>'
    : state.scoutFilter === "REVIEW" || state.scoutFilter === "EXCLUDED" ? '<span class="tag ' + outcome.tag + '">' + esc(outcome.label) + "</span>" : "";
  const meta = [by === "kind" ? "" : type, by === "regulator" ? "" : regulator.short_name, assessment.format && assessment.format !== "Web page" ? assessment.format : ""].filter(Boolean);
  const picked = state.scoutPicked.has(item.key);
  const locked = monitored || dismissed;
  return '<div class="scout-item' + (picked ? " is-picked" : "") + '">' +
    (locked ? "" : '<label class="scout-check"><input type="checkbox" data-scout-pick="' + esc(item.key) + '"' + (picked ? " checked" : "") +
      ' aria-label="' + esc("Select " + (item.title || item.url)) + '"><i aria-hidden="true"></i></label>') +
    '<button class="row scout-row" type="button" data-scout-key="' + esc(item.key) + '"' + (item.key === state.selectedScoutKey ? ' aria-selected="true"' : "") + ">" +
    scoutMeter(assessment) +
    '<span class="row-title">' + esc(item.title || displayUrl(item.url)) + "</span>" +
    '<span class="row-time">' + esc(time) + "</span>" +
    '<span class="row-sub">' + statusTag + '<span class="row-host">' + esc(meta.join(" · ")) + "</span></span></button></div>";
}
const SCOUT_GROUP_PREVIEW = 4;
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
    const badge = button.querySelector(".num");
    if (badge) badge.textContent = count ? String(count) : "";
  });
  document.querySelectorAll("[data-scout-group-by]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.scoutGroupBy === scoutGroupBy())));
  $("scoutStrongOnly").checked = !!state.scoutStrongOnly;
  const toReview = buckets.REVIEW.length;
  $("scoutCount").textContent = state.scoutFilter === "REVIEW" ? (toReview ? toReview + " to review" : "")
    : plural(items.length, "page", "pages");
  renderScoutBulk();
  if (!state.scoutReview) {
    $("scoutItems").innerHTML = emptyState("Scout data unavailable", "The Scout files could not be loaded. Monitoring is unaffected; press Reload to try again.");
    $("scoutDigest").hidden = true;
    return;
  }
  if (!items.length) {
    $("scoutDigest").hidden = true;
    const copy = SCOUT_FILTER_COPY[state.scoutFilter];
    const notRun = !state.scoutLatest || state.scoutLatest.status === "NOT_RUN";
    const filtered = $("scoutSearch").value.trim() || state.scoutStrongOnly || state.scoutFormatFilter !== "ALL";
    $("scoutItems").innerHTML = state.scoutFilter === "REVIEW" && notRun
      ? emptyState("Scout hasn't swept yet", "The first weekly sweep records what each regulator already publishes. Pages published after it appear here.",
        '<button class="btn" type="button" data-scout-coverage>See what Scout covers</button>')
      : emptyState((filtered ? "No findings match" : copy[0]), (filtered ? "Try a different search or filter." : copy[1]));
    return;
  }
  // A one-line digest first: how many, from how many regulators, how strong.
  const regulators = new Set(items.map(item => item.regulator_id));
  const strong = items.filter(item => L.scoutStrength(item.assessment).level === 3).length;
  $("scoutDigest").hidden = false;
  $("scoutDigest").innerHTML = "<strong>" + esc(plural(items.length, "page", "pages")) + "</strong> from " + esc(plural(regulators.size, "regulator", "regulators")) +
    (strong && strong < items.length ? " · " + esc(strong) + " with strong evidence" : strong ? " · all with strong evidence" : "");
  const groups = L.scoutGroups(items, scoutGroupBy(), id => scoutRegulator(id).short_name);
  // Long lists open as a digest: each group shows its first few pages until opened.
  const digest = items.length > 30 && groups.length > 1;
  const omitted = state.scoutReview.omitted_backlog || {};
  $("scoutItems").innerHTML = groups.map(group => {
    const open = !digest || state.scoutOpenGroups.has(group.key);
    const shown = open ? group.items : group.items.slice(0, SCOUT_GROUP_PREVIEW);
    const free = group.items.filter(item => !scoutIsMonitored(item) && !(item.decision && item.decision.decision === "dismissed"));
    const allPicked = free.length && free.every(item => state.scoutPicked.has(item.key));
    return '<div class="scout-group">' +
      '<button class="scout-group-head" type="button" data-scout-group="' + esc(group.key) + '"' + (digest ? ' aria-expanded="' + String(open) + '"' : "") + ">" +
        (digest ? '<span class="field-chevron" aria-hidden="true"></span>' : "") + '<span class="scout-group-name">' + esc(group.label) + '</span><span class="num">' + esc(group.items.length) + "</span></button>" +
      (free.length ? '<button class="text-button scout-group-pick" type="button" data-scout-group-pick="' + esc(group.key) + '">' + (allPicked ? "Clear" : "Select all") + "</button>" : "") +
      "</div>" + shown.map(scoutRow).join("") +
      (shown.length < group.items.length ? '<button class="scout-more" type="button" data-scout-group="' + esc(group.key) + '">Show all ' + esc(group.items.length) + "</button>" : "");
  }).join("") + (state.scoutFilter === "BACKLOG" && Object.keys(omitted).length
    ? '<p class="note-strip">The backlog shows the newest relevant pages per regulator. ' +
      esc(Object.entries(omitted).map(([id, count]) => scoutRegulator(id).short_name + " has " + count + " more").join("; ")) + " in Scout's registry.</p>"
    : "");
}
// Several findings at once: monitor them through the Add a link checklist, or
// record them as not relevant in one owner-approved request.
const SCOUT_BULK_DISMISS_LIMIT = 30;
function scoutPickedItems() {
  return Array.from(state.scoutPicked.keys()).map(key => scoutCandidates().find(item => item.key === key)).filter(Boolean)
    .filter(item => !scoutIsMonitored(item) && !(item.decision && item.decision.decision === "dismissed"));
}
function renderScoutBulk() {
  const bar = $("scoutBulk");
  const picked = scoutPickedItems();
  bar.hidden = !picked.length;
  if (!picked.length) return;
  $("scoutBulkCount").textContent = plural(picked.length, "page", "pages") + " selected";
  const dismiss = bar.querySelector('[data-scout-bulk="dismiss"]');
  dismiss.disabled = picked.length > SCOUT_BULK_DISMISS_LIMIT;
  dismiss.title = picked.length > SCOUT_BULK_DISMISS_LIMIT ? "Up to " + SCOUT_BULK_DISMISS_LIMIT + " pages per request" : "";
}
function scoutBulk(action) {
  const picked = scoutPickedItems();
  if (action === "clear" || !picked.length) { state.scoutPicked = new Map(); return renderScout(); }
  if (action === "dismiss") {
    if (picked.length > SCOUT_BULK_DISMISS_LIMIT) { showToast("Select up to " + SCOUT_BULK_DISMISS_LIMIT + " pages per request."); return; }
    openScoutDecision("dismiss", picked);
    return;
  }
  if (action === "monitor") {
    const a = state.add;
    addClearDraft();
    a.origin = "scout";
    a.url = picked[0].url;
    a.candidates = picked.map(item => addItem({ url: item.url, title: item.title, format: (item.assessment || {}).format === "PDF" ? "PDF" : "",
      section: ((item.assessment || {}).publication_type || {}).label || "", parentUrl: (item.evidence || {}).parent_url || "",
      parentTitle: "Scout · " + scoutRegulator(item.regulator_id).short_name })).filter(Boolean);
    a.candidates.forEach(item => a.picked.set(item.key, item));
    addSaveDraft();
    const dialog = $("addMonitorDialog");
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    addGoto("review");
    state.scoutPicked = new Map();
    renderScout();
  }
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
  const strength = L.scoutStrength(a);
  const dims = [
    ["Kind of page", a.publication_type ? a.publication_type.label : "Not recognised"],
    ["Topics", (a.topics || []).join(", ") || "None recognised"],
    ["Format", a.format || "Web page"],
    ["Dated", published ? shortDate(published.value) + " (" + (published.source === "listing" ? "listing text" : published.source === "page" ? "page metadata" : "feed") + ")" : "No date given"],
    ["Last modified", evidence.lastmod ? shortDate(evidence.lastmod) + " (site map)" : ""]
  ].filter(([, value]) => value);
  const reasons = (a.reasons || []).map(reason =>
    '<li class="' + (reason.effect === "+" ? "is-plus" : reason.effect === "-" ? "is-minus" : "is-neutral") + '"><span class="scout-signal-mark" aria-hidden="true">' +
      (reason.effect === "+" ? "+" : reason.effect === "-" ? "−" : "~") + "</span><span>" + esc(reason.text) + "</span>" +
      (reason.source ? "<small>" + esc(reason.source) + "</small>" : "") + "</li>").join("");
  return '<section class="sheet scout-why" aria-label="Why Scout surfaced this page"><div class="verdict">' +
    '<div class="verdict-head"><span class="verdict-label">Why Scout surfaced it</span><span class="tag ' + outcome.tag + '">' + esc(outcome.label) + "</span>" +
    '<span class="scout-strength">' + scoutMeter(a) + esc(strength.label) + "</span></div>" +
    '<p class="verdict-summary">' + esc(L.scoutSentence(a)) + "</p>" +
    (reasons ? '<ul class="scout-signals" aria-label="Signals">' + reasons + "</ul>" : "") +
    '<dl class="verdict-grid">' + dims.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl>" +
    '<p class="verdict-caveat">Scout judges from titles, link text, listing text and addresses, not the full document, and it never rejects a page for lack of evidence. Look at the page below before deciding.</p>' +
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
  return '<details class="sheet scout-evidence"><summary class="sheet-head"><h3 class="sheet-title">Evidence Scout recorded</h3><span class="sheet-note">What the regulator’s channel said about this address</span></summary>' +
    '<dl class="facts">' + facts + "</dl>" +
    '<p class="note-strip">“First seen” is when Scout first noticed the address. It is not proof of when the regulator published it.</p></details>';
}
// A live look at the finding without leaving the dashboard: the page itself, or
// the listing page it was found on with the link marked. Read through the same
// page reader as Add a link and shown in the same opaque-origin sandbox.
function scoutPreviewShell(item) {
  const evidence = item.evidence || {};
  const p = state.scoutPreview;
  const isDocument = L.pickFormat(item.url) !== "Web page" || /^(PDF|ZIP)$/i.test(String((item.assessment || {}).format || ""));
  const mode = p.mode === "source" && evidence.parent_url ? "source" : "page";
  const address = mode === "source" ? evidence.parent_url : item.url;
  return '<section class="sheet scout-preview' + (p.expanded ? " is-expanded" : "") + '" id="scoutPreview" aria-label="Preview">' +
    '<div class="sheet-head scout-preview-head">' +
      '<div class="segmented" role="group" aria-label="Preview">' +
        '<button type="button" data-scout-preview="page" aria-pressed="' + String(mode === "page") + '">' + (isDocument ? "The document" : "The page") + "</button>" +
        (evidence.parent_url ? '<button type="button" data-scout-preview="source" aria-pressed="' + String(mode === "source") + '">Where Scout found it</button>' : "") +
      "</div>" +
      '<span class="scout-preview-tools">' +
        '<button class="sheet-link" type="button" data-scout-preview-back hidden>Back</button>' +
        '<button class="sheet-link scout-device" type="button" data-scout-device aria-pressed="' + String(p.device === "phone") + '" title="Show the page at phone width">Phone width</button>' +
        '<button class="sheet-link" type="button" data-scout-expand>' + (p.expanded ? "Close" : "Expand") + "</button>" +
        '<a class="sheet-link" id="scoutPreviewOpen" href="' + esc(safeHttpUrl(address) || "#") + '" target="_blank" rel="noopener noreferrer">Open' + icon("external") + "</a>" +
      "</span></div>" +
    '<p class="scout-preview-address" id="scoutPreviewAddress">' + esc(displayUrl(address)) + "</p>" +
    '<div class="scout-preview-stage' + (p.device === "phone" ? " is-phone" : "") + '">' +
      '<iframe id="scoutPreviewFrame" title="Preview of the page Scout found" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>' +
      '<div class="explore-status" id="scoutPreviewStatus" role="status" aria-live="polite"><div class="loading">Preparing the preview…</div></div>' +
    "</div></section>";
}
let scoutPreviewTimer = 0;
function scoutPreviewStatus(html) {
  const box = $("scoutPreviewStatus");
  if (box) box.innerHTML = html || "";
}
function scoutPreviewLoad(item, url, options) {
  const o = options || {};
  const p = state.scoutPreview;
  clearTimeout(scoutPreviewTimer);
  const token = ++p.serial;
  p.key = item.key;
  const target = safeHttpUrl(url);
  if (!target) { scoutPreviewStatus(emptyState("No address to preview", "Scout recorded no address here.")); return; }
  if ($("scoutPreviewAddress")) $("scoutPreviewAddress").textContent = displayUrl(target);
  if ($("scoutPreviewOpen")) $("scoutPreviewOpen").href = target;
  const back = document.querySelector("[data-scout-preview-back]");
  if (back) back.hidden = !p.trail.length;
  scoutDocumentHost(false);
  if (!PAGE_READER_ENDPOINT) { scoutPreviewStatus(emptyState("Preview isn't set up", "The page reader isn't configured for this dashboard. Open the page in a new tab instead.")); return; }
  if (L.pickFormat(target) !== "Web page") { scoutDocumentLoad(item, target, token, o.immediate); return; }
  scoutPreviewStatus('<div class="loading">Reading ' + esc(displayUrl(target)) + "…</div>");
  // A short pause, so moving through the list with the arrow keys doesn't read every page on the way.
  scoutPreviewTimer = setTimeout(async () => {
    let data;
    try {
      data = await addReadPage(target);
    } catch (error) {
      if (token !== p.serial) return;
      scoutPreviewStatus(emptyState("This page couldn't be shown here", String(error.message || error) + ". You can still open it in a new tab.",
        '<button class="btn" type="button" data-scout-preview-retry>Try again</button>'));
      return;
    }
    if (token !== p.serial || !$("scoutPreviewFrame")) return;
    if (data.kind === "document") { scoutDocumentLoad(item, safeHttpUrl(data.url) || target, token, true); return; }
    if (data.kind !== "page") {
      scoutPreviewStatus(emptyState("The site didn't return the page", (data.message || "No page came back.") + " Open it in a new tab to check.",
        '<button class="btn" type="button" data-scout-preview-retry>Try again</button>'));
      return;
    }
    p.page = data;
    p.token = exploreRandom(16);
    p.locate = o.locate || "";
    $("scoutPreviewFrame").srcdoc = exploreDocument(data.html, p.token, exploreRandom(18));
    scoutPreviewStatus("");
  }, o.immediate ? 0 : 320);
}
// A document finding (PDF, workbook, Word, CSV, ZIP) opens in the dashboard's own viewer.
function scoutDocumentHost(show) {
  const stage = document.querySelector(".scout-preview-stage");
  if (!stage) return null;
  let host = stage.querySelector(".doc-host");
  if (show && !host) { host = document.createElement("div"); host.className = "doc-host"; stage.appendChild(host); }
  if (host) host.hidden = !show;
  stage.classList.toggle("has-doc", !!show);
  return host;
}
function scoutDocumentLoad(item, url, token, immediate) {
  const p = state.scoutPreview;
  scoutPreviewStatus('<div class="loading">Opening the document…</div>');
  clearTimeout(scoutPreviewTimer);
  scoutPreviewTimer = setTimeout(async () => {
    let data;
    try {
      data = await readDocumentFile(url);
    } catch (error) {
      if (token !== p.serial) return;
      scoutPreviewStatus(emptyState("This document couldn't be opened here", String(error.message || error) + ". You can still open it in a new tab.",
        '<button class="btn" type="button" data-scout-preview-retry>Try again</button>' + externalLink(url, "Open in a new tab", "btn")));
      return;
    }
    if (token !== p.serial) return;
    if (data.kind === "page" && $("scoutPreviewFrame")) {
      p.page = data;
      p.token = exploreRandom(16);
      $("scoutPreviewFrame").srcdoc = exploreDocument(data.html, p.token, exploreRandom(18));
      scoutPreviewStatus("");
      return;
    }
    if (data.kind !== "file") {
      scoutPreviewStatus(emptyState("The site didn't return the document", (data.message || data.error || "Nothing came back.") + " Open it in a new tab to check.",
        '<button class="btn" type="button" data-scout-preview-retry>Try again</button>'));
      return;
    }
    const host = scoutDocumentHost(true);
    scoutPreviewStatus("");
    await renderDocument(host, { bytes: data.bytes, name: data.url || url, title: item.title || displayUrl(url), format: data.format, url: data.url || url,
      alive: () => token === p.serial });
  }, immediate ? 0 : 320);
}
function scoutPreviewStart(item) {
  const p = state.scoutPreview;
  const evidence = item.evidence || {};
  p.trail = [];
  const source = p.mode === "source" && evidence.parent_url;
  scoutPreviewLoad(item, source ? evidence.parent_url : item.url, { locate: source ? item.url : "" });
}
function scoutPreviewPost(message) {
  const frame = $("scoutPreviewFrame");
  if (!frame || !frame.contentWindow || !state.scoutPreview.token) return;
  try { frame.contentWindow.postMessage(Object.assign({ cs: "cs-explore", token: state.scoutPreview.token }, message), "*"); } catch (_) {}
}
window.addEventListener("message", event => {
  const frame = $("scoutPreviewFrame");
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data || {};
  const p = state.scoutPreview;
  if (data.cs !== "cs-explore" || !p.token || data.token !== p.token || !p.page) return;
  if (data.type === "ready" && p.locate) {
    // Mark the finding on the listing page it came from.
    const key = L.urlKey(p.locate);
    const index = p.page.links.findIndex(link => L.urlKey(link.url) === key);
    if (index >= 0) { scoutPreviewPost({ type: "picked", indexes: [index] }); scoutPreviewPost({ type: "locate", index }); }
    else showToast("The link isn't on the listing page any more, or the site adds it with script.");
  }
  if (data.type === "click") {
    const link = p.page.links[Number(data.index)];
    const item = scoutSelected();
    if (!link || !item) return;
    p.trail.push(p.page.url);
    scoutPreviewLoad(item, link.url, { immediate: true });
    return;
  }
});
function setScoutPreviewExpanded(expanded) {
  const p = state.scoutPreview;
  p.expanded = !!expanded;
  const box = $("scoutPreview");
  if (box) box.classList.toggle("is-expanded", p.expanded);
  document.body.classList.toggle("pdf-viewer-open", p.expanded);
  const button = document.querySelector("[data-scout-expand]");
  if (button) button.textContent = p.expanded ? "Close" : "Expand";
}
function scoutPreviewAction(target) {
  const item = scoutSelected();
  if (!item) return;
  const p = state.scoutPreview;
  if (target.dataset.scoutPreview) {
    p.mode = target.dataset.scoutPreview === "source" ? "source" : "page";
    return renderScoutDetail();
  }
  if (target.dataset.scoutDevice !== undefined) {
    p.device = p.device === "phone" ? "desktop" : "phone";
    target.setAttribute("aria-pressed", String(p.device === "phone"));
    const stage = document.querySelector(".scout-preview-stage");
    if (stage) stage.classList.toggle("is-phone", p.device === "phone");
    return;
  }
  if (target.dataset.scoutExpand !== undefined) return setScoutPreviewExpanded(!p.expanded);
  if (target.dataset.scoutPreviewBack !== undefined && p.trail.length) {
    const previous = p.trail.pop();
    return scoutPreviewLoad(item, previous, { immediate: true, locate: p.trail.length ? "" : (p.mode === "source" ? item.url : "") });
  }
  if (target.dataset.scoutPreviewRetry !== undefined) {
    const url = $("scoutPreviewOpen") ? $("scoutPreviewOpen").getAttribute("href") : item.url;
    state.add.pages.delete(L.urlKey(url));
    documentCache.delete(L.urlKey(url));
    return scoutPreviewLoad(item, url, { immediate: true, locate: p.mode === "source" && !p.trail.length ? item.url : "" });
  }
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
  const kind = (item.assessment || {}).publication_type ? item.assessment.publication_type.label : "";
  pane.innerHTML = '<div class="detail-inner">' +
    detailHeading({ back: true, source: [regulator.short_name, kind].filter(Boolean).join(" · "),
      title: item.title || displayUrl(item.url), subtitle: subtitle.length > 260 ? subtitle.slice(0, 259) + "…" : subtitle, meta, actions: actions.join("") }) +
    status + renderScoutAssessment(item) + scoutPreviewShell(item) + renderScoutEvidence(item) + "</div>";
  if (state.scoutPreview.key !== item.key) { state.scoutPreview.expanded = false; document.body.classList.remove("pdf-viewer-open"); }
  scoutPreviewStart(item);
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
  const items = Array.isArray(item) ? item : [item];
  const request = L.scoutReviewIssue(verb, items, "");
  const params = new URLSearchParams();
  params.set("title", request.title);
  params.set("body", request.body);
  const target = REPO + "/issues/new?" + params.toString();
  showToast(verb === "restore" ? "Submit the prefilled request on GitHub to return " + (items.length > 1 ? "these pages" : "this page") + " to review."
    : "Submit the prefilled request on GitHub. Add a reason first if you like; it applies to " + (items.length > 1 ? "these " + items.length + " addresses" : "this address") + " only.");
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
    if (state.cadenceOwner && state.cadenceOwner !== "ALL" && !(event.kind === "manual" && String(event.entry.owner_name || "").trim().toLocaleLowerCase() === state.cadenceOwner.toLocaleLowerCase())) return false;
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
  state.cadenceLinkEvents = {};
  syncCadenceOwnerFilter();
  renderCadenceLoad();
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
    if (dayEvents.filter(event => event.kind === "derived" || event.category === "deadline").length >= 2) classes.push("is-clash");
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
        (linked ? '<button type="button" data-calendar-open-change="' + esc(event.eventId) + '">View change →</button>' : "") +
        (cadenceIsEditor() ? '<button type="button" data-calendar-track="' + esc(event.eventId) + '" data-calendar-date="' + esc(event.date) + '" title="Add this date to the team calendar with an owner and a reminder">Track this</button>' : "") +
        cadenceCalendarLinks(event) + "</div></article>";
    }
    const entry = event.entry, isEditor = state.cadenceMember && ["admin", "editor"].includes(state.cadenceMember.role);
    const isDone = !!event.completed;
    const reminder = entry.reminder_enabled ? '<span class="cadence-tag is-reminder">Email reminder</span>' : "";
    return '<article class="cadence-agenda-item"><div class="cadence-agenda-row"><i class="cadence-agenda-dot ' + cadenceClass(event) + '"></i><div class="cadence-agenda-content"><span class="cadence-agenda-title">' + esc(event.title) + '</span><div class="cadence-agenda-meta"><span class="cadence-tag">' + esc(cadenceTag(event.category)) + '</span>' +
      (entry.regulator ? '<span>' + esc(entry.regulator) + '</span>' : "") + (entry.owner_name ? '<span>Owner: ' + esc(entry.owner_name) + '</span>' : "") + reminder + (entry.recurrence && entry.recurrence !== "none" ? '<span>↻ ' + esc(entry.recurrence) + '</span>' : "") +
      '</div>' + (entry.description ? '<p class="cadence-agenda-notes">' + esc(entry.description) + "</p>" : "") + '</div></div><div class="cadence-agenda-actions">' +
      (event.sourceUrl ? '<a href="' + esc(event.sourceUrl) + '" target="_blank" rel="noopener noreferrer">Open source ↗</a>' + cadenceSourceFlag(event.sourceUrl) : "") +
      (isEditor ? '<button type="button" data-calendar-complete="' + esc(event.entryId) + '" data-calendar-date="' + esc(event.occurrenceDate) + '" data-calendar-done="' + String(isDone) + '">' + (isDone ? "Reopen occurrence" : "Mark done") + '</button><button type="button" data-calendar-edit="' + esc(event.entryId) + '">Edit</button><button type="button" data-calendar-delete="' + esc(event.entryId) + '">Archive</button>' : (isDone ? '<span>Completed</span>' : "")) +
      cadenceCalendarLinks(event) + "</div></article>";
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
    '<div class="cadence-upcoming-actions">' + source + (manual && event.sourceUrl ? cadenceSourceFlag(event.sourceUrl) : changeAction) + editActions + cadenceCalendarLinks(event) + '</div></div></article>';
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
function openCadenceEntry(id, preset) {
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
  if (!entry && preset) {
    $("cadenceEntryTitle").value = preset.title || "";
    $("cadenceEntryCategory").value = preset.category || "deadline";
    $("cadenceEntryStart").value = preset.start_date || $("cadenceEntryStart").value;
    $("cadenceEntrySource").value = preset.source_url || "";
    $("cadenceEntryDescription").value = preset.description || "";
  }
  $("cadenceEntryHeading").textContent = entry ? "Edit regulatory entry" : preset ? "Track this date" : "New regulatory entry";
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



/* ---------- Cadence: load strip, source flags, calendar links, filing planner ---------- */

function cadenceIsEditor() { return !!(state.cadenceMember && ["admin", "editor"].includes(state.cadenceMember.role)); }
function cadenceOwners() {
  const owners = new Map();
  (state.cadenceEntries || []).forEach(entry => {
    const name = String(entry && !entry.archived && entry.owner_name || "").trim();
    if (name) owners.set(name.toLocaleLowerCase(), name);
  });
  return Array.from(owners.values()).sort((a, b) => a.localeCompare(b));
}
function syncCadenceOwnerFilter() {
  const select = $("cadenceOwnerFilter");
  if (!select) return;
  const owners = cadenceOwners();
  if (state.cadenceOwner !== "ALL" && owners.indexOf(state.cadenceOwner) < 0) state.cadenceOwner = "ALL";
  const html = '<option value="ALL">Every owner</option>' + owners.map(name => '<option value="' + esc(name) + '">' + esc(name) + "</option>").join("");
  if (select.dataset.options !== html) { select.innerHTML = html; select.dataset.options = html; }
  select.value = state.cadenceOwner;
  select.hidden = !owners.length;
}
// What ChangeSentinel knows about an entry's source page: changed lately,
// monitored and quiet, or not monitored yet (with a way to start).
function cadenceSourceFlag(url) {
  const key = url ? L.urlKey(url) : "";
  if (!key) return "";
  const monitored = (state.items || []).some(item => L.urlKey(item.canonical_url || "") === key);
  const changes = changeLogEntries().filter(change => change.url && L.urlKey(change.url) === key && CHANGE_EVENT_TYPES.indexOf(change.event_type) >= 0)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  const latest = changes[0];
  const age = latest ? (Date.now() - new Date(latest.timestamp).getTime()) / 86400000 : Infinity;
  if (latest && age <= 45) {
    return '<span class="cadence-flag is-changed" title="ChangeSentinel saw this source change">Source changed ' + esc(relativeTime(latest.timestamp)) + "</span>" +
      '<button type="button" data-calendar-open-change="' + esc(latest.event_id) + '">View change →</button>';
  }
  if (monitored) return '<span class="cadence-flag is-watched" title="ChangeSentinel checks this page on every scan">Source monitored · no recent change</span>';
  return '<button type="button" data-calendar-monitor="' + esc(url) + '" title="Ask ChangeSentinel to watch this page so a change shows here">Monitor this source</button>';
}
// One-off calendar links for an entry: Google Calendar and a single .ics file.
function cadenceCalendarLinks(event) {
  const day = event.kind === "manual" ? (event.occurrenceDate || event.date) : event.date;
  const entry = event.entry || {};
  const endDate = event.kind === "manual" && entry.end_date ? cadenceAddDays(day, cadenceEntryDurationDays(entry)) : day;
  const details = event.kind === "manual" ? [cadenceTag(event.category), entry.regulator, entry.owner_name ? "Owner: " + entry.owner_name : "", entry.description].filter(Boolean).join("\n")
    : [(event.item && event.item.description) || "Detected by ChangeSentinel"].join("\n");
  const google = L.googleCalendarLink({ date: day, endDate, title: cadenceEventLabel(event), details, url: event.sourceUrl });
  const key = (event.kind === "manual" ? event.entryId : "derived-" + (event.eventId || event.title)) + "|" + day;
  state.cadenceLinkEvents[key] = { day, endDate, title: cadenceEventLabel(event), details, url: event.sourceUrl, uid: key };
  return (google ? '<a href="' + esc(google) + '" target="_blank" rel="noopener noreferrer" title="Add to Google Calendar">Google Calendar ↗</a>' : "") +
    '<button type="button" data-calendar-ics="' + esc(key) + '" title="Download this entry for Outlook or Apple Calendar">.ics</button>';
}
function downloadCadenceEvent(key) {
  const e = state.cadenceLinkEvents[key];
  if (!e) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ChangeSentinel//Cadence Regulatory Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", "UID:" + cadenceIcsEscape(e.uid + "@changesentinel"), "DTSTAMP:" + stamp,
    "DTSTART;VALUE=DATE:" + e.day.replace(/-/g, ""), "DTEND;VALUE=DATE:" + cadenceAddDays(e.endDate || e.day, 1).replace(/-/g, ""),
    "SUMMARY:" + cadenceIcsEscape(e.title), "DESCRIPTION:" + cadenceIcsEscape(e.details)]
    .concat(e.url ? ["URL:" + String(e.url).replace(/[\r\n]/g, "")] : [], ["END:VEVENT", "END:VCALENDAR"]);
  downloadTextFile(L.fileSlug ? L.fileSlug(e.title) + ".ics" : "cadence-entry.ics", "text/calendar;charset=utf-8", lines.join("\r\n") + "\r\n");
}
// The next twelve weeks at a glance: how much is due each week, with weeks
// carrying three or more deadlines marked as clashes.
function renderCadenceLoad() {
  const host = $("cadenceLoad");
  if (!host) return;
  const today = cadenceDateISO(new Date());
  const events = cadenceFilterEvents(cadenceEventsBetween(today, cadenceAddDays(today, 7 * 12))).map(event => ({
    key: event.kind === "manual" ? event.entryId + "|" + event.occurrenceDate : "derived|" + event.date + "|" + event.title,
    date: event.kind === "manual" ? event.occurrenceDate || event.date : event.date,
    title: cadenceEventLabel(event), completed: !!event.completed,
    deadline: event.kind === "manual" ? event.category === "deadline" : true
  }));
  const weeks = L.cadenceWeeks(events, today, 12);
  const busy = weeks.filter(week => week.busy);
  const total = weeks.reduce((sum, week) => sum + week.total, 0);
  const label = iso => { const d = cadenceDate(iso); return d ? d.toLocaleDateString([], { day: "numeric", month: "short" }) : iso; };
  // On a phone twelve weeks share ~330 px, so each shows its day under the
  // month, and the month only where it changes.
  const shortLabel = (iso, index) => {
    const d = cadenceDate(iso);
    if (!d) return esc(iso);
    const prev = index ? cadenceDate(weeks[index - 1].start) : null;
    const month = !prev || prev.getMonth() !== d.getMonth() ? d.toLocaleDateString([], { month: "short" }) : "";
    return "<i>" + esc(month) + "</i>" + esc(d.getDate());
  };
  host.innerHTML = '<div class="cadence-load-head"><div><span class="cadence-eyebrow">NEXT 12 WEEKS</span><strong>' + plural(total, "open date", "open dates") + "</strong>" +
      (busy.length ? '<span class="cadence-load-warn">' + plural(busy.length, "week has", "weeks have") + " three or more deadlines</span>" : "") + "</div>" +
      '<span class="cadence-load-key"><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> more due</span></div>' +
    '<div class="cadence-load-strip" role="list">' + weeks.map((week, index) =>
      '<button type="button" role="listitem" class="cadence-load-week lv' + week.level + (week.busy ? " is-busy" : "") + (week.start <= today && today <= week.end ? " is-now" : "") +
        '" data-calendar-jump-date="' + esc(week.start <= today ? today : week.start) + '" title="' + esc("Week of " + label(week.start) + ": " + (week.total ? plural(week.total, "date", "dates") + (week.deadlines ? ", " + plural(week.deadlines, "deadline", "deadlines") : "") + "\n" + week.titles.join("\n") : "nothing scheduled")) + '">' +
        '<span class="cadence-load-bar"><i style="height:' + (week.level * 25) + '%"></i></span><span class="cadence-load-count">' + (week.total || "") + "</span>" +
        '<span class="cadence-load-date"><span class="cl-full">' + esc(label(week.start)) + '</span><span class="cl-short" aria-hidden="true">' + shortLabel(week.start, index) + "</span></span></button>").join("") + "</div>";
}
function trackDetectedDate(eventId, date) {
  const item = state.calendar && Array.isArray(state.calendar.entries)
    ? state.calendar.entries.find(entry => String(entry.event_id || "") === eventId && String(entry.date || "") === date) : null;
  if (!item) return;
  openCadenceEntry("", {
    title: String(item.title || "Regulatory date").slice(0, 160), category: "deadline", start_date: date,
    source_url: String(item.url || ""), description: [item.description ? String(item.description) : "", "Detected by ChangeSentinel."].filter(Boolean).join("\n\n").slice(0, 4000)
  });
}

/* Filing planner: a periodic return's next due dates and the team's steps before each. */
const PLAN_MILESTONES = [["Data cut-off", 10], ["Review", 5], ["Sign-off", 2]];
function openCadencePlanner() {
  const dialog = $("cadencePlanDialog");
  const list = $("cadencePlanRegulators");
  if (list && !list.children.length) {
    list.innerHTML = regulatorProfiles().map(profile => '<option value="' + esc(profile.short_name ? profile.short_name + " · " + profile.name : profile.name) + '"></option>').join("");
  }
  $("cadencePlanMilestones").innerHTML = PLAN_MILESTONES.map(([label, offset], index) =>
    '<div class="plan-milestone"><input type="checkbox" id="planStep' + index + '" checked aria-label="Include ' + esc(label) + '">' +
    '<input class="field-input" id="planStepLabel' + index + '" maxlength="80" value="' + esc(label) + '" aria-label="Step name">' +
    '<input class="field-input" id="planStepOffset' + index + '" type="number" min="1" max="120" value="' + offset + '" aria-label="Business days before the due date"><span>business days before</span></div>').join("");
  $("cadencePlanStatus").textContent = "";
  $("cadencePlanStatus").classList.remove("is-error");
  if (!$("cadencePlanOwner").value && state.cadenceMember && state.cadenceMember.email) $("cadencePlanOwner").placeholder = "Regulatory Reporting";
  syncCadencePlanner();
  dialog.showModal();
  window.setTimeout(() => $("cadencePlanName").focus(), 30);
}
function cadencePlanOptions() {
  const frequency = $("cadencePlanFrequency").value;
  return {
    name: $("cadencePlanName").value.replace(/[\r\n]+/g, " ").trim().slice(0, 100),
    regulator: $("cadencePlanRegulator").value.trim().slice(0, 160),
    owner: $("cadencePlanOwner").value.trim().slice(0, 120),
    source: $("cadencePlanSource").value.trim(),
    frequency, yearEndMonth: Number($("cadencePlanYearEnd").value),
    lag: Number($("cadencePlanLag").value), lagLast: Number($("cadencePlanLagLast").value || $("cadencePlanLag").value),
    business: $("cadencePlanBusiness").checked, cycles: Number($("cadencePlanCycles").value),
    reminder: $("cadencePlanReminder").checked,
    milestones: PLAN_MILESTONES.map((_, index) => $("planStep" + index).checked ? { label: $("planStepLabel" + index).value, offset: Number($("planStepOffset" + index).value) } : null).filter(Boolean),
    from: cadenceDateISO(new Date())
  };
}
function cadencePlanRows(o) {
  const plan = L.cadencePlan(o);
  const name = o.name || "Return";
  const rows = [];
  plan.forEach(cycle => {
    rows.push({ title: name + " due · " + cycle.period, category: "deadline", start_date: cycle.due, cycle, main: true,
      description: "Filing for the period ending " + cycle.periodEnd + "." + (cycle.rolled ? " The due date fell on a weekend and was moved to the next business day." : "") + " Planned with the Cadence filing planner." });
    cycle.milestones.forEach(step => rows.push({ title: name + " · " + step.label + " · " + cycle.period, category: "internal_task", start_date: step.date, cycle,
      description: step.offset + " business days before the " + cycle.due + " filing." }));
  });
  return { plan, rows };
}
function syncCadencePlanner() {
  const o = cadencePlanOptions();
  $("cadencePlanYearEndWrap").hidden = o.frequency === "monthly";
  $("cadencePlanLagLastWrap").hidden = o.frequency === "yearly";
  const cycles = $("cadencePlanCycles");
  const choices = o.frequency === "monthly" ? [3, 6, 12] : o.frequency === "yearly" ? [1, 2, 3] : [2, 4, 8];
  const wanted = choices.indexOf(Number(cycles.value)) >= 0 ? Number(cycles.value) : choices[1];
  const html = choices.map(n => '<option value="' + n + '"' + (n === wanted ? " selected" : "") + ">Next " + n + "</option>").join("");
  if (cycles.dataset.options !== html) { cycles.innerHTML = html; cycles.dataset.options = html; }
  const { plan, rows } = cadencePlanRows(cadencePlanOptions());
  const existing = new Set((state.cadenceEntries || []).filter(entry => !entry.archived).map(entry => entry.title + "|" + entry.start_date));
  const fmtDay = iso => { const d = cadenceDate(iso); return d ? d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : iso; };
  $("cadencePlanPreview").innerHTML = plan.length ? plan.map(cycle =>
    '<div class="plan-cycle"><div class="plan-cycle-head"><strong>' + esc(cycle.period) + '</strong><span class="plan-due">Due ' + esc(fmtDay(cycle.due)) + (cycle.rolled ? ' <em title="Moved off a weekend">moved to Monday</em>' : "") + "</span></div>" +
      (cycle.milestones.length ? '<ol class="plan-steps">' + cycle.milestones.map(step => "<li><span>" + esc(step.label) + "</span><time>" + esc(fmtDay(step.date)) + "</time></li>").join("") + "</ol>" : "") + "</div>").join("")
    : '<p class="cadence-empty">Enter how many days after the period end the return is due.</p>';
  const fresh = rows.filter(row => !existing.has(row.title + "|" + row.start_date));
  const save = $("cadencePlanSave");
  save.disabled = !o.name || !rows.length || !fresh.length || !cadenceIsEditor();
  save.textContent = fresh.length ? "Add " + plural(fresh.length, "entry", "entries") + " to Cadence" : rows.length ? "Already on the calendar" : "Add to Cadence";
  $("cadencePlanIcs").disabled = !o.name || !rows.length;
  const note = !cadenceIsEditor() ? "Sign in as a Cadence editor to add these to the shared calendar; you can still download them." :
    rows.length > fresh.length ? plural(rows.length - fresh.length, "entry is", "entries are") + " already on the calendar and will be skipped." : "";
  $("cadencePlanNote").textContent = note;
}
async function saveCadencePlan() {
  const o = cadencePlanOptions();
  const status = $("cadencePlanStatus");
  if (!o.name) { $("cadencePlanName").reportValidity(); return; }
  if (o.source && !safeHttpUrl(o.source)) { status.textContent = "Enter the source as a full https:// address, or leave it empty."; status.classList.add("is-error"); return; }
  if (!cadenceIsEditor()) return;
  const existing = new Set((state.cadenceEntries || []).filter(entry => !entry.archived).map(entry => entry.title + "|" + entry.start_date));
  const rows = cadencePlanRows(o).rows.filter(row => !existing.has(row.title + "|" + row.start_date));
  const save = $("cadencePlanSave");
  save.disabled = true;
  status.classList.remove("is-error");
  let done = 0;
  try {
    for (const row of rows) {
      status.textContent = "Adding " + (done + 1) + " of " + rows.length + "…";
      const reminder = o.reminder && row.main;
      await cadenceApi("POST", { action: "save", entry: {
        title: row.title.slice(0, 160), category: row.category, recurrence: "none", start_date: row.start_date, end_date: null,
        regulator: o.regulator, owner_name: o.owner, source_url: o.source, description: row.description.slice(0, 4000),
        reminder_enabled: reminder, reminder_days_before: 7, reminder_emails: reminder && state.cadenceMember.email ? [state.cadenceMember.email] : []
      } });
      done += 1;
    }
    $("cadencePlanDialog").close();
    const first = rows[0];
    if (first) { state.cadenceSelectedDate = first.start_date; state.cadenceMonth = cadenceDate(first.start_date); state.cadenceMonth.setDate(1); }
    await refreshCadence(true);
    showToast(plural(done, "entry", "entries") + " added to Cadence for " + o.name + ".");
  } catch (error) {
    status.textContent = (done ? plural(done, "entry was", "entries were") + " added before this error: " : "") + String(error.message || error);
    status.classList.add("is-error");
    if (done) refreshCadence(true);
  } finally { save.disabled = false; }
}
function downloadCadencePlan() {
  const o = cadencePlanOptions();
  const rows = cadencePlanRows(o).rows;
  if (!o.name || !rows.length) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ChangeSentinel//Cadence Filing Planner//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  rows.forEach(row => {
    lines.push("BEGIN:VEVENT", "UID:" + cadenceIcsEscape(L.fileSlug(o.name) + "-" + row.category + "-" + row.start_date + "-" + L.fileSlug(row.title).slice(0, 40) + "@changesentinel"), "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + row.start_date.replace(/-/g, ""), "DTEND;VALUE=DATE:" + cadenceAddDays(row.start_date, 1).replace(/-/g, ""),
      "SUMMARY:" + cadenceIcsEscape(row.title), "DESCRIPTION:" + cadenceIcsEscape([row.description, o.regulator, o.owner ? "Owner: " + o.owner : ""].filter(Boolean).join("\n")));
    if (o.source && safeHttpUrl(o.source)) lines.push("URL:" + o.source.replace(/[\r\n]/g, ""));
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  downloadTextFile(L.fileSlug(o.name) + "-filing-plan.ics", "text/calendar;charset=utf-8", lines.join("\r\n") + "\r\n");
}


/* ================= Navigation ================= */

function viewSection(view) {
  return { overview: "overviewView", changes: "changesView", monitors: "monitorsView", runs: "runsView", health: "healthView", notifications: "notificationsView", scout: "scoutView", calendar: "calendarView", askSentinel: "askSentinelView" }[view] || "overviewView";
}
function hasSelection(view) {
  return view === "changes" ? !!state.selectedChangeId : view === "monitors" ? !!state.selectedId
    : view === "runs" ? !!state.selectedRunId : view === "notifications" ? !!state.selectedNotificationId
    : view === "health" ? !!state.selectedHealthKey
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
  syncMoreTab();
  const askLauncher = $("askSentinelLaunch");
  askLauncher.classList.toggle("active", state.view === "askSentinel");
  askLauncher.setAttribute("aria-current", state.view === "askSentinel" ? "page" : "false");
  const titles = { overview: "Overview", changes: "Changes", monitors: "Pages", runs: "Runs", health: "Health", notifications: "Alerts", scout: "Scout", calendar: "Cadence", askSentinel: "Ask Sentinel" };
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
  if (view === "health" && !healthKeys().includes(state.selectedHealthKey)) state.selectedHealthKey = "fleet";
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
      return item ? JSON.stringify([item, channelSummary()]) : "none";
    }
    if (view === "health") return JSON.stringify([state.selectedHealthKey, state.assetSignatures.health || "", state.assetSignatures.config || ""]);
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
  else if (view === "health") renderHealthDetail();
  else if (view === "scout") renderScoutDetail();
  else if (view === "calendar") { renderCadenceView(); refreshCadence(); }
}
function resetDetailScroll(view) {
  const pane = { changes: "changeDetail", monitors: "detailView", runs: "runDetail", health: "healthDetail", notifications: "notificationDetail", scout: "scoutDetail", calendar: "calendarView" }[view];
  if (pane && $(pane)) $(pane).scrollTop = 0;
  if (view === "overview") $("overviewView").scrollTop = 0;
}
function writeHash() {
  const id = state.view === "changes" ? state.selectedChangeId : state.view === "monitors" ? state.selectedId
    : state.view === "runs" ? state.selectedRunId : state.view === "notifications" ? state.selectedNotificationId
    : state.view === "health" ? (state.selectedHealthKey === "fleet" ? "" : state.selectedHealthKey)
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
  hideFieldTip();
  if (state.scoutPreview.expanded && view !== "scout") setScoutPreviewExpanded(false);
  state.view = VIEWS.indexOf(view) >= 0 ? view : "overview";
  // On a phone Health opens on the fleet view, not a list of 116 monitors.
  if (state.view === "health" && options.detail === undefined && isCompact()) { state.selectedHealthKey = state.selectedHealthKey || "fleet"; options.detail = true; }
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
  hideFieldTip();
  if (view === "changes") state.selectedChangeId = id;
  if (view === "monitors") {
    if (options.tab) state.detailTab = options.tab;
    else if (state.selectedId !== id) state.detailTab = "";
    state.selectedId = id;
    state.snapshotMode = "preview";
  }
  if (view === "runs") state.selectedRunId = id;
  if (view === "notifications") state.selectedNotificationId = id;
  if (view === "health") state.selectedHealthKey = id;
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
const SMALL_ASSETS = ["report", "notifications", "outbox", "config", "scoutLatest", "scoutConfig", "calendar", "lineage", "reviews", "regulators", "health"];
const LARGE_ASSETS = ["inventory", "history", "scoutReview"];
const OPTIONAL_ASSETS = new Set(["scoutLatest", "scoutReview", "scoutConfig", "calendar", "lineage", "reviews", "regulators", "health"]);
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
    state.regulators = values.regulators;
    state.health = values.health;
    state.regulatorProfiles = null;
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
          if (route.view === "health") state.selectedHealthKey = route.id;
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
      candidates: a.candidates.slice(0, 6000), picked: Array.from(a.picked.keys()), opened: a.opened, rules: a.rules, ruleRequests: a.ruleRequests,
      savedAt: new Date().toISOString()
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
  a.origin = saved.origin === "crawl" || saved.origin === "scout" ? saved.origin : "explore";
  a.scope = typeof saved.scope === "string" ? saved.scope : "";
  a.notes = Array.isArray(saved.notes) ? saved.notes.map(String).slice(0, 6) : [];
  a.info = typeof saved.info === "string" ? saved.info.slice(0, 200) : "";
  a.opened = saved.opened && typeof saved.opened === "object" ? saved.opened : {};
  a.rules = {};
  if (saved.rules && typeof saved.rules === "object") {
    Object.keys(saved.rules).slice(0, 200).forEach(key => {
      const rule = saved.rules[key] || {};
      const include = typeof rule.include === "string" ? rule.include.slice(0, RULE_LIMITS.selector) : "";
      const ignore = Array.isArray(rule.ignore) ? rule.ignore.filter(value => typeof value === "string" && value.length <= RULE_LIMITS.selector).slice(0, RULE_LIMITS.ignore) : [];
      if (include || ignore.length) a.rules[key] = { include, ignore };
    });
  }
  a.ruleRequests = {};
  if (saved.ruleRequests && typeof saved.ruleRequests === "object") {
    Object.keys(saved.ruleRequests).slice(0, 50).forEach(key => {
      const request = saved.ruleRequests[key] || {};
      if (Array.isArray(request.keys)) a.ruleRequests[key] = { url: String(request.url || ""), title: String(request.title || "").slice(0, 200), folder: String(request.folder || ""),
        pattern: String(request.pattern || "").slice(0, 200), keys: request.keys.map(String).slice(0, 5000), at: String(request.at || "") };
    });
  }
}
function addClearDraft() {
  const a = state.add;
  a.candidates = []; a.picked = new Map(); a.opened = {}; a.notes = []; a.history = []; a.at = -1; a.page = null; a.anchor = "";
  a.rules = {}; a.area = null; a.ruleDrafts = {}; a.ruleRequests = {}; a.ruleOpen = false;
  try { localStorage.removeItem(ADD_DRAFT_STORAGE); } catch (_) {}
}

/* ---------- Steps ---------- */

const ADD_STEP_COPY = {
  start: ["Add a link", "Open a page and pick the links on it you want ChangeSentinel to monitor."],
  explore: ["Explore the page", "Click a link to open it here. Shift-click to select it, Shift-drag to box an area, or pick a part of the page to watch or ignore."],
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

// AbortSignal.timeout arrived in Safari 16; older Safari gets the same behaviour by hand.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => {
    let reason;
    try { reason = new DOMException("The operation timed out.", "TimeoutError"); } catch (_) { reason = undefined; }
    controller.abort(reason);
  }, ms);
  return controller.signal;
}
async function addReadPage(url) {
  const a = state.add;
  const key = L.urlKey(url);
  if (a.pages.has(key)) return a.pages.get(key);
  if (!PAGE_READER_ENDPOINT) throw new Error("The page reader isn't set up for this dashboard yet");
  const identity = await askSentinelIdentity();
  const headers = Object.assign(askSentinelIdentityHeaders(identity), { "Content-Type": "application/json" });
  let response;
  try {
    response = await fetch(PAGE_READER_ENDPOINT, { method: "POST", headers, body: JSON.stringify({ url }), signal: timeoutSignal(40000) });
  } catch (error) {
    throw new Error(error && (error.name === "TimeoutError" || error.name === "AbortError") ? "The page took too long to read" : "The page reader could not be reached");
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
  $("exploreNotice").hidden = true;
  exploreDocumentClose();
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
    if (item) {
      if (!a.candidates.some(candidate => candidate.key === item.key)) a.candidates.push(item);
      exploreDocumentOpen(item);
    }
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
  a.area = null;
  a.ruleOpen = false;
  if (a.picking) a.picking = false;
  a.tab = a.picked.size ? a.tab : (exploreSuggestions().items.length ? "suggested" : "page");
  $("exploreAddress").textContent = displayUrl(data.url);
  $("exploreNewTab").href = safeHttpUrl(data.url) || "#";
  a.frameToken = exploreRandom(16);
  $("exploreFrame").srcdoc = exploreDocument(data.html, a.frameToken, exploreRandom(18));
  const notice = $("exploreNotice");
  notice.textContent = typeof data.notice === "string" ? data.notice.slice(0, 400) : "";
  notice.hidden = !notice.textContent;
  exploreStatus("", "ok");
  renderExploreSide();
}
// The reader's copy, shown in a frame sandboxed with allow-scripts but without
// allow-same-origin: it runs in an opaque origin, so nothing in it can reach the
// dashboard, its storage or its cookies. The reader already strips every script
// and handler; this document's policy then admits only the one bridge script
// below, by nonce. The bridge reports link clicks (with Shift) by postMessage and
// draws the selection marks. Safari never runs event listeners that the parent
// page attaches inside a script-less sandboxed frame, so clicks are handled from
// within the frame instead.
function exploreBridge(token) {
  var root = document.documentElement;
  var shift = false;
  var picking = false;
  var drag = null;
  var swallowClick = false;
  var hovered = null;
  var BLOCKS = "main,article,section,aside,nav,header,footer,form,table,tbody,ul,ol,dl,figure,fieldset,details,div,p,li,tr";
  function send(message) {
    message.cs = "cs-explore";
    message.token = token;
    try { parent.postMessage(message, "*"); } catch (e) {}
  }
  function linkOf(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    return node && node.closest ? node.closest("[data-cs-link], a[href], area[href]") : null;
  }
  function setShift(on) {
    shift = !!on;
    root.classList.toggle("cs-shift", shift);
  }
  function setPicking(on) {
    picking = !!on;
    root.classList.toggle("cs-picking", picking);
    if (!picking) setHover(null);
  }
  function setHover(node) {
    if (hovered === node) return;
    if (hovered) hovered.removeAttribute("data-cs-hover");
    hovered = node;
    if (hovered) hovered.setAttribute("data-cs-hover", "");
  }
  // A short, stable CSS selector for a part of the page: an id when it has a
  // readable one, otherwise tags and classes, with :nth-of-type only where needed.
  function stableClass(name) { return /^[A-Za-z_-][\w-]{1,40}$/.test(name) && !/^cs-/.test(name) && !/\d{3,}/.test(name) && !/^(active|open|show|hidden|selected|current|visible|focus|hover)$|^(is|has)-/.test(name); }
  function esc(value) { return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^\w-]/g, "\\$&"); }
  function unique(selector) { try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; } }
  function selectorFor(node) {
    if (!node || node.nodeType !== 1) return "";
    var parts = [];
    var current = node;
    while (current && current.nodeType === 1 && current !== document.body && current !== root) {
      var id = current.getAttribute("id");
      if (id && /^[A-Za-z][\w-]{1,60}$/.test(id) && !/\d{4,}/.test(id)) {
        parts.unshift("#" + esc(id));
        var byId = parts.join(" > ");
        if (unique(byId)) return byId;
      } else {
        var part = current.tagName.toLowerCase();
        var classes = Array.prototype.filter.call(current.classList || [], stableClass).slice(0, 2);
        if (classes.length) part += "." + classes.map(esc).join(".");
        var parentNode = current.parentElement;
        if (parentNode) {
          var same = Array.prototype.filter.call(parentNode.children, function (child) { return child.tagName === current.tagName; });
          if (same.length > 1 && !(classes.length && Array.prototype.filter.call(parentNode.children, function (child) { return child.matches && child.matches(part); }).length === 1)) {
            part += ":nth-of-type(" + (same.indexOf(current) + 1) + ")";
          }
        }
        parts.unshift(part);
        var path = parts.join(" > ");
        // Stop at the first unique path anchored on a class, so a bare "ul" or
        // "div:nth-of-type(3)" isn't left to break when the page grows.
        if (classes.length && unique(path)) return path;
      }
      current = current.parentElement;
    }
    var full = parts.length ? "body > " + parts.join(" > ") : "body";
    var short = parts.join(" > ");
    return short && unique(short) ? short : full;
  }
  function labelFor(node) {
    var heading = node.querySelector && node.querySelector("h1,h2,h3,h4,caption,legend,summary");
    var name = node.getAttribute("aria-label") || (heading && heading.textContent) || "";
    var kind = { TABLE: "Table", UL: "List", OL: "List", NAV: "Menu", FORM: "Form", HEADER: "Header", FOOTER: "Footer", ASIDE: "Side panel", SECTION: "Section", ARTICLE: "Article", MAIN: "Main content", P: "Paragraph" }[node.tagName] || "Part of the page";
    name = String(name).replace(/\s+/g, " ").trim();
    return name ? kind + " · " + name.slice(0, 70) : kind;
  }
  function linksIn(node) {
    var indexes = [];
    var nodes = node.querySelectorAll ? node.querySelectorAll("[data-cs-link]") : [];
    if (node.hasAttribute && node.hasAttribute("data-cs-link")) nodes = [node].concat(Array.prototype.slice.call(nodes));
    for (var i = 0; i < nodes.length; i++) {
      var index = Number(nodes[i].getAttribute("data-cs-link"));
      if (indexes.indexOf(index) < 0) indexes.push(index);
    }
    return indexes;
  }
  function report(node, indexes, how) {
    var marked = document.querySelectorAll("[data-cs-area]");
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute("data-cs-area");
    if (node && node !== document.body) node.setAttribute("data-cs-area", "");
    var text = node ? String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim() : "";
    send({ type: "area", how: how, indexes: indexes, selector: node && node !== document.body ? selectorFor(node) : "",
      label: node ? labelFor(node) : "Selected area", text: text.slice(0, 220), words: text ? text.split(" ").length : 0 });
  }
  function commonAncestor(nodes) {
    if (!nodes.length) return null;
    var ancestor = nodes[0];
    for (var i = 1; i < nodes.length; i++) {
      while (ancestor && !ancestor.contains(nodes[i])) ancestor = ancestor.parentElement;
    }
    return ancestor && ancestor.nodeType === 1 && ancestor.nodeName !== "A" ? ancestor : ancestor && ancestor.parentElement;
  }
  function finishDrag(box) {
    drag.box.parentNode && drag.box.parentNode.removeChild(drag.box);
    var left = Math.min(drag.x, box.x), right = Math.max(drag.x, box.x), top = Math.min(drag.y, box.y), bottom = Math.max(drag.y, box.y);
    var all = document.querySelectorAll("[data-cs-link]");
    var inside = [], indexes = [];
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (!r.width && !r.height) continue;
      var cx = r.left + scrollX + r.width / 2, cy = r.top + scrollY + r.height / 2;
      if (cx >= left && cx <= right && cy >= top && cy <= bottom) {
        inside.push(all[i]);
        var index = Number(all[i].getAttribute("data-cs-link"));
        if (indexes.indexOf(index) < 0) indexes.push(index);
      }
    }
    var node = commonAncestor(inside);
    if (!node) {
      node = document.elementFromPoint((left + right) / 2 - scrollX, (top + bottom) / 2 - scrollY);
      var area = (right - left) * (bottom - top);
      while (node && node.parentElement && node !== document.body) {
        var nr = node.getBoundingClientRect();
        if (nr.width * nr.height >= area * 0.6) break;
        node = node.parentElement;
      }
    }
    report(node, indexes, "drag");
  }
  document.addEventListener("click", function (event) {
    if (swallowClick) { swallowClick = false; event.preventDefault(); event.stopPropagation(); return; }
    if (picking) {
      event.preventDefault();
      event.stopPropagation();
      var target = event.target && event.target.closest ? event.target.closest(BLOCKS) : null;
      if (target) report(target, linksIn(target), "pick");
      return;
    }
    var link = linkOf(event.target);
    if (!link) return;
    var href = link.getAttribute("href") || "";
    if (!link.hasAttribute("data-cs-link") && href.charAt(0) === "#") return;
    event.preventDefault();
    event.stopPropagation();
    if (!link.hasAttribute("data-cs-link")) return;
    send({ type: "click", index: Number(link.getAttribute("data-cs-link")), shift: !!(event.shiftKey || shift) });
  }, true);
  ["auxclick", "dragstart"].forEach(function (name) {
    document.addEventListener(name, function (event) { if (linkOf(event.target) || drag) event.preventDefault(); }, true);
  });
  document.addEventListener("submit", function (event) { event.preventDefault(); }, true);
  // Shift+drag draws a box: the links inside it and the part of the page that
  // holds them are reported. Shift+mousedown would otherwise select text.
  document.addEventListener("mousedown", function (event) {
    if (!event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    drag = { x: event.pageX, y: event.pageY, moved: false, box: null };
  }, true);
  document.addEventListener("mousemove", function (event) {
    if (!!event.shiftKey !== shift) setShift(event.shiftKey);
    if (picking) {
      var block = event.target && event.target.closest ? event.target.closest(BLOCKS) : null;
      setHover(block && block !== document.body ? block : null);
    }
    if (!drag) return;
    if (!drag.moved && Math.abs(event.pageX - drag.x) + Math.abs(event.pageY - drag.y) < 8) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.box = document.createElement("div");
      drag.box.className = "cs-drag-box";
      document.body.appendChild(drag.box);
    }
    var s = drag.box.style;
    s.left = Math.min(drag.x, event.pageX) + "px";
    s.top = Math.min(drag.y, event.pageY) + "px";
    s.width = Math.abs(event.pageX - drag.x) + "px";
    s.height = Math.abs(event.pageY - drag.y) + "px";
  }, true);
  document.addEventListener("mouseup", function (event) {
    if (!drag) return;
    var moved = drag.moved;
    if (moved) { finishDrag({ x: event.pageX, y: event.pageY }); swallowClick = true; setTimeout(function () { swallowClick = false; }, 0); }
    drag = null;
  }, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Shift") setShift(true);
    if (event.key === "Escape") {
      if (drag && drag.box && drag.box.parentNode) drag.box.parentNode.removeChild(drag.box);
      drag = null;
      if (picking) { setPicking(false); send({ type: "pickoff" }); } else send({ type: "escape" });
    }
  }, true);
  document.addEventListener("keyup", function (event) { if (event.key === "Shift") setShift(false); }, true);
  window.addEventListener("blur", function () { setShift(false); });
  function markRules(include, ignore) {
    var marked = document.querySelectorAll("[data-cs-watch],[data-cs-ignore]");
    for (var i = 0; i < marked.length; i++) { marked[i].removeAttribute("data-cs-watch"); marked[i].removeAttribute("data-cs-ignore"); }
    function mark(selector, name) {
      if (!selector) return;
      try { var nodes = document.querySelectorAll(selector); for (var j = 0; j < nodes.length; j++) nodes[j].setAttribute(name, ""); } catch (e) {}
    }
    mark(include, "data-cs-watch");
    (ignore || []).forEach(function (selector) { mark(selector, "data-cs-ignore"); });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data || {};
    if (data.cs !== "cs-explore" || data.token !== token) return;
    if (data.type === "picked") {
      var marked = document.querySelectorAll("[data-cs-picked]");
      for (var i = 0; i < marked.length; i++) marked[i].removeAttribute("data-cs-picked");
      (data.indexes || []).forEach(function (index) {
        var nodes = document.querySelectorAll('[data-cs-link="' + Number(index) + '"]');
        for (var j = 0; j < nodes.length; j++) nodes[j].setAttribute("data-cs-picked", "");
      });
    } else if (data.type === "mode") {
      root.classList.toggle("cs-select", !!data.select);
    } else if (data.type === "shift") {
      setShift(data.on);
    } else if (data.type === "pick") {
      setPicking(data.on);
    } else if (data.type === "rules") {
      markRules(data.include, data.ignore);
    } else if (data.type === "area-clear") {
      var areas = document.querySelectorAll("[data-cs-area]");
      for (var k = 0; k < areas.length; k++) areas[k].removeAttribute("data-cs-area");
    } else if (data.type === "locate") {
      var target = document.querySelector('[data-cs-link="' + Number(data.index) + '"]');
      if (!target) return;
      try { target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { target.scrollIntoView(); }
      target.classList.remove("cs-flash");
      void target.offsetWidth;
      target.classList.add("cs-flash");
    }
  });
  send({ type: "ready" });
}
function exploreRandom(bytes) {
  const values = new Uint8Array(bytes);
  (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(values) : values.forEach((_, i) => { values[i] = Math.floor(Math.random() * 256); });
  return Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
}
function exploreDocument(html, token, nonce) {
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-' + nonce + '\'; ' +
    "style-src * data: blob: 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src 'none'; " +
    "frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'\">";
  const style = "<style>[data-cs-link]{cursor:pointer}" +
    "[data-cs-picked]{outline:2px solid #e8890a!important;outline-offset:2px;background:rgba(232,137,10,.16)!important;border-radius:2px}" +
    "html.cs-shift [data-cs-link],html.cs-select [data-cs-link]{cursor:copy!important;outline:1px dashed rgba(232,137,10,.85);outline-offset:2px}" +
    "@keyframes csFlash{0%,100%{box-shadow:0 0 0 0 rgba(232,137,10,0)}30%{box-shadow:0 0 0 6px rgba(232,137,10,.45)}}" +
    ".cs-flash{animation:csFlash 1.2s ease 2}" +
    ".cs-drag-box{position:absolute;z-index:2147483646;pointer-events:none;border:1.5px dashed #e8890a;background:rgba(232,137,10,.10);border-radius:3px}" +
    "html.cs-picking,html.cs-picking *{cursor:crosshair!important}" +
    "[data-cs-hover]{outline:2px dashed #3d7bd9!important;outline-offset:2px;background:rgba(61,123,217,.07)!important}" +
    "[data-cs-area]{outline:2px solid #e8890a!important;outline-offset:3px}" +
    "[data-cs-watch]{outline:2px solid #2f9e6b!important;outline-offset:4px;box-shadow:0 0 0 9999px rgba(20,24,30,.18)!important;position:relative;z-index:1}" +
    "[data-cs-ignore]{opacity:.35!important;filter:grayscale(1)!important;outline:1px dashed #c0392b!important}</style>";
  const script = '<script nonce="' + nonce + '">(' + exploreBridge.toString() + ")(" + JSON.stringify(token) + ");<\/script>";
  // Only the policy written here may apply: the reader's own (script-src 'none') would block the bridge.
  let doc = String(html || "").replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
  doc = /<head\b[^>]*>/i.test(doc) ? doc.replace(/<head\b[^>]*>/i, match => match + policy) : policy + doc;
  doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, style + "</head>") : style + doc;
  doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, script + "</body>") : doc + script;
  return doc;
}
function explorePost(message) {
  const frame = $("exploreFrame");
  if (!frame || !frame.contentWindow || !state.add.frameToken) return;
  try { frame.contentWindow.postMessage(Object.assign({ cs: "cs-explore", token: state.add.frameToken }, message), "*"); } catch (_) {}
}
function exploreSync() {
  explorePost({ type: "mode", select: state.add.selectMode });
  exploreMarkPicked();
  exploreSendRules();
  exploreSetPicking(state.add.picking);
}
function exploreShift(on) {
  if (state.add.step === "explore") explorePost({ type: "shift", on: !!on });
}
function exploreLinkClick(index, shift) {
  const a = state.add;
  const link = Number.isInteger(index) && a.page ? a.page.links[index] : null;
  if (!link) return;
  const item = addLinkItem(link, a.page, null);
  if (!item) return;
  if (shift || a.selectMode) { addToggle(item); return; }
  if (link.format !== "Web page") return exploreDocumentOpen(item);
  exploreOpen(link.url, true);
}
// A document linked from the page opens over it in the dashboard's viewer, with
// a way to select it and a way back to the page.
async function exploreDocumentOpen(item) {
  const a = state.add;
  const host = $("exploreDoc");
  const token = ++a.loading;
  a.docItem = item;
  host.hidden = false;
  const actions = () => '<button class="btn' + (a.picked.has(item.key) ? "" : " btn-primary") + '" type="button" data-explore-doc-pick>' + (a.picked.has(item.key) ? "Selected ✓" : "Select this document") + "</button>" +
    '<button class="btn" type="button" data-explore-doc-close>Back to the page</button>';
  host.innerHTML = '<div class="doc-view">' + docToolbar({ title: item.title, kindLabel: item.format, actions: actions() }) + '<div class="doc-body"><div class="loading">Opening ' + esc(item.title) + "…</div></div></div>";
  let data;
  try {
    data = await readDocumentFile(item.url);
  } catch (error) {
    if (token !== a.loading) return;
    host.querySelector(".doc-body").innerHTML = emptyState("This document couldn't be opened here", String(error.message || error) + ". You can still select it, or open it in a new tab.", externalLink(item.url, "Open in a new tab", "btn"));
    return;
  }
  if (token !== a.loading || host.hidden) return;
  if (data.kind !== "file") {
    host.querySelector(".doc-body").innerHTML = emptyState("The site didn't return a document", (data.message || data.error || "Nothing came back.") + " Select it anyway, or open it in a new tab.", externalLink(item.url, "Open in a new tab", "btn"));
    return;
  }
  await renderDocument(host, { bytes: data.bytes, name: data.url || item.url, title: item.title, format: data.format, url: data.url || item.url, actions: actions(),
    alive: () => token === a.loading && !host.hidden });
}
function exploreDocumentClose() {
  const host = $("exploreDoc");
  if (!host || host.hidden) return;
  host.hidden = true;
  host.innerHTML = "";
  releaseDocumentPdfs();
  state.add.loading += 1;
}
window.addEventListener("message", event => {
  const frame = $("exploreFrame");
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data || {};
  if (data.cs !== "cs-explore" || !state.add.frameToken || data.token !== state.add.frameToken) return;
  if (data.type === "ready") exploreSync();
  else if (data.type === "click") exploreLinkClick(Number(data.index), !!data.shift);
  else if (data.type === "area") exploreAreaMessage(data);
  else if (data.type === "pickoff") exploreSetPicking(false);
  // Escape inside the page closes the dialog, as it does anywhere else in it; the draft is kept.
  else if (data.type === "escape" && $("addMonitorDialog").open) $("addMonitorDialog").close();
});
function exploreMarkPicked() {
  const a = state.add;
  if (!a.page) return;
  const indexes = [];
  a.page.links.forEach((link, index) => { if (a.picked.has(L.urlKey(link.url))) indexes.push(index); });
  explorePost({ type: "picked", indexes });
}
function exploreLocate(url) {
  const a = state.add;
  if (!a.page || a.step !== "explore") return;
  const key = L.urlKey(url);
  const index = a.page.links.findIndex(link => L.urlKey(link.url) === key);
  if (index >= 0) explorePost({ type: "locate", index });
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
  else if (o.covered) tags.push('<span class="tag is-rule">In your document rule</span>');
  if (o.part) tags.push('<span class="tag is-part">' + esc(o.part) + "</span>");
  if (o.older) tags.push('<span class="tag is-older">Older version</span>');
  (o.reasons || []).filter(reason => !/ file$/.test(reason)).slice(0, 2).forEach(reason => tags.push('<span class="reason">' + esc(reason) + "</span>"));
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
  const suggestions = a.page ? exploreSuggestions() : { items: [] };
  $("exploreSuggestedCount").textContent = a.page ? String(suggestions.items.length) : "";
  document.querySelectorAll("[data-explore-tab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.exploreTab === a.tab)));
  $("exploreSelectMode").checked = a.selectMode;
  const pickButton = document.querySelector("[data-explore-pick]");
  if (pickButton) { pickButton.disabled = !a.page; pickButton.setAttribute("aria-pressed", String(a.picking)); pickButton.textContent = a.picking ? "Picking… (Esc)" : "Pick a part"; }
  $("exploreHint").innerHTML = a.picking
    ? "Click any part of the page — a table, a list, a section — to select it."
    : a.selectMode
    ? "Tap selects is on: clicking or tapping a link selects it. Turn it off to browse."
    : coarsePointer && coarsePointer.matches ? "Tap a link to open it here. Turn on <strong>Tap selects</strong> to select links, or use <strong>Pick a part</strong>."
      : "<kbd>Shift</kbd>-click a link to select it. <kbd>Shift</kbd>-drag to box an area. Click a link to open it here.";
  const thisPage = a.page ? a.picked.has(L.urlKey(a.page.url)) : false;
  const thisButton = document.querySelector("[data-explore-this]");
  thisButton.setAttribute("aria-pressed", String(thisPage));
  thisButton.textContent = thisPage ? "This page selected" : "Select this page";
  thisButton.disabled = !a.page;
  document.querySelector("[data-explore-back]").disabled = a.at <= 0;
  document.querySelector("[data-explore-forward]").disabled = a.at >= a.history.length - 1;
  const list = $("exploreList");
  const tools = exploreToolsHtml();
  const covered = addRuleCoveredKeys();
  const rowOptions = item => ({ covered: covered.has(item.key), part: addRulesFor(item.key).include ? "Watching one part" : addRulesFor(item.key).ignore.length ? "Ignoring " + plural(addRulesFor(item.key).ignore.length, "part", "parts") : "" });
  if (a.tab === "selected") {
    list.innerHTML = tools + (picked.length ? picked.slice().reverse().map(item => addPickRow(item, rowOptions(item))).join("")
      : emptyState("Nothing selected yet", "Shift-click links on the page, Shift-drag a box around several, or tick them under “Suggested” and “On this page”."));
  } else if (a.tab === "suggested" && a.page) {
    list.innerHTML = tools + exploreSuggestedHtml();
  } else if (!a.page) {
    list.innerHTML = '<div class="loading">Reading the page…</div>';
  } else if (!a.page.links.length) {
    list.innerHTML = emptyState("No links found", "This page has no links in its HTML. Some sites build their links with script, which the reader does not run.");
  } else {
    const content = a.page.links.filter(link => !link.chrome);
    const menus = a.page.links.length - content.length;
    list.innerHTML = tools + L.pickSections(content.map(link => addLinkItem(link, a.page, null)).filter(Boolean)).map((group, index) =>
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

/* ---------- Smarter picking: areas, page rules, suggestions, similar links, document rules ---------- */

const RULE_LIMITS = { selector: 500, ignore: 20 };
function addPageKey() { return state.add.page ? L.urlKey(state.add.page.url) : ""; }
function addRulesFor(key) {
  const rules = state.add.rules[key];
  return rules && typeof rules === "object" ? { include: String(rules.include || ""), ignore: Array.isArray(rules.ignore) ? rules.ignore.map(String) : [] } : { include: "", ignore: [] };
}
function addSetRules(key, rules) {
  const a = state.add;
  if (!rules.include && !rules.ignore.length) delete a.rules[key];
  else a.rules[key] = { include: rules.include, ignore: rules.ignore.slice(0, RULE_LIMITS.ignore) };
  // A document rule already requested for this page carries the old checking rules.
  if (a.ruleRequests[key]) a.ruleRequests[key].stale = true;
  exploreSendRules();
  addSaveDraft();
}
function exploreSendRules() {
  const rules = addRulesFor(addPageKey());
  explorePost({ type: "rules", include: rules.include, ignore: rules.ignore });
}
function exploreSetPicking(on) {
  const a = state.add;
  a.picking = !!on;
  explorePost({ type: "pick", on: a.picking });
  const button = document.querySelector("[data-explore-pick]");
  if (button) {
    button.setAttribute("aria-pressed", String(a.picking));
    button.textContent = a.picking ? "Picking… (Esc)" : "Pick a part";
  }
}
function exploreContentLinks() {
  const a = state.add;
  return a.page ? a.page.links.filter(link => !link.chrome) : [];
}
// Suggestions for the page being explored: documents and pages a compliance team
// would most likely monitor, best first, with older versions of the same document
// held back.
function exploreSuggestions() {
  const a = state.add;
  if (!a.page) return { items: [], older: [] };
  const links = a.page.links;
  const olderIndexes = L.pickVersions(links);
  const rows = [];
  const older = [];
  const seen = new Set();
  links.forEach((link, index) => {
    if (link.chrome) return;
    const key = L.urlKey(link.url);
    if (seen.has(key)) return;
    seen.add(key);
    const score = L.pickScore(link);
    const isOlder = score.older || olderIndexes.has(index);
    const row = { link, index, key, score: score.score, reasons: score.reasons, older: isOlder };
    if (isOlder) { if (score.score >= 2) older.push(row); return; }
    if (score.score >= 3) rows.push(row);
  });
  rows.sort((x, y) => y.score - x.score || x.index - y.index);
  return { items: rows, older };
}
function explorePickedOnPage() {
  const a = state.add;
  return exploreContentLinks().filter(link => a.picked.has(L.urlKey(link.url)));
}
function addSelectKeys(keys, links) {
  const a = state.add;
  const byKey = new Map();
  (links || []).forEach(link => { const key = L.urlKey(link.url); if (!byKey.has(key)) byKey.set(key, link); });
  let added = 0;
  keys.forEach(key => {
    if (a.picked.has(key)) return;
    const link = byKey.get(key);
    const item = link ? (link.key ? link : addLinkItem(link, a.page, null)) : a.candidates.find(candidate => candidate.key === key);
    if (!item) return;
    if (!a.candidates.some(candidate => candidate.key === item.key)) a.candidates.push(item);
    a.picked.set(item.key, a.candidates.find(candidate => candidate.key === item.key) || item);
    added += 1;
  });
  return added;
}
function ruleDraftFor(key) {
  const a = state.add;
  if (!a.ruleDrafts[key]) {
    const recipe = L.pickRecipe(a.page.url, explorePickedOnPage(), a.page.links) || {};
    a.ruleDrafts[key] = { folder: recipe.prefix || "", pattern: recipe.textPattern || "" };
  }
  return a.ruleDrafts[key];
}
function ruleSummaryHtml(matches) {
  if (matches.error) return '<span class="rule-error">' + esc(matches.error) + "</span>";
  return "Today that’s <strong>" + plural(matches.count, "document", "documents") + "</strong> on this page. New ones that match are picked up automatically; no other page on the site is followed.";
}
function exploreToolsHtml() {
  const a = state.add;
  if (!a.page) return "";
  const key = addPageKey();
  const parts = [];
  // The part of the page last boxed or picked.
  if (a.area && a.area.pageKey === key) {
    const area = a.area;
    const free = (area.indexes || []).filter(index => a.page.links[index] && !a.picked.has(L.urlKey(a.page.links[index].url)));
    parts.push('<section class="smart-card area-card" aria-label="Selected area">' +
      '<div class="smart-card-head"><span class="smart-kicker">Selected area</span><button class="text-button" type="button" data-area-clear aria-label="Clear the selected area">Clear</button></div>' +
      '<strong class="area-label">' + esc(area.label || "Part of the page") + "</strong>" +
      (area.text ? '<p class="area-text">' + esc(area.text) + (area.words > 36 ? "…" : "") + "</p>" : "") +
      '<div class="smart-actions">' +
        (area.indexes && area.indexes.length ? '<button class="btn btn-primary" type="button" data-area-select' + (free.length ? "" : " disabled") + ">" +
          (free.length ? "Select its " + plural(free.length, "link", "links") : "Its links are selected") + "</button>" : "") +
        (area.selector ? '<button class="btn" type="button" data-area-watch title="Compare only this part when the page is checked">Watch only this part</button>' +
          '<button class="btn" type="button" data-area-ignore title="Leave this part out when the page is checked (menus, banners, dates that change every day)">Ignore this part</button>' : "") +
      "</div>" +
      (area.selector ? '<code class="area-selector" title="CSS selector">' + esc(area.selector) + "</code>" : "") +
      "</section>");
  }
  // Rules already set for this page.
  const rules = addRulesFor(key);
  if (rules.include || rules.ignore.length) {
    parts.push('<section class="smart-card rules-card" aria-label="How this page is checked">' +
      '<div class="smart-card-head"><span class="smart-kicker">How this page is checked</span></div>' +
      (rules.include ? '<div class="rule-chip is-watch"><span>Only</span><code>' + esc(rules.include) + '</code><button type="button" data-rule-remove="include" aria-label="Remove">×</button></div>' : "") +
      rules.ignore.map((selector, index) => '<div class="rule-chip is-ignore"><span>Ignore</span><code>' + esc(selector) + '</code><button type="button" data-rule-remove="' + index + '" aria-label="Remove">×</button></div>').join("") +
      (a.ruleRequests[key] && a.ruleRequests[key].stale
        ? '<p class="smart-note is-warning">Your document rule for this page was requested before this change.</p><div class="smart-actions"><button class="btn btn-primary" type="button" data-rule-request>Update the rule request</button></div>'
        : '<p class="smart-note">Applies when this page is requested as a monitor.</p>') + "</section>");
  }
  // More like what was picked here.
  const picked = explorePickedOnPage();
  if (picked.length) {
    const similar = L.pickSimilar(picked, exploreContentLinks(), link => L.urlKey(link.url)).slice(0, 3);
    a.similar = similar;
    if (similar.length) {
      parts.push('<div class="similar-row" role="group" aria-label="Select similar links"><span class="smart-kicker">Select similar</span>' +
        similar.map((rule, index) => '<button class="similar-chip" type="button" data-similar="' + index + '"><b>+' + rule.extra + "</b> " + esc(rule.label) + "</button>").join("") + "</div>");
    }
    // Teach the monitor the pattern instead of a fixed list.
    const docs = picked.filter(link => link.format !== "Web page");
    if (docs.length) {
      const request = a.ruleRequests[key];
      if (!a.ruleOpen) {
        parts.push('<button class="rule-open" type="button" data-rule-open><span class="rule-open-mark" aria-hidden="true">↻</span><span><strong>' +
          (request ? "Document rule requested" : "Make this a monitoring rule") + "</strong><small>" +
          (request ? "Open it again or change it" : "Watch this page and every document like these, including future ones") + "</small></span></button>");
      } else {
        const draft = ruleDraftFor(key);
        const matches = L.pickRuleMatches(a.page.links, draft);
        parts.push('<section class="smart-card rule-card" aria-label="Monitoring rule">' +
          '<div class="smart-card-head"><span class="smart-kicker">Monitoring rule</span><button class="text-button" type="button" data-rule-close>Close</button></div>' +
          '<p class="rule-lede">Watch <strong>' + esc(a.page.title || displayUrl(a.page.url)) + "</strong> and the documents it links to:</p>" +
          '<label class="rule-field"><span>In this folder</span><input class="field-input" id="ruleFolder" type="url" spellcheck="false" autocomplete="off" value="' + esc(draft.folder) + '" placeholder="Anywhere on this site"></label>' +
          '<label class="rule-field"><span>Whose link text matches</span><input class="field-input" id="rulePattern" type="text" spellcheck="false" autocomplete="off" value="' + esc(draft.pattern) + '" placeholder="Any link text (for example ^Current)"></label>' +
          '<p class="rule-count" id="ruleCount" aria-live="polite">' + ruleSummaryHtml(matches) + "</p>" +
          (rules.include || rules.ignore.length ? '<p class="smart-note">The page is checked with the rules above.</p>' : "") +
          '<div class="smart-actions"><button class="btn btn-primary" type="button" data-rule-request' + (matches.error ? " disabled" : "") + ">" + (request ? "Open the rule request again" : "Request this rule on GitHub") + "</button>" +
          '<button class="text-button" type="button" data-rule-show>Show matches</button></div>' +
          (request ? '<p class="smart-note">Requested ' + esc(when(request.at)) + ". Its documents are left out of the link requests, so nothing is registered twice.</p>" : "") +
          "</section>");
      }
    }
  }
  return parts.length ? '<div class="smart-tools">' + parts.join("") + "</div>" : "";
}
function exploreSuggestedHtml() {
  const a = state.add;
  const suggestions = exploreSuggestions();
  const free = suggestions.items.filter(row => !a.picked.has(row.key));
  if (!suggestions.items.length) {
    return emptyState("No clear suggestions", "Nothing on this page looks like a form, template, instructions or a regulatory document. See “On this page” for every link.");
  }
  const row = item => {
    const entry = addLinkItem(item.link, a.page, null);
    return entry ? addPickRow(entry, { open: entry.format === "Web page", reasons: item.reasons, older: item.older }) : "";
  };
  return '<div class="link-group"><span class="link-group-name"><strong>Likely worth monitoring</strong> · ' + suggestions.items.length + "</span>" +
      (free.length ? '<button class="text-button" type="button" data-suggest-all>Select all ' + free.length + "</button>" : "") + "</div>" +
    suggestions.items.map(row).join("") +
    (suggestions.older.length ? '<div class="link-group"><span class="link-group-name"><strong>Older versions</strong> · ' + suggestions.older.length + "</span>" +
      '<button class="text-button" type="button" data-older-toggle>' + (a.showOlder ? "Hide" : "Show") + "</button></div>" +
      (a.showOlder ? suggestions.older.map(row).join("") : '<p class="note-strip">Earlier years and superseded copies of the documents above are held back.</p>') : "");
}
function exploreAreaMessage(data) {
  const a = state.add;
  if (!a.page) return;
  const indexes = (Array.isArray(data.indexes) ? data.indexes : []).map(Number).filter(index => Number.isInteger(index) && a.page.links[index]).slice(0, 2000);
  a.area = { pageKey: addPageKey(), indexes, selector: String(data.selector || "").slice(0, 1000), label: String(data.label || "").slice(0, 120),
    text: String(data.text || "").slice(0, 240), words: Number(data.words) || 0, how: data.how === "pick" ? "pick" : "drag" };
  if (a.picking) exploreSetPicking(false);
  renderExploreSide();
  const list = $("exploreList");
  if (list) list.scrollTop = 0;
}
function exploreAreaAction(kind) {
  const a = state.add;
  const area = a.area;
  if (!area || !a.page || area.pageKey !== addPageKey()) return;
  if (kind === "select") {
    const added = addSelectKeys(area.indexes.map(index => L.urlKey(a.page.links[index].url)), area.indexes.map(index => a.page.links[index]));
    exploreMarkPicked();
    renderExploreSide();
    addSaveDraft();
    showToast(added ? plural(added, "link", "links") + " selected from the area." : "Those links were already selected.");
    return;
  }
  if (!area.selector) return;
  if (area.selector.length > RULE_LIMITS.selector) { showToast("That part of the page has no short selector. Pick a smaller or more distinct part."); return; }
  const key = addPageKey();
  const rules = addRulesFor(key);
  if (kind === "watch") {
    rules.include = area.selector;
    rules.ignore = rules.ignore.filter(selector => selector !== area.selector);
    const previous = a.at > 0 ? a.pages.get(L.urlKey(a.history[a.at - 1])) : null;
    const pageItem = addItem({ url: a.page.url, title: a.page.title, parentUrl: previous ? previous.url : "", parentTitle: previous ? previous.title : "" });
    if (pageItem && !a.picked.has(pageItem.key)) addToggle(pageItem, true);
    showToast("This page will be compared only within “" + area.label + "”. The page is selected for monitoring.");
  } else {
    if (rules.ignore.length >= RULE_LIMITS.ignore) { showToast("A page can ignore at most " + RULE_LIMITS.ignore + " parts."); return; }
    if (rules.ignore.indexOf(area.selector) < 0) rules.ignore.push(area.selector);
    if (rules.include === area.selector) rules.include = "";
    showToast("“" + area.label + "” will be left out when this page is checked.");
  }
  a.area = null;
  explorePost({ type: "area-clear" });
  addSetRules(key, rules);
  renderExploreSide();
}
function exploreRuleInput() {
  const a = state.add;
  const key = addPageKey();
  if (!key || !a.ruleDrafts[key]) return;
  a.ruleDrafts[key].folder = ($("ruleFolder") || {}).value || "";
  a.ruleDrafts[key].pattern = ($("rulePattern") || {}).value || "";
  const matches = L.pickRuleMatches(a.page.links, a.ruleDrafts[key]);
  $("ruleCount").innerHTML = ruleSummaryHtml(matches);
  const button = document.querySelector("[data-rule-request]");
  if (button) button.disabled = !!matches.error;
}
function exploreRuleShow() {
  const a = state.add;
  const key = addPageKey();
  const matches = L.pickRuleMatches(a.page.links, ruleDraftFor(key));
  const indexes = [];
  a.page.links.forEach((link, index) => { if (matches.keys.indexOf(L.urlKey(link.url)) >= 0) indexes.push(index); });
  explorePost({ type: "picked", indexes });
  if (indexes.length) explorePost({ type: "locate", index: indexes[0] });
  showToast(indexes.length ? "Matching documents are outlined on the page for a moment." : "Nothing on this page matches the rule yet.");
  window.setTimeout(exploreMarkPicked, 2600);
}
function exploreRuleRequest() {
  const a = state.add;
  const key = addPageKey();
  if (!a.page || !key) return;
  const draft = ruleDraftFor(key);
  const matches = L.pickRuleMatches(a.page.links, draft);
  if (matches.error) { showToast(matches.error); return; }
  const rules = addRulesFor(key);
  const request = L.pickRuleRequest({ url: a.page.url, name: a.page.title || "", folder: draft.folder, pattern: draft.pattern, include: rules.include, ignore: rules.ignore });
  const params = new URLSearchParams();
  params.set("title", request.title);
  params.set("body", request.body);
  const target = REPO + "/issues/new?" + params.toString();
  if (target.length > MAX_BULK_REQUEST_URL_LENGTH) { showToast("This rule is too long for a GitHub request. Shorten the pattern or selectors."); return; }
  a.ruleRequests[key] = { url: a.page.url, title: a.page.title || "", folder: draft.folder, pattern: draft.pattern, keys: matches.keys.concat([key]), at: new Date().toISOString() };
  addSaveDraft();
  renderExploreSide();
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) {
    try { githubWindow.opener = null; } catch (_) {}
    showToast("Submit the rule request on GitHub. Once the owner workflow accepts it, the page and its matching documents are monitored.");
  } else {
    showToast("Your browser blocked the new tab. Allow pop-ups for this dashboard and press the button again.");
  }
}
// Keys a requested document rule already covers: left out of the link requests.
function addRuleCoveredKeys() {
  const covered = new Set();
  Object.values(state.add.ruleRequests || {}).forEach(request => (request.keys || []).forEach(key => covered.add(key)));
  return covered;
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
  return items.map(item => {
    const rules = addRulesFor(item.key);
    return { url: item.url, name: L.pickMonitorName(item), include_selector: rules.include, ignore_selectors: rules.ignore };
  });
}
function addPlan() {
  const a = state.add;
  const monitored = addMonitoredKeys();
  const stopped = addStoppedKeys(monitored);
  const picked = Array.from(a.picked.values());
  const summary = L.pickSummary(picked, monitored);
  const covered = addRuleCoveredKeys();
  const notStopped = summary.pending.filter(item => !stopped.has(item.key));
  const leftStopped = summary.pending.length - notStopped.length;
  const pending = notStopped.filter(item => !covered.has(item.key));
  const leftCovered = notStopped.length - pending.length;
  const prepared = L.pickBatches(addRequestRows(pending), makeBulkGitHubIssueUrl, MAX_BULK_LINKS, MAX_BULK_REQUEST_URL_LENGTH);
  return { monitored, stopped, covered, picked, summary, pending, leftStopped, leftCovered, prepared };
}
function renderReview() {
  const a = state.add;
  const plan = addPlan();
  const filters = { query: a.query, format: a.format, show: a.show, selectedKeys: new Set(a.picked.keys()) };
  // Scores and older versions, worked out once per candidate list.
  if (a.scored !== a.candidates || a.scoredCount !== a.candidates.length) {
    const olderIndexes = L.pickVersions(a.candidates);
    a.scores = new Map();
    a.candidates.forEach((item, index) => {
      const score = L.pickScore(item);
      a.scores.set(item.key, { score: score.score, reasons: score.reasons, older: score.older || olderIndexes.has(index) });
    });
    a.scored = a.candidates;
    a.scoredCount = a.candidates.length;
  }
  const scoreOf = item => a.scores.get(item.key) || { score: 0, reasons: [], older: false };
  const pool = a.candidates.filter(item => {
    const score = scoreOf(item);
    if (a.picked.has(item.key)) return a.show !== "SUGGESTED" || score.score >= 3;
    if (a.hideOlder && score.older) return false;
    return a.show !== "SUGGESTED" || score.score >= 3;
  });
  const hiddenOlder = a.hideOlder ? a.candidates.filter(item => !a.picked.has(item.key) && scoreOf(item).older).length : 0;
  const groups = L.pickGroupBy(pool, Object.assign({}, filters, { show: a.show === "SUGGESTED" ? "ALL" : a.show }));
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const notes = a.origin === "crawl"
    ? ["Found " + plural(a.candidates.length, "link", "links") + (a.crawl ? " on " + plural(a.crawl.read, "page", "pages") : "") + ". Nothing is ticked yet: tick the ones to monitor. Historical and unrelated links are listed too, so you decide.", a.info || ""]
    : a.origin === "scout" ? ["These are the Scout findings you selected. Untick any you don't want; each one is requested as its own monitor."]
    : ["These are the links you selected while exploring. Untick any you don't want."];
  if (hiddenOlder) notes.push(plural(hiddenOlder, "older version is", "older versions are") + " hidden.");
  const rulesRequested = Object.values(a.ruleRequests || {});
  if (rulesRequested.length) notes.push(plural(rulesRequested.length, "document rule was", "document rules were") + " requested; the links " + (rulesRequested.length === 1 ? "it covers are" : "they cover are") + " left out of these requests.");
  $("reviewNote").textContent = notes.concat(a.notes).filter(Boolean).join(" ");
  if ($("reviewHideOlder")) $("reviewHideOlder").checked = a.hideOlder;
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
    const tickedItems = Array.from(a.picked.values()).filter(item => !plan.monitored.has(item.key));
    a.reviewSimilar = tickedItems.length ? L.pickSimilar(tickedItems.slice(0, 200), a.candidates.filter(item => !plan.monitored.has(item.key) && !plan.stopped.has(item.key) && !(a.hideOlder && scoreOf(item).older)), item => item.key).slice(0, 3) : [];
    if (a.reviewSimilar.length) {
      html += '<div class="review-similar" role="group" aria-label="Tick similar links"><span class="smart-kicker">Tick similar</span>' +
        a.reviewSimilar.map((rule, index) => '<button class="similar-chip" type="button" data-review-similar="' + index + '"><b>+' + rule.extra + "</b> " + esc(rule.label) + "</button>").join("") + "</div>";
    }
    groups.forEach((group, index) => {
      if (shown >= a.limit) return;
      const rows = group.items.slice(0, a.limit - shown);
      const free = group.items.filter(item => !plan.monitored.has(item.key) && !plan.stopped.has(item.key));
      const all = free.length && free.every(item => a.picked.has(item.key));
      html += '<div class="link-group"><span class="link-group-name"><strong>' + esc(group.parentTitle || "Starting page") + "</strong>" +
        (group.section ? " · " + esc(group.section) : "") + " · " + group.items.length + "</span>" +
        (free.length ? '<button class="text-button" type="button" data-review-group="' + index + '">' + (all ? "Untick these" : "Tick these") + "</button>" : "") + "</div>" +
        rows.map(item => {
          const score = scoreOf(item);
          const rules = addRulesFor(item.key);
          return addPickRow(item, { monitored: plan.monitored.has(item.key), stopped: plan.stopped.has(item.key), locked: plan.monitored.has(item.key) || plan.stopped.has(item.key),
            covered: plan.covered.has(item.key), reasons: score.reasons, older: score.older,
            part: rules.include ? "Watching one part" : rules.ignore.length ? "Ignoring " + plural(rules.ignore.length, "part", "parts") : "" });
        }).join("");
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
  if (p.leftCovered) parts.push(p.leftCovered + " covered by your document rule");
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
// One optional condition for every new monitor in the review step's requests.
function reviewAlertCondition() {
  const field = $("reviewCondition");
  const condition = field ? field.value.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  const only = !!($("reviewConditionOnly") && $("reviewConditionOnly").checked);
  if (only && !condition) { showToast("Describe the condition to alert on, or untick \u201cAlert only when it is met\u201d."); return null; }
  return condition ? { condition, only } : {};
}
function reviewOpenBatch(index) {
  const a = state.add;
  const plan = addPlan();
  const batch = plan.prepared.batches[index];
  if (!batch) return renderReviewFoot(plan);
  const alert = reviewAlertCondition();
  if (alert === null) return;
  const target = makeBulkGitHubIssueUrl(batch, alert);
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
  const alertCondition = $("newMonitorAlertCondition").value.replace(/\s+/g, " ").trim().slice(0, 500);
  const alertOnly = $("newMonitorAlertOnly").checked;
  if (alertOnly && !alertCondition) {
    showToast("Describe the condition to alert on, or untick “Alert only when it is met”.");
    return;
  }
  const target = makeGitHubIssueUrl(parsed.toString(), name, includeSelector, ignoreSelectors, 0, false, { condition: alertCondition, only: alertOnly });
  ["newMonitorName", "newMonitorIncludeSelector", "newMonitorIgnoreSelectors", "newMonitorAlertCondition"].forEach(id => { $(id).value = ""; });
  $("newMonitorAlertOnly").checked = false;
  $("newMonitorMetadataStatus").textContent = "";
  openGitHubRequest(target, "Submit the prefilled request on GitHub. The page is scanned once the request is accepted.");
}

function makeGitHubIssueUrl(url, name, includeSelector, ignoreSelectors, crawlDepth, scoutEnabled, alert) {
  const bodyLines = [
    "<!-- changesentinel:add-monitor:v1 -->", "",
    "Please register this URL as a ChangeSentinel monitor.", "",
    "URL: " + url, "Name: " + (name || ""), "Crawl depth: " + String(Number.isInteger(Number(crawlDepth)) ? Math.max(0, Math.min(3, Number(crawlDepth))) : 0), "Scout discovery: " + (scoutEnabled ? "yes" : "no")
  ];
  // Optional per-monitor alert condition; omitted entirely when not set so an
  // existing monitor's condition is left unchanged.
  if (alert && alert.condition) {
    bodyLines.push("Alert me when: " + alert.condition, "Alert only when condition met: " + (alert.only ? "yes" : "no"));
  } else if (alert && alert.clear) {
    bodyLines.push("Alert me when: ");
  }
  bodyLines.push("Include selector: " + (includeSelector || ""), "Ignore selectors:");
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
function makeBulkGitHubIssueUrl(rows, alert) {
  const bodyLines = [
    BULK_REQUEST_MARKER, "",
    "Please register the URLs listed below as ChangeSentinel monitors.", ""
  ];
  if (alert && alert.condition) bodyLines.push("Alert me when: " + alert.condition, "Alert only when condition met: " + (alert.only ? "yes" : "no"), "");
  bodyLines.push(
    "BULK_DATA_JSON:",
    JSON.stringify(rows),
    "",
    "This request was created from the ChangeSentinel dashboard bulk upload."
  );
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
  const target = event.target.closest("[data-review-change],[data-evidence-pack],[data-export-changes],[data-copy-calendar],[data-verify-fingerprints],[data-select-change],[data-monitor-id],[data-select-run],[data-select-health],[data-edit-condition],[data-edit-schedule],[data-channel-guide],[data-select-notification],[data-go],[data-open-page],[data-back],[data-diff-mode],[data-detail-tab],[data-snapshot-mode],[data-pdf-action],[data-refresh],[data-add-monitor],[data-change-filter],[data-filter],[data-scout-key],[data-scout-filter],[data-scout-coverage],[data-scout-monitor],[data-scout-dismiss],[data-scout-restore],[data-scout-run],[data-scout-add-source],[data-scout-add-channel],[data-scout-edit],[data-calendar-mode],[data-calendar-jump-date],[data-calendar-prev],[data-calendar-next],[data-calendar-today],[data-calendar-new],[data-calendar-export],[data-calendar-day],[data-calendar-edit],[data-calendar-delete],[data-calendar-complete],[data-calendar-open-change],[data-calendar-test],[data-calendar-signout],[data-calendar-plan],[data-calendar-track],[data-calendar-ics],[data-calendar-monitor]");
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
  if (data.calendarPlan !== undefined) return openCadencePlanner();
  if (data.calendarTrack !== undefined) return trackDetectedDate(data.calendarTrack, data.calendarDate);
  if (data.calendarIcs) return downloadCadenceEvent(data.calendarIcs);
  if (data.calendarMonitor) {
    openAddMonitor();
    $("newMonitorUrl").value = data.calendarMonitor;
    $("addExact").open = true;
    return;
  }
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
  if (data.selectHealth) return select("health", data.selectHealth);
  if (data.editCondition) return openConditionDialog(data.editCondition);
  if (data.editSchedule) return openScanSchedule(data.editSchedule.split(","));
  if (data.channelGuide !== undefined) { const guide = $("channelGuide"); if (guide) { guide.open = true; guide.scrollIntoView({ block: "nearest" }); } return; }
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
// LED tooltips: which page, which scan, what happened. A mouse hovers; a touch
// pins the tip to the tapped light with its actions instead of navigating away.
let lastPointerType = "mouse";
$("signalVisual").addEventListener("pointermove", event => {
  if (event.pointerType !== "mouse") return;
  const tip = $("fieldTip");
  if (tip.classList.contains("is-pinned")) return;
  showFieldTip(event.target.closest(".led"), event.clientX, event.clientY);
});
$("signalVisual").addEventListener("pointerover", event => {
  const label = event.target.closest && event.target.closest(".field-label[data-row]");
  if (label) ledField.hoverRow(Number(label.dataset.row));
  else if (!(event.target.closest && event.target.closest(".led"))) ledField.hoverRow(-1);
});
$("signalVisual").addEventListener("pointerleave", event => {
  ledField.hoverRow(-1); if (event.pointerType === "mouse" && !$("fieldTip").classList.contains("is-pinned")) hideFieldTip(); });
document.addEventListener("pointerdown", event => {
  lastPointerType = event.pointerType || "mouse";
  const tip = $("fieldTip");
  if (!tip.hidden && !tip.contains(event.target) && !(event.target.closest && event.target.closest("#signalVisual .led"))) hideFieldTip();
}, true);
// Safari keeps the last hovered element "under" the pointer after the view
// changes, so any mouse movement away from the lights also clears the tip.
document.addEventListener("pointermove", event => {
  if (event.pointerType !== "mouse") return;
  const tip = $("fieldTip");
  if (tip.hidden || tip.classList.contains("is-pinned")) return;
  if (!(event.target.closest && event.target.closest("#signalVisual .led"))) hideFieldTip();
}, { passive: true, capture: true });
document.addEventListener("scroll", () => { if (!$("fieldTip").hidden) hideFieldTip(); }, true);
window.addEventListener("blur", hideFieldTip);
document.addEventListener("visibilitychange", () => { if (document.hidden) hideFieldTip(); });
$("signalVisual").addEventListener("click", event => {
  const more = event.target.closest("[data-field-more]");
  if (more) {
    event.stopPropagation();
    const prefs = fieldPrefs();
    const key = more.dataset.fieldMore;
    prefs.limits[key] = (prefs.limits[key] || prefs.limit) + 60;
    renderMonitoringSignal();
    return;
  }
  const led = event.target.closest(".led");
  const groupLabel = event.target.closest(".field-group-label, .field-section-label");
  if (led && lastPointerType !== "mouse" && led.dataset.state !== "none") {
    // Touch: show what this light means first; the tip carries the way in.
    event.stopPropagation();
    event.preventDefault();
    showFieldTip(led, 0, 0, true);
    return;
  }
  const groupKey = (groupLabel && groupLabel.dataset.fieldGroup) || (led && led.dataset.fieldGroup);
  if (groupKey) {
    event.stopPropagation();
    toggleFieldGroup(groupKey);
    return;
  }
  if (led && led.dataset.state === "pending") event.stopPropagation();
});
function toggleFieldGroup(key) {
  const prefs = fieldPrefs();
  if (key.indexOf("src:") === 0 || key.indexOf("sec:") === 0) { if (prefs.closed.has(key)) prefs.closed.delete(key); else prefs.closed.add(key); }
  else if (prefs.open.has(key)) prefs.open.delete(key); else prefs.open.add(key);
  hideFieldTip();
  renderMonitoringSignal();
}
$("fieldTip").addEventListener("click", event => {
  const open = event.target.closest("[data-tip-open]");
  const group = event.target.closest("[data-tip-group]");
  if (event.target.closest("[data-tip-close]")) return hideFieldTip();
  if (open) { hideFieldTip(); return select("monitors", open.dataset.tipOpen); }
  if (group) return toggleFieldGroup(group.dataset.tipGroup);
});
document.querySelector(".field-wrap").addEventListener("click", event => {
  const lens = event.target.closest("[data-field-lens]");
  if (!lens) return;
  const prefs = fieldPrefs();
  prefs.lens = L.FIELD_LENSES.indexOf(lens.dataset.fieldLens) >= 0 ? lens.dataset.fieldLens : "activity";
  if (!lens.closest(".field-lenses")) { prefs.query = ""; $("fieldSearch").value = ""; }
  prefs.limit = 80;
  saveFieldPrefs();
  hideFieldTip();
  renderMonitoringSignal();
});
$("fieldGroup").addEventListener("change", () => {
  const prefs = fieldPrefs();
  prefs.groupBy = Object.prototype.hasOwnProperty.call(FIELD_GROUPS, $("fieldGroup").value) ? $("fieldGroup").value : "regulator";
  prefs.limits = {};
  saveFieldPrefs();
  hideFieldTip();
  renderMonitoringSignal();
});
$("fieldRange").addEventListener("change", () => {
  const prefs = fieldPrefs();
  prefs.range = Object.prototype.hasOwnProperty.call(L.FIELD_RANGES, $("fieldRange").value) ? $("fieldRange").value : "7d";
  saveFieldPrefs();
  $("fieldViewport").dataset.initialized = "";
  renderMonitoringSignal();
});
document.querySelectorAll("[data-field-view]").forEach(button => button.addEventListener("click", () => {
  const prefs = fieldPrefs();
  prefs.view = button.dataset.fieldView === "timeline" ? "timeline" : "grid";
  prefs.storyLimit = 60;
  saveFieldPrefs();
  hideFieldTip();
  renderMonitoringSignal();
}));
$("tlLanes").addEventListener("change", () => {
  const prefs = fieldPrefs();
  prefs.tlLanes = TL_LANES.indexOf($("tlLanes").value) >= 0 ? $("tlLanes").value : "page";
  prefs.tlLaneLimit = TL_LANE_LIMIT;
  saveFieldPrefs();
  hideTimelineTip();
  renderMonitoringSignal();
});
document.querySelector(".field-wrap").addEventListener("click", event => {
  const show = event.target.closest("[data-tl-show]");
  if (!show) return;
  const prefs = fieldPrefs();
  prefs.tlShow = TL_SHOWS.indexOf(show.dataset.tlShow) >= 0 ? show.dataset.tlShow : "changed";
  prefs.tlLaneLimit = TL_LANE_LIMIT;
  prefs.storyLimit = 60;
  saveFieldPrefs();
  hideTimelineTip();
  renderMonitoringSignal();
});
$("timelineView").addEventListener("click", event => {
  if (event.target.closest("[data-tl-lanes-more]")) { event.stopPropagation(); fieldPrefs().tlLaneLimit = (fieldPrefs().tlLaneLimit || TL_LANE_LIMIT) + TL_LANE_LIMIT * 2; return renderMonitoringSignal(); }
  const bead = event.target.closest("[data-tl-bead]");
  if (bead) { event.stopPropagation(); hideTimelineTip(); return focusTimelineBead(bead.dataset.tlBead); }
  if (event.target.closest("[data-tl-more]")) { event.stopPropagation(); fieldPrefs().storyLimit = (fieldPrefs().storyLimit || 60) + 60; return renderMonitoringSignal(); }
  const range = event.target.closest("[data-tl-range]");
  if (range) { event.stopPropagation(); const prefs = fieldPrefs(); prefs.range = "all"; saveFieldPrefs(); return renderMonitoringSignal(); }
});
$("timelineView").addEventListener("pointerover", event => {
  const bead = event.target.closest("[data-tl-bead]");
  if (bead && event.pointerType === "mouse") showTimelineTip(bead);
});
$("timelineView").addEventListener("pointerout", event => {
  if (event.target.closest("[data-tl-bead]") && !(event.relatedTarget && event.relatedTarget.closest && event.relatedTarget.closest("[data-tl-bead]"))) hideTimelineTip();
});
$("timelineView").addEventListener("focusin", event => { const bead = event.target.closest("[data-tl-bead]"); if (bead) showTimelineTip(bead); });
$("timelineView").addEventListener("focusout", hideTimelineTip);
// Health: hover or focus a monitor light or a chart day to read it.
(() => {
  const pane = $("healthDetail");
  if (!pane) return;
  const show = target => {
    const cell = target.closest && target.closest("[data-hx]");
    if (cell) return showHealthCellTip(cell);
    const day = target.closest && target.closest("[data-hc-i]");
    if (day) return showHealthChartTip(day);
  };
  pane.addEventListener("pointerover", event => { if (event.pointerType !== "touch") show(event.target); });
  pane.addEventListener("pointerout", event => {
    const from = event.target.closest && event.target.closest("[data-hx], [data-hc-i]");
    const to = event.relatedTarget && event.relatedTarget.closest && event.relatedTarget.closest("[data-hx], [data-hc-i]");
    if (from && from !== to) hideHealthTips();
  });
  pane.addEventListener("focusin", event => show(event.target));
  pane.addEventListener("focusout", hideHealthTips);
  // Touch: a tap on a chart day shows its numbers (cells open their monitor).
  pane.addEventListener("click", event => { const day = event.target.closest("[data-hc-i]"); if (day) showHealthChartTip(day); });
})();
/* ---------- Phone: More sheet ----------
 * The bottom bar keeps four destinations; everything else opens from More,
 * each with its live status. While one of those views is open, the More tab
 * takes its name, so the bar always says where you are.
 */
const MORE_VIEWS = { health: "Health", runs: "Runs", scout: "Scout", calendar: "Cadence" };
function syncMoreTab() {
  const button = $("navMore");
  if (!button) return;
  const inMore = Object.prototype.hasOwnProperty.call(MORE_VIEWS, state.view);
  button.classList.toggle("is-more-active", inMore);
  button.setAttribute("aria-current", inMore ? "page" : "false");
  $("navMoreLabel").textContent = inMore ? MORE_VIEWS[state.view] : "More";
  const dot = $("navMoreDot");
  const failing = healthTotals().failing || 0;
  const review = state.scout ? scoutBuckets().REVIEW.length : 0;
  dot.hidden = !(failing || review);
  dot.classList.toggle("is-fresh", !failing && review > 0);
  dot.title = failing ? plural(failing, "monitor failing", "monitors failing") : review ? plural(review, "Scout suggestion", "Scout suggestions") + " to review" : "";
}
function renderMoreSheet() {
  const body = $("moreBody");
  if (!body) return;
  const totals = healthTotals();
  const week = (state.health && state.health.last_7_days) || {};
  const tone = totals.failing ? "bad" : totals.stale || totals.inactive ? "warn" : "ok";
  const now = Date.now();
  const order = ["bad", "stale", "warn", "quiet", "on", "ok"];
  const cells = healthMonitors().map(m => L.healthLight(m, now)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .slice(0, 200).map(light => '<i class="l-' + light + '"></i>').join("");
  const healthValue = !state.health ? "Not written yet" : totals.failing ? plural(totals.failing, "monitor failing", "monitors failing")
    : totals.stale ? plural(totals.stale, "monitor overdue", "monitors overdue") : healthNumber(totals.healthy) + " of " + healthNumber(totals.monitors) + " monitors healthy";
  const healthSub = !state.health ? "Appears after the next scan" : healthPercent(week.success_rate) + " of " + healthNumber(week.checks) + " checks ok this week";
  const text = id => { const el = $(id); return el ? el.textContent.trim() : ""; };
  const review = state.scout ? scoutBuckets().REVIEW.length : 0;
  const lastRunAt = state.report && state.report.generated_at;
  const cadence = Number(text("navCadenceCount")) || 0;
  const tile = (view, label, value, sub, logo = "") => '<button type="button" class="more-tile' + (state.view === view ? " is-current" : "") + '" data-more-go="' + view + '">' +
    '<span class="more-label">' + logo + esc(label) + '</span><span class="more-value">' + value + '</span><span class="more-sub">' + sub + "</span></button>";
  const scoutLogo = '<span class="scout-avatar-wrap more-logo" aria-hidden="true">' + ($("scoutLaunch")?.querySelector(".scout-avatar")?.outerHTML || "") + "</span>";
  const cadenceLogo = '<span class="cadence-nav-mark more-logo" aria-hidden="true">' + ($("cadenceLaunch")?.querySelector(".cadence-calendar-avatar")?.outerHTML || "") + "</span>";
  body.innerHTML =
    '<button type="button" class="more-health tone-' + tone + (state.view === "health" ? " is-current" : "") + '" data-more-go="health">' +
      '<span class="more-label">Monitor health<span class="more-go">Health ›</span></span>' +
      '<span class="more-value">' + esc(healthValue) + '</span><span class="more-sub">' + esc(healthSub) + "</span>" +
      '<span class="more-health-cells" aria-hidden="true">' + cells + "</span></button>" +
    '<div class="more-grid">' +
      tile("runs", "Runs", esc(lastRunAt ? relativeTime(lastRunAt) : "None"), esc(text("navRunCount") ? "last scan · " + text("navRunCount") + " saved" : "since the last scan")) +
      tile("scout", "Scout", review ? "<b>" + esc(review) + "</b>" : "0", esc(review ? "pages to review" : "nothing to review"), scoutLogo) +
      tile("calendar", "Cadence", esc(cadence), esc(cadence === 1 ? "date coming up" : "dates coming up"), cadenceLogo) +
    "</div>";
}
let moreReturnFocus = null;
function openMoreSheet() {
  const sheet = $("moreSheet");
  renderMoreSheet();
  moreReturnFocus = document.activeElement;
  sheet.classList.remove("is-closing");
  sheet.hidden = false;
  $("navMore").setAttribute("aria-expanded", "true");
  const first = sheet.querySelector(".more-health");
  if (first) first.focus({ preventScroll: true });
}
function closeMoreSheet(immediate) {
  const sheet = $("moreSheet");
  if (!sheet || sheet.hidden) return;
  $("navMore").setAttribute("aria-expanded", "false");
  const done = () => { sheet.hidden = true; sheet.classList.remove("is-closing"); };
  if (immediate || matchMedia("(prefers-reduced-motion: reduce)").matches) done();
  else { sheet.classList.add("is-closing"); setTimeout(done, 190); }
  if (moreReturnFocus && moreReturnFocus.focus && !immediate) moreReturnFocus.focus({ preventScroll: true });
}
$("navMore").addEventListener("click", () => { if ($("moreSheet").hidden) openMoreSheet(); else closeMoreSheet(); });
$("moreSheet").addEventListener("click", event => {
  const go = event.target.closest("[data-more-go]");
  if (go) { closeMoreSheet(true); return setView(go.dataset.moreGo); }
  if (event.target.closest("[data-more-close]")) return closeMoreSheet();
  if (event.target.closest("[data-more-dismiss]")) closeMoreSheet(true);
});
document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("moreSheet").hidden) { event.stopPropagation(); closeMoreSheet(); } }, true);
// Swipe the sheet down to close it.
(() => {
  const panel = document.querySelector(".more-panel");
  if (!panel) return;
  let startY = null, dy = 0;
  panel.addEventListener("touchstart", event => { startY = panel.scrollTop <= 0 ? event.touches[0].clientY : null; dy = 0; }, { passive: true });
  panel.addEventListener("touchmove", event => {
    if (startY == null) return;
    dy = Math.max(0, event.touches[0].clientY - startY);
    panel.style.transform = dy ? "translateY(" + dy + "px)" : "";
  }, { passive: true });
  panel.addEventListener("touchend", () => { panel.style.transform = ""; if (dy > 90) closeMoreSheet(true); startY = null; dy = 0; });
})();
// Leaving the phone layout closes the sheet.
if (compactQuery && compactQuery.addEventListener) compactQuery.addEventListener("change", () => { if (!isCompact()) closeMoreSheet(true); });
let fieldSearchTimer = 0;
$("fieldSearch").addEventListener("input", () => {
  clearTimeout(fieldSearchTimer);
  fieldSearchTimer = setTimeout(() => {
    const prefs = fieldPrefs();
    prefs.query = $("fieldSearch").value.trim().slice(0, 120);
    prefs.limit = 80;
    renderMonitoringSignal();
  }, 140);
});
// Redraw the field when its width changes enough to fit a different number of
// columns, and re-measure the painted lights whenever it moves or resizes.
if (typeof ResizeObserver === "function") {
  let resizeTimer = null;
  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.loaded || state.view !== "overview") return;
      if (fieldGeometry((state.fieldColumns || []).length).key !== $("signalVisual").dataset.geometry) renderMonitoringSignal();
      else ledField.measure();
    }, 120);
  });
  resizeObserver.observe($("signalVisual"));
  let timelineWidth = 0;
  new ResizeObserver(entries => {
    const width = Math.round(entries[0].contentRect.width);
    if (!width || Math.abs(width - timelineWidth) < 24) return;
    timelineWidth = width;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.loaded && state.view === "overview" && fieldPrefs().view === "timeline") renderMonitoringSignal(); }, 120);
  }).observe($("timelineView"));
  if ($("fieldViewport")) resizeObserver.observe($("fieldViewport"));
}
// Scrolling moves the viewport, not the cells relative to their canvas stage.
// Do not re-size/repaint the canvas on every scroll event: resetting its backing
// store caused visible flashes while users moved through the heatmap.
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
    if (state.scoutPreview.expanded) setScoutPreviewExpanded(false);
    else setPdfViewerExpanded(false);
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
// Scout: grouping, selection, bulk actions and the preview.
$("scoutView").addEventListener("click", event => {
  const target = event.target.closest("[data-scout-group],[data-scout-group-pick],[data-scout-group-by],[data-scout-bulk],[data-scout-preview],[data-scout-device],[data-scout-expand],[data-scout-preview-back],[data-scout-preview-retry]");
  if (!target) return;
  const data = target.dataset;
  if (data.scoutGroupBy) { state.scoutGroupBy = data.scoutGroupBy; state.scoutOpenGroups = new Set(); return renderScout(); }
  if (data.scoutBulk) return scoutBulk(data.scoutBulk);
  if (data.scoutGroup) {
    if (state.scoutOpenGroups.has(data.scoutGroup)) state.scoutOpenGroups.delete(data.scoutGroup); else state.scoutOpenGroups.add(data.scoutGroup);
    return renderScout();
  }
  if (data.scoutGroupPick) {
    const group = L.scoutGroups(scoutFiltered(), scoutGroupBy(), id => scoutRegulator(id).short_name).find(entry => entry.key === data.scoutGroupPick);
    if (!group) return;
    const free = group.items.filter(item => !scoutIsMonitored(item) && !(item.decision && item.decision.decision === "dismissed"));
    const all = free.every(item => state.scoutPicked.has(item.key));
    free.forEach(item => { if (all) state.scoutPicked.delete(item.key); else state.scoutPicked.set(item.key, true); });
    return renderScout();
  }
  return scoutPreviewAction(target);
});
$("scoutItems").addEventListener("change", event => {
  const box = event.target.closest("[data-scout-pick]");
  if (!box) return;
  if (box.checked) state.scoutPicked.set(box.dataset.scoutPick, true); else state.scoutPicked.delete(box.dataset.scoutPick);
  const item = box.closest(".scout-item");
  if (item) item.classList.toggle("is-picked", box.checked);
  renderScoutBulk();
});
$("scoutStrongOnly").addEventListener("change", () => { state.scoutStrongOnly = $("scoutStrongOnly").checked; renderScout(); });
$("monitorSearch").addEventListener("input", renderMonitorList);
$("scoutSearch").addEventListener("input", renderScout);
$("scoutFormatFilter").addEventListener("change", () => {
  state.scoutFormatFilter = $("scoutFormatFilter").value || "ALL";
  renderScout();
});
$("cadenceSearch").addEventListener("input", () => { state.cadenceSearch = $("cadenceSearch").value; renderCadenceView(); });
$("cadenceTypeFilter").addEventListener("change", () => { state.cadenceFilter = $("cadenceTypeFilter").value; renderCadenceView(); });
$("cadenceOwnerFilter").addEventListener("change", () => { state.cadenceOwner = $("cadenceOwnerFilter").value || "ALL"; renderCadenceView(); });
$("cadencePlanForm").addEventListener("input", syncCadencePlanner);
$("cadencePlanForm").addEventListener("change", syncCadencePlanner);
$("cadencePlanForm").addEventListener("submit", event => { event.preventDefault(); saveCadencePlan(); });
$("cadencePlanIcs").addEventListener("click", downloadCadencePlan);
document.querySelectorAll("[data-plan-close]").forEach(button => button.addEventListener("click", () => $("cadencePlanDialog").close()));
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
  if (tab) { a.tab = ["page", "suggested"].indexOf(tab.dataset.exploreTab) >= 0 ? tab.dataset.exploreTab : "selected"; return renderExploreSide(); }
  if (event.target.closest("[data-explore-pick]")) return exploreSetPicking(!a.picking), renderExploreSide();
  if (event.target.closest("[data-area-clear]")) { a.area = null; explorePost({ type: "area-clear" }); return renderExploreSide(); }
  if (event.target.closest("[data-area-select]")) return exploreAreaAction("select");
  if (event.target.closest("[data-area-watch]")) return exploreAreaAction("watch");
  if (event.target.closest("[data-area-ignore]")) return exploreAreaAction("ignore");
  const ruleRemove = event.target.closest("[data-rule-remove]");
  if (ruleRemove) {
    const key = addPageKey();
    const rules = addRulesFor(key);
    if (ruleRemove.dataset.ruleRemove === "include") rules.include = "";
    else rules.ignore.splice(Number(ruleRemove.dataset.ruleRemove), 1);
    addSetRules(key, rules);
    return renderExploreSide();
  }
  const similar = event.target.closest("[data-similar]");
  if (similar) {
    const rule = (a.similar || [])[Number(similar.dataset.similar)];
    if (!rule) return;
    const added = addSelectKeys(rule.keys, exploreContentLinks());
    exploreMarkPicked(); addSaveDraft(); renderExploreSide();
    return showToast(plural(added, "more link", "more links") + " selected: " + rule.label.replace(/^All |^Every /, "").toLowerCase() + ".");
  }
  if (event.target.closest("[data-suggest-all]")) {
    const added = addSelectKeys(exploreSuggestions().items.map(row => row.key), exploreContentLinks());
    exploreMarkPicked(); addSaveDraft(); renderExploreSide();
    return showToast(plural(added, "suggested link", "suggested links") + " selected.");
  }
  if (event.target.closest("[data-older-toggle]")) { a.showOlder = !a.showOlder; return renderExploreSide(); }
  if (event.target.closest("[data-rule-open]")) { a.ruleOpen = true; renderExploreSide(); const input = $("rulePattern"); if (input) input.focus({ preventScroll: true }); return; }
  if (event.target.closest("[data-rule-close]")) { a.ruleOpen = false; return renderExploreSide(); }
  if (event.target.closest("[data-rule-show]")) return exploreRuleShow();
  if (event.target.closest("[data-rule-request]")) return exploreRuleRequest();
  const go = event.target.closest("[data-explore-go]");
  if (go) return exploreOpen(go.dataset.exploreGo, true);
  const toggle = event.target.closest("input[data-link-toggle]");
  const main = event.target.closest("[data-link-main]");
  if (toggle || main) {
    const key = toggle ? toggle.dataset.linkToggle : main.dataset.linkMain;
    const item = a.candidates.find(candidate => candidate.key === key) ||
      (a.page ? a.page.links.map(link => addLinkItem(link, a.page, null)).find(candidate => candidate && candidate.key === key) : null);
    if (item) {
      addToggle(item, toggle ? toggle.checked : undefined);
      if (a.picked.has(item.key)) exploreLocate(item.url);
    }
    return;
  }
  if (event.target.closest("[data-explore-doc-close]")) return exploreDocumentClose();
  const docPick = event.target.closest("[data-explore-doc-pick]");
  if (docPick) {
    const target = a.docItem || null;
    if (target) addToggle(target);
    docPick.textContent = target && a.picked.has(target.key) ? "Selected ✓" : "Select this document";
    docPick.classList.toggle("btn-primary", !(target && a.picked.has(target.key)));
    return;
  }
  const locate = event.target.closest("[data-explore-locate]");
  if (locate) return exploreLocate(locate.dataset.exploreLocate);
  const goto = event.target.closest("[data-add-goto]");
  if (goto) addGoto(goto.dataset.addGoto);
});
document.querySelector(".add-explore").addEventListener("input", event => {
  if (event.target.id === "ruleFolder" || event.target.id === "rulePattern") exploreRuleInput();
});
$("exploreSelectMode").addEventListener("change", () => {
  state.add.selectMode = $("exploreSelectMode").checked;
  explorePost({ type: "mode", select: state.add.selectMode });
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
  if (show) { a.show = ["SELECTED", "SUGGESTED"].indexOf(show.dataset.reviewShow) >= 0 ? show.dataset.reviewShow : "ALL"; a.limit = REVIEW_PAGE; return renderReview(); }
  const similar = event.target.closest("[data-review-similar]");
  if (similar) {
    const rule = (a.reviewSimilar || [])[Number(similar.dataset.reviewSimilar)];
    if (!rule) return;
    const added = addSelectKeys(rule.keys, a.candidates);
    addSaveDraft();
    renderReview();
    return showToast(plural(added, "more link", "more links") + " ticked.");
  }
  const batch = event.target.closest("[data-review-batch]");
  if (batch) return reviewOpenBatch(Number(batch.dataset.reviewBatch));
  if (event.target.closest("[data-review-weekly]")) return reviewOpenWeekly();
  if (event.target.closest("[data-review-done]")) { addClearDraft(); $("newMonitorUrl").value = ""; $("addMonitorDialog").close(); return; }
});
document.querySelector(".add-review").addEventListener("change", event => {
  if (event.target.id === "reviewWeekly") { state.add.weekly = event.target.checked; renderReviewFoot(); }
  if (event.target.id === "reviewHideOlder") { state.add.hideOlder = event.target.checked; state.add.limit = REVIEW_PAGE; renderReview(); }
});
document.querySelector(".add-review").addEventListener("mousedown", event => { if (event.shiftKey && event.target.closest(".link-pick")) event.preventDefault(); });
$("reviewSearch").addEventListener("input", () => { state.add.query = $("reviewSearch").value; state.add.limit = REVIEW_PAGE; renderReview(); });
$("reviewFormat").addEventListener("change", () => { state.add.format = $("reviewFormat").value; state.add.limit = REVIEW_PAGE; renderReview(); });
$("reviewBack").addEventListener("click", () => {
  const a = state.add;
  if (a.origin === "explore" && a.page) addGoto("explore");
  else addGoto("start");
});
$("closeScanSchedule").addEventListener("click", () => $("scanScheduleDialog").close());
$("cancelScanSchedule").addEventListener("click", () => $("scanScheduleDialog").close());
$("scanScheduleReset").addEventListener("click", () => submitScanSchedule(true));
$("scanScheduleForm").addEventListener("submit", event => { event.preventDefault(); submitScanSchedule(false); });
["scanEvery", "scanWindowOn", "scanFrom", "scanUntil", "scanZone"].forEach(id => $(id).addEventListener("change", renderScanPreview));
$("scanScheduleDialog").addEventListener("click", event => {
  if (event.target === $("scanScheduleDialog")) return $("scanScheduleDialog").close();
  const mode = event.target.closest("[data-scan-days]");
  if (mode) { setScanDayMode(mode.dataset.scanDays); return renderScanPreview(); }
  const day = event.target.closest("[data-scan-day]");
  if (day) { day.setAttribute("aria-pressed", String(day.getAttribute("aria-pressed") !== "true")); renderScanPreview(); }
});
$("closeCondition").addEventListener("click", () => $("conditionDialog").close());
$("cancelCondition").addEventListener("click", () => $("conditionDialog").close());
$("conditionClear").addEventListener("click", () => submitCondition(true));
$("conditionForm").addEventListener("submit", event => { event.preventDefault(); submitCondition(false); });
$("conditionDialog").addEventListener("click", event => {
  if (event.target === $("conditionDialog")) return $("conditionDialog").close();
  const chip = event.target.closest("[data-condition-suggestion]");
  if (chip) { $("conditionText").value = chip.dataset.conditionSuggestion; $("conditionText").focus(); }
});
if ($("channelSecretsLink")) $("channelSecretsLink").href = REPO + "/settings/secrets/actions";
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


/* ================= Documents inside the dashboard =================
 * PDFs, Excel workbooks, CSV, Word documents and ZIP bundles open in place:
 * Scout's preview, Add a link, a page's saved copy and a change's comparison all
 * use these viewers. A live document is read whole through the page reader's file
 * mode (the regulator's site does not allow the browser to fetch it directly);
 * saved originals come from the repository. Nothing here runs the document's own
 * code: PDFs are drawn by the integrity-checked pdf.js, the rest is parsed as data.
 */
const DOC_LIMITS = { gridRows: 400, gridCols: 60, pdfPages: 400 };
const documentCache = boundedCache(6);
let docSerial = 0;
let docPdfs = [];
function releaseDocumentPdfs() {
  docPdfs.forEach(entry => { if (entry.observer) entry.observer.disconnect(); releasePdf(entry.doc); });
  docPdfs = [];
}
function docKind(name, format) {
  const path = String(name || "").toLowerCase().split(/[?#]/)[0];
  const hint = String(format || "").toLowerCase();
  if (/\.pdf$/.test(path) || hint === "pdf") return "pdf";
  if (/\.(xlsx|xlsm)$/.test(path) || hint === "xlsx" || hint === "spreadsheet" && !/\.(xls|csv)$/.test(path)) return "xlsx";
  if (/\.xls$/.test(path)) return "xls";
  if (/\.csv$/.test(path) || hint === "csv") return "csv";
  if (/\.docx$/.test(path) || hint === "word" || hint === "docx") return "docx";
  if (/\.zip$/.test(path) || hint === "zip") return "zip";
  if (/\.(xml|xsd|xbrl)$/.test(path) || hint === "xml") return "xml";
  if (/\.json$/.test(path) || hint === "json") return "json";
  if (/\.(txt|md)$/.test(path) || hint === "text") return "text";
  return "other";
}
// Sniff the bytes when the name says nothing (DownloadAttachment?guid=…).
function docKindFromBytes(bytes, fallback) {
  if (!bytes || bytes.length < 4) return fallback;
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "package";
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return "xls";
  return fallback;
}
function formatBytes(size) {
  if (!Number.isFinite(size)) return "";
  if (size < 1024) return size + " B";
  if (size < 1048576) return Math.round(size / 102.4) / 10 + " KB";
  return Math.round(size / 104857.6) / 10 + " MB";
}
// A live document, read whole by the page reader.
async function readDocumentFile(url) {
  const key = L.urlKey(url);
  const cached = documentCache.get(key);
  if (cached) return cached;
  if (!PAGE_READER_ENDPOINT) throw new Error("The page reader isn't set up for this dashboard yet");
  const identity = await askSentinelIdentity();
  const headers = Object.assign(askSentinelIdentityHeaders(identity), { "Content-Type": "application/json" });
  let response;
  try {
    response = await fetch(PAGE_READER_ENDPOINT, { method: "POST", headers, body: JSON.stringify({ url, mode: "file" }), signal: timeoutSignal(60000) });
  } catch (error) {
    throw new Error(error && (error.name === "TimeoutError" || error.name === "AbortError") ? "The document took too long to read" : "The page reader could not be reached");
  }
  if (response.headers.get("X-CS-Kind") === "file") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    let finalUrl = url;
    try { finalUrl = decodeURI(response.headers.get("X-CS-Url") || url); } catch (_) {}
    const result = { kind: "file", bytes, format: response.headers.get("X-CS-Format") || "", url: finalUrl };
    documentCache.set(key, result);
    return result;
  }
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || "The page reader answered HTTP " + response.status);
  return data;
}
function docToolbar(meta) {
  const parts = [meta.kindLabel, meta.size ? formatBytes(meta.size) : "", meta.extra || ""].filter(Boolean);
  return '<div class="doc-bar"><span class="doc-bar-name" title="' + esc(meta.name || "") + '">' + esc(meta.title || meta.name || "Document") + "</span>" +
    '<span class="doc-bar-meta">' + parts.map(part => "<span>" + esc(part) + "</span>").join("") + "</span>" +
    '<span class="doc-bar-actions">' + (meta.actions || "") + "</span></div>";
}
const DOC_KIND_LABEL = { pdf: "PDF", xlsx: "Excel workbook", xls: "Excel 97–2003 workbook", csv: "CSV", docx: "Word document", zip: "ZIP bundle", xml: "XML", json: "JSON", text: "Text", other: "File" };
// Renders a document into `host`. options: { bytes, name, title, format, url, actions, alive }.
async function renderDocument(host, options) {
  const o = options || {};
  const serial = ++docSerial;
  const alive = () => serial === docSerial && host.isConnected && (!o.alive || o.alive());
  releaseDocumentPdfs();
  const bytes = o.bytes instanceof Uint8Array ? o.bytes : new Uint8Array(o.bytes || []);
  let kind = docKindFromBytes(bytes, docKind(o.name || o.url, o.format));
  // A zip package is a workbook or a Word document when its index says so, else a bundle.
  if (kind === "package") {
    let names = [];
    try { names = (await L.zipListing(bytes)).map(entry => entry.name); } catch (_) { names = []; }
    kind = names.indexOf("xl/workbook.xml") >= 0 ? "xlsx" : names.indexOf("word/document.xml") >= 0 ? "docx" : "zip";
  }
  const download = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const fileName = (String(o.name || o.url || "document").split(/[?#]/)[0].split("/").pop() || "document").slice(0, 120);
  const actions = (o.actions || "") + '<a class="sheet-link" href="' + esc(download) + '" download="' + esc(fileName) + '">Download</a>' +
    (safeHttpUrl(o.url) ? externalLink(o.url, "Open original", "sheet-link") : "");
  host.innerHTML = '<div class="doc-view" data-kind="' + esc(kind) + '">' + docToolbar({ name: fileName, title: o.title || fileName, kindLabel: DOC_KIND_LABEL[kind], size: bytes.length, actions }) +
    '<div class="doc-body"><div class="loading">Opening the ' + esc((DOC_KIND_LABEL[kind] || "file").toLowerCase()) + "…</div></div></div>";
  const body = host.querySelector(".doc-body");
  try {
    if (kind === "pdf") await renderPdfDocument(body, bytes, alive);
    else if (kind === "xlsx") { const book = await L.readWorkbook(bytes); if (alive()) renderWorkbook(body, book, {}); }
    else if (kind === "csv") { if (alive()) renderWorkbook(body, L.csvWorkbook(new TextDecoder("utf-8").decode(bytes), fileName), {}); }
    else if (kind === "docx") { const blocks = await L.readDocx(bytes); if (alive()) body.innerHTML = renderDocxBlocks(blocks); }
    else if (kind === "zip") await renderZipListing(body, bytes, alive, o);
    else if (kind === "xml" || kind === "json" || kind === "text") {
      let text = new TextDecoder("utf-8").decode(bytes.subarray(0, 2000000));
      if (kind === "json") { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {} }
      if (alive()) body.innerHTML = '<pre class="doc-text-raw">' + esc(text) + (bytes.length > 2000000 ? "\n…" : "") + "</pre>";
    } else if (kind === "xls") {
      body.innerHTML = emptyState("An Excel 97–2003 workbook", "The older binary .xls format can't be read in the browser. Download it to open it in Excel.");
    } else {
      body.innerHTML = emptyState("This file can't be shown here", "Download it to open it on your computer.");
    }
  } catch (error) {
    if (alive()) body.innerHTML = emptyState("This document couldn't be opened here", String(error.message || error) + ". Download it to open it on your computer.");
  }
  return kind;
}
async function renderPdfDocument(body, bytes, alive) {
  const lib = await loadPdfJs();
  const doc = await openPdf(lib, bytes.slice());
  if (!alive()) { releasePdf(doc); return; }
  const entry = { doc, observer: null };
  docPdfs.push(entry);
  const count = Math.min(doc.numPages, DOC_LIMITS.pdfPages);
  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  body.innerHTML = '<div class="doc-pages">' + Array.from({ length: count }, (_, i) =>
    '<div class="doc-page" data-page="' + (i + 1) + '" style="aspect-ratio:' + base.width + " / " + base.height + '"><span class="doc-pageno">' + (i + 1) + " / " + doc.numPages + "</span></div>").join("") +
    (doc.numPages > count ? '<p class="note-strip">Showing the first ' + count + " of " + doc.numPages + " pages. Download the file for the rest.</p>" : "") + "</div>";
  const render = async holder => {
    if (holder.dataset.rendered) return;
    holder.dataset.rendered = "1";
    try {
      const page = await doc.getPage(Number(holder.dataset.page));
      const width = holder.clientWidth || 600;
      const unscaled = page.getViewport({ scale: 1 });
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: (width / unscaled.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      if (alive()) holder.insertBefore(canvas, holder.firstChild);
    } catch (_) {
      holder.classList.add("is-missing");
    }
  };
  const pages = Array.from(body.querySelectorAll(".doc-page"));
  if (typeof IntersectionObserver === "function") {
    entry.observer = new IntersectionObserver(items => items.forEach(item => { if (item.isIntersecting) render(item.target); }), { root: null, rootMargin: "600px 0px" });
    pages.forEach(page => entry.observer.observe(page));
  } else {
    for (const page of pages.slice(0, 20)) await render(page);
  }
}
function renderDocxBlocks(blocks) {
  if (!blocks.length) return emptyState("No text in this document", "It may consist of images only.");
  return '<div class="doc-text">' + blocks.map(block => {
    if (block.type === "heading") return '<p class="doc-heading">' + esc(block.text) + "</p>";
    if (block.type === "table") {
      return '<div class="doc-table-wrap"><table class="doc-table"><tbody>' + block.rows.slice(0, 400).map(row =>
        "<tr>" + row.map(cell => "<td>" + esc(cell).replace(/\n/g, "<br>") + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
    }
    return "<p>" + esc(block.text) + "</p>";
  }).join("") + "</div>";
}
async function renderZipListing(body, bytes, alive, options) {
  const entries = await L.zipListing(bytes);
  if (!alive()) return;
  const openable = name => ["pdf", "xlsx", "csv", "docx", "xml", "json", "text"].indexOf(docKind(name, "")) >= 0;
  body.innerHTML = '<ul class="doc-zip">' + entries.slice(0, 2000).map(entry =>
    '<li><span class="doc-zip-name">' + esc(entry.name) + '</span><span class="doc-zip-size">' + esc(formatBytes(entry.size)) + "</span>" +
    (openable(entry.name) ? '<button class="sheet-link" type="button" data-doc-zip-open="' + esc(entry.name) + '">Open</button>' : "") + "</li>").join("") + "</ul>";
  body.querySelectorAll("[data-doc-zip-open]").forEach(button => button.addEventListener("click", async () => {
    const name = button.dataset.docZipOpen;
    try {
      const inner = await L.zipFile(bytes, name);
      if (!inner) return;
      const host = body.closest(".doc-view").parentElement;
      const back = '<button class="sheet-link" type="button" data-doc-zip-back>Back to the bundle</button>';
      await renderDocument(host, { bytes: inner, name, title: name, url: options.url, actions: back });
      const backButton = host.querySelector("[data-doc-zip-back]");
      if (backButton) backButton.addEventListener("click", () => renderDocument(host, options));
    } catch (error) {
      showToast("Couldn't open " + name + ": " + String(error.message || error));
    }
  }));
}

/* ----- Workbook grid: sheet tabs, pinned headings, formulas on request ----- */
function workbookSheetTabs(sheets, active, badges) {
  return '<div class="wb-tabs" role="tablist">' + sheets.map((sheet, index) => {
    const badge = badges && badges[index];
    return '<button type="button" role="tab" class="wb-tab' + (sheet.state !== "visible" ? " is-hidden" : "") + (badge ? " is-" + badge.tone : "") + '" data-wb-sheet="' + index + '" aria-selected="' + String(index === active) + '"' +
      (sheet.state !== "visible" ? ' title="Hidden sheet"' : "") + ">" + esc(sheet.name || "Sheet " + (index + 1)) + (badge ? '<span class="wb-tab-badge">' + esc(badge.text) + "</span>" : "") + "</button>";
  }).join("") + "</div>";
}
// marks: { "A1": { tone: "value"|"formula"|"added"|"removed", was: "..." } }
function workbookGrid(sheet, options) {
  const o = options || {};
  if (!sheet || sheet.kind && sheet.kind !== "worksheet") return emptyState("Not a worksheet", "This sheet holds a chart or another object, not cells.");
  if (!sheet.count) return emptyState("An empty sheet", "This sheet has no filled cells.");
  const rows = Math.min(sheet.maxRow, o.rows || DOC_LIMITS.gridRows);
  const cols = Math.min(sheet.maxCol, DOC_LIMITS.gridCols);
  const marks = o.marks || {};
  let html = '<div class="wb-grid-wrap"><table class="wb-grid"><thead><tr><th class="wb-corner"></th>';
  for (let c = 0; c < cols; c += 1) html += "<th>" + L.columnName(c) + "</th>";
  html += "</tr></thead><tbody>";
  for (let r = 1; r <= rows; r += 1) {
    html += '<tr><th class="wb-rowno">' + r + "</th>";
    for (let c = 0; c < cols; c += 1) {
      const ref = L.cellRef(r, c);
      const cell = sheet.cells[ref];
      const mark = marks[ref];
      // A formula saved without its result (common in templates) shows the formula itself.
      const text = cell ? (o.formulas && cell.f ? "=" + cell.f : cell.v !== "" ? cell.v : cell.f ? "=" + cell.f : "") : "";
      const title = [cell && cell.f ? "=" + cell.f : "", mark && mark.was != null ? "Before: " + mark.was : ""].filter(Boolean).join("\n");
      html += "<td" + (mark ? ' class="is-' + mark.tone + '"' : cell && cell.f ? ' class="has-formula"' : "") + (title ? ' title="' + esc(title) + '"' : "") + ' data-ref="' + ref + '">' + esc(text) + "</td>";
    }
    html += "</tr>";
  }
  html += "</tbody></table></div>";
  const notes = [];
  if (sheet.maxRow > rows) notes.push('<button class="sheet-link" type="button" data-wb-more>Show ' + Math.min(800, sheet.maxRow - rows) + " more rows</button> · " + (sheet.maxRow - rows).toLocaleString() + " not shown");
  if (sheet.maxCol > cols) notes.push("Columns after " + L.columnName(cols - 1) + " are not shown");
  if (sheet.truncated) notes.push("This sheet is very large; only its first cells were read");
  if (sheet.merges && sheet.merges.length) notes.push(plural(sheet.merges.length, "merged range", "merged ranges"));
  if (sheet.validations && sheet.validations.length) notes.push(plural(sheet.validations.length, "drop-down or validation rule", "drop-down or validation rules"));
  return html + (notes.length ? '<p class="wb-notes">' + notes.join(" · ") + "</p>" : "");
}
function renderWorkbook(host, book, options) {
  const state0 = { sheet: Math.max(0, book.sheets.findIndex(sheet => sheet.state === "visible")), formulas: false, rows: DOC_LIMITS.gridRows };
  const draw = () => {
    const sheet = book.sheets[state0.sheet];
    host.innerHTML = '<div class="wb">' + '<div class="wb-head">' + workbookSheetTabs(book.sheets, state0.sheet) +
      '<label class="cmp-toggle wb-formulas"><input type="checkbox" data-wb-formulas' + (state0.formulas ? " checked" : "") + "> Show formulas</label></div>" +
      workbookGrid(sheet, { formulas: state0.formulas, rows: state0.rows }) +
      (book.names && book.names.length ? '<details class="wb-names"><summary>' + esc(plural(book.names.length, "named range", "named ranges")) + "</summary><ul>" +
        book.names.slice(0, 300).map(name => "<li><code>" + esc(name.name) + "</code> " + esc(name.value) + "</li>").join("") + "</ul></details>" : "") + "</div>";
  };
  host.onclick = event => {
    const tab = event.target.closest("[data-wb-sheet]");
    if (tab) { state0.sheet = Number(tab.dataset.wbSheet); state0.rows = DOC_LIMITS.gridRows; return draw(); }
    if (event.target.closest("[data-wb-more]")) { state0.rows += 800; return draw(); }
  };
  host.onchange = event => { if (event.target.matches("[data-wb-formulas]")) { state0.formulas = event.target.checked; draw(); } };
  draw();
}

/* ----- Workbook comparison: which sheets changed, then every changed cell ----- */
const WB_STATUS_WORDS = { same: "No change", changed: "Changed", added: "New sheet", removed: "Sheet removed", renamed: "Renamed" };
function workbookChangeWords(sheet) {
  if (sheet.status === "added") return "New sheet";
  if (sheet.status === "removed") return "Removed";
  if (sheet.status === "same") return "No change";
  const parts = [];
  const cells = (sheet.counts.value || 0) + (sheet.counts.formula || 0);
  if (cells) parts.push(plural(cells, "cell", "cells"));
  if (sheet.rowsAdded.length) parts.push("+" + plural(sheet.rowsAdded.length, "row", "rows"));
  if (sheet.rowsRemoved.length) parts.push("−" + plural(sheet.rowsRemoved.length, "row", "rows"));
  const loose = sheet.changes.filter(change => !change.row && (change.kind === "added" || change.kind === "removed")).length;
  if (loose) parts.push(plural(loose, "cell filled or cleared", "cells filled or cleared"));
  if (sheet.merges.added.length + sheet.merges.removed.length) parts.push("merges");
  if (sheet.validations.added.length + sheet.validations.removed.length) parts.push("drop-downs");
  if (sheet.visibility) parts.push(sheet.visibility.join(" → "));
  if (sheet.status === "renamed") parts.unshift("renamed from “" + sheet.before + "”");
  return parts.join(", ") || "Changed";
}
function renderWorkbookCompare(host, before, after, diff, options) {
  const o = options || {};
  const order = diff.sheets;
  const firstChanged = Math.max(0, order.findIndex(sheet => sheet.status !== "same"));
  const view = { sheet: firstChanged, mode: "changes", formulas: false, rows: DOC_LIMITS.gridRows, kind: "ALL" };
  const sheetOf = (book, name) => book.sheets.find(sheet => sheet.name === name) || null;
  const draw = () => {
    const entry = order[view.sheet];
    const badges = order.map(sheet => sheet.status === "same" ? null : {
      tone: sheet.status === "added" ? "added" : sheet.status === "removed" ? "removed" : "changed",
      text: sheet.status === "added" ? "new" : sheet.status === "removed" ? "gone" : String((sheet.changes || []).length + (sheet.more || 0) || "•")
    });
    const t = diff.totals;
    const summary = [
      plural(t.sheetsChanged, "sheet changed", "sheets changed") + " of " + order.length,
      t.cells ? plural(t.cells, "cell changed", "cells changed") : "",
      t.rowsAdded ? plural(t.rowsAdded, "row added", "rows added") : "",
      t.rowsRemoved ? plural(t.rowsRemoved, "row removed", "rows removed") : "",
      diff.names.added.length + diff.names.removed.length ? "named ranges changed" : ""
    ].filter(Boolean).join(" · ");
    let body = "";
    if (!entry) body = emptyState("No sheets", "Neither version has a worksheet.");
    else if (entry.status === "added" || entry.status === "removed") {
      const sheet = entry.status === "added" ? sheetOf(after, entry.after) : sheetOf(before, entry.before);
      body = '<p class="wb-sheet-note is-' + entry.status + '">' + esc(entry.status === "added" ? "This sheet is new in this version." : "This sheet was removed in this version; its last saved contents are shown.") + "</p>" +
        workbookGrid(sheet, { formulas: view.formulas, rows: view.rows });
    } else if (view.mode === "changes") {
      const list = entry.changes.filter(change => view.kind === "ALL" || change.kind === view.kind.toLowerCase());
      const extra = [];
      entry.merges.added.forEach(range => extra.push(["Merged", "", range]));
      entry.merges.removed.forEach(range => extra.push(["Unmerged", range, ""]));
      entry.validations.added.forEach(rule => extra.push(["Drop-down / validation", "", rule]));
      entry.validations.removed.forEach(rule => extra.push(["Drop-down / validation", rule, ""]));
      if (entry.visibility) extra.push(["Visibility", entry.visibility[0], entry.visibility[1]]);
      const kinds = ["ALL", "VALUE", "FORMULA", "ADDED", "REMOVED"].map(kind => '<button type="button" data-wb-kind="' + kind + '" aria-pressed="' + String(view.kind === kind) + '">' +
        esc({ ALL: "All", VALUE: "Values", FORMULA: "Formulas", ADDED: "Added", REMOVED: "Removed" }[kind]) + "</button>").join("");
      body = (entry.status === "same" ? '<p class="wb-sheet-note">No differences on this sheet.</p>' : "") +
        (entry.changes.length ? '<div class="segmented wb-kinds" role="group" aria-label="Show">' + kinds + "</div>" : "") +
        (list.length || extra.length ? '<div class="doc-table-wrap"><table class="wb-changes"><thead><tr><th>Cell</th><th>Before</th><th>After</th></tr></thead><tbody>' +
          list.slice(0, 2000).map(change => {
            const was = change.before, now = change.after;
            const shown = cell => cell ? (cell.f ? '<code>=' + esc(cell.f) + "</code>" + (cell.v !== "" ? '<span class="wb-result">' + esc(cell.v) + "</span>" : "") : esc(cell.v)) : '<span class="wb-empty">empty</span>';
            const ref = now && was && now.ref !== was.ref ? esc(was.ref) + " → " + esc(now.ref) : esc((now || was).ref);
            return '<tr class="is-' + change.kind + '"><td class="wb-ref" data-wb-goto="' + esc((now || was).ref) + '" data-wb-side="' + (now ? "after" : "before") + '">' + ref +
              (change.row ? '<small>' + (now ? "row added" : "row removed") + "</small>" : change.kind === "formula" ? "<small>formula</small>" : "") + "</td>" +
              '<td class="wb-before">' + shown(was) + '</td><td class="wb-after">' + shown(now) + "</td></tr>";
          }).join("") +
          extra.map(row => '<tr class="is-structure"><td class="wb-ref">' + esc(row[0]) + '</td><td class="wb-before">' + esc(row[1]) + '</td><td class="wb-after">' + esc(row[2]) + "</td></tr>").join("") +
          "</tbody></table></div>" + (list.length > 2000 || entry.more ? '<p class="wb-notes">' + esc(((list.length > 2000 ? list.length - 2000 : 0) + (entry.more || 0)).toLocaleString()) + " more changes on this sheet are not listed.</p>" : "")
          : (entry.status !== "same" ? '<p class="wb-sheet-note">No cell changes of this kind.</p>' : ""));
    } else {
      const side = view.mode === "before" ? sheetOf(before, entry.before) : sheetOf(after, entry.after);
      const marks = {};
      entry.changes.forEach(change => {
        const cell = view.mode === "before" ? change.before : change.after;
        if (!cell) return;
        const other = view.mode === "before" ? change.after : change.before;
        marks[cell.ref] = { tone: change.kind === "formula" ? "formula" : change.kind === "value" ? "value" : view.mode === "before" ? "removed" : "added",
          was: other ? (other.f ? "=" + other.f + (other.v ? " (" + other.v + ")" : "") : other.v) : null };
      });
      body = workbookGrid(side, { formulas: view.formulas, rows: view.rows, marks });
    }
    host.innerHTML = '<div class="wb wb-compare">' +
      '<div class="wb-summary"><strong>' + esc(summary) + "</strong>" + (diff.truncated ? '<span class="wb-notes">Very large workbook: only the first cells were compared.</span>' : "") + "</div>" +
      '<div class="wb-head">' + workbookSheetTabs(order.map(sheet => ({ name: sheet.name, state: (sheetOf(after, sheet.after) || sheetOf(before, sheet.before) || {}).state || "visible" })), view.sheet, badges) +
      '<div class="wb-head-tools"><div class="segmented" role="group" aria-label="View">' +
        ["changes", "after", "before"].map(mode => '<button type="button" data-wb-mode="' + mode + '" aria-pressed="' + String(view.mode === mode) + '">' + { changes: "Changes", after: "New version", before: "Previous version" }[mode] + "</button>").join("") +
      '</div><label class="cmp-toggle wb-formulas"><input type="checkbox" data-wb-formulas' + (view.formulas ? " checked" : "") + "> Formulas</label></div></div>" +
      (entry ? '<p class="wb-sheet-status">' + esc(entry.name) + " · " + esc(workbookChangeWords(entry)) + "</p>" : "") + body +
      (diff.names.added.length + diff.names.removed.length ? '<details class="wb-names" open><summary>Named ranges</summary><ul>' +
        diff.names.removed.map(name => '<li class="is-removed">− ' + esc(name.replace(/@$/, "")) + "</li>").join("") + diff.names.added.map(name => '<li class="is-added">+ ' + esc(name.replace(/@$/, "")) + "</li>").join("") + "</ul></details>" : "") +
      "</div>";
  };
  host.onclick = event => {
    const tab = event.target.closest("[data-wb-sheet]");
    if (tab) { view.sheet = Number(tab.dataset.wbSheet); view.rows = DOC_LIMITS.gridRows; return draw(); }
    const mode = event.target.closest("[data-wb-mode]");
    if (mode) { view.mode = mode.dataset.wbMode; return draw(); }
    const kind = event.target.closest("[data-wb-kind]");
    if (kind) { view.kind = kind.dataset.wbKind; return draw(); }
    if (event.target.closest("[data-wb-more]")) { view.rows += 800; return draw(); }
    const go = event.target.closest("[data-wb-goto]");
    if (go) {
      view.mode = go.dataset.wbSide === "before" ? "before" : "after";
      const row = Number(go.dataset.wbGoto.match(/\d+$/)[0]);
      view.rows = Math.max(view.rows, row + 20);
      draw();
      const cell = host.querySelector('td[data-ref="' + go.dataset.wbGoto + '"]');
      if (cell) { cell.scrollIntoView({ block: "center", inline: "center" }); cell.classList.add("is-focus"); }
    }
  };
  host.onchange = event => { if (event.target.matches("[data-wb-formulas]")) { view.formulas = event.target.checked; draw(); } };
  draw();
  if (o.onSummary) o.onSummary(diff);
}

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
  if (before.file_snapshot_location && after.file_snapshot_location && /\.xlsx$/i.test(after.file_snapshot_location) && /\.xlsx$/i.test(before.file_snapshot_location)) {
    return { kind: "xlsx", before: before.file_snapshot_location, after: after.file_snapshot_location, text };
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
  if (sources.kind === "xlsx") return compareWorkbooks(target, sources, alive);
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

/* ----- Workbooks: both saved originals read in the browser and compared sheet by sheet, cell by cell ----- */
async function compareWorkbooks(target, sources, alive) {
  target.innerHTML = '<div class="cmp" data-kind="xlsx"><p class="cmp-status" role="status">Reading both workbooks…</p></div>';
  try {
    const [beforeBytes, afterBytes] = await Promise.all([fetchSnapshotBytes(sources.before), fetchSnapshotBytes(sources.after)]);
    if (!alive()) return;
    const [before, after] = await Promise.all([L.readWorkbook(beforeBytes), L.readWorkbook(afterBytes)]);
    if (!alive()) return;
    const diff = L.workbookDiff(before, after);
    renderWorkbookCompare(target, before, after, diff);
  } catch (error) {
    if (alive()) target.innerHTML = '<div class="cmp"><p class="cmp-status">Couldn\'t compare the two workbooks: ' + esc(String(error.message || error)) + ". The text redline is still available.</p></div>";
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
    ? "Test mode · unlimited until " + new Date(ASK_SENTINEL_TEST_MODE_UNTIL).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
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
