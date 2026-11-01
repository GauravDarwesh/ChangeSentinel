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

// Date#toLocaleDateString / toLocaleTimeString / toLocaleString build a new
// Intl.DateTimeFormat on every call, which is slow, and the dashboard makes
// thousands of these calls per render (every heatmap cell carries a dated
// label). The same results come from one cached formatter per locale and
// options. Defaults follow ECMA-402 ToDateTimeOptions, so output is identical.
(function cacheDateFormatters() {
  if (typeof Intl !== "object" || !Intl.DateTimeFormat || Date.prototype.__csCachedFormat) return;
  const cache = new Map();
  const DATE = ["weekday", "year", "month", "day"];
  const TIME = ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits"];
  function formatter(locales, options, required, defaults) {
    let key;
    try { key = JSON.stringify([locales === undefined ? null : locales, options === undefined ? null : options, required, defaults]); } catch (_) { return null; }
    let f = cache.get(key);
    if (!f) {
      const opts = Object.assign({}, options || {});
      const has = name => opts[name] !== undefined;
      // dateStyle / timeStyle have their own per-method rules: leave those to the browser.
      if (has("dateStyle") || has("timeStyle")) return null;
      const need = !(required === "date" ? DATE : required === "time" ? TIME : DATE.concat(TIME)).some(has);
      if (need) (defaults === "date" ? ["year", "month", "day"] : defaults === "time" ? ["hour", "minute", "second"] : ["year", "month", "day", "hour", "minute", "second"]).forEach(name => { opts[name] = "numeric"; });
      f = new Intl.DateTimeFormat(locales, opts);
      if (cache.size > 200) cache.clear();
      cache.set(key, f);
    }
    return f;
  }
  const wrap = (name, required, defaults) => {
    const original = Date.prototype[name];
    Date.prototype[name] = function (locales, options) {
      if (Number.isNaN(this.getTime())) return original.call(this, locales, options);
      let f = null;
      try { f = formatter(locales, options, required, defaults); } catch (_) { f = null; }
      return f ? f.format(this) : original.call(this, locales, options);
    };
  };
  wrap("toLocaleDateString", "date", "date");
  wrap("toLocaleTimeString", "time", "time");
  wrap("toLocaleString", "any", "all");
  Object.defineProperty(Date.prototype, "__csCachedFormat", { value: true });
})();

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
const CHANGE_EVENT_TYPES = ["CHANGED_URL", "NEW_URL", "REMOVED_URL", "HTML_SOURCE_CHANGED", "VISUAL_CHANGED"];
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
  registry: "config/registry.json",
  registryTemplates: "config/registry-templates.json",
  reviews: "data/reviews/ledger.json",
  regulators: "config/regulators.json",
  health: "data/health.json",
  digests: "data/digests/index.json",
  digestConfig: "config/digests.json",
  changeFacts: "data/change-facts.json",
  reportRules: "config/reports.json",
  profile: "config/profile.json"
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
  registry: new URL("./config/registry.json", document.baseURI).href,
  registryTemplates: new URL("./config/registry-templates.json", document.baseURI).href,
  reviews: new URL("./data/reviews/ledger.json", document.baseURI).href,
  regulators: new URL("./config/regulators.json", document.baseURI).href,
  health: new URL("./data/health.json", document.baseURI).href,
  digests: new URL("./data/digests/index.json", document.baseURI).href,
  digestConfig: new URL("./config/digests.json", document.baseURI).href,
  changeFacts: new URL("./data/change-facts.json", document.baseURI).href,
  reportRules: new URL("./config/reports.json", document.baseURI).href,
  profile: new URL("./config/profile.json", document.baseURI).href
};
// The calendar feed is served from Pages so calendar apps can subscribe to it.
const CALENDAR_FEED = new URL("./data/calendar.ics", document.baseURI).href;
const VIEWS = ["overview", "changes", "monitors", "runs", "health", "notifications", "registry", "scout", "calendar", "askSentinel"];
const HASH_NAMES = { overview: "overview", changes: "changes", monitors: "pages", runs: "runs", health: "health", notifications: "alerts", registry: "registry", scout: "scout", calendar: "cadence", askSentinel: "ask-sentinel" };
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
  filter: "ALL", changeFilter: "REVIEW", specFilter: "attention", detailTab: "", diffMode: "compare", snapshotMode: "preview",
  docInfo: {}, titleQueue: [], titleWorkers: 0, titleTimer: null, titleMisses: new Set(), titlesFound: false,
  snapshotCache: boundedCache(24), htmlCache: boundedCache(12), evidenceCache: boundedCache(80), pdfPreviewUrl: "", toastTimer: null,
  assetSignatures: {}, renderedSignature: "", lastFullLoad: 0, loading: null, detailKeys: {},
  workflowRuns: [], workflowSignature: "", scanColumns: null, pendingScan: null,
  scoutLatest: null, scoutReview: null, scoutConfig: null, scoutFilter: "REVIEW", scoutFormatFilter: "ALL", selectedScoutKey: "", scoutMonitored: null,
  scoutGroupBy: "", scoutStrongOnly: false, scoutOpenGroups: new Set(), scoutPicked: new Map(),
  scoutPreview: { mode: "page", device: "desktop", expanded: false, key: "", serial: 0, token: "", page: null, locate: "", trail: [] },
  // Add a link: the page being explored, links found by level, and the ticked links.
  add: { step: "start", method: "explore", url: "", history: [], at: -1, page: null, pages: new Map(), livePages: new Map(), view: "copy", viewWhy: "", viewByHost: {}, areas: [], loading: 0,
    tab: "selected", selectMode: false, candidates: [], picked: new Map(), anchor: "", origin: "explore", notes: [], info: "",
    crawl: null, query: "", format: "ALL", show: "ALL", limit: 300, opened: {}, weekly: false, scope: "",
    rules: {}, area: null, picking: false, boxing: false, recording: false, waitPick: false, steps: {}, stepsOpen: false, readerStale: "", showOlder: false, ruleDrafts: {}, ruleRequests: {}, ruleOpen: false, similar: [], hideOlder: true, reviewSimilar: [] },
  scoutSourceMode: "add",
  changeFacts: null, reportRules: null, reportLibrary: L.reportLibrary(null), profile: null, assessments: null, changeSort: "newest",
  calendar: null, lineage: null, registry: null, registryModel: null, registryTemplates: null, ruleTables: new Map(), catalogSeries: new Map(), proposals: null, selectedRegistryKey: "", registryScheme: "ALL", reviews: null, reviewTarget: "", integrity: {},
  // Decisions saved in the dashboard (review-api), shown at once to signed-in
  // members; the Review Sync workflow copies them into the committed ledger.
  appReviews: [], teamMember: null, teamStatus: "unknown",
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
// A background poll revalidates (If-None-Match/If-Modified-Since) and usually
// gets a 304; an explicit load still busts every cache. Busting on every
// 2-minute poll downloaded the small assets in full each time and the large
// ones every 10 minutes (tens of MB an hour per idle tab).
async function fetchDataAsset(key, required, background) {
  const path = DATA_PATHS[key];
  const candidates = Array.from(new Set([ENDPOINTS[key], RAW + "/" + path].filter(Boolean)));
  const failures = [];
  for (const url of candidates) {
    let host = url;
    try { host = new URL(url).host; } catch (_) {}
    try {
      const response = background ? await fetch(url, { cache: "no-cache" }) : await fetch(bust(url), { cache: "no-store" });
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
// Module-level event bindings: a missing element is reported and skipped, so
// one renamed id can't throw during evaluation and leave every later binding unset.
function bind(id, type, handler, options) {
  const element = $(id);
  if (!element) { console.warn("ChangeSentinel: #" + id + " is missing; its " + type + " handler was not bound."); return null; }
  element.addEventListener(type, handler, options);
  return element;
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
    case "registry":
      return isPlainObject(value) && value.schema_version === 1 && (value.items === undefined || Array.isArray(value.items));
    case "registryTemplates":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.templates);
    case "lineage":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.mappings);
    case "reviews":
      return isPlainObject(value) && value.schema_version === 1 && isPlainObject(value.reviews) && Array.isArray(value.log);
    // Fleet health is rebuilt by every scan; before the first one it is absent.
    case "health":
      return isPlainObject(value) && value.schema_version === 1 && isPlainObject(value.totals) && Array.isArray(value.monitors);
    // Scheduled digests (regmon/digest.py) and their configuration; optional.
    case "digests":
      return isPlainObject(value) && value.schema_version === 1 && isPlainObject(value.digests);
    case "digestConfig":
      return isPlainObject(value) && Array.isArray(value.digests);
    // Who publishes each host; without it pages are grouped by their domain.
    case "regulators":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.regulators);
    // Phase 3 assessment (regmon/applicability.py, regmon/profile.py); all optional.
    case "changeFacts":
      return isPlainObject(value) && value.schema_version === 1 && isPlainObject(value.events);
    case "reportRules":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.reports);
    case "profile":
      return isPlainObject(value) && value.schema_version === 1 && Array.isArray(value.entities) && Array.isArray(value.reports);
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
      m = stripped.match(/Instructions for (?:the )?(?:Preparation of )?(.+?)\s*\(?\s*Reporting Form\s+((?:FR|FFIEC)\s+[A-Z]?-?\d[A-Za-z0-9\/-]*)/i);
      if (m) { name = m[1]; code = m[2]; }
    }
    // FFIEC documents cite FR forms (FR Y-9C) in their text; a cited code is
    // not the document's own, so without an explicit "Reporting Form FFIEC …"
    // heading the monitor's own name is kept.
    const firstFfiec = stripped.search(/\bFFIEC\s+\d/), firstFr = stripped.search(/\bFR\s+[A-Z]?-?\d/);
    if (!code && firstFfiec >= 0 && (firstFr < 0 || firstFfiec < firstFr)) return null;
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
function titleCacheKey(item) { return "cs-title:v6:" + (item.normalized_hash || item.url_id); }
function hydrateDocumentTitles() {
  state.items.forEach(item => {
    if (state.docInfo[item.url_id] || !item.snapshot_location || item.pending_registration || !["pdf", "zip"].includes(itemKind(item))) return;
    try {
      const cached = localStorage.getItem(titleCacheKey(item));
      if (cached === "-") return; // read before and has no recognisable title
      if (cached) { state.docInfo[item.url_id] = JSON.parse(cached); return; }
    } catch (_) {}
    if (state.titleMisses.has(item.url_id)) return;
    if (!state.titleQueue.some(entry => entry.url_id === item.url_id)) state.titleQueue.push(item);
  });
  pumpTitleQueue();
}
function pumpTitleQueue() {
  while (state.titleWorkers < 3 && state.titleQueue.length) {
    const item = state.titleQueue.shift();
    state.titleWorkers++;
    // Titles arrive one by one; the view is redrawn once per batch, and only
    // when a title was actually found. A snapshot with no title is remembered
    // (keyed by its content hash), and a failed read is not retried this visit.
    readSnapshotTextHead(item.snapshot_location, 9000).then(text => {
      const info = deriveDocumentTitle(text, itemKind(item));
      if (info && info.title) {
        state.docInfo[item.url_id] = info;
        state.titlesFound = true;
        try { localStorage.setItem(titleCacheKey(item), JSON.stringify(info)); } catch (_) {}
      } else {
        try { localStorage.setItem(titleCacheKey(item), "-"); } catch (_) {}
      }
    }).catch(() => { state.titleMisses.add(item.url_id); }).finally(() => {
      state.titleWorkers--;
      if (state.titlesFound && !state.titleTimer) state.titleTimer = setTimeout(() => {
        state.titleTimer = null;
        if (!state.titlesFound) return;
        state.titlesFound = false;
        renderLists();
      }, state.titleQueue.length || state.titleWorkers ? 700 : 120);
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
// A bot check, or a refusal that covers a whole site, is retried automatically.
// One refused page on an otherwise working site is more likely removed or made
// private, so it stays an ordinary problem (regmon/health.py does the same).
function blockWait(item) {
  const wait = L.botCheckWait(item);
  if (!wait || wait.kind !== "refusal") return wait;
  let host = "";
  try { host = new URL(String(item.canonical_url || "")).hostname; } catch (_) { return null; }
  const refused = (state.items || []).filter(other => {
    if (!/^AccessRefusedError/.test(String(other.fetch_error || ""))) return false;
    try { return new URL(String(other.canonical_url || "")).hostname === host; } catch (_) { return false; }
  }).length;
  return refused >= 2 ? wait : null;
}
// Bot-check attempts the scan retries by itself are not changes or problems to
// review: Health lists them under "Retrying automatically". Once a block has
// outlasted its grace period the events show again, as failures.
function isRoutineBotCheck(event, itemsById) {
  if (!event || event.event_type !== "FETCH_ERROR") return false;
  if (!/^(BotCheckError|AccessRefusedError)/.test(String((event.evidence && event.evidence.error) || ""))) return false;
  const wait = blockWait(itemsById.get(event.url_id) || {});
  return !(wait && !wait.waiting);
}
function changeLogEntries() {
  const entries = [];
  const seen = new Set();
  const itemsById = new Map(state.items.map(item => [item.url_id, item]));
  state.items.forEach(item => itemChangeEntries(item).forEach(entry => {
    if (seen.has(entry.event_id)) return;
    if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0 && ALERT_EVENT_TYPES.indexOf(entry.event_type) < 0) return;
    if (isSuppressedMarkupOnly(entry) || isRoutineBotCheck(entry, itemsById)) return;
    seen.add(entry.event_id);
    entries.push(entry);
  }));
  allEvents().forEach(event => {
    if (seen.has(event.event_id) || ALERT_EVENT_TYPES.indexOf(event.event_type) < 0) return;
    if (isRoutineBotCheck(event, itemsById)) return;
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
// The AI's view, never a decision: always prefixed "AI", drawn with a hollow
// mark, so it can't be read as the human review shown beside it.
const AI_TAG_TITLE = "The AI's view, not a decision. Check the evidence before relying on it.";
function verdictTag(verdict, event) {
  if (L.eventTone(event.event_type) === "problem") return "";
  if (verdict.state === "relevant") return '<span class="tag is-ai is-relevant" title="' + esc(AI_TAG_TITLE) + '">AI: relevant</span>';
  if (verdict.state === "irrelevant") return '<span class="tag is-ai is-irrelevant" title="' + esc(AI_TAG_TITLE) + '">AI: not relevant</span>';
  if (event.event_type === "CHANGED_URL" || event.event_type === "NEW_URL") return '<span class="tag is-ai is-unreviewed" title="The AI has not assessed this change.">AI: not assessed</span>';
  return "";
}
function eventHeadline(event) {
  const verdict = verdictFor(event);
  if (verdict.analysis && verdict.analysis.summary) return verdict.analysis.summary;
  if (event.evidence && event.evidence.error) return event.evidence.error;
  if (isPlainObject(event.spec) && event.spec.headline) return String(event.spec.headline);
  if (event.event_type === "HTML_SOURCE_CHANGED") return "The page markup changed; the extracted text is the same.";
  if (event.event_type === "VISUAL_CHANGED") {
    const share = isPlainObject(event.visual) ? Number(event.visual.changed_ratio) : NaN;
    return "The page looks different" + (Number.isFinite(share) ? " (" + (share * 100).toFixed(1) + "% of it)" : "") + " while its text and markup are the same.";
  }
  if (event.event_type === "REMOVED_URL" && isPlainObject(event.successor) && event.successor.to) {
    return "Replaced by a newer edition (" + String(event.successor.to).split("/").pop() + "), which was compared with it.";
  }
  if (event.event_type === "REMOVED_URL") return "This page was no longer found in a complete scan.";
  if (event.event_type === "NEW_URL") return "A new page entered the monitored scope.";
  return "The extracted text changed since the previous saved copy.";
}
function itemStatus(item) {
  if (item.pending_registration) return { label: "Awaiting first scan", tone: "pending", kind: "pending" };
  const botCheck = blockWait(item);
  if (botCheck) {
    // A bot check is retried automatically every scan; it only becomes a
    // problem once it has outlasted the grace period.
    return botCheck.waiting
      ? { label: botCheck.hasBaseline ? "Protected site · retrying" : "Protected site · first copy pending", tone: "pending", kind: "pending" }
      : { label: botCheck.kind === "refusal" ? "Blocked by the site" : "Blocked by bot check", tone: "problem", kind: "error" };
  }
  // One 404 or server error on a good URL is held for a scan before it counts
  // (regmon/engine.py _hold_transient_miss): CDNs miss a file now and then.
  if (isPlainObject(item.fetch_warning) && !item.fetch_error && !item.extraction_error) {
    return { label: "Rechecking next scan", tone: "pending", kind: "pending" };
  }
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
  // Counted like the Changes badge: undecided, code-only edits left out.
  const changes = recentChanges.length
    ? "<em>" + esc(numberWord(recentChanges.length).replace(/^\w/, ch => ch.toUpperCase())) + " " + (recentChanges.length === 1 ? "change is" : "changes are") + " waiting for a decision</em> from the last 7 days"
    : "Nothing from the last 7 days is waiting for a decision";
  // "Nothing needs attention" read as a contradiction beside changes waiting
  // for a decision; this half is only about pages that couldn't be read.
  const problems = totals.issue
    ? ", and <em>" + esc(numberWord(totals.issue)) + " " + (totals.issue === 1 ? "page has a problem" : "pages have problems") + "</em>."
    : ". Every page was read without problems.";
  return subject + changes + problems;
}
function renderOverview() {
  renderOverviewHealth();
  const totals = statusTotals();
  const sources = activeSources();
  const recentChanges = changeLogEntries().filter(entry =>
    undecidedChange(entry) && Date.now() - new Date(entry.timestamp || 0).getTime() < RECENT_CHANGE_MS
  );
  $("overviewLede").innerHTML = overviewStatement(totals, recentChanges);

  const recent = changeLogEntries().filter(needsReview).slice(0, 5);
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
  const parts = [healthNumber(totals.healthy) + " of " + healthNumber(totals.monitors) + " monitors working now"];
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
    '<li><button class="link-row" type="button" ' + calendarEntryTarget(entry) + ' title="' + esc(dateBasis(entry) + (entry.quote ? ": \u201c" + entry.quote + "\u201d" : "")) + '">' +
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
    // A late failure for an older change must not replace a newer preview.
    if ($("previewBody").dataset.eventId !== entry.event_id) return;
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
const FIELD_GROUPS = { regulator: "Regulator", jurisdiction: "Jurisdiction", workspace: "Workspace", kind: "Kind of document", source: "Monitor", none: "No grouping" };
// The timeline filters events, not pages, and by default gives each page its
// own lane so one page's updates read left to right with the time between them.
const TL_SHOWS = ["changed", "problems", "new", "markup", "all"];
const TL_LANES = ["page", "regulator", "jurisdiction", "workspace", "kind", "source", "none"];
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
  if (groupBy === "workspace") {
    const ws = sourceWorkspace(String(item.source_id || ""));
    return { groupKey: "ws:" + ws.name, groupLabel: ws.name, groupNote: ws.auto ? "by region" : "workspace" };
  }
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
  // The next-scan column is one light wide, so its header is the legend's hollow
  // square rather than a word that would crowd today's date on a phone.
  html += '<span class="field-day is-next" role="columnheader" title="The next scan" aria-label="Next scan"><i class="field-next-mark" aria-hidden="true"></i></span>';
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
  const refocus = field.contains(document.activeElement) && document.activeElement.classList.contains("led");
  field.innerHTML = html;
  fieldFocusRestore(field, refocus);
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
    const waitingOnCheck = blockWait(item);
    if ((item.fetch_error || item.extraction_error) && item.last_checked && !seenBad.has(item.url_id) && !(waitingOnCheck && waitingOnCheck.waiting)) {
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
    '<div class="tl-row tl-head"><div class="tl-corner"><span>' + esc(rangeShort) + "</span><small>" + esc(c.total ? plural(c.total, TL_SHOW_WORDS[prefs.tlShow].replace(/s$/, ""), TL_SHOW_WORDS[prefs.tlShow]) : "Nothing in range") + "</small>" + nextAxis + "</div>" +
    '<div class="tl-track tl-axis">' + bands + upcoming + labels + nowMark + nextMark + "</div></div>";
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
  // Today's scan instants (a fixed January date put the times an hour out for
  // most of the year wherever clocks change).
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
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
// Global on purpose: sentinel.js reports the next scan through it.
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

  // Whether the field is on screen comes from an IntersectionObserver: reading
  // offsetParent here forced a layout on every animation frame.
  let onScreen = true;
  if (canvas && typeof IntersectionObserver === "function") {
    new IntersectionObserver(entries => {
      onScreen = entries[entries.length - 1].isIntersecting;
      if (onScreen) wake();
    }).observe(canvas);
  }
  function visible() {
    return !document.hidden && canvas && onScreen && cells.length > 0;
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

/* ================= Assess (Phase 3): applies to you, gaps, priority =================
 * regmon/applicability.py writes the regulator side of each change (data/change-facts.json);
 * L.assessChange joins it here with config/profile.json, config/reports.json and the
 * registry, so a profile edit changes the list at once. Nothing is hidden: "All" lists
 * every change, and a change the profile can't decide is "May apply".
 */
const PRIORITY_GROUPS = { 1: "Priority 1", 2: "Priority 2", 3: "Priority 3", 0: "Not applicable", 9: "Not assessed" };
function profileNow() {
  return isPlainObject(state.profile) ? state.profile : { schema_version: 1, entities: [], reports: [], reports_complete: false };
}
function profileReady() { return L.hasProfile(profileNow()); }
function assessments() {
  if (state.assessments) return state.assessments;
  const events = state.changeFacts && isPlainObject(state.changeFacts.events) ? state.changeFacts.events : {};
  const today = L.localIsoDate();
  const model = registryModelNow();
  const out = new Map();
  Object.keys(events).forEach(id => {
    try { out.set(id, L.assessChange(events[id], profileNow(), model, state.reportLibrary, today)); } catch (_) {}
  });
  state.assessments = out;
  return out;
}
function assessmentFor(eventId) { return assessments().get(eventId) || null; }
function assessTags(entry) {
  if (!profileReady() || CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0) return "";
  const a = assessmentFor(entry.event_id);
  if (!a) return "";
  const status = a.applicability.status;
  if (status === "not_applicable") return '<span class="tag is-irrelevant" title="' + esc(a.applicability.reason) + '">Not applicable</span>';
  const band = a.priority.band;
  // P3 is the floor (text changes); only P1 and P2 are worth a tag on the row.
  return (band && band < 3 ? '<span class="tag' + (band === 1 ? " is-warn" : "") + '" title="' + esc("Priority " + band + ": " + a.priority.reasons.join(" · ")) + '">P' + esc(band) + "</span>" : "") +
    (status === "unknown" ? '<span class="tag is-unreviewed" title="' + esc(a.applicability.reason) + '">' + esc(L.APPLICABILITY_WORDS.unknown) + "</span>" : "") +
    (a.gaps ? '<span class="tag is-warn" title="' + esc(plural(a.gaps.unmapped, "changed item has", "changed items have") + " no consumer mapped") + '">Unmapped</span>' : "");
}
function prioritySortKey(entry) {
  const a = CHANGE_EVENT_TYPES.indexOf(entry.event_type) >= 0 ? assessmentFor(entry.event_id) : null;
  return a ? a.priority : { band: 9, score: 0 };
}
function sortByPriority(entries) {
  const rank = band => band === 0 ? 8 : band;
  return entries.slice().sort((a, b) => {
    const x = prioritySortKey(a), y = prioritySortKey(b);
    return rank(x.band) - rank(y.band) || y.score - x.score || new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
  });
}
function reportStatusTone(status) {
  return status === "files" ? "is-relevant" : status === "not_filed" ? "is-irrelevant" : "is-unreviewed";
}
function assessmentSheet(entry) {
  if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0) return "";
  const a = assessmentFor(entry.event_id);
  if (!a) return "";
  const setUp = '<button class="btn" type="button" data-select-registry="profile">' + (profileReady() ? "Entity profile" : "Set up the profile") + "</button>";
  if (!profileReady()) {
    return '<section class="sheet" aria-label="Applies to you"><div class="verdict is-muted"><div class="verdict-head"><span class="tag is-unreviewed">' +
      esc(L.APPLICABILITY_WORDS.unassessed) + '</span><span class="verdict-label">Applies to you</span></div>' +
      '<p class="verdict-summary">Add who you are and which reports you file. Changes to reports you don\'t file are then marked not applicable, with the reason, and the rest are put in priority order.</p>' +
      '<div class="review-actions">' + setUp + "</div></div></section>";
  }
  const facts = (state.changeFacts.events || {})[entry.event_id] || {};
  const status = a.applicability.status;
  const tone = status === "applies" ? "is-relevant" : status === "not_applicable" ? "is-irrelevant" : "is-unreviewed";
  const forms = Object.keys(a.applicability.forms || {});
  const statuses = forms.map(form => L.assessReportStatus(form, profileNow(), state.reportLibrary));
  const grid = [
    ["Reports", forms.length ? forms.map(form => form + " · " + (L.REPORT_STATUS_WORDS[a.applicability.forms[form]] || "")).join("; ") : "None identified"],
    ["Priority", a.priority.band ? "P" + a.priority.band + " · " + a.priority.reasons.join(" · ") : "Not applicable"],
    ["Severity", (facts.severity && facts.severity.detail) || ""],
    ["Takes effect", facts.effective ? facts.effective.quarter : ""],
    ["Unmapped items", a.gaps ? Object.keys(a.gaps.by_form).map(form => a.gaps.by_form[form] + " in " + form).join("; ") : ""]
  ].filter(([, value]) => value);
  const basisWords = { monitor: "the monitor's name", address: "the page or file address", listing: "the page that lists it", codes: "the item codes it touched", diff: "the changed lines" };
  const named = (facts.forms || []).map(row => row.form + " (from " + row.basis.map(b => basisWords[b] || b).join(", ") + ")");
  const why = statuses.map((row, index) => '<li class="spec-row"><span class="item-label">' + esc(forms[index]) + '</span><span class="spec-main"><span class="spec-meta">' +
      '<span class="tag ' + reportStatusTone(row.status) + '">' + esc(L.REPORT_STATUS_WORDS[row.status] || row.status) + "</span>" +
      '<span class="spec-when">' + esc(row.basis === "profile" ? "Your profile" : row.basis === "rule" ? "By rule" : row.basis === "list" ? "Not in your list" : "Not decided") + "</span>" +
      assessSourceLink(forms[index]) + "</span>" + '<span class="spec-declared">' + esc(row.reason) + "</span></span></li>").join("");
  const gaps = a.gaps ? '<div class="items-group"><div class="items-group-label is-removed">Applicable, no consumer mapped <span>' + esc(a.gaps.unmapped) + "</span></div>" +
      '<div class="registry-unregistered">' + a.gaps.codes.map(code => '<button class="chip" type="button" data-select-registry="code:' + esc(code) + '">' + esc(code) + "</button>").join("") +
      (a.gaps.unmapped > a.gaps.codes.length ? '<span class="sheet-note">and ' + esc(a.gaps.unmapped - a.gaps.codes.length) + " more</span>" : "") + "</div></div>" : "";
  return '<section class="sheet" aria-label="Applies to you"><div class="verdict">' +
    '<div class="verdict-head"><span class="verdict-label">Applies to you</span><span class="tag ' + tone + '">' + esc(L.APPLICABILITY_WORDS[status] || status) + "</span>" +
    (a.priority.band ? '<span class="tag' + (a.priority.band === 1 ? " is-warn" : "") + '">P' + esc(a.priority.band) + "</span>" : "") + "</div>" +
    '<p class="verdict-summary">' + esc(a.applicability.reason) + "</p>" +
    '<dl class="verdict-grid">' + grid.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl>" +
    (forms.length ? '<details class="verdict-why"><summary>Why</summary><p>' + esc("Reports named by " + named.join("; ") + ".") + '</p><ul class="items-list">' + why + "</ul></details>" : "") +
    "</div>" + gaps + '<div class="sheet-foot"><span class="sheet-note">Decided by rules and your profile, never by AI. Nothing is hidden: All still lists every change.</span>' + setUp + "</div></section>";
}
/* ---------- Your checks (Phase 4.2-4.3) ----------
 * A registry consumer can list the regulator's edit checks it implements
 * ("0303", or "FR Y-9C | 0303"). L.controlFindings (regmon/controls.py) joins a
 * change's rule changes (facts.rules, from the structured spec diff) with them:
 * retired but still implemented, changed, new with no check, and, against
 * data/rule-index.json, implemented but not in the form's current spec. */
function ruleIndexNow() { return state.ruleIndex || null; }
function loadRuleIndex() {
  if (state.ruleIndexPromise) return state.ruleIndexPromise;
  state.ruleIndexPromise = (async () => {
    for (const url of [new URL("./data/rule-index.json", document.baseURI).href, bust(RAW + "/data/rule-index.json")]) {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) continue;
        const doc = await response.json();
        if (isPlainObject(doc) && isPlainObject(doc.forms)) { state.ruleIndex = doc; return doc; }
      } catch (_) { /* next copy */ }
    }
    state.ruleIndex = { forms: {} };
    return state.ruleIndex;
  })();
  return state.ruleIndexPromise;
}
function registryImplements() { return Array.from(registryModelNow().consumers.values()).some(consumer => Array.isArray(consumer.implements) && consumer.implements.length); }
function controlsFor(eventId) {
  const facts = ((state.changeFacts || {}).events || {})[eventId];
  if (!facts || !registryImplements()) return null;
  try { return L.controlFindings(facts, registryModelNow(), ruleIndexNow()); } catch (_) { return null; }
}
function controlTag(entry) {
  if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0) return "";
  const result = controlsFor(entry.event_id);
  if (!result || !(result.counts.retired_in_use || result.counts.differs || result.counts.missing)) return "";
  return '<span class="tag is-warn" title="' + esc(L.controlSummary(result)) + '">Your checks</span>';
}
function consumerButton(id) {
  const consumer = registryModelNow().consumers.get(id);
  return '<button class="text-button" type="button" data-select-registry="consumer:' + esc(id) + '">' + esc(consumer ? consumer.name : id) + "</button>";
}
function controlsSheetHtml(result) {
  const groups = [["retired_in_use", "is-removed"], ["differs", "is-amended"], ["missing", "is-added"], ["extra", ""]].map(([finding, tone]) => {
    const rows = result[finding] || [];
    if (!rows.length) return "";
    const more = result.counts[finding] - rows.length;
    return '<div class="items-group"><div class="items-group-label ' + tone + '">' + esc(L.CONTROL_WORDS[finding]) + " <span>" + esc(result.counts[finding]) + "</span></div>" +
      '<ul class="items-list">' + rows.map(row => '<li class="spec-row"><span class="item-code">' + esc(row.id) + '</span><span class="spec-main"><span class="spec-meta">' +
        (row.change ? '<span class="tag">' + esc(L.CONTROL_CHANGE_WORDS[row.change] || row.change) + "</span>" : '<span class="tag">' + esc(row.form) + "</span>") +
        (row.quarter ? '<span class="spec-when">' + esc(row.quarter) + "</span>" : "") + (row.level ? '<span class="spec-when">' + esc(row.level) + "</span>" : "") + "</span>" +
        (row.consumers && row.consumers.length ? '<span class="spec-declared">' + (finding === "extra" ? "In " : "Implemented by ") + row.consumers.map(consumerButton).join(", ") + "</span>" : "") +
        (finding === "extra" ? "" : '<span class="suggestion-slot" data-suggest="' + esc(L.registryNorm(row.id)) + '"></span>') +
        "</span></li>").join("") + "</ul>" + (more > 0 ? '<p class="note-strip">And ' + esc(more) + " more.</p>" : "") + "</div>";
  }).join("");
  const line = L.controlSummary(result);
  const tracked = result.tracked.length ? "You track " + result.tracked.join(", ") + "." : "";
  const checked = result.checked.length ? " Extras checked against the current " + result.checked.join(", ") + " specification." : "";
  return '<section class="sheet" aria-label="Your checks"><div class="verdict' + (line ? "" : " is-muted") + '"><div class="verdict-head"><span class="verdict-label">Your checks</span>' +
    (result.counts.retired_in_use || result.counts.differs ? '<span class="tag is-warn">Update needed</span>' : line ? '<span class="tag is-unreviewed">Review</span>' : '<span class="tag is-relevant">Up to date</span>') + "</div>" +
    '<p class="verdict-summary">' + esc(line ? line.replace(/^Your checks: /, "") + "." : "No rule you implement is retired or changed here, and no new rule is missing a check.") + "</p></div>" +
    groups + '<div class="sheet-foot"><span class="sheet-note">' + esc((tracked + checked + " Matched by edit ID to what your registry's consumers implement; never by AI.").trim()) + "</span></div></section>";
}
function controlsSheet(entry) {
  if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0) return "";
  const result = controlsFor(entry.event_id);
  return result ? '<div id="change-controls" data-event="' + esc(entry.event_id) + '">' + controlsSheetHtml(result) + "</div>" : "";
}
// The rule index (for extras) loads the first time a change or consumer needs it.
function fillControls(entry, stillCurrent) {
  if (state.ruleIndex || !registryImplements()) return;
  loadRuleIndex().then(() => {
    const slot = document.getElementById("change-controls");
    if (!stillCurrent() || !slot || slot.dataset.event !== entry.event_id) return;
    const result = controlsFor(entry.event_id);
    if (result) { slot.innerHTML = controlsSheetHtml(result); fillSuggestions(entry.event_id, stillCurrent); }
  });
}
/* ---------- Suggested updates (Phase 4.4) ----------
 * regmon/suggestions.py writes data/suggestions/<event>.json after each scan: a brief per
 * rule (the regulator's before/after text and what to do; deterministic) and, when a free
 * OpenRouter model answered, a draft of the updated check. A draft is never applied: the
 * owner approves or rejects it through a prefilled issue (suggestion-review.yml), recorded
 * in data/reviews/suggestions.json with the draft's hash. */
const SUGGESTION_MARKER = "<!-- changesentinel:suggestion-decision:v1 -->";
const SUGGESTION_TITLE = "[ChangeSentinel] Suggestion decision";
function loadPagesJson(path, cacheKey) {
  if (!state.pagesJson) state.pagesJson = new Map();
  const key = cacheKey || path;
  if (state.pagesJson.has(key)) return state.pagesJson.get(key);
  const promise = (async () => {
    for (const url of [new URL("./" + path, document.baseURI).href, bust(RAW + "/" + path)]) {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (response.status === 404) continue;
        if (!response.ok) continue;
        return await response.json();
      } catch (_) { /* next copy */ }
    }
    return null;
  })();
  state.pagesJson.set(key, promise);
  return promise;
}
function suggestionDecision(decisions, eventId, ruleId, draftHash) {
  const record = ((decisions && decisions.decisions) || {})[eventId];
  const row = record && record[ruleId];
  if (!row) return null;
  return Object.assign({ stale: !!(row.draft_hash && draftHash && row.draft_hash !== draftHash) }, row);
}
function suggestionHtml(doc, brief, decisions) {
  const ai = doc.ai || {};
  const drafted = (ai.drafts || {})[brief.id];
  const decision = suggestionDecision(decisions, doc.event_id, brief.id, drafted && drafted.hash);
  const columns = (brief.columns || []).length ? specColumns({ columns: brief.columns }) :
    Object.keys(brief.values || {}).map(key => '<div class="spec-col"><span class="spec-col-name">' + esc(key) + '</span><span class="item-text">' + esc(brief.values[key]) + "</span></div>").join("");
  const checks = (brief.checks || []).map(check => [check.name, check.language].filter(Boolean).join(" · ")).join("; ");
  let draftPart;
  if (drafted) {
    const status = decision && !decision.stale ? '<span class="tag ' + (decision.decision === "approved" ? "is-relevant" : "is-irrelevant") + '">' + esc(decision.decision === "approved" ? "Approved" : "Rejected") + "</span>" +
        '<span class="spec-when">' + esc([decision.by, decision.at ? fmt(decision.at) : ""].filter(Boolean).join(" · ")) + "</span>" :
      '<span class="tag is-unreviewed">Not reviewed</span>' + (decision && decision.stale ? '<span class="spec-when">An earlier draft was ' + esc(decision.decision) + "</span>" : "");
    draftPart = '<div class="spec-meta"><span class="tag is-warn">AI draft</span><span class="spec-when">' + esc([drafted.language, ai.provider_model || ai.model].filter(Boolean).join(" · ")) + "</span>" + status + "</div>" +
      '<pre class="suggestion-draft">' + esc(drafted.draft) + "</pre>" +
      (drafted.notes ? '<span class="spec-declared">' + esc(drafted.notes) + "</span>" : "") +
      '<span class="suggestion-actions"><button class="btn" type="button" data-suggest-copy="' + esc(brief.id) + '">Copy draft</button>' +
      '<button class="btn" type="button" data-suggest-decide="approved" data-suggest-rule="' + esc(brief.id) + '">Approve</button>' +
      '<button class="btn" type="button" data-suggest-decide="rejected" data-suggest-rule="' + esc(brief.id) + '">Reject</button></span>';
  } else if (brief.finding === "retired_in_use") {
    draftPart = "";
  } else {
    draftPart = '<span class="spec-declared">' + esc(ai.status === "ok" ? "The model returned no draft for this rule." :
      "No AI draft yet" + (ai.reason ? " (" + ai.reason + ")" : "") + ". Drafts use free OpenRouter models only and are retried on the next scan.") + "</span>";
  }
  return '<details class="verdict-why suggestion"><summary>Suggested update</summary><div class="suggestion-body">' +
    '<span class="spec-declared">' + esc(brief.action) + "</span>" +
    (checks ? '<span class="spec-when">' + esc(checks) + "</span>" : "") +
    (columns ? '<div class="suggestion-columns">' + columns + "</div>" : "") + draftPart + "</div></details>";
}
async function fillSuggestions(eventId, stillCurrent) {
  const slots = () => Array.from(document.querySelectorAll("#change-controls .suggestion-slot"));
  if (!slots().length) return;
  const [doc, decisions] = await Promise.all([loadPagesJson("data/suggestions/" + eventId + ".json"), loadPagesJson("data/reviews/suggestions.json")]);
  if (!stillCurrent() || !doc || !Array.isArray(doc.briefs)) return;
  state.suggestionDoc = doc;
  const byId = new Map(doc.briefs.map(brief => [L.registryNorm(brief.id), brief]));
  slots().forEach(slot => {
    const brief = byId.get(slot.dataset.suggest);
    if (brief) slot.innerHTML = suggestionHtml(doc, brief, decisions);
  });
}
function suggestionBrief(ruleId) {
  const doc = state.suggestionDoc;
  return doc && (doc.briefs || []).find(brief => brief.id === ruleId) ? { doc, brief: doc.briefs.find(brief => brief.id === ruleId) } : null;
}
async function copySuggestion(ruleId) {
  const found = suggestionBrief(ruleId);
  const drafted = found && ((found.doc.ai || {}).drafts || {})[ruleId];
  if (!drafted) return;
  try { await navigator.clipboard.writeText(drafted.draft); showToast("Draft copied. It is unreviewed; check it against the regulator's text before using it."); }
  catch (_) { window.prompt("Copy the draft:", drafted.draft); }
}
function decideSuggestion(ruleId, decision) {
  const found = suggestionBrief(ruleId);
  if (!found) return;
  const drafted = ((found.doc.ai || {}).drafts || {})[ruleId] || {};
  const note = window.prompt(decision === "approved" ? "Approve this draft for " + ruleId + "? Add a note (optional):" : "Reject this draft for " + ruleId + "? Say why (optional):", "");
  if (note === null) return;
  const request = { version: 1, event_id: found.doc.event_id, rule: ruleId, decision, draft_hash: drafted.hash || "", note: String(note).slice(0, 500) };
  const body = [SUGGESTION_MARKER, "", (decision === "approved" ? "Approve" : "Reject") + " the suggested update for " + ruleId + ". Nothing is applied to any code; the decision is recorded.", "",
    "```json", JSON.stringify(request, null, 1), "```", "", "Only requests opened by the repository owner are recorded.", "", "This request was created from the ChangeSentinel dashboard."].join("\n");
  const params = new URLSearchParams();
  params.set("title", SUGGESTION_TITLE + ": " + decision + " " + ruleId);
  params.set("body", body);
  openGitHubRequest(REPO + "/issues/new?" + params.toString(), "Submit the prefilled request on GitHub. The decision shows here about a minute after it is recorded.");
}
function consumerControlsSheet(consumer) {
  const list = Array.isArray(consumer.implements) ? consumer.implements : [];
  if (!list.length) return "";
  const index = ruleIndexNow();
  const groups = new Map();
  list.forEach(value => {
    const [form, id] = L.parseImplements(value);
    const key = form || "Any form";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, extra: L.controlConsumerExtras({ implements: [value] }, index).length > 0 });
  });
  const events = (state.changeFacts && isPlainObject(state.changeFacts.events)) ? Object.keys(state.changeFacts.events) : [];
  const touched = new Set();
  events.forEach(id => {
    const result = controlsFor(id);
    if (result && ["retired_in_use", "differs"].some(finding => (result[finding] || []).some(row => row.consumers.indexOf(consumer.id) >= 0))) touched.add(id);
  });
  const entries = changeLogEntries().filter(entry => touched.has(entry.event_id)).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  const extraCount = Array.from(groups.values()).reduce((sum, rows) => sum + rows.filter(row => row.extra).length, 0);
  return '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Edit checks it implements</h3><div class="sheet-note">' +
      esc(plural(list.length, "edit check", "edit checks") + (extraCount ? "; " + extraCount + " not in the current specification" : "")) + "</div></div></div>" +
    Array.from(groups.entries()).map(([form, rows]) => '<div class="items-group"><div class="items-group-label">' + esc(form) + " <span>" + esc(rows.length) + "</span></div>" +
      '<div class="registry-unregistered">' + rows.slice(0, 300).map(row => '<span class="chip is-static' + '"' + (row.extra ? ' title="The current ' + esc(form) + ' specification does not define it"' : "") + ">" +
        esc(row.id) + (row.extra ? " · not in the current spec" : "") + "</span>").join("") + (rows.length > 300 ? '<span class="sheet-note">and ' + esc(rows.length - 300) + " more</span>" : "") + "</div></div>").join("") +
    "</section>" + (entries.length ? registryChangesSheet(entries, "Changes to rules it implements") :
      '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Changes to rules it implements</h3></div><p class="note-strip">No recorded change has retired or altered a rule it implements yet. Rules are matched by edit ID in each change\'s structured spec comparison.</p></section>');
}

function assessSourceLink(form) {
  const report = state.reportLibrary.reports.get(form);
  return report && safeHttpUrl(report.source) ? externalLink(report.source, "Who files it", "sheet-link") : "";
}
function assessmentCounts() {
  const counts = { applies: 0, not_applicable: 0, unknown: 0, unassessed: 0, p1: 0, gaps: 0 };
  assessments().forEach(a => {
    counts[a.applicability.status] = (counts[a.applicability.status] || 0) + 1;
    if (a.priority.band === 1) counts.p1 += 1;
    if (a.gaps) counts.gaps += 1;
  });
  return counts;
}

/* ---------- Entity profile: Registry → Entity profile, and its editor ---------- */
const PROFILE_CATEGORIES = [["", "Not stated"], ["none", "None"], ["I", "Category I"], ["II", "Category II"], ["III", "Category III"], ["IV", "Category IV"]];
const PROFILE_FLAGS = [["", "Not stated"], ["yes", "Yes"], ["no", "No"]];
const PROFILE_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "BRL", "COP", "INR", "BSD"];
let profileDraft = null;
function profileSummary(profile) {
  const entities = profile.entities || [];
  if (!L.hasProfile(profile)) return "Not set up: changes aren't assessed yet";
  const forms = Array.from(new Set(libraryReports().map(report => report.form).concat((profile.reports || []).map(row => row.form))));
  const files = forms.filter(form => L.assessReportStatus(form, profile, state.reportLibrary).status === "files");
  return plural(entities.length, "entity", "entities") + " · files " + (files.length ? files.slice(0, 3).join(", ") + (files.length > 3 ? " and " + (files.length - 3) + " more" : "") : "no report yet");
}
function profileRow(selected) {
  return '<div class="list-group-label">Entity profile</div><button class="row" type="button" data-select-registry="profile"' + selected("profile") + ">" +
    '<span class="row-mark ' + (profileReady() ? "tone-new" : "tone-markup") + '" aria-hidden="true"></span><span class="row-title">' +
    esc(profileReady() ? ((profileNow().entities[0] || {}).name || "Entity profile") : "Set up the entity profile") + "</span>" +
    '<span class="row-summary">' + esc(profileSummary(profileNow())) + "</span></button>";
}
// The profile's own jurisdictions first (US entities: US reports), then the rest.
function libraryReports(profile) {
  const kinds = state.reportLibrary.kinds || {};
  const home = new Set(((profile || profileDraft || profileNow()).entities || []).map(entity => (kinds[entity.kind] || {}).jurisdiction).filter(Boolean));
  const rank = report => home.has(report.jurisdiction) ? 0 : 1;
  return Array.from(state.reportLibrary.reports.values()).sort((a, b) => rank(a) - rank(b) || String(a.jurisdiction).localeCompare(String(b.jurisdiction)) || String(a.form).localeCompare(String(b.form)));
}
// Thresholds are tested on recent figures (the Call Report on 30 June, FR Y-14 on a four-quarter
// average), so figures more than 15 months old are flagged.
function profileStale(entity) {
  const days = entity && entity.as_of ? L.daysBetween(entity.as_of, L.localIsoDate()) : null;
  return days !== null && days > 456;
}
function profileEntityFacts(entity) {
  const kinds = state.reportLibrary.kinds || {};
  const flag = value => value === true ? "Yes" : value === false ? "No" : "";
  return [
    ["Kind", (kinds[entity.kind] || {}).label || entity.kind],
    ["Parent", entity.parent ? ((profileNow().entities.find(other => other.id === entity.parent) || {}).name || entity.parent) : "Top tier"],
    ["Total assets", entity.total_assets !== undefined ? L.assessMoney(entity.total_assets) + (entity.currency && entity.currency !== "USD" ? " " + entity.currency : "") : "Not stated"],
    ["As of", entity.as_of ? L.catalogDate(entity.as_of) + (profileStale(entity) ? " · over 15 months old: update the figures" : "") : ""],
    ["Foreign offices", flag(entity.foreign_offices)],
    ["Advanced approaches", flag(entity.advanced_approaches)],
    ["Category", entity.category ? (entity.category === "none" ? "None" : "Category " + entity.category) : ""],
    ["Trading assets and liabilities", entity.trading !== undefined ? L.assessMoney(entity.trading) : ""]
  ].filter(([, value]) => value);
}
function profileDetail() {
  const profile = profileNow();
  const ready = profileReady();
  const actions = '<button class="btn btn-primary" type="button" data-profile-edit>' + (ready ? "Edit profile" : "Set up the profile") + "</button>";
  const entities = (profile.entities || []).map(entity => '<li class="spec-row"><span class="item-label">' + esc(entity.name || entity.id) + '</span><span class="spec-main">' +
      profileEntityFacts(entity).map(([label, value]) => '<span class="spec-col"><span class="spec-col-name">' + esc(label) + "</span><span>" + esc(value) + "</span></span>").join("") +
      "</span></li>").join("");
  const listedForms = (profile.reports || []).map(row => row.form);
  const forms = Array.from(new Set(libraryReports().map(report => report.form).concat(listedForms)));
  const rows = forms.map(form => Object.assign({ form }, L.assessReportStatus(form, profile, state.reportLibrary)));
  const groups = [["files", "Files", "is-added"], ["eligible", "May file", "is-amended"], ["unknown", "Not decided", "is-amended"], ["not_filed", "Doesn't file", ""]];
  const reportsHtml = groups.map(([status, label, led]) => {
    const members = rows.filter(row => row.status === status);
    if (!members.length) return "";
    return '<div class="items-group"><div class="items-group-label ' + led + '">' + esc(label) + " <span>" + esc(members.length) + '</span></div><ul class="items-list">' +
      members.map(row => '<li class="spec-row"><span class="item-label">' + esc(row.form) + '</span><span class="spec-main"><span class="spec-meta">' +
        '<span class="spec-when">' + esc(row.basis === "profile" ? "Your profile" : row.basis === "rule" ? "By rule" : row.basis === "list" ? "Not in your list" : "Not decided") + "</span>" +
        assessSourceLink(row.form) + '</span><span class="spec-declared">' + esc(row.reason) + "</span></span></li>").join("") + "</ul></div>";
  }).join("");
  const counts = assessmentCounts();
  const effect = ready ? [["Apply", counts.applies], ["Not applicable", counts.not_applicable], ["May apply", counts.unknown], ["Priority 1", counts.p1], ["With unmapped items", counts.gaps]] : [];
  const verified = state.reportLibrary.verifiedAt ? " Thresholds were checked against each source on " + L.catalogDate(state.reportLibrary.verifiedAt) + "." : "";
  return '<div class="detail-inner">' + detailHeading({ back: true, source: "Registry", title: ready ? "Who you are and what you file" : "Set up the entity profile", actions }) +
    (ready ? '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Recorded changes, assessed</h3><div class="sheet-note">' +
      esc("By the rules below and this profile. Nothing is hidden: Changes → All still lists every change.") + '</div></div><button class="sheet-link" type="button" data-go-applies>Show what applies</button></div>' +
      '<dl class="facts">' + effect.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl></section>" :
      '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Why</h3></div><div class="registry-copy"><p>Say who reports (holding company, bank, branch: kind, total assets and the few facts the report rules test) and which reports you file. Each change then says whether it applies to you and why, changed items in reports you file that no consumer reads show as gaps, and the Changes list can be put in priority order.</p>' +
      '<p>Reports are decided by your list first, then by the regulator\'s rule (FR Y-9C: holding companies with $3 billion or more), and are otherwise left undecided, never assumed.</p></div></section>') +
    (entities ? '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Entities</h3><div class="sheet-note">' + esc(plural(profile.entities.length, "entity", "entities")) +
      (profile.updated_at ? " · updated " + esc(fmt(profile.updated_at)) : "") + '</div></div></div><ul class="items-list">' + entities + "</ul></section>" : "") +
    (ready ? '<div id="profileProposals"></div>' : "") +
    '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Reports</h3><div class="sheet-note">' +
      esc("Your list decides first, then the report's rule." + (profile.reports_complete ? " Your list is complete, so any other report is not filed." : "") + verified) + "</div></div>" +
      externalLink(REPO + "/blob/main/config/reports.json", "Report rules", "sheet-link") + "</div>" + reportsHtml + "</section></div>";
}
// Proposed revisions to the reports the profile files: what is coming, before it is final.
async function fillProfileProposals() {
  const slot = document.getElementById("profileProposals");
  if (!slot) return;
  const profile = profileNow();
  const forms = Array.from(new Set(libraryReports(profile).map(report => report.form).concat((profile.reports || []).map(row => row.form))))
    .filter(form => L.assessReportStatus(form, profile, state.reportLibrary).status === "files");
  if (!forms.length) { slot.innerHTML = ""; return; }
  let payload;
  try { payload = await loadProposals(); } catch (_) { slot.innerHTML = ""; return; }
  if (document.getElementById("profileProposals") !== slot) return;
  const today = L.localIsoDate();
  const all = payload ? L.proposalsFor(payload, forms) : [];
  // Still open (proposed, under review, request for comment) or not yet in effect; newest first.
  // A proposal page can keep a long-settled package under "proposed": open means dated in the
  // last 18 months, unless an effective date is still ahead.
  const recent = proposal => { const days = proposal.date ? L.daysBetween(proposal.date, today) : null; return days !== null && days <= 548; };
  const open = all.filter(proposal => (proposal.effective || []).some(day => day >= today) ||
    (["proposed", "request", "under_review"].indexOf(proposal.stage) >= 0 && recent(proposal)));
  slot.innerHTML = '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Coming to reports you file</h3><div class="sheet-note">' +
    esc("Open proposals and revisions not yet in effect for " + forms.join(", ") + ", from the regulators' form pages") + "</div></div></div>" +
    (open.length ? '<ul class="items-list">' + open.slice(0, 8).map(proposal => proposalRow(proposal, today)).join("") + "</ul>" +
      (open.length > 8 ? '<p class="note-strip">' + esc(plural(open.length - 8, "more", "more")) + " in data/proposals.json.</p>" : "") :
      '<p class="note-strip">No open proposal for these reports is listed on a monitored page.</p>') + "</section>";
}
function profileEntityFields(entity, index) {
  const kinds = state.reportLibrary.kinds || {};
  const id = name => "profile-" + name + "-" + index;
  const option = (value, label, current) => '<option value="' + esc(value) + '"' + (String(current) === String(value) ? " selected" : "") + ">" + esc(label) + "</option>";
  const flag = value => value === true ? "yes" : value === false ? "no" : "";
  const billions = value => value === undefined || value === null ? "" : String(Number(value) / 1e9);
  const parents = profileDraft.entities.filter((other, otherIndex) => otherIndex !== index);
  return '<fieldset class="profile-entity" data-profile-entity="' + index + '"><legend class="field-label-text"><span class="registry-legend">' + esc(entity.name || "Entity " + (index + 1)) + "</span>" +
    (profileDraft.entities.length > 1 ? '<button class="text-button" type="button" data-profile-remove="' + index + '">Remove</button>' : "") + "</legend>" +
    '<div class="form-grid">' +
    '<div class="span-2"><label class="field-label-text" for="' + id("name") + '">Name</label><input class="field-input" id="' + id("name") + '" data-field="name" maxlength="200" autocomplete="off" value="' + esc(entity.name || "") + '" placeholder="Example Bancorp"></div>' +
    '<div><label class="field-label-text" for="' + id("kind") + '">Kind</label><select class="field-input" id="' + id("kind") + '" data-field="kind">' +
      Object.keys(kinds).map(kind => option(kind, kinds[kind].label, entity.kind || "bhc")).join("") + "</select></div>" +
    '<div><label class="field-label-text" for="' + id("parent") + '">Parent <span>Top tier if none</span></label><select class="field-input" id="' + id("parent") + '" data-field="parent">' +
      option("", "None (top tier)", entity.parent || "") + parents.map(other => option(other.id, other.name || other.id, entity.parent || "")).join("") + "</select></div>" +
    '<div><label class="field-label-text" for="' + id("assets") + '">Total assets <span>In billions</span></label><input class="field-input" id="' + id("assets") + '" data-field="total_assets" inputmode="decimal" autocomplete="off" value="' + esc(billions(entity.total_assets)) + '" placeholder="48.2"></div>' +
    '<div><label class="field-label-text" for="' + id("currency") + '">Currency</label><select class="field-input" id="' + id("currency") + '" data-field="currency">' +
      PROFILE_CURRENCIES.map(code => option(code, code, entity.currency || (/^ca_/.test(entity.kind || "") ? "CAD" : "USD"))).join("") + "</select></div>" +
    '<div><label class="field-label-text" for="' + id("asof") + '">As of <span>Optional</span></label><input class="field-input" type="date" id="' + id("asof") + '" data-field="as_of" value="' + esc(entity.as_of || "") + '"></div>' +
    '<div><label class="field-label-text" for="' + id("trading") + '">Trading assets and liabilities <span>In billions</span></label><input class="field-input" id="' + id("trading") + '" data-field="trading" inputmode="decimal" autocomplete="off" value="' + esc(billions(entity.trading)) + '"></div>' +
    '<div><label class="field-label-text" for="' + id("foreign") + '">Foreign offices</label><select class="field-input" id="' + id("foreign") + '" data-field="foreign_offices">' +
      PROFILE_FLAGS.map(([value, label]) => option(value, label, flag(entity.foreign_offices))).join("") + "</select></div>" +
    '<div><label class="field-label-text" for="' + id("advanced") + '">Advanced approaches</label><select class="field-input" id="' + id("advanced") + '" data-field="advanced_approaches">' +
      PROFILE_FLAGS.map(([value, label]) => option(value, label, flag(entity.advanced_approaches))).join("") + "</select></div>" +
    '<div><label class="field-label-text" for="' + id("category") + '">Tailoring category</label><select class="field-input" id="' + id("category") + '" data-field="category">' +
      PROFILE_CATEGORIES.map(([value, label]) => option(value, label, entity.category || "")).join("") + "</select></div>" +
    "</div></fieldset>";
}
function profileSlug(text, taken) {
  const base = String(text || "entity").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "entity";
  let id = base, n = 2;
  while (taken.has(id)) { id = base.slice(0, 30) + "-" + n; n += 1; }
  return id;
}
// The draft as config/profile.json would hold it; amounts typed in billions.
function profileFromForm() {
  const errors = [];
  const taken = new Set();
  const entities = profileDraft.entities.map((entity, index) => {
    const box = document.querySelector('[data-profile-entity="' + index + '"]');
    const read = field => box ? (box.querySelector('[data-field="' + field + '"]') || {}).value || "" : "";
    const out = { id: entity.id || "", name: read("name").trim() || "Entity " + (index + 1), kind: read("kind") };
    if (!out.id) out.id = profileSlug(out.name, taken);
    taken.add(out.id);
    const parent = read("parent");
    if (parent) out.parent = parent;
    [["total_assets", "Total assets"], ["trading", "Trading assets and liabilities"]].forEach(([field, label]) => {
      const text = read(field).replace(/[,\s$]/g, "");
      if (!text) return;
      const value = Number(text);
      if (!Number.isFinite(value) || value < 0) errors.push(out.name + ": " + label + " must be a number of billions, such as 48.2.");
      else out[field] = Math.round(value * 1e9);
    });
    out.currency = read("currency") || "USD";
    if (read("as_of")) out.as_of = read("as_of");
    ["foreign_offices", "advanced_approaches"].forEach(field => { const value = read(field); if (value) out[field] = value === "yes"; });
    if (read("category")) out.category = read("category");
    return out;
  });
  const ids = new Map(profileDraft.entities.map((entity, index) => [entity.id || "", entities[index].id]));
  entities.forEach(entity => { if (entity.parent && ids.has(entity.parent)) entity.parent = ids.get(entity.parent); });
  const reports = [];
  const known = new Set(entities.map(entity => entity.id));
  document.querySelectorAll("[data-profile-report]").forEach(select => {
    const value = select.value;
    if (value === "files" || value === "not_filed") reports.push({ form: select.dataset.profileReport, files: value === "files" });
    else if (value.indexOf("files:") === 0) {
      const entity = ids.get(value.slice(6)) || value.slice(6);
      reports.push(known.has(entity) ? { form: select.dataset.profileReport, files: true, entity } : { form: select.dataset.profileReport, files: true });
    }
  });
  ($("profileOther").value || "").split(/\n|;/).map(line => line.trim()).filter(Boolean).forEach(form => {
    if (!reports.some(row => row.form === form)) reports.push({ form: form.slice(0, 40), files: true });
  });
  (profileDraft.reports || []).forEach(row => {
    if (row.note && reports.some(out => out.form === row.form && !out.entity)) reports.find(out => out.form === row.form).note = row.note;
  });
  const profile = { schema_version: 1, entities, reports, reports_complete: $("profileComplete").checked };
  if ($("profileMute") && $("profileMute").checked) profile.alerts = { not_applicable: "mute" };
  return { profile, errors };
}
function renderProfileReports() {
  const box = $("profileReports");
  if (!box) return;
  const draft = profileFromForm().profile;
  const listed = new Map((profileDraft.reports || []).map(row => [row.form, row.files === false ? "not_filed" : row.entity ? "files:" + row.entity : "files"]));
  document.querySelectorAll("[data-profile-report]").forEach(select => listed.set(select.dataset.profileReport, select.value));
  const ruleOnly = Object.assign({}, draft, { reports: draft.reports.filter(row => !state.reportLibrary.reports.has(row.form)), reports_complete: false });
  box.innerHTML = libraryReports().map(report => {
    const choice = listed.get(report.form) || "rule";
    const byRule = L.assessReportStatus(report.form, ruleOnly, state.reportLibrary);
    const id = "profile-report-" + report.form.replace(/[^A-Za-z0-9]+/g, "-");
    return '<div class="profile-report"><label class="field-label-text" for="' + id + '" title="' + esc(report.name) + '"><span class="profile-form">' + esc(report.form) + "</span><span>" + esc(report.name) + "</span></label>" +
      '<select class="field-input" id="' + id + '" data-profile-report="' + esc(report.form) + '">' +
      '<option value="rule"' + (choice === "rule" ? " selected" : "") + ">" + esc(report.rule ? "By rule: " + (L.REPORT_STATUS_WORDS[byRule.status] || "Undecided").toLowerCase() : "Not decided") + "</option>" +
      '<option value="files"' + (choice === "files" ? " selected" : "") + ">We file it</option>" +
      (draft.entities.length > 1 ? draft.entities.map(entity => '<option value="files:' + esc(entity.id) + '"' + (choice === "files:" + entity.id ? " selected" : "") + ">" +
        esc(entity.name || entity.id) + " files it</option>").join("") : "") +
      '<option value="not_filed"' + (choice === "not_filed" ? " selected" : "") + ">We don't file it</option></select></div>";
  }).join("");
}
function updateProfilePreview() {
  const preview = $("profilePreview");
  if (!preview) return;
  const draft = profileFromForm();
  const events = state.changeFacts && isPlainObject(state.changeFacts.events) ? state.changeFacts.events : {};
  const today = L.localIsoDate();
  const model = registryModelNow();
  const counts = { applies: 0, not_applicable: 0, unknown: 0, unassessed: 0 };
  Object.keys(events).forEach(id => { const a = L.assessChange(events[id], draft.profile, model, state.reportLibrary, today); counts[a.applicability.status] += 1; });
  const total = Object.keys(events).length;
  preview.textContent = !L.hasProfile(draft.profile) ? "" : total
    ? "Of " + plural(total, "recorded change", "recorded changes") + ": " + counts.applies + " apply, " + counts.not_applicable + " don't, " + counts.unknown + " may apply."
    : "No recorded changes to assess yet.";
}
function openProfileEditor() {
  const profile = profileNow();
  profileDraft = JSON.parse(JSON.stringify(profile));
  if (!profileDraft.entities.length) profileDraft.entities = [{ id: "", name: "", kind: "bhc" }];
  drawProfileEntities();
  const libraryForms = new Set(libraryReports().map(report => report.form));
  $("profileOther").value = (profile.reports || []).filter(row => row.files !== false && !libraryForms.has(row.form)).map(row => row.form).join("\n");
  $("profileComplete").checked = !!profile.reports_complete;
  if ($("profileMute")) $("profileMute").checked = !!(profile.alerts && profile.alerts.not_applicable === "mute");
  $("profileStatus").hidden = true;
  renderProfileReports();
  updateProfilePreview();
  $("profileDialog").showModal();
}
function drawProfileEntities() {
  $("profileEntities").innerHTML = profileDraft.entities.map(profileEntityFields).join("");
}
function syncProfileDraft() {
  const current = profileFromForm().profile;
  profileDraft.entities = current.entities;
  return current;
}
function addProfileEntity() {
  syncProfileDraft();
  const parent = profileDraft.entities[0];
  profileDraft.entities.push({ id: "", name: "", kind: parent && /^ca_/.test(parent.kind) ? "ca_bank" : "bank", parent: parent ? parent.id : "" });
  drawProfileEntities();
  renderProfileReports();
  updateProfilePreview();
}
function removeProfileEntity(index) {
  syncProfileDraft();
  const gone = profileDraft.entities[index];
  profileDraft.entities.splice(index, 1);
  profileDraft.entities.forEach(entity => { if (gone && entity.parent === gone.id) delete entity.parent; });
  drawProfileEntities();
  renderProfileReports();
  updateProfilePreview();
}
function submitProfile(event) {
  event.preventDefault();
  const draft = profileFromForm();
  const request = L.profileRequest(draft.profile);
  const errors = draft.errors.concat(request.errors);
  const params = new URLSearchParams();
  params.set("title", request.title);
  params.set("body", request.body);
  const target = REPO + "/issues/new?" + params.toString();
  if (!errors.length && target.length > MAX_BULK_REQUEST_URL_LENGTH) errors.push("This profile is too long for one GitHub link. Edit config/profile.json directly.");
  if (errors.length) { $("profileStatus").textContent = errors.join(" "); $("profileStatus").hidden = false; return; }
  $("profileDialog").close();
  openGitHubRequest(target, "Submit the prefilled request on GitHub. The profile, and every change's assessment, update about a minute after it is applied.");
}

/* ================= Lists ================= */

function changeRow(entry, options) {
  const verdict = verdictFor(entry);
  const tone = L.eventTone(entry.event_type);
  const selected = !options.compact && entry.event_id === state.selectedChangeId;
  return '<button class="row" type="button" data-select-change="' + esc(entry.event_id) + '"' + (selected ? ' aria-selected="true" aria-current="true"' : "") + ">" +
    '<span class="row-mark ' + toneClass(entry) + '" aria-hidden="true"></span>' +
    '<span class="row-title">' + esc(eventTitle(entry)) + "</span>" +
    '<span class="row-time">' + esc(rowTime(entry.timestamp)) + "</span>" +
    '<span class="row-sub"><span class="tag ' + toneClass(entry) + '">' + esc(L.eventLabel(entry.event_type)) + "</span>" + assessTags(entry) + controlTag(entry) + verdictTag(verdict, entry) + reviewTag(reviewFor(entry.event_id)) + specTag(entry) + "</span>" +
    '<span class="row-summary">' + esc(eventHeadline(entry)) + "</span></button>";
}
// A code-only edit (the page's HTML changed, its extracted text did not) is
// kept and searchable, but it is not something a reviewer has to decide on, so
// it stays out of the review queue, the Undecided list and every headline count.
function isCodeOnly(entry) { return !!entry && entry.event_type === "HTML_SOURCE_CHANGED"; }
function needsReview(entry) { return !!entry && !isCodeOnly(entry); }
// The Changes badge and the Overview headline count the same thing: changes
// still waiting for a decision, without code-only edits or changes to reports
// the profile says the entity doesn't file.
function undecidedChange(entry) {
  if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0 || isCodeOnly(entry) || reviewFor(entry.event_id)) return false;
  const a = profileReady() ? assessmentFor(entry.event_id) : null;
  return !(a && a.applicability.status === "not_applicable");
}
function filteredChanges() {
  return changeLogEntries().filter(entry => {
    if (!inScope(entrySourceId(entry))) return false;
    if (state.changeFilter === "REVIEW") return needsReview(entry);
    if (state.changeFilter === "RELEVANT") return verdictFor(entry).state === "relevant";
    if (state.changeFilter === "PROBLEMS") return L.eventTone(entry.event_type) === "problem";
    if (state.changeFilter === "UNDECIDED") {
      if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0 || isCodeOnly(entry) || reviewFor(entry.event_id)) return false;
      // Nobody needs to review a change to a report the entity doesn't file.
      const a = profileReady() ? assessmentFor(entry.event_id) : null;
      return !(a && a.applicability.status === "not_applicable");
    }
    if (state.changeFilter === "APPLIES") {
      const a = CHANGE_EVENT_TYPES.indexOf(entry.event_type) >= 0 ? assessmentFor(entry.event_id) : null;
      return !!a && a.applicability.status === "applies";
    }
    return true;
  });
}
// The Applies filter and the Priority order need a profile; they're shown once there is one.
function syncChangeTools() {
  const ready = profileReady();
  document.querySelectorAll("[data-needs-profile]").forEach(node => { node.hidden = !ready; });
  // With a profile the filters gain Applies, so Export moves down beside Order to keep them on one line.
  document.querySelectorAll("[data-without-profile]").forEach(node => { node.hidden = ready; });
  if (!ready && state.changeFilter === "APPLIES") state.changeFilter = "REVIEW";
  document.querySelectorAll("[data-change-filter]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.changeFilter === state.changeFilter)));
  const order = $("changeOrder");
  if (order) {
    order.value = ready ? state.changeSort : "newest";
    order.classList.toggle("is-set", ready && state.changeSort === "priority");
  }
}
function renderChangeRoute() {
  renderScopeBars();
  const all = changeLogEntries();
  const events = filteredChanges();
  const migrations = migrationCount();
  // The count is what the list shows, out of everything recorded.
  const scoped = all.filter(entry => inScope(entrySourceId(entry)));
  $("changeCount").textContent = state.changeFilter === "ALL" && events.length === all.length
    ? plural(all.length, "event", "events")
    : events.length + " of " + plural(all.length, "event", "events");
  const codeOnly = state.changeFilter === "REVIEW" ? scoped.filter(isCodeOnly).length : 0;
  const codeNote = codeOnly
    ? '<p class="note-strip code-only-note">' + esc(plural(codeOnly, "code-only edit is", "code-only edits are")) + " not listed: the page's code changed but its text did not, so there is nothing to decide. " +
      '<button class="sheet-link" type="button" data-change-filter="ALL">Show everything</button></p>'
    : "";
  syncChangeTools();
  if (!events.length) {
    if (state.changeFilter === "APPLIES" && !profileReady()) {
      $("changeItems").innerHTML = emptyState("No entity profile yet", "Add who you are and which reports you file, and the changes that apply to you are listed here.",
        '<button class="btn btn-primary" type="button" data-select-registry="profile">Set up the profile</button>');
      return;
    }
    $("changeItems").innerHTML = (state.changeFilter === "REVIEW" && all.length ? emptyState("Nothing to review", "No content changes, new or removed pages, or problems are recorded in this scope.") : emptyState(
      all.length ? "Nothing matches this filter" : "No changes recorded yet",
      all.length ? "Choose All to see every recorded change."
        : "Changes appear here once a monitored page differs from its saved copy." +
          (migrations ? " This run also re-read " + plural(migrations, "page", "pages") + " with an updated parser; that is not a source change, so it isn't listed (parser re-baseline)." : "")
    )) + codeNote;
    return;
  }
  const groups = [];
  const byPriority = state.changeSort === "priority" && profileReady();
  (byPriority ? sortByPriority(events) : events).forEach(entry => {
    const heading = byPriority ? PRIORITY_GROUPS[prioritySortKey(entry).band] || "Other" : L.dayHeading(entry.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.entries.push(entry);
    else groups.push({ heading, entries: [entry] });
  });
  $("changeItems").innerHTML = codeNote + groups.map(group =>
    '<div class="list-group-label">' + esc(group.heading) + "</div>" + group.entries.map(entry => changeRow(entry, {})).join("")
  ).join("") + (migrations
    ? '<p class="note-strip">The latest run also re-read ' + plural(migrations, "page", "pages") + " with an updated parser. A parser re-baseline is not a source change, so it isn't listed here.</p>"
    : "");
}
function pageRow(item) {
  const status = itemStatus(item);
  const selected = item.url_id === state.selectedId;
  const subtitle = itemSubtitle(item);
  const source = sourceForItem(item);
  if (state.picking) {
    const picked = state.picked.has(item.source_id);
    return '<button class="row monitor-row" type="button" data-pick-source="' + esc(item.source_id) + '" aria-pressed="' + picked + '">' +
      '<span class="row-mark ' + (picked ? "is-picked" : "is-pick") + '" aria-hidden="true"></span>' +
      '<span class="row-title">' + esc(itemTitle(item)) + "</span>" +
      '<span class="row-time">' + esc(scanScheduleWords(source).replace(/^Every 6 hours$/, "")) + "</span>" +
      '<span class="row-sub">' + organiseTags(source) + '<span class="row-host">' + esc(subtitle || displayUrl(item.canonical_url)) + "</span></span></button>";
  }
  return '<button class="row monitor-row" type="button" data-monitor-id="' + esc(item.url_id) + '" data-status-kind="' + esc(status.kind) + '"' + (selected ? ' aria-selected="true" aria-current="true"' : "") + ">" +
    '<span class="row-mark tone-' + esc(status.tone) + '" aria-hidden="true"></span>' +
    '<span class="row-title">' + esc(itemTitle(item)) + "</span>" +
    '<span class="row-time">' + esc(item.last_checked ? relativeTime(item.last_checked) : "") + "</span>" +
    '<span class="row-sub">' + (status.kind === "ok" ? "" : '<span class="tag tone-' + esc(status.tone) + '">' + esc(status.label) + "</span>") + organiseTags(source) +
    '<span class="row-host">' + esc(subtitle || displayUrl(item.canonical_url)) + "</span></span></button>";
}
function filteredMonitorItems() {
  const query = $("monitorSearch").value.trim().toLowerCase();
  return state.items.filter(item => {
    const status = itemStatus(item);
    if (state.filter === "CHANGES" && status.kind !== "change") return false;
    if (state.filter === "ERRORS" && status.kind !== "error") return false;
    if (!inScope(item.source_id)) return false;
    const source = sourceForItem(item);
    const haystack = [itemTitle(item), itemSubtitle(item), item.canonical_url, item.source_id, source.name, source.regulator, source.workspace || "", (source.labels || []).join(" ")].join(" ").toLowerCase();
    return !query || haystack.includes(query);
  });
}
function renderMonitorList() {
  renderScopeBars();
  const all = filteredMonitorItems();
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
    return label + '<button class="row" type="button" data-select-run="' + esc(runKey(run)) + '"' + (runKey(run) === state.selectedRunId ? ' aria-selected="true" aria-current="true"' : "") + ">" +
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
// Failed sends are recorded on the queued alert by regmon/notify.py.
function deliveryAttempts(item) { const count = Number(item && item.delivery_attempts); return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0; }
function deliveryErrors(item) {
  const errors = item && isPlainObject(item.last_errors) ? item.last_errors : {};
  return Object.keys(errors).map(name => channelLabel(name) + ": " + String(errors[name] || ""));
}
function notificationLists() {
  const pending = Object.entries(notificationMap(state.outbox, "pending_events"))
    .map(([eventId, item]) => ({ ...(item && typeof item === "object" ? item : {}), eventId, queued: true }))
    .sort((a, b) => String(b.eventId).localeCompare(String(a.eventId)));
  const sent = Object.entries(notificationMap(state.notifications, "sent_events"))
    .map(([eventId, item]) => ({ ...(item && typeof item === "object" ? item : {}), eventId, queued: false }))
    .sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));
  return { pending, sent };
}
// An alert is listed under the document it is about; its topic ("Replaced by
// a new edition") is the same for many alerts, so it goes underneath.
function notificationTitle(item) {
  const page = item && item.url ? state.items.find(candidate => candidate.canonical_url === item.url || candidate.url === item.url) : null;
  return page ? itemTitle(page) : item.topic || notificationKind(item.kind);
}
function notificationTopicLine(item) {
  const title = notificationTitle(item);
  return item.topic && item.topic !== title ? item.topic : "";
}
function renderNotifications() {
  const { pending, sent } = notificationLists();
  $("notificationPendingCount").textContent = pending.length ? "(" + pending.length + ")" : "";
  $("notificationSentCount").textContent = sent.length ? "(" + sent.length + ")" : "";
  $("notificationCounts").textContent = pending.length ? pending.length + " waiting" : "Nothing waiting";
  renderChannelBar();
  if ($("shadowEntry")) $("shadowEntry").innerHTML = shadowEntryRow();
  if ($("digestEntries")) $("digestEntries").innerHTML = digestEntryRows();

  $("notificationPendingItems").innerHTML = pending.length ? pending.map(item =>
    '<button class="row" type="button" data-select-notification="' + esc(item.eventId) + '"' + (item.eventId === state.selectedNotificationId ? ' aria-selected="true" aria-current="true"' : "") + ">" +
    '<span class="row-mark tone-' + (deliveryAttempts(item) ? "problem" : "change") + '" aria-hidden="true"></span>' +
    '<span class="row-title">' + esc(notificationTitle(item)) + "</span><span class=\"row-time\">" + esc(deliveryAttempts(item) ? "Failed " + deliveryAttempts(item) + "×" : "Queued") + "</span>" +
    '<span class="row-summary">' + esc([notificationTopicLine(item), item.summary || "Waiting for the next run to deliver it."].filter(Boolean).join(" · ")) + "</span>" +
    (safeHttpUrl(item.url) ? '<span class="row-sub"><span class="row-host">' + esc(displayUrl(item.url)) + "</span></span>" : "") +
    "</button>"
  ).join("") : '<p class="note-strip">Nothing is waiting. Alerts that fail to send stay queued and are retried on the next run.</p>';

  $("notificationSentItems").innerHTML = sent.length ? sent.slice(0, 100).map(item => {
    const superseded = !!item.superseded;
    return '<button class="row" type="button" data-select-notification="' + esc(item.eventId) + '"' + (item.eventId === state.selectedNotificationId ? ' aria-selected="true" aria-current="true"' : "") + ">" +
      '<span class="row-mark tone-' + (superseded ? "pending" : "ok") + '" aria-hidden="true"></span>' +
      '<span class="row-title">' + esc(notificationTitle(item)) + "</span>" +
      '<span class="row-time">' + esc(rowTime(item.sent_at)) + "</span>" +
      '<span class="row-sub">' + '<span class="tag">' + esc(notificationKind(item.kind)) + "</span>" +
      (superseded ? '<span class="tag is-irrelevant">Superseded</span>' : "") +
      '<span class="row-host">' + esc(notificationTopicLine(item) || (safeHttpUrl(item.url) ? displayUrl(item.url) : shortDate(item.sent_at) + ", no page recorded")) + "</span></span></button>";
  }).join("") + (sent.length > 100 ? '<p class="note-strip">Showing the 100 most recent deliveries.</p>' : "")
    : '<p class="note-strip">No alerts have been delivered yet.</p>';
}
// Only the view on screen is drawn. Every view used to be redrawn on each
// click, route change and background update (the Overview heatmap alone is
// rows × columns of cells), which made the whole dashboard lag. The others
// are marked stale and drawn when they are opened: setView and select set
// state.view before calling renderLists.
const LIST_RENDERERS = {
  overview() { renderOverview(); },
  changes() { renderChangeRoute(); },
  monitors() { renderMonitorList(); },
  runs() { renderRuns(); },
  health() { renderHealth(); },
  notifications() { renderNotifications(); },
  registry() { renderRegistry(); },
  scout() { renderScout(); },
  calendar() { renderCadenceView(); }
};
const staleLists = new Set();
function renderLists() {
  if (!state.loaded) return;
  Object.keys(LIST_RENDERERS).forEach(view => staleLists.add(view));
  renderListFor(state.view);
  renderNavCounts();
}
function renderListFor(view) {
  if (!LIST_RENDERERS[view]) return;
  staleLists.delete(view);
  LIST_RENDERERS[view]();
}
function renderNavCounts() {
  $("navRunCount").textContent = "";
  const pendingAlerts = notificationLists().pending.length;
  $("navNotificationCount").textContent = pendingAlerts ? pendingAlerts : "";
  $("navNotificationCount").classList.toggle("is-alert", pendingAlerts > 0);
  const undecided = changeLogEntries().filter(undecidedChange).length;
  $("navChangeCount").textContent = undecided || "";
  $("navChangeCount").title = undecided ? plural(undecided, "change", "changes") + " waiting for a decision" : "";
  if ($("navRegistryCount")) $("navRegistryCount").textContent = registryItems().length || "";
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
  if (event.event_type === "VISUAL_CHANGED") return '<div class="segmented" role="group" aria-label="Diff view"><button type="button" data-diff-mode="visual" aria-pressed="true">Visual</button></div>';
  const modes = [["redline", "Redline"], ["text", "Text diff"]];
  // Compare (cell by cell, page by page, side by side) whenever two versions may be stored: a
  // new edition (NEW_URL) is compared with its predecessor too. fillEvidence() drops the button
  // once the evidence shows there is nothing to overlay.
  if (event.event_type !== "REMOVED_URL") modes.unshift(["compare", "Compare"]);
  if (event.event_type !== "REMOVED_URL") modes.push(["html", "Code diff"]);
  if (isPlainObject(event.visual)) modes.push(["visual", "Visual"]);
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
    const wanted = event.event_type === "VISUAL_CHANGED" ? "visual" : state.diffMode;
    const mode = wanted === "compare" && !compareSources(evidence) ? "redline" : wanted === "visual" && !isPlainObject(evidence.visual) ? "redline" : wanted;
    // The buttons follow what is shown: Compare only when the evidence holds two versions to
    // overlay (not a first sighting or older evidence), and the view on screen is the pressed one.
    const group = target.parentElement && target.parentElement.querySelector("[data-diff-mode]");
    if (group && group.parentElement) {
      const canCompare = !!compareSources(evidence);
      group.parentElement.querySelectorAll("[data-diff-mode]").forEach(button => {
        if (button.dataset.diffMode === "compare" && !canCompare) button.remove();
        else button.setAttribute("aria-pressed", String(button.dataset.diffMode === mode));
      });
    }
    if (mode === "visual") {
      target.innerHTML = visualCompare(evidence.visual);
      if (summary) summary.textContent = visualSummary(evidence.visual);
    } else if (mode === "compare") {
      if (summary) summary.textContent = compareNote((compareSources(evidence) || {}).kind);
      renderCompare(target, evidence, event, stillCurrent);
    } else if (mode === "html") {
      target.innerHTML = L.renderUnifiedDiff(evidence.html_diff || "");
      if (summary) summary.textContent = "Formatted HTML markup diff. The fetched response is saved separately.";
    } else if (mode === "text") {
      target.innerHTML = L.renderUnifiedDiff(evidence.diff || "", { tables: true });
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
    renderVerdict(entry) + assessmentSheet(entry) + controlsSheet(entry) + reviewSheet(entry) + datesSheet(entry) + '<div id="change-impact"></div><div id="change-spec"></div><div id="change-items"></div><div id="change-links"></div>' + evidenceSheet(entry, boxId) + "</div>";
  const eventId = entry.event_id;
  const stillCurrent = () => state.view === "changes" && state.selectedChangeId === eventId;
  fillEvidence(entry, boxId, stillCurrent);
  fillReportingItems(entry, "change-items", stillCurrent);
  fillChangeLinks(entry, "change-links", stillCurrent);
  fillSpecChanges(entry, "change-spec", stillCurrent);
  fillImpact(entry, "change-impact", stillCurrent);
  fillControls(entry, stillCurrent);
  fillSuggestions(entry.event_id, stillCurrent);
}

/* ================= Review decisions, dates, reporting items ================= */

const REVIEW_TONES = { material: "is-relevant", action_required: "is-warn", not_material: "is-irrelevant", acknowledged: "" };
// Dashboard decisions not yet in the committed ledger (the sync adds an app_id
// to each record it copies, so a copied one is never counted twice).
function pendingAppReviews() {
  const log = state.reviews && Array.isArray(state.reviews.log) ? state.reviews.log : [];
  const copied = new Set(log.map(record => record && record.app_id).filter(Boolean));
  return (state.appReviews || []).filter(record => isPlainObject(record) && record.app_id && !copied.has(record.app_id))
    .map(record => ({ ...record, pending: true }));
}
// The current decision is the latest one by when it was made, however it was recorded.
function reviewFor(eventId) {
  const reviews = state.reviews && isPlainObject(state.reviews.reviews) ? state.reviews.reviews : {};
  const committed = isPlainObject(reviews[eventId]) ? reviews[eventId] : null;
  return pendingAppReviews().filter(record => record.event_id === eventId)
    .reduce((latest, record) => !latest || String(record.reviewed_at || "") >= String(latest.reviewed_at || "") ? record : latest, committed);
}
// Every decision ever recorded for a change, newest first.
function reviewLog(eventId) {
  const log = state.reviews && Array.isArray(state.reviews.log) ? state.reviews.log : [];
  return log.filter(record => isPlainObject(record) && record.event_id === eventId)
    .concat(pendingAppReviews().filter(record => record.event_id === eventId))
    .sort((a, b) => String(b.reviewed_at || "").localeCompare(String(a.reviewed_at || "")));
}
function reviewTag(review) {
  if (!review) return "";
  const label = L.REVIEW_DECISIONS[review.decision] || review.label || "Reviewed";
  const who = [review.reviewed_by ? "by " + review.reviewed_by : "", review.reviewed_at ? "on " + fmt(review.reviewed_at) : ""].filter(Boolean).join(" ");
  return '<span class="tag is-decision ' + (REVIEW_TONES[review.decision] || "") + '" title="' + esc("Review decision" + (who ? ", recorded " + who : "")) + '">Decided: ' + esc(label) + "</span>";
}
function reviewRequestLink(review) {
  if (review.pending) return "";
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
    (review.pending ? '<p class="review-pending">Saved in the dashboard. It is copied into the committed review record within about 15 minutes.</p>' : "") +
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
function dateBasis(entry) {
  return entry.basis === "ai" ? "From the AI reading of the change"
    : entry.basis === "spec" ? "From the effective dates of the changed rows in the specification file"
    : entry.basis === "catalog" ? "Stated by the regulator's data dictionary or edit checks (item catalog)"
    : entry.basis === "proposal" ? "Stated on the regulator's form page for these proposed revisions" : "Stated in the text the change added";
}
// Where a calendar entry opens: its change, its items in the Registry, or its day in Cadence.
function calendarEntryTarget(entry) {
  if (entry.event_id) return 'data-select-change="' + esc(entry.event_id) + '"';
  if (Array.isArray(entry.codes) && entry.codes.length) return 'data-select-registry="' + esc("code:" + entry.codes[0]) + '"';
  return 'data-calendar-jump-date="' + esc(entry.date) + '"';
}
// Dates the regulator's documents state (items, proposals) rather than a detected change.
function isStatedDate(item) { return !!item && (item.basis === "catalog" || item.basis === "proposal"); }
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

/* ================= Structured spec changes ================= */

// Rule, field and schema changes row by row (regmon/spec_diff.py): which rules
// are new or retired and from when, which logic changed, which checks became
// blocking, and where the regulator's own annotation disagrees with the change.
const SPEC_ROWS_SHOWN = 40;
const SPEC_GROUP_TONES = { added: "is-added", added_version: "is-added", reinstated: "is-added", removed: "is-removed", retired: "is-removed",
  metadata: "", cosmetic: "" };
const SPEC_FILTERS = [["attention", "Needs attention"], ["mismatch", "Mismatches"], ["all", "Everything"]];
function specTag(entry) {
  const spec = isPlainObject(entry.spec) ? entry.spec : null;
  if (!spec) return "";
  const line = L.describeSpec(spec);
  if (!line) return "";
  return (spec.escalated ? '<span class="tag is-warn" title="' + esc(line) + '">Escalated</span>' : "") +
    '<span class="tag is-rule" title="' + esc(line) + '">' + esc(spec.declared && !Object.keys(spec.counts || {}).length ? "Declared changes" : "Spec changes") + "</span>";
}
function specValueText(change) {
  const values = isPlainObject(change.values) ? change.values : {};
  const main = values.logic || values.message || values.description || values.dtype || "";
  return main;
}
function specColumns(change) {
  const columns = (Array.isArray(change.columns) ? change.columns : []).filter(column => column && column.kind !== "systematic");
  return columns.map(column => '<div class="spec-col"><span class="spec-col-name">' + esc(column.column || "") +
    (column.kind === "cosmetic" ? ' <span class="spec-col-kind">cosmetic</span>' : "") + "</span>" +
    '<span class="item-text">' + L.renderWordEdit(column.before || "", column.after || "") + "</span></div>").join("");
}
function specRow(table, change) {
  const meta = [];
  if (change.severity) {
    const tone = change.severity.direction === "escalated" ? "is-warn" : "";
    meta.push('<span class="tag ' + tone + '">' + esc((change.severity.before || "(blank)") + " → " + (change.severity.after || "(blank)")) +
      (change.severity.direction !== "changed" ? " · " + esc(change.severity.direction) : "") + "</span>");
  }
  if (change.version && table.kind === "rules") meta.push('<span class="tag">' + esc("v" + (change.version.before || "–") + " → v" + (change.version.after || "–")) + "</span>");
  if (change.effective) meta.push('<span class="spec-when">' + esc(change.effective) + (change.quarter && change.effective.indexOf(change.quarter) < 0 ? " (" + esc(change.quarter) + ")" : "") + "</span>");
  if (change.field && change.field !== change.label) meta.push('<span class="spec-field">' + esc(change.field) + "</span>");
  if (change.table && table.kind !== "codes") meta.push('<span class="spec-field">' + esc(change.table) + "</span>");
  (Array.isArray(change.also) ? change.also : []).forEach(name => meta.push('<span class="tag is-older">' + esc(L.specCategoryLabel(table.kind, name)) + "</span>"));
  const body = Array.isArray(change.columns) && change.columns.length ? specColumns(change)
    : (specValueText(change) ? '<span class="item-text">' + esc(specValueText(change)) + "</span>" : "");
  return '<li class="spec-row"><span class="item-code">' + esc(change.label || "") + "</span>" +
    '<div class="spec-main">' + (meta.length ? '<div class="spec-meta">' + meta.join("") + "</div>" : "") + body +
    (change.note ? '<span class="item-assets">' + esc(change.note) + "</span>" : "") +
    (change.declared && !change.mismatch ? '<span class="spec-declared">Declared: ' + esc(change.declared) + "</span>" : "") +
    (change.mismatch ? '<span class="spec-mismatch">' + esc(change.mismatch) + "</span>" : "") + "</div></li>";
}
function specTableBlock(table, filter) {
  const nouns = L.SPEC_KIND_NOUNS[table.kind] || "Table";
  const key = Array.isArray(table.key) && table.key.length ? " · aligned by " + table.key.join(", ") : "";
  const rows = table.table_added ? "new in this version, " + plural(Number(table.rows_after) || 0, "row", "rows")
    : table.table_removed ? "no longer in this version, " + plural(Number(table.rows_before) || 0, "row", "rows")
    : (Number(table.rows_before) || 0).toLocaleString() + " → " + (Number(table.rows_after) || 0).toLocaleString() + " rows";
  const notes = [];
  (Array.isArray(table.patterns) ? table.patterns : []).forEach(pattern => notes.push('<p class="note-strip">' + esc(pattern.column) + ": “" + esc(pattern.from) + "” → “" +
    esc(pattern.to) + "” in " + esc(Number(pattern.rows).toLocaleString()) + " rows. The same edit everywhere, so it is shown once rather than row by row.</p>"));
  const reconciliation = isPlainObject(table.reconciliation) ? table.reconciliation : null;
  if (reconciliation) {
    const bits = [];
    if (reconciliation.changed_not_declared_count) bits.push(plural(reconciliation.changed_not_declared_count, "row changed without being marked as changed", "rows changed without being marked as changed"));
    if (reconciliation.declared_not_changed_count) bits.push(plural(reconciliation.declared_not_changed_count, "row marked new or updated with nothing else changed", "rows marked new or updated with nothing else changed"));
    notes.push('<p class="note-strip is-warning">' + esc(bits.join(" · ")) + ". Check these with the regulator's change log.</p>");
  }
  (Array.isArray(table.warnings) ? table.warnings : []).forEach(warning => notes.push('<p class="note-strip">' + esc(warning) + "</p>"));
  if (table.columns_added && table.columns_added.length) notes.push('<p class="note-strip">New columns: ' + esc(table.columns_added.join(", ")) + "</p>");
  if (table.columns_removed && table.columns_removed.length) notes.push('<p class="note-strip">Columns no longer present: ' + esc(table.columns_removed.join(", ")) + "</p>");
  if (Array.isArray(table.columns_renamed) && table.columns_renamed.length) notes.push('<p class="note-strip">Columns renamed and still compared: ' +
    esc(table.columns_renamed.map(pair => "“" + (pair.before || "") + "” → “" + (pair.after || "") + "”").join(", ")) + "</p>");
  const groups = L.specGroups(table, filter).map(group => '<div class="items-group"><div class="items-group-label ' + (SPEC_GROUP_TONES[group.category] === undefined ? "is-amended" : SPEC_GROUP_TONES[group.category]) + '">' +
    esc(group.label) + " <span>" + esc(filter === "mismatch" ? group.changes.length : (table.counts && table.counts[group.category] || group.changes.length)) + "</span></div>" +
    '<ul class="items-list">' + group.changes.slice(0, SPEC_ROWS_SHOWN).map(change => specRow(table, change)).join("") + "</ul>" +
    (group.changes.length > SPEC_ROWS_SHOWN ? '<p class="note-strip">And ' + esc(group.changes.length - SPEC_ROWS_SHOWN) + " more in the evidence file and the CSV.</p>" : "") + "</div>").join("");
  const empty = !groups && !table.table_added && !table.table_removed
    ? '<p class="note-strip">' + (filter === "mismatch" ? "No mismatches in this table." : "Only metadata or cosmetic changes. Choose Everything to see them.") + "</p>" : "";
  return '<div class="spec-table"><div class="spec-table-head"><span class="spec-table-name">' + esc(table.name || "Table") + "</span>" +
    '<span class="sheet-note">' + esc(nouns + " · " + rows + key) + "</span></div>" + notes.join("") + groups + empty + (table.truncated ? '<p class="note-strip">The list is capped; the counts are complete.</p>' : "") +
    (Number(table.quiet_hidden) > 0 && filter === "all" ? '<p class="note-strip">' + esc(plural(Number(table.quiet_hidden), "further metadata or cosmetic row is", "further metadata or cosmetic rows are")) + " counted but not listed.</p>" : "") + "</div>";
}
// The file's own change log ("Version" sheet) checked claim by claim against
// what the comparison found (regmon/spec_diff.release_notes).
const NOTE_ACTION_WORDS = { added: "Added", retired: "Deprecated", updated: "Updated" };
const NOTE_FOUND_WORDS = { added: "new", added_version: "new version", updated_version: "re-versioned", retired: "retired", removed: "removed",
  logic: "logic changed", severity: "severity changed", message: "message changed", definition: "redefined", description: "description changed",
  effective: "dates changed", reinstated: "reinstated" };
function releaseNotesBlock(notes) {
  if (!isPlainObject(notes) || !Array.isArray(notes.entries) || !notes.entries.length) return "";
  const rows = [];
  notes.entries.forEach(entry => {
    const where = (Array.isArray(entry.tables) && entry.tables.length ? entry.tables.join(", ") : entry.worksheet) || "";
    (Array.isArray(entry.claims) ? entry.claims : []).forEach(claim => {
      const differs = claim.status === "differs";
      const found = claim.status === "unchecked" ? "no table to check against" : "found " + Number(claim.detected || 0).toLocaleString();
      const noun = String(claim.noun || "").replace(/'s$/, "s").replace(/^dpa$/, "DPAs").replace(/^dpas$/, "DPAs");
      rows.push('<li class="spec-row"><span class="item-code">' + esc((NOTE_ACTION_WORDS[claim.action] || claim.action) + " " + Number(claim.count).toLocaleString() + " " + noun) + "</span>" +
        '<div class="spec-main"><div class="spec-meta"><span class="tag ' + (differs ? "is-warn" : "") + '">' + esc(differs ? "Differs · " + found : claim.status === "matches" ? "Matches" : found) + "</span>" +
        (where ? '<span class="spec-field">' + esc(where) + "</span>" : "") + "</div></div></li>");
    });
    if (Number(entry.ids_listed) > 0) {
      const missing = Number(entry.ids_not_changed_count) || 0;
      rows.push('<li class="spec-row"><span class="item-code">' + esc(plural(Number(entry.ids_listed), "listed item", "listed items")) + "</span>" +
        '<div class="spec-main"><div class="spec-meta"><span class="tag ' + (missing ? "is-warn" : "") + '">' + esc(missing ? missing + " not changed as described" : "All changed as described") + "</span>" +
        (where ? '<span class="spec-field">' + esc(where) + "</span>" : "") + "</div>" +
        (missing ? '<span class="spec-mismatch">Listed in the notes but not changed that way in the file: ' + esc((entry.ids_not_changed || []).map(id => id + (entry.ids_found_as && entry.ids_found_as[id] ? " (" + (NOTE_FOUND_WORDS[entry.ids_found_as[id]] || entry.ids_found_as[id]) + ")" : " (unchanged)")).join(", ")) + (missing > (entry.ids_not_changed || []).length ? ", …" : "") + "</span>" : "") +
        "</div></li>");
    }
  });
  (Array.isArray(notes.undocumented) ? notes.undocumented : []).forEach(item => {
    rows.push('<li class="spec-row"><span class="item-code">' + esc(plural(Number(item.count), "unlisted change", "unlisted changes")) + "</span>" +
      '<div class="spec-main"><div class="spec-meta"><span class="tag is-warn">Not in the notes</span><span class="spec-field">' + esc(item.table || "") + "</span></div>" +
      '<span class="spec-mismatch">' + esc((NOTE_ACTION_WORDS[item.action] || item.action) + " in the file but missing from the notes' list: " + (item.labels || []).join(", ") +
        (Number(item.count) > (item.labels || []).length ? ", …" : "")) + "</span></div></li>");
  });
  if (!rows.length) return "";
  const differs = Number(notes.differs) || 0;
  return '<div class="spec-table"><div class="spec-table-head"><span class="spec-table-name">' + esc("Release notes v" + (notes.version || "?")) + "</span>" +
    '<span class="sheet-note">' + esc((notes.date ? notes.date + " · " : "") + (differs ? plural(differs, "point the file does not bear out", "points the file does not bear out") : "every claim matches the file")) + "</span></div>" +
    '<p class="note-strip' + (differs ? " is-warning" : "") + '">The file’s own change log, checked against the rows that actually changed.' + (differs ? " Raise the differences with the regulator before relying on the notes." : "") + "</p>" +
    '<ul class="items-list">' + rows.join("") + "</ul></div>";
}
function specSheet(spec, eventId) {
  const filter = state.specFilter || "attention";
  const tables = Array.isArray(spec.tables) ? spec.tables : [];
  const mismatches = (Number(spec.mismatches) || 0) + (spec.release_notes ? Number(spec.release_notes.differs) || 0 : 0);
  const note = (L.describeSpec({ counts: spec.counts || {}, escalated: spec.escalated, labels: [] }) || "Only metadata or cosmetic changes") +
    " · " + plural(tables.length, "table", "tables") + (mismatches ? " · " + plural(mismatches, "mismatch", "mismatches") : "");
  const filters = '<div class="segmented" role="group" aria-label="Show">' + SPEC_FILTERS.filter(([key]) => key !== "mismatch" || mismatches)
    .map(([key, label]) => '<button type="button" data-spec-filter="' + key + '" aria-pressed="' + String(filter === key) + '">' + label + "</button>").join("") + "</div>";
  return '<section class="sheet" aria-labelledby="change-spec-title"><div class="sheet-head"><div><h3 class="sheet-title" id="change-spec-title">Specification changes</h3>' +
    '<div class="sheet-note">' + esc(note) + "</div></div>" + filters + "</div>" +
    '<div class="items-body">' + (filter !== "mismatch" || (spec.release_notes && spec.release_notes.differs) ? releaseNotesBlock(spec.release_notes) : "") +
    tables.filter(table => filter !== "mismatch" || L.specGroups(table, filter).length).map(table => specTableBlock(table, filter)).join("") + "</div>" +
    '<div class="sheet-foot"><span class="sheet-note">Rows are aligned by their rule or field key, so an inserted row is one new item. Read from the saved texts, the same on every run.</span>' +
    '<button class="sheet-link" type="button" data-spec-csv="' + esc(eventId) + '">Download CSV</button></div></section>';
}
function specInventorySheet(inventory) {
  const tables = (Array.isArray(inventory.tables) ? inventory.tables : []).filter(table => table && table.declared && Object.keys(table.declared).length);
  if (!tables.length) return "";
  const words = { new: "marked new", updated: "marked updated", retired: "marked retired" };
  const totals = inventory.declared || {};
  const note = ["new", "updated", "retired"].filter(key => totals[key]).map(key => totals[key] + " " + words[key]).join(", ");
  const body = tables.map(table => {
    const declared = table.declared || {};
    return '<div class="spec-table"><div class="spec-table-head"><span class="spec-table-name">' + esc(table.name || "Table") + "</span>" +
      '<span class="sheet-note">' + esc((L.SPEC_KIND_NOUNS[table.kind] || "Table") + " · " + Number(table.rows || 0).toLocaleString() + " rows · " +
        ["new", "updated", "retired"].filter(key => declared[key]).map(key => declared[key] + " " + words[key]).join(", ")) + "</span></div>" +
      '<ul class="items-list">' + (Array.isArray(table.items) ? table.items : []).slice(0, SPEC_ROWS_SHOWN).map(item => '<li class="spec-row"><span class="item-code">' + esc(item.label || "") + "</span>" +
        '<div class="spec-main"><div class="spec-meta"><span class="tag ' + (item.action === "retired" ? "" : "is-warn") + '">' + esc(item.declared || "") + "</span>" +
        (item.effective ? '<span class="spec-when">' + esc(item.effective) + "</span>" : "") + "</div></div></li>").join("") + "</ul></div>";
  }).join("");
  return '<section class="sheet" aria-labelledby="change-spec-title"><div class="sheet-head"><div><h3 class="sheet-title" id="change-spec-title">Declared in this file</h3>' +
    '<div class="sheet-note">' + esc(note) + ". The first saved copy has nothing to compare with, so this is what the file says about itself.</div></div></div>" +
    '<div class="items-body">' + body + "</div></section>";
}
async function fillSpecChanges(entry, slotId, stillCurrent) {
  if (!entry.evidence_location || (!isPlainObject(entry.spec) && entry.event_type !== "CHANGED_URL" && entry.event_type !== "NEW_URL")) return;
  let evidence;
  try { evidence = await loadEvidence(entry.evidence_location); } catch (_) { return; }
  const slot = document.getElementById(slotId);
  if (!slot || !stillCurrent()) return;
  if (isPlainObject(evidence.spec_diff) && Array.isArray(evidence.spec_diff.tables) && evidence.spec_diff.tables.length) {
    slot.innerHTML = specSheet(evidence.spec_diff, entry.event_id);
  } else if (isPlainObject(evidence.spec_inventory)) {
    slot.innerHTML = specInventorySheet(evidence.spec_inventory);
  }
}
async function downloadSpecCsv(eventId) {
  const entry = changeById(eventId);
  if (!entry || !entry.evidence_location) { showToast("That change is no longer in the record."); return; }
  try {
    const evidence = await loadEvidence(entry.evidence_location);
    if (!isPlainObject(evidence.spec_diff)) { showToast("This change has no structured spec changes."); return; }
    const rows = L.specCsvRows(evidence.spec_diff);
    downloadFile("changesentinel-spec-" + L.fileSlug(eventTitle(entry), 40) + "-" + String(entry.timestamp || "").slice(0, 10) + ".csv",
      "text/csv;charset=utf-8", "\ufeff" + L.toCsv(rows));
    showToast("Exported " + plural(rows.length - 1, "changed item", "changed items") + ".");
  } catch (error) {
    showToast("Couldn't load the evidence file: " + String(error.message || error));
  }
}

/* ================= Item registry ================= */

// config/registry.json: the regulatory data points reported (MDRM, FR Y-14
// fields, DPM/BIRD, OSFI, SUCAVE, BCB 5050) linked to the tables, models,
// pipelines and code that read them. A change that touches a registered item
// names what it affects; this view browses the registry from either side.
const REGISTRY_UNREGISTERED_SHOWN = 60;
function registryModelNow() { return state.registryModel || L.registryModel(state.registry, state.lineage); }
function registryItems() { return registryModelNow().items; }
function registryItemKey(item) { return "item:" + item.scheme + ":" + L.registryNorm(item.code) + "|" + L.registryNorm(item.form || ""); }
function registryItemByKey(key) { return registryItems().find(item => registryItemKey(item) === key) || null; }
// Every change the record holds, with the codes it is known to have touched.
function registryTouches() {
  const touches = new Map();
  changeLogEntries().forEach(entry => {
    if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0) return;
    L.registryEntryCodes(entry).forEach(code => {
      if (!touches.has(code)) touches.set(code, []);
      touches.get(code).push(entry);
    });
  });
  return touches;
}
function registryUnregistered(touches) {
  const model = registryModelNow();
  return Array.from(touches.entries()).filter(([code]) => !model.byCode.has(code))
    .map(([code, entries]) => ({ code, entries })).sort((a, b) => b.entries.length - a.entries.length || a.code.localeCompare(b.code));
}
function registryKeys() {
  const model = registryModelNow();
  const keys = ["profile", "preflight"];
  if (!model.items.length && !model.consumers.size) keys.push("about");
  model.consumers.forEach((_consumer, id) => keys.push("consumer:" + id));
  model.items.forEach(item => keys.push(registryItemKey(item)));
  registryUnregistered(registryTouches()).slice(0, REGISTRY_UNREGISTERED_SHOWN).forEach(row => keys.push("code:" + row.code));
  ruleTableSources().forEach(source => keys.push("table:" + source.record.url_id));
  if (model.items.length || model.consumers.size) keys.push("about");
  return keys;
}
function consumerItems(id) {
  const model = registryModelNow();
  const direct = model.items.filter(item => (item.consumers || []).indexOf(id) >= 0);
  const rules = model.rules.filter(rule => (rule.consumers || []).indexOf(id) >= 0);
  return { direct, rules };
}
function registryRowTime(entries) {
  const latest = (entries || [])[0];
  return latest ? rowTime(latest.timestamp) : "";
}
function renderRegistry() {
  const list = $("registryItems");
  if (!list) return;
  const model = registryModelNow();
  const touches = registryTouches();
  const query = ($("registrySearch") ? $("registrySearch").value : "").trim().toLowerCase();
  const schemes = Array.from(new Set(model.items.map(item => item.scheme))).sort();
  if (state.registryScheme !== "ALL" && schemes.indexOf(state.registryScheme) < 0) state.registryScheme = "ALL";
  $("registryCount").textContent = model.items.length || model.consumers.size
    ? plural(model.items.length, "item", "items") + " · " + plural(model.consumers.size, "consumer", "consumers") : "Empty";
  const filters = $("registryFilters");
  if (filters) filters.innerHTML = schemes.length > 1 ? ["ALL"].concat(schemes).map(scheme => '<button type="button" data-registry-scheme="' + esc(scheme) + '" aria-pressed="' +
    String(state.registryScheme === scheme) + '">' + esc(scheme === "ALL" ? "All" : scheme) + "</button>").join("") : "";
  const matches = text => !query || String(text || "").toLowerCase().indexOf(query) >= 0;
  const selected = key => (!isCompact() || state.mobileDetail) && state.selectedRegistryKey === key ? ' aria-selected="true" aria-current="true"' : "";
  let html = state.registryScheme === "ALL" && (!query || "entity profile reports filed".indexOf(query) >= 0 || profileSummary(profileNow()).toLowerCase().indexOf(query) >= 0) ? profileRow(selected) : "";
  if (state.registryScheme === "ALL" && (!query || "pre-flight preflight a filing edit checks validity quality call report cdr".indexOf(query) >= 0)) html += preflightRow(selected);
  if (!model.items.length && !model.consumers.size) {
    html += '<button class="row" type="button" data-select-registry="about"' + selected("about") + '><span class="row-mark tone-markup" aria-hidden="true"></span>' +
      '<span class="row-title">Start the registry</span><span class="row-summary">List the items you report and what reads them; changes then name what they affect.</span></button>';
  }
  const consumers = Array.from(model.consumers.values()).filter(consumer => matches(consumer.name + " " + consumer.id + " " + (consumer.owner || "") + " " + (consumer.path || "")));
  if (consumers.length && state.registryScheme === "ALL") {
    html += '<div class="list-group-label">Consumers <span>(' + consumers.length + ")</span></div>" + consumers.map(consumer => {
      const reads = consumerItems(consumer.id);
      const count = reads.direct.length;
      const hit = reads.direct.some(item => touches.has(L.registryNorm(item.code)));
      return '<button class="row" type="button" data-select-registry="consumer:' + esc(consumer.id) + '"' + selected("consumer:" + consumer.id) + ">" +
        '<span class="row-mark ' + (hit ? "tone-change" : "tone-markup") + '" aria-hidden="true"></span><span class="row-title">' + esc(consumer.name) + "</span>" +
        '<span class="row-sub"><span class="tag">' + esc((L.REGISTRY_KIND_NOUNS[consumer.kind] || L.REGISTRY_KIND_NOUNS.other)[0]) + "</span>" +
        '<span class="row-host">' + esc([count || reads.rules.length || !(consumer.implements || []).length ? plural(count, "item", "items") + (reads.rules.length ? " + " + plural(reads.rules.length, "pattern", "patterns") : "") : "",
          (consumer.implements || []).length ? plural(consumer.implements.length, "edit check", "edit checks") : "", consumer.owner].filter(Boolean).join(" · ")) + "</span></span></button>";
    }).join("");
  }
  const groups = new Map();
  model.items.filter(item => state.registryScheme === "ALL" || item.scheme === state.registryScheme)
    .filter(item => matches([item.code, item.label, item.form, item.schedule, item.scheme, item.jurisdiction].concat(item.aliases || []).join(" ")))
    .forEach(item => {
      const where = [item.jurisdiction, item.form || L.REGISTRY_SCHEMES[item.scheme] || item.scheme, item.schedule].filter(Boolean).join(" · ");
      if (!groups.has(where)) groups.set(where, []);
      groups.get(where).push(item);
    });
  groups.forEach((items, where) => {
    html += '<div class="list-group-label">' + esc(where || "Items") + " <span>(" + items.length + ")</span></div>" + items.map(item => {
      const entries = touches.get(L.registryNorm(item.code)) || [];
      const key = registryItemKey(item);
      const consumerCount = new Set((item.consumers || []).concat(L.registryRuleConsumers(model, item.code, item.scheme))).size;
      return '<button class="row" type="button" data-select-registry="' + esc(key) + '"' + selected(key) + ">" +
        '<span class="row-mark ' + (entries.length ? "tone-change" : "tone-markup") + '" aria-hidden="true"></span><span class="row-title is-code">' + esc(item.code) + "</span>" +
        '<span class="row-time">' + esc(registryRowTime(entries)) + "</span>" +
        '<span class="row-sub"><span class="tag">' + esc(item.scheme) + "</span>" + (consumerCount ? '<span class="row-host">' + esc(plural(consumerCount, "consumer", "consumers")) + "</span>" : '<span class="row-host">No consumer mapped</span>') + "</span>" +
        (item.label ? '<span class="row-summary">' + esc(item.label) + "</span>" : "") + "</button>";
    }).join("");
  });
  const unregistered = registryUnregistered(touches).filter(row => matches(row.code)).slice(0, REGISTRY_UNREGISTERED_SHOWN);
  if (unregistered.length && state.registryScheme === "ALL") {
    html += '<div class="list-group-label">Seen in changes, not registered <span>(' + unregistered.length + ")</span></div>" + unregistered.map(row =>
      '<button class="row" type="button" data-select-registry="code:' + esc(row.code) + '"' + selected("code:" + row.code) + ">" +
      '<span class="row-mark tone-markup" aria-hidden="true"></span><span class="row-title is-code">' + esc(row.code) + "</span>" +
      '<span class="row-time">' + esc(registryRowTime(row.entries)) + '</span><span class="row-sub"><span class="row-host">' + esc(plural(row.entries.length, "change", "changes")) + "</span></span></button>").join("");
  }
  const tables = ruleTableSources().filter(source => matches(source.title + " " + source.record.canonical_url));
  if (tables.length && state.registryScheme === "ALL") {
    html += '<div class="list-group-label">Rule tables read from PDFs <span>(' + tables.length + ")</span></div>" + tables.map(source => {
      const key = "table:" + source.record.url_id;
      const summary = source.summary;
      return '<button class="row" type="button" data-select-registry="' + esc(key) + '"' + selected(key) + '><span class="row-mark tone-markup" aria-hidden="true"></span>' +
        '<span class="row-title">' + esc(source.title) + "</span>" +
        '<span class="row-sub"><span class="tag">' + esc(plural(Number(summary.rows) || 0, "row", "rows")) + '</span><span class="row-host">' +
        esc(plural(Number(summary.codes) || 0, "code", "codes") + " · " + displayUrl(source.record.canonical_url).split("/")[0]) + "</span></span></button>";
    }).join("");
  }
  if (model.items.length || model.consumers.size) {
    html += '<button class="row" type="button" data-select-registry="about"' + selected("about") + '><span class="row-mark tone-markup" aria-hidden="true"></span>' +
      '<span class="row-title">How the registry works</span><span class="row-summary">Editing it, CSV import and what a change says.</span></button>';
  }
  const looked = L.catalogCode(query);
  if (looked && !model.byCode.get(looked) && !touches.get(looked)) {
    html = '<div class="list-group-label">Item catalog</div><button class="row" type="button" data-select-registry="code:' + esc(looked) + '"' + selected("code:" + looked) + ">" +
      '<span class="row-mark tone-markup" aria-hidden="true"></span><span class="row-title is-code">' + esc(looked) + "</span>" +
      '<span class="row-summary">What the regulator\'s documents say it is, version by version.</span></button>' + html;
  }
  if (!html) html = emptyState("Nothing matches", "Try another search or scheme.");
  if (list.dataset.rendered !== html) { list.innerHTML = html; list.dataset.rendered = html; }
}
function registryChangesSheet(entries, title) {
  if (!entries.length) {
    return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">' + esc(title) + '</h3></div><p class="note-strip">No recorded change has named it yet. Changes are matched by reporting-item code, spec field and the codes on changed lines.</p></section>';
  }
  return '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">' + esc(title) + '</h3><div class="sheet-note">' + esc(plural(entries.length, "change", "changes")) + " in the record</div></div></div>" +
    '<div class="registry-changes">' + entries.slice(0, 30).map(entry => changeRow(entry, { compact: true })).join("") + "</div></section>";
}
function consumerLine(consumer, codes) {
  const link = L.registryConsumerLink(consumer);
  const nouns = L.REGISTRY_KIND_NOUNS[consumer.kind] || L.REGISTRY_KIND_NOUNS.other;
  return '<li class="registry-consumer"><span class="tag">' + esc(nouns[0]) + "</span>" +
    '<span class="registry-consumer-name">' + (link ? '<a class="detail-url" href="' + esc(safeHttpUrl(link)) + '" target="_blank" rel="noopener noreferrer"><span>' + esc(consumer.name) + "</span>" + icon("external") + "</a>" :
      '<button class="text-button" type="button" data-select-registry="consumer:' + esc(consumer.id) + '">' + esc(consumer.name) + "</button>") + "</span>" +
    '<span class="registry-consumer-meta">' + esc([consumer.owner, consumer.system, consumer.repo && consumer.path ? consumer.repo + "/" + consumer.path : consumer.path].filter(Boolean).join(" · ")) + "</span>" +
    (codes && codes.length ? '<span class="registry-codes">' + codes.slice(0, 12).map(code => '<span class="item-asset">' + esc(code) + "</span>").join(" ") + (codes.length > 12 ? " …" : "") + "</span>" : "") + "</li>";
}
function registryStarter() {
  const unregistered = registryUnregistered(registryTouches()).slice(0, 12);
  return JSON.stringify({
    schema_version: 1,
    consumers: [{ id: "example-pipeline", kind: "pipeline", name: "Example load pipeline", owner: "Regulatory Reporting", repo: "your-org/your-repo", path: "pipelines/example.py" }],
    items: (unregistered.length ? unregistered : [{ code: "BHCK2170" }]).map(row => ({ code: row.code, scheme: /^[A-Z]{4}[A-Z0-9]{4}$/.test(row.code) ? "MDRM" : "OTHER",
      form: "", schedule: "", label: "", consumers: ["example-pipeline"] })),
    rules: []
  }, null, 2);
}
async function copyRegistryStarter() {
  const text = registryStarter();
  try { await navigator.clipboard.writeText(text); showToast("Starter registry copied. Paste it into config/registry.json and fill in the details."); }
  catch (_) { window.prompt("Copy the starter registry:", text); }
}
function renderRegistryDetail() {
  state.detailKeys.registry = detailRenderKey("registry");
  const pane = $("registryDetail");
  if (!pane) return;
  const model = registryModelNow();
  const key = state.selectedRegistryKey || "about";
  const touches = registryTouches();
  const fileLink = externalLink(REPO + "/blob/main/config/registry.json", "config/registry.json", "btn");
  if (key === "profile") {
    pane.innerHTML = profileDetail();
    fillProfileProposals();
    return;
  }
  if (key === "preflight") return preflightDetail(pane);
  if (key === "about") {
    const unregistered = registryUnregistered(touches);
    pane.innerHTML = '<div class="detail-inner">' + detailHeading({ back: true, source: "Registry", title: "Items you report, and what reads them",
        actions: '<button class="btn btn-primary" type="button" data-registry-add>Add to registry</button><button class="btn" type="button" data-registry-import>Import a mapping</button>' + fileLink + '<button class="btn" type="button" data-registry-copy>Copy a starter file</button>' }) +
      ruleTablesSheet() +
      '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">What it does</h3></div><div class="registry-copy">' +
      "<p>Each item is a regulatory data point you report: an MDRM such as BHCK2170, an FR Y-14 field, an EBA DPM data point or BIRD variable, an OSFI DPA, a SUCAVE code or a BCB 5050 account. Link it to the tables, models, pipelines and code paths that read it.</p>" +
      "<p>When a change adds, retires or redefines a registered item (from the reporting-item codes, the specification changes, or a code named on a changed line), the change and its alert say so in one sentence: which fields in which form and schedule change, from which quarter, and what reads them. Equivalent items in other jurisdictions are listed alongside.</p>" +
      "<p><strong>Add to registry</strong> prefills from a report template (config/registry-templates.json: scheme, regulator, form, schedules and code prefixes per report) and opens a request on GitHub; the registry-update workflow merges it and validates the whole file. A rule table the scan read from a PDF can add every code it names in one request.</p>" +
      "<p><strong>Import a mapping</strong> reads a spreadsheet of codes and what reads them (CSV, TSV or XLSX; one row per item and consumer, columns found by header) in this browser and sends it as one request, however many rows it has. The same file merges from the command line with <span class=\"is-code\">python -m regmon.registry import mapping.csv --write</span>. You can also edit <span class=\"is-code\">config/registry.json</span> directly; <span class=\"is-code\">python -m regmon.registry check</span> validates it, and CI runs the same check. Mappings in config/lineage.json are still read.</p>" +
      "<p>A consumer can also list the regulator's edit checks it implements (<span class=\"is-code\">FR Y-9C | 0303</span>), in its editor or with an Edit check column in a mapping. A change that retires or alters one of them, or adds a rule to a form you track, then shows under <strong>Your checks</strong>; one that no longer exists in the form's current specification is marked on the consumer.</p>" +
      "<p>To find what reads your items, run <span class=\"is-code\">python -m regmon.find_consumers path/to/repo --out mapping.csv</span> on your own machine: every SQL table and view, dbt model, check, pipeline and script that names an MDRM code (<span class=\"is-code\">RCON2170</span>, <span class=\"is-code\">rcon_2170</span>) becomes a consumer row, ready to import.</p></div></section>" +
      (unregistered.length ? '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Seen in changes, not registered</h3><div class="sheet-note">Codes recorded changes touched that the registry does not list yet. The starter file includes the first twelve.</div></div></div>' +
        '<div class="registry-unregistered">' + unregistered.slice(0, 40).map(row => '<button class="chip" type="button" data-select-registry="code:' + esc(row.code) + '">' + esc(row.code) + " · " + esc(row.entries.length) + "</button>").join("") + "</div></section>" : "") +
      "</div>";
    return;
  }
  if (key.indexOf("consumer:") === 0) {
    const id = key.slice(9);
    const consumer = model.consumers.get(id);
    if (!consumer) { pane.innerHTML = '<div class="detail-inner">' + emptyState("Not in the registry", "This consumer is no longer listed.") + "</div>"; return; }
    const reads = consumerItems(id);
    const entries = [];
    const seen = new Set();
    reads.direct.forEach(item => (touches.get(L.registryNorm(item.code)) || []).forEach(entry => { if (!seen.has(entry.event_id)) { seen.add(entry.event_id); entries.push(entry); } }));
    touches.forEach((list, code) => {
      if (!reads.rules.some(rule => new RegExp("^" + L.registryNorm(rule.match).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(code))) return;
      list.forEach(entry => { if (!seen.has(entry.event_id)) { seen.add(entry.event_id); entries.push(entry); } });
    });
    entries.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    const link = L.registryConsumerLink(consumer);
    const facts = [["Kind", (L.REGISTRY_KIND_NOUNS[consumer.kind] || L.REGISTRY_KIND_NOUNS.other)[0]], ["Owner", consumer.owner], ["System", consumer.system],
      ["Repository", consumer.repo], ["Path", consumer.path], ["Note", consumer.note]].filter(([, value]) => value);
    pane.innerHTML = '<div class="detail-inner">' + detailHeading({ back: true, source: "Consumer", title: consumer.name,
        actions: '<button class="btn" type="button" data-registry-add data-registry-consumer="' + esc(id) + '">Map items to it</button>' +
          '<button class="btn" type="button" data-registry-edit-consumer="' + esc(id) + '">Edit</button>' + (link ? externalLink(link, consumer.repo ? "Open the code" : "Open", "btn") : "") }) +
      '<section class="sheet"><dl class="facts">' + facts.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl></section>" +
      '<div id="registryControls">' + consumerControlsSheet(consumer) + "</div>" +
      '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">What it reads</h3><div class="sheet-note">' + esc(plural(reads.direct.length, "registered item", "registered items") +
        (reads.rules.length ? " and every item matching " + reads.rules.map(rule => rule.match).join(", ") : "")) + "</div></div></div>" +
      '<ul class="items-list">' + reads.direct.slice(0, 200).map(item => '<li class="item-row"><button class="text-button item-code" type="button" data-select-registry="' + esc(registryItemKey(item)) + '">' + esc(item.code) + "</button>" +
        '<span class="item-text">' + esc([item.label, [item.form, item.schedule].filter(Boolean).join(" ")].filter(Boolean).join(" · ")) + "</span></li>").join("") + "</ul></section>" +
      registryChangesSheet(entries, "Changes that touched what it reads") + "</div>";
    if (!state.ruleIndex && (consumer.implements || []).length) {
      loadRuleIndex().then(() => {
        const slot = document.getElementById("registryControls");
        if (slot && state.view === "registry" && state.selectedRegistryKey === key) slot.innerHTML = consumerControlsSheet(model.consumers.get(id) || consumer);
      });
    }
    return;
  }
  if (key.indexOf("code:") === 0) {
    const code = key.slice(5);
    const entries = touches.get(code) || [];
    const guess = L.registryTemplateForCode(code, registryTemplateList());
    pane.innerHTML = '<div class="detail-inner">' + detailHeading({ back: true, source: "Not registered" + (guess ? " · " + guess.name : ""), title: code,
        actions: '<button class="btn btn-primary" type="button" data-registry-add data-registry-code="' + esc(code) + '">Register it</button>' }) +
      '<section class="sheet"><p class="note-strip">' + esc(entries.length ? "Recorded changes touched this code, but the registry does not list it, so they cannot say what reads it." :
        "The registry does not list this code yet.") + " Register it with its form, schedule and what reads it." + "</p></section>" +
      '<div id="registryCatalog"></div><div id="registryProposals"></div><div id="registryChecks"></div>' + registryChangesSheet(entries, "Changes that touched it") + "</div>";
    fillCatalog(code, key);
    fillRuleChecks(code, key);
    return;
  }
  if (key.indexOf("table:") === 0) {
    renderRuleTableDetail(pane, key.slice(6));
    return;
  }
  const item = registryItemByKey(key);
  if (!item) { pane.innerHTML = '<div class="detail-inner">' + emptyState("Not in the registry", "This item is no longer listed.") + "</div>"; return; }
  const resolved = L.registryImpact([{ code: item.code, change: "amended" }], model, "");
  const consumers = resolved ? resolved.consumers : [];
  const facts = [["Scheme", L.REGISTRY_SCHEMES[item.scheme] || item.scheme], ["Jurisdiction", item.jurisdiction], ["Regulator", item.regulator], ["Form", item.form],
    ["Schedule", item.schedule], ["Line", item.line], ["Aliases", (item.aliases || []).join(", ")], ["Owner", item.owner], ["Note", item.note]].filter(([, value]) => value);
  const equivalents = (item.equivalents || []).map(equivalent => {
    const code = String(equivalent).replace(/^[A-Z0-9_]+:/, "");
    const match = model.byCode.get(L.registryNorm(code)) || model.byCode.get(L.registryNorm(equivalent));
    return match && match.length ? '<button class="chip" type="button" data-select-registry="' + esc(registryItemKey(match[0])) + '">' + esc(equivalent) + "</button>" : '<span class="chip is-static">' + esc(equivalent) + "</span>";
  }).join("");
  pane.innerHTML = '<div class="detail-inner">' + detailHeading({ back: true, source: [L.REGISTRY_SCHEMES[item.scheme] || item.scheme, item.jurisdiction].filter(Boolean).join(" · "),
      title: item.code, subtitle: item.label || "", actions: '<button class="btn" type="button" data-registry-edit="' + esc(key) + '">Edit</button>' }) +
    '<section class="sheet"><dl class="facts">' + facts.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl></section>" +
    '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">What reads it</h3><div class="sheet-note">' + esc(consumers.length ? plural(consumers.length, "consumer", "consumers") : "No consumer is mapped yet") + "</div></div></div>" +
    (consumers.length ? '<ul class="items-list">' + consumers.map(consumer => consumerLine(consumer, [])).join("") + "</ul>" : '<p class="note-strip">Add consumer ids to this item, or a rule whose pattern matches it.</p>') + "</section>" +
    (equivalents ? '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Equivalent items elsewhere</h3><div class="sheet-note">The same data point under another regulator\'s scheme</div></div></div><div class="registry-unregistered">' + equivalents + "</div></section>" : "") +
    '<div id="registryCatalog"></div><div id="registryProposals"></div><div id="registryChecks"></div>' + registryChangesSheet(touches.get(L.registryNorm(item.code)) || [], "Changes that touched it") + "</div>";
  fillCatalog(item.code, key, item.form ? [item.form] : []);
  fillRuleChecks(item.code, key);
}
/* ================= Rule tables and registry requests ================= */

// Rule and field tables the scan read row by row from PDFs (regmon/pdf_tables.py),
// saved content-addressed in data/rule-tables/ and pointed at by the inventory.
// They are large, so each is fetched once, and only when a registry pane needs it.
const RULE_CHECKS_SHOWN = 12;
function registryTemplateList() { return L.registryTemplates(state.registryTemplates); }
function ruleTableSources() {
  const groups = (state.inventory && state.inventory.sources) || {};
  const out = [];
  Object.keys(groups).forEach(sourceId => Object.values(groups[sourceId] || {}).forEach(record => {
    const tables = record && record.rule_tables;
    const location = tables && tables.rule_tables_location;
    if (!location || record.active === false || !/^data\/rule-tables\/[A-Za-z0-9_.-]+\.json$/.test(location)) return;
    out.push({ record, location, summary: tables, title: itemTitle(record) });
  }));
  return out.sort((a, b) => (Number(b.summary.rows) || 0) - (Number(a.summary.rows) || 0));
}
function ruleTableSource(urlId) { return ruleTableSources().find(source => source.record.url_id === urlId) || null; }
function loadRuleTable(location) {
  const cached = state.ruleTables.get(location);
  if (cached) return cached;
  const promise = fetchImmutable(location).then(response => {
    if (!response.ok) throw new Error("Rule table request returned HTTP " + response.status);
    return response.json();
  }).then(L.ruleTableIndex).catch(error => { state.ruleTables.delete(location); throw error; });
  state.ruleTables.set(location, promise);
  return promise;
}
// The report a rule table belongs to: the template most of its row codes match.
function ruleTableTemplate(index) {
  const templates = registryTemplateList();
  const votes = new Map();
  index.byField.forEach((_rows, code) => {
    const template = L.registryTemplateForCode(code, templates);
    if (template) votes.set(template.id, (votes.get(template.id) || 0) + 1);
  });
  let best = "", count = 0;
  votes.forEach((value, id) => { if (value > count) { best = id; count = value; } });
  return templates.find(template => template.id === best) || null;
}
function rulePageLink(source, page) {
  const url = safeHttpUrl(source.record.canonical_url);
  if (!url || !page) return "";
  return '<a class="sheet-link" href="' + esc(url.split("#")[0] + "#page=" + Number(page)) + '" target="_blank" rel="noopener noreferrer" title="Open the regulator\'s PDF at this page">p. ' + esc(page) + icon("external") + "</a>";
}
// Codes in an edit's logic become links into the registry; the one being viewed is marked.
function ruleLogicHtml(logic, current) {
  const model = registryModelNow();
  return String(logic || "").split(/\b([A-Za-z]{4}[A-Za-z0-9]{4})\b/).map((part, index) => {
    if (index % 2 === 0) return esc(part);
    const code = L.registryNorm(part);
    if (!/[0-9]/.test(code)) return esc(part);
    if (current && code === L.registryNorm(current)) return "<mark>" + esc(part) + "</mark>";
    const items = model.byCode.get(code);
    return '<button class="text-button" type="button" data-select-registry="' + esc(items && items.length ? registryItemKey(items[0]) : "code:" + code) + '">' + esc(part) + "</button>";
  }).join("");
}
function ruleCheckRow(row, source, current) {
  const start = L.ruleCheckDate(row.start), end = L.ruleCheckDate(row.end);
  const when = start ? (end ? start + " – " + end : "From " + start) : (end ? "Until " + end : "");
  const status = String(row.status || "").trim();
  const place = [row.table, row.line_item].filter(Boolean).join(" · ");
  const defects = (Array.isArray(row.defects) ? row.defects : []).map(defect => L.RULE_DEFECT_WORDS[defect.kind] || String(defect.kind || ""));
  const onItem = row.field && L.registryNorm(row.field) !== L.registryNorm(current || "");
  return '<li class="spec-row"><span class="item-code">' + esc(L.ruleCheckName(row)) + '</span><span class="spec-main"><span class="spec-meta">' +
    (status && !/^no change$/i.test(status) ? '<span class="tag is-warn">' + esc(status) + "</span>" : "") +
    (place ? '<span class="spec-field">' + esc(place) + "</span>" : "") + (when ? '<span class="spec-when">' + esc(when) + "</span>" : "") + rulePageLink(source, row.page) + "</span>" +
    (onItem ? '<span class="spec-col"><span class="spec-col-name">On item</span><span class="rule-logic">' + ruleLogicHtml(row.field, current) + "</span></span>" : "") +
    (row.message ? '<span class="spec-col"><span class="spec-col-name">Test</span><span>' + esc(row.message) + "</span></span>" : "") +
    (row.logic ? '<span class="spec-col"><span class="spec-col-name">Logic</span><span class="rule-logic">' + ruleLogicHtml(row.logic, current) + "</span></span>" : "") +
    (defects.length ? '<span class="spec-declared">As printed in the PDF: ' + esc(defects.join("; ")) + "</span>" : "") + "</span></li>";
}
function ruleChecksSection(label, rows, source, current, tone) {
  if (!rows.length) return "";
  return '<div class="items-group"><div class="items-group-label' + (tone ? " " + tone : "") + '">' + esc(label) + " <span>" + esc(rows.length) + "</span></div>" +
    '<ul class="items-list">' + rows.slice(0, RULE_CHECKS_SHOWN).map(row => ruleCheckRow(row, source, current)).join("") + "</ul>" +
    (rows.length > RULE_CHECKS_SHOWN ? '<p class="note-strip">' + esc(plural(rows.length - RULE_CHECKS_SHOWN, "more row", "more rows")) + " in this table.</p>" : "") + "</div>";
}
// "Edit checks" on an item or code: rows about it, and rows whose logic reads it.
async function fillRuleChecks(code, key) {
  const sources = ruleTableSources();
  if (!sources.length) return;
  const norm = L.registryNorm(code);
  const results = await Promise.all(sources.map(source => loadRuleTable(source.location).then(index => ({ source, index })).catch(() => null)));
  const slot = document.getElementById("registryChecks");
  if (!slot || state.view !== "registry" || (state.selectedRegistryKey || "about") !== key) return;
  slot.innerHTML = results.filter(Boolean).map(({ source, index }) => {
    const about = index.byField.get(norm) || [];
    const reads = (index.byRead.get(norm) || []).filter(row => L.registryNorm(row.field) !== norm);
    if (!about.length && !reads.length) return "";
    return '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Edit checks</h3><div class="sheet-note">' +
      esc("From " + source.title + ", read row by row by the last scan") + '</div></div><button class="sheet-link" type="button" data-select-registry="table:' + esc(source.record.url_id) + '">The whole table</button></div>' +
      ruleChecksSection("Checks on this item", about, source, code, "is-amended") + ruleChecksSection("Other checks that read it", reads, source, code, "") + "</section>";
  }).join("");
}
/* ---------- Item catalog: what the regulator says the item is, version by version ---------- */
const CATALOG_HISTORY_SHOWN = 30;
const CATALOG_TEXT_CAP = 600;  // regmon/catalog.py MAX_TEXT: longer wording is cut there
// One series file (data/items/BHCK.json) per session; it changes only when a scan
// reads a changed document. Pages first, then the repository; a 404 means the
// catalog has no item of that series.
function loadCatalogSeries(series) {
  const cached = state.catalogSeries.get(series);
  if (cached) return cached;
  const path = "data/items/" + series + ".json";
  const promise = (async () => {
    let missing = 0;
    for (const url of [new URL("./" + path, document.baseURI).href, bust(RAW + "/" + path)]) {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (response.status === 404) { missing += 1; continue; }
        if (!response.ok) continue;
        const doc = await response.json();
        if (doc && doc.items && doc.facets) return doc;
      } catch (_) { /* next copy */ }
    }
    if (missing) return null;
    throw new Error("The item catalog could not be loaded");
  })().catch(error => { state.catalogSeries.delete(series); throw error; });
  state.catalogSeries.set(series, promise);
  return promise;
}
function catalogSourceLink(url, document, attrs) {
  const safe = safeHttpUrl(url);
  if (!safe) return "";
  const page = attrs && Array.isArray(attrs.pages) && attrs.pages.length ? Number(attrs.pages[0]) : 0;
  const label = page ? "p. " + page : "Source";
  return '<a class="sheet-link" href="' + esc(safe.split("#")[0] + (page ? "#page=" + page : "")) + '" target="_blank" rel="noopener noreferrer" title="' +
    esc((document ? document + " · " : "") + displayUrl(safe)) + '">' + esc(label) + icon("external") + "</a>";
}
// The monitored document's own title (a Fed "DownloadAttachment?guid=…" reads as its form's name).
function catalogTitle(url) {
  const groups = (state.inventory && state.inventory.sources) || {};
  for (const sourceId of Object.keys(groups)) {
    for (const record of Object.values(groups[sourceId] || {})) {
      if (record && record.canonical_url === url) return itemTitle(record);
    }
  }
  return "";
}
// "FFIEC 031 Call Report Taxonomy (CDR) · concepts.xsd": the monitor's title, then the file inside it.
function catalogDocument(entry) {
  const title = catalogTitle(entry.url);
  const parts = [title, entry.document].filter(Boolean).filter((part, index, list) => list.indexOf(part) === index);
  const name = parts.join(" · ") || displayUrl(entry.url).split("/").pop() || displayUrl(entry.url);
  return '<span class="spec-source" title="' + esc(displayUrl(entry.url)) + '">' + esc(name) + "</span>";
}
function catalogFactCols(attrs, names) {
  return L.catalogFacts(attrs).filter(([, , name]) => name !== "pages" && (!names || names.indexOf(name) >= 0))
    .map(([label, value, name]) => '<span class="spec-col"><span class="spec-col-name">' + esc(label) + "</span><span" +
      (name === "checked_by" || name === "read_by_sample" ? ' class="rule-logic"' : "") + ">" + esc(value) +
      (value.length >= CATALOG_TEXT_CAP ? "…" : "") + "</span></span>").join("");
}
function catalogChangeCols(entry) {
  return (entry.changed || []).map(name => {
    const label = (L.CATALOG_ATTRS.find(([key]) => key === name) || [name, name.replace(/_/g, " ")])[1];
    const facts = attrs => (L.catalogFacts(attrs).find(([, , key]) => key === name) || [])[1] || "";
    const before = facts(entry.before), after = facts(entry.attrs);
    // A short value replaced whole (HI-3 → HI-4) reads better as old, then new.
    const whole = before && after && !/\s/.test(before) && !/\s/.test(after);
    const text = whole ? "<del>" + esc(before) + "</del> <ins>" + esc(after) + "</ins>" :
      before && after ? L.renderWordEdit(before, after) : (before ? "<del>" + esc(before) + "</del>" : "<ins>" + esc(after) + "</ins>");
    return '<span class="spec-col"><span class="spec-col-name">' + esc(label) + '</span><span class="item-text">' + text + "</span></span>";
  }).join("");
}
function catalogEntryTone(entry) {
  if (entry.status === "absent") return "tone-problem";
  if (entry.status === "proposed") return "is-warn";
  return entry.first ? "tone-new" : "tone-change";
}
function catalogSheet(item) {
  const noun = kind => L.CATALOG_KIND_NOUNS[kind] || kind || "Document";
  const effective = item.effective;
  const applies = [
    ["Applies from", effective.from ? L.catalogDate(effective.from) + (effective.firstQuarter ? " · " + effective.firstQuarter : "") : ""],
    ["Applies to", effective.to ? (L.catalogDate(effective.to) ? L.catalogDate(effective.to) + (effective.lastQuarter ? " · " + effective.lastQuarter : "") : "Open-ended") : ""],
    ["Dates from", (effective.basis || []).map(noun).join(", ") + (effective.proposed ? " (proposed)" : "")],
    ["Taxonomy report date", effective.reportDate ? L.catalogDate(effective.reportDate) : ""]].filter(([, value]) => value);
  const documents = new Set(item.timeline.map(entry => entry.url).filter(Boolean)).size;
  // Dictionary first, then checklists, edit checks and schemas; within a kind, by document.
  const kindOrder = { dictionary: 0, checklist: 1, edits: 2, schema: 3 };
  const docKey = facet => (catalogTitle(facet.url) + " " + (facet.document || "")).toLowerCase();
  const current = item.current.slice().sort((a, b) => ((kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9)) || docKey(a).localeCompare(docKey(b)));
  const now = current.map(facet => '<li class="spec-row"><span class="item-label">' + esc(noun(facet.kind)) + '</span><span class="spec-main"><span class="spec-meta">' +
      (facet.status === "proposed" ? '<span class="tag is-warn">Proposed</span>' : "") + catalogDocument(facet) +
      '<span class="spec-when">' + esc("Since " + L.catalogDate(String(facet.since || "").slice(0, 10))) + "</span>" +
      catalogSourceLink(facet.url, facet.document, facet.attrs) + "</span>" + catalogFactCols(facet.attrs) +
      (facet.firstUrl ? '<span class="spec-declared">' + esc("Said the same since an earlier edition: " + displayUrl(facet.firstUrl).split("/").pop()) + "</span>" : "") +
      "</span></li>").join("");
  const timeline = item.timeline.slice().sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")) ||
    ((kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9)) || docKey(a).localeCompare(docKey(b)));
  const history = timeline.slice(0, CATALOG_HISTORY_SHOWN).map(entry => '<li class="spec-row"><span class="item-date">' +
      esc(L.catalogDate(String(entry.at || "").slice(0, 10))) + '</span><span class="spec-main"><span class="spec-meta">' +
      '<span class="tag ' + catalogEntryTone(entry) + (entry.superseded ? " is-older" : "") + '">' + esc(L.catalogEntryLabel(entry)) + "</span>" +
      '<span class="spec-when">' + esc(noun(entry.kind)) + "</span>" + catalogDocument(entry) + catalogSourceLink(entry.url, entry.document, entry.attrs) + "</span>" +
      (entry.changed ? catalogChangeCols(entry) :
        entry.first && entry.superseded ? catalogFactCols(entry.attrs, ["name", "schedule", "line", "type", "checked_by"]) : "") +
      (entry.reread ? '<span class="spec-declared">' + esc("Read again " + L.catalogDate(String(entry.reread).slice(0, 10)) + " with an improved reader; the document itself did not change") + "</span>" : "") +
      "</span></li>").join("");
  return '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">What the regulator says</h3><div class="sheet-note">' +
      esc("From " + plural(documents, "monitored document", "monitored documents") + ", in the regulator's own words. A version is added only when a document changes what it says.") + "</div></div></div>" +
    (applies.length ? '<dl class="facts">' + applies.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl>" : "") +
    (now ? '<div class="items-group"><div class="items-group-label is-amended">Now <span>' + esc(item.current.length) + '</span></div><ul class="items-list">' + now + "</ul></div>" :
      '<p class="note-strip">No monitored document lists this item any more.</p>') +
    '<div class="items-group"><div class="items-group-label">History <span>' + esc(item.timeline.length) + '</span></div><ul class="items-list">' + history + "</ul>" +
    (item.timeline.length > CATALOG_HISTORY_SHOWN ? '<p class="note-strip">' + esc(plural(item.timeline.length - CATALOG_HISTORY_SHOWN, "older version", "older versions")) + " in data/items/" + esc(item.series) + ".json.</p>" : "") +
    "</div></section>";
}
async function fillCatalog(code, key, forms) {
  const norm = L.catalogCode(code);
  const slot = document.getElementById("registryCatalog");
  if (!slot || !norm) { fillProposals(null, L.catalogForms({ code: L.registryNorm(code), current: [] }, registryTemplateList(), forms), key); return; }
  const still = () => document.getElementById("registryCatalog") === slot && state.view === "registry" && (state.selectedRegistryKey || "about") === key;
  slot.innerHTML = '<section class="sheet"><p class="note-strip">Reading the item catalog…</p></section>';
  let doc;
  try { doc = await loadCatalogSeries(norm.slice(0, 4)); } catch (error) {
    if (still()) slot.innerHTML = '<section class="sheet"><p class="note-strip">' + esc(error.message) + ". It is retried the next time this item opens.</p></section>";
    return;
  }
  if (!still()) return;
  const item = doc ? L.catalogItem(doc, norm) : null;
  slot.innerHTML = item ? catalogSheet(item) : '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">What the regulator says</h3></div>' +
    '<p class="note-strip">No monitored data dictionary, taxonomy or edit file defines this code yet. Monitor the MDRM dictionary or the form\'s edits to add it.</p></section>';
  fillProposals(item, L.catalogForms(item || { code: norm, current: [] }, registryTemplateList(), forms), key);
}

/* ---------- Pre-flight: the CDR's edit checks on a filing, before it is due ---------- */
// data/edits/index.json lists the edit sets by form; one set (about 1 MB) loads when chosen.
// The filing is read in this browser and never sent anywhere.
const PREFLIGHT_SHOWN = 40;
const PREFLIGHT_FORMULA_SHOWN = 240;
function preflightState() {
  if (!state.preflight) state.preflight = { form: "", set: "", compare: "", reportDate: "", file: null, result: null, error: "", running: false };
  if (!state.preflightFiles) state.preflightFiles = new Map();
  return state.preflight;
}
function loadPreflightFile(path, accept) {
  preflightState();
  const cached = state.preflightFiles.get(path);
  if (cached) return cached;
  const promise = (async () => {
    let missing = 0;
    for (const url of [new URL("./" + path, document.baseURI).href, bust(RAW + "/" + path)]) {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (response.status === 404) { missing += 1; continue; }
        if (!response.ok) continue;
        const payload = await response.json();
        if (accept(payload)) return payload;
      } catch (_) { /* next copy */ }
    }
    if (missing) return null;
    throw new Error("The edit checks could not be loaded");
  })().catch(error => { state.preflightFiles.delete(path); throw error; });
  state.preflightFiles.set(path, promise);
  return promise;
}
const loadPreflightIndex = () => loadPreflightFile("data/edits/index.json", payload => payload && payload.forms);
const loadPreflightSet = file => loadPreflightFile(file, payload => payload && Array.isArray(payload.edits));
function preflightRow(selected) {
  return '<div class="list-group-label">Pre-flight</div><button class="row" type="button" data-select-registry="preflight"' + selected("preflight") + ">" +
    '<span class="row-mark ' + (state.preflight && state.preflight.result ? "tone-new" : "tone-markup") + '" aria-hidden="true"></span><span class="row-title">Pre-flight a filing</span>' +
    '<span class="row-summary">The CDR\'s edit checks on your Call Report, before it is due</span></button>';
}
function preflightRerender() {
  if (state.view === "registry" && state.selectedRegistryKey === "preflight") renderRegistryDetail();
}
function preflightDefaultForm(forms) {
  const profile = profileNow();
  if (L.hasProfile(profile)) {
    const files = forms.find(form => L.assessReportStatus(form, profile, state.reportLibrary).status === "files");
    if (files) return files;
  }
  return forms.indexOf("FFIEC 041") >= 0 ? "FFIEC 041" : forms[0] || "";
}
function preflightSetLabel(version) {
  return L.catalogDate(version.date) + (version.version ? " · v" + version.version : "");
}
function preflightSetCounts(version) {
  const counts = (version && version.counts) || {};
  return Object.keys(counts).sort().reverse().map(type => counts[type].toLocaleString() + " " + type).join(", ");
}
function preflightField(id, label, control, note) {
  return '<div class="preflight-field"><label class="field-label-text" for="' + id + '">' + esc(label) + "</label>" + control +
    (note ? '<span class="preflight-note">' + esc(note) + "</span>" : "") + "</div>";
}
function preflightRowHtml(row, edit, extra) {
  const formula = String(edit.formula || "");
  return '<li class="spec-row"><span class="item-label">' + esc(row.id) + '</span><span class="spec-main">' +
    '<span class="spec-meta"><span class="spec-when">' + esc(row.type) + "</span>" + (extra || "") + "</span>" +
    (edit.message ? '<span class="preflight-message">' + esc(edit.message) + "</span>" : "") +
    '<span class="spec-field preflight-formula">' + esc(formula.length > PREFLIGHT_FORMULA_SHOWN ? formula.slice(0, PREFLIGHT_FORMULA_SHOWN) + "…" : formula) + "</span>" +
    (row.missing && row.missing.length ? '<span class="spec-declared">Not in the filing: ' + esc(row.missing.join(", ")) + "</span>" : "") +
    (row.error ? '<span class="spec-declared">' + esc(row.error) + "</span>" : "") + "</span></li>";
}
function preflightGroup(label, led, rows, byId, extra) {
  if (!rows.length) return "";
  return '<div class="items-group"><div class="items-group-label ' + led + '">' + esc(label) + " <span>" + esc(rows.length.toLocaleString()) + '</span></div><ul class="items-list">' +
    rows.slice(0, PREFLIGHT_SHOWN).map(row => preflightRowHtml(row, byId.get(row.id) || {}, extra ? extra(row) : "")).join("") + "</ul>" +
    (rows.length > PREFLIGHT_SHOWN ? '<p class="note-strip">' + esc(plural(rows.length - PREFLIGHT_SHOWN, "more", "more")) + " in the downloaded results.</p>" : "") + "</div>";
}
function preflightResultHtml(pf, edits) {
  const r = pf.result;
  const byId = new Map(edits.map(edit => [edit.id, edit]));
  const count = (type, result) => ((r.counts[type] || {})[result] || 0);
  const all = result => Object.keys(r.counts).reduce((sum, type) => sum + count(type, result), 0);
  const facts = [["Validity failing", count("Validity", "fail")], ["Quality failing", count("Quality", "fail")], ["Not evaluated", all("not_evaluated")], ["Passed", all("pass")]];
  if (r.newly_failing) facts.splice(2, 0, ["Newly failing", r.newly_failing.length]);
  if (all("error")) facts.push(["Could not be read", all("error")]);
  const failing = type => r.results.filter(row => row.type === type && row.result === "fail");
  // Gaps in a series the file reports (RCON, RIAD) are worth a look; a series it holds nothing
  // of (RCFD on an FFIEC 041) belongs to another form.
  const reported = new Set(Object.keys(pf.file.values).map(key => key.slice(0, 4)));
  const missing = new Map(), elsewhere = new Set();
  r.results.filter(row => row.result === "not_evaluated").forEach(row => (row.missing || []).forEach(ref => {
    if (!/^[A-Z0-9]{8}\[/.test(ref)) return;
    if (reported.has(ref.slice(0, 4))) missing.set(ref, (missing.get(ref) || 0) + 1);
    else elsewhere.add(ref.slice(0, 4));
  }));
  const commonMissing = Array.from(missing.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24);
  const otherSeries = Array.from(elsewhere).sort();
  const changes = r.edits ? [r.edits.added && plural(r.edits.added, "edit added", "edits added"), r.edits.changed && plural(r.edits.changed, "formula changed", "formulas changed"),
    r.edits.removed && plural(r.edits.removed, "edit removed", "edits removed")].filter(Boolean).join(", ") : "";
  return '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">' + esc(pf.file.name) + '</h3><div class="sheet-note">' +
      esc(plural(pf.file.count, "value", "values") + " · as of " + L.catalogDate(r.report_date) + (changes ? " · against the set before: " + changes : "")) + "</div></div>" +
      '<button class="sheet-link" type="button" data-preflight-csv>Download results</button></div>' +
      '<dl class="facts">' + facts.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value.toLocaleString()) + "</dd></div>").join("") + "</dl>" +
      '<p class="note-strip">' + esc("Validity edits must pass before the filing is accepted; a failing Quality edit needs an explanation with the filing. An edit that reads an item this file doesn't hold is not evaluated, never passed.") + "</p></section>" +
    (r.newly_failing ? '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Newly failing</h3><div class="sheet-note">' +
      esc("Edits that pass, or don't exist, in the set before and fail in this one: what the new taxonomy would flag on this filing.") + "</div></div></div>" +
      (r.newly_failing.length ? preflightGroup("New or changed", "is-amended", r.newly_failing, byId, row => '<span class="tag">' + esc(row.change) + "</span>") :
        '<p class="note-strip">None: no new or changed edit fails on this filing.</p>') + "</section>" : "") +
    '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Failing edits</h3><div class="sheet-note">' + esc("Validity first, then Quality, in the CDR's order.") + "</div></div></div>" +
      (failing("Validity").length || failing("Quality").length ? preflightGroup("Validity", "is-removed", failing("Validity"), byId) + preflightGroup("Quality", "is-amended", failing("Quality"), byId) :
        '<p class="note-strip">No edit fails on this filing.</p>') + "</section>" +
    (commonMissing.length || otherSeries.length ? '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Items most often missing</h3><div class="sheet-note">' +
      esc("Items in series this file reports that not-evaluated edits read, by how many edits read them. For an earlier quarter ([-P1Q]), add rows with that period end.") + "</div></div></div>" +
      (commonMissing.length ? '<div class="registry-unregistered">' + commonMissing.map(([ref, n]) => '<span class="chip">' + esc(ref + " · " + n) + "</span>").join("") + "</div>" : "") +
      (otherSeries.length ? '<p class="note-strip">' + esc("Edits reading " + (otherSeries.length > 8 ? otherSeries.slice(0, 8).join(", ") + " and " + (otherSeries.length - 8) + " more" : otherSeries.join(", ")) +
        " are not evaluated either: this file reports nothing in " + (otherSeries.length === 1 ? "that series" : "those series") + ", as on another form.") + "</p>" : "") + "</section>" : "");
}
function preflightDetail(pane) {
  const pf = preflightState();
  const heading = actions => detailHeading({ back: true, source: "Registry", title: "Pre-flight a filing", actions });
  let index;
  loadPreflightIndex().then(found => { if (!pf.indexLoaded) { pf.indexLoaded = true; pf.index = found; preflightRerender(); } },
    error => { if (!pf.indexLoaded) { pf.indexLoaded = true; pf.indexError = error.message; preflightRerender(); } });
  if (!pf.indexLoaded) { pane.innerHTML = '<div class="detail-inner">' + heading("") + '<p class="note-strip">Loading the edit checks…</p></div>'; return; }
  index = pf.index;
  const forms = index ? Object.keys(index.forms || {}).sort() : [];
  if (!forms.length) {
    pane.innerHTML = '<div class="detail-inner">' + heading("") + emptyState(pf.indexError ? "Edit checks not loaded" : "No edit checks yet",
      pf.indexError || "They are read from the CDR taxonomy each scan saves (data/edits/). They appear after the next scan of an FFIEC taxonomy page.") + "</div>";
    return;
  }
  if (forms.indexOf(pf.form) < 0) pf.form = preflightDefaultForm(forms);
  const versions = index.forms[pf.form] || [];
  if (!versions.some(version => version.file === pf.set)) pf.set = (versions[0] || {}).file || "";
  const older = versions.filter(version => version.file !== pf.set && version.date < ((versions.find(v => v.file === pf.set) || {}).date || ""));
  if (pf.compare && !older.some(version => version.file === pf.compare)) pf.compare = "";
  const option = (value, label, chosen) => '<option value="' + esc(value) + '"' + (value === chosen ? " selected" : "") + ">" + esc(label) + "</option>";
  const controls = '<div class="preflight-controls">' +
    preflightField("preflightForm", "Form", '<select class="field-input" id="preflightForm" data-preflight="form">' + forms.map(form => option(form, form, pf.form)).join("") + "</select>") +
    preflightField("preflightSet", "Edit checks", '<select class="field-input" id="preflightSet" data-preflight="set">' + versions.map(version => option(version.file, preflightSetLabel(version), pf.set)).join("") + "</select>",
      preflightSetCounts(versions.find(version => version.file === pf.set))) +
    preflightField("preflightCompare", "Compare with", '<select class="field-input" id="preflightCompare" data-preflight="compare"' + (older.length ? "" : " disabled") + ">" +
      option("", older.length ? "Nothing" : "No earlier set saved yet", pf.compare) + older.map(version => option(version.file, preflightSetLabel(version), pf.compare)).join("") + "</select>", "Lists what newly fails") +
    preflightField("preflightDate", "Report date", '<input class="field-input" type="date" id="preflightDate" data-preflight="reportDate" value="' + esc(pf.reportDate) + '">', pf.file && pf.file.reportDate && !pf.reportDate ? "From the file: " + L.catalogDate(pf.file.reportDate) : "From the file if blank") +
    preflightField("preflightFile", "Filing", '<input class="field-input" type="file" id="preflightFile" data-preflight="file" accept=".xml,.xbrl,.csv,text/csv,application/xml,text/xml">', pf.file ? "Checked: " + pf.file.name : "XBRL instance or CSV") +
    "</div>";
  const status = pf.error ? '<p class="bulk-status is-error">' + esc(pf.error) + "</p>" : pf.running ? '<p class="bulk-status">Checking ' + esc(pf.file ? pf.file.name : "the filing") + "…</p>" : "";
  const intro = '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Your filing, the regulator\'s checks</h3><div class="sheet-note">' +
      esc("The validity and quality edits from the FFIEC's published taxonomy, run on a filing you choose. When a new taxonomy lands, compare it with the one before to see what would newly fail, before the quarter it applies to.") +
      '</div></div><button class="sheet-link" type="button" data-preflight-template>CSV template</button></div>' + controls +
    '<p class="note-strip">' + esc("An XBRL instance from your filing software, or a CSV of MDRM code, value and, for earlier quarters, the period end (YYYY-MM-DD). Read in this browser and never uploaded.") + "</p>" + status + "</section>";
  const actions = "";
  if (!pf.result) { pane.innerHTML = '<div class="detail-inner">' + heading(actions) + intro + "</div>"; return; }
  loadPreflightSet(pf.set).then(set => {
    if (state.selectedRegistryKey !== "preflight" || !pane.isConnected) return;
    pane.innerHTML = '<div class="detail-inner">' + heading(actions) + intro + preflightResultHtml(pf, set.edits) + "</div>";
  }, error => { pf.error = error.message; pf.result = null; preflightRerender(); });
}
async function runPreflight() {
  const pf = preflightState();
  if (!pf.file || !pf.set) return;
  pf.running = true; pf.error = ""; pf.result = null;
  preflightRerender();
  try {
    const [set, before] = await Promise.all([loadPreflightSet(pf.set), pf.compare ? loadPreflightSet(pf.compare) : Promise.resolve(null)]);
    if (!set) throw new Error("This edit set is not published yet.");
    const reportDate = pf.reportDate || pf.file.reportDate;
    if (!reportDate) throw new Error("The file names no period: set the report date.");
    await new Promise(resolve => setTimeout(resolve, 20));
    pf.result = before ? L.preflightCompare(before.edits, set.edits, pf.file.values, reportDate) : L.preflightRun(set.edits, pf.file.values, reportDate);
  } catch (error) {
    pf.error = error.message || String(error);
  }
  pf.running = false;
  preflightRerender();
}
async function choosePreflightFile(input) {
  const pf = preflightState();
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const read = L.preflightReadFiling(await file.text());
    const count = Object.keys(read.values).length;
    if (!count) throw new Error("No MDRM values found in " + file.name + ": expected an XBRL instance or a CSV of code,value[,period].");
    pf.file = { name: file.name, values: read.values, reportDate: read.reportDate, count };
  } catch (error) {
    pf.file = null; pf.result = null; pf.error = error.message || String(error);
    return preflightRerender();
  }
  return runPreflight();
}
async function downloadPreflightResults() {
  const pf = preflightState();
  if (!pf.result) return;
  const set = await loadPreflightSet(pf.set);
  const byId = new Map(set.edits.map(edit => [edit.id, edit]));
  const newly = new Map((pf.result.newly_failing || []).map(row => [row.id, row.change]));
  const rows = [["Edit", "Type", "Result", "Change", "Missing", "Message", "Formula"]].concat(pf.result.results.map(row => {
    const edit = byId.get(row.id) || {};
    return [row.id, row.type, row.result, newly.get(row.id) || "", (row.missing || []).join(" "), edit.message || "", edit.formula || ""];
  }));
  downloadTextFile("preflight-" + L.fileSlug(pf.form) + "-" + pf.result.report_date + ".csv", "text/csv", L.toCsv(rows));
}
// Every item the chosen edit set reads, with the period each reference names, for a filing
// prepared by hand or exported from another system.
async function downloadPreflightTemplate() {
  const pf = preflightState();
  const set = pf.set && await loadPreflightSet(pf.set);
  if (!set) return;
  const day = pf.reportDate || (pf.file && pf.file.reportDate) || set.date;
  const seen = new Map();
  set.edits.forEach(edit => String(edit.formula).replace(/cc:([A-Za-z0-9]+)\[([^\]]+)\]/g, (_, code, ctx) => {
    const period = L.preflightShift(day, ctx) || ctx;
    seen.set(code.toUpperCase() + "|" + period, [code.toUpperCase(), "", period]);
    return "";
  }));
  const rows = [["code", "value", "period"]].concat(Array.from(seen.values()).sort((a, b) => b[2].localeCompare(a[2]) || a[0].localeCompare(b[0])));
  downloadTextFile("preflight-template-" + L.fileSlug(pf.form) + "-" + day + ".csv", "text/csv", L.toCsv(rows));
}
document.addEventListener("change", event => {
  const control = event.target.closest && event.target.closest("[data-preflight]");
  if (!control) return;
  const pf = preflightState();
  const field = control.dataset.preflight;
  if (field === "file") return choosePreflightFile(control);
  pf[field] = control.value;
  if (field === "form") { pf.set = ""; pf.compare = ""; }
  if (field === "set") pf.compare = "";
  if (pf.file) return runPreflight();
  preflightRerender();
});

/* ---------- Proposed revisions to the forms an item is reported on ---------- */
const PROPOSALS_SHOWN = 5;
function loadProposals() {
  if (state.proposals) return state.proposals;
  const path = "data/proposals.json";
  state.proposals = (async () => {
    let missing = 0;
    for (const url of [new URL("./" + path, document.baseURI).href, bust(RAW + "/" + path)]) {
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (response.status === 404) { missing += 1; continue; }
        if (!response.ok) continue;
        const payload = await response.json();
        if (payload && Array.isArray(payload.proposals)) return payload;
      } catch (_) { /* next copy */ }
    }
    if (missing) return null;
    throw new Error("Proposed revisions could not be loaded");
  })().catch(error => { state.proposals = null; throw error; });
  return state.proposals;
}
function proposalStageTone(stage) {
  return { proposed: "is-warn", request: "is-warn", final: "tone-change", under_review: "tone-markup", extension: "is-older" }[stage] || "tone-markup";
}
// "Draft form", "Draft instructions", "FIL-3-2024": which document a link is, in a word or two.
function proposalDocLabel(doc) {
  const text = String(doc.text || "") + " " + String(doc.url || "");
  if (doc.kind === "draft") return /instruction|_i_|_i\.pdf/i.test(text) && !/form and instruction|_f_i_|_fi_/i.test(text) ? "Draft instructions"
    : /form and instruction|_f_i_|_fi_/i.test(text) ? "Draft form and instructions" : "Draft form";
  if (doc.kind === "letter") { const fil = /\bFIL-\d+-\d{4}/i.exec(text); return fil ? fil[0].toUpperCase() : "Letter"; }
  return L.PROPOSAL_KINDS[doc.kind] || "Document";
}
function proposalRow(proposal, today) {
  const upcoming = (proposal.effective || []).filter(day => day >= today);
  const docs = (proposal.documents || []).filter(doc => safeHttpUrl(doc.url));
  // Notices first, then drafts, item lists and letters; at most six links.
  const order = { initial_notice: 0, final_notice: 1, notice: 2, request: 3, draft: 4, impact_list: 5, letter: 6, other: 7 };
  const shown = docs.slice().sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9)).slice(0, 6);
  return '<li class="spec-row"><span class="item-date">' + esc(L.proposalDateLabel(proposal)) + '</span><span class="spec-main"><span class="spec-meta">' +
    '<span class="tag ' + proposalStageTone(proposal.stage) + '">' + esc(L.PROPOSAL_STAGES[proposal.stage] || "Proposed") + "</span>" +
    (upcoming.length ? '<span class="tag is-warn">' + esc("Takes effect " + L.catalogDate(upcoming[0])) + "</span>" :
      (proposal.effective || []).length ? '<span class="spec-when">' + esc("Effective " + proposal.effective.map(L.catalogDate).join(", ")) + "</span>" : "") +
    '<span class="spec-source">' + esc((proposal.forms || []).join(", ")) + "</span></span>" +
    '<span class="item-text">' + esc(proposal.title || "Proposed revisions") + "</span>" +
    (shown.length ? '<span class="spec-meta">' + shown.map(doc => '<a class="sheet-link" href="' + esc(safeHttpUrl(doc.url)) + '" target="_blank" rel="noopener noreferrer" title="' +
      esc(doc.text || displayUrl(doc.url)) + '">' + esc(proposalDocLabel(doc)) + icon("external") + "</a>").join("") +
      (docs.length > shown.length ? '<span class="spec-when">' + esc("+" + (docs.length - shown.length) + " more") + "</span>" : "") + "</span>" : "") +
    "</span></li>";
}
async function fillProposals(item, forms, key) {
  const slot = document.getElementById("registryProposals");
  if (!slot) return;
  const still = () => document.getElementById("registryProposals") === slot && state.view === "registry" && (state.selectedRegistryKey || "about") === key;
  if (!forms.length) { slot.innerHTML = ""; return; }
  let payload;
  try { payload = await loadProposals(); } catch (error) {
    if (still()) slot.innerHTML = '<section class="sheet"><p class="note-strip">' + esc(error.message) + ". It is retried the next time this item opens.</p></section>";
    return;
  }
  if (!still()) return;
  const found = payload ? L.proposalsFor(payload, forms) : [];
  const today = L.localIsoDate();
  slot.innerHTML = '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Proposed revisions</h3><div class="sheet-note">' +
    esc("To " + forms.join(", ") + ", from the regulators' form pages: Federal Register notices, drafts and letters, newest first") + "</div></div></div>" +
    (found.length ? '<ul class="items-list">' + found.slice(0, PROPOSALS_SHOWN).map(proposal => proposalRow(proposal, today)).join("") + "</ul>" +
      (found.length > PROPOSALS_SHOWN ? '<p class="note-strip">' + esc(plural(found.length - PROPOSALS_SHOWN, "older proposal", "older proposals")) + " in data/proposals.json.</p>" : "") :
      '<p class="note-strip">No proposal for these forms is listed on a monitored page. Monitor the form\'s page on the regulator\'s site to follow its proposals.</p>') +
    "</section>";
}
function ruleTablesSheet() {
  const sources = ruleTableSources();
  if (!sources.length) return "";
  return '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Rule tables read from PDFs</h3><div class="sheet-note">Edit checks and field lists the scan reads row by row; each can add every code it names</div></div></div>' +
    '<ul class="items-list">' + sources.map(source => '<li class="registry-consumer"><span class="tag">' + esc(plural(Number(source.summary.rows) || 0, "row", "rows")) + "</span>" +
      '<span class="registry-consumer-name"><button class="text-button" type="button" data-select-registry="table:' + esc(source.record.url_id) + '">' + esc(source.title) + "</button></span>" +
      '<span class="registry-consumer-meta">' + esc(plural(Number(source.summary.codes) || 0, "code", "codes") + " · " + displayUrl(source.record.canonical_url)) + "</span></li>").join("") + "</ul></section>";
}
async function renderRuleTableDetail(pane, urlId) {
  const source = ruleTableSource(urlId);
  if (!source) { pane.innerHTML = '<div class="detail-inner">' + emptyState("Not read as a table", "The last scan did not read a rule table from this file.") + "</div>"; return; }
  const summary = source.summary;
  const pages = Array.isArray(summary.pages) && summary.pages.length ? "Pages " + summary.pages[0] + "–" + summary.pages[summary.pages.length - 1] : "";
  const columns = Array.isArray(summary.tables) && summary.tables.length ? summary.tables[0] : [];
  const placed = Number(summary.glyphs) ? (Number(summary.glyphs_placed) === Number(summary.glyphs) ? "Every character placed in a cell" :
    Number(summary.glyphs_placed).toLocaleString() + " of " + Number(summary.glyphs).toLocaleString() + " characters placed") : "";
  pane.innerHTML = '<div class="detail-inner">' + detailHeading({ back: true, source: "Rule table · " + (source.record.regulator || ""), title: source.title, meta: urlMeta(source.record.canonical_url),
      actions: '<button class="btn btn-primary" type="button" data-registry-seed="' + esc(urlId) + '">Add its codes to the registry</button>' +
        '<button class="btn" type="button" data-open-page="' + esc(urlId) + '">Open the page</button>' }) +
    '<section class="sheet"><dl class="rule-table-figures">' +
      "<div><dt>Rows</dt><dd>" + esc((Number(summary.rows) || 0).toLocaleString()) + "<span>" + esc(pages) + "</span></dd></div>" +
      "<div><dt>Codes</dt><dd>" + esc((Number(summary.codes) || 0).toLocaleString()) + '<span id="ruleTableRegistered">&nbsp;</span></dd></div>' +
      "<div><dt>Printed with defects</dt><dd>" + esc(Number(summary.rows_with_source_defects) || 0) + "<span>Kept exactly as printed</span></dd></div></dl>" +
      (columns.length ? '<p class="note-strip">Columns: ' + esc(columns.join(" · ")) + (placed ? ". " + placed + "." : "") +
        (Array.isArray(summary.pages_not_read) && summary.pages_not_read.length ? " Pages not read as a table: " + esc(summary.pages_not_read.join(", ")) + "." : "") + "</p>" : "") + "</section>" +
    '<div id="ruleTableRows"><section class="sheet"><p class="note-strip">Reading the table…</p></section></div></div>';
  let index;
  try { index = await loadRuleTable(source.location); } catch (error) {
    const slot = document.getElementById("ruleTableRows");
    if (slot) slot.innerHTML = '<section class="sheet"><p class="note-strip">The table could not be read: ' + esc(error.message) + "</p></section>";
    return;
  }
  if (state.view !== "registry" || state.selectedRegistryKey !== "table:" + urlId) return;
  const model = registryModelNow();
  const codes = Array.from(index.byField.keys());
  const registered = codes.filter(code => model.byCode.has(code)).length;
  const counter = document.getElementById("ruleTableRegistered");
  if (counter) counter.textContent = registered ? registered.toLocaleString() + " in the registry" : "None in the registry yet";
  const flagged = index.rows.filter(row => row.status && !/^no change$/i.test(String(row.status).trim()));
  const defective = index.rows.filter(row => Array.isArray(row.defects) && row.defects.length);
  const slot = document.getElementById("ruleTableRows");
  if (!slot) return;
  slot.innerHTML = '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Rows the regulator marks as changed</h3><div class="sheet-note">' +
      esc(flagged.length ? "From its own status column; the change record says whether the logic actually moved" : "No row is marked as added or revised") + "</div></div></div>" +
      (flagged.length ? ruleChecksSection("Marked", flagged, source, "", "is-amended") : "") + "</section>" +
    (defective.length ? '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Rows printed incompletely</h3><div class="sheet-note">The PDF\'s own text layer; nothing is repaired</div></div></div>' +
      ruleChecksSection("Rows", defective, source, "", "") + "</section>" : "");
}

/* ---------- Add to registry ---------- */

// Opens a prefilled GitHub request (regmon/registry.py apply-issue). Modes:
// add (optionally prefilled with a code or a consumer), edit an item, edit a
// consumer, or seed every code of a rule table.
let registryDraft = { mode: "add" };
function registryFill(id, value) { const field = $(id); if (field) field.value = value || ""; }
function registryConsumerPick(checked) {
  const model = registryModelNow();
  const ids = new Set(checked || []);
  $("registryConsumerPick").innerHTML = Array.from(model.consumers.values()).filter(consumer => consumer.id.indexOf("lineage:") !== 0).map(consumer =>
    '<label class="field-check"><input type="checkbox" value="' + esc(consumer.id) + '"' + (ids.has(consumer.id) ? " checked" : "") + "> " + esc(consumer.name) +
    ' <span class="tag">' + esc((L.REGISTRY_KIND_NOUNS[consumer.kind] || L.REGISTRY_KIND_NOUNS.other)[0]) + "</span></label>").join("");
}
function applyRegistryTemplate(id, keepFilled) {
  const template = registryTemplateList().find(candidate => candidate.id === id);
  $("registryTemplateHelp").textContent = template ? (template.documents ? "Documents: " + template.documents + "." : "") +
    (template.code_prefixes.length ? " Codes starting " + template.code_prefixes.slice(0, 6).join(", ") + (template.code_prefixes.length > 6 ? " and " + (template.code_prefixes.length - 6) + " more prefixes." : ".") : "") : "Enter the details yourself.";
  $("registryScheduleList").innerHTML = (template ? template.schedules : []).map(schedule => '<option value="' + esc(schedule) + '"></option>').join("");
  if (!template) return;
  const set = (field, value) => { if (!keepFilled || !$(field).value) $(field).value = value || ""; };
  set("registryScheme", template.scheme);
  set("registryFormName", template.form);
  set("registryJurisdiction", template.jurisdiction);
  set("registryRegulator", template.regulator);
}
function openRegistryDialog(options) {
  const o = options || {};
  const model = registryModelNow();
  const templates = registryTemplateList();
  registryDraft = Object.assign({ mode: "add" }, o);
  $("registryTemplate").innerHTML = '<option value="">No template</option>' + templates.map(template => '<option value="' + esc(template.id) + '">' + esc(template.name) + "</option>").join("");
  $("registryScheme").innerHTML = Object.keys(L.REGISTRY_SCHEMES).map(scheme => '<option value="' + esc(scheme) + '">' + esc(scheme + " · " + L.REGISTRY_SCHEMES[scheme]) + "</option>").join("");
  $("registryConsumerKind").innerHTML = L.REGISTRY_KINDS.map(kind => '<option value="' + kind + '"' + (kind === "pipeline" ? " selected" : "") + ">" + esc((L.REGISTRY_KIND_NOUNS[kind] || [kind])[0]) + "</option>").join("");
  ["registryCodes", "registrySchedule", "registryLine", "registryPattern", "registryConsumerName", "registryConsumerOwner", "registryConsumerRepo", "registryConsumerPath", "registryConsumerImplements"].forEach(id => registryFill(id, ""));
  $("registryNewConsumer").checked = false;
  $("registryNewConsumerFields").hidden = true;
  $("registryRemove").checked = false;
  $("registryRemoveBox").hidden = true;
  $("registryStatus").hidden = true;
  $("registrySeedBox").hidden = true;
  $("registryItemsBox").hidden = false;
  $("registryPatternBox").hidden = false;
  let template = "", checked = [], heading = "Add to registry", lede = "Items you report, and what reads them.";
  if (o.code) {
    const guess = L.registryTemplateForCode(o.code, templates);
    template = guess ? guess.id : "";
    $("registryCodes").value = o.code;
    lede = "Register " + o.code + (guess ? " (" + guess.name + ")" : "") + " and say what reads it.";
    // Where the regulator's own rule table places it: the most common schedule and line.
    ruleTableSources().forEach(source => loadRuleTable(source.location).then(index => {
      const rows = index.byField.get(L.registryNorm(o.code)) || [];
      if (!rows.length || registryDraft.code !== o.code || !$("registryDialog").open) return;
      const counts = new Map();
      rows.forEach(row => { const place = [row.table || "", row.line_item || ""].join("\u0000"); counts.set(place, (counts.get(place) || 0) + 1); });
      const [schedule, line] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0].split("\u0000");
      if (!$("registrySchedule").value) $("registrySchedule").value = schedule;
      if (!$("registryLine").value) $("registryLine").value = line;
      updateRegistryPreview();
    }).catch(() => {}));
  }
  if (o.consumer && model.consumers.has(o.consumer)) {
    checked = [o.consumer];
    lede = "Items " + model.consumers.get(o.consumer).name + " reads.";
  }
  if (o.mode === "edit") {
    const item = registryItemByKey(o.key);
    if (!item) return;
    heading = "Edit " + item.code;
    lede = "Details you change replace the stored ones; consumers you tick are added.";
    $("registryCodes").value = item.code + (item.label ? ", " + item.label : "");
    checked = item.consumers || [];
    $("registryRemoveBox").hidden = false;
    $("registryRemoveLabel").textContent = "Remove " + item.code + " from the registry";
    $("registryPatternBox").hidden = true;
  }
  if (o.mode === "consumer") {
    const consumer = model.consumers.get(o.consumer);
    if (!consumer) return;
    heading = "Edit " + consumer.name;
    lede = "Details you change replace the stored ones.";
    $("registryItemsBox").hidden = true;
    $("registryPatternBox").hidden = true;
    $("registryNewConsumer").checked = true;
    $("registryNewConsumerFields").hidden = false;
    registryFill("registryConsumerName", consumer.name);
    $("registryConsumerKind").value = consumer.kind || "other";
    registryFill("registryConsumerOwner", consumer.owner);
    registryFill("registryConsumerRepo", consumer.repo);
    registryFill("registryConsumerPath", consumer.path);
    registryFill("registryConsumerImplements", (consumer.implements || []).join("\n"));
    $("registryRemoveBox").hidden = false;
    $("registryRemoveLabel").textContent = "Remove " + consumer.name + " from the registry (items stay)";
  }
  if (o.mode === "seed") {
    const source = ruleTableSource(o.urlId);
    if (!source) return;
    heading = "Add a rule table's codes";
    lede = source.title;
    $("registryItemsBox").hidden = true;
    $("registryPatternBox").hidden = true;
    $("registrySeedBox").hidden = false;
    $("registrySeedBox").innerHTML = "Adds the <strong>" + esc((Number(source.summary.codes) || 0).toLocaleString()) + " codes</strong> its " +
      esc((Number(source.summary.rows) || 0).toLocaleString()) + " rows are about, and the codes their logic reads. Each takes its schedule and line from the rows themselves. " +
      "Items already registered keep their details; only blanks are filled.";
    loadRuleTable(source.location).then(index => {
      const guess = ruleTableTemplate(index);
      if (guess && registryDraft.mode === "seed" && !$("registryTemplate").value) { $("registryTemplate").value = guess.id; applyRegistryTemplate(guess.id); updateRegistryPreview(); }
    }).catch(() => {});
  }
  // An item is keyed by scheme, code and form; an edit keeps them as stored.
  ["registryTemplate", "registryScheme", "registryFormName"].forEach(id => { $(id).disabled = o.mode === "edit"; });
  $("registryHeading").textContent = heading;
  $("registryLede").textContent = lede;
  $("registryTemplate").value = template;
  if (o.mode === "edit") {
    const item = registryItemByKey(o.key);
    const match = templates.find(candidate => candidate.form && candidate.form === item.form && candidate.scheme === item.scheme);
    $("registryTemplate").value = match ? match.id : "";
    applyRegistryTemplate($("registryTemplate").value);
    $("registryScheme").value = item.scheme;
    registryFill("registryFormName", item.form);
    registryFill("registrySchedule", item.schedule);
    registryFill("registryLine", item.line);
    registryFill("registryJurisdiction", item.jurisdiction);
    registryFill("registryRegulator", item.regulator);
  } else {
    ["registryFormName", "registryJurisdiction", "registryRegulator"].forEach(id => registryFill(id, ""));
    $("registryScheme").value = "OTHER";
    applyRegistryTemplate(template);
  }
  registryConsumerPick(checked);
  updateRegistryPreview();
  $("registryDialog").showModal();
  window.setTimeout(() => (o.mode === "consumer" ? $("registryConsumerName") : o.mode === "seed" || o.mode === "edit" ? $("registryTemplate") : $("registryCodes")).focus(), 30);
}
function registryDialogValues() {
  const model = registryModelNow();
  const mode = registryDraft.mode;
  const template = $("registryTemplate").value;
  const checked = Array.from($("registryConsumerPick").querySelectorAll("input:checked")).map(input => input.value);
  const consumers = [];
  let newId = "";
  if ($("registryNewConsumer").checked && $("registryConsumerName").value.trim()) {
    newId = mode === "consumer" ? registryDraft.consumer : L.registryConsumerId($("registryConsumerName").value, new Set(model.consumers.keys()));
    const implementsList = $("registryConsumerImplements").value.split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    const stored = mode === "consumer" ? ((model.consumers.get(registryDraft.consumer) || {}).implements || []) : [];
    consumers.push({ id: newId, kind: $("registryConsumerKind").value, name: $("registryConsumerName").value, owner: $("registryConsumerOwner").value,
      repo: $("registryConsumerRepo").value.trim(), path: $("registryConsumerPath").value.trim(), implements: implementsList,
      remove_implements: stored.filter(value => implementsList.indexOf(String(value).replace(/\s+/g, " ").trim()) < 0) });
  }
  const readers = checked.concat(newId && mode !== "consumer" ? [newId] : []);
  const values = { template: mode === "consumer" ? "" : template, consumers, knownConsumers: Array.from(model.consumers.keys()), items: [], rules: [] };
  const parsed = L.registryParseCodes($("registryCodes").value);
  const errors = parsed.errors.slice();
  if (mode === "consumer") {
    if ($("registryRemove").checked) { values.consumers = []; values.removeConsumers = [registryDraft.consumer]; }
    values.summary = ($("registryRemove").checked ? "Remove " : "Edit ") + (model.consumers.get(registryDraft.consumer) || {}).name;
    if (!$("registryRemove").checked && !consumers.length) errors.push("Give the consumer a name.");
    return { values, errors };
  }
  if (mode === "seed") {
    const source = ruleTableSource(registryDraft.urlId);
    values.seed = { rule_tables: source ? source.location : "", template, consumers: readers };
    values.summary = "Add the codes of " + (source ? source.title : "a rule table").slice(0, 120);
    return { values, errors };
  }
  const shared = { scheme: $("registryScheme").value, form: $("registryFormName").value, schedule: $("registrySchedule").value,
    jurisdiction: $("registryJurisdiction").value, regulator: $("registryRegulator").value };
  if (mode === "edit") {
    const item = registryItemByKey(registryDraft.key);
    if ($("registryRemove").checked) {
      values.removeItems = [{ code: item.code, scheme: item.scheme, form: item.form }];
      values.summary = "Remove " + item.code;
      return { values, errors };
    }
    if (parsed.codes.length !== 1 || L.registryNorm(parsed.codes[0].code) !== L.registryNorm(item.code)) errors.push("Keep the code as " + item.code + "; to rename it, remove it and add the new one.");
    // The item's key (scheme, code, form) stays as stored, so an edit never forks it.
    values.template = "";
    values.items.push(Object.assign({}, shared, { code: item.code, scheme: item.scheme, form: item.form, line: $("registryLine").value,
      label: (parsed.codes[0] || {}).label || item.label, consumers: readers }));
    values.summary = "Edit " + item.code;
    return { values, errors };
  }
  if (!parsed.codes.length && !$("registryPattern").value.trim()) errors.push("List at least one code, or a pattern.");
  if ($("registryLine").value.trim() && parsed.codes.length > 1) errors.push("A line number applies to one item; leave it empty for several.");
  values.items = parsed.codes.map(entry => Object.assign({}, shared, { code: entry.code, label: entry.label || "", line: parsed.codes.length === 1 ? $("registryLine").value : "", consumers: readers }));
  if ($("registryPattern").value.trim()) {
    values.rules.push({ match: $("registryPattern").value, scheme: shared.scheme === "OTHER" ? "" : shared.scheme, consumers: readers });
  }
  const where = [shared.form, shared.schedule].filter(Boolean).join(" ");
  values.summary = (parsed.codes.length ? "Add " + (parsed.codes.length === 1 ? parsed.codes[0].code : plural(parsed.codes.length, "item", "items")) : "Map " + $("registryPattern").value.trim()) +
    (where ? " to " + where : "") + (consumers.length ? "; new " + ((L.REGISTRY_KIND_NOUNS[consumers[0].kind] || ["consumer"])[0]) + " " + consumers[0].name : "");
  return { values, errors };
}
function updateRegistryPreview() {
  const preview = $("registryPreview");
  if (!preview || !$("registryDialog")) return;
  let draft;
  try { draft = registryDialogValues(); } catch (_) { preview.textContent = ""; return; }
  const v = draft.values;
  const model = registryModelNow();
  const existing = v.items.filter(item => (model.byCode.get(L.registryNorm(item.code)) || []).some(stored => stored.scheme === (item.scheme || "OTHER") && L.registryNorm(stored.form) === L.registryNorm(item.form))).length;
  const readers = new Set([].concat(...v.items.map(item => item.consumers || []), ...v.rules.map(rule => rule.consumers || []), v.seed ? v.seed.consumers || [] : []));
  const names = Array.from(readers).map(id => (model.consumers.get(id) || v.consumers.find(consumer => consumer.id === id) || { name: id }).name);
  let text = v.summary || "";
  if (registryDraft.mode === "add" && v.items.length) {
    text = plural(v.items.length - existing, "new item", "new items") + (existing ? ", " + plural(existing, "update", "updates") : "") +
      (v.items[0].form ? " in " + [v.items[0].form, v.items[0].schedule].filter(Boolean).join(" ") : "") +
      (names.length ? ", read by " + names.slice(0, 3).join(", ") + (names.length > 3 ? " and " + (names.length - 3) + " more" : "") : ", no consumer mapped yet") + ".";
  } else if (registryDraft.mode === "seed") {
    text = "Every code in the table" + (v.template ? " as " + ((registryTemplateList().find(t => t.id === v.template) || {}).name || v.template) + " items" : "") +
      (names.length ? ", read by " + names.join(", ") : "") + ".";
  }
  preview.textContent = text;
}
/* ---------- Import a mapping (Phase 4.1) ----------
 * A code → system / owner spreadsheet is read here (CSV, TSV or the first
 * sheet of an XLSX; never uploaded) by L.registryMappingRequest, the same
 * function as `python -m regmon.registry import`, and sent as one registry
 * request. A request too long for a prefilled GitHub link is packed (deflate +
 * base64 with its SHA-256); if it still does not fit, it is copied and the
 * owner pastes it into the request GitHub opens (up to 65,536 characters).
 * Everything is prepared when the file is read, so the click that sends it
 * can copy and open GitHub without the browser blocking either. */
const REGISTRY_IMPORT_BODY_LIMIT = 65000;
const REGISTRY_IMPORT_ERRORS_SHOWN = 8;
const REGISTRY_IMPORT_CATALOG_SERIES = 40;
const REGISTRY_IMPORT_COLUMN_WORDS = { code: "Code", scheme: "Scheme", jurisdiction: "Jurisdiction", regulator: "Regulator", form: "Form", schedule: "Schedule",
  line: "Line", label: "Label", consumer: "Read by", consumer_kind: "Kind", repo: "Repository", path: "Path", owner: "Owner", system: "System" };
function openRegistryImport() {
  state.registryImport = null;
  $("registryImportForm").reset();
  ["registryImportColumns", "registryImportCatalog", "registryImportStatus", "registryImportPaste"].forEach(id => { $(id).hidden = true; });
  $("registryImportPreview").textContent = "";
  $("registryImportInfo").hidden = false;
  $("submitRegistryImport").disabled = true;
  $("submitRegistryImport").textContent = "Continue on GitHub";
  $("registryImportDialog").showModal();
}
function registryImportError(messages) {
  const status = $("registryImportStatus");
  const list = (messages || []).filter(Boolean);
  status.hidden = !list.length;
  status.textContent = list.slice(0, REGISTRY_IMPORT_ERRORS_SHOWN).join(". ") + (list.length > REGISTRY_IMPORT_ERRORS_SHOWN ? ". And " + (list.length - REGISTRY_IMPORT_ERRORS_SHOWN) + " more." : list.length ? "." : "");
}
async function readRegistryImportFile() {
  const file = $("registryImportFile").files && $("registryImportFile").files[0];
  state.registryImport = null;
  $("submitRegistryImport").disabled = true;
  ["registryImportColumns", "registryImportCatalog", "registryImportPaste"].forEach(id => { $(id).hidden = true; });
  $("registryImportPreview").textContent = "";
  registryImportError([]);
  if (!file) return;
  const token = {};
  state.registryImportToken = token;
  const extension = (file.name.split(".").pop() || "").toLowerCase();
  let matrix;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("The file is larger than 20 MB");
    if (extension === "xlsx" || extension === "xlsm") matrix = await L.xlsxFirstSheetRows(await file.arrayBuffer());
    else if (extension === "csv" || extension === "tsv") matrix = L.parseCsv((await file.text()).replace(/^\uFEFF/, ""), 1e9, extension === "tsv" ? "\t" : ",");
    else throw new Error("Choose a .csv, .tsv or .xlsx file");
  } catch (error) { if (state.registryImportToken === token) registryImportError([error.message || "The file could not be read"]); return; }
  if (state.registryImportToken !== token) return;
  const payload = state.registry || {};
  const result = L.registryMappingRequest(matrix, {
    knownSchemes: (payload.schemes || []).map(scheme => scheme && scheme.id).filter(Boolean),
    existingConsumers: (payload.consumers || []).map(consumer => consumer && consumer.id).filter(Boolean),
    summary: "Mapping import: " + file.name.slice(0, 120) + " (" + plural(Math.max(0, matrix.length - 1), "row", "rows") + ")"
  });
  const report = result.report;
  const columns = Object.keys(report.columns);
  $("registryImportColumns").hidden = !columns.length;
  $("registryImportColumns").innerHTML = columns.map(key => '<div class="bulk-preview-row"><span class="bulk-preview-name">' + esc(REGISTRY_IMPORT_COLUMN_WORDS[key] || key) +
    '</span><span class="row-host">' + esc(report.columns[key]) + "</span></div>").join("");
  registryImportError(report.errors);
  if (report.errors.length || !result.request.items) {
    $("registryImportPreview").textContent = report.rows ? plural(report.rows, "row", "rows") + " read; nothing is sent until every row above is fixed." : "";
    return;
  }
  const model = registryModelNow();
  const registered = new Set(model.items.map(item => item.scheme + "\u0000" + L.registryNorm(item.code) + "\u0000" + L.registryNorm(item.form || "")));
  const items = result.request.items, consumers = result.request.consumers || [];
  const newItems = items.filter(item => !registered.has(item.scheme + "\u0000" + L.registryNorm(item.code) + "\u0000" + L.registryNorm(item.form || ""))).length;
  const newConsumers = consumers.filter(consumer => !model.consumers.has(consumer.id)).length;
  $("registryImportPreview").textContent = plural(report.used, "row", "rows") + " → " + plural(items.length, "item", "items") +
    " (" + newItems + " new, " + (items.length - newItems) + " already registered)" +
    (consumers.length ? ", read by " + plural(consumers.length, "consumer", "consumers") + " (" + newConsumers + " new) in " + plural(report.links, "link", "links") : ", with no consumer column") +
    (report.skipped ? ". " + plural(report.skipped, "row has", "rows have") + " no code and " + (report.skipped === 1 ? "is" : "are") + " skipped" : "") + ".";
  const text = JSON.stringify(result.request);
  const title = L.REGISTRY_REQUEST_TITLE + ": " + String(result.request.summary || "Mapping import").slice(0, 80);
  const linkFor = body => { const params = new URLSearchParams(); params.set("title", title); params.set("body", body); return REPO + "/issues/new?" + params.toString(); };
  let body = L.registryRequestBody(result.request), mode = "link";
  if (linkFor(body).length > MAX_BULK_REQUEST_URL_LENGTH) {
    let packed = null;
    try { packed = await L.packRequest(text); } catch (_) { packed = null; }
    if (state.registryImportToken !== token) return;
    if (packed) body = L.registryRequestBody(result.request, packed, await L.sha256Hex(text));
    mode = linkFor(body).length <= MAX_BULK_REQUEST_URL_LENGTH ? "link" : "paste";
  }
  if (state.registryImportToken !== token) return;
  if (body.length > REGISTRY_IMPORT_BODY_LIMIT) {
    registryImportError(["This mapping is too large for one GitHub request (" + Math.round(body.length / 1000) + "k characters packed; the limit is 65k). Split the file, or merge it with python -m regmon.registry import mapping.csv --write"]);
    return;
  }
  state.registryImport = { mode, body, title, target: mode === "link" ? linkFor(body) : linkFor("Paste the request the dashboard copied here (Ctrl+V or ⌘V), replacing this line."), name: file.name };
  $("submitRegistryImport").disabled = false;
  $("submitRegistryImport").textContent = mode === "link" ? "Continue on GitHub" : "Copy and continue on GitHub";
  fillRegistryImportCatalog(items, token);
}
// How many imported MDRM codes a monitored document defines; the rest still import.
async function fillRegistryImportCatalog(items, token) {
  const codes = Array.from(new Set(items.filter(item => item.scheme === "MDRM").map(item => L.catalogCode(item.code)).filter(Boolean)));
  if (!codes.length) return;
  const series = Array.from(new Set(codes.map(code => code.slice(0, 4))));
  if (series.length > REGISTRY_IMPORT_CATALOG_SERIES) return;
  const docs = new Map();
  await Promise.all(series.map(name => loadCatalogSeries(name).then(doc => docs.set(name, doc), () => docs.set(name, undefined))));
  if (state.registryImportToken !== token || !$("registryImportDialog").open) return;
  if (Array.from(docs.values()).some(doc => doc === undefined)) return;
  const missing = codes.filter(code => { const doc = docs.get(code.slice(0, 4)); return !doc || !L.catalogItem(doc, code); });
  const note = $("registryImportCatalog");
  note.hidden = false;
  note.textContent = missing.length
    ? plural(codes.length - missing.length, "MDRM code is", "MDRM codes are") + " in the item catalog. " + missing.length + (missing.length === 1 ? " is" : " are") +
      " not defined by any monitored document (" + missing.slice(0, 6).join(", ") + (missing.length > 6 ? ", …" : "") + "); they import all the same, and changes to them are still matched by code."
    : "Every MDRM code is in the item catalog, so each item shows what the regulator says it is.";
}
async function copyRegistryImport() {
  const pending = state.registryImport;
  if (!pending) return false;
  try { await navigator.clipboard.writeText(pending.body); return true; } catch (_) { return false; }
}
function submitRegistryImport(event) {
  event.preventDefault();
  const pending = state.registryImport;
  if (!pending) return;
  if (pending.mode === "link") {
    $("registryImportDialog").close();
    openGitHubRequest(pending.target, "Submit the prefilled request on GitHub. The registry updates about a minute after it is applied.");
    return;
  }
  // Copy first, inside the click, then open GitHub; the dialog stays open with the request.
  const copied = copyRegistryImport();
  const githubWindow = window.open(pending.target, "_blank");
  if (githubWindow) { try { githubWindow.opener = null; } catch (_) {} }
  $("registryImportBody").value = pending.body;
  $("registryImportPaste").hidden = false;
  $("registryImportInfo").hidden = true;
  $("submitRegistryImport").textContent = "Open GitHub again";
  copied.then(ok => {
    $("registryImportPaste").querySelector("strong").textContent = ok ? "The request is copied." : "Copy the request below.";
    if (!ok) { $("registryImportBody").focus(); $("registryImportBody").select(); }
  });
  if (!githubWindow) showToast("Your browser blocked the new tab. Allow pop-ups for this page, or open GitHub's new issue page and paste.");
}

function submitRegistry(event) {
  event.preventDefault();
  const draft = registryDialogValues();
  const request = L.registryRequest(draft.values);
  const errors = draft.errors.concat(request.errors);
  const params = new URLSearchParams();
  params.set("title", request.title);
  params.set("body", request.body);
  const target = REPO + "/issues/new?" + params.toString();
  if (!errors.length && target.length > MAX_BULK_REQUEST_URL_LENGTH) {
    errors.push("This request is too long for one GitHub link (" + plural(draft.values.items.length, "item", "items") + "). Split it, or merge a spreadsheet with python -m regmon.registry import.");
  }
  if (errors.length) { $("registryStatus").textContent = errors.join(" "); $("registryStatus").hidden = false; return; }
  $("registryDialog").close();
  openGitHubRequest(target, "Submit the prefilled request on GitHub. The registry updates about a minute after it is applied.");
}

function impactSheet(impact) {
  const items = Array.isArray(impact.items) ? impact.items : [];
  const consumers = Array.isArray(impact.consumers) ? impact.consumers : [];
  if (!items.length) return "";
  return '<section class="sheet" aria-labelledby="change-impact-title"><div class="sheet-head"><div><h3 class="sheet-title" id="change-impact-title">Downstream impact</h3>' +
    '<div class="sheet-note">From the item registry, as configured when this change was recorded</div></div>' +
    '<button class="sheet-link" type="button" data-go="registry">Registry</button></div>' +
    '<p class="impact-sentence">' + esc(impact.sentence || "") + "</p>" +
    (consumers.length ? '<div class="items-group"><div class="items-group-label is-amended">What reads them <span>' + esc(consumers.length) + "</span></div>" +
      '<ul class="items-list">' + consumers.map(consumer => consumerLine(consumer, consumer.codes || [])).join("") + "</ul></div>" : "") +
    '<div class="items-group"><div class="items-group-label">Registered items touched <span>' + esc(items.length) + "</span></div>" +
    '<ul class="items-list">' + items.slice(0, 60).map(item => '<li class="item-row"><span class="item-code">' + esc(item.code) + "</span>" +
      '<span class="item-text">' + esc([L.REGISTRY_CHANGE_WORDS[item.change] || item.change, [item.form, item.schedule].filter(Boolean).join(" "), item.label, item.quarter].filter(Boolean).join(" · ")) + "</span></li>").join("") + "</ul></div>" +
    (impact.unregistered_count ? '<p class="note-strip">' + esc(plural(impact.unregistered_count, "other code was", "other codes were")) + " touched but is not registered.</p>" : "") + "</section>";
}
async function fillImpact(entry, slotId, stillCurrent) {
  if (!entry.evidence_location || CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0) return;
  let evidence;
  try { evidence = await loadEvidence(entry.evidence_location); } catch (_) { return; }
  const slot = document.getElementById(slotId);
  if (!slot || !stillCurrent()) return;
  let impact = isPlainObject(evidence.impact) ? evidence.impact : null;
  if (!impact) {
    // Recorded before the registry existed (or before an item was added): read it now.
    const model = registryModelNow();
    if (!model.items.length && !model.rules.length) return;
    impact = L.registryImpact(L.registryTouched(evidence.item_codes, evidence.spec_diff), model, "");
    if (impact && impact.items.length) impact.live = true;
  }
  if (impact && Array.isArray(impact.items) && impact.items.length) {
    slot.innerHTML = impactSheet(impact).replace("as configured when this change was recorded", impact.live ? "as configured now; this change was recorded before these items were registered" : "as configured when this change was recorded");
  }
}

/* ================= Measured precision ================= */

// Reviewer verdicts against what each monitor alerted (regmon/precision.py):
// precision and recall with a 95% range, the changes behind them, and how to
// tune the monitor's alert condition. Read in the browser from the inventory,
// the delivery ledger and the review ledger, so a new decision counts at once.
let precisionCache = { key: "", value: null };
function precisionModel() {
  const key = [state.assetSignatures.inventory, state.assetSignatures.notifications, state.assetSignatures.reviews, state.assetSignatures.config].join("|");
  if (precisionCache.key === key && precisionCache.value) return precisionCache.value;
  const value = L.precisionBuild(state.inventory, (state.notifications && state.notifications.sent_events) || {}, state.reviews || {}, configuredSources());
  precisionCache = { key, value };
  return value;
}
function percent(value) { return value === null || value === undefined ? "—" : Math.round(value * 100) + "%"; }
function precisionFigure(label, value, ci, detail) {
  if (value === null || value === undefined) return '<div class="precision-figure"><dt>' + esc(label) + '</dt><dd class="is-empty">Not measured yet<span>' + esc(detail) + "</span></dd></div>";
  const range = Array.isArray(ci) ? '<div class="precision-bar" aria-hidden="true"><i style="left:' + (ci[0] * 100).toFixed(1) + "%;right:" + (100 - ci[1] * 100).toFixed(1) + '%"></i><b style="left:calc(' +
    (value * 100).toFixed(1) + '% - 1px)"></b></div>' : "";
  return '<div class="precision-figure"><dt>' + esc(label) + "</dt><dd>" + esc(percent(value)) + "<span>" + esc(detail + (Array.isArray(ci) ? " · likely " + percent(ci[0]) + "–" + percent(ci[1]) : "")) + "</span>" + range + "</dd></div>";
}
const OUTCOME_WORDS = { tp: "Alerted · material", fp: "Alerted · not material", fn: "Quiet · material", tn: "Quiet · not material", unreviewed_alert: "Alerted · no decision", unreviewed: "Quiet · no decision" };
function precisionSheet(score, sourceId, rows) {
  if (!score) {
    return '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Alert precision</h3><div class="sheet-note">Measured from review decisions</div></div>' +
      '<button class="sheet-link" type="button" data-report-missed="' + esc(sourceId) + '">Report a missed change</button></div>' +
      '<p class="note-strip">No change on this monitor has a review decision yet. Record decisions on its changes (Material or Not material) and its precision and recall appear here.</p></section>';
  }
  const tips = (score.suggestions || []).map((tip, index) => '<div class="precision-tip"><span class="precision-tip-title">' + esc(tip.title) + "</span><p>" + esc(tip.why) + "</p>" +
    (tip.condition ? "<q>" + esc(tip.condition) + "</q>" + (tip.only ? '<p class="health-sub">Suggested with “alerts only when met”.</p>' : "") +
      '<div class="review-actions"><button class="btn" type="button" data-precision-apply="' + esc(sourceId) + '" data-precision-index="' + index + '">Use this condition</button></div>' : "") + "</div>").join("");
  const matrix = '<div class="precision-matrix" role="table" aria-label="Alerts against review decisions">' +
    '<span class="is-head" role="columnheader"></span><span class="is-head" role="columnheader">Material</span><span class="is-head" role="columnheader">Not material</span>' +
    '<span class="is-head" role="rowheader">Alerted</span><span class="is-num">' + esc(score.tp) + '</span><span class="is-num">' + esc(score.fp) + "</span>" +
    '<span class="is-head" role="rowheader">Quiet</span><span class="is-num">' + esc(score.fn) + '</span><span class="is-num">' + esc(score.tn) + "</span>" +
    (score.missed ? '<span class="is-head" role="rowheader">Missed</span><span class="is-num">' + esc(score.missed) + "</span><span></span>" : "") + "</div>";
  const recent = rows.filter(row => row.outcome !== "unreviewed").slice(0, 8);
  return '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Alert precision</h3><div class="sheet-note">' +
    esc(plural(score.reviewed, "reviewed change", "reviewed changes") + (score.unreviewed_alerts ? " · " + plural(score.unreviewed_alerts, "alert", "alerts") + " still without a decision" : "")) + "</div></div>" +
    '<button class="sheet-link" type="button" data-report-missed="' + esc(sourceId) + '">Report a missed change</button></div>' +
    '<dl class="precision-figures">' +
      precisionFigure("Precision", score.precision, score.precision_ci, score.tp + " of " + (score.tp + score.fp) + " alerts were material") +
      precisionFigure("Recall", score.recall, score.recall_ci, score.tp + " of " + (score.tp + score.fn + score.missed) + " material changes alerted") +
    "</dl>" + matrix + tips +
    (recent.length ? '<div class="registry-changes">' + recent.map(row => {
      const entry = changeById(row.event_id);
      return entry ? changeRow(entry, { compact: true }).replace('<span class="row-summary">', '<span class="row-summary"><span class="tag ' + (row.outcome === "fp" || row.outcome === "fn" ? "is-warn" : "") + '">' + esc(OUTCOME_WORDS[row.outcome] || row.outcome) + "</span> ") : "";
    }).join("") + "</div>" : "") +
    '<p class="note-strip">The range is a 95% interval: with few reviews it is wide, and it narrows as decisions accumulate. Acknowledged decisions are not counted.</p></section>';
}
function precisionFleetSheet() {
  const model = precisionModel();
  const measured = model.monitors.filter(row => row.reviewed || row.missed);
  if (!measured.length) return "";
  const totals = model.totals || {};
  return '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Alert precision</h3><div class="sheet-note">' +
    esc(plural(totals.reviewed || 0, "reviewed change", "reviewed changes") + " across " + plural(measured.length, "monitor", "monitors")) + "</div></div></div>" +
    '<dl class="precision-figures">' + precisionFigure("Precision", totals.precision, totals.precision_ci, (totals.tp || 0) + " of " + ((totals.tp || 0) + (totals.fp || 0)) + " alerts were material") +
      precisionFigure("Recall", totals.recall, totals.recall_ci, (totals.tp || 0) + " of " + ((totals.tp || 0) + (totals.fn || 0) + (totals.missed || 0)) + " material changes alerted") + "</dl>" +
    '<div class="precision-row is-head"><span>Monitor</span><span class="num">Precision</span><span class="num">Recall</span><span class="num counts">TP · FP · FN</span></div>' +
    measured.slice(0, 40).map(row => '<div class="precision-row"><button class="text-button" type="button" data-select-health="' + esc(row.source_id) + '">' + esc(row.name) + "</button>" +
      '<span class="num">' + esc(percent(row.precision)) + '</span><span class="num">' + esc(percent(row.recall)) + '</span><span class="num counts">' +
      esc(row.tp + " · " + row.fp + " · " + (row.fn + row.missed)) + "</span></div>").join("") +
    (measured.some(row => row.suggestions.length) ? '<p class="note-strip">' + esc(plural(measured.filter(row => row.suggestions.length).length, "monitor has", "monitors have")) + " a tuning suggestion. Open one to see it.</p>" : "") + "</section>";
}
function applyPrecisionSuggestion(sourceId, index) {
  const score = precisionModel().monitors.find(row => row.source_id === sourceId);
  const tip = score && score.suggestions[Number(index)];
  if (!tip || !tip.condition) return;
  openConditionDialog(sourceId);
  if (!$("conditionDialog").open) return;
  $("conditionText").value = tip.condition;
  $("conditionOnly").checked = !!tip.only;
}
let missedTarget = "";
function openMissedDialog(sourceId) {
  const source = configuredSources().find(candidate => candidate.id === sourceId) || {};
  missedTarget = sourceId;
  $("missedLede").textContent = (source.name || sourceId) + " · a change it should have caught but did not.";
  ["missedWhat", "missedEvidence", "missedSeen"].forEach(id => { $(id).value = ""; });
  $("missedUrl").value = (source.seed_urls || [])[0] || "";
  $("missedStatus").hidden = true;
  $("missedDialog").showModal();
  window.setTimeout(() => $("missedWhat").focus(), 30);
}
function submitMissed(event) {
  event.preventDefault();
  const request = L.missedChangeRequest({ monitor: missedTarget, url: $("missedUrl").value, seenOn: $("missedSeen").value, what: $("missedWhat").value, evidence: $("missedEvidence").value });
  if (request.errors.length) { $("missedStatus").textContent = request.errors.join(" "); $("missedStatus").hidden = false; return; }
  const params = new URLSearchParams();
  params.set("title", request.title);
  params.set("body", request.body);
  $("missedDialog").close();
  openGitHubRequest(REPO + "/issues/new?" + params.toString(), "Submit the prefilled request on GitHub. The miss counts in this monitor's recall about a minute after it is recorded.");
}

/* ================= Visual diff ================= */

// Screenshots of a browser-rendered page (regmon/visual.py): the previous and
// new render under a divider, with the changed regions marked on the new one.
function visualSummary(visual) {
  const share = Number(visual.changed_ratio);
  return (Number.isFinite(share) ? (share < 0.001 ? "Under 0.1%" : (share * 100).toFixed(share < 0.1 ? 1 : 0) + "%") + " of the page looks different" : "Visual comparison") +
    " · " + plural(Number(visual.region_count) || 0, "region", "regions") + ". Drag the divider; Marked regions outlines what moved.";
}
function visualCompare(visual) {
  const before = visual.before ? snapshotURL(visual.before) : "", after = visual.after ? snapshotURL(visual.after) : "", overlay = visual.overlay ? snapshotURL(visual.overlay) : "";
  if (!before || !after) return '<p class="rl-empty">This change has no pair of screenshots to compare.</p>';
  // Open with the divider just left of the first changed region, so the change shows on the new side.
  const width = Array.isArray(visual.size_after) ? Number(visual.size_after[0]) : 0;
  const first = Array.isArray(visual.regions) && visual.regions.length ? visual.regions.slice().sort((a, b) => a[0] - b[0])[0] : null;
  const start = width && first ? Math.max(2, Math.min(90, Math.floor(first[0] / width * 100) - 2)) : 50;
  return '<div class="visual-diff" data-visual-diff><div class="visual-tools"><label class="field-check"><input type="checkbox" data-visual-marks' + (overlay ? " checked" : " disabled") + "> Marked regions</label>" +
    '<input class="visual-range" type="range" min="0" max="100" value="' + start + '" aria-label="Divider between the previous and the new screenshot" data-visual-range></div>' +
    '<div class="visual-stage"><img class="visual-before" alt="Previous screenshot" loading="lazy" src="' + esc(before) + '">' +
    '<img class="visual-after" alt="New screenshot" src="' + esc(overlay || after) + '" data-plain="' + esc(after) + '" data-marked="' + esc(overlay) + '" style="clip-path: inset(0 0 0 ' + start + '%)">' +
    '<span class="visual-divider" style="left:' + start + '%" aria-hidden="true"></span></div>' +
    '<div class="visual-legend"><span>Previous</span><span>New</span></div></div>';
}
document.addEventListener("input", event => {
  const range = event.target.closest && event.target.closest("[data-visual-range]");
  if (!range) return;
  const box = range.closest("[data-visual-diff]");
  const value = Number(range.value);
  box.querySelector(".visual-after").style.clipPath = "inset(0 0 0 " + value + "%)";
  box.querySelector(".visual-divider").style.left = value + "%";
});
document.addEventListener("change", event => {
  const marks = event.target.closest && event.target.closest("[data-visual-marks]");
  if (!marks) return;
  const image = marks.closest("[data-visual-diff]").querySelector(".visual-after");
  image.src = marks.checked && image.dataset.marked ? image.dataset.marked : image.dataset.plain;
});

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
// One element per line: a multi-megabyte page or schema is capped rather than
// turned into hundreds of thousands of nodes in one write.
const SOURCE_LINE_LIMIT = 20000;
function renderSourceCode(source) {
  const lines = String(source || "").split(/\r?\n/);
  const shown = lines.slice(0, SOURCE_LINE_LIMIT);
  return '<div class="source-code" role="region" aria-label="Saved source">' +
    shown.map((line, index) => '<div class="source-line"><span class="line-no">' + (index + 1) + "</span><code>" + (esc(line) || " ") + "</code></div>").join("") + "</div>" +
    (lines.length > shown.length ? '<p class="wb-notes">Showing the first ' + SOURCE_LINE_LIMIT.toLocaleString() + " of " + lines.length.toLocaleString() + " lines. The evidence file and the extracted text hold the rest.</p>" : "");
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
  // With its scripts gone, a page would otherwise stay in its no-JS styling.
  source = L.withJsClass(source);
  // The frame keeps allow-same-origin (to mark and measure the page), so also
  // drop what could navigate it or embed other content: nested frames,
  // plugins and meta refresh. Not executable today, but one sandbox
  // relaxation away from it.
  source = source.replace(/<(iframe|frame|object|embed|applet)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(iframe|frame|frameset|object|embed|applet)\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
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
    (source && source.id ? organiseTags(source) : "") +
    "<span>Checked " + esc(relativeTime(item.last_checked).toLowerCase()) + "</span>" + urlMeta(item.canonical_url);
  const actions = externalLink(item.canonical_url, "Open live page") +
    (snapshotPath ? externalLink(REPO + "/blob/main/" + snapshotPath, savedFileLabel) : "") +
    (item.source_id ? '<button class="btn" type="button" data-run-scan="' + esc(item.source_id) + '" title="Scan this page\'s source now">Scan this source</button>' : "") +
    (conditionEditable(source) ? '<button class="btn" type="button" data-edit-condition="' + esc(source.id) + '" title="Set what should raise an alert for this monitor">' + (source.alert_condition ? "Edit alert condition" : "Alert me when…") + "</button>" : "") +
    (source && source.id && source.active !== false ? '<button class="btn" type="button" data-edit-schedule="' + esc(source.id) + '" title="How often and when this monitor is scanned">Scan schedule</button>' : "") +
    (source && source.id && source.active !== false ? '<button class="btn" type="button" data-edit-organise="' + esc(source.id) + '" title="Workspace and labels">Labels</button>' : "") +
    '<button class="btn" type="button" data-find-similar="' + esc(item.url_id) + '" title="Find pages like this one on the regulator\'s site">Find similar</button>' +
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
  const isWorkbook = ["xlsx", "xls", "ods"].indexOf(fileType) >= 0;
  const isFile = filePath && (fileType === "pdf" || fileType === "zip" || isWorkbook);
  const isPdf = fileType === "pdf";
  // Without a saved original, a workbook or CSV is drawn from its extracted text, and XML as its source.
  const sheetFromText = !isFile && !item.html_snapshot_location && item.snapshot_location && (isWorkbook || fileType === "csv");
  const xmlFromText = !isFile && !item.html_snapshot_location && item.snapshot_location && fileType === "xml";
  const previewLabel = isFile ? (isPdf ? "PDF" : isWorkbook ? "Workbook" : "Archive") : sheetFromText ? (fileType === "csv" ? "Table" : "Workbook") : xmlFromText ? "XML" : "Rendered page";
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
      await renderDocument(canvas.querySelector(".doc-host"), { bytes, name: filePath, title: "The original " + (isWorkbook ? "workbook" : "bundle") + " as fetched", url: item.canonical_url, alive: current });
    } catch (error) {
      if (current()) canvas.innerHTML = emptyState("Couldn't load the saved file", String(error.message || error) + ". The extracted text may still be available.", externalLink(REPO + "/blob/main/" + filePath, "Saved file"));
    }
    return;
  }
  if (sheetFromText || xmlFromText) {
    try {
      const text = await readSnapshotFile(item.snapshot_location, state.snapshotCache);
      if (!current() || state.snapshotMode !== "preview") return;
      if (xmlFromText) {
        canvas.innerHTML = '<p class="snapshot-note snapshot-caveat">The XML as compared: canonical form, attributes in a fixed order and layout normalised.</p>' + renderSourceCode(text);
      } else {
        canvas.innerHTML = '<p class="snapshot-note snapshot-caveat">Drawn from the extracted cells; rows are numbered in order of the filled rows.</p><div class="doc-host doc-host-inline"></div>';
        renderWorkbook(canvas.querySelector(".doc-host"), L.workbookFromText(text, item.title || "Sheet1"), {});
      }
    } catch (error) {
      if (current()) canvas.innerHTML = emptyState("Couldn't load the saved copy", String(error.message || error));
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
    ["Workspace", (ws => ws.name + (ws.auto ? " (from the regulator's region)" : ""))(sourceWorkspace(source))],
    ["Labels", sourceLabels(source).join(", ") || "None"],
    ["Alerts", source.shadow ? "Shadow mode: changes are recorded without alerts" : "Sent for relevant changes"],
    ["Loaded with", FETCH_MODE_WORDS[sourceLoading(source).fetch_mode] + (item.rendered_by === "browser" && item.browser ? " · last render blocked " + plural(Number(item.browser.blocked_requests || 0), "request", "requests") + (item.browser.consent ? ", cookie banner: " + item.browser.consent.replace(/^\w+:/, "") : "") : "") +
      (sourceLoading(source).browser_actions.length ? " · " + plural(sourceLoading(source).browser_actions.length, "recorded step", "recorded steps") : "") +
      (item.visual && Number.isFinite(Number(item.visual.changed_ratio)) && item.visual.changed_ratio !== null ? " · last screenshot " + (Number(item.visual.changed_ratio) * 100).toFixed(1) + "% different" : "")],
    ["Bot check", item.browser && item.browser.passed_check && !item.fetch_error ? (/^HTTP \d/.test(item.browser.passed_check)
        ? "Plain requests were refused (" + item.browser.passed_check.replace(/ refusal$/, "") + "); loaded in a browser on the last scan"
        : item.browser.passed_check + " check passed automatically in a browser on the last scan")
      : item.bot_check ? item.bot_check.vendor + " challenge, " + fmt(item.bot_check.captured_at) + " (" + (item.bot_check.via === "browser" ? "still shown in the browser" : "plain request") + ")" +
        (blockWait(item) && blockWait(item).waiting ? " · retrying automatically every scan" : "") : "None seen"],
    ["Fetch error", item.fetch_error || (isPlainObject(item.fetch_warning)
      ? "None confirmed · last scan got " + String(item.fetch_warning.message || "an error").replace(/^\w+: /, "").replace(/ for https?:\/\/\S+/, "") +
        " after rechecks; the last good copy was kept and the next scan confirms it"
      : "None")], ["Extraction error", item.extraction_error || "None"],
    ["Text fingerprint (SHA-256)", item.normalized_hash || "Not available", true], ["Saved HTML fingerprint", item.html_hash || "Not available", true],
    ["Response fingerprint", item.raw_hash || "Not available", true],
    ["Text snapshot", item.snapshot_location || "Not saved", true], ["HTML snapshot", item.html_snapshot_location || "Not saved", true],
    ["Original file", item.file_snapshot_location || "Not saved", true],
    ["Saved bot-check page", item.bot_check && item.bot_check.location ? item.bot_check.location : "None", true]
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
  else if (state.detailTab === "links") renderPageLinks(item);
  else renderDetails(item);
  if (pane) pane.scrollTop = 0;
}

/* ================= Link lineage =================
 * data/link-lineage.json records, for every HTML page the scans read, each link
 * it lists: when it was first seen there and, once the page drops it, when it
 * was removed. The Links tab shows where a page's address is (or was) listed,
 * what the page itself lists and has dropped, and looks up any address, so a
 * link a regulator deletes can always be traced to the page it was on.
 */
let linkLineagePromise = null, linkLineageAt = 0;
function loadLinkLineage() {
  if (linkLineagePromise && Date.now() - linkLineageAt < 5 * 60 * 1000) return linkLineagePromise;
  linkLineageAt = Date.now();
  const read = url => fetch(url, { cache: "no-cache" }).then(response => {
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  });
  // The published dashboard carries the record; a copy without it (or an older
  // deploy) answers 404, which is not "no record": the repository is asked next.
  linkLineagePromise = read(new URL("./data/link-lineage.json", document.baseURI).href)
    .then(data => data || read(RAW + "/data/link-lineage.json"))
    .catch(() => read(RAW + "/data/link-lineage.json"))
    .then(data => data && typeof data === "object" && data.pages ? data : { pages: {}, events: [] })
    .catch(error => { linkLineagePromise = null; throw error; });
  return linkLineagePromise;
}
function lineageDay(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
function lineagePageLabel(url) {
  const item = state.items.find(candidate => L.urlKey(candidate.canonical_url) === L.urlKey(url));
  const label = item ? itemTitle(item) : displayUrl(url);
  return item ? '<button class="text-button lineage-page" type="button" data-open-page="' + esc(item.url_id) + '" data-open-tab="links">' + esc(label) + "</button>"
    : '<span class="lineage-page">' + esc(label) + "</span>";
}
function lineageListingRow(row) {
  const when = row.removedAt
    ? '<span class="tag tone-problem">Removed ' + esc(lineageDay(row.removedAt)) + "</span>"
    : '<span class="tag tone-new">Listed now</span>';
  const since = row.firstSeen && row.firstSeen === row.trackingSince ? "listed when tracking began, " + lineageDay(row.firstSeen) : "first listed " + lineageDay(row.firstSeen);
  return '<li class="lineage-row">' + when + '<div class="lineage-main"><span>on ' + lineagePageLabel(row.page) + "</span>" +
    '<small>' + (row.text ? "as “" + esc(row.text) + "” · " : "") + esc(since) + (row.removedAt ? " · last seen in the scan before " + esc(lineageDay(row.removedAt)) : "") + "</small></div>" +
    externalLink(row.page, "Open page", "sheet-link") + "</li>";
}
function lineageLinkRow(row, kind) {
  const tag = kind === "removed" ? '<span class="tag tone-problem">Removed ' + esc(lineageDay(row.removedAt)) + "</span>"
    : kind === "added" ? '<span class="tag tone-new">Added ' + esc(lineageDay(row.firstSeen)) + "</span>" : "";
  return '<li class="lineage-row">' + tag + '<div class="lineage-main"><span class="lineage-link-text">' + esc(row.text || L.pickSlug(row.url)) + "</span>" +
    '<small class="lineage-url">' + esc(displayUrl(row.url)) + "</small></div>" + externalLink(row.url, "Open", "sheet-link") + "</li>";
}
function lineageSearchHtml(rows, query) {
  if (!String(query || "").trim()) return '<p class="lineage-hint">Type part of an address or link text, for example <code>fr2028</code> or <code>user guide</code>.</p>';
  if (!rows.length) return '<p class="lineage-hint">No monitored page lists, or has listed since tracking began, an address matching “' + esc(query) + "”. Pages are tracked from the first scan that reads them.</p>";
  return '<ul class="lineage-list">' + rows.map(row => '<li class="lineage-row">' +
    (row.removedAt ? '<span class="tag tone-problem">Removed ' + esc(lineageDay(row.removedAt)) + "</span>" : '<span class="tag tone-new">Listed now</span>') +
    '<div class="lineage-main"><span class="lineage-link-text">' + esc(row.text || L.pickSlug(row.url)) + '</span><small class="lineage-url">' + esc(displayUrl(row.url)) + "</small>" +
    "<small>on " + lineagePageLabel(row.page) + "</small></div>" + externalLink(row.url, "Open", "sheet-link") + "</li>").join("") + "</ul>";
}
// The Lineage tab: where this address is listed (checked live on every open,
// and as recorded by the scans), what the page itself lists and has dropped,
// and a lookup for any address.
async function renderPageLinks(item) {
  const body = $("detailBody");
  const id = item.url_id;
  const still = () => state.view === "monitors" && selectedItem() && selectedItem().url_id === id && state.detailTab === "links";
  body.innerHTML = '<section class="sheet"><div class="loading">Reading the lineage record…</div></section>';
  let lineage;
  try { lineage = await loadLinkLineage(); } catch (error) {
    if (still()) body.innerHTML = '<section class="sheet">' + emptyState("The lineage record couldn't be loaded", String(error.message || error)) + "</section>";
    return;
  }
  if (!still()) return;
  const source = configuredSources().find(candidate => candidate.id === item.source_id) || {};
  const listedOn = Array.isArray(source.listed_on) ? source.listed_on.map(String) : [];
  const listings = L.linkListings(lineage, item.canonical_url);
  const own = L.pageLinkLineage(lineage, item.canonical_url);
  const isPage = String(item.extraction_type || "") === "html";
  const livePages = [];
  listedOn.concat(listings.filter(row => !row.removedAt).map(row => row.page)).forEach(page => {
    if (livePages.length < 5 && !livePages.some(known => L.urlKey(known) === L.urlKey(page))) livePages.push(page);
  });
  const sheets = [];
  const liveHtml = livePages.length && PAGE_READER_ENDPOINT
    ? '<h4 class="lineage-h">Right now</h4><ul class="lineage-list">' + livePages.map((page, index) => '<li class="lineage-row" data-lineage-live="' + index + '">' +
        '<span class="tag">Checking…</span><div class="lineage-main"><span>on ' + lineagePageLabel(page) + "</span><small>Reading the page now…</small></div>" + externalLink(page, "Open page", "sheet-link") + "</li>").join("") + "</ul>"
    : "";
  const recorded = listings.length ? '<h4 class="lineage-h">Recorded by the scans</h4><ul class="lineage-list">' + listings.map(lineageListingRow).join("") + "</ul>" : "";
  const waiting = listedOn.filter(page => !listings.some(row => L.urlKey(row.page) === L.urlKey(page)));
  const unknown = !listings.length && !listedOn.length;
  sheets.push('<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Where this address is listed</h3>' +
    '<div class="sheet-note">' + (unknown ? "Not known yet." : "The pages that list this link: checked now, and as each scan recorded them (first listed, removed).") + "</div></div></div>" +
    '<div class="sheet-body lineage-body">' + liveHtml + recorded +
    (waiting.length ? '<p class="lineage-hint">' + esc(plural(waiting.length, "listing page is", "listing pages are")) + " recorded from the next scan of this monitor: " + waiting.map(page => esc(displayUrl(page))).join(", ") + ".</p>" : "") +
    (unknown ? '<p class="lineage-hint">No monitored page lists this address, and this monitor doesn’t know which page lists it. Name that page below (the forms or documents page you found it on): each scan then reads it and records when this link is listed, renamed or removed.</p>' : "") +
    '<details class="lineage-name"' + (unknown ? " open" : "") + "><summary>" + (unknown ? "Which page lists this link?" : "Track another page that lists it") + "</summary>" +
      '<form class="lineage-form" id="lineageForm"><input class="field-input" id="lineagePage" type="url" required placeholder="https://… the page that lists this link" autocomplete="off" spellcheck="false">' +
      '<button class="btn" type="submit">Check the page</button></form><div id="lineageCheck" aria-live="polite"></div></details>' +
    "</div></section>");
  if (own) {
    const content = own.current.filter(row => !row.menu);
    sheets.push('<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Links on this page</h3>' +
      '<div class="sheet-note">' + esc(plural(content.length, "link", "links")) + " in its content, " + esc(plural(own.current.length - content.length, "menu link", "menu links")) +
      " · tracked since " + esc(lineageDay(own.trackingSince)) + " · read " + esc(relativeTime(own.lastScan).toLowerCase()) + "</div></div></div><div class=\"sheet-body lineage-body\">" +
      '<h4 class="lineage-h">Removed from this page · ' + own.removed.length + "</h4>" +
      (own.removed.length ? '<ul class="lineage-list">' + own.removed.slice(0, 200).map(row => lineageLinkRow(row, "removed")).join("") + "</ul>" : '<p class="lineage-hint">No link has been removed since tracking began.</p>') +
      '<h4 class="lineage-h">Added since tracking began · ' + own.added.length + "</h4>" +
      (own.added.length ? '<ul class="lineage-list">' + own.added.slice(0, 200).map(row => lineageLinkRow(row, "added")).join("") + "</ul>" : '<p class="lineage-hint">No new links since tracking began.</p>') +
      '<details class="lineage-all"><summary>Every link it lists now (' + own.current.length + ")</summary>" +
      '<ul class="lineage-list">' + own.current.slice(0, 1500).map(row => lineageLinkRow(row, "")).join("") + "</ul></details>" +
      "</div></section>");
  } else if (isPage) {
    sheets.push('<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Links on this page</h3>' +
      '<div class="sheet-note">Recorded from the next scan that reads this page in full; nothing to do.</div></div></div></section>');
  }
  sheets.push('<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Look up any address</h3>' +
    '<div class="sheet-note">Find which page listed a link, and when it was removed.</div></div></div><div class="sheet-body lineage-body">' +
    '<input class="field-input lineage-search" id="lineageSearch" type="search" placeholder="Part of an address or link text" autocomplete="off" spellcheck="false">' +
    '<div id="lineageResults">' + lineageSearchHtml([], "") + "</div></div></section>");
  body.innerHTML = sheets.join("");
  const input = $("lineageSearch");
  let timer = 0;
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { $("lineageResults").innerHTML = lineageSearchHtml(L.linkLineageSearch(lineage, input.value, 200), input.value); }, 150);
  });
  $("lineageForm").addEventListener("submit", event => {
    event.preventDefault();
    const page = safeHttpUrl($("lineagePage").value.trim());
    if (!page) { $("lineageCheck").innerHTML = '<p class="lineage-hint">Enter the full address of the page, beginning with https://.</p>'; return; }
    lineageCheckPage(item, page, still);
  });
  // Every open reads the listing pages again, so what is shown is today's page.
  livePages.forEach((page, index) => {
    lineageLinksOf(page).then(result => {
      const row = body.querySelector('[data-lineage-live="' + index + '"]');
      if (!row || !still()) return;
      const found = result.links ? result.links.find(link => L.urlKey(link.url) === L.urlKey(item.canonical_url)) : null;
      row.querySelector(".tag").outerHTML = result.error ? '<span class="tag">Not checked</span>'
        : found ? '<span class="tag tone-new">Listed now</span>' : '<span class="tag tone-problem">Not listed now</span>';
      row.querySelector("small").textContent = result.error ? "Couldn’t read the page: " + result.error
        : found ? (found.text ? "as “" + found.text + "” · " : "") + "checked just now" : "The page doesn’t link to this address today · checked just now";
    });
  });
}
// The links a page lists, read now through the page reader (links only).
async function lineageLinksOf(page) {
  try {
    const data = await addReadPage(page, { mode: "links", fresh: true });
    if (data.kind !== "page") return { error: data.message || "the site didn’t return a page" };
    return { links: data.links || [], title: data.title || "" };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}
async function lineageCheckPage(item, page, still) {
  const slot = $("lineageCheck");
  slot.innerHTML = '<div class="loading">Reading ' + esc(displayUrl(page)) + "…</div>";
  const result = await lineageLinksOf(page);
  if (!still() || !$("lineageCheck")) return;
  if (result.error) { slot.innerHTML = '<p class="lineage-hint">That page couldn’t be read: ' + esc(result.error) + ". You can still track it; the scans read it from GitHub.</p>" + lineageTrackHtml(item, page, []); return; }
  const keys = new Set(result.links.map(link => L.urlKey(link.url)));
  const found = result.links.find(link => L.urlKey(link.url) === L.urlKey(item.canonical_url));
  // Other monitored links that page lists: tracked in the same request if wanted.
  const others = [];
  state.items.forEach(candidate => {
    if (candidate.active === false || candidate.url_id === item.url_id || !keys.has(L.urlKey(candidate.canonical_url))) return;
    const src = configuredSources().find(entry => entry.id === candidate.source_id);
    if (!src || src.active === false || (src.seed_urls || []).length !== 1) return;
    if ((src.listed_on || []).some(url => L.urlKey(url) === L.urlKey(page))) return;
    if (!others.some(entry => entry.id === src.id)) others.push(src);
  });
  slot.innerHTML = '<p class="lineage-hint">' + (found ? "Found: <strong>" + esc(result.title || displayUrl(page)) + "</strong> lists this link" + (found.text ? " as “" + esc(found.text) + "”" : "") + "."
    : "<strong>" + esc(result.title || displayUrl(page)) + "</strong> doesn’t link to this address today. If it used to, track it anyway: a link that comes back is recorded too.") + "</p>" +
    lineageTrackHtml(item, page, others);
  slot.querySelector("[data-lineage-track]").addEventListener("click", () => {
    const also = slot.querySelector("[data-lineage-also]");
    const sources = [configuredSources().find(entry => entry.id === item.source_id)].concat(also && also.checked ? others : []).filter(Boolean);
    const payloads = L.listedOnPayloads(sources, page);
    if (!payloads.length) { showToast("That page is already tracked for this link."); return; }
    const requests = [].concat(...payloads.map(payload => L.settingsRequests(payload, "track where links are listed → " + displayUrl(page))));
    requests.slice(1).forEach(request => {
      const params = new URLSearchParams(); params.set("title", request.title); params.set("body", request.body);
      window.open(REPO + "/issues/new?" + params.toString(), "_blank");
    });
    const params = new URLSearchParams(); params.set("title", requests[0].title); params.set("body", requests[0].body);
    openGitHubRequest(REPO + "/issues/new?" + params.toString(), "Submit the prefilled request on GitHub. From the next scan, " + displayUrl(page) + " is read for its links and this link's lineage is recorded.");
  });
}
function lineageTrackHtml(item, page, others) {
  return '<div class="lineage-track">' +
    (others.length ? '<label class="field-check"><input type="checkbox" data-lineage-also checked> Also for the ' + esc(plural(others.length, "other monitored link", "other monitored links")) + " this page lists</label>" : "") +
    '<button class="btn btn-primary" type="button" data-lineage-track>Track ' + esc(displayUrl(page)) + "</button></div>";
}
// A change to a page: the links it gained and lost in that scan.
async function fillChangeLinks(entry, slotId, stillCurrent) {
  if (!entry || ["CHANGED_URL", "HTML_SOURCE_CHANGED"].indexOf(entry.event_type) < 0) return;
  let lineage;
  try { lineage = await loadLinkLineage(); } catch (_) { return; }
  const slot = document.getElementById(slotId);
  if (!slot || !stillCurrent()) return;
  const events = L.linkEventsAt(lineage, entry.url, entry.timestamp);
  if (!events.length) return;
  const removed = events.filter(event => event.change === "removed");
  const added = events.filter(event => event.change !== "removed");
  const row = (event, kind) => lineageLinkRow({ url: event.url, text: event.text, firstSeen: event.at, removedAt: event.at }, kind);
  slot.innerHTML = '<section class="sheet"><div class="sheet-head"><div><h3 class="sheet-title">Links in this change</h3>' +
    '<div class="sheet-note">' + esc([removed.length ? plural(removed.length, "link removed", "links removed") : "", added.length ? plural(added.length, "link added", "links added") : ""].filter(Boolean).join(", ")) +
    " · kept in the lineage record, so each can be traced to this page later</div></div></div><div class=\"sheet-body lineage-body\"><ul class=\"lineage-list\">" +
    removed.map(event => row(event, "removed")).join("") + added.map(event => row(event, "added")).join("") + "</ul></div></section>";
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
  if (state.selectedNotificationId === SHADOW_KEY) return renderShadowDetail(pane);
  if (state.selectedNotificationId.indexOf(DIGEST_PREFIX) === 0) return renderDigestDetail(pane);
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
    detailHeading({ back: true, source: [notificationKind(item.kind), notificationTopicLine(item)].filter(Boolean).join(" · "), title: notificationTitle(item), meta, actions: externalLink(item.url, "Open page") }) +
    '<section class="sheet"><dl class="facts">' + fields.filter(([, value]) => value).map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") +
    '<div><dt>' + esc(item.queued ? "Delivered so far" : "Delivered to") + "</dt><dd>" + esc(deliveredChannels(item).map(channelLabel).join(", ") || (item.queued ? "Not yet" : "ntfy")) + "</dd></div>" +
    (item.condition ? "<div><dt>Alert condition</dt><dd>" + esc(item.condition) + "</dd></div>" : "") +
    (item.queued && deliveryAttempts(item) ? "<div><dt>Failed attempts</dt><dd>" + esc(String(deliveryAttempts(item)) + (item.first_failed_at ? " since " + fmt(item.first_failed_at) : "")) + "</dd></div>" : "") +
    (item.queued && deliveryErrors(item).length ? '<div><dt>Last error</dt><dd class="is-code">' + deliveryErrors(item).map(esc).join("<br>") + "</dd></div>" : "") +
    "</dl>" + '<details class="tech-details"><summary>Technical details</summary><dl class="facts"><div><dt>Event ID</dt><dd class="is-code">' + esc(item.eventId) + "</dd></div></dl></details>" +
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
  protected: { label: "Protected site · retrying", tone: "pending", order: 1 },
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
function healthProtected(sourceId) {
  const rows = state.health && Array.isArray(state.health.protected) ? state.health.protected : [];
  return sourceId == null ? rows : rows.filter(row => String(row.source_id) === String(sourceId));
}
function protectedWords(rows) {
  const first = rows[0] || {};
  return "Blocked by " + (first.reason || "a " + (first.vendor || "bot") + " bot check") + " · retrying automatically every scan" + (first.has_baseline === false ? " · first copy pending" : " · last good copy kept");
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
  if (monitor.status === "protected") return protectedWords(healthProtected(String(monitor.source_id)));
  if (monitor.status === "stale") return "Overdue · last saved scan " + (monitor.last_scan ? relativeTime(monitor.last_scan).toLowerCase() : "not recorded") + (monitor.cadence && monitor.cadence.every_hours > 6 ? " · " + monitor.cadence.label.toLowerCase() : "");
  const checks = Number(monitor.checks_7d || 0), failed = Number(monitor.failures_7d || 0);
  const checkWords = failed ? failed + " of " + checks + " checks failed this week" : checks ? "All " + checks + " checks ok this week" : "Not checked this week";
  if (light === "on" || light === "warn") return checkWords + " · " + healthDays(monitor).replace(/^No change since it was added/, "never changed");
  return checkWords + " · " + (monitor.last_change ? healthDays(monitor).toLowerCase() : "never changed");
}
const HEALTH_LIST_GROUPS = [
  ["attention", "Needs attention", ["bad", "stale"]], ["retrying", "Retrying automatically", ["guard"]], ["recovered", "Recovered this week", ["warn"]],
  ["changed", "Changed this week", ["on"]], ["quiet", "Quiet for weeks", ["quiet"]], ["ok", "Healthy", ["ok"]]
];
function healthRow(monitor, light) {
  const key = String(monitor.source_id);
  const tone = { bad: "problem", stale: "pending", quiet: "pending", warn: "pending", guard: "pending", on: "change", ok: "ok" }[light] || "ok";
  const year = healthYearFlag(key);
  return '<button class="row hx-row" type="button" data-select-health="' + esc(key) + '"' + (key === state.selectedHealthKey ? ' aria-selected="true" aria-current="true"' : "") + ">" +
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
  let html = '<button class="row" type="button" data-select-health="fleet"' + (fleetSelected ? ' aria-selected="true" aria-current="true"' : "") + ">" +
    '<span class="row-mark tone-' + (totals.failing ? "problem" : "ok") + '" aria-hidden="true"></span>' +
    '<span class="row-title">All monitors</span><span class="row-time">' + esc(healthPercent(week.success_rate)) + "</span>" +
    '<span class="row-summary">' + esc(healthNumber(totals.monitors) + " monitors, " + healthNumber(week.checks) + " checks and " + healthNumber(week.alerts_sent) + " alerts in 7 days") + "</span></button>";
  const now = Date.now();
  renderScopeBars();
  const lit = healthMonitors().filter(monitor => inScope(String(monitor.source_id))).map(monitor => ({ monitor, light: L.healthLight(monitor, now) }));
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
      precisionFleetSheet() +
      healthMatrix(health) +
      '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Daily activity</h3><span class="sheet-note">Last ' + esc(String((health.daily || []).length)) + " days, UTC · " + (isCompact() ? "tap" : "hover") + " a day</span></div>" + healthChart(health.daily) + "</section>" +
      healthScheduleSheet(health) +
      (failing.length ? '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Failing now</h3></div>' + failing.map(row =>
        '<button class="row" type="button" data-select-health="' + esc(row.source_id) + '"><span class="row-mark tone-problem" aria-hidden="true"></span>' +
        '<span class="row-title">' + esc(row.name || row.source_id) + '</span><span class="row-time">' + esc(row.since ? relativeTime(row.since) : "") + "</span>" +
        '<span class="row-summary">' + esc(row.error || "") + "</span></button>").join("") + "</section>" : "") +
      protectedSheet(healthProtected()) +
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
    ["Next scan", nextScanWords(key) || "Not recorded"],
    ["Workspace", (ws => ws.name + (ws.auto ? " (region)" : ""))(sourceWorkspace(source))],
    ["Labels", sourceLabels(source).join(", ") || "None"]
  ];
  const actions = (item ? '<button class="btn" type="button" data-monitor-id="' + esc(item.url_id) + '">Open page</button>' : "") +
    '<button class="btn" type="button" data-run-scan="' + esc(key) + '">Scan this source</button>' +
    (source.id && source.active !== false ? '<button class="btn" type="button" data-edit-schedule="' + esc(key) + '">Scan schedule</button>' : "") +
    (source.id && source.active !== false ? '<button class="btn" type="button" data-edit-organise="' + esc(key) + '">Labels</button>' : "") +
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
      (monitor.status !== "failing" && monitor.status !== "protected" && Number(monitor.failures_7d) > 0 ? '<span class="tag tone-pending">Recovered · ' + esc(plural(Number(monitor.failures_7d), "failure", "failures")) + " this week</span>" : "") +
      "<span>" + esc(healthRegulator(monitor).name || monitor.regulator || "") + "</span>", actions }) +
    healthMonitorPulse(monitor, health) + failureSheet + protectedSheet(healthProtected(key)) + yearSheet +
    precisionSheet(precisionModel().monitors.find(row => row.source_id === key) || null, key, precisionModel().outcomes.filter(row => row.source_id === key)) + healthPageStrip(key) +
    '<section class="sheet"><dl class="facts">' + facts.map(([label, value]) => "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl></section></div>";
}
// Sites showing a bot check, grouped by host: calm, because the scan retries
// them itself and keeps the last good copy; an alert follows only if it lasts.
function protectedSheet(rows) {
  if (!rows.length) return "";
  const sites = new Map();
  rows.forEach(row => {
    let host = "";
    try { host = new URL(String(row.url || "")).hostname; } catch (_) { host = String(row.url || ""); }
    if (!sites.has(host)) sites.set(host, []);
    sites.get(host).push(row);
  });
  const grace = Number(((state.health || {}).thresholds || {}).bot_check_grace_hours || L.BOT_CHECK_GRACE_HOURS);
  return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Retrying automatically</h3><span class="sheet-note">Nothing to do yet</span></div><dl class="facts">' +
    Array.from(sites.entries()).map(([host, group]) => {
      const since = group.map(row => row.since).filter(Boolean).sort()[0];
      const pending = group.filter(row => row.has_baseline === false).length;
      return "<div><dt>" + esc(host) + "</dt><dd>" + esc(plural(group.length, "page", "pages") + " blocked by " + (group[0].reason || "a " + (group[0].vendor || "bot") + " bot check") + (since ? ", since " + relativeTime(since).toLowerCase() : "")) +
        '<br><span class="health-sub">' + esc("Each scan opens these in a browser to get past it" + (pending ? "; " + plural(pending, "page is", "pages are") + " still waiting for a first copy" : "; the last good copy stays the baseline meanwhile")) + "</span></dd></div>";
    }).join("") + '</dl><p class="note-strip">You are alerted once per site, and only if a block lasts ' + esc(plural(grace, "hour", "hours")) + ".</p></section>";
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
    : totals.protected ? (Number(totals.monitors) - Number(totals.protected)) + " of " + healthNumber(totals.monitors) + " monitors working · " + plural(totals.protected, "retrying a bot check", "retrying bot checks")
    : "All " + healthNumber(totals.monitors) + " monitors working now";
  // "Healthy" next to hundreds of failed checks read as a contradiction: say
  // that the failures this week have all recovered.
  const recovered = !totals.failing && !totals.stale && Number(week.failed_checks) > 0
    ? healthNumber(week.failed_checks) + " checks failed this week and recovered" : "";
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
      '<div class="hx-sub">' + esc([recovered, lastScan ? "Last scan " + relativeTime(lastScan).toLowerCase() : "", healthNextScanWords(state.pendingScan), healthNumber(totals.pages) + " pages and documents"].filter(Boolean).join(" · ")) + "</div></div>" +
    '<div class="hx-stats">' +
      stat("Checks, 7 days", healthNumber(week.checks), healthDial(daily, "checks", "is-ink", d => plural(Number(d.checks) || 0, "check", "checks") + (Number(d.failed_checks) ? ", " + d.failed_checks + " failed" : "")), healthNumber(week.failed_checks) + " failed") +
      stat("Changes", healthNumber(week.changes), healthDial(daily, "changes", "is-on", d => plural(Number(d.changes) || 0, "change", "changes")), "text changes and removals") +
      stat("Alerts sent", healthNumber(week.alerts_sent), healthDial(daily, "alerts_sent", "is-accent", d => plural(Number(d.alerts_sent) || 0, "alert", "alerts")), "test alerts not counted") +
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
  // The year after the newest one in the address (it was "this year", which is
  // the same address in the usual case, and an older one for a future year).
  const next = String(year + 1);
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
// Suggestions drawn from the page itself (its saved text and the links on it,
// see L.conditionSuggestionsFrom); shown at once from the address and
// refined when the saved copy has loaded. The owner edits or replaces them.
function conditionChips(list) {
  return list.map(text => '<button class="chip" type="button" data-condition-suggestion="' + esc(text) + '">' + esc(text) + "</button>").join("");
}
function renderConditionSuggestions(source) {
  const item = state.items.find(candidate => candidate.source_id === source.id);
  const format = L.pickFormat(String((source.seed_urls || [])[0] || ""));
  $("conditionSuggestions").innerHTML = conditionChips(L.conditionSuggestionsFrom({ title: item ? itemTitle(item) : source.name }, { format }));
  if (!item || !item.snapshot_location) return;
  readSnapshotFile(item.snapshot_location, state.snapshotCache).then(text => {
    if (state.pendingCondition !== source.id || !$("conditionDialog").open) return;
    $("conditionSuggestions").innerHTML = conditionChips(L.conditionSuggestionsFrom({ title: itemTitle(item), text }, { format }));
  }).catch(() => {});
}
function renderReviewConditionSuggestions() {
  const box = $("reviewConditionSuggestions");
  if (!box) return;
  const a = state.add;
  const page = a.page || a.pages.get(L.urlKey(a.url || "")) || {};
  const ticked = Array.from(a.picked.values());
  // The ticked links speak loudest; the starting page and the other links found give context.
  const source = ticked.length ? ticked : a.candidates.slice(0, 400);
  const links = source.map(item => ({ text: item.title, format: item.format })).concat((page.links || []).slice(0, 200));
  const formats = Array.from(new Set(ticked.map(item => item.format)));
  const html = conditionChips(L.conditionSuggestionsFrom({ title: page.title || "", text: ticked.map(item => item.title).join("\n"), links },
    { format: formats.length === 1 && formats[0] !== "Web page" ? formats[0] : "" }));
  if (box.dataset.rendered !== html) { box.innerHTML = html; box.dataset.rendered = html; }
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
  // Page loading: prefilled from the first monitor; only sent when changed.
  const loading = sourceLoading(first);
  state.scanLoadingBase = JSON.stringify(loading);
  $("scanFetchMode").value = loading.fetch_mode;
  $("scanWait").value = String(loading.browser_wait_seconds);
  $("scanWaitSelector").value = loading.browser_wait_selector;
  $("scanDismiss").checked = loading.browser_dismiss_cookies;
  $("scanSteps").value = loading.browser_actions.length ? JSON.stringify(loading.browser_actions, null, 2) : "";
  $("scanVisual").checked = loading.visual_compare;
  $("scanVisualThreshold").value = loading.visual_alert_threshold ? String(Math.round(loading.visual_alert_threshold * 1000) / 10) : "";
  $("scanRecorder").href = L.recorderBookmarklet();
  $("scanLoading").open = loading.fetch_mode !== "http";
  renderScanLoading();
  renderScanPreview();
  $("scanScheduleDialog").showModal();
}
const FETCH_MODE_WORDS = { http: "Automatic", auto: "Automatic", browser: "Browser every scan" };
function sourceLoading(source) {
  const s = source || {};
  return {
    // "auto" (browser on bot checks) is now what every monitor does: shown as automatic.
    fetch_mode: s.fetch_mode === "browser" ? "browser" : "http",
    browser_wait_seconds: Number.isInteger(s.browser_wait_seconds) ? s.browser_wait_seconds : 3,
    browser_wait_selector: String(s.browser_wait_selector || ""),
    browser_dismiss_cookies: s.browser_dismiss_cookies !== false,
    browser_actions: Array.isArray(s.browser_actions) ? s.browser_actions : [],
    visual_compare: s.visual_compare === true,
    visual_alert_threshold: typeof s.visual_alert_threshold === "number" ? s.visual_alert_threshold : null
  };
}
function scanStepsValue() {
  const raw = $("scanSteps").value.trim();
  if (!raw) return { steps: [], error: "" };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return { steps: [], error: "The steps are not valid JSON. Paste what the recorder copied." }; }
  return L.validateBrowserSteps(parsed);
}
function scanLoadingState() {
  return {
    fetch_mode: $("scanFetchMode").value,
    browser_wait_seconds: Math.max(0, Math.min(20, Math.round(Number($("scanWait").value) || 0))),
    browser_wait_selector: $("scanWaitSelector").value.trim().slice(0, 200),
    browser_dismiss_cookies: $("scanDismiss").checked,
    browser_actions: $("scanFetchMode").value === "browser" ? scanStepsValue().steps : [],
    visual_compare: $("scanFetchMode").value === "browser" && $("scanVisual").checked,
    visual_alert_threshold: $("scanFetchMode").value === "browser" && $("scanVisual").checked && Number($("scanVisualThreshold").value) > 0
      ? Math.min(1, Math.max(0.001, Number($("scanVisualThreshold").value) / 100)) : null
  };
}
function renderScanLoading() {
  const loading = scanLoadingState();
  $("scanBrowserOptions").hidden = loading.fetch_mode === "http";
  $("scanBrowserOnly").hidden = loading.fetch_mode !== "browser";
  $("scanVisualThresholdRow").hidden = !$("scanVisual").checked;
  const steps = scanStepsValue();
  $("scanStepsHelp").textContent = steps.error || (steps.steps.length ? steps.steps.map((step, index) => (index + 1) + ". " + L.describeBrowserStep(step)).join("  ") : "No steps: the page is read as it loads.");
  $("scanStepsHelp").classList.toggle("is-error", !!steps.error);
  $("scanLoadingNow").textContent = FETCH_MODE_WORDS[loading.fetch_mode] + (loading.browser_actions.length ? " · " + plural(loading.browser_actions.length, "step", "steps") : "") + (loading.visual_compare ? " · screenshots" : "");
}
function submitScanSchedule(reset) {
  const ids = state.pendingScanSchedule || [];
  const schedule = reset ? L.scanSchedule({}) : scanDialogState();
  const payload = L.scanSchedulePayload(ids, schedule);
  const loading = scanLoadingState();
  let words = "scan schedule → " + L.scanScheduleLabel(schedule);
  if (!reset && $("scanFetchMode").value === "browser" && scanStepsValue().error) { showToast(scanStepsValue().error); return; }
  if (!reset && JSON.stringify(loading) !== state.scanLoadingBase) {
    const defaults = { fetch_mode: "http", browser_wait_seconds: 3, browser_wait_selector: "", browser_dismiss_cookies: true,
      browser_actions: [], visual_compare: false, visual_alert_threshold: null };
    Object.keys(defaults).forEach(key => {
      if (JSON.stringify(loading[key]) === JSON.stringify(defaults[key])) payload.clear.push(key); else payload.set[key] = loading[key];
    });
    words += "; pages loaded with " + FETCH_MODE_WORDS[loading.fetch_mode].toLowerCase();
  }
  const requests = L.settingsRequests(payload, words);
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

/* ================= Workspaces, labels and presets =================
 * Workspace and labels live per monitor in config/sources.json. The scope
 * bar above Pages, Changes and Health filters all three at once (remembered in
 * this browser). Select in Pages picks monitors for a bulk change: scan
 * schedule, workspace and labels, or a preset. Every change goes through a
 * prefilled request the owner-only Update Monitor Settings workflow applies.
 */
const SCOPE_STORAGE = "cs-scope-v1";
state.scope = (() => { try { const saved = JSON.parse(localStorage.getItem(SCOPE_STORAGE) || "{}") || {}; return { workspace: saved.workspace || "ALL", label: saved.label || "ALL" }; } catch (_) { return { workspace: "ALL", label: "ALL" }; } })();
state.picking = false;
state.picked = new Set();
function sourceRegion(source) {
  const seed = source && Array.isArray(source.seed_urls) ? source.seed_urls[0] : "";
  return seed ? L.regulatorFor(seed, regulatorProfiles(), source.regulator || "").region : "";
}
function sourceWorkspace(sourceOrId) {
  const source = typeof sourceOrId === "string" ? configuredSources().find(candidate => candidate.id === sourceOrId) : sourceOrId;
  return L.workspaceOf(source || {}, source ? sourceRegion(source) : "");
}
function sourceLabels(sourceOrId) {
  const source = typeof sourceOrId === "string" ? configuredSources().find(candidate => candidate.id === sourceOrId) : sourceOrId;
  return L.labelsOf(source || {});
}
function inScope(sourceId) {
  if (state.scope.workspace === "ALL" && state.scope.label === "ALL") return true;
  return L.scopeMatches(state.scope, sourceWorkspace(String(sourceId || "")), sourceLabels(String(sourceId || "")));
}
function entrySourceId(entry) {
  if (entry && entry.source_id) return entry.source_id;
  const item = entry && state.items.find(candidate => candidate.canonical_url === entry.url);
  return item ? item.source_id : "";
}
function scopeOptions() {
  const workspaces = new Map(), labels = new Map();
  activeSources().forEach(source => {
    const ws = sourceWorkspace(source);
    const entry = workspaces.get(ws.name) || { name: ws.name, count: 0, auto: true };
    entry.count++; entry.auto = entry.auto && ws.auto;
    workspaces.set(ws.name, entry);
    sourceLabels(source).forEach(label => { const key = label.toLowerCase(); const hit = labels.get(key) || { name: label, count: 0 }; hit.count++; labels.set(key, hit); });
  });
  const byName = (a, b) => (a.name === "Other") - (b.name === "Other") || a.name.localeCompare(b.name);
  return { workspaces: Array.from(workspaces.values()).sort(byName), labels: Array.from(labels.values()).sort(byName) };
}
function renderScopeBars() {
  const { workspaces, labels } = scopeOptions();
  if (state.scope.workspace !== "ALL" && !workspaces.some(ws => ws.name === state.scope.workspace)) state.scope.workspace = "ALL";
  if (state.scope.label !== "ALL" && !labels.some(label => label.name.toLowerCase() === String(state.scope.label).toLowerCase())) state.scope.label = "ALL";
  const show = workspaces.length > 1 || labels.length > 0;
  const option = (value, text, current) => '<option value="' + esc(value) + '"' + (value === current ? " selected" : "") + ">" + esc(text) + "</option>";
  const html = !show ? "" :
    '<label>Workspace <select class="scope-select' + (state.scope.workspace !== "ALL" ? " is-set" : "") + '" data-scope="workspace" aria-label="Workspace">' +
      option("ALL", "All", state.scope.workspace) + workspaces.map(ws => option(ws.name, ws.name + (ws.auto ? " (region)" : "") + " · " + ws.count, state.scope.workspace)).join("") + "</select></label>" +
    (labels.length ? '<label>Label <select class="scope-select' + (state.scope.label !== "ALL" ? " is-set" : "") + '" data-scope="label" aria-label="Label">' +
      option("ALL", "All", state.scope.label) + labels.map(label => option(label.name, label.name + " · " + label.count, state.scope.label)).join("") + "</select></label>" : "") +
    (state.scope.workspace !== "ALL" || state.scope.label !== "ALL" ? '<button class="scope-clear" type="button" data-scope-clear>Clear</button>' : "");
  document.querySelectorAll("[data-scope-bar]").forEach(bar => {
    bar.hidden = !show;
    if (bar.dataset.rendered !== html) { bar.innerHTML = html; bar.dataset.rendered = html; }
  });
}
function setScope(key, value) {
  if (key) state.scope[key] = value || "ALL";
  else state.scope = { workspace: "ALL", label: "ALL" };
  try { localStorage.setItem(SCOPE_STORAGE, JSON.stringify(state.scope)); } catch (_) {}
  renderLists();
  renderDetailForView(state.view);
}
function renderDetailForView(view) {
  if (view === "health") renderHealthDetail();
}
function organiseTags(source) {
  const ws = sourceWorkspace(source);
  return (source && source.shadow ? '<span class="tag tone-pending" title="Shadow mode: changes are recorded without alerts">Shadow</span>' : "") +
    (!ws.auto ? '<span class="tag" title="Workspace">' + esc(ws.name) + "</span>" : "") +
    sourceLabels(source).map(label => '<span class="tag is-label" title="Label">#' + esc(label) + "</span>").join("");
}
// Selection: settings apply per monitor (source), so picking a page picks its monitor.
function setPicking(on) {
  state.picking = !!on;
  if (!state.picking) state.picked.clear();
  $("selectMonitorsBtn").setAttribute("aria-pressed", String(state.picking));
  $("selectMonitorsBtn").textContent = state.picking ? "Done" : "Select";
  renderMonitorList();
  renderSelectBar();
}
function togglePicked(sourceId) {
  if (!sourceId) return;
  if (state.picked.has(sourceId)) state.picked.delete(sourceId); else state.picked.add(sourceId);
  renderMonitorList();
  renderSelectBar();
}
function shownMonitorIds() {
  return Array.from(new Set(filteredMonitorItems().map(item => item.source_id).filter(id => configuredSources().some(source => source.id === id && source.active !== false))));
}
function renderSelectBar() {
  const bar = $("selectBar");
  if (!bar) return;
  bar.hidden = !state.picking;
  const n = state.picked.size;
  $("selectCount").textContent = n ? plural(n, "monitor", "monitors") + " selected" : "Tap pages to select their monitors";
  bar.querySelectorAll("[data-bulk]").forEach(button => { button.disabled = !n; });
  const shown = shownMonitorIds();
  const all = shown.length && shown.every(id => state.picked.has(id));
  bar.querySelector("[data-select-shown]").textContent = all ? "Clear selection" : "Select all shown (" + shown.length + ")";
}
function openSettingsRequests(payload, describe, toast) {
  const requests = L.settingsRequests(payload, describe);
  if (!requests.length) return;
  requests.slice(1).forEach(request => {
    const params = new URLSearchParams(); params.set("title", request.title); params.set("body", request.body);
    window.open(REPO + "/issues/new?" + params.toString(), "_blank");
  });
  const params = new URLSearchParams(); params.set("title", requests[0].title); params.set("body", requests[0].body);
  openGitHubRequest(REPO + "/issues/new?" + params.toString(), (requests.length > 1 ? "Submit each of the " + requests.length + " prefilled requests on GitHub. " : "Submit the prefilled request on GitHub. ") + toast);
}
function openOrganise(ids) {
  const list = Array.from(new Set((ids || []).filter(id => configuredSources().some(source => source.id === id && source.active !== false))));
  if (!list.length) { showToast("Choose at least one active monitor."); return; }
  state.pendingOrganise = list;
  state.organiseRemove = new Map();
  const first = configuredSources().find(source => source.id === list[0]) || {};
  $("organiseTarget").textContent = list.length === 1 ? (first.name || first.id) : plural(list.length, "monitor", "monitors");
  const { workspaces, labels } = scopeOptions();
  const current = Array.from(new Set(list.map(id => { const ws = sourceWorkspace(id); return ws.auto ? "" : ws.name; })));
  const explicit = workspaces.filter(ws => !ws.auto).map(ws => ws.name);
  const suggestions = Array.from(new Set(explicit.concat(["NAM", "EMEA", "LATAM", "APAC"])));
  $("organiseWorkspace").innerHTML = '<option value="__keep">' + esc(current.length === 1 ? "Keep: " + (current[0] || "by region") : "Keep each monitor's own") + "</option>" +
    suggestions.map(name => '<option value="' + esc(name) + '">' + esc(name) + "</option>").join("") +
    '<option value="__new">New workspace…</option><option value="__clear">None (group by region)</option>';
  $("organiseWorkspace").value = "__keep";
  $("organiseWorkspaceNew").hidden = true;
  $("organiseWorkspaceNew").value = "";
  $("organiseAdd").value = "";
  $("organiseLabelList").innerHTML = labels.map(label => '<option value="' + esc(label.name) + '"></option>').join("");
  $("organiseSuggestions").innerHTML = labels.slice(0, 12).map(label => '<button class="chip" type="button" data-add-label="' + esc(label.name) + '">+ ' + esc(label.name) + "</button>").join("");
  const present = new Map();
  list.forEach(id => sourceLabels(id).forEach(label => present.set(label.toLowerCase(), label)));
  $("organiseRemoveRow").hidden = !present.size;
  $("organiseRemove").innerHTML = Array.from(present.values()).sort().map(label => '<button class="chip" type="button" data-remove-label="' + esc(label) + '" aria-pressed="false">#' + esc(label) + "</button>").join("");
  $("organiseError").textContent = "";
  $("organiseAlerts").value = "keep";
  $("organiseDialog").showModal();
}
function submitOrganise() {
  const choice = $("organiseWorkspace").value;
  const newName = $("organiseWorkspaceNew").value.trim();
  const add = L.parseLabels($("organiseAdd").value);
  const bad = add.concat(choice === "__new" ? [newName] : []).filter(text => !L.validTag(text));
  if (choice === "__new" && !newName) { $("organiseError").textContent = "Name the new workspace."; return; }
  if (bad.length) { $("organiseError").textContent = "Use 1–40 letters, digits, spaces or & / + . - _ in names: " + bad.join(", "); return; }
  const overflow = state.pendingOrganise.filter(id => {
    const kept = sourceLabels(id).filter(label => !state.organiseRemove.has(label.toLowerCase()));
    return kept.concat(add.filter(label => !kept.some(other => other.toLowerCase() === label.toLowerCase()))).length > L.LABEL_MAX;
  });
  if (overflow.length) { $("organiseError").textContent = "A monitor can carry at most " + L.LABEL_MAX + " labels; " + plural(overflow.length, "monitor", "monitors") + " would exceed that."; return; }
  const payload = L.organisePayload(state.pendingOrganise, {
    workspace: choice === "__new" ? newName : choice.indexOf("__") === 0 ? "" : choice,
    clearWorkspace: choice === "__clear",
    add, remove: Array.from(state.organiseRemove.values()),
    shadow: $("organiseAlerts").value === "shadow" ? true : $("organiseAlerts").value === "on" ? false : undefined
  });
  if (L.payloadIsEmpty(payload)) { $("organiseError").textContent = "Nothing to change yet: pick a workspace, or add or remove a label."; return; }
  const words = [payload.set.workspace ? "workspace → " + payload.set.workspace : payload.clear.indexOf("workspace") >= 0 ? "workspace → by region" : "",
    payload.add_labels ? "add " + payload.add_labels.join(", ") : "", payload.remove_labels ? "remove " + payload.remove_labels.join(", ") : "",
    payload.set.shadow ? "shadow mode on" : payload.clear.indexOf("shadow") >= 0 ? "alerts on" : ""].filter(Boolean).join("; ");
  $("organiseDialog").close();
  openSettingsRequests(payload, words, "Workspaces and labels apply as soon as it is processed.");
}
function openPreset(ids) {
  const list = Array.from(new Set((ids || []).filter(id => configuredSources().some(source => source.id === id && source.active !== false))));
  if (!list.length) { showToast("Choose at least one active monitor."); return; }
  state.pendingPreset = list;
  $("presetTarget").textContent = plural(list.length, "monitor", "monitors");
  $("presetList").innerHTML = L.SETTINGS_PRESETS.map((preset, index) => '<label class="preset-option"><input type="radio" name="preset" value="' + esc(preset.id) + '"' + (index === 1 ? " checked" : "") + '><b>' + esc(preset.name) + "</b><small>" + esc(preset.note) +
    (preset.labels ? " Adds the label " + preset.labels.map(label => "#" + label).join(", ") + "." : "") + "</small></label>").join("");
  const others = activeSources().filter(source => list.indexOf(source.id) < 0).sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b)));
  $("presetCopyFrom").innerHTML = others.map(source => '<option value="' + esc(source.id) + '">' + esc(sourceLabel(source) + " — " + scanScheduleWords(source)) + "</option>").join("");
  renderPresetPreview();
  $("presetDialog").showModal();
}
// The regulator's time zone for "business hours", from its region; the owner can refine it per monitor.
const REGION_ZONES = { NAM: "America/New_York", LATAM: "America/Sao_Paulo", EMEA: "Europe/London", APAC: "Asia/Singapore" };
function presetChoice() {
  const picked = (document.querySelector("#presetList input:checked") || {}).value;
  return L.SETTINGS_PRESETS.find(preset => preset.id === picked) || L.SETTINGS_PRESETS[0];
}
function presetPayloadFor(ids) {
  const preset = presetChoice();
  if (preset.copy) return L.presetPayload(ids, preset, { from: configuredSources().find(source => source.id === $("presetCopyFrom").value) || {} });
  const regions = Array.from(new Set(ids.map(id => sourceWorkspace(id)).filter(ws => ws.auto).map(ws => ws.name)));
  return L.presetPayload(ids, preset, { timezone: REGION_ZONES[regions.length === 1 ? regions[0] : ""] || "UTC" });
}
function renderPresetPreview() {
  const preset = presetChoice();
  $("presetCopyRow").hidden = !preset.copy;
  const payload = presetPayloadFor(state.pendingPreset || []);
  const schedule = L.scanSchedule(payload.set);
  const extras = [payload.set.workspace ? "workspace " + payload.set.workspace : "", payload.add_labels ? "adds " + payload.add_labels.map(label => "#" + label).join(", ") : ""].filter(Boolean);
  $("presetPreview").innerHTML = '<div class="scan-preview-head"><b>' + esc(L.scanScheduleLabel(schedule)) + "</b><span>" + esc(extras.join(" · ") || "schedule only") + "</span></div>";
}
function submitPreset() {
  const ids = state.pendingPreset || [];
  const preset = presetChoice();
  if (preset.copy && !$("presetCopyFrom").value) { showToast("Pick the monitor to copy from."); return; }
  const payload = presetPayloadFor(ids);
  $("presetDialog").close();
  openSettingsRequests(payload, "preset “" + preset.name + "” → " + L.scanScheduleLabel(L.scanSchedule(payload.set)), "The preset applies from the next scheduled scan.");
}

/* ================= Shadow comparison with Visualping =================
 * The owner exports Visualping's alert history (CSV or XLSX) and drops it here.
 * It is read in this browser only and compared with the changes ChangeSentinel
 * recorded for the same pages and period: which both caught, which only one
 * did, and which Visualping pages are not monitored here yet.
 */
const SHADOW_KEY = "__shadow";
state.shadow = null;
function shadowOurChanges() {
  return changeLogEntries().filter(entry => ["CHANGED_URL", "NEW_URL", "REMOVED_URL"].indexOf(entry.event_type) >= 0)
    .map(entry => ({ url: entry.url, at: Date.parse(entry.timestamp), event_type: entry.event_type, event_id: entry.event_id, source_id: entrySourceId(entry) }))
    .filter(row => row.url && Number.isFinite(row.at));
}
function shadowMonitoredUrls() {
  return new Set(state.items.map(item => item.canonical_url).filter(Boolean));
}
function shadowOurAlerts(period) {
  return Object.values(notificationMap(state.notifications, "sent_events")).filter(item => item && item.kind !== "TEST" && ["CHANGED_URL", "NEW_URL", "REMOVED_URL"].indexOf(item.kind) >= 0)
    .filter(item => { const at = Date.parse(item.sent_at); return Number.isFinite(at) && (!period || (at >= period.from - 86400000 && at <= period.to + 86400000)); }).length;
}
async function readShadowFile(file) {
  if (!file) return;
  state.shadow = { name: file.name, loading: true };
  renderNotifications(); renderNotificationDetail();
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error("This file is larger than 25 MB.");
    const extension = file.name.toLowerCase().split(".").pop();
    const matrix = extension === "xlsx" ? await L.xlsxFirstSheetRows(await file.arrayBuffer()) : extension === "csv" ? parseCsvMatrix(await file.text()) : null;
    if (!matrix) throw new Error("Choose a .csv or .xlsx file.");
    const parsed = L.shadowRows(matrix);
    if (parsed.error) throw new Error(parsed.error);
    const result = L.shadowCompare(parsed.rows, shadowOurChanges(), shadowMonitoredUrls(), { windowHours: 36 });
    state.shadow = { name: file.name, rows: parsed.rows.length, unreadable: parsed.unreadable, result, at: Date.now() };
  } catch (error) {
    state.shadow = { name: file.name, error: String(error && error.message || error) };
  }
  renderNotifications(); renderNotificationDetail();
}
function shadowEntryRow() {
  const r = state.shadow && state.shadow.result;
  // Only for teams running monitors beside their previous tool (shadow mode).
  if (!r && !state.shadow && !activeSources().some(source => source && source.shadow)) return "";
  const summary = r ? r.totals.both + " matched, " + r.totals.theirsOnly + " only in Visualping, " + r.totals.oursOnly + " only here" : "Drop Visualping's alert export to compare both tools";
  return '<button class="row" type="button" data-select-notification="' + SHADOW_KEY + '"' + (state.selectedNotificationId === SHADOW_KEY ? ' aria-selected="true" aria-current="true"' : "") + ">" +
    '<span class="row-mark tone-' + (r ? (r.totals.theirsOnly ? "problem" : "ok") : "pending") + '" aria-hidden="true"></span>' +
    '<span class="row-title">Compare with Visualping</span><span class="row-time">' + esc(r ? "shadow run" : "") + "</span>" +
    '<span class="row-summary">' + esc(summary) + "</span></button>";
}
// A row that opens the page here when it is monitored, else the live page.
function shadowRow(url, body) {
  const item = state.items.find(candidate => L.urlKey(candidate.canonical_url) === L.urlKey(url));
  return item ? '<button class="row" type="button" data-monitor-id="' + esc(item.url_id) + '">' + body + "</button>"
    : '<a class="row" href="' + esc(safeHttpUrl(url) ? url : "#") + '" target="_blank" rel="noopener noreferrer">' + body + "</a>";
}
function shadowList(title, rows, note, render) {
  if (!rows.length) return "";
  const shown = rows.slice(0, 40);
  return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">' + esc(title) + '</h3><span class="sheet-note">' + esc(note) + "</span></div>" +
    shown.map(render).join("") + (rows.length > shown.length ? '<p class="note-strip">' + esc(plural(rows.length - shown.length, "more row", "more rows")) + " in the downloaded comparison.</p>" : "") + "</section>";
}
function renderShadowDetail(pane) {
  const shadow = state.shadow;
  const intro = '<section class="sheet"><div class="shadow-upload">' +
    '<p class="field-help">Run both tools on the same pages for a few weeks (import them with <b>Shadow mode</b> so only Visualping alerts), then compare what each caught.</p>' +
    "<ol><li>In Visualping, export the alert or change history for the period as CSV or Excel. It needs a page URL column and a date column.</li>" +
    "<li>Choose the file here. It is read in this browser and never uploaded.</li></ol>" +
    '<input class="field-input" type="file" id="shadowFile" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Visualping alert export">' +
    (shadow && shadow.error ? '<p class="bulk-status is-error">' + esc(shadow.error) + "</p>" : shadow && shadow.loading ? '<p class="bulk-status">Reading ' + esc(shadow.name) + "…</p>" : "") +
    "</div></section>";
  const heading = detailHeading({ back: true, source: "Shadow comparison", title: "Compare with Visualping",
    meta: shadow && shadow.result ? "<span>" + esc(shadow.name) + "</span><span>" + esc(shortDate(new Date(shadow.result.period.from)) + " – " + shortDate(new Date(shadow.result.period.to))) + "</span>" : "<span>Nothing loaded</span>",
    actions: shadow && shadow.result ? '<button class="btn" type="button" data-shadow-download>Download comparison</button>' : "" });
  if (!shadow || !shadow.result) { pane.innerHTML = '<div class="detail-inner">' + heading + intro + "</div>"; return; }
  const r = shadow.result, t = r.totals;
  const alertsHere = shadowOurAlerts(r.period);
  const tiles = [
    ["Visualping alerts", t.theirs.toLocaleString(), plural(t.pagesTheirs, "monitored page", "monitored pages") + (t.notMonitored ? " + " + t.notMonitored + " not monitored here" : "")],
    ["Changes recorded here", t.ours.toLocaleString(), plural(alertsHere, "alert", "alerts") + " sent in the period"],
    ["Caught by both", t.both.toLocaleString(), [r.medianLagHours == null ? "" : "median " + (r.medianLagHours >= 0 ? "+" : "") + r.medianLagHours.toFixed(1) + " h vs Visualping",
      t.repeats ? plural(t.repeats, "repeat Visualping alert", "repeat Visualping alerts") + " for the same changes" : ""].filter(Boolean).join(" · ")],
    ["Only in Visualping", t.theirsOnly.toLocaleString(), "possible misses to check"]
  ];
  const watched = t.both + t.theirsOnly + t.oursOnly || 1;
  const bar = '<div class="shadow-bar" role="img" aria-label="' + esc(t.both + " matched, " + t.theirsOnly + " only in Visualping, " + t.oursOnly + " only here") + '">' +
    '<i class="is-both" style="width:' + (t.both / watched * 100).toFixed(1) + '%"></i><i class="is-theirs" style="width:' + (t.theirsOnly / watched * 100).toFixed(1) + '%"></i><i class="is-ours" style="width:' + (t.oursOnly / watched * 100).toFixed(1) + '%"></i></div>' +
    '<div class="shadow-key"><span><i style="background:var(--good)"></i>Both</span><span><i style="background:var(--state-bad)"></i>Only Visualping</span><span><i style="background:var(--state-change)"></i>Only ChangeSentinel</span></div>';
  // Per workspace: Visualping's own column when the export has one, else ours.
  const groups = new Map();
  const bump = (name, key) => { const row = groups.get(name) || { name, both: 0, theirsOnly: 0, oursOnly: 0 }; row[key]++; groups.set(name, row); };
  const ourWorkspace = url => { const item = state.items.find(candidate => L.urlKey(candidate.canonical_url) === L.urlKey(url)); return item ? sourceWorkspace(String(item.source_id)).name : "Other"; };
  r.both.forEach(pair => bump(pair.theirs.workspace || ourWorkspace(pair.theirs.url), "both"));
  r.theirsOnly.forEach(row => bump(row.workspace || ourWorkspace(row.url), "theirsOnly"));
  r.oursOnly.forEach(row => bump(ourWorkspace(row.url), "oursOnly"));
  const table = groups.size > 1 ? '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">By workspace</h3></div><table class="shadow-table"><thead><tr><th>Workspace</th><th>Both</th><th>Only Visualping</th><th>Only here</th></tr></thead><tbody>' +
    Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name)).map(row => "<tr><td>" + esc(row.name) + "</td><td>" + row.both + "</td><td>" + row.theirsOnly + "</td><td>" + row.oursOnly + "</td></tr>").join("") + "</tbody></table></section>" : "";
  const when = at => new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const notMonitored = Array.from(new Map(r.notMonitored.map(row => [L.urlKey(row.url), row])).values());
  pane.innerHTML = '<div class="detail-inner">' + heading +
    '<section class="sheet"><div class="health-tiles">' + tiles.map(([name, value, note]) => '<div class="health-tile"><div class="health-tile-label">' + esc(name) + '</div><div class="health-tile-value">' + esc(value) + '</div><div class="health-tile-note">' + esc(note) + "</div></div>").join("") + "</div>" + bar + "</section>" +
    table +
    shadowList("Only in Visualping", r.theirsOnly, "No change recorded here within 36 h · open the page to check", row => shadowRow(row.url,
      '<span class="row-mark tone-problem" aria-hidden="true"></span><span class="row-title">' + esc(displayUrl(row.url)) + '</span><span class="row-time">' + esc(when(row.at)) + "</span>")) +
    shadowList("Only in ChangeSentinel", r.oursOnly, "Changes Visualping did not alert on", row => shadowRow(row.url,
      '<span class="row-mark tone-change" aria-hidden="true"></span><span class="row-title">' + esc(displayUrl(row.url)) + '</span><span class="row-time">' + esc(when(row.at)) + '</span><span class="row-summary">' + esc(L.eventLabel(row.event_type)) + "</span>")) +
    (notMonitored.length ? '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Visualping pages not monitored here</h3><span class="sheet-note">' + esc(plural(notMonitored.length, "page", "pages")) + '</span></div><p class="note-strip">These alerted in Visualping but have no monitor here, so they cannot be compared. Import them to include them in the next comparison.</p>' +
      '<div class="modal-actions" style="padding:0 18px 14px"><button class="btn btn-primary" type="button" data-shadow-import>Import ' + esc(plural(notMonitored.length, "page", "pages")) + " in shadow mode</button></div></section>" : "") +
    intro.replace("Choose the file here.", "Choose another file to compare again.") +
    '<p class="note-strip">' + esc((shadow.unreadable ? shadow.unreadable + " rows without a URL or date were skipped. " : "") + "A Visualping alert matches a change here when both concern the same page within 36 hours. Several Visualping alerts for one change count once each; only one can match it.") + "</p></div>";
}
function downloadShadowComparison() {
  const r = state.shadow && state.shadow.result;
  if (!r) return;
  const iso = at => new Date(at).toISOString();
  const rows = [["Outcome", "Page", "Visualping alert", "ChangeSentinel change", "Lag (hours)"]]
    .concat(r.both.map(pair => ["Both", pair.theirs.url, iso(pair.theirs.at), iso(pair.ours.at), pair.lagHours.toFixed(1)]))
    .concat(r.theirsOnly.map(row => ["Only Visualping", row.url, iso(row.at), "", ""]))
    .concat(r.oursOnly.map(row => ["Only ChangeSentinel", row.url, "", iso(row.at), ""]))
    .concat(r.notMonitored.map(row => ["Not monitored here", row.url, iso(row.at), "", ""]));
  downloadFile("changesentinel-vs-visualping-" + L.localIsoDate() + ".csv", "text/csv;charset=utf-8", "﻿" + L.toCsv(rows));
}
function importShadowPages() {
  const r = state.shadow && state.shadow.result;
  if (!r) return;
  const urls = Array.from(new Map(r.notMonitored.map(row => [L.urlKey(row.url), row])).values());
  openAddMonitor();
  const bulk = $("addBulk");
  if (bulk) bulk.open = true;
  const result = bulkRowsFromMatrix([["URL", "Workspace"]].concat(urls.map(row => [row.url, row.workspace || ""])));
  bulkImport = result; bulkImportRows = result.rows; bulkImportErrors = result.errors; bulkOpened = new Set();
  $("bulkShadow").checked = true;
  if (!$("bulkLabels").value) $("bulkLabels").value = "Visualping import";
  setBulkStatus(result.errors.length ? result.errors.slice(0, 3).join(" ") : "Ready to import " + result.rows.length + " pages from the comparison, in shadow mode.", !!result.errors.length);
  renderBulkPreview();
}

/* ================= Scheduled digests =================
 * config/digests.json lists them; regmon/digest.py builds each one in the first
 * scan after its time and queues it with that run's alerts. data/digests/index.json
 * holds the latest digest of each in full and a short history.
 */
const DIGEST_PREFIX = "digest:";
state.digests = null;
state.digestConfig = null;
state.digestCache = boundedCache(12);
function digestList() { return state.digestConfig && Array.isArray(state.digestConfig.digests) ? state.digestConfig.digests : []; }
function digestEntry(id) { return state.digests && isPlainObject(state.digests.digests) ? state.digests.digests[id] || null : null; }
function digestScope(workspace) { return workspace === "*" ? "All workspaces" : workspace; }
function digestWhen(digest) {
  const day = { mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays", thu: "Thursdays", fri: "Fridays", sat: "Saturdays", sun: "Sundays" }[digest.day || "mon"];
  return (digest.frequency === "weekly" ? "Weekly, " + day : "Daily") + " at " + String(digest.hour == null ? 8 : digest.hour).padStart(2, "0") + ":00 " + (digest.timezone || "UTC").replace(/_/g, " ");
}
function digestEntryRows() {
  const digests = digestList();
  const rows = digests.map(digest => {
    const entry = digestEntry(digest.id);
    const latest = entry && entry.latest;
    const key = DIGEST_PREFIX + digest.id;
    const summary = latest ? plural(latest.counts.changes, "change", "changes") + (latest.counts.relevant ? ", " + latest.counts.relevant + " relevant" : "") + " · " + digestWhen(digest) : "First digest after " + digestWhen(digest).toLowerCase();
    return '<button class="row" type="button" data-select-notification="' + esc(key) + '"' + (state.selectedNotificationId === key ? ' aria-selected="true" aria-current="true"' : "") + ">" +
      '<span class="row-mark tone-' + (latest && latest.counts.relevant ? "change" : latest ? "ok" : "pending") + '" aria-hidden="true"></span>' +
      '<span class="row-title">' + esc((digest.frequency === "weekly" ? "Weekly" : "Daily") + " digest · " + digestScope(digest.workspace)) + "</span>" +
      '<span class="row-time">' + esc(latest ? shortDate(latest.period.to) : "") + "</span>" +
      '<span class="row-summary">' + esc(summary) + "</span></button>";
  }).join("");
  return '<div class="list-group-label">Digests' + (digests.length ? " <span>(" + digests.length + ")</span>" : "") + "</div>" + rows +
    '<div class="channel-bar" style="padding:8px 20px 12px"><button class="chip chip-add" type="button" data-digest-edit>' + icon("plus") + (digests.length ? "Edit digests" : "Set up a daily or weekly digest") + "</button></div>";
}
function renderDigestRecord(record, digest, history) {
  const counts = record.counts || {};
  const items = Array.isArray(record.items) ? record.items : [];
  const tag = item => item.relevant === true ? '<span class="tag tone-change">Relevant</span>' : item.relevant === false ? '<span class="tag">Not relevant</span>' : '<span class="tag tone-pending">Not assessed</span>';
  const itemHtml = items.map(item => '<div class="digest-item"><div class="digest-item-head">' + tag(item) + "<b>" + esc(item.monitor) + "</b>" +
    '<span class="sheet-note">' + esc(L.eventLabel(item.event_type) + " · " + shortDate(item.at)) + "</span></div>" +
    (item.summary ? "<p>" + esc(item.summary) + "</p>" : "") +
    (item.quote ? '<blockquote class="digest-quote">' + esc(item.quote) + "</blockquote>" : "") +
    (item.effective_date && !/^not stated$/i.test(item.effective_date) ? '<p class="sheet-note">Effective: ' + esc(item.effective_date) + "</p>" : "") +
    '<div class="channel-bar" style="margin:0"><button class="sheet-link" type="button" data-select-change="' + esc(item.event_id) + '">Open the change</button>' +
    (safeHttpUrl(item.url) ? externalLink(item.url, "Live page", "sheet-link") : "") + "</div></div>").join("");
  const tiles = [["Changes", counts.changes || 0, plural(counts.monitors || 0, "monitor", "monitors")], ["Relevant", counts.relevant || 0, "judged by the AI"],
    ["Not relevant", counts.not_relevant || 0, "recorded, no action"], ["Not assessed", counts.unassessed || 0, "AI was unavailable"]];
  const older = (history || []).filter(entry => entry.id !== record.id);
  return '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Overview</h3><span class="sheet-note">' + esc(record.overview_status === "ok" ? "Written by the AI from the changes below" : "AI overview unavailable; plain count") + "</span></div>" +
    '<p class="digest-overview">' + esc(record.overview || "") + "</p>" +
    '<div class="health-tiles">' + tiles.map(([name, value, note]) => '<div class="health-tile"><div class="health-tile-label">' + esc(name) + '</div><div class="health-tile-value">' + esc(String(value)) + '</div><div class="health-tile-note">' + esc(note) + "</div></div>").join("") + "</div></section>" +
    (items.length ? '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Changes</h3><span class="sheet-note">English summary, then the changed text as published</span></div>' + itemHtml + "</section>"
      : '<section class="sheet"><p class="note-strip">Nothing changed on these monitors in this period.</p></section>') +
    (older.length ? '<section class="sheet"><div class="sheet-head"><h3 class="sheet-title">Earlier digests</h3></div>' + older.slice(0, 12).map(entry =>
      '<button class="row" type="button" data-digest-open="' + esc(entry.path || "") + '" data-digest-of="' + esc(digest.id) + '"><span class="row-mark tone-' + ((entry.counts || {}).relevant ? "change" : "ok") + '" aria-hidden="true"></span>' +
      '<span class="row-title">' + esc(shortDate(entry.period.from) + " – " + shortDate(entry.period.to)) + '</span><span class="row-time">' + esc(plural((entry.counts || {}).changes || 0, "change", "changes")) + "</span>" +
      '<span class="row-summary">' + esc(entry.overview || "") + "</span></button>").join("") + "</section>" : "");
}
function renderDigestDetail(pane) {
  const id = state.selectedNotificationId.slice(DIGEST_PREFIX.length);
  const digest = digestList().find(candidate => candidate.id === id);
  const entry = digestEntry(id);
  const record = state.digestOpen && state.digestOpen.of === id ? state.digestOpen.record : entry && entry.latest;
  const heading = detailHeading({ back: true, source: "Scheduled digest", title: digest ? (digest.frequency === "weekly" ? "Weekly" : "Daily") + " digest · " + digestScope(digest.workspace) : "Digest",
    meta: (record ? "<span>" + esc(shortDate(record.period.from) + " – " + shortDate(record.period.to)) + "</span>" : "") + (digest ? "<span>" + esc(digestWhen(digest)) + "</span>" : ""),
    actions: '<button class="btn" type="button" data-digest-edit>Edit digests</button>' + (state.digestOpen && state.digestOpen.of === id ? '<button class="btn" type="button" data-digest-latest>Latest digest</button>' : "") });
  if (!digest) { pane.innerHTML = '<div class="detail-inner">' + heading + emptyState("This digest is no longer configured", "Edit digests to set one up again.") + "</div>"; return; }
  pane.innerHTML = '<div class="detail-inner">' + heading + (record ? renderDigestRecord(record, digest, entry ? entry.history : [])
    : '<section class="sheet"><p class="note-strip">No digest yet. The first is built by the first scan after ' + esc(digestWhen(digest).toLowerCase()) + ", and sent with that scan's alerts.</p></section>") + "</div>";
}
async function openOlderDigest(path, of) {
  if (!path) return;
  try {
    const record = JSON.parse(await readSnapshotFile(path, state.digestCache));
    state.digestOpen = { of, record };
  } catch (error) { showToast("Couldn't load that digest: " + String(error.message || error)); return; }
  renderNotificationDetail();
  resetDetailScroll("notifications");
}
function digestRowHtml(digest, index) {
  const { workspaces } = scopeOptions();
  const names = Array.from(new Set(workspaces.map(ws => ws.name).concat(digest.workspace && digest.workspace !== "*" ? [digest.workspace] : [])));
  const option = (value, text, current) => '<option value="' + esc(value) + '"' + (String(value) === String(current) ? " selected" : "") + ">" + esc(text) + "</option>";
  const zones = SCAN_ZONES.indexOf(digest.timezone || "UTC") >= 0 ? SCAN_ZONES : [digest.timezone].concat(SCAN_ZONES);
  return '<div class="digest-row" data-digest-row="' + index + '">' +
    '<label><span class="visually-hidden">Workspace</span><select class="field-input" data-digest-field="workspace">' + option("*", "All workspaces", digest.workspace) + names.map(name => option(name, name, digest.workspace)).join("") + "</select></label>" +
    '<label><span class="visually-hidden">How often</span><select class="field-input" data-digest-field="frequency">' + option("daily", "Daily", digest.frequency) + option("weekly", "Weekly", digest.frequency) + "</select></label>" +
    '<label><span class="visually-hidden">Day</span><select class="field-input" data-digest-field="day"' + (digest.frequency === "weekly" ? "" : " disabled") + ">" + L.SCAN_WEEKDAYS.map(day => option(day, SCAN_DAY_WORDS[day], digest.day || "mon")).join("") + "</select></label>" +
    '<label><span class="visually-hidden">Hour</span><select class="field-input" data-digest-field="hour">' + Array.from({ length: 24 }, (_, h) => option(h, String(h).padStart(2, "0") + ":00", digest.hour == null ? 8 : digest.hour)).join("") + "</select></label>" +
    '<label><span class="visually-hidden">Time zone</span><select class="field-input" data-digest-field="timezone">' + zones.map(zone => option(zone, zone.replace(/_/g, " "), digest.timezone || "UTC")).join("") + "</select></label>" +
    '<button type="button" data-digest-remove="' + index + '" aria-label="Remove this digest">Remove</button></div>';
}
function openDigestDialog() {
  state.digestDraft = digestList().map(digest => Object.assign({}, digest));
  renderDigestRows();
  $("digestError").textContent = "";
  $("digestDialog").showModal();
}
function renderDigestRows() {
  $("digestRows").innerHTML = state.digestDraft.length ? state.digestDraft.map(digestRowHtml).join("") : '<p class="field-help">No digests yet.</p>';
}
function readDigestRows() {
  document.querySelectorAll("#digestRows [data-digest-row]").forEach(row => {
    const digest = state.digestDraft[Number(row.dataset.digestRow)];
    row.querySelectorAll("[data-digest-field]").forEach(field => { digest[field.dataset.digestField] = field.dataset.digestField === "hour" ? Number(field.value) : field.value; });
    if (digest.frequency !== "weekly") delete digest.day;
  });
}
function digestId(digest, taken) {
  const base = (String(digest.workspace === "*" ? "all" : digest.workspace).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "digest") + "-" + digest.frequency;
  let id = base, n = 2;
  while (taken.has(id)) id = base + "-" + n++;
  taken.add(id);
  return id;
}
function submitDigests() {
  readDigestRows();
  const seen = new Set();
  const dupes = state.digestDraft.filter(digest => { const key = digest.workspace + "|" + digest.frequency; const hit = seen.has(key); seen.add(key); return hit; });
  if (dupes.length) { $("digestError").textContent = "Two digests cover the same workspace at the same frequency."; return; }
  const kept = new Set(state.digestDraft.filter(digest => digest.id).map(digest => digest.id));
  const digests = state.digestDraft.map(digest => {
    const out = { id: digest.id || digestId(digest, kept), workspace: digest.workspace, frequency: digest.frequency, hour: digest.hour == null ? 8 : digest.hour, timezone: digest.timezone || "UTC" };
    if (digest.frequency === "weekly") out.day = digest.day || "mon";
    return out;
  });
  const body = [L.SETTINGS_MARKER, "", "Please apply these monitor settings in ChangeSentinel.", "",
    "Change: scheduled digests \u2192 " + (digests.map(d => d.frequency + " " + digestScope(d.workspace)).join(", ") || "none"), "",
    "SETTINGS_JSON:", JSON.stringify({ digests }), "", "This request was created from the ChangeSentinel dashboard."].join("\n");
  $("digestDialog").close();
  const params = new URLSearchParams(); params.set("title", "[ChangeSentinel] Update monitors (digests)"); params.set("body", body);
  openGitHubRequest(REPO + "/issues/new?" + params.toString(), "Submit the prefilled request on GitHub. Digests are sent from the first scan after their time.");
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
// Bucketing every Scout finding canonicalises each URL; the nav counts and the
// More tab ask for it on every render. The result changes only when the Scout
// review or the monitored set is replaced (both are swapped, never mutated).
let scoutBucketsMemo = null;
function scoutBuckets() {
  const candidates = scoutCandidates(), monitored = scoutMonitoredKeys();
  if (!scoutBucketsMemo || scoutBucketsMemo.candidates !== candidates || scoutBucketsMemo.monitored !== monitored) {
    scoutBucketsMemo = { candidates, monitored, buckets: L.scoutBuckets(candidates, monitored) };
  }
  return scoutBucketsMemo.buckets;
}
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
    '<button class="row scout-row" type="button" data-scout-key="' + esc(item.key) + '"' + (item.key === state.selectedScoutKey ? ' aria-selected="true" aria-current="true"' : "") + ">" +
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
    ? "Change how Scout describes and judges this regulator, and optionally add a channel. It changes once the repository owner submits the request."
    : "Tell Scout where a regulator publishes. Once the repository owner submits the request, Scout checks it and runs a first sweep, which only records what is there today.";
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
      state.cadenceUnreachable = false;
      cadenceSetMessage("Connected to Cadence", "Shared team entries are loaded. Changes are saved centrally and email reminders run on the scheduled service.", false);
    } catch (error) {
      state.cadenceEntries = [];
      state.cadenceMember = null;
      state.cadenceStatus = "error";
      state.cadenceError = String(error.message || error);
      // When the service can't be reached at all, a sign-in form beside the
      // error only invites a sign-in that cannot work: say what still does.
      state.cadenceUnreachable = /could not load|failed to fetch|networkerror|load failed/i.test(state.cadenceError);
      if (state.cadenceUnreachable) cadenceSetMessage("Team calendar is offline", "The team calendar service can't be reached right now. Regulatory dates below still show; team entries and sign-in come back when it does.", true);
      else cadenceSetMessage("Calendar access needs attention", state.cadenceError, true);
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
    refreshAppReviews();
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
  // One team account: signing out of Cadence signs out of review decisions too.
  state.teamMember = null; state.appReviews = []; state.teamStatus = "signed-out";
  renderTeamIdentity();
}
function renderCadenceAccess() {
  const session = state.cadenceSession;
  const member = state.cadenceMember;
  $("cadenceSignInForm").hidden = !!session || state.cadenceRecoveryMode || !!state.cadenceUnreachable;
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
      return '<article class="cadence-agenda-item"><div class="cadence-agenda-row"><i class="cadence-agenda-dot is-derived"></i><div class="cadence-agenda-content"><span class="cadence-agenda-title">' + esc(event.title) + '</span><div class="cadence-agenda-meta"><span class="cadence-tag">' + esc(isStatedDate(event.item) ? event.item.label : "Detected date") + '</span><span>ChangeSentinel</span></div>' +
        (event.item && event.item.description ? '<p class="cadence-agenda-notes">' + esc(String(event.item.description)) + "</p>" : "") + '</div></div><div class="cadence-agenda-actions">' +
        (safeHttpUrl(event.sourceUrl) ? '<a href="' + esc(safeHttpUrl(event.sourceUrl)) + '" target="_blank" rel="noopener noreferrer">Open source ↗</a>' : "") +
        (linked ? '<button type="button" data-calendar-open-change="' + esc(event.eventId) + '">View change →</button>' : "") + cadenceItemsAction(event) +
        (cadenceIsEditor() ? '<button type="button" data-calendar-track="' + esc(event.eventId) + '" data-calendar-entry="' + esc(event.item && event.item.id || "") + '" data-calendar-date="' + esc(event.date) + '" title="Add this date to the team calendar with an owner and a reminder">Track this</button>' : "") +
        cadenceCalendarLinks(event) + "</div></article>";
    }
    const entry = event.entry, isEditor = state.cadenceMember && ["admin", "editor"].includes(state.cadenceMember.role);
    const isDone = !!event.completed;
    const reminder = entry.reminder_enabled ? '<span class="cadence-tag is-reminder">Email reminder</span>' : "";
    return '<article class="cadence-agenda-item"><div class="cadence-agenda-row"><i class="cadence-agenda-dot ' + cadenceClass(event) + '"></i><div class="cadence-agenda-content"><span class="cadence-agenda-title">' + esc(event.title) + '</span><div class="cadence-agenda-meta"><span class="cadence-tag">' + esc(cadenceTag(event.category)) + '</span>' +
      (entry.regulator ? '<span>' + esc(entry.regulator) + '</span>' : "") + (entry.owner_name ? '<span>Owner: ' + esc(entry.owner_name) + '</span>' : "") + reminder + (entry.recurrence && entry.recurrence !== "none" ? '<span>↻ ' + esc(entry.recurrence) + '</span>' : "") +
      '</div>' + (entry.description ? '<p class="cadence-agenda-notes">' + esc(entry.description) + "</p>" : "") + '</div></div><div class="cadence-agenda-actions">' +
      (safeHttpUrl(event.sourceUrl) ? '<a href="' + esc(safeHttpUrl(event.sourceUrl)) + '" target="_blank" rel="noopener noreferrer">Open source ↗</a>' + cadenceSourceFlag(event.sourceUrl) : "") +
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
  const category = manual ? cadenceTag(event.category) : isStatedDate(event.item) ? event.item.label : "Detected date";
  const owner = manual && entry.owner_name ? '<span>Owner: ' + esc(entry.owner_name) + '</span>' : "";
  const regulator = manual && entry.regulator ? '<span>' + esc(entry.regulator) + '</span>' : "";
  const recurrence = manual && entry.recurrence && entry.recurrence !== "none" ? '<span>↻ ' + esc(entry.recurrence) + '</span>' : "";
  const notes = manual ? entry.description : event.item && event.item.description;
  // sourceUrl is free text on team entries: only http(s) becomes a link (no javascript:/data:).
  const source = safeHttpUrl(event.sourceUrl) ? '<a href="' + esc(safeHttpUrl(event.sourceUrl)) + '" target="_blank" rel="noopener noreferrer">Open source ↗</a>' : "";
  const changeLinked = !manual && event.eventId && changeLogEntries().some(change => change.event_id === event.eventId);
  const editActions = manual && state.cadenceMember && ["admin", "editor"].includes(state.cadenceMember.role)
    ? '<button type="button" data-calendar-complete="' + esc(event.entryId) + '" data-calendar-date="' + esc(event.occurrenceDate) + '" data-calendar-done="' + String(!!event.completed) + '">' + (event.completed ? "Reopen occurrence" : "Mark done") + '</button><button type="button" data-calendar-edit="' + esc(event.entryId) + '">Edit</button><button type="button" data-calendar-delete="' + esc(event.entryId) + '">Archive</button>'
    : (manual && event.completed ? '<span class="cadence-upcoming-completed">Completed</span>' : "");
  const changeAction = (changeLinked ? '<button type="button" data-calendar-open-change="' + esc(event.eventId) + '">View change →</button>' : "") + (manual ? "" : cadenceItemsAction(event));
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
function cadenceItemsAction(event) {
  const codes = event.item && Array.isArray(event.item.codes) ? event.item.codes : [];
  return codes.length ? '<button type="button" data-select-registry="' + esc("code:" + codes[0]) + '" title="' + esc(codes.join(", ")) + '">' +
    esc(codes.length === 1 ? "View item →" : "View items →") + "</button>" : "";
}
function trackDetectedDate(eventId, date, entryId) {
  const entries = state.calendar && Array.isArray(state.calendar.entries) ? state.calendar.entries : [];
  const item = (entryId && entries.find(entry => String(entry.id || "") === entryId)) ||
    entries.find(entry => eventId && String(entry.event_id || "") === eventId && String(entry.date || "") === date) || null;
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
  return { overview: "overviewView", changes: "changesView", monitors: "monitorsView", runs: "runsView", health: "healthView", notifications: "notificationsView", registry: "registryView", scout: "scoutView", calendar: "calendarView", askSentinel: "askSentinelView" }[view] || "overviewView";
}
function hasSelection(view) {
  return view === "changes" ? !!state.selectedChangeId : view === "monitors" ? !!state.selectedId
    : view === "runs" ? !!state.selectedRunId : view === "notifications" ? !!state.selectedNotificationId
    : view === "health" ? !!state.selectedHealthKey
    : view === "registry" ? !!state.selectedRegistryKey
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
  const titles = { overview: "Overview", changes: "Changes", monitors: "Pages", runs: "Runs", health: "Health", notifications: "Alerts", registry: "Registry", scout: "Scout", calendar: "Cadence", askSentinel: "Ask Sentinel" };
  document.title = titles[state.view] + " | ChangeSentinel";
}
// On wide screens the first row is selected automatically, so opening a view
// shows content immediately. On phones the list is shown first.
function ensureSelection(view) {
  if (isCompact()) return;
  if (view === "changes" && !filteredChanges().some(entry => entry.event_id === state.selectedChangeId)) {
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
  if (view === "registry" && !registryKeys().includes(state.selectedRegistryKey) && !/^(code|table):/.test(state.selectedRegistryKey)) state.selectedRegistryKey = registryKeys()[0] || "";
  if (view === "notifications") {
    const { pending, sent } = notificationLists();
    const special = state.selectedNotificationId === SHADOW_KEY || (state.selectedNotificationId.indexOf(DIGEST_PREFIX) === 0 && digestList().some(d => DIGEST_PREFIX + d.id === state.selectedNotificationId));
    if (!special && !pending.concat(sent).some(item => item.eventId === state.selectedNotificationId)) {
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
        L.datesForChange(state.calendar, entry.event_id), state.assetSignatures.lineage || "", state.assetSignatures.registry || "",
        state.assetSignatures.profile || "", state.assetSignatures.reportRules || "", state.assetSignatures.changeFacts || "", state.ruleIndex ? 1 : 0]) : "none";
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
      if (state.selectedNotificationId.indexOf(DIGEST_PREFIX) === 0) return "digest|" + state.selectedNotificationId + "|" + (state.assetSignatures.digests || "") + "|" + (state.assetSignatures.digestConfig || "") + "|" + (state.digestOpen ? state.digestOpen.record.id : "");
      if (state.selectedNotificationId === SHADOW_KEY) return "shadow|" + (state.shadow ? state.shadow.at || state.shadow.name || "" : "") + "|" + (state.shadow && state.shadow.loading ? 1 : 0);
      const { pending, sent } = notificationLists();
      const item = pending.concat(sent).find(candidate => candidate.eventId === state.selectedNotificationId);
      return item ? JSON.stringify([item, channelSummary()]) : "none";
    }
    if (view === "health") return JSON.stringify([state.selectedHealthKey, state.assetSignatures.health || "", state.assetSignatures.config || "",
      state.assetSignatures.reviews || "", state.assetSignatures.notifications || "", state.assetSignatures.inventory || ""]);
    if (view === "registry") return JSON.stringify([state.selectedRegistryKey, state.assetSignatures.registry || "", state.assetSignatures.registryTemplates || "", state.assetSignatures.lineage || "", state.assetSignatures.inventory || "",
      state.assetSignatures.profile || "", state.assetSignatures.reportRules || "", state.assetSignatures.changeFacts || ""]);
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
  else if (view === "registry") renderRegistryDetail();
  else if (view === "scout") renderScoutDetail();
  else if (view === "calendar") { renderCadenceView(); refreshCadence(); }
}
function resetDetailScroll(view) {
  const pane = { changes: "changeDetail", monitors: "detailView", runs: "runDetail", health: "healthDetail", notifications: "notificationDetail", registry: "registryDetail", scout: "scoutDetail", calendar: "calendarView" }[view];
  if (pane && $(pane)) $(pane).scrollTop = 0;
  if (view === "overview") $("overviewView").scrollTop = 0;
}
function writeHash() {
  const id = state.view === "changes" ? state.selectedChangeId : state.view === "monitors" ? state.selectedId
    : state.view === "runs" ? state.selectedRunId : state.view === "notifications" ? state.selectedNotificationId
    : state.view === "health" ? (state.selectedHealthKey === "fleet" ? "" : state.selectedHealthKey)
    : state.view === "registry" ? state.selectedRegistryKey
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
// Open the view and item a "#view/id" address names (first load and later hash changes).
function applyRoute(route, options) {
  if (route.id) {
    if (route.view === "changes") { state.selectedChangeId = route.id; revealChange(route.id); }
    if (route.view === "monitors" && state.items.some(item => item.url_id === route.id)) state.selectedId = route.id;
    if (route.view === "runs") state.selectedRunId = route.id;
    if (route.view === "notifications") state.selectedNotificationId = route.id;
    if (route.view === "health") state.selectedHealthKey = route.id;
    if (route.view === "registry") state.selectedRegistryKey = route.id;
    if (route.view === "scout") {
      state.selectedScoutKey = route.id;
      // A deep link to a finding outside the default list opens the list that holds it.
      const linked = scoutCandidates().find(item => item.key === route.id);
      const bucket = linked ? L.scoutBucket(linked, scoutMonitoredKeys()) : "";
      if (bucket) state.scoutFilter = bucket;
    }
  }
  setView(route.view, { detail: !!route.id, preserveHash: !!(options && options.preserveHash) });
}
// A link pasted into (or followed within) an open tab, such as an alert's
// "#changes/<id>", opens that item; it used to be read only on first load.
window.addEventListener("hashchange", () => {
  if (!state.loaded || isCadenceRecoveryRedirect()) return;
  const route = readHash();
  if (route) applyRoute(route);
});
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
// Opening a change the current filter hides (a code-only edit from a link, say)
// widens the list to All, so the open change is always one the list shows.
function revealChange(id) {
  if (id && state.changeFilter !== "ALL" && !filteredChanges().some(entry => entry.event_id === id) && changeLogEntries().some(entry => entry.event_id === id)) state.changeFilter = "ALL";
}
function select(view, id, options) {
  options = options || {};
  hideFieldTip();
  if (view === "changes") { state.selectedChangeId = id; revealChange(id); }
  if (view === "monitors") {
    if (options.tab) state.detailTab = options.tab;
    else if (state.selectedId !== id) state.detailTab = "";
    state.selectedId = id;
    state.snapshotMode = "preview";
  }
  if (view === "runs") state.selectedRunId = id;
  if (view === "notifications") state.selectedNotificationId = id;
  if (view === "health") state.selectedHealthKey = id;
  if (view === "registry") state.selectedRegistryKey = id;
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
const SMALL_ASSETS = ["report", "notifications", "outbox", "config", "scoutLatest", "scoutConfig", "calendar", "lineage", "registry", "registryTemplates", "reviews", "regulators", "health", "digests", "digestConfig", "reportRules", "profile"];
const LARGE_ASSETS = ["inventory", "history", "scoutReview", "changeFacts"];
const OPTIONAL_ASSETS = new Set(["scoutLatest", "scoutReview", "scoutConfig", "calendar", "lineage", "registry", "registryTemplates", "reviews", "regulators", "health", "digests", "digestConfig", "changeFacts", "reportRules", "profile"]);
const FULL_REFRESH_MS = 10 * 60 * 1000;
function assetsSignature() {
  return SMALL_ASSETS.concat(LARGE_ASSETS).map(key => key + "=" + (state.assetSignatures[key] || "")).join("|");
}
function scanMarker(report) { return report ? String(report.run_id || "") + "|" + String(report.generated_at || "") : ""; }
function sweepMarker(latest) { return latest ? String(latest.sweep_id || "") + "|" + String(latest.finished_at || "") : ""; }
async function fetchAssets(keys, background) {
  const values = await Promise.all(keys.map(key => fetchDataAsset(key, !OPTIONAL_ASSETS.has(key), background)));
  const out = {};
  keys.forEach((key, index) => { out[key] = values[index]; });
  return out;
}
// One load at a time. A reload asked for while one runs is queued and runs after
// it (chaining onto the running promise let its finally clear the chain, so a
// third call started a second, concurrent load).
function loadData(showErrors) {
  if (state.loading) {
    if (showErrors !== false) state.reloadQueued = true;
    return state.loading;
  }
  const run = async () => {
    await loadDataOnce(showErrors);
    while (state.reloadQueued) {
      state.reloadQueued = false;
      await loadDataOnce(true);
    }
  };
  state.loading = run().finally(() => { state.loading = null; });
  return state.loading;
}
async function loadDataOnce(showErrors) {
  const background = showErrors === false && state.loaded;
  if (!background) setStatus("Refreshing stored data…", false);
  if (showErrors !== false) $("loadError").hidden = true;
  try {
    const full = !background || Date.now() - state.lastFullLoad > FULL_REFRESH_MS;
    const values = await fetchAssets(full ? SMALL_ASSETS.concat(LARGE_ASSETS) : SMALL_ASSETS, background);
    if (!full) {
      // The large files only change with a new scan or sweep, which the small
      // report and sweep summary already show.
      const moved = scanMarker(values.report) !== scanMarker(state.report) || sweepMarker(values.scoutLatest) !== sweepMarker(state.scoutLatest);
      if (moved) Object.assign(values, await fetchAssets(LARGE_ASSETS));
      else LARGE_ASSETS.forEach(key => { values[key] = key === "history" ? state.history : key === "inventory" ? state.inventory : key === "changeFacts" ? state.changeFacts : state.scoutReview; });
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
    state.registry = values.registry;
    state.registryTemplates = values.registryTemplates;
    state.registryModel = L.registryModel(state.registry, state.lineage);
    state.reviews = values.reviews;
    state.regulators = values.regulators;
    state.health = values.health;
    state.digests = values.digests;
    state.digestConfig = values.digestConfig;
    state.changeFacts = values.changeFacts;
    // Suggested updates and their decisions are re-read after each data load (they change with scans and decisions).
    state.pagesJson = null;
    state.reportRules = values.reportRules;
    state.reportLibrary = L.reportLibrary(values.reportRules);
    state.profile = values.profile;
    state.assessments = null;
    state.regulatorProfiles = null;
    state.items = makeItems();
    state.scoutMonitored = null;
    const firstLoad = !state.loaded;
    state.loaded = true;
    hydrateDocumentTitles();
    if (firstLoad) {
      refreshAppReviews();
      const recoveryRedirect = isCadenceRecoveryRedirect();
      const route = recoveryRedirect ? { view: "calendar", id: "" } : readHash();
      if (route) {
        applyRoute(route, { preserveHash: recoveryRedirect });
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
// An import is split into requests of MAX_BULK_LINKS links each.
const MAX_IMPORT_LINKS = 2500;
const BULK_ACCEPTED = "Accepted columns: URL (required), Name, Workspace, Labels, Frequency, Status, Include Selector, Ignore Selectors.";
let bulkImport = null;
let bulkOpened = new Set();
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
// The page-reader version this dashboard was built with (READER_VERSION in
// supabase/functions/page-reader/index.ts). An older deployed reader sends
// pages without their styles, live view or reading view, so the dashboard says so.
const PAGE_READER_VERSION = "2026-10-27";
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
      candidates: a.candidates.slice(0, 6000), picked: Array.from(a.picked.keys()), opened: a.opened, rules: a.rules, ruleRequests: a.ruleRequests, steps: a.steps,
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
  a.steps = {};
  if (saved.steps && typeof saved.steps === "object") {
    Object.keys(saved.steps).slice(0, 50).forEach(key => {
      const entry = saved.steps[key] || {};
      const checked = L.validateBrowserSteps(Array.isArray(entry.actions) ? entry.actions : []);
      if (!checked.error && (checked.steps.length || entry.visual === true)) {
        a.steps[key] = { actions: checked.steps, labels: (Array.isArray(entry.labels) ? entry.labels : []).map(String).slice(0, 20), visual: entry.visual === true, url: String(entry.url || "") };
      }
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
  state.add.similarTo = null;
  const a = state.add;
  a.candidates = []; a.picked = new Map(); a.opened = {}; a.notes = []; a.history = []; a.at = -1; a.page = null; a.anchor = "";
  a.rules = {}; a.areas = []; a.ruleDrafts = {}; a.ruleRequests = {}; a.ruleOpen = false; a.steps = {}; a.recording = false; a.waitPick = false;
  try { localStorage.removeItem(ADD_DRAFT_STORAGE); } catch (_) {}
}

/* ---------- Steps ---------- */

const ADD_STEP_COPY = {
  start: ["Add a link", "Open a page and pick the links on it you want ChangeSentinel to monitor."],
  explore: ["Explore the page", "Click a link to open it here. Shift-click to select it, box an area, pick a part to watch or ignore, or record the steps a portal needs."],
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
// mode "links": links only (following links by level), no stylesheets fetched.
// mode "live": the original page, for the live view; kept apart from the copies.
async function addReadPage(url, options) {
  const a = state.add;
  const mode = options && options.mode === "live" ? "live" : options && options.mode === "links" ? "links" : "";
  const key = L.urlKey(url);
  const cache = mode === "live" ? a.livePages : a.pages;
  const cached = cache.get(key);
  if (cached && !(options && options.fresh) && !(mode === "" && cached.linksOnly)) return cached;
  if (!PAGE_READER_ENDPOINT) throw new Error("The page reader isn't set up for this dashboard yet");
  const identity = await askSentinelIdentity();
  const headers = Object.assign(askSentinelIdentityHeaders(identity), { "Content-Type": "application/json" });
  let response;
  try {
    response = await fetch(PAGE_READER_ENDPOINT, { method: "POST", headers, body: JSON.stringify(mode ? { url, mode } : { url }), signal: timeoutSignal(40000) });
  } catch (error) {
    throw new Error(error && (error.name === "TimeoutError" || error.name === "AbortError") ? "The page took too long to read" : "The page reader could not be reached");
  }
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || "The page reader answered HTTP " + response.status);
  if (data.kind === "page" && (!Array.isArray(data.links) || typeof data.html !== "string")) throw new Error("The page reader returned an unexpected answer");
  if (data.kind === "live" && typeof data.html !== "string") throw new Error("The page reader returned an unexpected answer");
  if (mode === "links") data.linksOnly = true;
  if (data.kind === "page" || data.kind === "live") a.readerStale = String(data.reader_version || "") >= PAGE_READER_VERSION ? null : { version: String(data.reader_version || "") };
  cache.set(key, data);
  if (data.url) cache.set(L.urlKey(data.url), data);
  while (cache.size > (mode === "live" ? 8 : 60)) cache.delete(cache.keys().next().value);
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
  a.areas = [];
  a.ruleOpen = false;
  a.recording = false;
  a.waitPick = false;
  a.autoTried = {};
  if (a.picking) a.picking = false;
  a.tab = a.picked.size ? a.tab : (exploreSuggestions().items.length ? "suggested" : "page");
  $("exploreAddress").textContent = displayUrl(data.url);
  $("exploreNewTab").href = safeHttpUrl(data.url) || "#";
  // A view the person chose for this site is kept as they browse it.
  const chosen = a.viewByHost[exploreHost(data.url)];
  exploreRender(chosen || "copy", "");
  renderExploreSide();
}

/* ---------- Three ways to show a page ----------
 * "Copy": the reader's script-free copy, with the site's stylesheets (and, for
 * sites that refuse cross-site requests, its images) written into it.
 * "Live": the original page with its own scripts, in the same sandbox, for pages
 * that draw their content with script.
 * "Reading view": the page's text, tables and links without the site's layout.
 * After a page is drawn the frame reports how much of it is visible; a copy that
 * comes out blank or as a loading skeleton moves on to the live page, and a live
 * page that stays blank moves on to the reading view. Links keep working in all three.
 */
const EXPLORE_VIEWS = [["copy", "Page"], ["live", "Live"], ["reader", "Reading view"]];
function exploreHost(url) { try { return new URL(url).hostname; } catch (_) { return ""; } }
async function exploreRender(view, why) {
  const a = state.add;
  const page = a.page;
  if (!page) return;
  a.view = EXPLORE_VIEWS.some(([key]) => key === view) ? view : "copy";
  if (a.view === "reader" && !page.reader) a.view = "copy";
  a.viewWhy = why || "";
  a.frameToken = exploreRandom(16);
  a.frameLoads = 0;
  a.areas = [];
  const frame = $("exploreFrame");
  if (a.view === "live") {
    const token = ++a.loading;
    exploreStatus('<div class="loading">Starting the live page…</div>', "loading");
    let live;
    try {
      live = await addReadPage(page.url, { mode: "live" });
    } catch (error) {
      if (token !== a.loading || a.page !== page) return;
      exploreStatus("", "ok");
      return exploreRender(page.reader ? "reader" : "copy", "The live page couldn't be loaded (" + String(error.message || error) + ").");
    }
    if (token !== a.loading || a.page !== page) return;
    exploreStatus("", "ok");
    if (!live || live.kind !== "live") return exploreRender(page.reader ? "reader" : "copy", (live && live.message) || "The live page couldn't be loaded.");
    frame.srcdoc = exploreLiveDocument(live.html, a.frameToken);
  } else {
    exploreStatus("", "ok");
    frame.srcdoc = exploreDocument(a.view === "reader" ? page.reader : page.html, a.frameToken, exploreRandom(18), a.view);
  }
  renderExploreViewBar();
}
function renderExploreViewBar() {
  const a = state.add;
  const page = a.page;
  const bar = $("exploreViewBar");
  if (!bar) return;
  const stale = a.readerStale ? "The page reader on Supabase is older than this dashboard" + (a.readerStale.version ? " (" + a.readerStale.version + ")" : "") +
    ", so pages can show without their styles and the Live and Reading views may not work. Redeploy the page-reader Edge Function. " : "";
  const words = stale + (a.viewWhy || (a.view === "live" ? "The live page runs the site's own scripts, sealed off from this dashboard."
    : a.view === "reader" ? "The page's text, tables and links, without the site's layout."
    : page && typeof page.notice === "string" ? page.notice.slice(0, 400) : ""));
  $("exploreNotice").textContent = words;
  $("exploreNotice").hidden = !words;
  bar.hidden = !page;
  bar.querySelectorAll("[data-explore-view]").forEach(button => {
    const key = button.dataset.exploreView;
    button.setAttribute("aria-pressed", String(key === a.view));
    button.disabled = !page || (key === "reader" && !page.reader);
  });
}
// The frame's own report on what it drew: visible text, and how many sample
// points across the view land on something with text or an image.
function exploreRenderReport(data) {
  const a = state.add;
  const page = a.page;
  if (!page) return;
  const visible = Number(data.visible) || 0;
  const skeleton = Number(data.skeleton) || 0;
  const blank = visible < 20;
  const tried = a.autoTried || (a.autoTried = {});
  if (a.viewByHost[exploreHost(page.url)]) return; // the person chose this view
  // A copy still showing loading placeholders, with little else to read, is
  // waiting for script that never runs here.
  const waiting = skeleton >= 3 && visible < 300;
  if (a.view === "copy" && !tried.live && (blank || (page.scripted && waiting))) {
    tried.live = true;
    return exploreRender("live", page.scripted || waiting
      ? "This page draws its content with script, so the live page is shown. Switch to Page or Reading view at any time."
      : "The copy of this page came out blank, so the live page is shown. Switch to Page or Reading view at any time.");
  }
  if (a.view === "live" && data.final && blank && !tried.reader && page.reader) {
    tried.reader = true;
    return exploreRender("reader", "Neither the copy nor the live page drew this site's layout here, so its reading view is shown: the same text, tables and links.");
  }
}
// Links the live page drew with script join the page's list.
function exploreLiveLinks(list) {
  const a = state.add;
  if (!a.page || !Array.isArray(list)) return;
  const known = new Set(a.page.links.map(link => L.urlKey(link.url)));
  let added = 0;
  list.slice(0, 4000).forEach(raw => {
    const url = safeHttpUrl(raw && raw.url);
    if (!url || known.has(L.urlKey(url)) || a.page.links.length >= 6000) return;
    known.add(L.urlKey(url));
    a.page.links.push({ url, text: String(raw.text || "").replace(/\s+/g, " ").trim().slice(0, 300), section: String(raw.section || "").slice(0, 160),
      format: L.pickFormat(url), chrome: !!raw.chrome });
    added += 1;
  });
  if (added) renderExploreSide();
}
function exploreLinkIndexFor(url, text) {
  const a = state.add;
  const safe = safeHttpUrl(url);
  if (!a.page || !safe) return -1;
  const key = L.urlKey(safe);
  let index = a.page.links.findIndex(link => L.urlKey(link.url) === key);
  if (index < 0) {
    a.page.links.push({ url: safe, text: String(text || "").replace(/\s+/g, " ").trim().slice(0, 300), section: "", format: L.pickFormat(safe), chrome: false });
    index = a.page.links.length - 1;
  }
  return index;
}
// The live page: the site's own document and scripts. The frame stays sandboxed
// (scripts only: no same-origin, forms, pop-ups or top navigation), so whatever
// runs there cannot reach the dashboard, its storage or its session.
function exploreLiveDocument(html, token) {
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: \'unsafe-inline\' \'unsafe-eval\'; ' +
    "form-action 'none'; object-src 'none'\">";
  const script = "<script>(" + exploreBridge.toString() + ")(" + JSON.stringify(token) + ", true, \"live\");<\/script>";
  let doc = String(html || "").replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
  doc = /<head\b[^>]*>/i.test(doc) ? doc.replace(/<head\b[^>]*>/i, match => match + policy) : policy + doc;
  doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, exploreFrameStyle() + "</head>") : exploreFrameStyle() + doc;
  doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, script + "</body>") : doc + script;
  return doc;
}
// The reader's copy, shown in a frame sandboxed with allow-scripts but without
// allow-same-origin: it runs in an opaque origin, so nothing in it can reach the
// dashboard, its storage or its cookies. The reader already strips every script
// and handler; this document's policy then admits only the one bridge script
// below, by nonce. The bridge reports link clicks (with Shift) by postMessage and
// draws the selection marks. Safari never runs event listeners that the parent
// page attaches inside a script-less sandboxed frame, so clicks are handled from
// within the frame instead. In the live view (live = true) the page's own links
// carry no numbers, so clicks, areas and selection marks also go by address,
// and the links the page draws are reported as they appear.
function exploreBridge(token, live, kind) {
  var root = document.documentElement;
  var areaSeq = 0;
  var shift = false;
  var picking = false;
  var boxing = false;
  var recording = false;
  var waitPick = false;
  var gesture = null;
  var swallowClick = false;
  var hovered = null;
  var areas = {};
  var layerEl = null;
  var scrollTimer = 0;
  var BLOCKS = "main,article,section,aside,nav,header,footer,form,table,tbody,ul,ol,dl,figure,fieldset,details,div,p,li,tr";
  function send(message) {
    message.cs = "cs-explore";
    message.token = token;
    try { parent.postMessage(message, "*"); } catch (e) {}
  }
  function ours(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    return !!(node && node.closest && node.closest("[data-cs-ui]"));
  }
  function linkOf(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    return node && node.closest ? node.closest("[data-cs-link], a[href], area[href]") : null;
  }
  // The address a link opens, absolute and without its #fragment.
  function addressOf(link) {
    var href = "";
    try { href = link.href && typeof link.href === "string" ? link.href : new URL(link.getAttribute("href") || "", document.baseURI).href; } catch (e) { href = ""; }
    return /^https?:/i.test(href) ? href.split("#")[0] : "";
  }
  function textOf(node) { return String(node.innerText || node.textContent || node.getAttribute("aria-label") || node.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 300); }
  function setShift(on) {
    shift = !!on;
    root.classList.toggle("cs-shift", shift);
  }
  function setPicking(on) {
    picking = !!on;
    root.classList.toggle("cs-picking", picking || waitPick);
    if (!picking && !waitPick) setHover(null);
  }
  function setHover(node) {
    if (hovered === node) return;
    if (hovered) hovered.removeAttribute("data-cs-hover");
    hovered = node;
    if (hovered) hovered.setAttribute("data-cs-hover", "");
  }
  // A short, stable CSS selector for a part of the page: an id when it has a
  // readable one, otherwise tags and classes, with :nth-of-type only where needed.
  // The browser adds <tbody> to every table; the page's own HTML (what a scan
  // reads) may not have one, so a tbody is never part of the selector.
  function stableClass(name) { return /^[A-Za-z_-][\w-]{1,40}$/.test(name) && !/^cs-/.test(name) && !/\d{3,}/.test(name) && !/^(active|open|show|hidden|selected|current|visible|focus|hover)$|^(is|has)-/.test(name); }
  function esc(value) { return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^\w-]/g, "\\$&"); }
  function unique(selector) { try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; } }
  function selectorFor(node) {
    if (!node || node.nodeType !== 1 || kind === "reader") return "";
    if (node.tagName === "TBODY" && node.parentElement) node = node.parentElement;
    var parts = [];
    var gap = " > ";
    var path = function () { var out = ""; for (var i = 0; i < parts.length; i++) out += parts[i].s + (i < parts.length - 1 ? parts[i].gap : ""); return out; };
    var current = node;
    while (current && current.nodeType === 1 && current !== document.body && current !== root) {
      if (current.tagName === "TBODY") { gap = " "; current = current.parentElement; continue; }
      var id = current.getAttribute("id");
      if (id && /^[A-Za-z][\w-]{1,60}$/.test(id) && !/\d{4,}/.test(id)) {
        parts.unshift({ s: "#" + esc(id), gap: gap });
        gap = " > ";
        if (unique(path())) return path();
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
        parts.unshift({ s: part, gap: gap });
        gap = " > ";
        // Stop at the first unique path anchored on a class, so a bare "ul" or
        // "div:nth-of-type(3)" isn't left to break when the page grows.
        if (classes.length && unique(path())) return path();
      }
      current = current.parentElement;
    }
    var short = path();
    return short && unique(short) ? short : (short ? "body > " + short : "body");
  }
  function labelFor(node) {
    var heading = node.querySelector && node.querySelector("h1,h2,h3,h4,caption,legend,summary");
    var name = node.getAttribute("aria-label") || (heading && heading.textContent) || "";
    var kindName = { TABLE: "Table", TBODY: "Table", UL: "List", OL: "List", NAV: "Menu", FORM: "Form", HEADER: "Header", FOOTER: "Footer", ASIDE: "Side panel", SECTION: "Section", ARTICLE: "Article", MAIN: "Main content", P: "Paragraph", H1: "Heading", H2: "Heading", H3: "Heading", H4: "Heading", TR: "Table row", LI: "List item", DL: "List" }[node.tagName] || "Part of the page";
    name = String(name).replace(/\s+/g, " ").trim();
    return name ? kindName + " · " + name.slice(0, 70) : kindName;
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
  // Links with no number (the live view): reported by address and text.
  function plainLinksIn(nodes) {
    var out = [], seen = {};
    for (var i = 0; i < nodes.length && out.length < 2000; i++) {
      if (nodes[i].hasAttribute("data-cs-link")) continue;
      var url = addressOf(nodes[i]);
      if (!url || seen[url]) continue;
      seen[url] = 1;
      out.push({ url: url, text: textOf(nodes[i]) });
    }
    return out;
  }
  // A link laid out with display: contents has no box of its own; its first
  // child with one stands in for it.
  function rectOf(node) {
    var r = node.getBoundingClientRect();
    if (r.width || r.height) return r;
    for (var child = node.firstElementChild; child; child = child.nextElementSibling) {
      var c = child.getBoundingClientRect();
      if (c.width || c.height) return c;
    }
    return null;
  }
  function commonAncestor(nodes) {
    if (!nodes.length) return null;
    var ancestor = nodes[0];
    for (var i = 1; i < nodes.length; i++) {
      while (ancestor && !ancestor.contains(nodes[i])) ancestor = ancestor.parentElement;
    }
    return ancestor && ancestor.nodeType === 1 && ancestor.nodeName !== "A" ? ancestor : ancestor && ancestor.parentElement;
  }

  /* ---- Areas: boxes on the page, numbered by the dashboard, that can be
   * resized from any edge or corner and moved by their number. Drawing (Shift
   * held, or "Box an area" on) scrolls the page when the pointer nears an edge,
   * and follows the wheel. Each box reports the links inside it and the part of
   * the page that holds them. */
  function layer() {
    if (!layerEl || !layerEl.isConnected) {
      layerEl = document.createElement("div");
      layerEl.className = "cs-area-layer";
      layerEl.setAttribute("data-cs-ui", "");
      root.appendChild(layerEl);
    }
    return layerEl;
  }
  var HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  function makeBox(id) {
    var box = document.createElement("div");
    box.className = "cs-area-box";
    box.setAttribute("data-cs-ui", "");
    if (id) box.setAttribute("data-area", String(id));
    box.innerHTML = '<span class="cs-area-num" title="Drag to move this area"></span><span class="cs-area-x" role="button" title="Remove this area" aria-label="Remove this area">×</span>' +
      HANDLES.map(function (h) { return '<span class="cs-h cs-h-' + h + '" data-h="' + h + '"></span>'; }).join("");
    layer().appendChild(box);
    return box;
  }
  function place(box, r) {
    box.style.left = r.x + "px";
    box.style.top = r.y + "px";
    box.style.width = Math.max(1, r.w) + "px";
    box.style.height = Math.max(1, r.h) + "px";
  }
  function norm(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; }
  function docSize() { return { w: Math.max(root.scrollWidth, document.body ? document.body.scrollWidth : 0), h: Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0) }; }
  function clampRect(r) {
    var size = docSize();
    var x = Math.max(0, Math.min(r.x, size.w - 8)), y = Math.max(0, Math.min(r.y, size.h - 8));
    return { x: x, y: y, w: Math.max(12, Math.min(r.w, size.w - x)), h: Math.max(12, Math.min(r.h, size.h - y)) };
  }
  function pointNow() { return { x: gesture.client.x + scrollX, y: gesture.client.y + scrollY }; }
  function follow() {
    if (!gesture) return;
    var p = pointNow();
    if (gesture.mode === "draw") {
      if (!gesture.moved && Math.abs(p.x - gesture.start.x) + Math.abs(p.y - gesture.start.y) < 8) return;
      if (!gesture.moved) {
        gesture.moved = true;
        capture();
        gesture.box = makeBox(0);
        gesture.box.classList.add("is-drawing");
        root.classList.add("cs-drawing");
      }
      gesture.rect = norm(gesture.start, p);
      place(gesture.box, gesture.rect);
      return;
    }
    var dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    gesture.moved = true;
    capture();
    var r0 = gesture.rect0, r = { x: r0.x, y: r0.y, w: r0.w, h: r0.h };
    if (gesture.mode === "move") { r.x = r0.x + dx; r.y = r0.y + dy; }
    else {
      var h = gesture.handle;
      if (h.indexOf("e") >= 0) r.w = r0.w + dx;
      if (h.indexOf("s") >= 0) r.h = r0.h + dy;
      if (h.indexOf("w") >= 0) { r.x = r0.x + dx; r.w = r0.w - dx; }
      if (h.indexOf("n") >= 0) { r.y = r0.y + dy; r.h = r0.h - dy; }
      if (r.w < 0) { r.x += r.w; r.w = -r.w; }
      if (r.h < 0) { r.y += r.h; r.h = -r.h; }
    }
    gesture.rect = clampRect(r);
    place(areas[gesture.id].box, gesture.rect);
  }
  // Near the top or bottom (or sides) of the view, the page scrolls on by itself.
  function edgeScroll() {
    if (!gesture) { scrollTimer = 0; return; }
    var edge = 40, c = gesture.client, dx = 0, dy = 0;
    if (c.y < edge) dy = -(edge - c.y); else if (c.y > innerHeight - edge) dy = c.y - (innerHeight - edge);
    if (c.x < edge) dx = -(edge - c.x); else if (c.x > innerWidth - edge) dx = c.x - (innerWidth - edge);
    if (dx || dy) {
      var sx = scrollX, sy = scrollY;
      scrollBy(Math.max(-28, Math.min(28, Math.round(dx * 0.6))), Math.max(-28, Math.min(28, Math.round(dy * 0.6))));
      if (scrollX !== sx || scrollY !== sy) follow();
    }
    scrollTimer = requestAnimationFrame(edgeScroll);
  }
  // The pointer is captured only once a box is really being drawn or changed:
  // captured from the press, a Shift-click's click would land on the page, not the link.
  function capture() {
    if (!gesture || gesture.captured) return;
    gesture.captured = true;
    try { root.setPointerCapture(gesture.pointerId); } catch (e) {}
  }
  function startGesture(g, event) {
    gesture = g;
    gesture.pointerId = event.pointerId;
    if (!scrollTimer) scrollTimer = requestAnimationFrame(edgeScroll);
  }
  function endGesture() {
    gesture = null;
    root.classList.remove("cs-drawing");
    if (scrollTimer) { cancelAnimationFrame(scrollTimer); scrollTimer = 0; }
  }
  function outline(area, node) {
    if (area.node && area.node !== node) area.node.removeAttribute("data-cs-area");
    area.node = node;
    if (node) node.setAttribute("data-cs-area", "");
  }
  // What a box holds: the links whose centre is inside it, and the smallest
  // part of the page that holds them (or, with no links, the part it covers).
  function measure(id, how) {
    var area = areas[id];
    if (!area) return;
    var r = area.rect, left = r.x, right = r.x + r.w, top = r.y, bottom = r.y + r.h;
    var all = document.querySelectorAll("[data-cs-link], a[href], area[href]");
    var inside = [], indexes = [];
    for (var i = 0; i < all.length; i++) {
      if (ours(all[i])) continue;
      var lr = rectOf(all[i]);
      if (!lr) continue;
      var cx = lr.left + scrollX + lr.width / 2, cy = lr.top + scrollY + lr.height / 2;
      if (cx >= left && cx <= right && cy >= top && cy <= bottom) {
        inside.push(all[i]);
        if (!all[i].hasAttribute("data-cs-link")) continue;
        var index = Number(all[i].getAttribute("data-cs-link"));
        if (indexes.indexOf(index) < 0) indexes.push(index);
      }
    }
    var node = area.fixed || commonAncestor(inside);
    if (!node) {
      area.box.style.visibility = "hidden";
      node = document.elementFromPoint((left + right) / 2 - scrollX, (top + bottom) / 2 - scrollY);
      area.box.style.visibility = "";
      var size = (right - left) * (bottom - top);
      while (node && node.parentElement && node !== document.body) {
        var nr = node.getBoundingClientRect();
        if (nr.width * nr.height >= size * 0.6) break;
        node = node.parentElement;
      }
    }
    if (!node || node === document.body || node === root || ours(node)) node = null;
    outline(area, node);
    var text = node ? String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim() : "";
    var plain = plainLinksIn(inside);
    send({ type: "area", id: id, how: how, indexes: indexes, links: plain, selector: node ? selectorFor(node) : "",
      label: node ? labelFor(node) : "Selected area", text: text.slice(0, 220), words: text ? text.split(" ").length : 0 });
  }
  function addArea(rect, how, fixed) {
    var id = ++areaSeq;
    var box = makeBox(id);
    areas[id] = { rect: clampRect(rect), box: box, node: null, fixed: fixed || null };
    place(box, areas[id].rect);
    measure(id, how);
    return id;
  }
  function removeArea(id) {
    var ids = id ? [id] : Object.keys(areas).map(Number);
    ids.forEach(function (key) {
      var area = areas[key];
      if (!area) return;
      if (area.box && area.box.parentNode) area.box.parentNode.removeChild(area.box);
      if (area.node) area.node.removeAttribute("data-cs-area");
      delete areas[key];
    });
  }
  function pickArea(node) {
    var r = node.getBoundingClientRect();
    addArea({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }, "pick", node);
  }

  /* ---- Recording steps (live view): clicks, choices and typing on the page
   * become the steps a scan replays in a real browser before reading it. Links
   * clicked while recording are written down, not followed. Passwords are never
   * recorded. */
  function stepSelector(el) {
    if (el.id && unique("#" + esc(el.id))) return "#" + esc(el.id);
    var names = ["name", "data-testid", "aria-label", "title", "value"];
    for (var a = 0; a < names.length; a++) {
      var v = el.getAttribute && el.getAttribute(names[a]);
      if (v && v.length < 80) {
        var s = el.tagName.toLowerCase() + "[" + names[a] + '="' + v.replace(/"/g, '\\"') + '"]';
        if (unique(s)) return s;
      }
    }
    var parts = [], n = el;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 6) {
      if (n.id && unique("#" + esc(n.id))) { parts.unshift("#" + esc(n.id)); break; }
      var p = n.tagName.toLowerCase();
      var sib = n.parentElement ? Array.prototype.filter.call(n.parentElement.children, function (c) { return c.tagName === n.tagName; }) : [];
      if (sib.length > 1) p += ":nth-of-type(" + (sib.indexOf(n) + 1) + ")";
      parts.unshift(p);
      n = n.parentElement;
    }
    return parts.join(" > ").slice(0, 200);
  }
  function recordStep(step, label) { send({ type: "step", step: step, label: String(label || "").slice(0, 80) }); }
  function recordClick(event) {
    var t = event.target;
    while (t && t.nodeType !== 1) t = t.parentNode;
    if (!t) return;
    var tag = t.tagName.toLowerCase(), type = String(t.type || "").toLowerCase();
    if (tag === "select" || tag === "option" || tag === "textarea" || (tag === "input" && ["checkbox", "radio", "submit", "button", "image", "reset"].indexOf(type) < 0)) return;
    if (tag === "input" && (type === "checkbox" || type === "radio")) { recordStep({ action: t.checked ? "check" : "uncheck", selector: stepSelector(t) }, textOf(t.closest("label") || t)); return; }
    var target = t.closest("a,button,[role=button],[role=tab],[role=option],[role=menuitem],input[type=submit],summary,label,[onclick]") || t;
    recordStep({ action: "click", selector: stepSelector(target) }, textOf(target));
    if (target.closest("a[href]")) { event.preventDefault(); }
  }
  document.addEventListener("change", function (event) {
    if (!recording || ours(event.target)) return;
    var t = event.target;
    if (!t || t.nodeType !== 1) return;
    var tag = t.tagName.toLowerCase(), type = String(t.type || "").toLowerCase();
    if (tag === "select") { recordStep({ action: "select", selector: stepSelector(t), value: String(t.value).slice(0, 200) }, t.options && t.selectedIndex >= 0 ? textOf(t.options[t.selectedIndex]) : ""); return; }
    if ((tag === "input" && ["checkbox", "radio", "submit", "button", "image", "reset", "file"].indexOf(type) < 0) || tag === "textarea") {
      if (type === "password") { send({ type: "step-note", text: "Password fields are never recorded." }); return; }
      recordStep({ action: "type", selector: stepSelector(t), text: String(t.value).replace(/[\r\n]+/g, " ").slice(0, 200) });
    }
  }, true);

  document.addEventListener("click", function (event) {
    if (swallowClick) { swallowClick = false; event.preventDefault(); event.stopPropagation(); return; }
    if (ours(event.target)) { event.preventDefault(); event.stopPropagation(); return; }
    if (waitPick) {
      event.preventDefault();
      event.stopPropagation();
      var waited = event.target && event.target.closest ? event.target.closest(BLOCKS) || event.target : null;
      waitPick = false;
      setPicking(picking);
      if (waited) send({ type: "waitfor", selector: stepSelector(waited), label: labelFor(waited) });
      return;
    }
    if (recording) { recordClick(event); return; }
    if (picking) {
      event.preventDefault();
      event.stopPropagation();
      var target = event.target && event.target.closest ? event.target.closest(BLOCKS) : null;
      if (target && target !== document.body) pickArea(target);
      return;
    }
    var link = linkOf(event.target);
    if (!link) return;
    var href = link.getAttribute("href") || "";
    if (!link.hasAttribute("data-cs-link") && href.charAt(0) === "#") return;
    event.preventDefault();
    event.stopPropagation();
    if (link.hasAttribute("data-cs-link")) { send({ type: "click", index: Number(link.getAttribute("data-cs-link")), shift: !!(event.shiftKey || shift) }); return; }
    var url = addressOf(link);
    if (url) send({ type: "click", url: url, text: textOf(link), shift: !!(event.shiftKey || shift) });
  }, true);
  ["auxclick", "dragstart"].forEach(function (name) {
    document.addEventListener(name, function (event) { if (linkOf(event.target) || gesture) event.preventDefault(); }, true);
  });
  document.addEventListener("submit", function (event) { event.preventDefault(); }, true);
  document.addEventListener("pointerdown", function (event) {
    if (event.button !== 0) return;
    var t = event.target;
    while (t && t.nodeType !== 1) t = t.parentNode;
    if (t && ours(t)) {
      var box = t.closest(".cs-area-box");
      var id = box ? Number(box.getAttribute("data-area")) : 0;
      if (!id || !areas[id]) return;
      event.preventDefault();
      event.stopPropagation();
      if (t.classList.contains("cs-area-x")) { removeArea(id); send({ type: "area-remove", id: id }); return; }
      var handle = t.getAttribute("data-h");
      var start = { x: event.clientX + scrollX, y: event.clientY + scrollY };
      var r = areas[id].rect;
      startGesture({ mode: handle ? "resize" : "move", handle: handle || "", id: id, start: start, client: { x: event.clientX, y: event.clientY }, rect0: { x: r.x, y: r.y, w: r.w, h: r.h }, rect: r, moved: false }, event);
      root.classList.add("cs-drawing");
      return;
    }
    if (!(event.shiftKey || boxing) || picking || recording || waitPick) return;
    event.preventDefault();
    startGesture({ mode: "draw", start: { x: event.clientX + scrollX, y: event.clientY + scrollY }, client: { x: event.clientX, y: event.clientY }, moved: false, box: null }, event);
  }, true);
  document.addEventListener("pointermove", function (event) {
    if (!!event.shiftKey !== shift) setShift(event.shiftKey);
    if (!gesture) {
      if (picking || waitPick) {
        var block = event.target && event.target.closest && !ours(event.target) ? event.target.closest(BLOCKS) : null;
        setHover(block && block !== document.body ? block : null);
      }
      return;
    }
    gesture.client = { x: event.clientX, y: event.clientY };
    follow();
  }, true);
  // The wheel (or a trackpad) scrolls the page while a box is being drawn or resized.
  window.addEventListener("scroll", function () { if (gesture) follow(); }, true);
  function finish(cancel) {
    var g = gesture;
    if (!g) return;
    endGesture();
    if (g.mode === "draw") {
      if (!g.moved) return;
      if (g.box && g.box.parentNode) g.box.parentNode.removeChild(g.box);
      swallowClick = true;
      setTimeout(function () { swallowClick = false; }, 0);
      if (!cancel && g.rect && g.rect.w >= 6 && g.rect.h >= 6) addArea(g.rect, "drag");
      return;
    }
    var area = areas[g.id];
    if (!area) return;
    if (cancel || !g.moved) { place(area.box, area.rect); return; }
    swallowClick = true;
    setTimeout(function () { swallowClick = false; }, 0);
    area.rect = g.rect;
    area.fixed = null;
    measure(g.id, "drag");
  }
  document.addEventListener("pointerup", function () { finish(false); }, true);
  document.addEventListener("pointercancel", function () { finish(true); }, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Shift") setShift(true);
    if (recording && event.key === "Enter" && event.target && event.target.tagName === "INPUT" && String(event.target.type || "").toLowerCase() !== "password") {
      recordStep({ action: "type", selector: stepSelector(event.target), text: String(event.target.value).slice(0, 200) });
      recordStep({ action: "press", key: "Enter", selector: stepSelector(event.target) });
    }
    if (event.key === "Escape") {
      if (gesture) { finish(true); return; }
      if (waitPick) { waitPick = false; setPicking(picking); send({ type: "waitoff" }); return; }
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
      if (data.urls && data.urls.length) {
        var wanted = {};
        data.urls.forEach(function (url) { wanted[url] = 1; });
        var anchors = document.querySelectorAll("a[href]:not([data-cs-link])");
        for (var k = 0; k < anchors.length; k++) if (wanted[addressOf(anchors[k])]) anchors[k].setAttribute("data-cs-picked", "");
      }
    } else if (data.type === "mode") {
      root.classList.toggle("cs-select", !!data.select);
    } else if (data.type === "shift") {
      setShift(data.on);
    } else if (data.type === "pick") {
      setPicking(data.on);
    } else if (data.type === "box") {
      boxing = !!data.on;
      root.classList.toggle("cs-boxing", boxing);
    } else if (data.type === "record") {
      recording = !!data.on;
      root.classList.toggle("cs-recording", recording);
    } else if (data.type === "waitpick") {
      waitPick = !!data.on;
      setPicking(picking);
    } else if (data.type === "rules") {
      markRules(data.include, data.ignore);
    } else if (data.type === "area-clear") {
      removeArea(data.id ? Number(data.id) : 0);
    } else if (data.type === "area-labels") {
      var labels = data.labels || {};
      Object.keys(areas).forEach(function (id) {
        var num = areas[id].box.querySelector(".cs-area-num");
        if (num) num.textContent = labels[id] ? String(labels[id]) : "";
      });
    } else if (data.type === "area-show") {
      var shown = areas[Number(data.id)];
      if (!shown) return;
      try { scrollTo({ top: Math.max(0, shown.rect.y - 60), behavior: "smooth" }); } catch (e) { scrollTo(0, Math.max(0, shown.rect.y - 60)); }
      shown.box.classList.remove("cs-flash");
      void shown.box.offsetWidth;
      shown.box.classList.add("cs-flash");
    } else if (data.type === "locate") {
      var target = document.querySelector('[data-cs-link="' + Number(data.index) + '"]');
      if (!target && data.url) {
        var all = document.querySelectorAll("a[href]");
        for (var n = 0; n < all.length && !target; n++) if (addressOf(all[n]) === data.url) target = all[n];
      }
      if (!target) return;
      try { target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { target.scrollIntoView(); }
      target.classList.remove("cs-flash");
      void target.offsetWidth;
      target.classList.add("cs-flash");
    }
  });
  // How much of the page is actually visible on the first screen: text and
  // images that are inside the view and not covered by something else. The
  // dashboard moves on to another view when a page comes out blank or stuck
  // on a loading skeleton.
  function health(final) {
    var body = document.body;
    var text = body ? String(body.innerText || "").replace(/\s+/g, " ").trim().length : 0;
    var W = innerWidth, H = innerHeight, visible = 0;
    var nodes = document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th,a,span,div,dd,dt,label,button,strong,em,b,img,svg,canvas,picture,video");
    for (var i = 0; i < nodes.length && i < 4000 && visible < 400; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) continue;
      var weight = 0;
      if (/^(IMG|SVG|CANVAS|PICTURE|VIDEO|svg)$/.test(el.tagName)) weight = r.width >= 40 && r.height >= 40 ? 50 : 0;
      else for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) weight += String(c.nodeValue || "").trim().length;
      if (!weight) continue;
      var x = Math.min(W - 1, Math.max(0, r.left + Math.min(r.width, 40) / 2)), y = Math.min(H - 1, Math.max(0, r.top + Math.min(r.height, 20) / 2));
      var hit = document.elementFromPoint(x, y);
      // A card is often covered by one link stretched over it; that still counts as seen.
      if (hit && (hit === el || el.contains(hit) || hit.contains(el) || (hit !== body && hit !== root && hit.closest && hit.closest("a[href], button, label")))) visible += weight;
    }
    var skeleton = document.querySelectorAll('.animate-pulse, [class*="skeleton"], [class*="Skeleton"], [class*="shimmer"]').length;
    send({ type: "render", text: text, visible: visible, skeleton: skeleton, final: !!final });
  }
  function reportLinks() {
    var anchors = document.querySelectorAll("a[href]");
    var out = [], seen = {};
    for (var i = 0; i < anchors.length && out.length < 4000; i++) {
      var url = addressOf(anchors[i]);
      if (!url || seen[url]) continue;
      seen[url] = 1;
      var chrome = !!(anchors[i].closest("header, nav, footer, [role=navigation], [role=banner], [role=contentinfo]") && !anchors[i].closest("main, article, [role=main]"));
      out.push({ url: url, text: textOf(anchors[i]), section: "", chrome: chrome });
    }
    send({ type: "links", links: out });
  }
  var settled = false;
  function settle() {
    if (settled) return;
    settled = true;
    setTimeout(function () { health(!live); if (live) reportLinks(); }, live ? 2500 : 900);
    if (live) setTimeout(function () { health(true); reportLinks(); }, 6000);
  }
  if (document.readyState === "complete") settle(); else { window.addEventListener("load", settle); setTimeout(settle, 7000); }
  send({ type: "ready" });
}
function exploreRandom(bytes) {
  const values = new Uint8Array(bytes);
  (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(values) : values.forEach((_, i) => { values[i] = Math.floor(Math.random() * 256); });
  return Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
}
function exploreDocument(html, token, nonce, kind) {
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-' + nonce + '\'; ' +
    "style-src * data: blob: 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src 'none'; " +
    "frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'\">";
  const style = exploreFrameStyle();
  const script = '<script nonce="' + nonce + '">(' + exploreBridge.toString() + ")(" + JSON.stringify(token) + ", false, " + JSON.stringify(kind === "reader" ? "reader" : "copy") + ");<\/script>";
  // Only the policy written here may apply: the reader's own (script-src 'none') would block the bridge.
  let doc = String(html || "").replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
  doc = /<head\b[^>]*>/i.test(doc) ? doc.replace(/<head\b[^>]*>/i, match => match + policy) : policy + doc;
  doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, style + "</head>") : style + doc;
  doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, script + "</body>") : doc + script;
  return doc;
}
function exploreFrameStyle() {
  const A = "#e8890a";
  return "<style>[data-cs-link]{cursor:pointer}" +
    "[data-cs-picked]{outline:2px solid " + A + "!important;outline-offset:2px;background:rgba(232,137,10,.16)!important;border-radius:2px}" +
    "html.cs-shift [data-cs-link],html.cs-select [data-cs-link]{cursor:copy!important;outline:1px dashed rgba(232,137,10,.85);outline-offset:2px}" +
    "@keyframes csFlash{0%,100%{box-shadow:0 0 0 0 rgba(232,137,10,0)}30%{box-shadow:0 0 0 6px rgba(232,137,10,.45)}}" +
    ".cs-flash{animation:csFlash 1.2s ease 2}" +
    "html.cs-picking,html.cs-picking *{cursor:crosshair!important}" +
    "html.cs-boxing body,html.cs-boxing body *{cursor:crosshair!important}" +
    "html.cs-drawing,html.cs-drawing *{user-select:none!important;-webkit-user-select:none!important}" +
    "html.cs-boxing{touch-action:none}" +
    "[data-cs-hover]{outline:2px dashed #3d7bd9!important;outline-offset:2px;background:rgba(61,123,217,.07)!important}" +
    "[data-cs-watch]{outline:2px solid #2f9e6b!important;outline-offset:4px;box-shadow:0 0 0 9999px rgba(20,24,30,.18)!important;position:relative;z-index:1}" +
    "[data-cs-ignore]{opacity:.35!important;filter:grayscale(1)!important;outline:1px dashed #c0392b!important}" +
    "[data-cs-area]{outline:1px dotted rgba(232,137,10,.9)!important;outline-offset:1px}" +
    ".cs-area-layer{position:absolute!important;left:0!important;top:0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;z-index:2147483640!important;pointer-events:none!important;display:block!important}" +
    ".cs-area-box{position:absolute!important;display:block!important;box-sizing:border-box!important;margin:0!important;padding:0!important;border:2px solid " + A + "!important;border-radius:3px!important;background:rgba(232,137,10,.07)!important;pointer-events:none!important;box-shadow:0 0 0 1px rgba(255,255,255,.7)!important}" +
    ".cs-area-box.is-drawing{border-style:dashed!important;background:rgba(232,137,10,.12)!important}" +
    ".cs-area-box>span{position:absolute!important;display:block!important;box-sizing:border-box!important;pointer-events:auto!important;margin:0!important}" +
    ".cs-area-num{left:-2px!important;top:-21px!important;min-width:20px!important;height:19px!important;padding:0 6px!important;border-radius:3px 3px 0 0!important;background:" + A + "!important;color:#fff!important;font:600 11px/19px system-ui,sans-serif!important;text-align:center!important;cursor:move!important}" +
    ".cs-area-num:empty{display:none!important}" +
    ".cs-area-x{right:-2px!important;top:-21px!important;width:20px!important;height:19px!important;border-radius:3px 3px 0 0!important;background:" + A + "!important;color:#fff!important;font:600 14px/19px system-ui,sans-serif!important;text-align:center!important;cursor:pointer!important}" +
    ".cs-area-box.is-drawing>span{display:none!important}" +
    ".cs-h{width:11px!important;height:11px!important;border:2px solid " + A + "!important;border-radius:2px!important;background:#fff!important}" +
    ".cs-h-n{top:-6px!important;left:calc(50% - 5px)!important;cursor:ns-resize!important}.cs-h-s{bottom:-6px!important;left:calc(50% - 5px)!important;cursor:ns-resize!important}" +
    ".cs-h-e{right:-6px!important;top:calc(50% - 5px)!important;cursor:ew-resize!important}.cs-h-w{left:-6px!important;top:calc(50% - 5px)!important;cursor:ew-resize!important}" +
    ".cs-h-ne{right:-6px!important;top:-6px!important;cursor:nesw-resize!important}.cs-h-sw{left:-6px!important;bottom:-6px!important;cursor:nesw-resize!important}" +
    ".cs-h-nw{left:-6px!important;top:-6px!important;cursor:nwse-resize!important}.cs-h-se{right:-6px!important;bottom:-6px!important;cursor:nwse-resize!important}" +
    "html.cs-recording body{box-shadow:inset 0 0 0 3px #d8432f!important}</style>";
}
function explorePost(message) {
  const frame = $("exploreFrame");
  if (!frame || !frame.contentWindow || !state.add.frameToken) return;
  try { frame.contentWindow.postMessage(Object.assign({ cs: "cs-explore", token: state.add.frameToken }, message), "*"); } catch (_) {}
}
function exploreSync() {
  const a = state.add;
  explorePost({ type: "mode", select: a.selectMode });
  exploreMarkPicked();
  exploreSendRules();
  exploreSetPicking(a.picking);
  explorePost({ type: "box", on: a.boxing });
  explorePost({ type: "record", on: a.recording && a.view === "live" });
  explorePost({ type: "waitpick", on: a.waitPick && a.recording });
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
  else if (data.type === "click") exploreLinkClick(typeof data.url === "string" ? exploreLinkIndexFor(data.url, data.text) : Number(data.index), !!data.shift);
  else if (data.type === "area") exploreAreaMessage(data);
  else if (data.type === "render") exploreRenderReport(data);
  else if (data.type === "links" && state.add.view === "live") exploreLiveLinks(data.links);
  else if (data.type === "pickoff") exploreSetPicking(false);
  else if (data.type === "area-remove") exploreAreaRemove(data.id, true);
  else if (data.type === "step" && state.add.recording && data.step && typeof data.step === "object") exploreStepAdd(data.step, data.label);
  else if (data.type === "step-note") showToast(String(data.text || "").slice(0, 200));
  else if (data.type === "waitfor" && typeof data.selector === "string") { state.add.waitPick = false; exploreStepAdd({ action: "wait_for", selector: data.selector.slice(0, 200), seconds: 10 }, data.label); }
  else if (data.type === "waitoff") { state.add.waitPick = false; renderExploreSide(); }
  // Escape inside the page closes the dialog, as it does anywhere else in it; the draft is kept.
  else if (data.type === "escape" && $("addMonitorDialog").open) $("addMonitorDialog").close();
});
// The live page runs the site's scripts; if they move the frame to another
// address, the bridge is gone, so the page is shown another way instead.
(() => {
  const frame = $("exploreFrame");
  if (!frame) return;
  frame.addEventListener("load", () => {
    const a = state.add;
    a.frameLoads = (a.frameLoads || 0) + 1;
    if (a.view === "live" && a.frameLoads > 1 && a.page) {
      (a.autoTried || (a.autoTried = {})).live = true;
      exploreRender(a.page.reader ? "reader" : "copy", "The live page tried to open another address inside this view, so its " + (a.page.reader ? "reading view" : "copy") + " is shown instead.");
    }
  });
})();
function exploreMarkPicked() {
  const a = state.add;
  if (!a.page) return;
  const indexes = [];
  const urls = [];
  a.page.links.forEach((link, index) => { if (a.picked.has(L.urlKey(link.url))) { indexes.push(index); urls.push(link.url); } });
  explorePost({ type: "picked", indexes, urls: a.view === "live" ? urls : [] });
}
function exploreLocate(url) {
  const a = state.add;
  if (!a.page || a.step !== "explore") return;
  const key = L.urlKey(url);
  const index = a.page.links.findIndex(link => L.urlKey(link.url) === key);
  if (index >= 0) explorePost({ type: "locate", index, url: a.page.links[index].url });
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
  const steps = exploreStepsFor(item.key);
  if (steps.actions.length || steps.visual) tags.push('<span class="tag is-part">' + esc(steps.actions.length ? plural(steps.actions.length, "recorded step", "recorded steps") : "Screenshots compared") + "</span>");
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
  const boxButton = document.querySelector("[data-explore-box]");
  if (boxButton) { boxButton.disabled = !a.page || a.recording; boxButton.setAttribute("aria-pressed", String(a.boxing)); }
  const recordButton = document.querySelector("[data-explore-record]");
  if (recordButton) { recordButton.disabled = !a.page; recordButton.setAttribute("aria-pressed", String(a.recording)); recordButton.textContent = a.recording ? "Stop recording" : "Record steps"; }
  $("exploreHint").innerHTML = a.recording
    ? "Recording: use the page as on the site. Each click, choice and typed value becomes a step; links are written down, not opened."
    : a.picking
    ? "Click any part of the page — a table, a list, a section — to select it."
    : a.boxing
    ? "Drag on the page to draw a box around an area. Drag its edges to resize it, its number to move it."
    : a.selectMode
    ? "Tap selects is on: clicking or tapping a link selects it. Turn it off to browse."
    : coarsePointer && coarsePointer.matches ? "Tap a link to open it here. Turn on <strong>Tap selects</strong> to select links, or use <strong>Pick a part</strong>."
      : "<kbd>Shift</kbd>-click a link to select it. <kbd>Shift</kbd>-drag (or <strong>Box an area</strong>) to draw a box you can resize. Click a link to open it here.";
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
  if (a.picking && a.boxing) exploreSetBoxing(false);
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
  // Steps recorded for this page (what a scan does before reading it).
  const steps = exploreStepsHtml();
  if (steps) parts.push(steps);
  // The parts of the page boxed or picked so far (several at once).
  const areas = exploreAreasHere();
  if (areas.length) parts.push(exploreAreasHtml(areas));
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
/* ---------- Selected areas: boxes drawn with Shift-drag (or "Box an area"), or Pick a part ----------
 * Each area is a box on the page that can be resized from its edges and
 * corners and moved by its number; the frame reports the links inside it and
 * the part of the page that holds them. The dashboard numbers them 1, 2, 3 in
 * the order they were made, and numbers again when one is removed.
 */
const AREA_LIMIT = 12;
function exploreAreasHere() {
  const a = state.add;
  const key = addPageKey();
  return (a.areas || []).filter(area => area.pageKey === key);
}
function exploreAreaNumber(id) {
  return exploreAreasHere().findIndex(area => area.id === Number(id)) + 1;
}
function exploreAreaLabels() {
  const labels = {};
  exploreAreasHere().forEach((area, index) => { labels[area.id] = index + 1; });
  explorePost({ type: "area-labels", labels });
}
function exploreAreaFree(area) {
  const a = state.add;
  return (area.indexes || []).filter(index => a.page.links[index] && !a.picked.has(L.urlKey(a.page.links[index].url)));
}
// Can the scan find this part? It reads the page's own HTML without script:
// a part drawn by script (live view) or one from the reading view (a layout
// of the reader's own) has no place there.
function exploreSelectorProblem(selector) {
  const a = state.add;
  if (!selector) return a.view === "reader" ? "Watching or ignoring a part needs the Page or Live view."
    : "Spans several parts of the page. To watch it, draw it around one table, list or section.";
  if (a.view !== "live" || !a.page || typeof DOMParser === "undefined") return "";
  try {
    if (!a.copyDoc || a.copyDoc.page !== a.page) a.copyDoc = { page: a.page, doc: new DOMParser().parseFromString(a.page.html || "", "text/html") };
    if (a.copyDoc.doc.querySelector(selector)) return "";
  } catch (_) {
    return "";
  }
  return "The site draws this part with script, and the scan reads the page without it, so it can't be watched as a part.";
}
function exploreAreasHtml(areas) {
  const allFree = new Set();
  areas.forEach(area => exploreAreaFree(area).forEach(index => allFree.add(index)));
  const usable = areas.filter(area => area.selector && !area.problem);
  const several = areas.length > 1;
  const row = (area, index) => {
    const free = exploreAreaFree(area);
    const links = (area.indexes || []).length;
    const watchTitle = area.problem || "Compare only this part when the page is checked";
    return '<div class="area-row" data-area-id="' + area.id + '">' +
      '<button class="area-num" type="button" data-area-show="' + area.id + '" title="Show area ' + (index + 1) + ' on the page">' + (index + 1) + "</button>" +
      '<div class="area-main" title="' + esc(area.text || "") + '"><span class="area-label">' + esc(area.label || "Part of the page") + "</span>" +
        '<span class="area-meta">' + esc(plural(links, "link", "links") + (area.text ? " · " + area.text : "")) + "</span></div>" +
      '<button class="area-remove" type="button" data-area-remove="' + area.id + '" aria-label="Remove area ' + (index + 1) + '" title="Remove this area">×</button>' +
      '<div class="area-acts">' +
        (links ? '<button class="btn area-act" type="button" data-area-select="' + area.id + '" title="Select the links in this area"' + (free.length ? "" : " disabled") + ">" + (free.length ? "Select " + free.length : "Selected ✓") + "</button>" : "") +
        '<button class="btn area-act" type="button" data-area-watch="' + area.id + '" title="' + esc(watchTitle) + '"' + (area.selector && !area.problem ? "" : " disabled") + ">Watch only</button>" +
        '<button class="btn area-act" type="button" data-area-ignore="' + area.id + '" title="' + esc(area.problem || "Leave this part out when the page is checked (menus, banners, dates that change every day)") + '"' + (area.selector && !area.problem ? "" : " disabled") + ">Ignore</button>" +
      "</div>" +
      (area.problem ? '<p class="area-problem">' + esc(area.problem) + "</p>" : "") + "</div>";
  };
  return '<section class="smart-card area-card" aria-label="Selected areas">' +
    '<div class="smart-card-head"><span class="smart-kicker">' + (several ? areas.length + " areas" : "1 area") + "</span>" +
      '<button class="text-button" type="button" data-area-clear>' + (several ? "Clear all" : "Clear") + "</button></div>" +
    areas.map(row).join("") +
    (several ? '<div class="area-all">' +
      '<button class="btn area-act is-strong" type="button" data-area-select="all"' + (allFree.size ? "" : " disabled") + ">" +
        (allFree.size ? "Select links in all " + areas.length + " (" + allFree.size + ")" : "All their links are selected") + "</button>" +
      (usable.length > 1 ? '<button class="btn area-act" type="button" data-area-watch="all">Watch only these ' + usable.length + "</button>" +
        '<button class="btn area-act" type="button" data-area-ignore="all">Ignore these ' + usable.length + "</button>" : "") +
      "</div>" : "") +
    '<p class="smart-note">Drag a box’s edges or corners to resize it, or its number to move it. Near the top or bottom of the page it scrolls for you.</p>' +
    "</section>";
}
function exploreAreaMessage(data) {
  const a = state.add;
  if (!a.page) return;
  const indexes = (Array.isArray(data.indexes) ? data.indexes : []).map(Number).filter(index => Number.isInteger(index) && a.page.links[index]);
  // Links the page drew with script (live view) are found by address.
  (Array.isArray(data.links) ? data.links : []).slice(0, 2000).forEach(link => {
    const index = exploreLinkIndexFor(link && link.url, link && link.text);
    if (index >= 0 && indexes.indexOf(index) < 0) indexes.push(index);
  });
  const id = Number(data.id);
  if (!Number.isInteger(id) || id <= 0) return;
  const selector = String(data.selector || "").slice(0, 1000);
  const area = { id, pageKey: addPageKey(), indexes: indexes.slice(0, 2000), selector, problem: exploreSelectorProblem(selector),
    label: String(data.label || "").slice(0, 120), text: String(data.text || "").slice(0, 240), words: Number(data.words) || 0, how: data.how === "pick" ? "pick" : "drag" };
  a.areas = a.areas || [];
  const at = a.areas.findIndex(existing => existing.id === id && existing.pageKey === area.pageKey);
  // A box that was resized or moved keeps its place (and its number).
  if (at >= 0) a.areas[at] = area; else a.areas.push(area);
  while (exploreAreasHere().length > AREA_LIMIT) {
    const dropped = exploreAreasHere()[0];
    a.areas = a.areas.filter(existing => existing !== dropped);
    explorePost({ type: "area-clear", id: dropped.id });
  }
  if (a.picking) exploreSetPicking(false);
  exploreAreaLabels();
  renderExploreSide();
  if (at < 0) {
    const list = $("exploreList");
    if (list) list.scrollTop = 0;
  }
}
function exploreAreaRemove(id, fromFrame) {
  const a = state.add;
  const key = addPageKey();
  a.areas = (a.areas || []).filter(area => !(area.pageKey === key && (id === "all" || area.id === Number(id))));
  if (!fromFrame) explorePost({ type: "area-clear", id: id === "all" ? 0 : Number(id) });
  exploreAreaLabels();
  renderExploreSide();
}
function exploreAreaAction(kind, which) {
  const a = state.add;
  if (!a.page) return;
  const here = exploreAreasHere();
  const chosen = which === "all" ? here : here.filter(area => area.id === Number(which));
  if (!chosen.length) return;
  if (kind === "select") {
    const indexes = Array.from(new Set([].concat(...chosen.map(area => area.indexes || []))));
    const added = addSelectKeys(indexes.map(index => L.urlKey(a.page.links[index].url)), indexes.map(index => a.page.links[index]));
    exploreMarkPicked();
    renderExploreSide();
    addSaveDraft();
    showToast(added ? plural(added, "link", "links") + " selected from " + (chosen.length > 1 ? chosen.length + " areas." : "area " + exploreAreaNumber(chosen[0].id) + ".") : "Those links were already selected.");
    return;
  }
  const usable = chosen.filter(area => area.selector && !area.problem);
  const selectors = Array.from(new Set(usable.map(area => area.selector)));
  if (!selectors.length) { showToast(chosen[0].problem || "That area has no part of the page the scan can find."); return; }
  const key = addPageKey();
  const rules = addRulesFor(key);
  const names = usable.length > 1 ? usable.length + " areas" : "area " + exploreAreaNumber(usable[0].id) + " (" + usable[0].label + ")";
  if (kind === "watch") {
    // Several parts are watched together: a CSS selector list matches all of them.
    const combined = selectors.join(", ");
    if (combined.length > RULE_LIMITS.selector) { showToast("Those parts have no short enough selector together. Pick fewer or more distinct parts."); return; }
    rules.include = combined;
    rules.ignore = rules.ignore.filter(selector => selectors.indexOf(selector) < 0);
    const previous = a.at > 0 ? a.pages.get(L.urlKey(a.history[a.at - 1])) : null;
    const pageItem = addItem({ url: a.page.url, title: a.page.title, parentUrl: previous ? previous.url : "", parentTitle: previous ? previous.title : "" });
    if (pageItem && !a.picked.has(pageItem.key)) addToggle(pageItem, true);
    showToast("This page will be compared only within " + names + ". The page is selected for monitoring.");
  } else {
    const fresh = selectors.filter(selector => selector.length <= RULE_LIMITS.selector && rules.ignore.indexOf(selector) < 0);
    if (rules.ignore.length + fresh.length > RULE_LIMITS.ignore) { showToast("A page can ignore at most " + RULE_LIMITS.ignore + " parts."); return; }
    rules.ignore = rules.ignore.concat(fresh);
    if (selectors.indexOf(rules.include) >= 0) rules.include = "";
    showToast(names.charAt(0).toUpperCase() + names.slice(1) + " will be left out when this page is checked.");
  }
  usable.forEach(area => explorePost({ type: "area-clear", id: area.id }));
  a.areas = a.areas.filter(area => usable.indexOf(area) < 0);
  exploreAreaLabels();
  addSetRules(key, rules);
  renderExploreSide();
}
function exploreSetBoxing(on) {
  const a = state.add;
  a.boxing = !!on;
  if (a.boxing && a.picking) exploreSetPicking(false);
  explorePost({ type: "box", on: a.boxing });
  const button = document.querySelector("[data-explore-box]");
  if (button) button.setAttribute("aria-pressed", String(a.boxing));
}

/* ---------- Recorded steps: what a scan does on the page before reading it ----------
 * "Record steps" opens the live page (the site's own scripts) and writes down
 * clicks, choices and typing as the steps a scan replays in a real browser
 * (fetch_mode "browser", browser_actions; regmon/browser_actions.py). The page
 * runs sealed off from the site, so a search may not answer here; the steps are
 * still the ones the scan replays. Steps can also be pasted from the recorder
 * bookmarklet used on the real site.
 */
const STEP_LIMIT = 20;
function exploreStepsFor(key) {
  const entry = state.add.steps && state.add.steps[key];
  return entry && Array.isArray(entry.actions) ? entry : { actions: [], labels: [], visual: false };
}
function exploreStepsSet(key, entry) {
  const a = state.add;
  a.steps = a.steps || {};
  if (!entry.actions.length && !entry.visual) delete a.steps[key];
  else a.steps[key] = { actions: entry.actions.slice(0, STEP_LIMIT), labels: (entry.labels || []).slice(0, STEP_LIMIT), visual: !!entry.visual, url: entry.url || (a.page ? a.page.url : "") };
  addSaveDraft();
}
function exploreStepAdd(step, label) {
  const a = state.add;
  if (!a.page) return;
  const key = addPageKey();
  const entry = exploreStepsFor(key);
  const actions = entry.actions.slice(), labels = (entry.labels || []).slice();
  const last = actions[actions.length - 1];
  // Typing into the same field is one step.
  if (last && step.action === "type" && last.action === "type" && last.selector === step.selector) { actions.pop(); labels.pop(); }
  if (actions.length >= STEP_LIMIT) { showToast("A page can have at most " + STEP_LIMIT + " steps."); return; }
  const checked = L.validateBrowserSteps(actions.concat([step]));
  if (checked.error) { showToast(checked.error); return; }
  actions.push(checked.steps[checked.steps.length - 1]);
  labels.push(String(label || ""));
  exploreStepsSet(key, { actions, labels, visual: entry.visual, url: a.page.url });
  exploreStepsSelectPage();
  renderExploreSide();
}
// A page with steps is monitored as itself: it is selected.
function exploreStepsSelectPage() {
  const a = state.add;
  if (!a.page) return;
  const previous = a.at > 0 ? a.pages.get(L.urlKey(a.history[a.at - 1])) : null;
  const pageItem = addItem({ url: a.page.url, title: a.page.title, parentUrl: previous ? previous.url : "", parentTitle: previous ? previous.title : "" });
  if (pageItem && !a.picked.has(pageItem.key)) addToggle(pageItem, true);
}
function exploreSetRecording(on) {
  const a = state.add;
  if (!a.page) return;
  a.recording = !!on;
  if (a.recording) {
    if (a.picking) exploreSetPicking(false);
    if (a.boxing) exploreSetBoxing(false);
    if (a.view !== "live") {
      a.viewByHost[exploreHost(a.page.url)] = "live";
      exploreRender("live", "Recording runs on the live page: use it as you would on the site. Clicks, choices and typing become the steps each scan replays before reading the page.");
    }
  }
  explorePost({ type: "record", on: a.recording });
  if (!a.recording) explorePost({ type: "waitpick", on: false });
  a.tab = a.recording ? "selected" : a.tab;
  renderExploreSide();
}
function exploreStepsHtml() {
  const a = state.add;
  if (!a.page) return "";
  const key = addPageKey();
  const entry = exploreStepsFor(key);
  if (!a.recording && !entry.actions.length && !entry.visual && !a.stepsOpen) return "";
  const labels = entry.labels || [];
  const rows = entry.actions.map((step, index) => '<li class="step-row"><span class="step-n">' + (index + 1) + '</span><span class="step-text" title="' + esc(step.selector || "") + '">' +
    esc(["click", "check", "uncheck", "wait_for"].indexOf(step.action) >= 0 && labels[index] ? L.describeBrowserStep(step).replace(step.selector, "“" + labels[index] + "”") : L.describeBrowserStep(step)) + "</span>" +
    '<button class="area-remove" type="button" data-step-remove="' + index + '" aria-label="Remove step ' + (index + 1) + '">×</button></li>').join("");
  return '<section class="smart-card steps-card' + (a.recording ? " is-recording" : "") + '" aria-label="Recorded steps">' +
    '<div class="smart-card-head"><span class="smart-kicker">' + (a.recording ? '<i class="rec-dot" aria-hidden="true"></i>Recording · ' : "Steps before reading · ") + entry.actions.length + "</span>" +
      '<button class="text-button" type="button" data-step-record>' + (a.recording ? "Stop" : "Record more") + "</button></div>" +
    (rows ? '<ol class="step-list">' + rows + "</ol>" : '<p class="smart-note">' + (a.recording ? "Use the page: choose, type and click as you would to reach what should be monitored." : "No steps yet.") + "</p>") +
    '<div class="area-acts">' +
      '<button class="btn area-act" type="button" data-step-waitpick' + (a.waitPick ? ' aria-pressed="true"' : "") + ">" + (a.waitPick ? "Click the part… (Esc)" : "+ Wait for a part") + "</button>" +
      '<button class="btn area-act" type="button" data-step-wait>+ Wait 2 s</button>' +
      (entry.actions.length ? '<button class="btn area-act" type="button" data-step-undo>Undo</button><button class="btn area-act" type="button" data-step-clear>Clear</button>' : "") +
    "</div>" +
    '<label class="field-check step-visual"><input type="checkbox" data-step-visual' + (entry.visual ? " checked" : "") + "> Also compare screenshots of the page</label>" +
    '<p class="smart-note">The page here runs sealed off from the site, so a search may not answer; each scan replays these steps in a real browser, then reads the page.</p>' +
    '<details class="step-paste"><summary>Record on the real site instead</summary>' +
      '<p class="smart-note">For portals that need a sign-in or several pages: drag <a class="recorder-link" href="' + esc(L.recorderBookmarklet()) + '" data-step-bookmarklet>ChangeSentinel recorder</a> to your bookmarks bar, use the portal, click it, then <em>Copy steps</em> and paste them here.</p>' +
      '<textarea class="field-input is-code" id="stepPaste" rows="3" spellcheck="false" placeholder="Paste the copied steps"></textarea>' +
      '<div class="area-acts"><button class="btn area-act" type="button" data-step-paste>Use these steps</button></div></details>' +
    "</section>";
}
function exploreStepAction(target) {
  const a = state.add;
  const key = addPageKey();
  const entry = exploreStepsFor(key);
  if (target.closest("[data-step-record]")) return exploreSetRecording(!a.recording);
  const remove = target.closest("[data-step-remove]");
  if (remove) {
    const index = Number(remove.dataset.stepRemove);
    const actions = entry.actions.slice(), labels = (entry.labels || []).slice();
    actions.splice(index, 1); labels.splice(index, 1);
    exploreStepsSet(key, { actions, labels, visual: entry.visual });
    return renderExploreSide();
  }
  if (target.closest("[data-step-undo]")) {
    exploreStepsSet(key, { actions: entry.actions.slice(0, -1), labels: (entry.labels || []).slice(0, -1), visual: entry.visual });
    return renderExploreSide();
  }
  if (target.closest("[data-step-clear]")) { exploreStepsSet(key, { actions: [], labels: [], visual: entry.visual }); return renderExploreSide(); }
  if (target.closest("[data-step-wait]")) return exploreStepAdd({ action: "wait", seconds: 2 }, "");
  if (target.closest("[data-step-waitpick]")) {
    a.waitPick = !a.waitPick;
    explorePost({ type: "waitpick", on: a.waitPick });
    return renderExploreSide();
  }
  if (target.closest("[data-step-paste]")) {
    const raw = ($("stepPaste") || {}).value || "";
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return showToast("Those steps are not valid JSON. Paste exactly what the recorder copied."); }
    const checked = L.validateBrowserSteps(parsed);
    if (checked.error) return showToast(checked.error);
    exploreStepsSet(key, { actions: checked.steps, labels: [], visual: entry.visual });
    exploreStepsSelectPage();
    showToast(plural(checked.steps.length, "step", "steps") + " added for this page.");
    return renderExploreSide();
  }
  if (target.closest("[data-step-bookmarklet]")) return showToast("Drag this link to your bookmarks bar, then click it on the portal you want to record.");
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
        addReadPage(job.url, { mode: "links" }).then(data => {
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

/* ---------- Find similar: pages like one monitored page ----------
 * Starts from where the page is listed (Scout's record of the page that
 * linked it, the monitor's own start page, or the nearest section page),
 * follows links two levels within that section, and lists the most similar
 * links first in the usual review step. Nothing is ticked for the owner.
 */
async function findSimilar(urlId) {
  const item = state.items.find(candidate => candidate.url_id === urlId);
  if (!item) return;
  const source = sourceForItem(item);
  const target = { url: item.canonical_url, title: healthName({ name: itemTitle(item) }), format: L.pickFormat(item.canonical_url, item.content_type) };
  const scoutParents = scoutCandidates().filter(candidate => L.urlKey(candidate.url) === L.urlKey(item.canonical_url))
    .map(candidate => candidate.evidence && candidate.evidence.parent_url).filter(Boolean);
  const seeds = (source.seed_urls || []).filter(seed => L.urlKey(seed) !== L.urlKey(item.canonical_url));
  const starts = L.similarStarts(target, { parents: scoutParents.concat(seeds) });
  openAddMonitor();
  const a = state.add;
  a.similarTo = target;
  $("newMonitorUrl").value = starts[0] || item.canonical_url;
  showToast("Looking for pages like \u201c" + target.title + "\u201d\u2026");
  let start = "";
  for (const url of starts) {
    try {
      const page = await addReadPage(url, { mode: "links" });
      if (page.kind === "page" && (page.links || []).filter(link => !link.chrome).length >= 3) { start = page.url || url; break; }
    } catch (_) { /* try the next place it may be listed */ }
  }
  if (!start) { a.similarTo = null; showToast("Couldn't find a page that lists this one. Open its section in Add a link instead."); return; }
  a.url = start;
  $("newMonitorUrl").value = start;
  const options = L.pickScopeOptions(start);
  const scope = (options.find(option => option.id === "section") || options[0] || {}).prefix || "";
  await crawlStart(start, 2, scope);
  a.similarTo = target;
  if (a.step === "review") renderReview();
}
function similarEntries(plan, scoreOf) {
  const a = state.add;
  if (!a.similarTo) return [];
  const free = a.candidates.filter(item => !plan.monitored.has(item.key) && !plan.stopped.has(item.key));
  return L.rankSimilar(a.similarTo, free.map(item => Object.assign({}, item, { title: item.title }))).map(entry => ({
    item: a.candidates.find(candidate => candidate.key === entry.link.key) || entry.link, score: entry.score, reasons: entry.reasons
  })).filter(entry => entry.item && entry.item.key);
}

/* ---------- Confirm ---------- */

// Each link carries the page it was found on (listed_on: its lineage is then
// recorded every scan) and, for a page with recorded steps, those steps.
function addRequestRows(items) {
  return items.map(item => {
    const rules = addRulesFor(item.key);
    const row = { url: item.url, name: L.pickMonitorName(item), include_selector: rules.include, ignore_selectors: rules.ignore };
    if (item.parentUrl && L.urlKey(item.parentUrl) !== item.key) row.listed_on = item.parentUrl;
    const steps = exploreStepsFor(item.key);
    if (steps.actions.length) row.browser_actions = steps.actions;
    if (steps.visual) row.visual_compare = true;
    return row;
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
  const workspaceList = $("reviewWorkspaceList");
  if (workspaceList && !workspaceList.childElementCount) {
    const names = Array.from(new Set(scopeOptions().workspaces.filter(ws => !ws.auto).map(ws => ws.name).concat(["NAM", "EMEA", "LATAM", "APAC"])));
    workspaceList.innerHTML = names.map(name => '<option value="' + esc(name) + '"></option>').join("");
  }
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
  const similar = similarEntries(plan, scoreOf);
  const similarKeys = new Set(similar.map(entry => entry.item.key));
  const pool = a.candidates.filter(item => {
    if (similarKeys.has(item.key)) return false;
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
  if (a.similarTo) notes.unshift("Looking for pages like \u201c" + a.similarTo.title + "\u201d: " + (similar.length ? plural(similar.length, "close match is", "close matches are") + " listed first." : "no close match was found, so every link found nearby is listed."));
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
  } else if (!total && !similar.length) {
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
    if (similar.length) {
      html += '<div class="link-group"><span class="link-group-name"><strong>Most like \u201c' + esc(a.similarTo.title) + "\u201d</strong> · " + similar.length + "</span></div>" +
        similar.map(entry => addPickRow(entry.item, { reasons: entry.reasons.concat(scoreOf(entry.item).reasons || []).slice(0, 4), older: scoreOf(entry.item).older, monitored: false, stopped: false, locked: false, covered: plan.covered.has(entry.item.key), part: "" })).join("");
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
  renderReviewConditionSuggestions();
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
// Workspace and labels for every new monitor in the review step's requests.
function reviewOrganise() {
  const workspace = ($("reviewWorkspace") ? $("reviewWorkspace").value : "").trim();
  const labels = L.parseLabels($("reviewLabels") ? $("reviewLabels").value : "");
  const bad = (workspace ? [workspace] : []).concat(labels).filter(text => !L.validTag(text));
  if (bad.length) { showToast("Use 1\u201340 letters, digits, spaces or & / + . - _ in: " + bad.join(", ")); return null; }
  if (labels.length > L.LABEL_MAX) { showToast("At most " + L.LABEL_MAX + " labels."); return null; }
  return { workspace, labels };
}
function reviewOpenBatch(index) {
  const a = state.add;
  const plan = addPlan();
  const batch = plan.prepared.batches[index];
  if (!batch) return renderReviewFoot(plan);
  const alert = reviewAlertCondition();
  if (alert === null) return;
  const organise = reviewOrganise();
  if (organise === null) return;
  const target = makeBulkGitHubIssueUrl(batch, alert, organise);
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
// Reads URL, name, selectors, and (from another tool's export) workspace,
// labels, check frequency and status; see L.importRows.
function bulkRowsFromMatrix(matrix) {
  const known = new Set(state.items.map(item => L.canonicalUrl(item.canonical_url)).concat(
    activeSources().filter(source => (source.seed_urls || []).length === 1).map(source => L.canonicalUrl(source.seed_urls[0]))));
  const result = L.importRows(matrix, known);
  if (result.rows.length > MAX_IMPORT_LINKS) result.errors.push("An import can hold up to " + MAX_IMPORT_LINKS.toLocaleString() + " new links. Split this file.");
  return result;
}
function setBulkStatus(message, isError) {
  const status = $("bulkImportStatus");
  status.textContent = message;
  status.classList.toggle("is-error", !!isError);
}
function bulkOrganise() {
  const workspace = $("bulkWorkspace").value.trim();
  const labels = L.parseLabels($("bulkLabels").value);
  const bad = (workspace ? [workspace] : []).concat(labels).filter(text => !L.validTag(text));
  return { workspace, labels, shadow: $("bulkShadow").checked, bad };
}
function bulkBatches() {
  const batches = [];
  for (let i = 0; i < bulkImportRows.length; i += MAX_BULK_LINKS) batches.push(bulkImportRows.slice(i, i + MAX_BULK_LINKS));
  return batches;
}
function renderBulkPreview() {
  const preview = $("bulkImportPreview");
  const actions = $("bulkImportActions");
  const summary = $("bulkImportSummary");
  preview.replaceChildren();
  const skipped = bulkImport ? bulkImport.skipped : { existing: [], paused: [] };
  const anything = bulkImportRows.length || skipped.existing.length || skipped.paused.length;
  summary.hidden = !anything;
  $("bulkImportOptions").hidden = !bulkImportRows.length;
  actions.hidden = !anything;
  if (anything) {
    const chips = [plural(bulkImportRows.length, "new link", "new links")];
    if (skipped.existing.length) chips.push(skipped.existing.length + " already monitored");
    if (skipped.paused.length) chips.push(skipped.paused.length + " paused, left out");
    const workspaces = new Map(), cadences = new Map();
    bulkImportRows.forEach(row => {
      if (row.workspace) workspaces.set(row.workspace, (workspaces.get(row.workspace) || 0) + 1);
      const label = L.scanScheduleLabel(L.scanSchedule({ check_every_hours: row.check_every_hours || 6 }));
      cadences.set(label, (cadences.get(label) || 0) + 1);
    });
    workspaces.forEach((count, name) => chips.push(name + " · " + count));
    if (cadences.size > 1 || !cadences.has("Every 6 hours")) cadences.forEach((count, label) => chips.push(label + " · " + count));
    if (bulkImport && bulkImport.conditions) chips.push(bulkImport.conditions + " alert conditions not imported");
    summary.innerHTML = chips.map(text => '<span class="chip is-static">' + esc(text) + "</span>").join("");
  }
  preview.hidden = !bulkImportRows.length;
  bulkImportRows.slice(0, 5).forEach(item => {
    const line = document.createElement("div");
    line.className = "bulk-preview-row";
    const name = document.createElement("span");
    name.className = "bulk-preview-name";
    name.textContent = (item.name || item.url) + (item.workspace ? " \u00b7 " + item.workspace : "");
    const url = document.createElement("span");
    url.className = "bulk-preview-url";
    try { url.textContent = new URL(item.url).hostname; } catch (_) { url.textContent = item.url; }
    line.append(name, url);
    preview.appendChild(line);
  });
  if (bulkImportRows.length > 5) {
    const more = document.createElement("div");
    more.className = "field-help";
    more.textContent = "+ " + (bulkImportRows.length - 5).toLocaleString() + " more links";
    preview.appendChild(more);
  }
  const batches = bulkBatches();
  const blocked = !!bulkImportErrors.length;
  $("bulkRequests").innerHTML = !batches.length ? "" : batches.map((batch, index) => {
    const opened = bulkOpened.has(index);
    const label = batches.length === 1 ? (opened ? "Open again" : "Continue with " + plural(batch.length, "link", "links"))
      : (opened ? "Open again " : "Request ") + (index + 1) + " of " + batches.length;
    return '<button class="btn' + (opened ? "" : " btn-primary") + '" type="button" data-bulk-batch="' + index + '"' + (blocked ? " disabled" : "") + ' title="' + esc(plural(batch.length, "link", "links")) + '">' + esc(label) + "</button>";
  }).join("");
}
function openBulkBatch(index) {
  const batch = bulkBatches()[index];
  if (!batch || bulkImportErrors.length) return;
  const organise = bulkOrganise();
  if (organise.bad.length) { setBulkStatus("Use 1\u201340 letters, digits, spaces or & / + . - _ in: " + organise.bad.join(", "), true); return; }
  const target = makeBulkGitHubIssueUrl(batch, null, organise);
  if (target.length > MAX_BULK_REQUEST_URL_LENGTH) { setBulkStatus("Request " + (index + 1) + " is too long for GitHub; shorten names or labels in the file.", true); return; }
  bulkOpened.add(index);
  renderBulkPreview();
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) {
    try { githubWindow.opener = null; } catch (_) {}
    showToast("Request " + (index + 1) + " of " + bulkBatches().length + " opened on GitHub. Submit it there; nothing is registered until you do.");
  } else {
    showToast("Your browser blocked the new tab. Allow pop-ups for this dashboard and press the button again.");
  }
}
async function readBulkFile(file) {
  bulkImportRows = [];
  bulkImportErrors = [];
  renderBulkPreview();
  if (!file) {
    setBulkStatus(BULK_ACCEPTED, false);
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
    bulkImport = result;
    bulkImportRows = result.rows;
    bulkImportErrors = result.errors;
    bulkOpened = new Set();
    if (bulkImportErrors.length) {
      setBulkStatus("Found " + bulkImportErrors.length + " issue(s): " + bulkImportErrors.slice(0, 3).join(" ") + (bulkImportErrors.length > 3 ? " …" : ""), true);
    } else if (!bulkImportRows.length) {
      setBulkStatus("Nothing new to import: every link in the file is already monitored or paused.", false);
    } else {
      const batches = Math.ceil(bulkImportRows.length / MAX_BULK_LINKS);
      setBulkStatus("Ready to import " + bulkImportRows.length.toLocaleString() + " new links" + (batches > 1 ? " in " + batches + " requests of up to " + MAX_BULK_LINKS : "") + ". " +
        (result.columns && result.columns.frequency >= 0 ? "Check frequencies were matched to the nearest scan schedule (fastest every 6 hours). " : "") +
        (extension === "xlsx" ? "Read from the first worksheet." : "Parsed in this browser."), false);
    }
  } catch (error) {
    bulkImport = null;
    bulkImportRows = [];
    bulkImportErrors = [String(error && error.message || error)];
    setBulkStatus(bulkImportErrors[0], true);
  }
  renderBulkPreview();
}
function makeBulkGitHubIssueUrl(rows, alert, organise) {
  const bodyLines = [
    BULK_REQUEST_MARKER, "",
    "Please register the URLs listed below as ChangeSentinel monitors.", ""
  ];
  if (alert && alert.condition) bodyLines.push("Alert me when: " + alert.condition, "Alert only when condition met: " + (alert.only ? "yes" : "no"), "");
  if (organise && organise.workspace) bodyLines.push("Workspace: " + organise.workspace);
  if (organise && organise.labels && organise.labels.length) bodyLines.push("Labels: " + organise.labels.join(", "));
  if (organise && organise.shadow) bodyLines.push("Shadow mode: yes");
  if (organise && (organise.workspace || (organise.labels || []).length || organise.shadow)) bodyLines.push("");
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
function clearBulkImport() {
  $("bulkMonitorFile").value = "";
  bulkImport = null;
  bulkImportRows = [];
  bulkImportErrors = [];
  bulkOpened = new Set();
  renderBulkPreview();
  setBulkStatus(BULK_ACCEPTED, false);
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
/* Team sign-in and in-app decisions (review-api). The account is the one
 * Cadence uses: an approved email on the team list. Admins and editors record
 * decisions; viewers read them. GitHub stays available to the repository owner. */
const REVIEW_ENDPOINT = window.CHANGESENTINEL_REVIEW_ENDPOINT || "";
async function teamSession() {
  const client = cadenceGetClient();
  const result = await client.auth.getSession();
  const session = result.data && result.data.session;
  return session && session.access_token ? session : null;
}
async function reviewApi(method, payload) {
  const session = await teamSession();
  if (!session) { const error = new Error("Sign in with your team account first."); error.status = 401; throw error; }
  state.cadenceSession = session;
  const headers = { Accept: "application/json", apikey: CADENCE_PUBLISHABLE_KEY, Authorization: "Bearer " + session.access_token };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const response = await fetch(method === "GET" ? REVIEW_ENDPOINT + "?action=list" : REVIEW_ENDPOINT,
    { method, headers, body: method === "GET" ? undefined : JSON.stringify(payload || {}), cache: "no-store" });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) { const error = new Error(data.error || "The decision service returned HTTP " + response.status + "."); error.status = response.status; throw error; }
  return data;
}
function teamCanDecide() { return !!(state.teamMember && (state.teamMember.role === "admin" || state.teamMember.role === "editor")); }
async function refreshAppReviews() {
  if (!REVIEW_ENDPOINT) { state.teamStatus = "off"; renderTeamIdentity(); return; }
  try {
    const session = await teamSession();
    if (!session) {
      state.teamStatus = "signed-out"; state.teamMember = null; state.appReviews = [];
    } else {
      const data = await reviewApi("GET");
      state.appReviews = Array.isArray(data.decisions) ? data.decisions : [];
      state.teamMember = data.member || null;
      state.teamStatus = "ready";
    }
    state.teamError = "";
  } catch (error) {
    const status = Number(error && error.status);
    state.teamStatus = status === 401 ? "signed-out" : status === 403 ? "not-member" : "unavailable";
    state.teamError = String((error && error.message) || error);
    if (status === 401 || status === 403) { state.teamMember = null; state.appReviews = []; }
  }
  renderTeamIdentity();
  if (state.loaded) {
    renderLists();
    if (state.view === "changes") renderChangeDetail();
  }
  if ($("reviewDialog") && $("reviewDialog").open) syncReviewAccess();
}
function renderTeamIdentity() {
  const line = $("railTeam");
  if (!line) return;
  const member = state.teamMember;
  line.innerHTML = member
    ? "Signed in as " + esc(member.name || member.email) + (member.role === "viewer" ? " (read-only)" : "") + ' · <button class="text-button" type="button" data-team-signout>Sign out</button>'
    : state.teamStatus === "not-member" ? 'Signed in, but not on the team list · <button class="text-button" type="button" data-team-signout>Sign out</button>' : "";
  line.hidden = !line.innerHTML;
}
async function signOutTeam() {
  await signOutCadence();
  state.teamMember = null; state.appReviews = []; state.teamStatus = "signed-out";
  renderTeamIdentity();
  if (state.loaded) { renderLists(); if (state.view === "changes") renderChangeDetail(); }
  showToast("Signed out.");
}
// The dialog says what Save will do, and offers sign-in only when it is needed.
function syncReviewAccess() {
  const status = state.teamStatus;
  const member = state.teamMember;
  const canDecide = teamCanDecide();
  const signIn = $("reviewSignIn");
  signIn.hidden = canDecide || status === "unavailable" || status === "off" || !!(member && member.role === "viewer");
  $("reviewSignInLede").textContent = status === "not-member"
    ? "This account is not on the team list. Sign in with an approved team email, or ask an admin to add this one."
    : "Sign in with your team account to save this decision here, under your name.";
  $("reviewSave").disabled = !canDecide;
  $("reviewSave").title = canDecide ? "" : "Sign in with a team account that can record decisions";
  $("reviewInfo").textContent = canDecide
    ? "Saved at once as " + (member.name || member.email) + " and kept with the change. Earlier decisions are never erased."
    : member && member.role === "viewer" ? "Your team role is read-only. Ask an admin to make you an editor to record decisions."
    : status === "unavailable" || status === "off" ? "The decision service can't be reached right now. If you own the repository, use GitHub instead."
    : "Earlier decisions are never erased. If you own the repository you can also use GitHub instead.";
}
async function signInFromReview() {
  const email = $("reviewSignInEmail").value.trim().toLowerCase();
  const password = $("reviewSignInPassword").value;
  if (!email) { $("reviewSignInEmail").focus(); return; }
  if (!password) { $("reviewSignInPassword").focus(); return; }
  const button = $("reviewSignInButton");
  button.disabled = true;
  $("reviewStatus").hidden = true;
  try {
    const result = await cadenceGetClient().auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    state.cadenceSession = result.data && result.data.session;
    $("reviewSignInPassword").value = "";
    await refreshAppReviews();
    if (!teamCanDecide() && state.teamStatus !== "ready") throw new Error(state.teamError || "This account can't record decisions.");
  } catch (error) {
    $("reviewStatus").textContent = String((error && error.message) || error);
    $("reviewStatus").hidden = false;
  } finally {
    button.disabled = false;
    syncReviewAccess();
  }
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
  syncReviewAccess();
  dialog.showModal();
  if (state.teamStatus === "unknown") refreshAppReviews();
  window.setTimeout(() => { const first = document.querySelector('input[name="reviewDecision"]'); if (first) first.focus(); }, 30);
}
function reviewInput() {
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
    return null;
  }
  return { entry, decision: choice.value, request };
}
async function submitReview(event) {
  event.preventDefault();
  if (!teamCanDecide()) { syncReviewAccess(); return; }
  const input = reviewInput();
  if (!input) return;
  const save = $("reviewSave");
  save.disabled = true;
  save.textContent = "Saving…";
  try {
    const data = await reviewApi("POST", {
      action: "decide", decision: input.decision,
      rationale: $("reviewRationale").value, owner: $("reviewOwner").value, ticket: $("reviewTicket").value,
      events: [{ event_id: input.entry.event_id, event_type: input.entry.event_type, url: input.entry.url, detected_at: input.entry.timestamp }]
    });
    state.appReviews = (state.appReviews || []).concat(Array.isArray(data.decisions) ? data.decisions : []);
    $("reviewDialog").close();
    renderLists();
    if (state.view === "changes") renderChangeDetail();
    showToast("Decision saved: " + (L.REVIEW_DECISIONS[input.decision] || input.decision) + ". Your team sees it now; it reaches the committed record within about 15 minutes.");
  } catch (error) {
    $("reviewStatus").textContent = String((error && error.message) || error);
    $("reviewStatus").hidden = false;
    if (Number(error && error.status) === 401) refreshAppReviews();
  } finally {
    save.textContent = "Save decision";
    syncReviewAccess();
  }
}
// The repository owner can still record a decision through a GitHub request.
function submitReviewViaGitHub() {
  const input = reviewInput();
  if (!input) return;
  const params = new URLSearchParams();
  params.set("title", input.request.title);
  params.set("body", input.request.body);
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
function exportAssessment(entry) {
  const a = profileReady() && CHANGE_EVENT_TYPES.indexOf(entry.event_type) >= 0 ? assessmentFor(entry.event_id) : null;
  if (!a) return ["", "", "", ""];
  return [L.APPLICABILITY_WORDS[a.applicability.status] || a.applicability.status, a.priority.band ? "P" + a.priority.band + " · " + a.priority.reasons.join(" · ") : "",
    a.applicability.reason, a.gaps ? a.gaps.codes.join(" ") + (a.gaps.unmapped > a.gaps.codes.length ? " …" : "") : ""];
}
function exportChanges() {
  const entries = filteredChanges();
  if (!entries.length) { showToast("Nothing to export: the list is empty."); return; }
  const rows = [["Detected (UTC)", "Event", "Page", "URL", "Source", "AI assessment", "AI topic", "Review decision", "Reviewed by", "Reviewed at (UTC)",
    "Rationale", "Owner", "Ticket", "Reporting items", "Spec changes", "Downstream", "Dates", "Applies to you", "Priority", "Why", "Unmapped items", "Dashboard link", "Evidence file", "Event ID"]];
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
      L.describeSpec(entry.spec),
      isPlainObject(entry.impact) ? String(entry.impact.sentence || "") : "",
      L.datesForChange(state.calendar, entry.event_id).map(date => date.date + " " + (date.label || "")).join("; "),
      ...exportAssessment(entry),
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
    applicability: CHANGE_EVENT_TYPES.indexOf(entry.event_type) >= 0 && assessmentFor(entry.event_id) ? Object.assign({
      facts: ((state.changeFacts || {}).events || {})[entry.event_id] || null, profile_updated_at: profileNow().updated_at || null,
      basis: "Deterministic: config/reports.json rules and config/profile.json, joined in the dashboard (regmon/applicability.py assess)." }, assessmentFor(entry.event_id)) : null,
    dates: L.datesForChange(state.calendar, entry.event_id),
    reporting_items: codes,
    downstream_impact: evidence && isPlainObject(evidence.impact) ? evidence.impact : null,
    spec_changes: evidence && isPlainObject(evidence.spec_diff) ? evidence.spec_diff : (evidence && isPlainObject(evidence.spec_inventory) ? evidence.spec_inventory : null),
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
bind("workspace", "click", event => {
  const target = event.target.closest("[data-precision-apply],[data-report-missed],[data-preflight-csv],[data-preflight-template],[data-profile-edit],[data-profile-remove],[data-go-applies],[data-select-registry],[data-registry-scheme],[data-registry-copy],[data-registry-import],[data-suggest-copy],[data-suggest-decide],[data-registry-add],[data-registry-edit],[data-registry-edit-consumer],[data-registry-seed],[data-spec-filter],[data-spec-csv],[data-review-change],[data-evidence-pack],[data-export-changes],[data-copy-calendar],[data-verify-fingerprints],[data-select-change],[data-monitor-id],[data-select-run],[data-select-health],[data-edit-condition],[data-edit-schedule],[data-edit-organise],[data-pick-source],[data-select-shown],[data-bulk],[data-scope-clear],[data-shadow-download],[data-shadow-import],[data-find-similar],[data-digest-edit],[data-digest-open],[data-digest-latest],[data-channel-guide],[data-select-notification],[data-go],[data-open-page],[data-back],[data-diff-mode],[data-detail-tab],[data-snapshot-mode],[data-pdf-action],[data-refresh],[data-add-monitor],[data-change-filter],[data-filter],[data-scout-key],[data-scout-filter],[data-scout-coverage],[data-scout-monitor],[data-scout-dismiss],[data-scout-restore],[data-scout-run],[data-scout-add-source],[data-scout-add-channel],[data-scout-edit],[data-calendar-mode],[data-calendar-jump-date],[data-calendar-prev],[data-calendar-next],[data-calendar-today],[data-calendar-new],[data-calendar-export],[data-calendar-day],[data-calendar-edit],[data-calendar-delete],[data-calendar-complete],[data-calendar-open-change],[data-calendar-test],[data-calendar-signout],[data-calendar-plan],[data-calendar-track],[data-calendar-ics],[data-calendar-monitor]");
  if (!target) return;
  const data = target.dataset;
  if (data.preflightCsv !== undefined) return downloadPreflightResults();
  if (data.preflightTemplate !== undefined) return downloadPreflightTemplate();
  if (data.calendarMode) { state.cadencePanel = data.calendarMode === "upcoming" ? "upcoming" : "month"; return renderCadenceView(); }
  if (data.calendarJumpDate) {
    if (state.view !== "calendar") setView("calendar");
    return jumpCadenceToDate(data.calendarJumpDate);
  }
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
  if (data.calendarTrack !== undefined) return trackDetectedDate(data.calendarTrack, data.calendarDate, data.calendarEntry);
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
  if (data.specFilter) {
    state.specFilter = data.specFilter;
    const entry = changeById(state.selectedChangeId);
    if (entry) fillSpecChanges(entry, "change-spec", () => state.view === "changes" && state.selectedChangeId === entry.event_id);
    return;
  }
  if (data.specCsv) return downloadSpecCsv(data.specCsv);
  if (data.selectRegistry) return select("registry", data.selectRegistry);
  if (data.precisionApply) return applyPrecisionSuggestion(data.precisionApply, data.precisionIndex);
  if (data.reportMissed) return openMissedDialog(data.reportMissed);
  if (data.registryScheme) { state.registryScheme = data.registryScheme; renderRegistry(); return; }
  if (data.registryCopy !== undefined) return copyRegistryStarter();
  if (data.suggestCopy) return copySuggestion(data.suggestCopy);
  if (data.suggestDecide) return decideSuggestion(data.suggestRule || "", data.suggestDecide);
  if (data.registryImport !== undefined) return openRegistryImport();
  if (data.registryAdd !== undefined) return openRegistryDialog({ mode: "add", code: data.registryCode || "", consumer: data.registryConsumer || "" });
  if (data.registryEdit) return openRegistryDialog({ mode: "edit", key: data.registryEdit });
  if (data.registryEditConsumer) return openRegistryDialog({ mode: "consumer", consumer: data.registryEditConsumer });
  if (data.registrySeed) return openRegistryDialog({ mode: "seed", urlId: data.registrySeed });
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
  if (data.editOrganise) return openOrganise(data.editOrganise.split(","));
  if (data.pickSource) return togglePicked(data.pickSource);
  if (data.selectShown !== undefined) {
    const shown = shownMonitorIds();
    const all = shown.length && shown.every(id => state.picked.has(id));
    shown.forEach(id => all ? state.picked.delete(id) : state.picked.add(id));
    renderMonitorList(); renderSelectBar(); return;
  }
  if (data.bulk) {
    const ids = Array.from(state.picked);
    if (data.bulk === "schedule") return openScanSchedule(ids);
    if (data.bulk === "organise") return openOrganise(ids);
    return openPreset(ids);
  }
  if (data.scopeClear !== undefined) return setScope(null);
  if (data.findSimilar) return findSimilar(data.findSimilar);
  if (data.shadowDownload !== undefined) return downloadShadowComparison();
  if (data.shadowImport !== undefined) return importShadowPages();
  if (data.digestEdit !== undefined) return openDigestDialog();
  if (data.digestOpen !== undefined) return openOlderDigest(data.digestOpen, data.digestOf);
  if (data.digestLatest !== undefined) { state.digestOpen = null; renderNotificationDetail(); return; }
  if (data.channelGuide !== undefined) { const guide = $("channelGuide"); if (guide) { guide.open = true; guide.scrollIntoView({ block: "nearest" }); } return; }
  if (data.selectNotification) return select("notifications", data.selectNotification);
  if (data.go) return setView(data.go);
  if (data.openPage) return select("monitors", data.openPage, { tab: data.openTab === "links" ? "links" : "changes" });
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
  if (data.profileEdit !== undefined) return openProfileEditor();
  if (data.profileRemove !== undefined) return removeProfileEntity(Number(data.profileRemove));
  if (data.goApplies !== undefined) { state.changeFilter = "APPLIES"; state.changeSort = "priority"; return setView("changes"); }
  if (data.changeFilter) {
    state.changeFilter = data.changeFilter;
    document.querySelectorAll("[data-change-filter]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.changeFilter === state.changeFilter)));
    renderChangeRoute();
    // Never leave a change the list no longer shows open beside it: a decision
    // recorded there would look as if it were for a change in the list.
    if (!isCompact() && !filteredChanges().some(entry => entry.event_id === state.selectedChangeId)) {
      const first = filteredChanges()[0];
      state.selectedChangeId = first ? first.event_id : "";
      renderChangeRoute();
      renderChangeDetail();
      writeHash();
    }
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
bind("signalVisual", "pointermove", event => {
  if (event.pointerType !== "mouse") return;
  const tip = $("fieldTip");
  if (tip.classList.contains("is-pinned")) return;
  showFieldTip(event.target.closest(".led"), event.clientX, event.clientY);
});
bind("signalVisual", "pointerover", event => {
  const label = event.target.closest && event.target.closest(".field-label[data-row]");
  if (label) ledField.hoverRow(Number(label.dataset.row));
  else if (!(event.target.closest && event.target.closest(".led"))) ledField.hoverRow(-1);
});
bind("signalVisual", "pointerleave", event => {
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
bind("signalVisual", "click", event => {
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
/* ----- The scan field by keyboard: one light is in the tab order, the arrow keys
 * move between lights (Home/End to a row's ends), Enter opens what a click
 * opens, and the light's tip is shown as it takes focus. ----- */
function fieldLight(field, x, y) {
  return field.querySelector('.led[data-x="' + x + '"][data-y="' + y + '"]');
}
function fieldFocusRestore(field, refocus) {
  const lights = field.querySelectorAll(".led");
  if (!lights.length) return;
  lights.forEach(light => light.setAttribute("tabindex", "-1"));
  const at = state.fieldFocus || {};
  const target = (at.x != null && fieldLight(field, at.x, at.y)) || field.querySelector('.led:not([data-state="none"])') || lights[0];
  target.setAttribute("tabindex", "0");
  if (refocus) target.focus({ preventScroll: true });
}
function moveFieldFocus(field, from, dx, dy, edge) {
  const x0 = Number(from.dataset.x), y0 = Number(from.dataset.y);
  let next = null;
  if (edge) {
    const row = Array.from(field.querySelectorAll('.led[data-y="' + y0 + '"]'));
    next = edge === "start" ? row[0] : row[row.length - 1];
  } else {
    for (let step = 1; step < 400 && !next; step += 1) {
      const y = y0 + dy * step, x = x0 + dx * step;
      if (y < 0 || x < 0) break;
      next = fieldLight(field, x, y);
      if (!next && dx) break;
    }
  }
  if (!next) return;
  from.setAttribute("tabindex", "-1");
  next.setAttribute("tabindex", "0");
  state.fieldFocus = { x: Number(next.dataset.x), y: Number(next.dataset.y) };
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest", inline: "nearest" });
}
bind("signalVisual", "keydown", event => {
  const light = event.target.closest && event.target.closest(".led");
  if (!light) return;
  const field = $("signalVisual");
  const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (moves[event.key]) { event.preventDefault(); moveFieldFocus(field, light, moves[event.key][0], moves[event.key][1]); return; }
  if (event.key === "Home" || event.key === "End") { event.preventDefault(); moveFieldFocus(field, light, 0, 0, event.key === "Home" ? "start" : "end"); return; }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (light.dataset.fieldGroup) toggleFieldGroup(light.dataset.fieldGroup);
    else if (light.dataset.monitorId) { hideFieldTip(); light.click(); }
    return;
  }
  if (event.key === "Escape") hideFieldTip();
});
bind("signalVisual", "focusin", event => {
  const light = event.target.closest && event.target.closest(".led");
  // Keyboard focus only: a click also focuses the light, and has its own tip handling.
  if (light && light.dataset.state !== "none" && light.matches(":focus-visible")) showFieldTip(light, 0, 0, true);
});
function toggleFieldGroup(key) {
  const prefs = fieldPrefs();
  if (key.indexOf("src:") === 0 || key.indexOf("sec:") === 0) { if (prefs.closed.has(key)) prefs.closed.delete(key); else prefs.closed.add(key); }
  else if (prefs.open.has(key)) prefs.open.delete(key); else prefs.open.add(key);
  hideFieldTip();
  renderMonitoringSignal();
}
bind("fieldTip", "click", event => {
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
bind("fieldGroup", "change", () => {
  const prefs = fieldPrefs();
  prefs.groupBy = Object.prototype.hasOwnProperty.call(FIELD_GROUPS, $("fieldGroup").value) ? $("fieldGroup").value : "regulator";
  prefs.limits = {};
  saveFieldPrefs();
  hideFieldTip();
  renderMonitoringSignal();
});
bind("fieldRange", "change", () => {
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
bind("tlLanes", "change", () => {
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
bind("timelineView", "click", event => {
  if (event.target.closest("[data-tl-lanes-more]")) { event.stopPropagation(); fieldPrefs().tlLaneLimit = (fieldPrefs().tlLaneLimit || TL_LANE_LIMIT) + TL_LANE_LIMIT * 2; return renderMonitoringSignal(); }
  const bead = event.target.closest("[data-tl-bead]");
  if (bead) { event.stopPropagation(); hideTimelineTip(); return focusTimelineBead(bead.dataset.tlBead); }
  if (event.target.closest("[data-tl-more]")) { event.stopPropagation(); fieldPrefs().storyLimit = (fieldPrefs().storyLimit || 60) + 60; return renderMonitoringSignal(); }
  const range = event.target.closest("[data-tl-range]");
  if (range) { event.stopPropagation(); const prefs = fieldPrefs(); prefs.range = "all"; saveFieldPrefs(); return renderMonitoringSignal(); }
});
bind("timelineView", "pointerover", event => {
  const bead = event.target.closest("[data-tl-bead]");
  if (bead && event.pointerType === "mouse") showTimelineTip(bead);
});
bind("timelineView", "pointerout", event => {
  if (event.target.closest("[data-tl-bead]") && !(event.relatedTarget && event.relatedTarget.closest && event.relatedTarget.closest("[data-tl-bead]"))) hideTimelineTip();
});
bind("timelineView", "focusin", event => { const bead = event.target.closest("[data-tl-bead]"); if (bead) showTimelineTip(bead); });
bind("timelineView", "focusout", hideTimelineTip);
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
// Runs has its own tab in the phone bar (where Ask used to be); More holds the rest.
const MORE_VIEWS = { health: "Health", registry: "Registry", scout: "Scout", calendar: "Cadence" };
function syncMoreTab() {
  const button = $("navMore");
  if (!button) return;
  const inMore = Object.prototype.hasOwnProperty.call(MORE_VIEWS, state.view);
  button.classList.toggle("is-more-active", inMore);
  button.setAttribute("aria-current", inMore ? "page" : "false");
  $("navMoreLabel").textContent = inMore ? MORE_VIEWS[state.view] : "More";
  const dot = $("navMoreDot");
  const failing = healthTotals().failing || 0;
  const review = state.scoutReview ? scoutBuckets().REVIEW.length : 0;
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
    : totals.stale ? plural(totals.stale, "monitor overdue", "monitors overdue") : healthNumber(totals.healthy) + " of " + healthNumber(totals.monitors) + " monitors working now";
  const healthSub = !state.health ? "Appears after the next scan" : healthPercent(week.success_rate) + " of " + healthNumber(week.checks) + " checks ok this week";
  const text = id => { const el = $(id); return el ? el.textContent.trim() : ""; };
  const review = state.scoutReview ? scoutBuckets().REVIEW.length : 0;
  const cadence = Number(text("navCadenceCount")) || 0;
  const tile = (view, label, value, sub, logo = "") => '<button type="button" class="more-tile' + (state.view === view ? " is-current" : "") + '" data-more-go="' + view + '">' +
    '<span class="more-label">' + logo + esc(label) + '</span><span class="more-value">' + value + '</span><span class="more-sub">' + sub + "</span></button>";
  const scoutLogo = '<span class="scout-avatar-wrap more-logo" aria-hidden="true">' + ($("scoutLaunch")?.querySelector(".scout-avatar")?.outerHTML || "") + "</span>";
  const cadenceLogo = '<span class="cadence-nav-mark more-logo" aria-hidden="true">' + ($("cadenceLaunch")?.querySelector(".cadence-calendar-avatar")?.outerHTML || "") + "</span>";
  const registryLogo = '<span class="registry-binder-wrap more-logo" aria-hidden="true">' + ($("registryLaunch")?.querySelector(".registry-binder-avatar")?.outerHTML || "") + "</span>";
  body.innerHTML =
    '<button type="button" class="more-health tone-' + tone + (state.view === "health" ? " is-current" : "") + '" data-more-go="health">' +
      '<span class="more-label">Monitor health<span class="more-go">Health ›</span></span>' +
      '<span class="more-value">' + esc(healthValue) + '</span><span class="more-sub">' + esc(healthSub) + "</span>" +
      '<span class="more-health-cells" aria-hidden="true">' + cells + "</span></button>" +
    '<div class="more-grid">' +
      tile("scout", "Scout", review ? "<b>" + esc(review) + "</b>" : "0", esc(review ? "pages to review" : "nothing to review"), scoutLogo) +
      tile("calendar", "Cadence", esc(cadence), esc(cadence === 1 ? "date coming up" : "dates coming up"), cadenceLogo) +
      tile("registry", "Registry", esc(registryItems().length), esc(registryItems().length === 1 ? "registered item" : "registered items"), registryLogo) +
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
bind("navMore", "click", () => { if ($("moreSheet").hidden) openMoreSheet(); else closeMoreSheet(); });
bind("moreSheet", "click", event => {
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
bind("fieldSearch", "input", () => {
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
// Theme: index.html restores the saved choice before first paint; toggles persist the next choice.
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
bind("detailBody", "toggle", event => {
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
bind("scoutView", "click", event => {
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
bind("scoutItems", "change", event => {
  const box = event.target.closest("[data-scout-pick]");
  if (!box) return;
  if (box.checked) state.scoutPicked.set(box.dataset.scoutPick, true); else state.scoutPicked.delete(box.dataset.scoutPick);
  const item = box.closest(".scout-item");
  if (item) item.classList.toggle("is-picked", box.checked);
  renderScoutBulk();
});
bind("scoutStrongOnly", "change", () => { state.scoutStrongOnly = $("scoutStrongOnly").checked; renderScout(); });
bind("monitorSearch", "input", renderMonitorList);
if ($("registrySearch")) $("registrySearch").addEventListener("input", renderRegistry);
bind("scoutSearch", "input", renderScout);
bind("scoutFormatFilter", "change", () => {
  state.scoutFormatFilter = $("scoutFormatFilter").value || "ALL";
  renderScout();
});
bind("cadenceSearch", "input", () => { state.cadenceSearch = $("cadenceSearch").value; renderCadenceView(); });
bind("cadenceTypeFilter", "change", () => { state.cadenceFilter = $("cadenceTypeFilter").value; renderCadenceView(); });
bind("cadenceOwnerFilter", "change", () => { state.cadenceOwner = $("cadenceOwnerFilter").value || "ALL"; renderCadenceView(); });
bind("cadencePlanForm", "input", syncCadencePlanner);
bind("cadencePlanForm", "change", syncCadencePlanner);
bind("cadencePlanForm", "submit", event => { event.preventDefault(); saveCadencePlan(); });
bind("cadencePlanIcs", "click", downloadCadencePlan);
document.querySelectorAll("[data-plan-close]").forEach(button => button.addEventListener("click", () => $("cadencePlanDialog").close()));
bind("cadenceSignInForm", "submit", signInCadence);
bind("cadenceForgotPassword", "click", requestCadencePasswordReset);
bind("cadenceRecoveryForm", "submit", updateCadencePassword);
bind("cadenceRecoveryCancel", "click", () => signOutCadence());
bind("cadenceEntryForm", "submit", saveCadenceEntry);
document.querySelectorAll("[data-calendar-close]").forEach(button => button.addEventListener("click", () => $("cadenceEntryDialog").close()));
bind("cadenceEntryDialog", "click", event => { if (event.target === $("cadenceEntryDialog")) $("cadenceEntryDialog").close(); });
bind("cadenceReminderEnabled", "change", () => { const enabled = $("cadenceReminderEnabled").checked; $("cadenceReminderDays").disabled = !enabled; $("cadenceReminderEmails").disabled = !enabled; });
bind("scoutSourceForm", "submit", submitScoutSource);
bind("scoutSourceForm", "change", syncScoutSourceForm);
bind("closeScoutSource", "click", () => $("scoutSourceDialog").close());
bind("cancelScoutSource", "click", () => $("scoutSourceDialog").close());
bind("scoutSourceDialog", "click", event => { if (event.target === $("scoutSourceDialog")) $("scoutSourceDialog").close(); });
// A new regulator's id follows its short name (or name) until it is typed by hand.
["scoutSourceName", "scoutSourceShortName"].forEach(id => $(id).addEventListener("input", () => {
  if ($("scoutSourceRegulator").value !== "__new" || $("scoutSourceId").dataset.edited === "true") return;
  $("scoutSourceId").value = L.scoutSlug($("scoutSourceShortName").value || $("scoutSourceName").value);
}));
bind("scoutSourceId", "input", () => { $("scoutSourceId").dataset.edited = "true"; });
bind("refreshBtn", "click", () => loadData(true));
bind("addMonitorBtn", "click", () => openAddMonitor());
// The rail sits outside #workspace, so its "Add link" button needs its own listener.
document.querySelectorAll(".rail [data-add-monitor]").forEach(button => button.addEventListener("click", () => openAddMonitor()));
bind("closeAddMonitor", "click", () => $("addMonitorDialog").close());
bind("cancelAddMonitor", "click", () => $("addMonitorDialog").close());
// Only the first step closes on a backdrop click; the larger steps hold work in progress.
bind("addMonitorDialog", "click", event => {
  if (event.target === $("addMonitorDialog") && state.add.step === "start") $("addMonitorDialog").close();
  const chip = event.target.closest("#reviewConditionSuggestions [data-condition-suggestion]");
  if (chip) { $("reviewCondition").value = chip.dataset.conditionSuggestion; $("reviewCondition").focus(); }
});
bind("addMonitorDialog", "close", () => {
  if (state.add.crawl && state.add.crawl.running) state.add.crawl.stop = true;
  state.add.loading += 1;
  addSaveDraft();
});
bind("newMonitorUrl", "input", () => {
  $("newMonitorUrl").setCustomValidity("");
  $("newMonitorMetadataStatus").textContent = "";
  if (state.add.method === "crawl") syncAddScope();
});
bind("addMonitorForm", "change", event => { if (event.target.name === "addMethod") syncAddMethod(); });
bind("addMonitorForm", "submit", event => { state.add.similarTo = null; startAddLink(event); });
bind("addExactSubmit", "click", submitExactAddress);
bind("autofillMonitorMetadata", "click", suggestMonitorMetadata);
bind("addResume", "click", event => {
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
  if (event.target.closest("[data-explore-box]")) { exploreSetBoxing(!a.boxing); return renderExploreSide(); }
  if (event.target.closest("[data-explore-record]")) return exploreSetRecording(!a.recording);
  if (event.target.closest("[data-step-bookmarklet]")) event.preventDefault();
  const visual = event.target.closest("input[data-step-visual]");
  if (visual) { const key = addPageKey(); const entry = exploreStepsFor(key); exploreStepsSet(key, Object.assign({}, entry, { visual: visual.checked })); if (visual.checked) exploreStepsSelectPage(); return; }
  if (event.target.closest("[data-step-record], [data-step-remove], [data-step-undo], [data-step-clear], [data-step-wait], [data-step-waitpick], [data-step-paste], [data-step-bookmarklet]")) return exploreStepAction(event.target);
  const areaShow = event.target.closest("[data-area-show]");
  if (areaShow) return explorePost({ type: "area-show", id: Number(areaShow.dataset.areaShow) });
  if (event.target.closest("[data-area-clear]")) return exploreAreaRemove("all");
  const areaRemove = event.target.closest("[data-area-remove]");
  if (areaRemove) return exploreAreaRemove(areaRemove.dataset.areaRemove);
  const areaButton = event.target.closest("[data-area-select], [data-area-watch], [data-area-ignore]");
  if (areaButton) {
    const kind = areaButton.hasAttribute("data-area-select") ? "select" : areaButton.hasAttribute("data-area-watch") ? "watch" : "ignore";
    return exploreAreaAction(kind, areaButton.getAttribute("data-area-" + kind));
  }
  const viewButton = event.target.closest("[data-explore-view]");
  if (viewButton && a.page) {
    // A view the person picks is kept for the rest of this site.
    a.viewByHost[exploreHost(a.page.url)] = viewButton.dataset.exploreView;
    return exploreRender(viewButton.dataset.exploreView, "");
  }
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
bind("exploreSelectMode", "change", () => {
  state.add.selectMode = $("exploreSelectMode").checked;
  explorePost({ type: "mode", select: state.add.selectMode });
  renderExploreSide();
});
document.addEventListener("keydown", event => { if (event.key === "Shift" && state.add.step === "explore") exploreShift(true); });
document.addEventListener("keyup", event => { if (event.key === "Shift") exploreShift(false); });
window.addEventListener("blur", () => exploreShift(false));
bind("crawlStop", "click", () => { if (state.add.crawl) state.add.crawl.stop = true; $("crawlStop").disabled = true; });
bind("crawlReview", "click", () => addGoto("review"));
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
bind("reviewSearch", "input", () => { state.add.query = $("reviewSearch").value; state.add.limit = REVIEW_PAGE; renderReview(); });
bind("reviewFormat", "change", () => { state.add.format = $("reviewFormat").value; state.add.limit = REVIEW_PAGE; renderReview(); });
bind("reviewBack", "click", () => {
  const a = state.add;
  if (a.origin === "explore" && a.page) addGoto("explore");
  else addGoto("start");
});
bind("selectMonitorsBtn", "click", () => setPicking(!state.picking));
bind("workspace", "change", event => {
  const select = event.target.closest("[data-scope]");
  if (select) return setScope(select.dataset.scope, select.value);
  if (event.target.id === "shadowFile") readShadowFile(event.target.files && event.target.files[0]);
});
bind("closeOrganise", "click", () => $("organiseDialog").close());
bind("cancelOrganise", "click", () => $("organiseDialog").close());
bind("organiseForm", "submit", event => { event.preventDefault(); submitOrganise(); });
bind("organiseWorkspace", "change", () => { $("organiseWorkspaceNew").hidden = $("organiseWorkspace").value !== "__new"; if (!$("organiseWorkspaceNew").hidden) $("organiseWorkspaceNew").focus(); });
bind("organiseDialog", "click", event => {
  if (event.target === $("organiseDialog")) return $("organiseDialog").close();
  const add = event.target.closest("[data-add-label]");
  if (add) { const labels = L.parseLabels($("organiseAdd").value + "," + add.dataset.addLabel); $("organiseAdd").value = labels.join(", "); return; }
  const remove = event.target.closest("[data-remove-label]");
  if (remove) {
    const key = remove.dataset.removeLabel.toLowerCase();
    if (state.organiseRemove.has(key)) state.organiseRemove.delete(key); else state.organiseRemove.set(key, remove.dataset.removeLabel);
    remove.setAttribute("aria-pressed", String(state.organiseRemove.has(key)));
    remove.classList.toggle("is-remove", state.organiseRemove.has(key));
  }
});
bind("closeDigest", "click", () => $("digestDialog").close());
bind("cancelDigest", "click", () => $("digestDialog").close());
bind("digestForm", "submit", event => { event.preventDefault(); submitDigests(); });
bind("digestDialog", "change", event => {
  if (event.target.dataset.digestField === "frequency") { readDigestRows(); renderDigestRows(); }
});
bind("digestDialog", "click", event => {
  if (event.target === $("digestDialog")) return $("digestDialog").close();
  if (event.target.closest("[data-digest-add]")) {
    readDigestRows();
    state.digestDraft.push({ workspace: "*", frequency: "weekly", day: "mon", hour: 8, timezone: "UTC" });
    return renderDigestRows();
  }
  const remove = event.target.closest("[data-digest-remove]");
  if (remove) { readDigestRows(); state.digestDraft.splice(Number(remove.dataset.digestRemove), 1); renderDigestRows(); }
});
bind("closePreset", "click", () => $("presetDialog").close());
bind("cancelPreset", "click", () => $("presetDialog").close());
bind("presetForm", "submit", event => { event.preventDefault(); submitPreset(); });
bind("presetForm", "change", renderPresetPreview);
bind("presetDialog", "click", event => { if (event.target === $("presetDialog")) $("presetDialog").close(); });
bind("closeScanSchedule", "click", () => $("scanScheduleDialog").close());
bind("cancelScanSchedule", "click", () => $("scanScheduleDialog").close());
bind("scanScheduleReset", "click", () => submitScanSchedule(true));
bind("scanScheduleForm", "submit", event => { event.preventDefault(); submitScanSchedule(false); });
["scanEvery", "scanWindowOn", "scanFrom", "scanUntil", "scanZone"].forEach(id => $(id).addEventListener("change", renderScanPreview));
["scanFetchMode", "scanWait", "scanWaitSelector", "scanDismiss"].forEach(id => $(id).addEventListener("change", renderScanLoading));
["scanVisual", "scanVisualThreshold"].forEach(id => $(id).addEventListener("change", renderScanLoading));
bind("scanSteps", "input", renderScanLoading);
bind("scanRecorder", "click", event => { event.preventDefault(); showToast("Drag this link to your bookmarks bar, then click it on the portal you want to record."); });
bind("scanScheduleDialog", "click", event => {
  if (event.target === $("scanScheduleDialog")) return $("scanScheduleDialog").close();
  const mode = event.target.closest("[data-scan-days]");
  if (mode) { setScanDayMode(mode.dataset.scanDays); return renderScanPreview(); }
  const day = event.target.closest("[data-scan-day]");
  if (day) { day.setAttribute("aria-pressed", String(day.getAttribute("aria-pressed") !== "true")); renderScanPreview(); }
});
bind("closeCondition", "click", () => $("conditionDialog").close());
bind("cancelCondition", "click", () => $("conditionDialog").close());
bind("conditionClear", "click", () => submitCondition(true));
bind("conditionForm", "submit", event => { event.preventDefault(); submitCondition(false); });
bind("conditionDialog", "click", event => {
  if (event.target === $("conditionDialog")) return $("conditionDialog").close();
  const chip = event.target.closest("[data-condition-suggestion]");
  if (chip) { $("conditionText").value = chip.dataset.conditionSuggestion; $("conditionText").focus(); }
});
if ($("channelSecretsLink")) $("channelSecretsLink").href = REPO + "/settings/secrets/actions";
bind("closeDeleteMonitor", "click", () => $("deleteMonitorDialog").close());
bind("cancelDeleteMonitor", "click", () => $("deleteMonitorDialog").close());
bind("deleteMonitorDialog", "click", event => { if (event.target === $("deleteMonitorDialog")) $("deleteMonitorDialog").close(); });
bind("confirmDeleteMonitor", "click", submitDeleteMonitor);
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

bind("reviewForm", "submit", submitReview);
bind("reviewViaGitHub", "click", submitReviewViaGitHub);
bind("reviewSignInButton", "click", signInFromReview);
bind("reviewSignInPassword", "keydown", event => { if (event.key === "Enter") { event.preventDefault(); signInFromReview(); } });
document.addEventListener("click", event => { if (event.target.closest("[data-team-signout]")) signOutTeam(); });
bind("missedForm", "submit", submitMissed);
bind("addRegistryBtn", "click", () => openRegistryDialog({ mode: "add" }));
bind("registryForm", "submit", submitRegistry);
bind("importRegistryBtn", "click", openRegistryImport);
bind("registryImportFile", "change", readRegistryImportFile);
bind("registryImportForm", "submit", submitRegistryImport);
bind("closeRegistryImport", "click", () => $("registryImportDialog").close());
bind("cancelRegistryImport", "click", () => $("registryImportDialog").close());
bind("registryImportCopy", "click", () => copyRegistryImport().then(ok => showToast(ok ? "Request copied. Paste it into the GitHub description." : "Select the request text and copy it.")));
bind("registryImportDownload", "click", () => {
  const pending = state.registryImport;
  if (!pending) return;
  const url = URL.createObjectURL(new Blob([pending.body], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url; link.download = "registry-request.txt"; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
bind("registryForm", "input", updateRegistryPreview);
bind("registryForm", "change", updateRegistryPreview);
bind("registryTemplate", "change", () => { applyRegistryTemplate($("registryTemplate").value, false); updateRegistryPreview(); });
bind("registryNewConsumer", "change", () => { $("registryNewConsumerFields").hidden = !$("registryNewConsumer").checked; if ($("registryNewConsumer").checked) $("registryConsumerName").focus(); });
bind("closeRegistry", "click", () => $("registryDialog").close());
bind("changeOrder", "change", event => { state.changeSort = event.target.value === "priority" ? "priority" : "newest"; renderChangeRoute(); });
bind("profileForm", "submit", submitProfile);
bind("profileForm", "change", event => { if (event.target.closest("[data-profile-entity]")) renderProfileReports(); updateProfilePreview(); });
bind("profileForm", "input", event => { if (event.target.closest("[data-profile-entity]")) { renderProfileReports(); updateProfilePreview(); } });
bind("profileAddEntity", "click", addProfileEntity);
bind("closeProfile", "click", () => $("profileDialog").close());
bind("cancelProfile", "click", () => $("profileDialog").close());
bind("cancelRegistry", "click", () => $("registryDialog").close());
bind("closeMissed", "click", () => $("missedDialog").close());
bind("cancelMissed", "click", () => $("missedDialog").close());
bind("reviewForm", "change", event => { if (event.target.name === "reviewDecision") syncReviewForm(); });
bind("closeReview", "click", () => $("reviewDialog").close());
bind("cancelReview", "click", () => $("reviewDialog").close());
bind("reviewDialog", "click", event => {
  if (event.target === $("reviewDialog")) $("reviewDialog").close();
});
bind("bulkMonitorFile", "change", event => readBulkFile(event.target.files && event.target.files[0]));
bind("bulkRequests", "click", event => {
  const button = event.target.closest("[data-bulk-batch]");
  if (button) openBulkBatch(Number(button.dataset.bulkBatch));
});
bind("clearBulkImport", "click", clearBulkImport);
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
  if (/\.xls$/.test(path) || hint === "xls") return "xls";
  if (/\.ods$/.test(path) || hint === "ods") return "ods";
  if (/\.csv$/.test(path) || hint === "csv") return "csv";
  if (/\.tsv$/.test(path) || hint === "tsv") return "tsv";
  if (/\.docx$/.test(path) || hint === "word" || hint === "docx") return "docx";
  if (/\.doc$/.test(path) || hint === "doc") return "doc";
  if (/\.ppt$/.test(path) || hint === "ppt") return "ppt";
  if (/\.odt$/.test(path) || hint === "odt") return "odt";
  if (/\.rtf$/.test(path) || hint === "rtf") return "rtf";
  if (/\.zip$/.test(path) || hint === "zip") return "zip";
  if (/\.(xml|xsd|xbrl|xsl|xslt|rdf)$/.test(path) || hint === "xml") return "xml";
  if (/\.json$/.test(path) || hint === "json") return "json";
  if (/\.(txt|md)$/.test(path) || hint === "text") return "text";
  return "other";
}
// Sniff the bytes when the name says nothing (DownloadAttachment?guid=…).
function docKindFromBytes(bytes, fallback) {
  if (!bytes || bytes.length < 4) return fallback;
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "package";
  // An Office 97-2003 file says what it is through the streams it holds.
  if (L.isCfb(bytes)) return L.oleKind(bytes) || fallback;
  if (bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74) return "rtf";
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
const DOC_KIND_LABEL = { pdf: "PDF", xlsx: "Excel workbook", xls: "Excel 97–2003 workbook", ods: "OpenDocument spreadsheet", csv: "CSV", tsv: "Tab-separated values",
  docx: "Word document", doc: "Word 97–2003 document", odt: "OpenDocument text", rtf: "Rich Text document", ppt: "PowerPoint 97–2003 presentation",
  zip: "ZIP bundle", xml: "XML", json: "JSON", text: "Text", other: "File" };
// Formats ChangeSentinel reads as text for comparison but the browser cannot draw.
const DOC_TEXT_ONLY = { doc: "Word 97–2003 documents", ppt: "PowerPoint 97–2003 presentations", odt: "OpenDocument text documents", rtf: "Rich Text documents" };
let documentDownloadUrl = "";
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
    if (kind === "zip" && names.indexOf("mimetype") >= 0 && names.indexOf("content.xml") >= 0) {
      let mimetype = "";
      try { mimetype = new TextDecoder("ascii").decode((await L.zipFile(bytes, "mimetype")) || new Uint8Array()); } catch (_) {}
      kind = /opendocument\.spreadsheet/.test(mimetype) ? "ods" : /opendocument\.text/.test(mimetype) ? "odt" : "zip";
    }
  }
  // One download link at a time: the previous document's blob is released.
  if (documentDownloadUrl) URL.revokeObjectURL(documentDownloadUrl);
  const download = documentDownloadUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const fileName = (String(o.name || o.url || "document").split(/[?#]/)[0].split("/").pop() || "document").slice(0, 120);
  const actions = (o.actions || "") + '<a class="sheet-link" href="' + esc(download) + '" download="' + esc(fileName) + '">Download</a>' +
    (safeHttpUrl(o.url) ? externalLink(o.url, "Open original", "sheet-link") : "");
  host.innerHTML = '<div class="doc-view" data-kind="' + esc(kind) + '">' + docToolbar({ name: fileName, title: o.title || fileName, kindLabel: DOC_KIND_LABEL[kind], size: bytes.length, actions }) +
    '<div class="doc-body"><div class="loading">Opening the ' + esc((DOC_KIND_LABEL[kind] || "file").toLowerCase()) + "…</div></div></div>";
  const body = host.querySelector(".doc-body");
  try {
    if (kind === "pdf") await renderPdfDocument(body, bytes, alive);
    else if (kind === "xlsx") { const book = await L.readWorkbook(bytes); if (alive()) renderWorkbook(body, book, {}); }
    else if (kind === "xls") { const book = L.readXls(bytes); if (alive()) renderWorkbook(body, book, {}); }
    else if (kind === "ods") { const book = await L.readOds(bytes); if (alive()) renderWorkbook(body, book, {}); }
    else if (kind === "csv" || kind === "tsv") { if (alive()) renderWorkbook(body, L.csvWorkbook(new TextDecoder("utf-8").decode(bytes), fileName, kind === "tsv" ? "\t" : ","), {}); }
    else if (kind === "docx") { const blocks = await L.readDocx(bytes); if (alive()) body.innerHTML = renderDocxBlocks(blocks); }
    else if (kind === "zip") await renderZipListing(body, bytes, alive, o);
    else if (kind === "xml" || kind === "json" || kind === "text") {
      let text = new TextDecoder("utf-8").decode(bytes.subarray(0, 2000000));
      if (kind === "json") { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {} }
      if (alive()) body.innerHTML = '<pre class="doc-text-raw">' + esc(text) + (bytes.length > 2000000 ? "\n…" : "") + "</pre>";
    } else if (DOC_TEXT_ONLY[kind]) {
      body.innerHTML = emptyState(DOC_KIND_LABEL[kind], DOC_TEXT_ONLY[kind] + " can't be drawn in the browser. ChangeSentinel reads and compares their text on every scan; download the file to open it.");
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
  const openable = name => ["pdf", "xlsx", "xls", "ods", "csv", "tsv", "docx", "xml", "json", "text"].indexOf(docKind(name, "")) >= 0;
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
// Each format is compared the way its readers think of it: PDFs page by page,
// workbooks (.xlsx, .xls, .ods, and CSV/TSV) sheet by sheet and cell by cell,
// XML (schemas, taxonomies, XBRL) element by element, pages as rendered HTML.
const WORKBOOK_FILE = /\.(xlsx|xlsm|xls|ods)$/i;
const SHEET_TEXT_TYPES = ["xlsx", "xls", "ods", "csv"];
function compareSources(evidence) {
  const before = (evidence && evidence.before) || {};
  const after = (evidence && evidence.after) || {};
  const text = before.snapshot_location && after.snapshot_location ? { before: before.snapshot_location, after: after.snapshot_location } : null;
  const typeOf = record => String(record.extraction_type || "").toLowerCase();
  if (before.file_snapshot_location && after.file_snapshot_location && /\.pdf$/i.test(after.file_snapshot_location)) {
    return { kind: "pdf", before: before.file_snapshot_location, after: after.file_snapshot_location, text };
  }
  if (before.file_snapshot_location && after.file_snapshot_location && WORKBOOK_FILE.test(after.file_snapshot_location) && WORKBOOK_FILE.test(before.file_snapshot_location)) {
    return { kind: "xlsx", before: before.file_snapshot_location, after: after.file_snapshot_location, text };
  }
  if (before.html_snapshot_location && after.html_snapshot_location) {
    return { kind: "html", before: before.html_snapshot_location, after: after.html_snapshot_location, text };
  }
  if (text && typeOf(before) === "xml" && typeOf(after) === "xml") return { kind: "xml", before: text.before, after: text.after, text };
  // A workbook saved before its original was kept, or a CSV: rebuilt from its extracted text.
  if (text && SHEET_TEXT_TYPES.indexOf(typeOf(before)) >= 0 && SHEET_TEXT_TYPES.indexOf(typeOf(after)) >= 0) {
    return { kind: "sheet-text", before: text.before, after: text.after, text };
  }
  if (text) return { kind: "text", before: text.before, after: text.after, text };
  return null;
}
// The note above a comparison, in the words of the view it opens.
function compareNote(kind) {
  if (kind === "xlsx" || kind === "sheet-text") return "Sheet by sheet and cell by cell. Open a changed cell to see it in the workbook.";
  if (kind === "xml") return "Element by element. Elements are matched by name, id or code, so moved or inserted elements don't cascade.";
  return "Drag the divider to move between the previous and new version.";
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
  if (sources.kind === "sheet-text") return compareSheetText(target, sources, alive);
  if (sources.kind === "xml") return compareXml(target, sources, event, alive);
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
    const [before, after] = await Promise.all([readWorkbookFile(beforeBytes, sources.before), readWorkbookFile(afterBytes, sources.after)]);
    if (!alive()) return;
    const diff = L.workbookDiff(before, after);
    renderWorkbookCompare(target, before, after, diff);
  } catch (error) {
    if (alive()) target.innerHTML = '<div class="cmp"><p class="cmp-status">Couldn\'t compare the two workbooks: ' + esc(String(error.message || error)) + ". The text redline is still available.</p></div>";
  }
}
// Any saved workbook original, by its contents first and its name second.
async function readWorkbookFile(bytes, name) {
  if (L.isCfb(bytes)) return L.readXls(bytes);
  if (/\.ods$/i.test(String(name || ""))) return L.readOds(bytes);
  return L.readWorkbook(bytes);
}

/* ----- Workbooks with no saved originals, and CSV: rebuilt from the two text snapshots ----- */
async function compareSheetText(target, sources, alive) {
  target.innerHTML = '<div class="cmp" data-kind="xlsx"><p class="cmp-status" role="status">Reading both versions…</p></div>';
  try {
    const [a, b] = await Promise.all([readSnapshotFile(sources.before, state.snapshotCache), readSnapshotFile(sources.after, state.snapshotCache)]);
    if (!alive()) return;
    const before = L.workbookFromText(a), after = L.workbookFromText(b);
    renderWorkbookCompare(target, before, after, L.workbookDiff(before, after));
    const status = target.querySelector(".wb-summary");
    if (status) status.insertAdjacentHTML("beforeend", '<span class="wb-notes">Rebuilt from the extracted text: rows are numbered in order of the filled rows.</span>');
  } catch (error) {
    if (alive()) target.innerHTML = '<div class="cmp"><p class="cmp-status">Couldn\'t compare the two versions: ' + esc(String(error.message || error)) + ". The text redline is still available.</p></div>";
  }
}

/* ----- XML: schemas, taxonomies and XBRL compared element by element ----- */
const XML_KIND_WORDS = { ALL: "All", changed: "Changed", added: "Added", removed: "Removed" };
async function compareXml(target, sources, event, alive) {
  target.innerHTML = '<div class="cmp" data-kind="xml"><p class="cmp-status" role="status">Reading both versions…</p></div>';
  let a, b, diff;
  try {
    [a, b] = await Promise.all([readSnapshotFile(sources.before, state.snapshotCache), readSnapshotFile(sources.after, state.snapshotCache)]);
    if (!alive()) return;
    diff = L.xmlTreeDiff(a, b);
  } catch (error) {
    if (!alive()) return;
    // Not parseable as one XML tree (a fragment, or a very large file): fall back to lines.
    target.innerHTML = compareShell("text", event);
    const root = target.querySelector(".cmp");
    wireCompareSlider(root);
    await compareFillText(root, root.querySelector(".cmp-status"), sources, alive);
    return;
  }
  const view = { mode: "structure", kind: "ALL", shown: 400 };
  const t = diff.totals;
  const draw = () => {
    const summary = [diff.kind, t.changed ? plural(t.changed, "element changed", "elements changed") : "", t.added ? plural(t.added, "element added", "elements added") : "",
      t.removed ? plural(t.removed, "element removed", "elements removed") : ""].filter(Boolean).join(" · ") || diff.kind + " · no element differences";
    const modes = '<div class="segmented" role="group" aria-label="View">' + [["structure", "Elements"], ["lines", "Lines"]].map(pair =>
      '<button type="button" data-xml-mode="' + pair[0] + '" aria-pressed="' + String(view.mode === pair[0]) + '">' + pair[1] + "</button>").join("") + "</div>";
    let body = "";
    if (view.mode === "structure") {
      const list = diff.changes.filter(change => view.kind === "ALL" || change.kind === view.kind);
      const kinds = '<div class="segmented wb-kinds" role="group" aria-label="Show">' + ["ALL", "changed", "added", "removed"].map(kind =>
        '<button type="button" data-xml-kind="' + kind + '" aria-pressed="' + String(view.kind === kind) + '">' + esc(XML_KIND_WORDS[kind]) + (kind !== "ALL" && t[kind] ? " " + t[kind].toLocaleString() : "") + "</button>").join("") + "</div>";
      const cell = value => value == null ? '<span class="wb-empty">none</span>' : '<code>' + esc(String(value).slice(0, 600)) + "</code>";
      const rows = list.slice(0, view.shown).map(change => {
        const where = change.path.slice(-3).map(part => esc(part)).join(' <span class="xml-sep">›</span> ');
        const full = change.path.join(" › ");
        const label = change.kind === "added" ? "added" + (change.size > 1 ? " · " + plural(change.size - 1, "child", "children") : "")
          : change.kind === "removed" ? "removed" + (change.size > 1 ? " · " + plural(change.size - 1, "child", "children") : "")
          : change.renamed ? "renamed" : change.details.map(detail => detail.what).join(", ");
        const head = '<td class="wb-ref xml-path" title="' + esc(full) + '">' + where + "<small>" + esc(label) + "</small></td>";
        if (change.kind === "added") return '<tr class="is-added">' + head + '<td class="wb-before"><span class="wb-empty">not in the previous version</span></td><td class="wb-after">' + cell(change.summary || change.tag) + "</td></tr>";
        if (change.kind === "removed") return '<tr class="is-removed">' + head + '<td class="wb-before">' + cell(change.summary || change.tag) + '</td><td class="wb-after"><span class="wb-empty">not in the new version</span></td></tr>';
        // Several attributes of one element: each row says which one it is.
        const several = change.details.length > 1;
        return change.details.map((detail, index) => '<tr class="is-value">' + (index === 0 ? head.replace("<td ", '<td rowspan="' + change.details.length + '" ') : "") +
          '<td class="wb-before">' + (several ? '<small class="xml-attr">' + esc(detail.what) + "</small>" : "") + cell(detail.before) +
          '</td><td class="wb-after">' + cell(detail.after) + "</td></tr>").join("");
      }).join("");
      body = (diff.changes.length ? kinds : "") + (rows ? '<div class="doc-table-wrap"><table class="wb-changes xml-changes"><thead><tr><th>Element</th><th>Before</th><th>After</th></tr></thead><tbody>' + rows + "</tbody></table></div>"
        : '<p class="wb-sheet-note">' + esc(diff.changes.length ? "No element changes of this kind." : "The two versions have the same elements, attributes and text; only formatting or order differs.") + "</p>") +
        (list.length > view.shown ? '<p class="wb-notes"><button class="sheet-link" type="button" data-xml-more>Show ' + Math.min(400, list.length - view.shown).toLocaleString() + " more</button> · " + (list.length - view.shown).toLocaleString() + " not shown</p>" : "") +
        (diff.more ? '<p class="wb-notes">' + diff.more.toLocaleString() + " further changes are not listed.</p>" : "");
    }
    target.innerHTML = '<div class="wb wb-compare" data-kind="xml"><div class="wb-summary"><strong>' + esc(summary) + "</strong></div>" +
      '<div class="wb-head"><span class="wb-sheet-status xml-root">' + esc("<" + diff.root + ">") + '</span><div class="wb-head-tools">' + modes + "</div></div>" +
      (view.mode === "structure" ? body : '<div class="xml-lines"></div>') + "</div>";
    if (view.mode === "lines") {
      const host = target.querySelector(".xml-lines");
      host.innerHTML = compareShell("text", event);
      const root = host.querySelector(".cmp");
      wireCompareSlider(root);
      compareFillText(root, root.querySelector(".cmp-status"), sources, alive).catch(error => { root.querySelector(".cmp-status").textContent = String(error.message || error); });
    }
  };
  target.onclick = event => {
    const mode = event.target.closest("[data-xml-mode]");
    if (mode) { view.mode = mode.dataset.xmlMode; return draw(); }
    const kind = event.target.closest("[data-xml-kind]");
    if (kind) { view.kind = kind.dataset.xmlKind; view.shown = 400; return draw(); }
    if (event.target.closest("[data-xml-more]")) { view.shown += 400; return draw(); }
  };
  draw();
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
const CMP_STALLED_STYLE_MS = 4000;
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
    // The saved page's styles, fonts and images load from the live site, and the
    // frame's load event waits for every one of them. A site behind a bot shield
    // (banrep.gov.co, Radware) can hold those requests open indefinitely, which
    // left the comparison on "Loading both versions…". Marking only needs the
    // parsed document, so the comparison starts as soon as that exists.
    let settled = false, poll = 0, cap = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(cap);
      resolve(node);
    };
    const parsed = () => {
      try {
        const doc = node.contentDocument;
        return !!(doc && doc.URL === "about:srcdoc" && doc.readyState !== "loading" && doc.body);
      } catch (_) { return false; }
    };
    node.addEventListener("load", finish, { once: true });
    poll = setInterval(() => { if (parsed()) finish(); }, 50);
    cap = setTimeout(finish, 8000);
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
  const fit = () => {
    if (!frameA.isConnected) return;
    const height = Math.max(measure(frameA), measure(frameB));
    frameA.style.height = frameB.style.height = height + "px";
  };
  fit();
  // Styles and images that arrive later change the page's height.
  [frameA, frameB].forEach(node => node.addEventListener("load", fit));
  // A stylesheet in <head> blocks painting until it arrives, so one the live site
  // never answers leaves the frame blank. After a grace period any still pending
  // is dropped: the saved page shows, unstyled where its styles did not load.
  setTimeout(() => {
    if (!alive()) return;
    let dropped = 0;
    [frameA, frameB].forEach(node => {
      try {
        node.contentDocument.querySelectorAll('link[rel~="stylesheet" i]').forEach(link => {
          if (!link.sheet) { link.remove(); dropped += 1; }
        });
      } catch (_) {}
    });
    if (!dropped) return;
    fit();
    status.textContent += " Some of the live site's styles did not load, so the pages are shown partly unstyled.";
  }, CMP_STALLED_STYLE_MS);
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
// The Edge Function owns the quota; the dashboard only shows the `remaining` it returns.
const askSentinelState = { messages: [], sending: false, remaining: 50, limit: 50, warmed: false, warmingPromise: null, warmError: "", identity: null, memoryVisitorId: "" };

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
    if (Number.isInteger(payload.limit) && payload.limit > 0) askSentinelState.limit = payload.limit;
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
  if (Number.isInteger(remaining) && remaining >= 0 && remaining <= askSentinelState.limit) askSentinelState.remaining = remaining;
  const quota = $("askSentinelQuota");
  quota.textContent = askSentinelState.remaining + " of " + askSentinelState.limit + " questions left today";
  quota.classList.toggle("is-empty", askSentinelState.remaining <= 0);
  quota.classList.remove("is-busy");
}
function askSentinelOpen() {
  // Sentinel's agent workspace (sentinel.js) replaces this page when it loads.
  if (window.Sentinel && typeof window.Sentinel.open === "function") { window.Sentinel.open(); return; }
  setView("askSentinel");
  $("askSentinelInput").focus({ preventScroll: true });
  void askSentinelWarmIndex();
}
function askSentinelSetSending(sending) {
  askSentinelState.sending = sending;
  const quotaEmpty = askSentinelState.remaining <= 0;
  $("askSentinelSend").disabled = sending || quotaEmpty;
  $("askSentinelInput").disabled = sending || quotaEmpty;
  $("askSentinelSend").setAttribute("aria-busy", String(sending));
}
/* Repository history and evidence are indexed server-side; client context is not sent as authoritative evidence. */
async function askSentinelSendQuestion(promptOverride) {
  if (askSentinelState.sending || (askSentinelState.remaining <= 0)) return;
  const input = $("askSentinelInput");
  const question = String(promptOverride == null ? input.value : promptOverride).trim();
  if (!question) { input.focus(); return; }
  if (!state.loaded) {
    askSentinelAppendMessage("assistant", "Monitoring data is still loading. Please wait until the dashboard finishes loading before asking a question.", "ask-sentinel-error");
    return;
  }
  if (question.length > 1200) {
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
      throw new Error(typeof payload.error === "string" ? payload.error : "Daily limit reached. Your allowance resets at 00:00 UTC.");
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
    if (askSentinelState.remaining <= 0) {
      askSentinelUpdateQuota(0);
      $("askSentinelInput").placeholder = "Daily limit reached — resets at 00:00 UTC";
      document.querySelectorAll("[data-ask-prompt]").forEach(button => { button.disabled = true; });
    }
    input.focus({ preventScroll: true });
  }
}
bind("askSentinelLaunch", "click", askSentinelOpen);
bind("askSentinelBack", "click", () => setView("overview"));
bind("askSentinelForm", "submit", event => {
  event.preventDefault();
  askSentinelSendQuestion();
});
bind("askSentinelInput", "keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    askSentinelSendQuestion();
  }
});
bind("askSentinelInput", "input", event => {
  const el = event.target;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
});
bind("askSentinelMessages", "click", event => {
  const prompt = event.target.closest("[data-ask-prompt]");
  if (prompt) askSentinelSendQuestion(prompt.dataset.askPrompt);
});

addRestoreDraft();
if ($("repoLink")) $("repoLink").href = REPO;
loadData(true);
refreshWorkflowRuns();
window.setInterval(() => loadData(false), 120000);
window.setInterval(updateNextRunCountdown, 30000);
