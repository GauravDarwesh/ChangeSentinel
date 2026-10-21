"use strict";

/*
 * ChangeSentinel review workspace.
 *
 * Data layer (unchanged contract): core JSON is read same-origin from Pages
 * with a raw-GitHub fallback, every asset is schema-checked, and incomplete or
 * stale scans are reported as such rather than as healthy. Snapshot bytes and
 * evidence are read from raw GitHub, because Pages only publishes the UI and
 * the core JSON.
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
  config: "config/sources.json"
};
// Load core state from the same origin as GitHub Pages first. Keep the raw GitHub
// URL as a fallback so older deployments can still recover while Pages publishes.
const ENDPOINTS = {
  report: new URL("./data/report.json", document.baseURI).href,
  inventory: new URL("./data/latest.json", document.baseURI).href,
  history: new URL("./data/history/index.json", document.baseURI).href,
  notifications: new URL("./data/notifications.json", document.baseURI).href,
  outbox: new URL("./data/notification-outbox.json", document.baseURI).href,
  config: new URL("./config/sources.json", document.baseURI).href
};
const VIEWS = ["overview", "changes", "monitors", "runs", "notifications", "askSentinel"];
const HASH_NAMES = { overview: "overview", changes: "changes", monitors: "pages", runs: "runs", notifications: "alerts", askSentinel: "ask-sentinel" };
const $ = id => document.getElementById(id);
const esc = L.esc;
const state = {
  report: {}, inventory: {}, history: [], notifications: {}, outbox: {}, config: {},
  items: [], view: "overview", loaded: false,
  selectedId: "", selectedChangeId: "", selectedRunId: "", selectedNotificationId: "",
  mobileDetail: false,
  filter: "ALL", changeFilter: "ALL", detailTab: "", diffMode: "compare", snapshotMode: "preview",
  docInfo: {}, titleQueue: [], titleWorkers: 0, titleTimer: null,
  snapshotCache: {}, htmlCache: {}, evidenceCache: {}, pdfPreviewUrl: "", toastTimer: null,
  workflowRuns: [], workflowSignature: "", scanColumns: null, pendingScan: null
};
const compactQuery = window.matchMedia ? window.matchMedia("(max-width: 980px)") : null;
function isCompact() { return !!(compactQuery && compactQuery.matches); }

/* ================= Data loading ================= */

