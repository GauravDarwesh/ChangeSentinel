"use strict";

const RAW = "https://raw.githubusercontent.com/GauravDarwesh/ChangeSentinel/main";
const REPO = "https://github.com/GauravDarwesh/ChangeSentinel";
const ENDPOINTS = {
  report: RAW + "/data/report.json",
  inventory: RAW + "/data/latest.json",
  history: RAW + "/data/history/index.json",
  notifications: RAW + "/data/notifications.json",
  config: RAW + "/config/sources.json"
};
const $ = id => document.getElementById(id);
const state = {
  report: {}, inventory: {}, history: [], notifications: {}, config: {},
  items: [], selectedId: "", view: "monitors", filter: "ALL", detailTab: "snapshot",
  snapshotMode: "preview", snapshotCache: {}, htmlCache: {}, evidenceCache: {},
  toastTimer: null
};

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}
function bust(url) { return url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now(); }
function fmt(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString([], {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}
function relativeTime(value) {
  if (!value) return "Not checked yet";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + "m ago";
  if (mins < 1440) return Math.floor(mins / 60) + "h ago";
  return Math.floor(mins / 1440) + "d ago";
}
function dateShort(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
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
function activeSourceName() {
  const active = activeSources();
  if (!active.length) return "No active sources";
  if (active.length === 1) return active[0].name || active[0].regulator || active[0].id;
  return active.length + " active sources";
}
function itemTitle(item) {
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
  return last.replace(/\.(html?|pdf)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
}
function urlHost(item) {
  try { return new URL(item.canonical_url).hostname; }
  catch (_) { return item.canonical_url || "Unknown URL"; }
}
function matchingEvents(item) {
  const url = item.canonical_url || "";
  return allEvents().filter(event =>
    event.url === url || event.canonical_url === url || (event.url_id && event.url_id === item.url_id)
  );
}
function itemStatus(item) {
  if (item.fetch_error || item.extraction_error || (item.http_status && Number(item.http_status) >= 400)) {
    return { label: "Needs attention", cls: "is-error", icon: "!", kind: "error" };
  }
  const events = matchingEvents(item).slice().sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  const newest = events[0];
  if (newest && newest.event_type === "CHANGED_URL") return { label: "Content changed", cls: "is-warning", icon: "↗", kind: "change" };
  if (newest && newest.event_type === "HTML_SOURCE_CHANGED") return { label: "HTML source changed", cls: "is-warning", icon: "⌁", kind: "change" };
  if (newest && newest.event_type === "NEW_URL") return { label: "New page", cls: "is-warning", icon: "+", kind: "change" };
  if (newest && newest.event_type === "FETCH_ERROR") return { label: "Fetch error", cls: "is-error", icon: "!", kind: "error" };
  if (newest && newest.event_type === "EXTRACTION_ERROR") return { label: "Extraction error", cls: "is-error", icon: "!", kind: "error" };
  if (item.first_seen && item.last_checked && new Date(item.first_seen).getTime() === new Date(item.last_checked).getTime()) {
    return { label: "Baseline saved", cls: "", icon: "✓", kind: "ok" };
  }
  return { label: "Monitoring", cls: "", icon: "✓", kind: "ok" };
}
function makeItems() {
  const groups = state.inventory.sources || {};
  const ids = activeSourceIds();
  const items = [];
  Object.keys(groups).forEach(sourceId => {
    if (ids.length && ids.indexOf(sourceId) < 0) return;
    const group = groups[sourceId] || {};
    Object.values(group).forEach(item => {
      if (item && item.canonical_url && item.active !== false) items.push(item);
    });
  });
  items.sort((a, b) => itemTitle(a).localeCompare(itemTitle(b)));
  return items;
}
function selectedItem() { return state.items.find(item => item.url_id === state.selectedId) || null; }
function setStatus(value, failed) {
  $("connectionStatus").textContent = value;
  $("sideStatus").textContent = failed ? "GitHub data unavailable" : value;
  $("headerDot").style.background = failed ? "#d34d5b" : "#26a879";
  $("headerDot").style.boxShadow = failed ? "none" : "0 0 0 4px #26a87920";
  $("sideDot").style.background = failed ? "#d34d5b" : "#4ed3a0";
  $("sideDot").style.boxShadow = failed ? "none" : "0 0 0 4px rgba(78,211,160,.12)";
}
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, 5600);
}
function emptyState(title, copy, icon) {
  return '<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">' +
    esc(icon || "◫") + '</div><div class="empty-title">' + esc(title) +
    '</div><div class="empty-copy">' + esc(copy) + '</div></div></div>';
}
function renderMetrics() {
  const counts = state.report.counts || {};
  const events = allEvents();
  const changes = events.filter(event =>
    ["CHANGED_URL", "HTML_SOURCE_CHANGED", "NEW_URL", "REMOVED_URL"].indexOf(event.event_type) >= 0
  ).length;
  const errors = Number(counts.fetch_error || 0) + Number(counts.extraction_error || 0);
  $("metricMonitors").textContent = state.items.length;
  $("metricChanges").textContent = changes;
  $("metricErrors").textContent = errors;
  $("metricLast").textContent = state.report.generated_at ? dateShort(state.report.generated_at) : "—";
  $("metricRunId").textContent = state.report.run_id ? "Latest run " + state.report.run_id : "No saved scan report";
  $("navMonitorCount").textContent = state.items.length;
  $("navChangeCount").textContent = events.length;
  $("monitorCount").textContent = state.items.length + (state.items.length === 1 ? " page" : " pages");
  $("footerStamp").textContent = "Latest stored report · " + fmt(state.report.generated_at);
}
function renderMonitorList() {
  const query = $("monitorSearch").value.trim().toLowerCase();
  const all = state.items.filter(item => {
    const status = itemStatus(item);
    if (state.filter === "CHANGES" && status.kind !== "change") return false;
    if (state.filter === "ERRORS" && status.kind !== "error") return false;
    const source = sourceForItem(item);
    const haystack = [itemTitle(item), item.canonical_url, item.source_id, source.name, source.regulator].join(" ").toLowerCase();
    return !query || haystack.includes(query);
  });
  $("monitorCount").textContent = all.length + (all.length === 1 ? " page" : " pages") +
    (all.length === state.items.length ? "" : " shown");
  if (!all.length) {
    $("monitorList").innerHTML = emptyState(
      state.items.length ? "No pages match this view" : "No active monitors yet",
      state.items.length
        ? "Try a different search or choose another filter to see more pages."
        : "Add your first URL to begin monitoring. When the GitHub request is submitted and the first scan completes, the page will appear here.",
      state.items.length ? "⌕" : "+"
    );
    return;
  }
  $("monitorList").innerHTML = all.map(item => {
    const status = itemStatus(item);
    const source = sourceForItem(item);
    const initial = (urlHost(item).replace(/^www\./i, "").charAt(0) || "W").toUpperCase();
    const host = urlHost(item);
    return '<article class="monitor-card">' +
      '<div class="monitor-main"><div class="site-badge" aria-hidden="true">' + esc(initial) + '</div>' +
      '<div class="monitor-copy"><div class="monitor-title-row"><h3 class="monitor-title">' + esc(itemTitle(item)) + '</h3>' +
      '<span class="status-pill ' + esc(status.cls) + '">' + esc(status.label) + '</span></div>' +
      '<div class="monitor-url">' + esc(item.canonical_url) + '</div>' +
      '<div class="monitor-bottom"><span>◉ ' + esc(host) + '</span><span>◷ Checked ' + esc(relativeTime(item.last_checked)) + '</span>' +
      '<span>HTTP ' + esc(item.http_status == null ? "—" : item.http_status) + '</span>' +
      (source.name ? '<span>' + esc(source.name) + '</span>' : '') +
      '</div></div></div>' +
      '<button class="monitor-open" data-monitor-id="' + esc(item.url_id) + '" type="button" aria-label="Open details for ' + esc(itemTitle(item)) + '">View page details <span aria-hidden="true">→</span></button>' +
      '</article>';
  }).join("");
}
function snapshotURL(path) { return path ? bust(RAW + "/" + path) : ""; }
async function readSnapshotFile(path, cache, asText) {
  if (!path) throw new Error("Snapshot path is not available");
  if (cache[path] != null) return cache[path];
  const response = await fetch(snapshotURL(path), { cache: "no-store" });
  if (!response.ok) throw new Error("Snapshot request returned HTTP " + response.status);
  const content = asText ? await response.text() : await response.text();
  cache[path] = content;
  return content;
}
function previewSource(source, url) {
  const baseTag = '<base href="' + esc(url) + '">';
  if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, match => match + baseTag);
  return '<!doctype html><html><head><meta charset="utf-8">' + baseTag + '</head><body>' + source + '</body></html>';
}
function renderSnapshotText(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (!lines.some(line => line.trim())) return emptyState("Snapshot is empty", "The repository contains a snapshot record, but no readable text was extracted from it.", "▧");
  const dateRe = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/i;
  const likelySection = /^(Information Collections|Pending Review|Reporting Forms|Recent Reporting Form Updates|Information Collections Out for Public Comment|Collection Identifier|Questions regarding|Note:|Last Update:)/i;
  return '<div class="snapshot-text">' + lines.map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return '<div style="height:8px"></div>';
    let cls = "doc-line";
    if (dateRe.test(trimmed)) cls += " date-line";
    else if (index > 0 && (likelySection.test(trimmed) || (trimmed.length < 72 && !/[.!?]$/.test(trimmed) && trimmed.split(/\s+/).length < 9))) cls += " section-line";
    return '<p class="' + cls + '">' + esc(trimmed) + '</p>';
  }).join("") + '</div>';
}
function renderSourceCode(source) {
  const lines = String(source || "").split(/\r?\n/);
  return '<div class="source-code" role="region" aria-label="Saved HTML source"><div class="source-code-inner">' +
    lines.map((line, index) => '<div class="source-line"><span class="line-no">' + (index + 1) + '</span><code>' + esc(line || " ") + '</code></div>').join("") +
    '</div></div>';
}
function renderDetailHeader(item) {
  const status = itemStatus(item);
  const source = sourceForItem(item);
  const htmlPath = item.html_snapshot_location || "";
  const textPath = item.snapshot_location || "";
  const snapshotPath = htmlPath || textPath;
  $("detailHeader").innerHTML =
    '<div class="detail-hero"><div class="detail-hero-top"><div class="detail-title-wrap">' +
    '<div class="detail-kicker">' + esc(source.name || source.regulator || "Monitored page") + '</div>' +
    '<h2 class="detail-title">' + esc(itemTitle(item)) + '</h2><div class="detail-url">' + esc(item.canonical_url) + '</div>' +
    '</div><div class="detail-actions"><a class="btn" href="' + esc(item.canonical_url) + '" target="_blank" rel="noopener noreferrer">Open live page ↗</a>' +
    (snapshotPath ? '<a class="btn" href="' + esc(REPO + "/blob/main/" + snapshotPath) + '" target="_blank" rel="noopener noreferrer">Open saved file ↗</a>' : '') +
    '</div></div><div class="detail-meta"><span class="status-pill ' + esc(status.cls) + '">' + esc(status.label) + '</span>' +
    '<span class="meta-chip">HTTP ' + esc(item.http_status == null ? "—" : item.http_status) + '</span>' +
    '<span class="meta-chip">Last checked ' + esc(fmt(item.last_checked)) + '</span>' +
    '<span class="meta-chip">' + (htmlPath ? 'HTML response saved' : 'HTML snapshot not captured') + '</span>' +
    (item.content_type ? '<span class="meta-chip">' + esc(item.content_type) + '</span>' : '') + '</div></div>';
  document.querySelectorAll("[data-detail-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.detailTab === state.detailTab);
    button.setAttribute("aria-current", button.dataset.detailTab === state.detailTab ? "page" : "false");
  });
}
async function loadSnapshot(item) {
  const body = $("detailBody");
  body.innerHTML =
    '<div class="snapshot-panel"><div class="snapshot-toolbar"><div class="snapshot-label"><span class="file-icon" aria-hidden="true">▧</span>' +
    '<div><div class="snapshot-label-title">Saved page snapshot</div><div class="snapshot-sub">Captured ' + esc(fmt(item.last_full_fetch || item.last_checked)) + '</div></div></div>' +
    '<span class="meta-chip">HTML SHA-256 ' + esc((item.html_hash || "").slice(0, 14) || "pending") + '</span></div>' +
    '<div class="snapshot-main"><div class="snapshot-notice"><span aria-hidden="true">ⓘ</span><span>This preview uses the stored HTML response. Scripts are disabled in the preview; the original response is preserved separately in HTML source.</span></div>' +
    '<div class="snapshot-mode" role="group" aria-label="Snapshot display mode">' +
    '<button class="mode-button ' + (state.snapshotMode === "preview" ? "active" : "") + '" data-snapshot-mode="preview" type="button">Rendered preview</button>' +
    '<button class="mode-button ' + (state.snapshotMode === "text" ? "active" : "") + '" data-snapshot-mode="text" type="button">Extracted text</button></div>' +
    '<div class="loading-text" id="snapshotCanvas">Loading saved snapshot…</div></div></div>';
  const canvas = $("snapshotCanvas");
  if (state.snapshotMode === "text") {
    if (!item.snapshot_location) {
      canvas.innerHTML = emptyState("Text snapshot unavailable", "This record has no normalized-text snapshot path.", "!");
      return;
    }
    try {
      const text = await readSnapshotFile(item.snapshot_location, state.snapshotCache, true);
      if (selectedItem()?.url_id !== item.url_id || state.detailTab !== "snapshot") return;
      canvas.outerHTML = renderSnapshotText(text);
    } catch (error) {
      canvas.outerHTML = emptyState("Could not load text snapshot", String(error.message || error), "!");
    }
    return;
  }
  if (!item.html_snapshot_location) {
    canvas.outerHTML = emptyState("HTML snapshot not captured yet", "The first successful full fetch creates the saved preview and preserves a separate source file. This page can still be opened live above.", "⌁");
    return;
  }
  try {
    const source = await readSnapshotFile(item.html_snapshot_location, state.htmlCache, true);
    if (selectedItem()?.url_id !== item.url_id || state.detailTab !== "snapshot") return;
    canvas.outerHTML = '<iframe class="snapshot-frame" title="Saved HTML page preview" sandbox="" loading="lazy"></iframe>';
    const frame = body.querySelector("iframe.snapshot-frame");
    if (frame) frame.srcdoc = previewSource(source, item.canonical_url || "");
  } catch (error) {
    canvas.outerHTML = emptyState("Could not load HTML snapshot", String(error.message || error), "!");
  }
}
async function loadHtmlSource(item) {
  const path = item.html_snapshot_location || "";
  const body = $("detailBody");
  body.innerHTML = '<div class="snapshot-panel"><div class="snapshot-toolbar"><div class="snapshot-label"><span class="file-icon" aria-hidden="true">&lt;/&gt;</span>' +
    '<div><div class="snapshot-label-title">Saved HTML source</div><div class="snapshot-sub">' + esc(path || "No HTML response captured") + '</div></div></div>' +
    '<span class="meta-chip">SHA-256 ' + esc((item.html_hash || "").slice(0, 14) || "pending") + '</span></div><div class="snapshot-main">' +
    '<div class="snapshot-notice"><span aria-hidden="true">ⓘ</span><span>This is the fetched response body, not a browser-generated DOM after client-side JavaScript runs.</span></div>' +
    '<div id="htmlSourceCanvas" class="loading-text">Loading source code…</div></div></div>';
  const canvas = $("htmlSourceCanvas");
  if (!path) {
    canvas.outerHTML = emptyState("HTML source not captured yet", "A successful full fetch is needed to create the first HTML response snapshot.", "⌁");
    return;
  }
  try {
    const source = await readSnapshotFile(path, state.htmlCache, true);
    if (selectedItem()?.url_id !== item.url_id || state.detailTab !== "source") return;
    canvas.outerHTML = renderSourceCode(source);
  } catch (error) {
    canvas.outerHTML = emptyState("Could not load HTML source", String(error.message || error), "!");
  }
}
function renderDiffMarkup(diff) {
  if (!diff) return '<div class="diff-empty">No line-level differences were recorded in this evidence file.</div>';
  return '<div class="diff-code">' + String(diff).split(/\r?\n/).map(line => {
    const cls = line.startsWith("+++") || line.startsWith("---") ? "diff-file" :
      line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" :
      line.startsWith("@@") ? "diff-hunk" : "";
    return '<div class="diff-line ' + cls + '">' + esc(line || " ") + '</div>';
  }).join("") + '</div>';
}
function renderChangesForItem(item) {
  const events = matchingEvents(item).slice().sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  if (!events.length) {
    const baseline = item.first_seen && item.last_checked && new Date(item.first_seen).getTime() === new Date(item.last_checked).getTime();
    return emptyState(baseline ? "Baseline captured" : "No recent change events", baseline
      ? "This fetch established the initial baseline. Later runs compare extracted content and, separately, the fetched HTML source."
      : "There are no events for this URL in the latest report. Use Run history to inspect earlier scans.", "✓");
  }
  return '<div class="diff-list">' + events.slice(0, 20).map(event => {
    const summary = (event.ai && event.ai.analysis && event.ai.analysis.summary) ||
      (event.evidence && event.evidence.error) || event.summary ||
      (event.event_type === "HTML_SOURCE_CHANGED" ? "The HTML markup changed while extracted text remained the same." : "A monitoring event was recorded for this URL.");
    const boxId = "evidence-" + String(event.event_id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    return '<article class="event-card"><div class="event-symbol ' + (/ERROR/.test(event.event_type || "") ? "is-error" : ["CHANGED_URL","HTML_SOURCE_CHANGED","NEW_URL","REMOVED_URL"].includes(event.event_type) ? "is-warning" : "") + '">' +
      esc(event.event_type === "HTML_SOURCE_CHANGED" ? "⌁" : event.event_type === "NEW_URL" ? "+" : event.event_type === "CHANGED_URL" ? "↗" : /ERROR/.test(event.event_type || "") ? "!" : event.event_type === "REMOVED_URL" ? "−" : "✓") +
      '</div><div><div class="event-top"><div><h3 class="event-title">' + esc(summary) + '</h3><div class="event-type">' + esc(event.event_type || "EVENT") + '</div></div><div class="event-time">' + esc(fmt(event.timestamp)) + '</div></div>' +
      (event.evidence_location ? '<div class="event-footer"><a href="' + esc(REPO + "/blob/main/" + event.evidence_location) + '" target="_blank" rel="noopener noreferrer">Open evidence JSON ↗</a></div><div class="diff-list" id="' + esc(boxId) + '"><div class="diff-loading">Loading text and HTML source diffs…</div></div>' :
      '<div class="event-summary">No evidence file is attached to this event.</div>') + '</div></article>';
  }).join("") + (events.length > 20 ? '<div class="diff-empty">Showing the 20 most recent events for this page.</div>' : '') + '</div>';
}
async function loadChangesForItem(item) {
  $("detailBody").innerHTML = renderChangesForItem(item);
  const events = matchingEvents(item).slice().sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, 20);
  for (const event of events) {
    if (!event.evidence_location) continue;
    try {
      let evidence = state.evidenceCache[event.evidence_location];
      if (!evidence) {
        const response = await fetch(bust(RAW + "/" + event.evidence_location), { cache: "no-store" });
        if (!response.ok) throw new Error("Evidence request returned HTTP " + response.status);
        evidence = await response.json();
        state.evidenceCache[event.evidence_location] = evidence;
      }
      if (selectedItem()?.url_id !== item.url_id || state.detailTab !== "changes") return;
      const boxId = "evidence-" + String(event.event_id || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const box = document.getElementById(boxId);
      if (!box) continue;
      box.innerHTML = '<details class="diff-details" open><summary>HTML source diff</summary><div class="diff-note">Formatted markup diff · original HTML snapshot files remain available separately</div>' +
        renderDiffMarkup(evidence.html_diff || "") + '</details><details class="diff-details"><summary>Extracted content diff</summary>' +
        renderDiffMarkup(evidence.diff || "") + '</details>';
    } catch (error) {
      const boxId = "evidence-" + String(event.event_id || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const box = document.getElementById(boxId);
      if (box) box.innerHTML = '<div class="diff-empty">Could not load event evidence: ' + esc(String(error.message || error)) + '</div>';
    }
  }
}
function renderDetails(item) {
  const fields = [
    ["Source ID", item.source_id], ["Source name", sourceForItem(item).name], ["Regulator / host", item.regulator || urlHost(item)],
    ["HTTP status", item.http_status], ["Content type", item.content_type], ["Extraction type", item.extraction_type],
    ["First seen", fmt(item.first_seen)], ["Last checked", fmt(item.last_checked)], ["Last full fetch", fmt(item.last_full_fetch)],
    ["ETag", item.etag || "Not supplied"], ["Last-Modified", item.last_modified || "Not supplied"],
    ["Normalized text SHA-256", item.normalized_hash || "Not available"], ["HTML source SHA-256", item.html_hash || "Not available"],
    ["Raw response SHA-256", item.raw_hash || "Not available"], ["HTML snapshot file", item.html_snapshot_location || "Not captured"],
    ["Text snapshot file", item.snapshot_location || "Not available"], ["Fetch error", item.fetch_error || "None"],
    ["Extraction error", item.extraction_error || "None"]
  ];
  $("detailBody").innerHTML = '<div class="detail-grid">' + fields.map(([key, value]) =>
    '<div class="detail-cell"><label>' + esc(key) + '</label><div class="' + (String(key).indexOf("SHA-256") >= 0 ? "hash" : "") + '">' +
    esc(value == null ? "—" : value) + '</div></div>'
  ).join("") + '</div>';
}
function renderDetailBody() {
  const item = selectedItem();
  if (!item) {
    $("detailHeader").innerHTML = "";
    $("detailBody").innerHTML = "";
    return;
  }
  renderDetailHeader(item);
  if (state.detailTab === "snapshot") loadSnapshot(item);
  else if (state.detailTab === "source") loadHtmlSource(item);
  else if (state.detailTab === "changes") loadChangesForItem(item);
  else renderDetails(item);
}
function renderChangeRoute() {
  const events = allEvents().slice().sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  $("changeSubtitle").textContent = state.report.run_id
    ? "Run " + state.report.run_id + " · " + fmt(state.report.generated_at)
    : "No report metadata available";
  $("changeCount").textContent = events.length + (events.length === 1 ? " event" : " events");
  if (!events.length) {
    $("changeItems").innerHTML = emptyState("No change events in the latest report",
      "A scan can establish a baseline without raising a change event. Earlier scan summaries remain available in Run history.", "✓");
    return;
  }
  $("changeItems").innerHTML = events.map(event => {
    const item = state.items.find(candidate => candidate.canonical_url === event.url || candidate.url_id === event.url_id);
    const title = item ? itemTitle(item) : (event.url || event.event_type || "Monitoring event");
    const isError = /ERROR/.test(event.event_type || "");
    const isChange = ["CHANGED_URL", "HTML_SOURCE_CHANGED", "NEW_URL", "REMOVED_URL"].includes(event.event_type);
    const symbol = event.event_type === "HTML_SOURCE_CHANGED" ? "⌁" : event.event_type === "NEW_URL" ? "+" :
      event.event_type === "CHANGED_URL" ? "↗" : isError ? "!" : event.event_type === "REMOVED_URL" ? "−" : "✓";
    return '<article class="event-card"><div class="event-symbol ' + (isError ? "is-error" : isChange ? "is-warning" : "") + '">' + esc(symbol) +
      '</div><div><div class="event-top"><div><h3 class="event-title">' + esc(title) + '</h3><div class="event-type">' + esc(event.event_type || "EVENT") +
      '</div></div><div class="event-time">' + esc(fmt(event.timestamp)) + '</div></div><div class="event-url">' + esc(event.url || "") +
      '</div><div class="event-summary">' + esc((event.ai && event.ai.analysis && event.ai.analysis.summary) || event.summary ||
        (event.event_type === "HTML_SOURCE_CHANGED" ? "The HTML markup changed while extracted text remained the same." : "A monitoring event was recorded for this URL.")) +
      '</div><div class="event-footer"><button class="btn" data-event-url="' + esc(event.url || event.canonical_url || "") + '" type="button">Inspect this page →</button>' +
      (event.evidence_location ? ' <a class="btn btn-quiet" href="' + esc(REPO + "/blob/main/" + event.evidence_location) + '" target="_blank" rel="noopener noreferrer">Open evidence file ↗</a>' : '') +
      '</div></div></article>';
  }).join("");
}
function renderRuns() {
  const runs = state.history.slice(0, 50);
  $("runCount").textContent = runs.length + (runs.length === 1 ? " run" : " runs");
  if (!runs.length) {
    $("runItems").innerHTML = emptyState("No run history available", "The repository’s history index does not contain any saved runs yet.", "◷");
    return;
  }
  $("runItems").innerHTML = runs.map(run => {
    const counts = run.counts || {};
    const source = configuredSources().find(candidate => candidate.id === run.source_id);
    const isActive = !!source && source.active !== false;
    const pills = [
      ["Checked", counts.discovered], ["Changed", counts.changed], ["New", counts.new],
      ["Source changes", counts.source_changed], ["Errors", Number(counts.fetch_error || 0) + Number(counts.extraction_error || 0)]
    ];
    return '<article class="run-card"><div class="run-symbol" aria-hidden="true">◷</div><div class="run-main"><div class="run-title">' +
      esc(run.regulator || (source && source.name) || run.source_id || "Monitoring run") + '</div><div class="run-sub">' +
      esc(fmt(run.generated_at)) + ' · ' + esc(run.run_id || "") + '</div><div class="run-sub">Source ID: ' + esc(run.source_id || "—") +
      '</div><div class="run-counts">' + pills.map(([label, value]) => '<span class="run-count">' + esc(label) + ': ' + esc(value == null ? 0 : value) +
      '</span>').join("") + '</div></div><span class="run-source">' + (isActive ? "Active source" : "Historical / inactive") + '</span></article>';
  }).join("");
}
function renderViews() {
  const isMonitor = state.view === "monitors";
  $("monitorsView").hidden = !isMonitor || !!state.selectedId;
  $("detailView").hidden = !isMonitor || !state.selectedId;
  $("changesView").hidden = state.view !== "changes";
  $("runsView").hidden = state.view !== "runs";
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === state.view);
    button.setAttribute("aria-current", button.dataset.view === state.view ? "page" : "false");
  });
  const labels = { monitors: "Monitored pages", changes: "Change log", runs: "Run history" };
  $("breadcrumb").textContent = "Workspace / " + (isMonitor && state.selectedId ? "Page details" : labels[state.view]);
}
function renderAll() {
  state.items = makeItems();
  if (state.selectedId && !state.items.some(item => item.url_id === state.selectedId)) state.selectedId = "";
  renderMetrics();
  renderMonitorList();
  if (state.selectedId) renderDetailBody();
  renderChangeRoute();
  renderRuns();
  renderViews();
}
function setSelected(id) {
  state.selectedId = id;
  state.detailTab = "snapshot";
  state.snapshotMode = "preview";
  renderMonitorList();
  renderDetailBody();
  renderViews();
  const item = selectedItem();
  try {
    if (item) history.replaceState(null, "", "#monitor=" + encodeURIComponent(item.url_id));
    else history.replaceState(null, "", location.pathname + location.search);
  } catch (_) {}
}
function setView(view) {
  state.view = view;
  if (view !== "monitors") state.selectedId = "";
  else state.selectedId = "";
  renderViews();
  if (view === "changes") renderChangeRoute();
  if (view === "runs") renderRuns();
  if (view === "monitors") renderMonitorList();
  try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
}
async function loadData(showErrors) {
  setStatus("Refreshing stored state…", false);
  if (showErrors !== false) $("loadError").hidden = true;
  try {
    const urls = [ENDPOINTS.report, ENDPOINTS.inventory, ENDPOINTS.history, ENDPOINTS.notifications, ENDPOINTS.config];
    const responses = await Promise.all(urls.map(url => fetch(bust(url), { cache: "no-store" }).catch(() => null)));
    if (!responses[0] || !responses[0].ok) throw new Error("Latest report is unavailable");
    if (!responses[1] || !responses[1].ok) throw new Error("Latest monitored URL inventory is unavailable");
    if (!responses[4] || !responses[4].ok) throw new Error("Source configuration is unavailable");
    state.report = await responses[0].json();
    state.inventory = await responses[1].json();
    state.history = responses[2] && responses[2].ok ? await responses[2].json() : [];
    state.notifications = responses[3] && responses[3].ok ? await responses[3].json() : {};
    state.config = await responses[4].json();
    const hash = location.hash.match(/monitor=([^&]+)/);
    if (hash && !state.selectedId) {
      const id = decodeURIComponent(hash[1]);
      const exists = Object.values(state.inventory.sources || {}).some(group => group && group[id]);
      if (exists) state.selectedId = id;
    }
    renderAll();
    setStatus("Connected to GitHub", false);
  } catch (error) {
    setStatus("Stored data unavailable", true);
    $("loadError").textContent = "Could not load dashboard data: " + String(error.message || error) +
      ". Check the GitHub Pages deployment or press Refresh data to retry.";
    $("loadError").hidden = false;
    if (!state.items.length) {
      $("monitorList").innerHTML = emptyState("Stored monitoring data unavailable",
        "The dashboard is online, but the report, source configuration, or URL inventory could not be fetched from GitHub.", "!");
    }
  }
}
function openAddMonitor() {
  const dialog = $("addMonitorDialog");
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    window.setTimeout(() => $("newMonitorUrl").focus(), 30);
  } else {
    showToast("This browser does not support the add-monitor dialog. Please use a current browser.");
  }
}
function makeGitHubIssueUrl(url, name) {
  const body = [
    "<!-- changesentinel:add-monitor:v1 -->",
    "",
    "Please register this URL as a ChangeSentinel monitor.",
    "",
    "URL: " + url,
    "Name: " + (name || ""),
    "",
    "This request was created from the ChangeSentinel dashboard."
  ].join("\n");
  const params = new URLSearchParams();
  params.set("title", "[ChangeSentinel] Add monitor request");
  params.set("body", body);
  return REPO + "/issues/new?" + params.toString();
}
function submitAddMonitor(event) {
  event.preventDefault();
  const rawUrl = $("newMonitorUrl").value.trim();
  const name = $("newMonitorName").value.replace(/[\r\n]+/g, " ").trim().slice(0, 100);
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (_) {
    $("newMonitorUrl").setCustomValidity("Enter a complete URL beginning with https:// or http://.");
    $("newMonitorUrl").reportValidity();
    return;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    $("newMonitorUrl").setCustomValidity("Use a public http:// or https:// page URL without a username or password.");
    $("newMonitorUrl").reportValidity();
    return;
  }
  $("newMonitorUrl").setCustomValidity("");
  parsed.hash = "";
  const url = parsed.toString();
  const target = makeGitHubIssueUrl(url, name);
  $("addMonitorDialog").close();
  $("newMonitorUrl").value = "";
  $("newMonitorName").value = "";
  showToast("Submit the prefilled request on GitHub. The URL is added to configuration and scanned after that request is accepted.");
  const githubWindow = window.open(target, "_blank");
  if (githubWindow) {
    try { githubWindow.opener = null; } catch (_) {}
  } else {
    window.location.href = target;
  }
}

