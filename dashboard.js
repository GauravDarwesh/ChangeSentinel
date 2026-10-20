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
  filter: "ALL", changeFilter: "ALL", detailTab: "", diffMode: "redline", snapshotMode: "preview",
  docInfo: {}, titleQueue: [], titleWorkers: 0, titleTimer: null,
  snapshotCache: {}, htmlCache: {}, evidenceCache: {}, pdfPreviewUrl: "", toastTimer: null
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

function fmt(value) {
  if (!value) return "Not recorded";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString([], {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}
function timeOnly(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
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
          '</span><span class="row-time">' + esc(rowTime(entry.timestamp)) + '</span><span class="row-sub"><span class="tag ' + toneClass(entry) + '">' +
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

// The LED change field: one row per page, one cell per six-hour scan slot.
// The field shows as many six-hour slots as fit (at least 14px each), between
// three and seven days, so labels never collapse on narrower screens.
function fieldGeometry() {
  const field = $("signalVisual");
  const width = (field && (field.clientWidth || field.parentElement.clientWidth)) || 800;
  const labelWidth = Math.round(Math.min(220, Math.max(104, width * (isCompact() ? .36 : .34))));
  const slots = Math.max(12, Math.min(28, Math.floor((width - labelWidth) / 16)));
  return { slots, labelWidth };
}
function renderMonitoringSignal() {
  const field = $("signalVisual");
  const items = state.items || [];
  if (!items.length) {
    field.innerHTML = emptyState("No pages yet", "Each monitored page gets a row of lights here, one per scan.");
    return;
  }
  const geometry = fieldGeometry();
  const slots = L.scanSlots(new Date(), geometry.slots);
  field.style.setProperty("--slots", slots.length);
  field.style.setProperty("--label-w", geometry.labelWidth + "px");
  field.dataset.slots = String(slots.length);
  const scansBySource = {};
  state.history.forEach(run => {
    if (run && run.source_id && run.generated_at) (scansBySource[run.source_id] = scansBySource[run.source_id] || []).push(run.generated_at);
  });
  const reportEvents = allEvents();
  const groups = [];
  items.forEach(item => {
    const last = groups[groups.length - 1];
    if (last && last.sourceId === item.source_id) last.items.push(item);
    else groups.push({ sourceId: item.source_id, items: [item] });
  });
  groups.sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));
  const merged = {};
  groups.forEach(group => { (merged[group.sourceId] = merged[group.sourceId] || []).push(...group.items); });
  let html = "";
  let y = 0;
  const sourceIds = Object.keys(merged);
  sourceIds.forEach(sourceId => {
    const source = configuredSources().find(candidate => candidate.id === sourceId) || { id: sourceId };
    if (sourceIds.length > 1) html += '<div class="field-group" role="row"><span role="rowheader">' + esc(shortSourceLabel(source)) + "</span></div>";
    merged[sourceId].slice().sort((a, b) => itemTitle(a).localeCompare(itemTitle(b))).forEach(item => {
      const page = {
        firstSeen: item.first_seen,
        events: itemChangeEntries(item).concat(reportEvents.filter(event => (event.url_id === item.url_id || event.url === item.canonical_url) &&
          (event.event_type === "FETCH_ERROR" || event.event_type === "EXTRACTION_ERROR"))),
        scans: scansBySource[item.source_id] || [],
        problemAt: item.fetch_error || item.extraction_error ? item.last_checked : null
      };
      const title = itemTitle(item);
      html += '<button class="field-label" type="button" data-monitor-id="' + esc(item.url_id) + '" title="' + esc(title) + '">' + esc(title) + "</button>";
      slots.forEach((slot, x) => {
        const s = L.slotState(slot, page);
        html += '<span class="led s-' + s + (slot.current ? " is-now" : "") + '" role="gridcell" style="--x:' + x + ";--y:" + y + '"' +
          (s === "none" ? "" : ' data-monitor-id="' + esc(item.url_id) + '"') +
          ' data-tip="' + esc(title) + '" data-slot="' + slot.start + '" data-state="' + s + '" aria-label="' + esc(title + ", " + slotLabel(slot) + ": " + stateWords(s)) + '"></span>';
      });
      y++;
    });
  });
  // Day labels under the first slot of each local day.
  let lastDay = "";
  html += '<div class="field-axis" aria-hidden="true">' + slots.map(slot => {
    const d = new Date(slot.start);
    const day = d.toLocaleDateString([], { weekday: "short" });
    const label = day !== lastDay ? day : "";
    lastDay = day;
    return "<span>" + esc(label) + "</span>";
  }).join("") + "</div>";
  field.innerHTML = html;
  const lit = field.querySelectorAll(".led.s-on, .led.s-new").length;
  const bad = field.querySelectorAll(".led.s-bad").length;
  $("fieldNote").textContent = "Each light is one page in one six-hour scan, newest on the right; the outlined column is the scan in progress. " +
    (lit || bad
      ? plural(lit, "scan", "scans") + " found a change" + (bad ? ", and " + plural(bad, "scan", "scans") + " hit a problem" : "") + " in this window."
      : "No scan in this window found a change.");
  updateNextRunCountdown();
}
function slotLabel(slot) {
  const start = new Date(slot.start);
  return start.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + ", " +
    start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " scan" + (slot.current ? " (in progress)" : "");
}
function stateWords(s) {
  return { on: "content changed", new: "new page", bad: "couldn't fetch or read", dim: "checked, no change", none: "no scan" }[s] || s;
}
function nextScheduledScan(reference = new Date()) { return L.nextScheduledScan(reference); }
// Updates the countdown and the six-hour cycle bar; called every 30 seconds.
function updateNextRunCountdown() {
  const cycle = L.scanCycle(new Date());
  const timeNode = $("nextRunTime");
  if (timeNode) timeNode.innerHTML = esc(cycle.next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) +
    ' <small>' + esc(cycle.next.toLocaleDateString([], { weekday: "short" })) + "</small>";
  const countdown = $("nextRunCountdown");
  if (countdown) countdown.textContent = "in " + L.formatDuration(cycle.remainingMinutes);
  const bar = $("cycleBar");
  if (bar) {
    const lit = Math.floor(cycle.progress * 24);
    bar.innerHTML = Array.from({ length: 24 }, (_, i) => '<i class="' + (i < lit ? "on" : i === lit ? "now" : "") + '"></i>').join("");
  }
  const last = state.report.generated_at;
  if ($("lastScanTime")) {
    $("lastScanTime").textContent = last ? relativeTime(last) : "None saved yet";
    const stale = last && Date.now() - new Date(last).getTime() > 8 * 3600 * 1000;
    $("lastScanNote").textContent = last ? (stale ? "later than the six-hour schedule" : timeOnly(last)) : "";
  }
}
function showFieldTip(target, x, y) {
  const tip = $("fieldTip");
  if (!target) { tip.hidden = true; return; }
  const slot = { start: Number(target.dataset.slot), current: target.classList.contains("is-now") };
  tip.innerHTML = esc(target.dataset.tip) + "<small>" + esc(slotLabel(slot)) + "</small><small>" + esc(stateWords(target.dataset.state).replace(/^\w/, ch => ch.toUpperCase())) + "</small>";
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - box.width - 12, x + 14) + "px";
  tip.style.top = Math.max(12, y - box.height - 12) + "px";
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
      '<span class="row-summary">' + esc(runSummary(counts)) + (run.superseded ? ". Superseded by a later correction." : "") + "</span></button>";
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
    if (state.diffMode === "html") {
      target.innerHTML = L.renderUnifiedDiff(evidence.html_diff || "");
      if (summary) summary.textContent = "Formatted HTML markup diff. The fetched response is saved separately.";
    } else if (state.diffMode === "text") {
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
          return "<tr>" + padded.map(cell => "<" + tag + ">" + esc(cell || "") + "</" + tag + ">").join("") + "</tr>";
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
function previewSource(source, url) {
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
    (snapshotPath ? externalLink(REPO + "/blob/main/" + snapshotPath, savedFileLabel) : "");
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
  return { overview: "overviewView", changes: "changesView", monitors: "monitorsView", runs: "runsView", notifications: "notificationsView" }[view];
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
  const hash = "#" + HASH_NAMES[state.view] + (id ? "/" + encodeURIComponent(id) : "");
  try { history.replaceState(null, "", state.view === "overview" ? location.pathname + location.search : hash); } catch (_) {}
}
function readHash() {
  const raw = String(location.hash || "").replace(/^#/, "");
  const legacy = raw.match(/^monitor=([^&]+)/);
  if (legacy) return { view: "monitors", id: decodeURIComponent(legacy[1]) };
  const [name, ...rest] = raw.split("/");
  const view = Object.keys(HASH_NAMES).find(key => HASH_NAMES[key] === name);
  return view ? { view, id: rest.length ? decodeURIComponent(rest.join("/")) : "" } : null;
}
function setView(view, options) {
  options = options || {};
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

/* ================= Add a page ================= */

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
  $("addMonitorDialog").close();
  ["newMonitorUrl", "newMonitorName", "newMonitorIncludeSelector", "newMonitorIgnoreSelectors"].forEach(id => { $(id).value = ""; });
  showToast("Submit the prefilled request on GitHub. The page is scanned once the request is accepted.");
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) {
    try { githubWindow.opener = null; } catch (_) {}
  } else {
    window.location.href = target;
  }
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
$("signalVisual").addEventListener("mousemove", event => {
  const cell = event.target.closest(".led");
  showFieldTip(cell, event.clientX, event.clientY);
});
$("signalVisual").addEventListener("mouseleave", () => showFieldTip(null));
// Redraw the field when its width changes enough to fit a different number of slots.
if (typeof ResizeObserver === "function") {
  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.loaded && state.view === "overview" && String(fieldGeometry().slots) !== $("signalVisual").dataset.slots) renderMonitoringSignal();
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
  if (meta) meta.setAttribute("content", currentTheme() === "dark" ? "#120b07" : "#e4e0da");
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
$("closeAddMonitor").addEventListener("click", () => $("addMonitorDialog").close());
$("cancelAddMonitor").addEventListener("click", () => $("addMonitorDialog").close());
$("addMonitorDialog").addEventListener("click", event => {
  if (event.target === $("addMonitorDialog")) $("addMonitorDialog").close();
});
$("newMonitorUrl").addEventListener("input", () => $("newMonitorUrl").setCustomValidity(""));
$("addMonitorForm").addEventListener("submit", submitAddMonitor);
if (compactQuery && typeof compactQuery.addEventListener === "function") {
  compactQuery.addEventListener("change", () => { if (state.loaded) setView(state.view, { detail: state.mobileDetail }); });
}


/* ================= Ask Sentinel =================
 * This UI deliberately talks only to a same-origin server endpoint.
 * It never contains an OpenRouter credential and does not implement a
 * client-side quota (which would be bypassable by clearing browser storage).
 */
const ASK_SENTINEL_ENDPOINT = window.CHANGESENTINEL_ASK_ENDPOINT || "";
const ASK_SENTINEL_MAX_TRANSCRIPT = 12;
const askSentinelState = { messages: [], sending: false, remaining: 3 };

function askSentinelEscapedText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function askSentinelMessageNode(role, content, extraClass) {
  const node = document.createElement("article");
  node.className = "ask-sentinel-message " + (role === "user" ? "user" : "assistant") + (extraClass ? " " + extraClass : "");
  const avatar = document.createElement("div");
  avatar.className = "ask-sentinel-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = role === "user" ? "YOU" : "S/AI";
  const body = document.createElement("div");
  body.className = "ask-sentinel-message-body";
  const label = document.createElement("div");
  label.className = "ask-sentinel-role";
  label.textContent = role === "user" ? "You" : "Sentinel";
  const text = document.createElement("div");
  text.className = "ask-sentinel-text";
  text.textContent = content;
  body.append(label, text);
  node.append(avatar, body);
  return node;
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
  quota.textContent = askSentinelState.remaining + " of 3 left today";
}
function askSentinelOpen() {
  setView("askSentinel");
  $("askSentinelInput").focus({ preventScroll: true });
}
function askSentinelSetSending(sending) {
  askSentinelState.sending = sending;
  $("askSentinelSend").disabled = sending || askSentinelState.remaining <= 0;
  $("askSentinelInput").disabled = sending || askSentinelState.remaining <= 0;
  $("askSentinelSend").setAttribute("aria-busy", String(sending));
}
function askSentinelHistoryContext() {
  // Summarize the dashboard's actual loaded objects. The server must treat this
  // as untrusted context and may independently load full evidence from the repo.
  const report = state.report || {};
  const totals = report.counts || {};
  const inventory = state.inventory && state.inventory.sources || {};
  const pages = [];
  Object.keys(inventory).forEach(sourceId => {
    const records = inventory[sourceId];
    if (!isPlainObject(records)) return;
    Object.keys(records).forEach(id => {
      const item = records[id] || {};
      pages.push({
        source_id: sourceId,
        url_id: item.url_id || id,
        regulator: item.regulator || null,
        url: item.canonical_url || null,
        active: item.active !== false,
        last_checked: item.last_checked || null,
        last_seen: item.last_seen || null,
        http_status: item.http_status || null,
        content_type: item.content_type || null,
        extraction_error: item.extraction_error || null,
        fetch_error: item.fetch_error || null,
        relevance: item.relevance || null,
        changes: itemChangeEntries(item).slice(0, 6).map(event => ({
          event_id: event.event_id, event_type: event.event_type,
          timestamp: event.timestamp, summary: event.summary || event.ai_summary || null,
          old_hash: event.old_hash || null, new_hash: event.new_hash || null,
          evidence_location: event.evidence_location || null
        }))
      });
    });
  });
  return {
    schema_version: 1,
    generated_at: report.generated_at || null,
    run_id: report.run_id || null,
    totals,
    sources: configuredSources().map(source => ({
      id: source.id, name: source.name, regulator: source.regulator,
      seeds: source.seeds || [], active: source.active !== false
    })),
    latest_runs: (Array.isArray(state.history) ? state.history : []).slice(0, 120),
    recent_events: changeLogEntries().slice(0, 160).map(event => ({
      event_id: event.event_id, event_type: event.event_type,
      timestamp: event.timestamp, source_id: event.source_id,
      url: event.url, summary: event.summary || event.ai_summary || null,
      status: event.status || null, relevance: event.relevance || null,
      evidence_location: event.evidence_location || null,
      superseded: event.superseded === true,
      superseded_reason: event.superseded_reason || null
    })),
    notifications: {
      pending: notificationLists().pending.slice(0, 50),
      sent: notificationLists().sent.slice(0, 100)
    },
    pages,
    // Paths are repository-relative and resolved only by the trusted server.
    data_sources: [
      "data/report.json", "data/latest.json", "data/history/index.json",
      "data/notifications.json", "data/notification-outbox.json", "config/sources.json",
      "data/evidence/*", "data/history/*", "data/snapshots/*", "data/file_snapshots/*"
    ]
  };
}
async function askSentinelSubmit(promptOverride) {
  if (askSentinelState.sending || askSentinelState.remaining <= 0) return;
  const input = $("askSentinelInput");
  const question = String(promptOverride == null ? input.value : promptOverride).trim();
  if (!question) { input.focus(); return; }
  if (question.length > 1200) {
    askSentinelAppendMessage("assistant", "Please keep each question to 1,200 characters or fewer.", "ask-sentinel-error");
    return;
  }
  if (!ASK_SENTINEL_ENDPOINT) {
    askSentinelAppendMessage("assistant",
      "Ask Sentinel’s interface is ready, but its secure server endpoint has not been configured yet. No request was sent, and no daily allowance was used. Configure CHANGESENTINEL_ASK_ENDPOINT to a dedicated server-side endpoint that authenticates each user, enforces the three-request daily limit atomically, and calls OpenRouter without exposing its key.",
      "ask-sentinel-error");
    return;
  }
  $("askSentinelWelcome").hidden = true;
  input.value = "";
  askSentinelAppendMessage("user", question);
  const history = askSentinelState.messages.slice(-ASK_SENTINEL_MAX_TRANSCRIPT);
  const typing = askSentinelAppendMessage("assistant", "Reviewing saved monitoring records…", "ask-sentinel-typing");
  askSentinelSetSending(true);
  try {
    const response = await fetch(ASK_SENTINEL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        question,
        conversation: history,
        dashboard_context: askSentinelHistoryContext()
      })
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
    typing.querySelector(".ask-sentinel-text").textContent = answer;
    typing.classList.remove("ask-sentinel-typing");
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
      $("askSentinelQuota").textContent = "0 of 3 left today";
      $("askSentinelInput").placeholder = "Daily request limit reached";
    }
    input.focus({ preventScroll: true });
  }
}
$("askSentinelLaunch").addEventListener("click", askSentinelOpen);
$("askSentinelBack").addEventListener("click", () => setView("overview"));
$("askSentinelForm").addEventListener("submit", event => {
  event.preventDefault();
  askSentinelSubmit();
});
$("askSentinelTranscript").addEventListener("click", event => {
  const prompt = event.target.closest("[data-ask-prompt]");
  if (prompt) askSentinelSubmit(prompt.dataset.askPrompt);
});
document.querySelectorAll("[data-ask-prompt]").forEach(button => button.addEventListener("click", () => askSentinelSubmit(button.dataset.askPrompt)));

loadData(true);
window.setInterval(() => loadData(false), 120000);
window.setInterval(updateNextRunCountdown, 30000);