function bust(url) { return url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now(); }
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
      const value = await response.json();
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
function snapshotURL(path) { return path ? bust(RAW + "/" + path) : ""; }
async function readSnapshotFile(path, cache) {
  if (!path) throw new Error("Snapshot path is not available");
  if (cache[path] != null) return cache[path];
  const response = await fetch(snapshotURL(path), { cache: "no-store" });
  if (!response.ok) throw new Error("Snapshot request returned HTTP " + response.status);
  const content = await response.text();
  cache[path] = content;
  return content;
}
function loadEvidence(location) {
  if (!location) return Promise.reject(new Error("No evidence file is attached to this event"));
  if (!state.evidenceCache[location]) {
    state.evidenceCache[location] = fetch(bust(RAW + "/" + location), { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error("Evidence request returned HTTP " + response.status);
      return response.json();
    }).catch(error => {
      delete state.evidenceCache[location];
      throw error;
    });
  }
  return state.evidenceCache[location];
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
  const response = await fetch(snapshotURL(path), { cache: "no-store" });
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
function changeLogEntries() {
  const entries = [];
  const seen = new Set();
  state.items.forEach(item => itemChangeEntries(item).forEach(entry => {
    if (seen.has(entry.event_id)) return;
    if (CHANGE_EVENT_TYPES.indexOf(entry.event_type) < 0 && ALERT_EVENT_TYPES.indexOf(entry.event_type) < 0) return;
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
function canonicalForDashboard(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    const tracking = ["fbclid", "gclid", "mc_cid", "mc_eid"];
    const params = Array.from(url.searchParams.entries()).filter(([key]) => {
      const lower = key.toLowerCase();
      return !lower.startsWith("utm_") && tracking.indexOf(lower) < 0;
    });
    params.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    url.search = "";
    params.forEach(([key, val]) => url.searchParams.append(key, val));
    return url.toString();
  } catch (_) {
    return String(value || "");
  }
}
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

  renderMonitoringSignal();
  renderLatestPreview();
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
async function refreshWorkflowRuns() {
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
    '<span class="row-sub"><span class="tag ' + toneClass(entry) + '">' + esc(L.eventLabel(entry.event_type)) + "</span>" + verdictTag(verdict, entry) + "</span>" +
    '<span class="row-summary">' + esc(eventHeadline(entry)) + "</span></button>";
}
function filteredChanges() {
  return changeLogEntries().filter(entry => {
    if (state.changeFilter === "RELEVANT") return verdictFor(entry).state === "relevant";
    if (state.changeFilter === "PROBLEMS") return L.eventTone(entry.event_type) === "problem";
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
  renderNavCounts();
}
function renderNavCounts() {
  const changes = changeLogEntries().filter(entry => CHANGE_EVENT_TYPES.indexOf(entry.event_type) >= 0).length;
  $("navChangeCount").textContent = changes;
  $("navMonitorCount").textContent = state.items.length;
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
    (item ? '<button class="btn" type="button" data-open-page="' + esc(item.url_id) + '">Page history and snapshots</button>' : "");
  const boxId = "change-evidence";
  pane.innerHTML = '<div class="detail-inner">' +
    detailHeading({ back: true, source, title: eventTitle(entry), meta, actions }) +
    renderVerdict(entry) + evidenceSheet(entry, boxId) + "</div>";
  const eventId = entry.event_id;
  fillEvidence(entry, boxId, () => state.view === "changes" && state.selectedChangeId === eventId);
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
    (item.source_id ? '<button class="btn" type="button" data-run-scan="' + esc(item.source_id) + '" title="Scan this page\'s source now">Scan this source</button>' : "");
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
      // URL triggers GitHub's attachment download behavior; Pages does not
      // publish the data/ directory because its deploy artifact contains UI only.
      const response = await fetch(snapshotURL(filePath), { cache: "no-store" });
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
  $("detailBody").innerHTML = '<section class="sheet"><dl class="facts">' + rows.map(([key, value, code]) =>
    "<div><dt>" + esc(key) + '</dt><dd class="' + (code ? "is-code" : "") + '">' + esc(value == null || value === "" ? "Not recorded" : value) + "</dd></div>"
  ).join("") + "</dl></section>";
}
function renderDetailBody() {
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

/* ================= Navigation ================= */

function viewSection(view) {
  return { overview: "overviewView", changes: "changesView", monitors: "monitorsView", runs: "runsView", notifications: "notificationsView", askSentinel: "askSentinelView" }[view] || "overviewView";
}
function hasSelection(view) {
  return view === "changes" ? !!state.selectedChangeId : view === "monitors" ? !!state.selectedId
    : view === "runs" ? !!state.selectedRunId : view === "notifications" ? !!state.selectedNotificationId : false;
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
  const titles = { overview: "Overview", changes: "Changes", monitors: "Pages", runs: "Runs", notifications: "Alerts", askSentinel: "Ask Sentinel" };
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
}
function renderDetailFor(view) {
  if (view === "changes") renderChangeDetail();
  else if (view === "monitors") renderDetailBody();
  else if (view === "runs") renderRunDetail();
  else if (view === "notifications") renderNotificationDetail();
}
function resetDetailScroll(view) {
  const pane = { changes: "changeDetail", monitors: "detailView", runs: "runDetail", notifications: "notificationDetail" }[view];
  if (pane && $(pane)) $(pane).scrollTop = 0;
  if (view === "overview") $("overviewView").scrollTop = 0;
}
function writeHash() {
  const id = state.view === "changes" ? state.selectedChangeId : state.view === "monitors" ? state.selectedId
    : state.view === "runs" ? state.selectedRunId : state.view === "notifications" ? state.selectedNotificationId : "";
  const hash = "#" + (HASH_NAMES[state.view] || (state.view === "askSentinel" ? "ask-sentinel" : "overview")) + (id ? "/" + encodeURIComponent(id) : "");
  try { history.replaceState(null, "", state.view === "overview" ? location.pathname + location.search : hash); } catch (_) {}
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
  writeHash();
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

async function loadData(showErrors) {
  setStatus("Refreshing stored data…", false);
  if (showErrors !== false) $("loadError").hidden = true;
  try {
    const [report, inventory, historyData, notifications, outbox, config] = await Promise.all([
      fetchDataAsset("report", true),
      fetchDataAsset("inventory", true),
      fetchDataAsset("history", true),
      fetchDataAsset("notifications", true),
      fetchDataAsset("outbox", true),
      fetchDataAsset("config", true)
    ]);
    validateDataAssets({ report, inventory, historyData, notifications, outbox, config });
    state.report = report;
    state.inventory = inventory;
    state.history = historyData;
    state.notifications = notifications;
    state.outbox = outbox;
    state.config = config;
    state.items = makeItems();
    const firstLoad = !state.loaded;
    state.loaded = true;
    hydrateDocumentTitles();
    if (firstLoad) {
      const route = readHash();
      if (route) {
        if (route.id) {
          if (route.view === "changes") state.selectedChangeId = route.id;
          if (route.view === "monitors" && state.items.some(item => item.url_id === route.id)) state.selectedId = route.id;
          if (route.view === "runs") state.selectedRunId = route.id;
          if (route.view === "notifications") state.selectedNotificationId = route.id;
        }
        setView(route.view, { detail: !!route.id });
      } else {
        setView("overview");
      }
    } else {
      // A background refresh keeps the current view and selection.
      renderLists();
      if (state.view !== "monitors") renderDetailFor(state.view);
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
let xlsxParserPromise = null;

function openAddMonitor() {
  const dialog = $("addMonitorDialog");
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    window.setTimeout(() => $("newMonitorUrl").focus(), 30);
  } else {
    showToast("This browser can't open the add-page dialog. Use a current browser.");
  }
}
function makeGitHubIssueUrl(url, name, includeSelector, ignoreSelectors) {
  const bodyLines = [
    "<!-- changesentinel:add-monitor:v1 -->", "",
    "Please register this URL as a ChangeSentinel monitor.", "",
    "URL: " + url, "Name: " + (name || ""), "Include selector: " + (includeSelector || ""), "Ignore selectors:"
  ];
  if (ignoreSelectors.length) ignoreSelectors.forEach(selector => bodyLines.push("- " + selector));
  else bodyLines.push("(none)");
  bodyLines.push("", "This request was created from the ChangeSentinel dashboard.");
  const params = new URLSearchParams();
  params.set("title", "[ChangeSentinel] Add monitor request");
  params.set("body", bodyLines.join("\n"));
  return REPO + "/issues/new?" + params.toString();
}
function openGitHubRequest(target, toastMessage) {
  $("addMonitorDialog").close();
  showToast(toastMessage);
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) {
    try { githubWindow.opener = null; } catch (_) {}
  } else {
    window.location.href = target;
  }
}
function submitAddMonitor(event) {
  event.preventDefault();
  const rawUrl = $("newMonitorUrl").value.trim();
  const name = $("newMonitorName").value.replace(/[\r\n]+/g, " ").trim().slice(0, 100);
  const includeSelector = $("newMonitorIncludeSelector").value.replace(/[\r\n]+/g, " ").trim();
  const ignoreSelectors = $("newMonitorIgnoreSelectors").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  let parsed;
  try { parsed = new URL(rawUrl); } catch (_) {
    $("newMonitorUrl").setCustomValidity("Enter a full URL beginning with https:// or http://.");
    $("newMonitorUrl").reportValidity();
    return;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    $("newMonitorUrl").setCustomValidity("Use a public http:// or https:// URL without a username or password.");
    $("newMonitorUrl").reportValidity();
    return;
  }
  $("newMonitorUrl").setCustomValidity("");
  if (includeSelector.length > 500 || ignoreSelectors.length > 20 || ignoreSelectors.some(selector => selector.length > 500)) {
    showToast("Use one selector of up to 500 characters to compare, and up to 20 selectors to ignore.");
    return;
  }
  parsed.hash = "";
  const target = makeGitHubIssueUrl(parsed.toString(), name, includeSelector, ignoreSelectors);
  ["newMonitorUrl", "newMonitorName", "newMonitorIncludeSelector", "newMonitorIgnoreSelectors"].forEach(id => { $(id).value = ""; });
  openGitHubRequest(target, "Submit the prefilled request on GitHub. The page is scanned once the request is accepted.");
}

/* CSV is parsed locally. XLSX uses the pinned SheetJS standalone build, fetched only when needed. */
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
      candidate.hash = "";
      if (candidate.pathname !== "/" && candidate.pathname.endsWith("/")) candidate.pathname = candidate.pathname.slice(0, -1);
      for (const key of Array.from(candidate.searchParams.keys())) {
        const lowered = key.toLowerCase();
        if (lowered.startsWith("utm_") || ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(lowered)) candidate.searchParams.delete(key);
      }
      url = candidate.toString();
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
function loadXlsxParser() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxParserPromise) return xlsxParserPromise;
  xlsxParserPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
    script.async = true;
    script.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error("Excel parser could not be initialized."));
    script.onerror = () => reject(new Error("Excel support could not load. Try saving the spreadsheet as CSV."));
    document.head.appendChild(script);
  }).catch(error => {
    xlsxParserPromise = null;
    throw error;
  });
  return xlsxParserPromise;
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
      const XLSX = await loadXlsxParser();
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellText: true, cellDates: false });
      const firstSheet = workbook.SheetNames && workbook.SheetNames[0];
      if (!firstSheet) throw new Error("The workbook does not contain a worksheet.");
      matrix = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1, raw: false, defval: "" });
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
/* ================= Events ================= */

document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
$("workspace").addEventListener("click", event => {
  const target = event.target.closest("[data-select-change],[data-monitor-id],[data-select-run],[data-select-notification],[data-go],[data-open-page],[data-back],[data-diff-mode],[data-detail-tab],[data-snapshot-mode],[data-pdf-action],[data-refresh],[data-add-monitor],[data-change-filter],[data-filter]");
  if (!target) return;
  const data = target.dataset;
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
// Theme: dark by default, remembered per browser.
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
$("refreshBtn").addEventListener("click", () => loadData(true));
$("addMonitorBtn").addEventListener("click", openAddMonitor);
// The rail sits outside #workspace, so its "Add link" button needs its own listener.
document.querySelectorAll(".rail [data-add-monitor]").forEach(button => button.addEventListener("click", openAddMonitor));
$("closeAddMonitor").addEventListener("click", () => $("addMonitorDialog").close());
$("cancelAddMonitor").addEventListener("click", () => $("addMonitorDialog").close());
$("addMonitorDialog").addEventListener("click", event => {
  if (event.target === $("addMonitorDialog")) $("addMonitorDialog").close();
});
$("newMonitorUrl").addEventListener("input", () => $("newMonitorUrl").setCustomValidity(""));
$("addMonitorForm").addEventListener("submit", submitAddMonitor);
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
const PDFJS_VERSION = "3.11.174";
const PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VERSION + "/";
const COMPARE_PAGE_LIMIT = 400;
let pdfjsPromise = null;
let compareSerial = 0;

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PDFJS_BASE + "pdf.min.js";
      script.crossOrigin = "anonymous";
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      script.onerror = () => { pdfjsPromise = null; reject(new Error("The PDF renderer could not load")); };
      document.head.append(script);
    });
  }
  return pdfjsPromise;
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
  const response = await fetch(snapshotURL(path), { cache: "no-store" });
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
function normalizeForMatch(value) {
  return String(value || "").normalize("NFKC").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}