$("monitorList").addEventListener("click", event => {
  const button = event.target.closest("[data-monitor-id]");
  if (button) setSelected(button.dataset.monitorId);
});
$("monitorSearch").addEventListener("input", renderMonitorList);
document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach(candidate => {
    candidate.classList.toggle("active", candidate === button);
    candidate.setAttribute("aria-pressed", candidate === button ? "true" : "false");
  });
  renderMonitorList();
}));
document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
$("detailTabs").addEventListener("click", event => {
  const button = event.target.closest("[data-detail-tab]");
  if (!button) return;
  state.detailTab = button.dataset.detailTab;
  renderDetailBody();
});
$("detailBody").addEventListener("click", event => {
  const button = event.target.closest("[data-snapshot-mode]");
  if (!button) return;
  state.snapshotMode = button.dataset.snapshotMode;
  const item = selectedItem();
  if (item && state.detailTab === "snapshot") loadSnapshot(item);
});
$("changeItems").addEventListener("click", event => {
  const button = event.target.closest("[data-event-url]");
  if (!button) return;
  const item = state.items.find(candidate => candidate.canonical_url === button.dataset.eventUrl);
  if (item) {
    setView("monitors");
    setSelected(item.url_id);
    state.detailTab = "changes";
    renderDetailBody();
  }
});
$("refreshBtn").addEventListener("click", () => loadData(true));
$("backToMonitors").addEventListener("click", () => setSelected(""));
$("addMonitorBtn").addEventListener("click", openAddMonitor);
$("closeAddMonitor").addEventListener("click", () => $("addMonitorDialog").close());
$("cancelAddMonitor").addEventListener("click", () => $("addMonitorDialog").close());
$("addMonitorDialog").addEventListener("click", event => {
  if (event.target === $("addMonitorDialog")) $("addMonitorDialog").close();
});
$("newMonitorUrl").addEventListener("input", () => $("newMonitorUrl").setCustomValidity(""));
$("addMonitorForm").addEventListener("submit", submitAddMonitor);

loadData(true);
window.setInterval(() => loadData(false), 120000);