function flattenDocumentText(doc) {
  // Visible text with a map from each normalized character back to its text node.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  let flat = "";
  const map = [];
  let lastSpace = true;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.normalize("NFKC");
    for (let i = 0; i < text.length; i += 1) {
      const ch = /\s|\u00a0/.test(text[i]) ? " " : text[i];
      if (ch === " " && lastSpace) continue;
      flat += ch; map.push([node, i]); lastSpace = ch === " ";
    }
  }
  return { flat, map };
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
  const { flat, map } = index;
  const ranges = [];
  let cursor = 0;
  const find = (needle, from, to) => {
    let at = flat.indexOf(needle, from);
    if (at >= 0 && to != null && at + needle.length > to) at = -1;
    return at;
  };
  targets.forEach(target => {
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
    const lineAt = line.length >= 8 ? (find(line, cursor) >= 0 ? find(line, cursor) : find(line, 0)) : -1;
    target.parts.forEach(part => {
      const needle = normalizeForMatch(part);
      if (!needle) return;
      let at = -1;
      if (lineAt >= 0) at = find(needle, lineAt, lineAt + line.length);
      else if (needle.length >= 12 && !(otherFlat && otherFlat.includes(needle))) at = find(needle, cursor) >= 0 ? find(needle, cursor) : find(needle, 0);
      if (at < 0) return;
      ranges.push([at, at + needle.length]);
    });
    if (lineAt >= 0) cursor = lineAt + line.length;
  });
  // Wrap from the end so earlier offsets stay valid.
  ranges.sort((x, y) => y[0] - x[0]).forEach(([start, end]) => {
    const pieces = new Map();
    for (let k = start; k < end; k += 1) {
      const [node, offset] = map[k];
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
function htmlMarkTargets(rows, side) {
  const targets = [];
  rows.forEach(row => {
    const line = side === "before" ? row.before : row.after;
    if (line == null) return;
    const whole = side === "before" ? row.type === "del" : row.type === "add";
    if (whole) {
      targets.push({ whole: true, line, parts: String(line).replace(/^\s*(#+|[-*•]|\d+[.)])\s+/, "").split(/\s\|\s|^\||\|$/).map(s => s.trim()).filter(Boolean) });
    } else if (row.type === "edit") {
      const want = side === "before" ? "del" : "add";
      const parts = row.segments.filter(seg => seg.type === want && seg.text.trim()).map(seg => seg.text.replace(/\|/g, " ").trim()).filter(Boolean);
      if (parts.length) targets.push({ whole: false, line: String(line).replace(/\|/g, " "), parts });
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
async function pdfWords(doc, onProgress) {
  const words = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
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
    if (onProgress && number % 10 === 0) onProgress(number, doc.numPages);
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
  const [docA, docB] = await Promise.all([lib.getDocument({ data: bytesA }).promise, lib.getDocument({ data: bytesB }).promise]);
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
  slots.forEach(slot => observer.observe(slot.a));

  status.textContent = "Comparing the words of both versions…";
  const [wordsA, wordsB] = await Promise.all([
    pdfWords(docA, (n, all) => { if (alive()) status.textContent = "Reading the previous version… page " + n + " of " + all; }),
    pdfWords(docB)
  ]);
  if (!alive()) return;
  const { removed, added } = L.changedWords(wordsA, wordsB, { maxD: 4000 });
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
const askSentinelState = { messages: [], sending: false, remaining: 3, warmed: false, warmingPromise: null, warmError: "", identity: null, memoryVisitorId: "" };

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
function askSentinelInline(text) {
  let out = askSentinelEscapedText(text);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => { codes.push(code); return "\u0000" + (codes.length - 1) + "\u0000"; });
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) =>
    '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + "</a>");
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, href) =>
    pre + '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + href.replace(/^https?:\/\//, "") + "</a>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[Number(i)] + "</code>");
}
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
function askSentinelSourceLink(path) {
  const p = String(path || "");
  if (!p || p.startsWith("__")) return null;
  const a = document.createElement("a");
  a.href = "https://github.com/GauravDarwesh/ChangeSentinel/blob/main/" + p.split("/").map(encodeURIComponent).join("/");
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = p;
  return a;
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
  node.querySelector(".ask-sentinel-text").innerHTML = askSentinelMarkdown(answer);
  const links = (Array.isArray(sources) ? sources : []).map(askSentinelSourceLink).filter(Boolean)
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
  if (Number.isInteger(remaining) && remaining >= 0 && remaining <= 3) askSentinelState.remaining = remaining;
  const quota = $("askSentinelQuota");
  quota.textContent = askSentinelState.remaining + " of 3 questions left today";
  quota.classList.toggle("is-empty", askSentinelState.remaining <= 0);
  quota.classList.remove("is-busy");
}
function askSentinelOpen() {
  setView("askSentinel");
  $("askSentinelInput").focus({ preventScroll: true });
  void askSentinelWarmIndex();
}
function askSentinelSetSending(sending) {
  askSentinelState.sending = sending;
  $("askSentinelSend").disabled = sending || askSentinelState.remaining <= 0;
  $("askSentinelInput").disabled = sending || askSentinelState.remaining <= 0;
  $("askSentinelSend").setAttribute("aria-busy", String(sending));
}
/* Repository history and evidence are indexed server-side; client context is not sent as authoritative evidence. */
async function askSentinelSendQuestion(promptOverride) {
  if (askSentinelState.sending || askSentinelState.remaining <= 0) return;
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
      "Ask Sentinel’s interface is ready, but its secure server endpoint has not been configured yet. No request was sent, and no daily allowance was used. Configure CHANGESENTINEL_ASK_ENDPOINT to a dedicated server-side endpoint that authenticates each user, enforces the three-request daily limit atomically, and calls Groq without exposing its key.",
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
    if (askSentinelState.remaining <= 0) {
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

loadData(true);
refreshWorkflowRuns();
window.setInterval(() => loadData(false), 120000);
window.setInterval(updateNextRunCountdown, 30000);
