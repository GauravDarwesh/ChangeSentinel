/* ChangeSentinel dashboard helpers.
 *
 * Pure functions with no DOM access, shared by dashboard.js in the browser and
 * exercised directly by tests/test_dashboard_lib.py through Node. Anything that
 * decides what a reviewer sees (diff markup, scan timing, event wording) lives
 * here so it can be tested without a browser.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CSLib = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  /* ---------- Scan schedule ---------- */

  const SCAN_INTERVAL_HOURS = 6;

  // The GitHub Actions schedule is 0 */6 * * * (UTC).
  function nextScheduledScan(reference = new Date()) {
    const next = new Date(Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate(),
      Math.floor(reference.getUTCHours() / SCAN_INTERVAL_HOURS) * SCAN_INTERVAL_HOURS,
      0, 0, 0
    ));
    while (next.getTime() <= reference.getTime()) next.setUTCHours(next.getUTCHours() + SCAN_INTERVAL_HOURS);
    return next;
  }

  // Where we are in the current six-hour cycle: 0 just after a scheduled slot,
  // approaching 1 just before the next one. Drives the scan dial's hand.
  function scanCycle(reference = new Date()) {
    const next = nextScheduledScan(reference);
    const periodMs = SCAN_INTERVAL_HOURS * 3600 * 1000;
    const start = new Date(next.getTime() - periodMs);
    const progress = Math.min(1, Math.max(0, (reference.getTime() - start.getTime()) / periodMs));
    const remainingMinutes = Math.max(0, Math.ceil((next.getTime() - reference.getTime()) / 60000));
    return { start, next, progress, remainingMinutes };
  }

  const PERIOD_MS = SCAN_INTERVAL_HOURS * 3600 * 1000;
  function slotStartOf(time) { return Math.floor(time / PERIOD_MS) * PERIOD_MS; }

  /* ---------- Per-monitor scan cadence ----------
   * Mirrors regmon/schedule.py, which decides what a scheduled run scans. The
   * dashboard uses it to describe a monitor's schedule, preview a new one and
   * build the settings request; health.json carries the engine's own answer
   * (next_due, overdue_after) for every monitor.
   */
  const SCAN_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const SCAN_BUSINESS_DAYS = SCAN_WEEKDAYS.slice(0, 5);
  const SCAN_INTERVALS = [6, 12, 24, 48, 72, 168];
  const SCAN_EVERY_WORDS = { 6: "Every 6 hours", 12: "Every 12 hours", 24: "Daily", 48: "Every 2 days", 72: "Every 3 days", 168: "Weekly" };
  // A source's cadence settings with defaults filled in.
  function scanSchedule(source) {
    const s = source || {};
    const every = SCAN_INTERVALS.indexOf(Number(s.check_every_hours)) >= 0 ? Number(s.check_every_hours) : 6;
    const picked = Array.isArray(s.check_days) && s.check_days.length ? SCAN_WEEKDAYS.filter(day => s.check_days.indexOf(day) >= 0) : SCAN_WEEKDAYS.slice();
    const hours = Array.isArray(s.check_hours) && s.check_hours.length === 2 ? [Number(s.check_hours[0]), Number(s.check_hours[1])] : null;
    return { every, days: picked.length ? picked : SCAN_WEEKDAYS.slice(), hours, timezone: String(s.check_timezone || "") || "UTC" };
  }
  function scanScheduleIsDefault(schedule) {
    const c = schedule || {};
    return c.every === 6 && (c.days || []).length === 7 && !c.hours;
  }
  // The same words as Cadence.describe(): "Daily, weekdays, 08:00–18:00 America/Sao_Paulo".
  function scanScheduleLabel(schedule) {
    const c = schedule || scanSchedule({});
    let words = SCAN_EVERY_WORDS[c.every] || "Every " + c.every + " hours";
    const days = c.days || SCAN_WEEKDAYS;
    if (days.join() === SCAN_BUSINESS_DAYS.join()) words += ", weekdays";
    else if (days.length !== 7) words += ", " + days.map(day => day.charAt(0).toUpperCase() + day.slice(1)).join("/");
    const pad = n => String(n).padStart(2, "0");
    if (c.hours) words += ", " + pad(c.hours[0]) + ":00\u2013" + pad(c.hours[1]) + ":00";
    if ((days.length !== 7 || c.hours) && c.timezone && c.timezone !== "UTC") words += " " + c.timezone;
    else if (c.hours) words += " UTC";
    return words;
  }
  // Weekday ("mon") and hour of a moment in a time zone.
  function zonedParts(time, zone) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone || "UTC", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(time));
      const get = type => (parts.find(part => part.type === type) || {}).value || "";
      return { day: get("weekday").slice(0, 3).toLowerCase(), hour: Number(get("hour")) % 24 };
    } catch (_) {
      const d = new Date(time);
      return { day: SCAN_WEEKDAYS[(d.getUTCDay() + 6) % 7], hour: d.getUTCHours() };
    }
  }
  function scanAllows(schedule, slot) {
    const local = zonedParts(slot, schedule.timezone);
    if ((schedule.days || SCAN_WEEKDAYS).indexOf(local.day) < 0) return false;
    return !schedule.hours || (local.hour >= schedule.hours[0] && local.hour < schedule.hours[1]);
  }
  // Whether a run in `slot` scans the monitor (regmon.schedule.is_due).
  function scanIsDue(schedule, lastScan, slot) {
    if (lastScan == null) return true;
    if (!scanAllows(schedule, slot)) return false;
    if (schedule.every === 6) return true;
    return slot >= lastScan + (schedule.every - 3) * 3600000;
  }
  // The slots in the next `days` days that would scan the monitor, assuming
  // each run starts on time. Used for the week preview in the schedule dialog.
  function scanSlots(schedule, from, days = 7, lastScan = null) {
    const start = slotStartOf(typeof from === "number" ? from : new Date(from || Date.now()).getTime()) + PERIOD_MS;
    const out = [];
    let last = lastScan;
    for (let i = 0; i < days * 24 / SCAN_INTERVAL_HOURS; i++) {
      const slot = start + i * PERIOD_MS;
      // With no last scan (a preview of a new schedule) the window still applies.
      const due = last == null ? scanAllows(schedule, slot) : slot > slotStartOf(last) && scanIsDue(schedule, last, slot);
      out.push({ at: slot, due });
      if (due) last = slot;
    }
    return out;
  }
  // The settings request body: unset what equals the default, set the rest.
  function scanSchedulePayload(ids, schedule) {
    const c = schedule || {};
    const set = {}, clear = [];
    if (c.every === 6) clear.push("check_every_hours"); else set.check_every_hours = c.every;
    if ((c.days || []).length === 7) clear.push("check_days"); else set.check_days = c.days.slice();
    if (c.hours) set.check_hours = [c.hours[0], c.hours[1]]; else clear.push("check_hours");
    if ((c.hours || (c.days || []).length !== 7) && c.timezone && c.timezone !== "UTC") set.check_timezone = c.timezone; else clear.push("check_timezone");
    return { monitors: Array.from(new Set(ids || [])), set, clear };
  }
  const SETTINGS_MARKER = "<!-- changesentinel:update-monitors:v1 -->";
  // A prefilled "[ChangeSentinel] Update monitors" issue, split so each stays
  // well inside the length GitHub accepts in a new-issue address.
  function settingsRequests(payload, describe, perRequest = 120) {
    const ids = (payload && payload.monitors) || [];
    const out = [];
    for (let i = 0; i < ids.length; i += perRequest) {
      const part = Object.assign({}, payload, { monitors: ids.slice(i, i + perRequest) });
      const body = [SETTINGS_MARKER, "", "Please apply these monitor settings in ChangeSentinel.", "", describe ? "Change: " + describe : "", "", "SETTINGS_JSON:", JSON.stringify(part), "", "This request was created from the ChangeSentinel dashboard."].join("\n");
      out.push({ title: "[ChangeSentinel] Update monitors (" + part.monitors.length + ")", body, count: part.monitors.length });
    }
    return out;
  }

  /* ---------- Workspaces, labels and settings presets ----------
   * A monitor's workspace is the one set in config/sources.json, or else the
   * region of its regulator (marked auto). Labels are free tags. Both group
   * and filter the dashboard; neither changes what is detected.
   */
  const LABEL_MAX = 12;
  const TAG_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}_ &/+.\-]*[\p{L}\p{N}])?$/u;
  function validTag(text) { const t = String(text || "").trim(); return t.length > 0 && t.length <= 40 && TAG_RE.test(t) && t.indexOf("  ") < 0; }
  function parseLabels(text) {
    const out = [];
    String(text || "").split(",").map(part => part.trim()).filter(Boolean).forEach(label => {
      if (!out.some(existing => existing.toLowerCase() === label.toLowerCase())) out.push(label);
    });
    return out;
  }
  function workspaceOf(source, region) {
    const own = String((source && source.workspace) || "").trim();
    if (own) return { name: own, auto: false };
    return region ? { name: region, auto: true } : { name: "Other", auto: true };
  }
  function labelsOf(source) { return Array.isArray(source && source.labels) ? source.labels.filter(Boolean) : []; }
  // scope: { workspace: "ALL" | name, label: "ALL" | name }
  function scopeMatches(scope, workspace, labels) {
    const s = scope || {};
    if (s.workspace && s.workspace !== "ALL" && (workspace || {}).name !== s.workspace) return false;
    if (s.label && s.label !== "ALL" && !(labels || []).some(label => label.toLowerCase() === String(s.label).toLowerCase())) return false;
    return true;
  }
  function organisePayload(ids, change) {
    const c = change || {};
    const payload = { monitors: Array.from(new Set(ids || [])), set: {}, clear: [] };
    if (c.clearWorkspace) payload.clear.push("workspace");
    else if (c.workspace) payload.set.workspace = String(c.workspace).trim();
    const add = parseLabels((c.add || []).join(",")), remove = parseLabels((c.remove || []).join(","));
    if (add.length) payload.add_labels = add;
    if (remove.length) payload.remove_labels = remove.filter(label => !add.some(other => other.toLowerCase() === label.toLowerCase()));
    if (payload.remove_labels && !payload.remove_labels.length) delete payload.remove_labels;
    if (c.shadow === true) payload.set.shadow = true;
    else if (c.shadow === false) payload.clear.push("shadow");
    return payload;
  }
  function payloadIsEmpty(payload) {
    const p = payload || {};
    return !Object.keys(p.set || {}).length && !(p.clear || []).length && !(p.add_labels || []).length && !(p.remove_labels || []).length;
  }
  // Built-in presets shaped like a regulatory reporting team's monitors.
  const SETTINGS_PRESETS = [
    { id: "release", name: "Release notes and update pages", note: "Every 6 hours, every day. For pages that announce new forms, versions and errata.", schedule: { check_every_hours: 6 } },
    { id: "spec", name: "Specifications and user guides", note: "Daily on weekdays. Technical specs, layouts, taxonomies and validation rules change by planned release.", schedule: { check_every_hours: 24, check_days: SCAN_BUSINESS_DAYS }, labels: ["Specs"] },
    // Every scan slot inside the window. Scans start every six hours, so a
    // ten-hour window holds one or two slots, six hours apart; a 12-hour
    // cadence would need nine hours between scans and always scan once a day.
    { id: "office", name: "Regulator business hours", note: "Weekdays, every scan between 08:00 and 18:00 in the regulator's time zone (once or twice a day).", schedule: { check_every_hours: 6, check_days: SCAN_BUSINESS_DAYS, check_hours: [8, 18] }, zoned: true },
    { id: "archive", name: "Annual and archived documents", note: "Weekly. Year-stamped lists, historical instructions and pages that rarely move.", schedule: { check_every_hours: 168 }, labels: ["Archive"] },
    { id: "copy", name: "Copy from another monitor", note: "Its scan schedule, workspace and labels.", copy: true }
  ];
  function presetPayload(ids, preset, options = {}) {
    const p = preset || {};
    if (p.copy) {
      const from = options.from || {};
      const schedule = scanSchedulePayload(ids, scanSchedule(from));
      const own = String(from.workspace || "").trim();
      if (own) schedule.set.workspace = own;
      const labels = labelsOf(from);
      if (labels.length) schedule.add_labels = labels.slice();
      return schedule;
    }
    const schedule = scanSchedule(Object.assign({}, p.schedule, p.zoned && options.timezone ? { check_timezone: options.timezone } : {}));
    const payload = scanSchedulePayload(ids, schedule);
    if (p.labels && p.labels.length) payload.add_labels = p.labels.slice();
    return payload;
  }

  /* ---------- Importing from another monitoring tool ----------
   * A spreadsheet export (Visualping or any similar tool) becomes monitor
   * requests. Columns are found by their header; nothing about the file is
   * sent anywhere until the owner submits the prefilled requests.
   */
  const IMPORT_ALIASES = {
    url: ["url", "urls", "link", "links", "website", "website url", "webpage", "web page", "page url", "page", "address", "monitored url", "target url", "job url"],
    name: ["name", "display name", "title", "monitor name", "description", "job name", "page name", "page title"],
    include_selector: ["include selector", "include css selector", "selector", "css selector"],
    ignore_selectors: ["ignore selectors", "ignore css selectors"],
    workspace: ["workspace", "workspace name", "folder", "project", "group", "team"],
    labels: ["labels", "label", "tags", "tag"],
    frequency: ["frequency", "check frequency", "interval", "check interval", "schedule", "checks every", "check every"],
    status: ["status", "active", "state", "paused", "job status"],
    condition: ["alert me when", "ai condition", "alert condition", "condition", "ai alert"]
  };
  function importHeaderKey(value) {
    return String(value || "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]+/g, " ").replace(/[()]/g, "").trim();
  }
  function importColumns(header) {
    const keys = (header || []).map(importHeaderKey);
    const out = {};
    Object.keys(IMPORT_ALIASES).forEach(field => { out[field] = keys.findIndex(key => IMPORT_ALIASES[field].indexOf(key) >= 0); });
    return out;
  }
  // "Every 12 hours", "Daily", "1 week", "720" (minutes) -> the nearest
  // ChangeSentinel cadence that is not more frequent than every 6 hours.
  function importFrequencyHours(text) {
    const raw = String(text == null ? "" : text).trim().toLowerCase();
    if (!raw) return null;
    let hours = null;
    if (/^\d+(\.\d+)?$/.test(raw)) hours = Number(raw) / 60;
    else if (/hourly/.test(raw)) hours = 1;
    else if (/twice a day|twice daily/.test(raw)) hours = 12;
    else if (/daily|every day|once a day/.test(raw)) hours = 24;
    else if (/weekly|every week|once a week/.test(raw)) hours = 168;
    else if (/monthly|every month/.test(raw)) hours = 720;
    else {
      const match = raw.match(/(\d+(?:\.\d+)?)\s*(min|minute|h|hr|hour|d|day|w|wk|week|month)/);
      if (match) hours = Number(match[1]) * ({ min: 1 / 60, minute: 1 / 60, h: 1, hr: 1, hour: 1, d: 24, day: 24, w: 168, wk: 168, week: 168, month: 720 }[match[2]] || 1);
      else if (/every\s+(hour|day|week)/.test(raw)) hours = { hour: 1, day: 24, week: 168 }[raw.match(/every\s+(hour|day|week)/)[1]];
    }
    if (!Number.isFinite(hours) || hours <= 0) return null;
    const fit = SCAN_INTERVALS.filter(interval => interval >= hours * 0.9)[0];
    return fit || SCAN_INTERVALS[SCAN_INTERVALS.length - 1];
  }
  // A "Status" or "Active" column says what is running ("No" = paused); a
  // "Paused" column says the opposite ("Yes" = paused).
  function importIsPaused(text, pausedColumn) {
    const raw = String(text == null ? "" : text).trim().toLowerCase();
    if (pausedColumn) return /^(paused|yes|y|true|1)$/.test(raw);
    return /^(paused|inactive|disabled|stopped|off|no|false|archived)$/.test(raw);
  }
  // matrix: rows of cells, the first holding headers when a URL column is named.
  // known: Set of canonical URLs already monitored.
  function importRows(matrix, known, options = {}) {
    const blank = row => !row || row.every(cell => !String(cell == null ? "" : cell).trim());
    const rows = (matrix || []).map(row => Array.isArray(row) ? row.map(value => String(value == null ? "" : value).trim()) : []).filter(row => !blank(row));
    if (!rows.length) return { rows: [], errors: ["The spreadsheet has no link rows."], skipped: { existing: [], paused: [] }, columns: {}, header: false, conditions: 0 };
    let columns = importColumns(rows[0]);
    const header = columns.url >= 0;
    const pausedColumn = header && columns.status >= 0 && importHeaderKey(rows[0][columns.status]) === "paused";
    if (header) rows.shift();
    else columns = { url: 0, name: 1, include_selector: 2, ignore_selectors: 3, workspace: -1, labels: -1, frequency: -1, status: -1, condition: -1 };
    const out = [], errors = [], existing = [], paused = [];
    const seen = new Map();
    let conditions = 0;
    rows.forEach((row, index) => {
      const number = index + (header ? 2 : 1);
      const cell = column => column >= 0 && column < row.length ? row[column] : "";
      const rawUrl = cell(columns.url);
      if (!rawUrl) { errors.push("Row " + number + ": missing URL."); return; }
      let url;
      try {
        const candidate = new URL(rawUrl);
        if (["http:", "https:"].indexOf(candidate.protocol) < 0 || !candidate.hostname || candidate.username || candidate.password) throw new Error();
        url = canonicalUrl(candidate.toString());
      } catch (_) { errors.push("Row " + number + ": enter a complete public http:// or https:// URL."); return; }
      const name = cell(columns.name).replace(/[\r\n]+/g, " ").trim().slice(0, 100);
      if (importIsPaused(cell(columns.status), pausedColumn) && !options.includePaused) { paused.push({ url, name, row: number }); return; }
      if (known && known.has(url)) { existing.push({ url, name, row: number }); return; }
      const includeSelector = cell(columns.include_selector).trim();
      const rawIgnore = cell(columns.ignore_selectors);
      const ignoreSelectors = rawIgnore ? rawIgnore.split(/[;\r\n]+/).map(value => value.trim()).filter(Boolean) : [];
      if (includeSelector.length > 500) errors.push("Row " + number + ": include selector exceeds 500 characters.");
      if (ignoreSelectors.length > 20 || ignoreSelectors.some(value => value.length > 500)) errors.push("Row " + number + ": use at most 20 ignore selectors, each at most 500 characters.");
      const previous = seen.get(url);
      if (previous) {
        if (previous.include_selector !== includeSelector || previous.ignore_selectors.join("\n") !== ignoreSelectors.join("\n")) errors.push("Row " + number + ": duplicate URL has different selectors from an earlier row.");
        return;
      }
      const item = { url, name, include_selector: includeSelector, ignore_selectors: ignoreSelectors };
      const workspace = cell(columns.workspace).trim();
      if (workspace && !validTag(workspace)) { errors.push("Row " + number + ": workspace \u201c" + workspace + "\u201d has characters that can't be used."); return; }
      if (workspace) item.workspace = workspace;
      const labels = parseLabels(cell(columns.labels).replace(/[;|]/g, ","));
      const badLabels = labels.filter(label => !validTag(label));
      if (badLabels.length) { errors.push("Row " + number + ": labels with characters that can't be used: " + badLabels.join(", ")); return; }
      if (labels.length > LABEL_MAX) { errors.push("Row " + number + ": at most " + LABEL_MAX + " labels."); return; }
      if (labels.length) item.labels = labels;
      const every = importFrequencyHours(cell(columns.frequency));
      if (every && every !== 6) item.check_every_hours = every;
      if (cell(columns.condition)) conditions++;
      seen.set(url, item);
      out.push(item);
    });
    if (!out.length && !errors.length && !existing.length && !paused.length) errors.push("No valid URLs were found. Add a URL column or place one URL in the first column.");
    return { rows: out, errors, skipped: { existing, paused }, columns, header, conditions };
  }

  /* ---------- Shadow comparison with another tool ----------
   * Visualping (or any tool) alert history against ChangeSentinel's recorded
   * changes for the same pages and period. A pair matches when both saw the
   * same page change within `windowHours` of each other.
   *   other:   [{ url, at (ms), workspace? }]
   *   ours:    [{ url, at (ms), event_type, source_id }]
   *   monitored: Set of canonical URLs ChangeSentinel watches
   */
  function shadowCompare(other, ours, monitored, options = {}) {
    const windowMs = (Number(options.windowHours) || 36) * 3600000;
    const theirs = (other || []).filter(row => row && row.url && Number.isFinite(row.at)).map(row => Object.assign({}, row, { key: urlKey(row.url) }));
    if (!theirs.length) return null;
    const from = Math.min(...theirs.map(row => row.at)) - windowMs, to = Math.max(...theirs.map(row => row.at)) + windowMs;
    const mine = (ours || []).filter(row => row && row.url && row.at >= from && row.at <= to).map(row => Object.assign({}, row, { key: urlKey(row.url), used: false }));
    const watched = new Set(Array.from(monitored || []).map(urlKey));
    const byKey = new Map();
    mine.forEach(row => { const list = byKey.get(row.key) || []; list.push(row); byKey.set(row.key, list); });
    const both = [], theirsOnly = [], notMonitored = [], repeats = [];
    theirs.sort((a, b) => a.at - b.at).forEach(row => {
      if (!watched.has(row.key)) { notMonitored.push(row); return; }
      const near = (byKey.get(row.key) || []).filter(entry => Math.abs(entry.at - row.at) <= windowMs)
        .sort((a, b) => Math.abs(a.at - row.at) - Math.abs(b.at - row.at));
      const candidates = near.filter(entry => !entry.used);
      if (candidates.length) { candidates[0].used = true; both.push({ theirs: row, ours: candidates[0], lagHours: (candidates[0].at - row.at) / 3600000 }); }
      // Another alert from the other tool for a change already matched is a
      // repeat, not a change ChangeSentinel missed.
      else if (near.length) repeats.push({ theirs: row, ours: near[0] });
      else theirsOnly.push(row);
    });
    const oursOnly = mine.filter(row => !row.used && watched.has(row.key));
    // Several alerts from the other tool for one change of ours are counted once.
    const pagesTheirs = new Set(theirs.filter(row => watched.has(row.key)).map(row => row.key));
    const lags = both.map(pair => pair.lagHours).sort((a, b) => a - b);
    return {
      period: { from: from + windowMs, to: to - windowMs },
      totals: { theirs: theirs.length, ours: mine.length, both: both.length, theirsOnly: theirsOnly.length, oursOnly: oursOnly.length, notMonitored: notMonitored.length, repeats: repeats.length,
        pagesTheirs: pagesTheirs.size, pagesNotMonitored: new Set(notMonitored.map(row => row.key)).size },
      medianLagHours: lags.length ? lags[Math.floor(lags.length / 2)] : null,
      both, theirsOnly, oursOnly, notMonitored, repeats
    };
  }
  // Rows of an alert-history export: a URL column and a date/time column.
  const SHADOW_TIME_ALIASES = ["date", "time", "timestamp", "datetime", "date time", "created", "created at", "detected", "detected at", "alert date", "alert time", "changed at", "change date", "sent at", "triggered at", "date sent", "notification date"];
  function shadowRows(matrix) {
    const rows = (matrix || []).filter(row => Array.isArray(row) && row.some(cell => String(cell == null ? "" : cell).trim()));
    if (rows.length < 2) return { rows: [], error: "The file needs a header row and at least one alert." };
    const keys = rows[0].map(importHeaderKey);
    const urlCol = keys.findIndex(key => IMPORT_ALIASES.url.indexOf(key) >= 0);
    const timeCol = keys.findIndex(key => SHADOW_TIME_ALIASES.indexOf(key) >= 0);
    const wsCol = keys.findIndex(key => IMPORT_ALIASES.workspace.indexOf(key) >= 0);
    if (urlCol < 0 || timeCol < 0) return { rows: [], error: "Couldn't find " + [urlCol < 0 ? "a URL column" : "", timeCol < 0 ? "a date or time column" : ""].filter(Boolean).join(" or ") + " in the header row." };
    const out = [];
    let unreadable = 0;
    rows.slice(1).forEach(row => {
      const url = String(row[urlCol] || "").trim();
      const raw = row[timeCol];
      let at = typeof raw === "number" ? Math.round((raw - 25569) * 86400000) : Date.parse(String(raw || "").trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2"));
      if (!url || !Number.isFinite(at)) { unreadable++; return; }
      let canonical;
      try { canonical = canonicalUrl(new URL(url).toString()); } catch (_) { unreadable++; return; }
      out.push({ url: canonical, at, workspace: wsCol >= 0 ? String(row[wsCol] || "").trim() : "" });
    });
    return { rows: out, unreadable, error: out.length ? "" : "No alert rows had both a URL and a readable date." };
  }

  /* ---------- Scan columns ---------- */

  // What started a run: "scheduled", "manual", "continuation" (a paused crawl
  // re-dispatching itself) or "unknown" for history written before runs
  // recorded it.
  function normalizeTrigger(value) {
    const raw = String(value || "").toLowerCase();
    if (raw === "schedule" || raw === "scheduled") return "scheduled";
    if (raw === "workflow_dispatch" || raw === "manual") return "manual";
    if (raw === "continuation") return "continuation";
    return raw ? "manual" : "";
  }
  // A GitHub Actions run, as returned by the workflow runs API.
  function workflowRunTrigger(run) {
    if (!run) return "";
    if (run.event === "schedule") return "scheduled";
    const actor = String(run.triggering_actor || run.actor || "");
    if (run.event === "workflow_dispatch" && actor === "github-actions[bot]") return "continuation";
    return run.event ? "manual" : "";
  }
  function runTime(run, key) {
    const t = Date.parse(run && run[key]);
    return Number.isNaN(t) ? null : t;
  }
  // The Actions run that produced a saved scan: by id when the scan recorded
  // it, otherwise the run whose lifetime contains the scan's save time.
  function matchWorkflowRun(column, runs) {
    if (column.workflowRunId) {
      const byId = runs.find(run => String(run.id) === String(column.workflowRunId));
      if (byId) return byId;
    }
    let best = null;
    runs.forEach(run => {
      const started = runTime(run, "run_started_at") ?? runTime(run, "created_at");
      const ended = runTime(run, "updated_at");
      if (started === null || ended === null) return;
      if (column.at < started - 60000 || column.at > ended + 180000) return;
      if (!best || started > (runTime(best, "run_started_at") ?? runTime(best, "created_at"))) best = run;
    });
    return best;
  }

  // One column per saved scan, oldest first. A scan covers every source that
  // ran under the same run id. Scheduled and manual scans each get their own
  // column, so a manual run shows up the moment its results are saved.
  //   at       when the scan's results were saved (ms)
  //   prevAt   the previous scan's save time; events in (prevAt, at] belong here
  //   sources  { source_id: saved at (ms) }
  //   trigger  scheduled | manual | continuation | unknown
  //   slot     start of the six-hour schedule slot the scan ran in
  function runColumns(history, options = {}) {
    const workflowRuns = Array.isArray(options.workflowRuns) ? options.workflowRuns : [];
    const byId = new Map();
    (Array.isArray(history) ? history : []).forEach(entry => {
      if (!entry || !entry.generated_at) return;
      const t = Date.parse(entry.generated_at);
      if (Number.isNaN(t)) return;
      const id = String(entry.run_id || entry.generated_at);
      let column = byId.get(id);
      if (!column) {
        column = { id, at: t, sources: {}, trigger: "", workflowRunId: null, htmlUrl: "" };
        byId.set(id, column);
      }
      column.at = Math.max(column.at, t);
      if (entry.source_id) column.sources[entry.source_id] = Math.max(column.sources[entry.source_id] || 0, t);
      if (entry.trigger && !column.trigger) column.trigger = normalizeTrigger(entry.trigger);
      if (entry.workflow_run_id && !column.workflowRunId) column.workflowRunId = String(entry.workflow_run_id);
    });
    const columns = Array.from(byId.values()).sort((a, b) => a.at - b.at);
    columns.forEach((column, index) => {
      const run = matchWorkflowRun(column, workflowRuns);
      if (run) {
        if (!column.trigger) column.trigger = workflowRunTrigger(run);
        if (!column.workflowRunId && run.id) column.workflowRunId = String(run.id);
        column.htmlUrl = run.html_url || "";
      }
      if (!column.trigger) column.trigger = "unknown";
      column.prevAt = index ? columns[index - 1].at : column.at - PERIOD_MS;
      column.slot = slotStartOf(column.at);
    });
    const limit = Number(options.limit) || 0;
    return limit > 0 && columns.length > limit ? columns.slice(-limit) : columns;
  }

  // One column per six-hour schedule slot that saved at least one scan, oldest
  // first. Manual runs and crawl continuations land in the slot they ran in
  // instead of adding a column of their own, so a one-source run can't leave a
  // hole in every other row, and each column means the same span of time.
  //   start, end  the slot's window [start, end)
  //   at          the last save in the slot
  //   sources     { source_id: last save in the slot (ms) }
  //   scans       the saved scans (runColumns entries) in the slot
  //   trigger     scheduled if the slot's scheduled scan ran, else manual/continuation
  //   manual      number of manual scans in the slot
  function slotColumns(history, options = {}) {
    const runs = runColumns(history, { workflowRuns: options.workflowRuns });
    const bySlot = new Map();
    runs.forEach(run => {
      let column = bySlot.get(run.slot);
      if (!column) {
        column = { id: "slot-" + run.slot, slot: run.slot, start: run.slot, end: run.slot + PERIOD_MS, at: run.at, sources: {}, scans: [], trigger: "", manual: 0, htmlUrl: "" };
        bySlot.set(run.slot, column);
      }
      column.scans.push(run);
      column.at = Math.max(column.at, run.at);
      Object.keys(run.sources).forEach(id => { column.sources[id] = Math.max(column.sources[id] || 0, run.sources[id]); });
      if (run.trigger === "manual") column.manual++;
      if (run.htmlUrl) column.htmlUrl = run.htmlUrl;
    });
    const columns = Array.from(bySlot.values()).sort((a, b) => a.slot - b.slot);
    columns.forEach(column => {
      const triggers = column.scans.map(run => run.trigger);
      column.trigger = triggers.some(t => t === "scheduled" || t === "unknown") ? "scheduled"
        : triggers.indexOf("manual") >= 0 ? "manual" : "continuation";
    });
    const limit = Number(options.limit) || 0;
    return limit > 0 && columns.length > limit ? columns.slice(-limit) : columns;
  }

  const CONTENT_CHANGE_TYPES = ["CHANGED_URL", "REMOVED_URL"];

  // One LED in the change field: what happened to one page in one column.
  //   "on"      the page's extracted text changed (or it disappeared)
  //   "new"     the page was first saved in this column
  //   "bad"     a scan could not fetch or read the page
  //   "markup"  the HTML changed but the extracted text is identical; drawn
  //             like "dim" because nothing a reader cares about changed
  //   "dim"     the page was scanned and nothing changed
  //   "skip"    the page was monitored but no scan in this window covered it
  //   "none"    nothing to draw: the page wasn't monitored yet, is still
  //             waiting for its first scan, or no scan in the column covered it
  // Columns from slotColumns carry a [start, end) window; columns from
  // runColumns use (prevAt, at].
  function columnCellState(column, page) {
    const windowed = Number.isFinite(column.start) && Number.isFinite(column.end);
    const lo = windowed ? column.start : column.prevAt;
    const hi = windowed ? column.end : column.at;
    const inColumn = time => {
      const t = typeof time === "number" ? time : Date.parse(time);
      if (Number.isNaN(t)) return false;
      return windowed ? t >= lo && t < hi : t > lo && t <= hi;
    };
    // A page still waiting for its first scan (its crawl hasn't finished) has no history yet.
    if (page.pending) return "none";
    const firstSeen = page.firstSeen ? Date.parse(page.firstSeen) : NaN;
    const known = !Number.isNaN(firstSeen);
    // Before the page was first saved: nothing to show.
    if (known && (windowed ? firstSeen >= hi : firstSeen > hi + 1000)) return "none";
    const events = (page.events || []).filter(event => inColumn(event.timestamp));
    if (events.some(event => event.event_type === "FETCH_ERROR" || event.event_type === "EXTRACTION_ERROR")) return "bad";
    if (page.problemAt && inColumn(page.problemAt)) return "bad";
    // first_seen is the page's first save, whether or not the first run was a
    // quiet baseline (which suppresses NEW_URL). The column holding it is green.
    if (known && (windowed ? inColumn(firstSeen) : firstSeen > lo)) return "new";
    if (events.some(event => event.event_type === "NEW_URL")) return "new";
    // Monitored, but no scan in this window reached its source (a missed or late
    // scheduled scan): a placeholder keeps the row continuous instead of a hole.
    if (!column.sources[page.sourceId]) return known && windowed ? "skip" : "none";
    if (events.some(event => CONTENT_CHANGE_TYPES.indexOf(event.event_type) >= 0)) return "on";
    if (events.some(event => event.event_type === "HTML_SOURCE_CHANGED")) return "markup";
    return "dim";
  }

  /* ---------- Change field: lenses, ranges and summary rows ----------
   * The field can't give every page its own row forever: at a few hundred pages
   * the rows that matter (a change, a problem) drown in rows where nothing
   * happened. So the default lens keeps a row for each page that changed or
   * failed in the displayed range, and folds the rest into one summary row per
   * kind ("New pages", "No change") whose lights are the strongest state of
   * any member in that column. A summary row opens in place to list its pages.
   */
  const FIELD_RANGES = { "2d": 2, "7d": 7, "30d": 30, all: 0 };
  const FIELD_LENSES = ["activity", "changed", "problems", "new", "all"];
  const STATE_RANK = { bad: 6, on: 5, new: 4, markup: 3, dim: 2, skip: 1, none: 0 };

  // The columns inside a range ending now; "all" keeps every saved column.
  function fieldWindow(columns, range, reference) {
    const list = Array.isArray(columns) ? columns.slice() : [];
    const days = FIELD_RANGES[range];
    if (!days) return list;
    const now = reference instanceof Date ? reference.getTime() : Number(reference || Date.now());
    const from = now - days * 86400000;
    return list.filter(column => (Number.isFinite(column.end) ? column.end : column.at) > from);
  }

  // One light standing for several pages: the most important thing that happened to any of them.
  function mergeCellStates(states) {
    let best = "none";
    (states || []).forEach(state => { if ((STATE_RANK[state] || 0) > STATE_RANK[best]) best = state; });
    return best;
  }

  // What one page's row amounts to over the displayed columns.
  function rowActivity(states) {
    const list = Array.isArray(states) ? states : [];
    let changed = 0, problems = 0, fresh = 0, scanned = 0, last = -1;
    list.forEach((state, index) => {
      if (state === "on") { changed += 1; last = index; }
      else if (state === "bad") { problems += 1; last = index; }
      else if (state === "new") { fresh += 1; last = Math.max(last, index); }
      if (state !== "none") scanned += 1;
    });
    const kind = problems ? "problem" : changed ? "changed" : fresh ? "new" : scanned ? "quiet" : "unscanned";
    return { kind, changed, problems, fresh, last };
  }

  function fieldCounts(pages) {
    const counts = { activity: 0, changed: 0, problems: 0, new: 0, quiet: 0, waiting: 0, all: 0 };
    (pages || []).forEach(page => {
      const a = page.activity || rowActivity(page.states);
      counts.all += 1;
      if (a.changed) counts.changed += 1;
      if (a.problems) counts.problems += 1;
      if (a.changed || a.problems) counts.activity += 1;
      else if (a.kind === "new") counts.new += 1;
      else if (a.kind === "quiet") counts.quiet += 1;
      else counts.waiting += 1;
    });
    return counts;
  }

  function fieldMatches(page, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    return [page.title, page.url, page.sourceLabel].join(" ").toLowerCase().indexOf(q) >= 0;
  }

  // The rows the field draws, in order. Each is one of
  //   { type: "section", key, label, note, count, states, open, counts }   a regulator (or other) heading
  //   { type: "page", page, member }            a page's own lights (member: inside an open summary)
  //   { type: "group", key, label, count, states, open, kind }   a summary row
  //   { type: "more", key, hidden }             one "show more" for a section whose pages ran past its limit
  // options: lens (FIELD_LENSES); query; groupBy ("none" or anything the pages carry a
  // groupKey for); open (summary keys opened); closed (section and source keys closed);
  // limit (page rows per section); limits ({ sectionKey: page rows } raised by "show more").
  function fieldRows(pages, options = {}) {
    const lens = FIELD_LENSES.indexOf(options.lens) >= 0 ? options.lens : "activity";
    const open = options.open instanceof Set ? options.open : new Set(options.open || []);
    const closed = options.closed instanceof Set ? options.closed : new Set(options.closed || []);
    const limits = options.limits || {};
    const grouped = !!options.groupBy && options.groupBy !== "none";
    const list = (pages || []).map(page => Object.assign({}, page, { activity: page.activity || rowActivity(page.states) }));
    const matching = list.filter(page => fieldMatches(page, options.query));
    const byTitle = (a, b) => String(a.title || "").localeCompare(String(b.title || ""));
    const byActivity = (a, b) => (b.activity.problems ? 1 : 0) - (a.activity.problems ? 1 : 0) ||
      b.activity.last - a.activity.last || (b.activity.changed + b.activity.problems) - (a.activity.changed + a.activity.problems) || byTitle(a, b);
    const merged = members => {
      const width = members.length ? members[0].states.length : 0;
      return Array.from({ length: width }, (_, x) => mergeCellStates(members.map(page => page.states[x])));
    };
    const rows = [];
    const flat = String(options.query || "").trim() || lens === "changed" || lens === "problems" || lens === "new";
    const keep = lens === "changed" ? page => page.activity.changed > 0
      : lens === "problems" ? page => page.activity.problems > 0
      : lens === "new" ? page => page.activity.kind === "new"
      : () => true;
    // Sections: one per regulator (or jurisdiction, kind, source), in name order with "Other" last.
    const sections = new Map();
    matching.forEach(page => {
      const key = grouped ? String(page.groupKey || "other") : "all";
      if (!sections.has(key)) sections.set(key, { key, label: grouped ? String(page.groupLabel || "Other") : "", note: grouped ? String(page.groupNote || "") : "", pages: [] });
      sections.get(key).pages.push(page);
    });
    const ordered = Array.from(sections.values()).sort((a, b) =>
      (a.key === "other") - (b.key === "other") || a.label.localeCompare(b.label));
    ordered.forEach(section => {
      const members = flat ? section.pages.filter(keep) : section.pages;
      if (!members.length) return;
      const sectionKey = "sec:" + section.key;
      let budget = Math.max(1, Number(limits[sectionKey]) || Number(options.limit) || 80);
      let hidden = 0;
      const pushPages = (list, member) => {
        list.forEach(page => {
          if (budget <= 0) { hidden += 1; return; }
          rows.push({ type: "page", page, member: !!member, section: section.key });
          budget -= 1;
        });
      };
      const summary = (key, label, group, kind) => {
        if (!group.length) return;
        const isOpen = kind === "source" ? !closed.has(key) : open.has(key);
        rows.push({ type: "group", key, label, count: group.length, states: merged(group), open: isOpen, kind, section: section.key, members: group });
        if (isOpen) pushPages(group.slice().sort(byTitle), true);
      };
      if (grouped) {
        const counts = fieldCounts(members);
        const isOpen = !closed.has(sectionKey);
        rows.push({ type: "section", key: sectionKey, label: section.label, note: section.note, count: members.length, states: merged(members), open: isOpen, counts, members });
        if (!isOpen) return;
      }
      const scope = grouped ? section.key + ":" : "";
      if (flat) {
        pushPages(members.slice().sort(byActivity), false);
      } else if (lens === "all") {
        if (grouped && options.groupBy !== "source") {
          pushPages(members.slice().sort(byTitle), false);
        } else {
          const bySource = new Map();
          members.forEach(page => {
            const key = String(page.sourceId || "");
            if (!bySource.has(key)) bySource.set(key, []);
            bySource.get(key).push(page);
          });
          Array.from(bySource.entries())
            .sort((a, b) => String(a[1][0].sourceLabel || a[0]).localeCompare(String(b[1][0].sourceLabel || b[0])))
            .forEach(([sourceId, group]) => {
              if (group.length === 1 || options.groupBy === "source") pushPages(group.slice().sort(byTitle), false);
              else summary("src:" + sourceId, group[0].sourceLabel || sourceId, group, "source");
            });
        }
      } else {
        pushPages(members.filter(page => page.activity.changed || page.activity.problems).sort(byActivity), false);
        summary(scope + "new", "New pages", members.filter(page => !page.activity.changed && !page.activity.problems && page.activity.kind === "new"), "new");
        summary(scope + "quiet", "No change", members.filter(page => page.activity.kind === "quiet"), "quiet");
        summary(scope + "waiting", "Not scanned yet", members.filter(page => page.activity.kind === "unscanned"), "waiting");
      }
      if (hidden) rows.push({ type: "more", key: sectionKey, hidden, section: section.key });
    });
    return { rows, lens, counts: fieldCounts(matching) };
  }

  /* ---------- Timeline ----------
   * The field answers "which page, which scan"; the timeline answers "what
   * happened, and when". Each event sits at its own time on its section's lane;
   * events too close to tell apart at the current zoom share a bead, and a
   * burst of new pages from one scan is told once in the story.
   */
  const TIMELINE_KINDS = ["bad", "on", "removed", "new", "markup"];
  const TIMELINE_LENS_KINDS = {
    activity: ["bad", "on", "removed", "new", "markup"], all: ["bad", "on", "removed", "new", "markup"],
    changed: ["on", "removed"], problems: ["bad"], new: ["new"], markup: ["markup"]
  };
  function timelineTopKind(kinds) {
    return TIMELINE_KINDS.find(kind => kinds[kind]) || "markup";
  }
  function timelineModel(entries, options = {}) {
    const start = Number(options.start), end = Number(options.end);
    const span = Math.max(1, end - start);
    // Events on one lane closer than this share a bead; further apart, each
    // keeps its own place, so two changes two days apart never merge.
    const gapMs = Number(options.gapMs) || Number(options.bucketMs) || PERIOD_MS;
    const allowed = TIMELINE_LENS_KINDS[options.lens] || TIMELINE_LENS_KINDS.activity;
    const burstMin = Number(options.burstMin) || 4;
    const inRange = (entries || []).filter(entry => entry && Number.isFinite(entry.at) && entry.at >= start && entry.at <= end && allowed.indexOf(entry.kind) >= 0);
    const counts = { bad: 0, on: 0, removed: 0, new: 0, markup: 0, total: inRange.length };
    const lanes = new Map();
    inRange.forEach(entry => {
      counts[entry.kind] = (counts[entry.kind] || 0) + 1;
      const key = String(entry.laneKey || "all");
      if (!lanes.has(key)) lanes.set(key, { key, label: String(entry.laneLabel || "All pages"), note: String(entry.laneNote || ""), badge: String(entry.laneBadge || entry.laneLabel || "All pages"), latest: 0, counts: { bad: 0, on: 0, removed: 0, new: 0, markup: 0 }, members: [] });
      const lane = lanes.get(key);
      lane.latest = Math.max(lane.latest, entry.at);
      lane.counts[entry.kind] += 1;
      lane.members.push(entry);
    });
    const beadOf = new Map();
    const weight = lane => (lane.counts.bad + lane.counts.on + lane.counts.removed) > 0 ? 1 : 0;
    const laneList = Array.from(lanes.values()).sort((a, b) => weight(b) - weight(a) || b.latest - a.latest || a.label.localeCompare(b.label)).map(lane => {
      const beads = [];
      lane.members.slice().sort((a, b) => a.at - b.at).forEach(entry => {
        let bead = beads[beads.length - 1];
        if (!bead || entry.at - bead.first >= gapMs) {
          bead = { key: lane.key + "|" + beads.length, first: entry.at, last: entry.at, sum: 0, count: 0, kinds: {}, ids: [] };
          beads.push(bead);
        }
        bead.last = entry.at;
        bead.sum += entry.at - start;
        bead.count += 1;
        bead.kinds[entry.kind] = (bead.kinds[entry.kind] || 0) + 1;
        bead.ids.push(entry.id);
        beadOf.set(entry.id, bead.key);
      });
      // Each bead also knows how long after the one before it on its lane it
      // came, which is what the timeline is for: when an update came, and
      // when the next one followed.
      beads.forEach((bead, index) => {
        bead.after = index ? bead.first - beads[index - 1].last : null;
        bead.at = start + bead.sum / bead.count;
        bead.x = Math.max(0, Math.min(1, (bead.at - start) / span));
        bead.top = timelineTopKind(bead.kinds);
        delete bead.sum;
      });
      return { key: lane.key, label: lane.label, note: lane.note, badge: lane.badge, latest: lane.latest, counts: lane.counts, beads };
    });
    // The story: newest first, one heading per local day. A scan that added
    // many pages to one lane is one expandable row, and markup-only edits that
    // repeat on a page through a day are one line.
    const sorted = inRange.slice().sort((a, b) => b.at - a.at || String(a.title || "").localeCompare(String(b.title || "")));
    const groupsOf = (kind, keyOf) => {
      const groups = new Map();
      sorted.forEach(entry => {
        if (entry.kind !== kind) return;
        const key = keyOf(entry);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      });
      return groups;
    };
    // With one lane per page, a scan's new pages still read as one burst per regulator.
    const burstKey = entry => String(entry.burstKey || entry.laneKey || "all") + "|" + Math.floor(entry.at / PERIOD_MS);
    const repeatKey = entry => String(entry.pageId || entry.id) + "|" + localIsoDate(new Date(entry.at));
    const bursts = groupsOf("new", burstKey);
    const repeats = groupsOf("markup", repeatKey);
    const keysOf = members => Array.from(new Set(members.map(member => beadOf.get(member.id))));
    const told = new Set();
    const rows = [];
    sorted.forEach(entry => {
      if (entry.kind === "new") {
        const key = burstKey(entry);
        const members = bursts.get(key);
        if (members.length >= burstMin) {
          if (told.has("n|" + key)) return;
          told.add("n|" + key);
          rows.push({ type: "burst", key: "burst|" + key, at: members[0].at, kind: "new", laneKey: entry.laneKey, laneLabel: entry.burstLabel || entry.laneLabel, count: members.length, members, beadKeys: keysOf(members) });
          return;
        }
      }
      if (entry.kind === "markup") {
        const key = repeatKey(entry);
        const members = repeats.get(key);
        if (members.length > 1) {
          if (told.has("m|" + key)) return;
          told.add("m|" + key);
          rows.push({ type: "event", key: "markup|" + key, at: entry.at, kind: "markup", entry, repeat: members.length, beadKeys: keysOf(members) });
          return;
        }
      }
      rows.push({ type: "event", key: "event|" + entry.id, at: entry.at, kind: entry.kind, entry, beadKeys: [beadOf.get(entry.id)] });
    });
    const days = [];
    rows.forEach(row => {
      const day = localIsoDate(new Date(row.at));
      if (!days.length || days[days.length - 1].day !== day) days.push({ day, at: row.at, rows: [] });
      days[days.length - 1].rows.push(row);
    });
    return { lanes: laneList, days, counts, gapMs, start, end };
  }
  // The time between two updates, short enough to sit on the line joining them.
  function timelineGapWords(ms) {
    const minutes = Math.max(1, Math.round(Number(ms) / 60000));
    if (!Number.isFinite(minutes)) return "";
    if (minutes < 60) return minutes + " min";
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours + " h";
    const days = Math.floor(hours / 24), rest = hours % 24;
    return days + " d" + (rest && days < 7 ? " " + rest + " h" : "");
  }

  /* ---------- Fleet health insights ----------
   * A short, ordered list of what stands out in data/health.json: problems
   * first, then what is about to need attention, then context. Each line
   * names its monitors so the view can link to them; nothing is guessed.
   */
  function healthInsights(health, options = {}) {
    const h = health || {};
    const monitors = Array.isArray(h.monitors) ? h.monitors : [];
    const daily = Array.isArray(h.daily) ? h.daily : [];
    const week = h.last_7_days || {};
    const quietAfter = Number((h.thresholds || {}).inactive_after_days) || 45;
    const nameOf = options.nameOf || (m => String(m.name || m.source_id));
    const dayOf = options.dayLabel || (d => String(d));
    const now = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
    const out = [];
    const names = list => {
      const shown = list.slice(0, 2).map(nameOf);
      return list.length > 2 ? shown.join(", ") + " and " + (list.length - 2) + " more" : shown.join(" and ");
    };
    const many = (n, one, other) => n + " " + (n === 1 ? one : other);
    const ids = list => list.map(m => String(m.source_id));
    const failing = monitors.filter(m => m.status === "failing");
    if (failing.length) out.push({ tone: "bad", key: "failing", targets: ids(failing), text: many(failing.length, "monitor is", "monitors are") + " failing now: " + names(failing) + ". Their last good copy stays as the baseline." });
    const protectedRows = Array.isArray(h.protected) ? h.protected : [];
    const retrying = monitors.filter(m => m.status === "protected");
    if (retrying.length) {
      const hosts = Array.from(new Set(protectedRows.map(row => { try { return new URL(String(row.url)).hostname; } catch (_) { return ""; } }).filter(Boolean)));
      const reason = (protectedRows[0] || {}).reason || "a " + ((protectedRows[0] || {}).vendor || "bot") + " bot check";
      out.push({ tone: "info", key: "retrying", targets: ids(retrying), text: many(retrying.length, "monitor is", "monitors are") + " blocked by " + reason +
        (hosts.length ? " on " + hosts.slice(0, 2).join(" and ") + (hosts.length > 2 ? " and " + (hosts.length - 2) + " more sites" : "") : "") +
        ". Each scan opens them in a browser to get past it; nothing to do unless it lasts a day." });
    }
    const recovered = monitors.filter(m => m.status !== "failing" && m.status !== "protected" && Number(m.failures_7d) > 0).sort((a, b) => b.failures_7d - a.failures_7d);
    if (recovered.length) {
      const total = recovered.reduce((sum, m) => sum + Number(m.failures_7d || 0), 0);
      out.push({ tone: "warn", key: "recovered", targets: ids(recovered), text: names(recovered) + (recovered.length === 1 ? " had " : " had ") + many(total, "failed check", "failed checks") + " this week and " + (recovered.length === 1 ? "is" : "are") + " working again." });
    }
    const failDays = daily.filter(d => Number(d.failed_checks) > 0);
    const failTotal = failDays.reduce((sum, d) => sum + Number(d.failed_checks || 0), 0);
    if (failTotal >= 3 && failDays.length) {
      const worst = failDays.slice().sort((a, b) => b.failed_checks - a.failed_checks)[0];
      if (worst.failed_checks / failTotal >= .8 && failDays.length <= 2) out.push({ tone: "info", key: "fail-day", day: worst.date, text: "Failures were concentrated on " + dayOf(worst.date) + " (" + worst.failed_checks + " of " + failTotal + "), not spread across the period." });
    }
    const stale = monitors.filter(m => m.status === "stale");
    // Overdue is judged against each monitor's own scan schedule (health.json
    // carries it); a weekly monitor scanned four days ago is on time.
    if (stale.length) out.push({ tone: "warn", key: "stale", targets: ids(stale), text: many(stale.length, "monitor is", "monitors are") + " overdue for a scan: " + names(stale) + "." });
    const quiet = monitors.filter(m => m.status === "inactive");
    if (quiet.length) out.push({ tone: "warn", key: "quiet", targets: ids(quiet), text: many(quiet.length, "monitor has", "monitors have") + " been quiet for " + quietAfter + "+ days. The page may have moved; check the regulator's site." });
    const soon = monitors.filter(m => m.status !== "inactive" && Number(m.days_without_change) >= quietAfter - 14 && Number(m.days_without_change) < quietAfter)
      .sort((a, b) => b.days_without_change - a.days_without_change);
    if (soon.length) out.push({ tone: "info", key: "soon-quiet", targets: ids(soon), text: many(soon.length, "monitor reaches", "monitors reach") + " the " + quietAfter + "-day quiet mark within two weeks: " + names(soon) + "." });
    const year = Array.isArray(h.year_bound) ? h.year_bound : [];
    if (year.length) out.push({ tone: "info", key: "year", targets: year.map(y => String(y.source_id)), text: many(year.length, "address carries", "addresses carry") + " a past year. Next year's list may be published at a new address." });
    const load = h.schedule_load || {};
    const mixes = Array.isArray(load.by_cadence) ? load.by_cadence : [];
    if (mixes.length > 1) {
      const slower = mixes.filter(mix => !/^Every 6 hours$/.test(mix.label)).reduce((sum, mix) => sum + Number(mix.monitors || 0), 0);
      if (slower) out.push({ tone: "info", key: "cadence", text: many(slower, "monitor is", "monitors are") + " on a slower scan schedule; the fleet runs about " + Math.round(Number(load.page_checks_per_day || 0)).toLocaleString() + " page checks a day." });
    }
    const changed = monitors.filter(m => m.last_change).sort((a, b) => new Date(b.last_change) - new Date(a.last_change));
    if (changed.length) {
      const latest = changed[0];
      const days = Math.max(0, Math.floor((now - new Date(latest.last_change).getTime()) / 86400000));
      out.push({ tone: "on", key: "latest-change", targets: [String(latest.source_id)], text: "Most recent content change: " + nameOf(latest) + ", " + (days === 0 ? "today" : days === 1 ? "yesterday" : days + " days ago") + "." + (changed.length > 1 ? " " + changed.length + " monitors have changed at least once." : "") });
    }
    const never = monitors.filter(m => !m.last_change);
    if (monitors.length && never.length / monitors.length >= .5) {
      const ages = never.map(m => Number(m.days_without_change) || 0).sort((a, b) => a - b);
      const median = ages[Math.floor(ages.length / 2)];
      out.push({ tone: "info", key: "never", text: never.length + " of " + monitors.length + " monitors haven't changed since they were added" + (median <= 1 ? "; most were added in the last day, so that is expected." : median <= 14 ? "; most are " + many(median, "day", "days") + " old, so that is expected." : ".") });
    }
    if (Number(week.checks) > 0 && !failing.length && !stale.length) {
      const scans = monitors.map(m => new Date(m.last_scan).getTime()).filter(Number.isFinite);
      const spread = scans.length ? (Math.max(...scans) - Math.min(...scans)) / 60000 : 0;
      out.push({ tone: "ok", key: "coverage", text: (mixes.length > 1 ? "Every monitor is on schedule" : "Every monitor was covered by the last scan" + (scans.length > 1 ? ", all within " + Math.max(1, Math.round(spread)) + " min of each other" : "")) + "; " + (Math.round(Number(week.success_rate || 0) * 1000) / 10) + "% of " + Number(week.checks).toLocaleString() + " checks succeeded this week." });
    }
    return out;
  }
  // The colour a monitor's light takes in the fleet matrix.
  /* ---------- A site showing a bot check ----------
   * The scan retries such a page in a browser and keeps its last good copy
   * (regmon/botcheck.py). For BOT_CHECK_GRACE_HOURS it is "retrying
   * automatically", not a failure; null when the page has no bot-check error.
   */
  const BOT_CHECK_GRACE_HOURS = 24;
  // A bare refusal ("AccessRefusedError: HTTP 403 refusal …") is handled the
  // same way when it covers a whole site; kind tells the two apart.
  function botCheckWait(item, now = Date.now(), graceHours = BOT_CHECK_GRACE_HOURS) {
    const message = String((item && item.fetch_error) || "");
    const refusal = /^AccessRefusedError:\s*HTTP (\d{3})/.exec(message);
    if (!refusal && !/^BotCheckError/.test(message)) return null;
    const vendorMatch = /^BotCheckError:\s*(.+?) bot check\b/.exec(message);
    const vendor = refusal ? "HTTP " + refusal[1] : vendorMatch ? vendorMatch[1] : "bot";
    const since = item.error_since ? new Date(item.error_since).getTime() : NaN;
    const hours = Number.isFinite(since) ? Math.max(0, (now - since) / 3600000) : null;
    return { kind: refusal ? "refusal" : "check", vendor, reason: refusal ? "an HTTP " + refusal[1] + " refusal" : "a " + vendor + " bot check",
      since: item.error_since || null, hours, waiting: hours === null || hours < graceHours, hasBaseline: !!item.normalized_hash };
  }

  function healthLight(monitor, now = Date.now()) {
    const m = monitor || {};
    if (m.status === "failing") return "bad";
    if (m.status === "protected") return "guard";
    if (m.status === "stale") return "stale";
    if (m.status === "inactive") return "quiet";
    if (m.last_change && (now - new Date(m.last_change).getTime()) <= 7 * 86400000) return "on";
    if (Number(m.failures_7d) > 0) return "warn";
    return "ok";
  }

  /* ---------- Who publishes a page ----------
   * Monitors added from the dashboard carry only their host name, so the field
   * groups pages by the regulator behind the host: config/regulators.json first,
   * then Scout's regulator profiles, then the country a public-sector domain
   * belongs to.
   */
  const JURISDICTION_SUFFIXES = [
    [/\.europa\.eu$/, "European Union", "EMEA"], [/\.gc\.ca$|\.ca$/, "Canada", "NAM"], [/\.gov\.uk$|\.co\.uk$|\.org\.uk$|\.uk$/, "United Kingdom", "EMEA"],
    [/\.gov\.au$|\.au$/, "Australia", "APAC"], [/\.gob\.mx$|\.mx$/, "Mexico", "LATAM"], [/\.gob\.ar$|\.ar$/, "Argentina", "LATAM"],
    [/\.bs$/, "Bahamas", "LATAM"], [/\.gov\.sg$|\.sg$/, "Singapore", "APAC"], [/\.gov\.hk$|\.hk$/, "Hong Kong", "APAC"],
    [/\.gov\.in$|\.in$/, "India", "APAC"], [/\.go\.jp$|\.jp$/, "Japan", "APAC"], [/\.de$/, "Germany", "EMEA"], [/\.fr$/, "France", "EMEA"],
    [/\.ie$/, "Ireland", "EMEA"], [/\.nl$/, "Netherlands", "EMEA"], [/\.ch$/, "Switzerland", "EMEA"], [/\.za$/, "South Africa", "EMEA"],
    [/\.gov$|\.mil$|\.fed\.us$|\.us$/, "United States", "NAM"]
  ];
  function hostOf(url) {
    try { return new URL(String(url || "")).hostname.toLowerCase().replace(/\.$/, ""); } catch (_) { return ""; }
  }
  function jurisdictionForHost(host) {
    const h = String(host || "").toLowerCase();
    const hit = JURISDICTION_SUFFIXES.find(([pattern]) => pattern.test(h));
    return hit ? { jurisdiction: hit[1], region: hit[2] } : { jurisdiction: "", region: "" };
  }
  // profiles: [{ id, name, short_name, jurisdiction, region, hosts: [...] }, ...] in priority order.
  function regulatorFor(url, profiles, fallbackName) {
    const host = hostOf(url);
    const bare = host.replace(/^www\d?\./, "");
    for (const profile of profiles || []) {
      const hosts = (profile && profile.hosts) || [];
      if (hosts.some(entry => {
        const candidate = String(entry || "").toLowerCase().replace(/^www\d?\./, "");
        return candidate && (bare === candidate || bare.endsWith("." + candidate));
      })) {
        const where = jurisdictionForHost(host);
        return { id: String(profile.id || bare), name: profile.name || profile.short_name || bare, short: profile.short_name || profile.name || bare,
          jurisdiction: profile.jurisdiction || where.jurisdiction, region: profile.region || where.region, known: true };
      }
    }
    const where = jurisdictionForHost(host);
    const named = fallbackName && !/^[\w.-]+\.[a-z]{2,}$/i.test(String(fallbackName).trim()) ? String(fallbackName).trim() : "";
    return { id: bare || "other", name: named || bare || "Other", short: named || bare || "Other", jurisdiction: where.jurisdiction, region: where.region, known: !!named };
  }

  // What kind of document a monitored page is, from its title and address.
  function pageKind(title, url, extractionType) {
    const text = String(title || "") + " " + String(url || "").toLowerCase().replace(/[-_/]+/g, " ");
    if (/\binstruction/i.test(text)) return "Instructions";
    if (/\bsample\b|\bexample\b/i.test(text)) return "Sample files";
    if (/technical spec|specification|taxonom|\bxsd\b|schema|validation rule|edit check/i.test(text)) return "Technical specifications";
    if (/\bfaq\b|q&a|questions and answers|frequently asked/i.test(text)) return "Q&A";
    if (/\btemplate|\bform\b|reporting form|\breturn\b|report form|\bschedule\b/i.test(text)) return "Forms and templates";
    if (/guid|guideline|manual|handbook|\bnotice|circular|\bletter/i.test(text)) return "Guidance and notices";
    const type = String(extractionType || "").toLowerCase();
    const path = String(url || "").toLowerCase();
    if (type === "xlsx" || type === "csv" || /\.(xlsx|xlsm|xls|csv)(\?|$)/.test(path)) return "Spreadsheets";
    if (type === "pdf" || /\.pdf(\?|$)/.test(path)) return "Other documents";
    if (type === "zip" || /\.zip(\?|$)/.test(path)) return "Bundles";
    return "Web pages";
  }

  const ACTIVE_RUN_STATUSES = ["queued", "in_progress", "waiting", "requested", "pending"];

  // The next scan, for the empty column at the end of the field and the
  // countdown. The schedule clock never stops: slots start at 00, 06, 12 and
  // 18 UTC. GitHub often starts a scheduled run hours into its slot, so until
  // that run is saved the slot's scan is still "due", not "done".
  //   phase  waiting     the slot's scheduled scan is saved; next one at `due`
  //          due         the slot just started; GitHub should start it soon
  //          late        the slot started a while ago and GitHub hasn't run it
  //          queued      GitHub has the run queued
  //          running     a scan is running on GitHub right now
  //          publishing  a scan finished; its results are being saved
  function pendingScan(reference, columns, workflowRuns) {
    const now = reference instanceof Date ? reference.getTime() : Number(reference);
    const cols = Array.isArray(columns) ? columns : [];
    const runs = Array.isArray(workflowRuns) ? workflowRuns : [];
    const slot = slotStartOf(now);
    // A scheduled run in which no monitor was due (every monitor on a slower
    // scan schedule) saves nothing, so its finished workflow run also counts.
    const scheduledDone = cols.some(column => column.at >= slot && (column.trigger === "scheduled" || column.trigger === "unknown")) ||
      runs.some(run => run.event === "schedule" && run.status === "completed" && run.conclusion === "success" && (runTime(run, "created_at") || 0) >= slot);
    const due = scheduledDone ? slot + PERIOD_MS : slot;
    const result = {
      due: new Date(due), slot, phase: scheduledDone ? "waiting" : (now - slot < 20 * 60000 ? "due" : "late"),
      remainingMinutes: Math.max(0, Math.ceil((due - now) / 60000)),
      lateMinutes: scheduledDone ? 0 : Math.max(0, Math.floor((now - slot) / 60000)),
      startedAt: null, trigger: "", htmlUrl: ""
    };
    const active = runs
      .filter(run => ACTIVE_RUN_STATUSES.indexOf(run.status) >= 0)
      .sort((a, b) => (runTime(b, "created_at") || 0) - (runTime(a, "created_at") || 0))[0];
    if (active) {
      result.phase = active.status === "in_progress" ? "running" : "queued";
      result.startedAt = new Date(runTime(active, "run_started_at") ?? runTime(active, "created_at") ?? now);
      result.trigger = workflowRunTrigger(active);
      result.htmlUrl = active.html_url || "";
      return result;
    }
    // A finished run keeps working for a few minutes after its results are
    // saved (commit, alerts, Pages), so "finished" is only "still saving"
    // while no saved scan belongs to it yet.
    const saved = run => cols.some(column =>
      (column.workflowRunId && String(column.workflowRunId) === String(run.id)) ||
      column.at >= (runTime(run, "run_started_at") ?? runTime(run, "created_at") ?? Infinity) - 60000);
    const finished = runs.find(run => {
      const ended = runTime(run, "updated_at");
      return run.status === "completed" && run.conclusion === "success" && ended !== null &&
        now - ended < 20 * 60000 && !saved(run);
    });
    if (finished) {
      result.phase = "publishing";
      result.trigger = workflowRunTrigger(finished);
      result.htmlUrl = finished.html_url || "";
    }
    return result;
  }

  /* ---------- LED wave ---------- */

  // Smooth 3-D value noise, summed over three octaves (0..1). Drives the slow
  // wave of light that drifts across the change field and the lock screen.
  function hash3(x, y, z) {
    let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function valueNoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
    const lerp = (a, b, t) => a + (b - a) * t;
    const plane = k => lerp(
      lerp(hash3(xi, yi, k), hash3(xi + 1, yi, k), xf),
      lerp(hash3(xi, yi + 1, k), hash3(xi + 1, yi + 1, k), xf), yf);
    return lerp(plane(zi), plane(zi + 1), zf);
  }
  function fbm(x, y, z) {
    let sum = 0, amp = .55, freq = 1, norm = 0;
    for (let octave = 0; octave < 3; octave++) {
      sum += amp * valueNoise(x * freq, y * freq, z * freq + octave * 17.3);
      norm += amp; amp *= .5; freq *= 2.03;
    }
    return sum / norm;
  }

  function formatDuration(minutes) {
    const total = Math.max(0, Math.round(minutes));
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    if (!hours) return rest + " min";
    return rest ? hours + " h " + rest + " min" : hours + " h";
  }

  /* ---------- Event wording ---------- */

  const EVENT_LABELS = {
    CHANGED_URL: "Content changed",
    NEW_URL: "New page",
    REMOVED_URL: "Page removed",
    HTML_SOURCE_CHANGED: "Markup changed",
    VISUAL_CHANGED: "Looks different",
    FETCH_ERROR: "Couldn't fetch",
    EXTRACTION_ERROR: "Couldn't read content",
    BASELINE_MIGRATION: "Parser re-baseline"
  };

  function eventLabel(type) {
    return EVENT_LABELS[type] || "Monitoring event";
  }

  // "change" | "markup" | "problem" | "info" — markup-only events remain visible,
  // but are visually quieter than changes to extracted regulatory content.
  function eventTone(type) {
    if (type === "FETCH_ERROR" || type === "EXTRACTION_ERROR") return "problem";
    if (type === "HTML_SOURCE_CHANGED") return "markup";
    if (type === "CHANGED_URL" || type === "NEW_URL" || type === "REMOVED_URL" || type === "VISUAL_CHANGED") return "change";
    return "info";
  }

  /* ---------- Unified diff parsing ---------- */

  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const TRUNCATION_RE = /^\.\.\. diff truncated after (\d+) lines$/;

  // Parse the engine's unified diff (difflib, 3 lines of context) into hunks.
  function parseUnifiedDiff(text) {
    const result = { hunks: [], truncated: false, truncatedAfter: null };
    let hunk = null;
    const lines = String(text || "").split(/\r?\n/);
    // A trailing newline is not an empty context line (it drew a phantom row).
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.forEach(line => {
      const header = HUNK_RE.exec(line);
      if (header) {
        hunk = {
          oldStart: Number(header[1]), oldLength: header[2] === undefined ? 1 : Number(header[2]),
          newStart: Number(header[3]), newLength: header[4] === undefined ? 1 : Number(header[4]),
          lines: []
        };
        result.hunks.push(hunk);
        return;
      }
      const truncation = TRUNCATION_RE.exec(line);
      if (truncation) {
        result.truncated = true;
        result.truncatedAfter = Number(truncation[1]);
        return;
      }
      // "--- before" / "+++ after" are file headers only before the first hunk
      // (where !hunk already skips them). Inside a hunk they are content: a
      // removed line "-- note" is emitted as "--- note" and an added "++ x" as
      // "+++ x", and testing the prefix here dropped exactly those lines.
      if (!hunk || line.startsWith("\\")) return;
      const marker = line.charAt(0);
      const body = line.slice(1);
      if (marker === "+") hunk.lines.push({ type: "add", text: body });
      else if (marker === "-") hunk.lines.push({ type: "del", text: body });
      else if (marker === " " || line === "") hunk.lines.push({ type: "ctx", text: marker === " " ? body : "" });
    });
    return result;
  }

  /* ---------- Word-level diff ---------- */

  // Lines longer than this are shown as a whole-line replacement. The token diff
  // itself is Myers with a bounded edit distance, so this only guards memory.
  const MAX_TOKENS = 4000;
  const WORD_DIFF_MAX_D = 400;

  function tokenize(text) {
    return String(text || "").match(/\s+|[A-Za-z0-9$%][A-Za-z0-9$%.,'’\/-]*[A-Za-z0-9%]|[A-Za-z0-9$%]|[^\sA-Za-z0-9]/g) || [];
  }

  // A whitespace-only "same" run between two edits is folded into them, so
  // "the quick fox" -> "a slow fox" reads as one replaced phrase rather than
  // alternating struck and inserted words. Whitespace both sides still share at
  // the edges of a folded phrase is handed back as unchanged text. Before and
  // after text are always exactly reconstructable from the segments.
  function foldWhitespace(segments) {
    const out = [];
    const push = (type, text) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    };
    let group = null;
    const flush = () => {
      if (!group) return;
      let del = group.del, add = group.add;
      let lead = "";
      while (del && add && /\s/.test(del[0]) && del[0] === add[0]) { lead += del[0]; del = del.slice(1); add = add.slice(1); }
      let trail = "";
      while (del && add && /\s/.test(del[del.length - 1]) && del[del.length - 1] === add[add.length - 1]) {
        trail = del[del.length - 1] + trail; del = del.slice(0, -1); add = add.slice(0, -1);
      }
      push("same", lead); push("del", del); push("add", add); push("same", trail);
      group = null;
    };
    segments.forEach((segment, index) => {
      if (segment.type !== "same") {
        group = group || { del: "", add: "" };
        group[segment.type] += segment.text;
        return;
      }
      const next = segments[index + 1];
      if (group && next && next.type !== "same" && /^\s+$/.test(segment.text)) {
        group.del += segment.text;
        group.add += segment.text;
        return;
      }
      flush();
      push("same", segment.text);
    });
    flush();
    return out;
  }

  // Token diff (patience anchors + Myers, see diffSequences). Returns segments
  // of {type: "same"|"del"|"add", text}. Very long lines, or lines rewritten
  // beyond the edit-distance budget, become a whole-line replacement.
  function wordDiff(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);
    if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
      return [{ type: "del", text: String(before || "") }, { type: "add", text: String(after || "") }]
        .filter(segment => segment.text);
    }
    const segments = [];
    const push = (type, text) => {
      if (!text) return;
      const last = segments[segments.length - 1];
      if (last && last.type === type) last.text += text;
      else segments.push({ type, text });
    };
    diffSequences(a, b, { maxD: WORD_DIFF_MAX_D }).forEach(run => {
      if (run.type === "add") push("add", b.slice(run.b[0], run.b[1]).join(""));
      else push(run.type, a.slice(run.a[0], run.a[1]).join(""));
    });
    return foldWhitespace(segments);
  }

  // Share of the line that survived; low values mean "rewritten", not "edited".
  function similarity(segments) {
    let same = 0, total = 0;
    segments.forEach(segment => {
      const size = segment.text.replace(/\s+/g, "").length;
      total += size;
      if (segment.type === "same") same += size;
    });
    return total ? same / total : 1;
  }

  /* ---------- Redline model ---------- */

  // Turn hunks into display rows: context, edited lines (word-level), whole-line
  // deletions/insertions, and "N unchanged lines" gaps between hunks.
  function redlineRows(parsed) {
    const rows = [];
    let lastOldEnd = null;
    let stats = { added: 0, removed: 0, edited: 0 };
    parsed.hunks.forEach((hunk, hunkIndex) => {
      if (hunkIndex === 0 && hunk.oldStart > 1) rows.push({ kind: "gap", count: hunk.oldStart - 1, leading: true });
      else if (lastOldEnd !== null && hunk.oldStart > lastOldEnd) rows.push({ kind: "gap", count: hunk.oldStart - lastOldEnd });
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const lines = hunk.lines;
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (line.type === "ctx") {
          rows.push({ kind: "ctx", text: line.text, oldLine, newLine });
          oldLine++; newLine++; index++;
          continue;
        }
        const dels = [], adds = [];
        while (index < lines.length && lines[index].type === "del") dels.push(lines[index++].text);
        while (index < lines.length && lines[index].type === "add") adds.push(lines[index++].text);
        const pairs = Math.min(dels.length, adds.length);
        for (let k = 0; k < pairs; k++) {
          const segments = wordDiff(dels[k], adds[k]);
          if (similarity(segments) >= 0.35) {
            rows.push({ kind: "edit", segments, oldLine: oldLine + k, newLine: newLine + k });
            stats.edited++;
          } else {
            rows.push({ kind: "del", text: dels[k], oldLine: oldLine + k });
            rows.push({ kind: "add", text: adds[k], newLine: newLine + k });
            stats.removed++; stats.added++;
          }
        }
        for (let k = pairs; k < dels.length; k++) { rows.push({ kind: "del", text: dels[k], oldLine: oldLine + k }); stats.removed++; }
        for (let k = pairs; k < adds.length; k++) { rows.push({ kind: "add", text: adds[k], newLine: newLine + k }); stats.added++; }
        oldLine += dels.length;
        newLine += adds.length;
      }
      lastOldEnd = hunk.oldStart + hunk.oldLength;
    });
    return { rows, stats, truncated: parsed.truncated, truncatedAfter: parsed.truncatedAfter };
  }

  function plural(count, one, many) { return count + " " + (count === 1 ? one : many); }

  function redlineSummary(stats) {
    const parts = [];
    if (stats.edited) parts.push(plural(stats.edited, "line edited", "lines edited"));
    if (stats.removed) parts.push(plural(stats.removed, "line removed", "lines removed"));
    if (stats.added) parts.push(plural(stats.added, "line added", "lines added"));
    return parts.length ? parts.join(", ") : "No text differences recorded";
  }

  function renderSegments(segments) {
    return segments.map(segment => {
      if (segment.type === "same") return esc(segment.text);
      const tag = segment.type === "del" ? "del" : "ins";
      return "<" + tag + ">" + esc(segment.text) + "</" + tag + ">";
    }).join("");
  }

  // Render the redline sheet. Deleted text is struck, inserted text underlined,
  // and every changed line carries a change bar in the margin. Runs of lines
  // that are rows of a Markdown table (how the extractor writes page tables)
  // are drawn as a real table, with the changed rows marked in place.
  function renderRedline(diffText) {
    const model = redlineRows(parseUnifiedDiff(diffText));
    if (!model.rows.length) {
      return { html: '<p class="rl-empty">No line-level text differences were recorded for this event.</p>', stats: model.stats, summary: redlineSummary(model.stats), truncated: model.truncated };
    }
    const lineHtml = row => {
      if (row.kind === "gap") {
        return '<div class="rl-gap" role="separator">' + esc(plural(row.count, "unchanged line", "unchanged lines")) + (row.leading ? " before this change" : "") + "</div>";
      }
      // Numbers follow the current text; a removed line has no current number,
      // as in a printed redline.
      const number = row.kind === "del" ? null : row.newLine;
      const gutter = '<span class="rl-no" aria-hidden="true">' + (number == null ? "" : esc(number)) + "</span>";
      if (row.kind === "ctx") return '<div class="rl-line">' + gutter + '<span class="rl-text">' + (esc(row.text) || "&nbsp;") + "</span></div>";
      if (row.kind === "edit") return '<div class="rl-line rl-changed rl-edit">' + gutter + '<span class="rl-text">' + renderSegments(row.segments) + "</span></div>";
      const tag = row.kind === "del" ? "del" : "ins";
      const label = row.kind === "del" ? "Removed line" : "Added line";
      return '<div class="rl-line rl-changed rl-' + row.kind + '">' + gutter + '<span class="rl-text"><' + tag + ' aria-label="' + label + '">' + (esc(row.text) || "&nbsp;") + "</" + tag + "></span></div>";
    };
    let html = "";
    let index = 0;
    const rows = model.rows;
    while (index < rows.length) {
      if (redlineTableRow(rows[index])) {
        let end = index;
        while (end < rows.length && redlineTableRow(rows[end])) end++;
        const run = rows.slice(index, end);
        // One stray line that merely starts and ends with a pipe stays a line.
        if (run.length >= 2 || run.some(row => row.kind !== "ctx")) {
          html += renderRedlineTable(run);
          index = end;
          continue;
        }
      }
      html += lineHtml(rows[index]);
      index++;
    }
    const tail = model.truncated
      ? '<div class="rl-gap rl-truncated" role="note">The stored diff stops after ' + esc(model.truncatedAfter) + " lines. Open the evidence file for the full before and after text.</div>"
      : "";
    return { html: html + tail, stats: model.stats, summary: redlineSummary(model.stats), truncated: model.truncated };
  }

  /* ---------- Tables inside a diff ---------- */

  // "| a | b |": a row of a Markdown table as the extractor writes it.
  function isTableLine(text) {
    const value = String(text == null ? "" : text).trim();
    return value.length >= 3 && value.charAt(0) === "|" && value.charAt(value.length - 1) === "|" && splitMarkdownTableRow(value).length >= 2;
  }
  function segmentsSide(segments, want) {
    return (segments || []).filter(segment => segment.type === "same" || segment.type === want).map(segment => segment.text).join("");
  }
  function redlineTableRow(row) {
    if (!row || row.kind === "gap") return false;
    if (row.kind === "edit") return isTableLine(segmentsSide(row.segments, "del")) && isTableLine(segmentsSide(row.segments, "add"));
    return isTableLine(row.text);
  }
  // A header row whose only text is in its first cell is the table's title
  // ("| Recently Approved and Implemented | | | |"): it spans the table.
  function titleOnly(cells) {
    return cells.length > 1 && String(cells[0] || "").trim() && cells.slice(1).every(cell => !String(cell || "").trim());
  }
  function tableCellsHtml(cells, columns, tag, wrap) {
    if (tag === "th" && titleOnly(cells)) return "<th colspan=\"" + columns + "\" class=\"rl-cell rl-title\">" + wrap(cells[0]) + "</th>";
    let html = "";
    for (let k = 0; k < columns; k++) {
      const cell = k < cells.length ? cells[k] : "";
      html += "<" + tag + ' class="rl-cell">' + (String(cell).trim() ? wrap(cell) : "") + "</" + tag + ">";
    }
    return html;
  }
  function renderRedlineTable(run) {
    // Every row as cells; an edited row keeps both sides.
    const parsed = run.map(row => {
      if (row.kind === "edit") {
        const before = splitMarkdownTableRow(segmentsSide(row.segments, "del"));
        const after = splitMarkdownTableRow(segmentsSide(row.segments, "add"));
        return { row, before, after, separator: isMarkdownTableSeparator(before) && isMarkdownTableSeparator(after) };
      }
      const cells = splitMarkdownTableRow(row.text);
      return { row, cells, separator: isMarkdownTableSeparator(cells) };
    });
    const columns = Math.max(1, ...parsed.map(entry => Math.max((entry.cells || []).length, (entry.before || []).length, (entry.after || []).length)));
    // The row just above a separator is the header, as in Markdown.
    const header = new Set();
    parsed.forEach((entry, k) => { if (entry.separator && k > 0 && !parsed[k - 1].separator) header.add(k - 1); });
    const plain = text => esc(text);
    const gutter = number => '<td class="rl-no" aria-hidden="true">' + (number == null ? "" : esc(number)) + "</td>";
    let body = "";
    parsed.forEach((entry, k) => {
      const row = entry.row;
      if (entry.separator && row.kind === "ctx") return;
      const tag = header.has(k) ? "th" : "td";
      if (row.kind === "ctx") {
        body += '<tr class="rl-tr' + (tag === "th" ? " is-head" : "") + '">' + gutter(row.newLine) + tableCellsHtml(entry.cells, columns, tag, plain) + "</tr>";
      } else if (row.kind === "del" || row.kind === "add") {
        const mark = row.kind === "del" ? "del" : "ins";
        const label = row.kind === "del" ? "Removed row" : "Added row";
        body += '<tr class="rl-tr is-changed is-' + row.kind + (tag === "th" ? " is-head" : "") + '" aria-label="' + label + '">' + gutter(row.kind === "del" ? null : row.newLine) +
          tableCellsHtml(entry.cells, columns, tag, text => "<" + mark + ">" + esc(text) + "</" + mark + ">") + "</tr>";
      } else if (entry.before.length === entry.after.length) {
        // The same columns on both sides: mark the edit inside each changed cell.
        let cellsHtml = "";
        if (tag === "th" && titleOnly(entry.before) && titleOnly(entry.after)) {
          cellsHtml = '<th colspan="' + columns + '" class="rl-cell rl-title">' + renderSegments(wordDiff(entry.before[0], entry.after[0])) + "</th>";
        } else {
          for (let c = 0; c < columns; c++) {
            const before = c < entry.before.length ? entry.before[c] : "";
            const after = c < entry.after.length ? entry.after[c] : "";
            const changed = before !== after;
            cellsHtml += "<" + tag + ' class="rl-cell' + (changed ? " rl-cell-changed" : "") + '">' + (changed ? renderSegments(wordDiff(before, after)) : esc(after)) + "</" + tag + ">";
          }
        }
        body += '<tr class="rl-tr is-changed is-edit' + (tag === "th" ? " is-head" : "") + '">' + gutter(row.newLine) + cellsHtml + "</tr>";
      } else {
        // A column was added or removed: show the old row struck and the new row underlined.
        body += '<tr class="rl-tr is-changed is-del" aria-label="Removed row">' + gutter(null) + tableCellsHtml(entry.before, columns, tag, text => "<del>" + esc(text) + "</del>") + "</tr>" +
          '<tr class="rl-tr is-changed is-add" aria-label="Added row">' + gutter(row.newLine) + tableCellsHtml(entry.after, columns, tag, text => "<ins>" + esc(text) + "</ins>") + "</tr>";
      }
    });
    return '<div class="rl-table-wrap"><table class="rl-table"><tbody>' + body + "</tbody></table></div>";
  }

  // Plain unified diff for technical review (HTML source and raw text diffs).
  // With { tables: true } (the extracted-text diff) runs of Markdown table rows
  // are laid out as a table, each row keeping its +, - or blank marker.
  function renderUnifiedDiff(diffText, options) {
    const text = String(diffText || "");
    if (!text.trim()) return '<p class="rl-empty">No differences were recorded in this evidence file.</p>';
    const lines = text.split(/\r?\n/);
    const tables = !!(options && options.tables);
    const kindOf = line => line.startsWith("+++") || line.startsWith("---") ? "cd-file"
      : line.startsWith("@@") ? "cd-hunk"
      : line.startsWith("+") ? "cd-add"
      : line.startsWith("-") ? "cd-del" : "";
    const tableLine = line => {
      const kind = kindOf(line);
      if (kind === "cd-file" || kind === "cd-hunk") return false;
      const body = /^[ +-]/.test(line) ? line.slice(1) : line;
      return isTableLine(body);
    };
    let html = "";
    let index = 0;
    while (index < lines.length) {
      if (tables && tableLine(lines[index])) {
        let end = index;
        while (end < lines.length && tableLine(lines[end])) end++;
        if (end - index >= 2) {
          const run = lines.slice(index, end).map(line => {
            const marker = /^[ +-]/.test(line) ? line.charAt(0) : " ";
            const cells = splitMarkdownTableRow(/^[ +-]/.test(line) ? line.slice(1) : line);
            return { marker, cells, kind: kindOf(line), separator: isMarkdownTableSeparator(cells) };
          });
          const columns = Math.max(1, ...run.map(entry => entry.cells.length));
          const header = new Set();
          run.forEach((entry, k) => { if (entry.separator && k > 0 && !run[k - 1].separator) header.add(k - 1); });
          html += '<div class="cd-table-wrap"><table class="cd-table"><tbody>' + run.map((entry, k) => {
            if (entry.separator && !entry.kind) return "";
            const tag = header.has(k) ? "th" : "td";
            return '<tr class="cd-tr ' + entry.kind + '"><td class="cd-mark" aria-hidden="true">' + (entry.marker === " " ? "" : esc(entry.marker)) + "</td>" +
              tableCellsHtml(entry.cells, columns, tag, cell => esc(cell)) + "</tr>";
          }).join("") + "</tbody></table></div>";
          index = end;
          continue;
        }
      }
      const line = lines[index];
      html += '<div class="cd-line ' + kindOf(line) + '">' + (esc(line) || "&nbsp;") + "</div>";
      index++;
    }
    return '<div class="code-diff">' + html + "</div>";
  }

  /* ---------- Markdown tables in extracted text ---------- */

  function splitMarkdownTableRow(line) {
    let value = String(line || "").trim();
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    const cells = [];
    let cell = "";
    let escaped = false;
    for (const ch of value) {
      if (ch === "|" && !escaped) {
        cells.push(cell.trim());
        cell = "";
        continue;
      }
      cell += ch;
      if (ch === "\\" && !escaped) escaped = true;
      else escaped = false;
    }
    cells.push(cell.trim());
    return cells.map(value => value.replace(/\\\|/g, "|"));
  }

  function isMarkdownTableSeparator(cells) {
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(String(cell || "").trim()));
  }

  // Exact row identity matters when labels such as "link", "N/A", or a form
  // identifier recur across multiple tables. Never treat one shared cell as a
  // match for an entire row.
  function tableCellsMatch(expected, actual) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((cell, index) => normalizeForMatch(cell) === normalizeForMatch(actual[index]));
  }

  /* ---------- Locating an edit inside a rendered page ---------- */

  // Text as the HTML compare matches it: NFKC, no-break spaces and runs of
  // whitespace collapsed to one space, trimmed.
  function normalizeForMatch(value) {
    return String(value || "").normalize("NFKC").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }
  // The changed runs of one side of a word diff ("del" for before, "add" for
  // after), each with its offset inside normalizeForMatch(that side's line).
  // Table pipes read as spaces, as they do in the rendered page. Knowing the
  // offset lets the compare mark "Tier 2" where it changed even when "2"
  // occurs earlier on the same line.
  function changedPartOffsets(segments, want) {
    let raw = "";
    const parts = [];
    (segments || []).forEach(seg => {
      if (seg.type !== "same" && seg.type !== want) return;
      const text = String(seg.text || "").replace(/\|/g, " ");
      if (seg.type === want && text.trim()) {
        const prefix = raw + text.slice(0, text.length - text.trimStart().length);
        const normalized = normalizeForMatch(prefix);
        parts.push({ text: text.trim(), offset: normalized.length + (normalized && /\s$/.test(prefix) ? 1 : 0) });
      }
      raw += text;
    });
    return parts;
  }

  /* ---------- Model answers: a small, safe Markdown subset ----------
   * All text is HTML-escaped first and only fixed tags are produced; links must
   * be http(s). Code spans and links are set aside before emphasis is applied,
   * so a "*" inside an address can never turn into <em>, and a sentence's
   * closing punctuation stays outside a bare link.
   */
  function linkHtml(href, label) {
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
  }
  // `url` is already HTML-escaped, so quotes arrive as entities.
  function splitTrailingPunctuation(url) {
    let tail = "";
    for (;;) {
      const mark = url.match(/(?:[.,;:!?]|&quot;|&#39;)$/);
      if (mark) { tail = mark[0] + tail; url = url.slice(0, -mark[0].length); continue; }
      if (url.endsWith(")") && url.split("(").length < url.split(")").length) { tail = ")" + tail; url = url.slice(0, -1); continue; }
      return [url, tail];
    }
  }
  function inlineMarkdown(text) {
    let out = esc(text);
    const held = [];
    const hold = html => { held.push(html); return "\u0000" + (held.length - 1) + "\u0000"; };
    out = out.replace(/`([^`\u0000]+)`/g, (_, code) => hold("<code>" + code + "</code>"));
    out = out.replace(/\[([^\]\u0000]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g, (_, label, href) => hold(linkHtml(href, label)));
    out = out.replace(/(^|[\s(])(https?:\/\/(?:(?!&lt;|&gt;)[^\s\u0000])+)/g, (_, pre, raw) => {
      const [href, tail] = splitTrailingPunctuation(raw);
      return href.length > 8 ? pre + hold(linkHtml(href, href.replace(/^https?:\/\//, ""))) + tail : pre + raw;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    // A link label can hold a code span, so restore until nothing is left.
    for (let pass = 0; pass < 4 && out.indexOf("\u0000") >= 0; pass += 1) {
      out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => held[Number(index)]);
    }
    return out;
  }

  /* ---------- XLSX: the first worksheet as rows of text ----------
   * A minimal reader so the bulk-upload dialog needs no third-party script: an
   * .xlsx file is a ZIP of XML parts. Only the first worksheet's cell text is
   * read (shared, inline and formula-result strings, and numbers as written).
   * Entry count, sizes and rows are capped, and everything returned is plain
   * text that callers escape before display. Inflation uses the browser's
   * DecompressionStream (also available in Node 18+).
   */
  const XLSX_LIMITS = { entries: 2000, partBytes: 24 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, rows: 5000, columns: 64 };
  function zipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("This file is not a valid .xlsx workbook.");
    const count = view.getUint16(eocd + 10, true);
    if (count > XLSX_LIMITS.entries) throw new Error("The workbook has too many parts to read safely.");
    let offset = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder("utf-8");
    const entries = new Map();
    for (let n = 0; n < count; n += 1) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error("The workbook's file index is damaged.");
      const method = view.getUint16(offset + 10, true);
      const compressed = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const local = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      entries.set(name, { method, compressed, size, local });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }
  async function zipText(bytes, entries, name, budget) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.size > XLSX_LIMITS.partBytes) throw new Error("A workbook part is too large to read safely.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = entry.local;
    if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) throw new Error("The workbook's file data is damaged.");
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const raw = bytes.subarray(start, start + entry.compressed);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) {
      if (typeof DecompressionStream !== "function") throw new Error("This browser can't read .xlsx files. Save the sheet as CSV.");
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.length;
        budget.used += part.value.length;
        if (total > XLSX_LIMITS.partBytes || budget.used > XLSX_LIMITS.totalBytes) {
          try { await reader.cancel(); } catch (_) {}
          throw new Error("The workbook expands beyond the safe size limit.");
        }
        chunks.push(part.value);
      }
      data = new Uint8Array(total);
      let pos = 0;
      chunks.forEach(chunk => { data.set(chunk, pos); pos += chunk.length; });
    } else {
      throw new Error("The workbook uses an unsupported compression method. Save the sheet as CSV.");
    }
    return new TextDecoder("utf-8").decode(data);
  }
  function xmlText(value) {
    return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) => {
      const lower = code.toLowerCase();
      if (lower[0] === "#") {
        const point = lower[1] === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower];
    });
  }
  function runText(xml) {
    let text = "";
    String(xml || "").replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, value) => { text += xmlText(value); return ""; });
    return text;
  }
  function columnIndex(ref) {
    const letters = (String(ref || "").match(/^[A-Z]+/i) || [""])[0].toUpperCase();
    let index = 0;
    for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
    return index - 1;
  }
  async function xlsxFirstSheetRows(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const entries = zipEntries(bytes);
    const budget = { used: 0 };
    const workbook = await zipText(bytes, entries, "xl/workbook.xml", budget);
    if (!workbook) throw new Error("The workbook does not contain a worksheet.");
    const firstSheet = workbook.match(/<sheet\b[^>]*>/);
    if (!firstSheet) throw new Error("The workbook does not contain a worksheet.");
    const relId = (firstSheet[0].match(/\br:id="([^"]+)"/) || firstSheet[0].match(/\bid="([^"]+)"/) || [])[1];
    let target = "xl/worksheets/sheet1.xml";
    const rels = await zipText(bytes, entries, "xl/_rels/workbook.xml.rels", budget);
    if (rels && relId) {
      const rel = Array.from(rels.matchAll(/<Relationship\b[^>]*>/g)).map(match => match[0])
        .find(tag => (tag.match(/\bId="([^"]+)"/) || [])[1] === relId);
      const path = rel && (rel.match(/\bTarget="([^"]+)"/) || [])[1];
      if (path) target = path.startsWith("/") ? path.slice(1) : "xl/" + path.replace(/^\.\//, "");
    }
    const sheet = await zipText(bytes, entries, target, budget);
    if (!sheet) throw new Error("The workbook's first worksheet could not be read.");
    const sharedXml = await zipText(bytes, entries, "xl/sharedStrings.xml", budget);
    const shared = sharedXml ? Array.from(sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)).map(match => runText(match[1])) : [];
    const rows = [];
    for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      // Keep spreadsheet row numbers: blank rows are omitted from the XML.
      const number = Number((rowMatch[1].match(/\br="(\d+)"/) || [])[1]);
      while (number && rows.length < number - 1 && rows.length < XLSX_LIMITS.rows) rows.push([]);
      if (rows.length >= XLSX_LIMITS.rows) break;
      const row = [];
      for (const cell of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] || "";
        const body = cell[2] || "";
        const ref = (attrs.match(/\br="([^"]+)"/) || [])[1];
        const col = ref ? columnIndex(ref) : row.length;
        if (col < 0 || col >= XLSX_LIMITS.columns) continue;
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "n";
        const raw = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let value = "";
        if (type === "s") value = shared[Number(raw)] || "";
        else if (type === "inlineStr") value = runText(body);
        else if (raw != null) value = xmlText(raw);
        while (row.length < col) row.push("");
        row[col] = value;
      }
      rows.push(row);
    }
    return rows;
  }


  /* ---------- Workbooks: every sheet, cell by cell ----------
   * readWorkbook reads an .xlsx/.xlsm in the browser (no library): every sheet in
   * order with its visibility, each cell's displayed value and formula, merged
   * ranges, data-validation lists and defined names. Dates stored as serial
   * numbers are shown as dates when their cell format is a date format.
   * workbookDiff compares two such workbooks the way a reviewer reads a template:
   * sheets matched by name (or by content, if renamed), rows aligned so an
   * inserted row is one inserted row rather than a cascade of edits, then the
   * cells in each matched row.
   */
  const WORKBOOK_LIMITS = { cellsPerSheet: 400000, cells: 1500000, changesPerSheet: 4000 };
  function columnName(index) {
    let name = "";
    let n = index + 1;
    while (n > 0) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); }
    return name;
  }
  function cellRef(row, col) { return columnName(col) + row; }
  function attr(tag, name) {
    const match = String(tag || "").match(new RegExp("\\b" + name + '="([^"]*)"'));
    return match ? xmlText(match[1]) : "";
  }
  const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  function isDateFormat(code) {
    const text = String(code || "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    return /[dmy]/i.test(text) && !/^[#0.,%\s]*$/.test(text);
  }
  function serialDate(serial, withTime) {
    const ms = Math.round((Number(serial) - 25569) * 86400000);
    const date = new Date(ms);
    if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) return String(serial);
    const iso = date.toISOString();
    return withTime && Math.abs(Number(serial) % 1) > 1e-9 ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
  }
  async function readWorkbook(buffer, options = {}) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const entries = zipEntries(bytes);
    const budget = { used: 0 };
    const read = name => zipText(bytes, entries, name, budget);
    const workbookXml = await read("xl/workbook.xml");
    if (!workbookXml) throw new Error("This file is not an Excel workbook (.xlsx).");
    const rels = (await read("xl/_rels/workbook.xml.rels")) || "";
    const relTargets = {};
    Array.from(rels.matchAll(/<Relationship\b[^>]*>/g)).forEach(match => {
      const id = attr(match[0], "Id");
      const target = attr(match[0], "Target");
      if (id && target) relTargets[id] = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    });
    const sharedXml = await read("xl/sharedStrings.xml");
    const shared = sharedXml ? Array.from(sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)).map(match => runText(match[1])) : [];
    const stylesXml = (await read("xl/styles.xml")) || "";
    const customFormats = {};
    Array.from(stylesXml.matchAll(/<numFmt\b[^>]*>/g)).forEach(match => { customFormats[Number(attr(match[0], "numFmtId"))] = attr(match[0], "formatCode"); });
    const xfs = (stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || ["", ""])[1];
    const dateStyles = Array.from(xfs.matchAll(/<xf\b[^>]*\/?>/g)).map(match => {
      const id = Number(attr(match[0], "numFmtId"));
      return BUILTIN_DATE_FORMATS.has(id) || (customFormats[id] ? isDateFormat(customFormats[id]) : false);
    });
    const names = Array.from(workbookXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)).map(match => ({
      name: attr(match[1], "name"), scope: attr(match[1], "localSheetId"), value: xmlText(match[2]).trim()
    })).filter(entry => entry.name && !/^_xlnm\._FilterDatabase$/.test(entry.name));
    const sheets = [];
    let total = 0;
    let truncated = false;
    for (const match of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
      const tag = match[0];
      const name = attr(tag, "name");
      const relId = attr(tag, "r:id") || attr(tag, "id");
      const path = relTargets[relId];
      const sheet = { name, state: attr(tag, "state") || "visible", cells: {}, maxRow: 0, maxCol: 0, merges: [], validations: [], count: 0, truncated: false, kind: "worksheet" };
      sheets.push(sheet);
      if (!path || !/worksheets\//.test(path)) { sheet.kind = path && /chartsheets\//.test(path) ? "chart" : "other"; continue; }
      const xml = await read(path);
      if (!xml) continue;
      const sharedFormulas = {};
      for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const rowNumber = Number(attr(rowMatch[1], "r")) || sheet.maxRow + 1;
        for (const cell of String(rowMatch[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = cell[1] || "";
          const body = cell[2] || "";
          const ref = attr(attrs, "r");
          const col = ref ? columnIndex(ref) : 0;
          const row = ref ? Number((ref.match(/\d+$/) || [rowNumber])[0]) : rowNumber;
          const type = attr(attrs, "t") || "n";
          const raw = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          const formulaMatch = body.match(/<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/);
          let formula = formulaMatch && formulaMatch[2] ? xmlText(formulaMatch[2]) : "";
          // Shared formulas are written once and referenced by index from the other cells.
          const sharedIndex = formulaMatch && attr(formulaMatch[1], "t") === "shared" ? attr(formulaMatch[1], "si") : "";
          if (sharedIndex) {
            if (formula) sharedFormulas[sharedIndex] = formula;
            else formula = sharedFormulas[sharedIndex] ? sharedFormulas[sharedIndex] + " (shared)" : "(shared formula)";
          }
          let value = "";
          if (type === "s") value = shared[Number(raw)] || "";
          else if (type === "inlineStr") value = runText(body);
          else if (type === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
          else if (raw != null) {
            value = xmlText(raw);
            const style = Number(attr(attrs, "s"));
            if (type === "n" && value !== "" && dateStyles[style]) value = serialDate(value, true);
          }
          if (value === "" && !formula) continue;
          if (sheet.count >= WORKBOOK_LIMITS.cellsPerSheet || total >= WORKBOOK_LIMITS.cells) { sheet.truncated = truncated = true; break; }
          sheet.cells[cellRef(row, col)] = formula ? { v: value, f: formula } : { v: value };
          sheet.count += 1;
          total += 1;
          if (row > sheet.maxRow) sheet.maxRow = row;
          if (col + 1 > sheet.maxCol) sheet.maxCol = col + 1;
        }
        if (sheet.truncated) break;
      }
      sheet.merges = Array.from(xml.matchAll(/<mergeCell\b[^>]*>/g)).map(m => attr(m[0], "ref")).filter(Boolean);
      sheet.validations = Array.from(xml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)).map(m => ({
        range: attr(m[1], "sqref"), type: attr(m[1], "type") || "any",
        rule: xmlText((m[2].match(/<formula1>([\s\S]*?)<\/formula1>/) || ["", ""])[1]) + ((m[2].match(/<formula2>([\s\S]*?)<\/formula2>/) || [])[1] ? " … " + xmlText(m[2].match(/<formula2>([\s\S]*?)<\/formula2>/)[1]) : "")
      }));
    }
    return { sheets, names, truncated };
  }
  // A sheet's rows as arrays [row number, signature, { col: cell }], in order.
  function sheetRows(sheet) {
    const byRow = new Map();
    Object.keys(sheet.cells).forEach(ref => {
      const row = Number(ref.match(/\d+$/)[0]);
      const col = columnIndex(ref);
      if (!byRow.has(row)) byRow.set(row, {});
      byRow.get(row)[col] = sheet.cells[ref];
    });
    return Array.from(byRow.keys()).sort((a, b) => a - b).map(row => {
      const cells = byRow.get(row);
      const cols = Object.keys(cells).map(Number).sort((a, b) => a - b);
      return { row, cells, signature: cols.map(col => col + "=" + cells[col].v + (cells[col].f ? "{" + cells[col].f + "}" : "")).join("\u0001") };
    });
  }
  function rowSimilarity(a, b) {
    const left = new Set(Object.keys(a.cells).map(col => col + "=" + a.cells[col].v));
    const right = Object.keys(b.cells).map(col => col + "=" + b.cells[col].v);
    if (!left.size && !right.length) return 1;
    const shared = right.filter(key => left.has(key)).length;
    return (2 * shared) / (left.size + right.length);
  }
  function sheetSimilarity(a, b) {
    const values = sheet => new Set(Object.values(sheet.cells).slice(0, 4000).map(cell => cell.v).filter(Boolean));
    const left = values(a), right = values(b);
    if (!left.size || !right.size) return 0;
    let shared = 0;
    right.forEach(value => { if (left.has(value)) shared += 1; });
    return (2 * shared) / (left.size + right.size);
  }
  function diffSheet(before, after) {
    const a = sheetRows(before), b = sheetRows(after);
    const changes = [];
    const rowsAdded = [], rowsRemoved = [];
    let more = 0;
    const push = change => { if (changes.length < WORKBOOK_LIMITS.changesPerSheet) changes.push(change); else more += 1; };
    const compareRows = (left, right) => {
      const cols = new Set(Object.keys(left.cells).concat(Object.keys(right.cells)).map(Number));
      Array.from(cols).sort((x, y) => x - y).forEach(col => {
        const was = left.cells[col], now = right.cells[col];
        const beforeRef = was ? cellRef(left.row, col) : "", afterRef = now ? cellRef(right.row, col) : "";
        if (was && now) {
          if (was.v === now.v && (was.f || "") === (now.f || "")) return;
          push({ kind: (was.f || "") !== (now.f || "") ? "formula" : "value", before: { ref: beforeRef, v: was.v, f: was.f || "" }, after: { ref: afterRef, v: now.v, f: now.f || "" } });
        } else if (now) push({ kind: "added", before: null, after: { ref: afterRef, v: now.v, f: now.f || "" } });
        else push({ kind: "removed", before: { ref: beforeRef, v: was.v, f: was.f || "" }, after: null });
      });
    };
    const runs = diffSequences(a.map(row => row.signature), b.map(row => row.signature), { maxD: 2000 });
    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i];
      if (run.type === "same") continue;
      // A removed block followed by an added block: pair rows that still look alike as edits.
      let removed = run.type === "del" ? a.slice(run.a[0], run.a[1]) : [];
      let added = run.type === "add" ? b.slice(run.b[0], run.b[1]) : [];
      if (run.type === "del" && runs[i + 1] && runs[i + 1].type === "add") { added = b.slice(runs[i + 1].b[0], runs[i + 1].b[1]); i += 1; }
      // In order: each removed row pairs with the most similar added row after the
      // last pair; added rows skipped over are insertions, unpaired removals deletions.
      let y = 0;
      removed.forEach(row => {
        let best = -1, score = 0;
        for (let k = y; k < added.length && k < y + 60; k += 1) {
          const s = rowSimilarity(row, added[k]);
          if (s > score) { score = s; best = k; }
        }
        if (best >= 0 && score >= 0.34) {
          for (let k = y; k < best; k += 1) rowsAdded.push(added[k].row);
          compareRows(row, added[best]);
          y = best + 1;
        } else rowsRemoved.push(row.row);
      });
      added.slice(y).forEach(row => rowsAdded.push(row.row));
    }
    rowsRemoved.forEach(row => { const r = a.find(entry => entry.row === row); if (r) Object.keys(r.cells).forEach(col => push({ kind: "removed", before: { ref: cellRef(row, Number(col)), v: r.cells[col].v, f: r.cells[col].f || "" }, after: null, row: true })); });
    rowsAdded.forEach(row => { const r = b.find(entry => entry.row === row); if (r) Object.keys(r.cells).forEach(col => push({ kind: "added", before: null, after: { ref: cellRef(row, Number(col)), v: r.cells[col].v, f: r.cells[col].f || "" }, row: true })); });
    const setDiff = (x, y) => x.filter(item => y.indexOf(item) < 0);
    const merges = { added: setDiff(after.merges, before.merges), removed: setDiff(before.merges, after.merges) };
    const rule = v => v.range + " " + v.type + " " + v.rule;
    const validations = { added: setDiff(after.validations.map(rule), before.validations.map(rule)), removed: setDiff(before.validations.map(rule), after.validations.map(rule)) };
    const counts = { value: 0, formula: 0, added: 0, removed: 0 };
    changes.forEach(change => { counts[change.kind] += 1; });
    const changed = changes.length || more || merges.added.length || merges.removed.length || validations.added.length || validations.removed.length || before.state !== after.state;
    return { changes, more, counts, rowsAdded, rowsRemoved, merges, validations, visibility: before.state !== after.state ? [before.state, after.state] : null, changed: !!changed };
  }
  function workbookDiff(before, after) {
    const sheets = [];
    const left = (before && before.sheets) || [], right = (after && after.sheets) || [];
    const matchedRight = new Set();
    const pairs = [];
    left.forEach(sheet => {
      const twin = right.find(candidate => candidate.name === sheet.name);
      if (twin) { pairs.push([sheet, twin]); matchedRight.add(twin); } else pairs.push([sheet, null]);
    });
    // A sheet missing by name may have been renamed: match by content.
    pairs.forEach(pair => {
      if (pair[1]) return;
      let best = null, score = 0;
      right.filter(candidate => !matchedRight.has(candidate)).forEach(candidate => {
        const s = sheetSimilarity(pair[0], candidate);
        if (s > score) { score = s; best = candidate; }
      });
      if (best && score >= 0.6) { pair[1] = best; pair.renamed = true; matchedRight.add(best); }
    });
    pairs.forEach(pair => {
      const [was, now] = pair;
      if (!now) { sheets.push({ name: was.name, before: was.name, after: null, status: "removed", cells: was.count }); return; }
      const diff = diffSheet(was, now);
      sheets.push(Object.assign({ name: now.name, before: was.name, after: now.name, status: pair.renamed ? "renamed" : diff.changed ? "changed" : "same" }, diff));
    });
    right.forEach((sheet, index) => {
      if (matchedRight.has(sheet)) return;
      const entry = { name: sheet.name, before: null, after: sheet.name, status: "added", cells: sheet.count };
      // Keep the new workbook's sheet order.
      const at = sheets.findIndex(item => item.after && right.findIndex(s => s.name === item.after) > index);
      if (at < 0) sheets.push(entry); else sheets.splice(at, 0, entry);
    });
    const key = entry => entry.name + "=" + entry.value + "@" + entry.scope;
    const beforeNames = ((before && before.names) || []).map(key), afterNames = ((after && after.names) || []).map(key);
    const names = { added: afterNames.filter(n => beforeNames.indexOf(n) < 0), removed: beforeNames.filter(n => afterNames.indexOf(n) < 0) };
    const totals = { sheetsChanged: sheets.filter(s => s.status !== "same").length, cells: 0, rowsAdded: 0, rowsRemoved: 0 };
    sheets.forEach(s => { if (s.changes) { totals.cells += s.changes.filter(c => !c.row).length + (s.more || 0); totals.rowsAdded += s.rowsAdded.length; totals.rowsRemoved += s.rowsRemoved.length; } });
    return { sheets, names, totals, truncated: !!((before && before.truncated) || (after && after.truncated)) };
  }
  function parseCsv(text, limit) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    const max = limit || 20000;
    const s = String(text || "");
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i += 1;
        row.push(cell); rows.push(row); row = []; cell = "";
        if (rows.length >= max) return rows;
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  // A CSV file as a one-sheet workbook, so it can use the same viewer and comparison.
  function csvWorkbook(text, name) {
    const sheet = { name: name || "Sheet1", state: "visible", cells: {}, maxRow: 0, maxCol: 0, merges: [], validations: [], count: 0, truncated: false, kind: "worksheet" };
    parseCsv(text).forEach((row, r) => row.forEach((value, c) => {
      if (value === "") return;
      sheet.cells[cellRef(r + 1, c)] = { v: value };
      sheet.count += 1;
      sheet.maxRow = Math.max(sheet.maxRow, r + 1);
      sheet.maxCol = Math.max(sheet.maxCol, c + 1);
    }));
    return { sheets: [sheet], names: [], truncated: false };
  }
  // The names in a zip file, for listing a bundle's contents.
  async function zipListing(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return Array.from(zipEntries(bytes).entries()).map(([name, entry]) => ({ name, size: entry.size, compressed: entry.compressed }))
      .filter(entry => !entry.name.endsWith("/"));
  }
  async function zipFile(buffer, name) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const entries = zipEntries(bytes);
    const entry = entries.get(name);
    if (!entry) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = entry.local;
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const raw = bytes.subarray(start, start + entry.compressed);
    if (entry.method === 0) return raw.slice();
    if (entry.method !== 8 || typeof DecompressionStream !== "function") throw new Error("This part of the bundle can't be opened here.");
    const out = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    return new Uint8Array(out);
  }
  // Paragraphs and tables of a Word document, as plain blocks.
  async function readDocx(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const entries = zipEntries(bytes);
    const xml = await zipText(bytes, entries, "word/document.xml", { used: 0 });
    if (!xml) throw new Error("This file is not a Word document (.docx).");
    const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || ["", xml])[1];
    const blocks = [];
    const paragraphText = p => Array.from(p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)).map(m => m[1] != null ? xmlText(m[1]) : " ").join("");
    for (const part of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
      const chunk = part[0];
      if (chunk.startsWith("<w:tbl")) {
        const rows = Array.from(chunk.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)).map(tr =>
          Array.from(tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)).map(tc => Array.from(tc[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)).map(p => paragraphText(p[0])).join("\n")));
        blocks.push({ type: "table", rows });
      } else {
        const text = paragraphText(chunk);
        const style = (chunk.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || "";
        if (text.trim()) blocks.push({ type: /heading|title/i.test(style) ? "heading" : "paragraph", text });
      }
      if (blocks.length > 5000) break;
    }
    return blocks;
  }

  /* ---------- Time ---------- */

  function relativeTime(value, now = Date.now()) {
    if (!value) return "Not checked yet";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "Unknown";
    const mins = Math.max(0, Math.floor((now - d.getTime()) / 60000));
    if (mins < 1) return "Just now";
    if (mins < 60) return mins + " min ago";
    if (mins < 1440) return Math.floor(mins / 60) + " h ago";
    const days = Math.floor(mins / 1440);
    return days === 1 ? "Yesterday" : days + " days ago";
  }

  // "Today" / "Yesterday" / "Mon 19 Oct" — group headings in the change list.
  function dayHeading(value, now = new Date()) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "Undated";
    const startOf = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  }

  /* ---------- Sequence diff (patience + Myers) ----------
   * diffSequences(a, b) compares two arrays of strings and returns runs
   * {type: "same"|"del"|"add", a: [start, end), b: [start, end)}. Patience anchors
   * (items unique in both ranges, kept in order) split large documents into small
   * gaps; each gap is solved with Myers' O((N+M)D) algorithm. A gap whose edit
   * distance exceeds maxD is reported as a replacement instead of exhausting memory.
   */
  function diffSequences(a, b, options) {
    const maxD = (options && options.maxD) || 1200;
    const runs = [];
    const emit = (type, a0, a1, b0, b1) => {
      if (a1 - a0 <= 0 && b1 - b0 <= 0) return;
      const last = runs[runs.length - 1];
      if (last && last.type === type && last.a[1] === a0 && last.b[1] === b0) { last.a[1] = a1; last.b[1] = b1; return; }
      runs.push({ type, a: [a0, a1], b: [b0, b1] });
    };
    function myers(a0, a1, b0, b1) {
      const n = a1 - a0, m = b1 - b0, max = n + m, offset = max + 1;
      const limit = Math.min(max, maxD);
      const v = new Int32Array(2 * max + 3);
      const trace = [];
      for (let d = 0; d <= limit; d += 1) {
        trace.push(v.slice(offset - d - 1, offset + d + 2));
        for (let k = -d; k <= d; k += 2) {
          let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
          let y = x - k;
          while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x += 1; y += 1; }
          v[offset + k] = x;
          if (x >= n && y >= m) {
            const ops = [];
            for (let back = d; back > 0; back -= 1) {
              const prev = trace[back], base = back + 1; // prev holds v[k] for k in [-back-1, back+1]
              const kk = x - y;
              const down = kk === -back || (kk !== back && prev[base + kk - 1] < prev[base + kk + 1]);
              const pk = down ? kk + 1 : kk - 1;
              const px = prev[base + pk], py = px - pk;
              const sx = down ? px : px + 1, sy = down ? py + 1 : py;
              if (x > sx) ops.push(["same", a0 + sx, a0 + x, b0 + sy, b0 + y]);
              ops.push(down ? ["add", a0 + px, a0 + px, b0 + py, b0 + py + 1] : ["del", a0 + px, a0 + px + 1, b0 + py, b0 + py]);
              x = px; y = py;
            }
            if (x > 0) ops.push(["same", a0, a0 + x, b0, b0 + y]);
            for (let i = ops.length - 1; i >= 0; i -= 1) emit(...ops[i]);
            return;
          }
        }
      }
      emit("del", a0, a1, b0, b0);
      emit("add", a1, a1, b0, b1);
    }
    function anchors(a0, a1, b0, b1) {
      const count = new Map();
      for (let i = a0; i < a1; i += 1) { const c = count.get(a[i]) || [0, 0, -1, -1]; c[0] += 1; c[2] = i; count.set(a[i], c); }
      for (let j = b0; j < b1; j += 1) { const c = count.get(b[j]); if (c) { c[1] += 1; c[3] = j; } }
      const pairs = [];
      for (let i = a0; i < a1; i += 1) { const c = count.get(a[i]); if (c && c[0] === 1 && c[1] === 1) pairs.push([i, c[3]]); }
      // Longest increasing subsequence on b positions keeps anchors in order.
      const tails = [], prevIndex = new Int32Array(pairs.length).fill(-1), tailIdx = [];
      pairs.forEach((p, idx) => {
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < p[1]) lo = mid + 1; else hi = mid; }
        tails[lo] = p[1]; tailIdx[lo] = idx; prevIndex[idx] = lo > 0 ? tailIdx[lo - 1] : -1;
      });
      const out = [];
      for (let idx = tails.length ? tailIdx[tails.length - 1] : -1; idx >= 0; idx = prevIndex[idx]) out.push(pairs[idx]);
      return out.reverse();
    }
    function diffInto(a0, a1, b0, b1) {
      // Same steps as the outer loop for a sub-range, recursing through gaps.
      let p = 0;
      while (a0 + p < a1 && b0 + p < b1 && a[a0 + p] === b[b0 + p]) p += 1;
      emit("same", a0, a0 + p, b0, b0 + p); a0 += p; b0 += p;
      let s = 0;
      while (a1 - s > a0 && b1 - s > b0 && a[a1 - s - 1] === b[b1 - s - 1]) s += 1;
      const tail = [a1 - s, a1, b1 - s, b1];
      a1 -= s; b1 -= s;
      if (a0 === a1 || b0 === b1) { emit("del", a0, a1, b0, b0); emit("add", a1, a1, b0, b1); }
      else {
        const found = (a1 - a0) + (b1 - b0) > 64 ? anchors(a0, a1, b0, b1) : [];
        if (found.length) {
          let ca = a0, cb = b0;
          found.forEach(([i, j]) => { diffInto(ca, i, cb, j); emit("same", i, i + 1, j, j + 1); ca = i + 1; cb = j + 1; });
          diffInto(ca, a1, cb, b1);
        } else myers(a0, a1, b0, b1);
      }
      emit("same", ...tail);
    }
    diffInto(0, a.length, 0, b.length);
    return runs;
  }

  // Align two documents line by line for a side-by-side compare: unchanged lines
  // share a row; a changed block pairs its removed and added lines, and edited
  // pairs carry word-level segments. Rows: {type, before, after, segments}.
  function alignLines(beforeText, afterText) {
    const a = String(beforeText || "").replace(/\r\n/g, "\n").split("\n");
    const b = String(afterText || "").replace(/\r\n/g, "\n").split("\n");
    const key = line => line.replace(/\s+/g, " ").trim();
    const runs = diffSequences(a.map(key), b.map(key));
    const rows = [];
    const stats = { added: 0, removed: 0, edited: 0 };
    for (let r = 0; r < runs.length; r += 1) {
      const run = runs[r];
      if (run.type === "same") {
        for (let i = 0; i < run.a[1] - run.a[0]; i += 1) rows.push({ type: "same", before: a[run.a[0] + i], after: b[run.b[0] + i] });
        continue;
      }
      // Gather a contiguous change block (del and add runs between two same runs).
      const dels = [], adds = [];
      while (r < runs.length && runs[r].type !== "same") {
        const x = runs[r];
        for (let i = x.a[0]; i < x.a[1]; i += 1) dels.push(a[i]);
        for (let j = x.b[0]; j < x.b[1]; j += 1) adds.push(b[j]);
        r += 1;
      }
      r -= 1;
      const pairs = Math.min(dels.length, adds.length);
      for (let i = 0; i < Math.max(dels.length, adds.length); i += 1) {
        const before = i < dels.length ? dels[i] : null;
        const after = i < adds.length ? adds[i] : null;
        if (i < pairs) {
          const segments = wordDiff(before, after);
          if (similarity(segments) >= 0.35) { rows.push({ type: "edit", before, after, segments }); stats.edited += 1; continue; }
        }
        if (before !== null) { rows.push({ type: "del", before, after: null }); stats.removed += 1; }
        if (after !== null) { rows.push({ type: "add", before: null, after }); stats.added += 1; }
      }
    }
    return { rows, stats };
  }

  // Word-level changes between two PDF word lists ({text, ...} items). Returns the
  // indexes of removed words in `before` and added words in `after`.
  function changedWords(beforeWords, afterWords, options) {
    const runs = diffSequences(beforeWords.map(w => w.text), afterWords.map(w => w.text), options);
    const removed = [], added = [];
    runs.forEach(run => {
      if (run.type === "del") for (let i = run.a[0]; i < run.a[1]; i += 1) removed.push(i);
      if (run.type === "add") for (let j = run.b[0]; j < run.b[1]; j += 1) added.push(j);
    });
    return { removed, added };
  }

  /* ---------- Scout (new-page discovery) ---------- */

  const SCOUT_FILTERS = ["REVIEW", "BACKLOG", "EXCLUDED", "DONE"];
  const SCOUT_OUTCOMES = {
    relevant: { label: "Looks relevant", tag: "is-relevant", mark: "tone-new" },
    uncertain: { label: "Unsure", tag: "is-unreviewed", mark: "tone-pending" },
    irrelevant: { label: "Not relevant", tag: "is-irrelevant", mark: "" }
  };
  const SCOUT_CONFIDENCE = { strong: "Strong evidence", supported: "Supported evidence", weak: "Weak evidence", conflicting: "Conflicting evidence" };
  const SCOUT_STATUS = {
    COMPLETE: { label: "Complete", tone: "ok" }, PARTIAL: { label: "Partial", tone: "warn" }, DEGRADED: { label: "Degraded", tone: "warn" },
    BLOCKED: { label: "Blocked", tone: "bad" }, FAILED: { label: "Failed", tone: "bad" }, NOT_RUN: { label: "Not run yet", tone: "idle" }
  };
  const SCOUT_CHANNEL_STATUS = {
    ok: "Read as planned", partial: "Read in part", failed: "Failed", blocked: "Blocked", deferred: "Deferred by the server"
  };
  const SCOUT_NOUNS = {
    rule: "a rule or regulation", consultation: "a consultation or proposal", technical_standard: "a technical standard",
    guidance: "guidance or a guideline", reporting: "a reporting form or instructions", supervisory_letter: "a supervisory letter or notice",
    qa: "a Q&A", enforcement: "an enforcement action", decision_opinion: "a decision or opinion", report: "a report",
    press_release: "a press release", speech: "a speech or testimony", minutes: "a meeting record", research: "research",
    statistics: "a statistical release", event: "an event page", media: "a media page", job: "a job posting"
  };
  const SCOUT_REVIEW_MARKER = "<!-- changesentinel:scout-review:v1 -->";

  /* ---------- URL identity ----------
   * One canonical form for the whole dashboard, mirroring regmon/discovery.py
   * canonical(): no fragment, one trailing slash dropped, tracking parameters
   * (utm_*, fbclid, gclid, mc_cid, mc_eid) removed and the rest of the query
   * sorted by key then value. Inventory URLs are stored in this form, so any
   * address compared against them must go through it too.
   */
  const TRACKING_PARAMS = ["fbclid", "gclid", "mc_cid", "mc_eid"];
  // canonicalUrl and urlKey are pure and called for every listed URL on each
  // render; parsing with URL() is the cost, so results are remembered.
  const urlMemo = new Map();
  function remembered(kind, value, compute) {
    const key = kind + String(value == null ? "" : value);
    let hit = urlMemo.get(key);
    if (hit === undefined) {
      hit = compute();
      if (urlMemo.size > 20000) urlMemo.clear();
      urlMemo.set(key, hit);
    }
    return hit;
  }
  function canonicalUrl(value) { return remembered("c", value, () => canonicalUrlUncached(value)); }
  function canonicalUrlUncached(value) {
    const raw = String(value == null ? "" : value).trim();
    try {
      const url = new URL(raw);
      url.hash = "";
      if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
      const params = Array.from(url.searchParams.entries()).filter(([key]) => {
        const lower = key.toLowerCase();
        return !lower.startsWith("utm_") && TRACKING_PARAMS.indexOf(lower) < 0;
      });
      params.sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
      url.search = "";
      params.forEach(([key, val]) => url.searchParams.append(key, val));
      return url.toString();
    } catch (_) {
      return raw;
    }
  }

  // Loose address identity for the "already monitored" hint: on top of the
  // canonical form, the scheme, host case, a trailing dot and any trailing
  // slashes never make a different page.
  function urlKey(value) { return remembered("k", value, () => urlKeyUncached(value)); }
  function urlKeyUncached(value) {
    try {
      const url = new URL(canonicalUrl(value));
      const path = url.pathname.replace(/\/+$/, "") || "/";
      return url.hostname.toLowerCase().replace(/\.$/, "") + path + url.search;
    } catch (_) {
      return String(value || "");
    }
  }

  // Which list a Scout finding belongs in. Baseline findings that do not look
  // relevant stay out of every list (they are in the registry, not the queue).
  function scoutBucket(candidate, monitoredKeys) {
    const decision = candidate && candidate.decision ? candidate.decision.decision : "";
    const monitored = (candidate.monitored_by && candidate.monitored_by.length) || (monitoredKeys && monitoredKeys.has(urlKey(candidate.url)));
    if (decision === "dismissed" || monitored) return "DONE";
    const outcome = (candidate.assessment || {}).outcome;
    if (candidate.origin !== "new") return outcome === "relevant" ? "BACKLOG" : null;
    return outcome === "irrelevant" ? "EXCLUDED" : "REVIEW";
  }

  function scoutBuckets(candidates, monitoredKeys) {
    const out = { REVIEW: [], BACKLOG: [], EXCLUDED: [], DONE: [] };
    (candidates || []).forEach(candidate => {
      const bucket = scoutBucket(candidate, monitoredKeys);
      if (bucket) out[bucket].push(candidate);
    });
    const rank = item => Number((item.assessment || {}).rank || 0);
    const day = value => String(value || "").slice(0, 10);
    const byArrival = (a, b) => day(b.first_seen).localeCompare(day(a.first_seen)) || rank(b) - rank(a) || String(a.title).localeCompare(String(b.title));
    // The backlog is shown grouped under one heading per regulator, so it must
    // be contiguous by regulator; within one, strongest evidence then newest first.
    const published = item => {
      const evidence = item.evidence || {};
      const t = Date.parse(evidence.published || evidence.page_published || evidence.date_hint || item.first_seen || "");
      return Number.isNaN(t) ? 0 : t;
    };
    const byRegulator = (a, b) => String(a.regulator_id || "").localeCompare(String(b.regulator_id || "")) ||
      rank(b) - rank(a) || published(b) - published(a) || String(a.title).localeCompare(String(b.title));
    out.REVIEW.sort(byArrival);
    out.BACKLOG.sort(byRegulator);
    out.EXCLUDED.sort(byArrival);
    out.DONE.sort((a, b) => String((b.decision || {}).decided_at || b.first_seen || "").localeCompare(String((a.decision || {}).decided_at || a.first_seen || "")));
    return out;
  }

  // How strongly Scout's evidence points one way, as a three-light meter.
  function scoutStrength(assessment) {
    const confidence = (assessment || {}).confidence;
    if (confidence === "strong") return { level: 3, label: "Strong evidence", tone: "strong" };
    if (confidence === "supported") return { level: 2, label: "Supported evidence", tone: "supported" };
    if (confidence === "conflicting") return { level: 1, label: "Conflicting evidence", tone: "conflicting" };
    return { level: 1, label: "Weak evidence", tone: "weak" };
  }

  // Findings grouped for reading: by kind of publication, by regulator, or by the
  // day Scout found them. Groups keep the order of the list they were given
  // within themselves; larger groups come first except for dates (newest first).
  function scoutGroups(items, by, regulatorLabel) {
    const label = typeof regulatorLabel === "function" ? regulatorLabel : id => id;
    const groups = new Map();
    (items || []).forEach(item => {
      const a = item.assessment || {};
      let key, name;
      if (by === "regulator") { key = "reg:" + (item.regulator_id || ""); name = label(item.regulator_id || "") || "Unknown regulator"; }
      else if (by === "date") {
        const when = (item.decision || {}).decided_at || item.first_seen || "";
        key = "day:" + String(when).slice(0, 10);
        name = when ? dayHeading(when) : "Date unknown";
      } else {
        const type = a.publication_type || null;
        key = "kind:" + (type ? type.id : "unrecognised");
        name = type ? type.label : "Kind not recognised";
      }
      if (!groups.has(key)) groups.set(key, { key, label: name, items: [] });
      groups.get(key).items.push(item);
    });
    const list = Array.from(groups.values());
    if (by === "date") return list.sort((x, y) => y.key.localeCompare(x.key));
    return list.sort((x, y) => y.items.length - x.items.length || x.label.localeCompare(y.label));
  }

  function scoutSentence(assessment) {
    const a = assessment || {};
    const noun = a.publication_type ? (SCOUT_NOUNS[a.publication_type.id] || String(a.publication_type.label || "").toLowerCase()) : "";
    const topics = (a.topics || []).slice(0, 2).map(topic => topic.charAt(0).toLowerCase() + topic.slice(1));
    const about = topics.length ? " about " + topics.join(" and ") : "";
    if (a.outcome === "relevant") {
      return noun ? "Looks like " + noun + about + "." : "Mentions " + (topics.join(" and ") || "a regulatory topic") + ".";
    }
    if (a.outcome === "irrelevant") {
      const utility = (a.reasons || []).some(reason => /utility page/.test(reason.text || ""));
      if (utility) return "Looks like a site utility page, not a publication.";
      return noun ? "Looks like " + noun + ", which the monitoring objective leaves out." : "Looks outside the monitoring objective.";
    }
    if (a.confidence === "conflicting") return "The evidence points both ways" + (noun ? ": possibly " + noun + about : "") + ".";
    return noun ? "Possibly " + noun + about + ", but the evidence is thin." : "Scout couldn't tell what this page is from the evidence it has.";
  }

  function oneLine(value, max) {
    return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max || 300);
  }

  // The body review.py parses: one Decision line, one Reason line and one
  // "- regulator:id | url" line per finding. Decisions never cover a path or topic.
  function scoutReviewIssue(decision, candidates, reason) {
    const verb = decision === "restore" ? "restore" : "dismiss";
    const lines = [
      SCOUT_REVIEW_MARKER, "",
      verb === "dismiss" ? "Please record these Scout findings as not relevant." : "Please return these Scout findings to review.", "",
      "Decision: " + verb,
      "Reason: " + (oneLine(reason) || "(none)"), "",
      "Candidates:"
    ];
    (candidates || []).forEach(candidate => lines.push("- " + candidate.regulator_id + ":" + candidate.id + " | " + candidate.url));
    lines.push("", "You can edit the Reason line before submitting. A decision applies to the listed addresses only.", "",
      "This request was created from the ChangeSentinel dashboard.");
    const count = (candidates || []).length;
    return {
      title: "[ChangeSentinel] Scout review: " + (verb === "dismiss" ? "not relevant" : "restore") + (count > 1 ? " (" + count + ")" : ""),
      body: lines.join("\n")
    };
  }

  // The Scout workflow's schedule: Mondays at 04:17 UTC.
  function nextScoutSweep(reference = new Date()) {
    const next = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate(), 4, 17, 0, 0));
    while (next.getUTCDay() !== 1 || next.getTime() <= reference.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  /* ---------- Scout sources: add a regulator, a channel, or edit metadata ---------- */

  const SCOUT_SOURCE_MARKER = "<!-- changesentinel:scout-source:v1 -->";
  const SCOUT_TOPIC_IDS = ["capital", "liquidity", "reporting", "stress_testing", "resolution", "financial_crime", "payments_crypto",
    "consumer", "operational_resilience", "governance", "climate_esg", "credit_market_risk", "insurance_pensions", "markets", "supervision"];
  const SCOUT_REGIONS = ["NAM", "LATAM", "EMEA", "APAC"];

  function scoutSlug(text) {
    return String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  function splitList(text) {
    const seen = new Set();
    return String(text || "").split(/[\n,]/).map(item => item.replace(/\s+/g, " ").trim()).filter(item => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function splitLines(text) {
    return String(text || "").split(/\n/).map(item => item.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  // "/en/guidance/ = guidance", "/x/ = topic:capital", "/events/ = exclude", or both a kind and a topic.
  function parsePathHints(text) {
    const hints = [], errors = [];
    splitLines(text).forEach(line => {
      const [prefix, rest] = line.split("=").map(part => (part || "").trim());
      if (!prefix || !prefix.startsWith("/") || rest === undefined || !rest) {
        errors.push("Path hint “" + line + "” should look like /path/ = guidance");
        return;
      }
      const hint = { prefix };
      const parts = rest.split(/[,\s]+/).filter(Boolean);
      for (const part of parts) {
        const value = part.toLowerCase();
        if (value === "exclude" || value === "not-relevant") { hint.effect = "negative"; continue; }
        if (value.startsWith("topic:")) {
          const topic = value.slice(6);
          if (SCOUT_TOPIC_IDS.indexOf(topic) < 0) { errors.push("Unknown topic “" + topic + "” in “" + line + "”"); return; }
          hint.topic = topic;
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(SCOUT_NOUNS, value)) { errors.push("Unknown kind of page “" + value + "” in “" + line + "”"); return; }
        hint.publication_type = value;
      }
      if (hint.effect === "negative") { delete hint.topic; delete hint.publication_type; }
      hints.push(hint);
    });
    return { hints, errors };
  }

  function pathHintsText(hints) {
    return (hints || []).map(hint => hint.prefix + " = " + (hint.effect === "negative" ? "exclude"
      : [hint.publication_type, hint.topic ? "topic:" + hint.topic : ""].filter(Boolean).join(", "))).join("\n");
  }

  // Builds the issue the owner-only "Scout Source Request" workflow applies.
  // mode: "add" (a channel, for an existing or a new regulator) or "edit" (metadata, optionally plus a channel).
  function scoutSourceRequest(values) {
    const v = values || {};
    const errors = [];
    const isNew = !!v.isNew;
    const name = String(v.name || "").trim();
    const id = isNew ? (scoutSlug(v.id) || scoutSlug(v.shortName) || scoutSlug(name)) : String(v.regulatorId || "");
    if (!id) errors.push(isNew ? "Enter the regulator's name." : "Choose a regulator.");
    if (isNew && !name) errors.push("Enter the regulator's name.");
    if (isNew && SCOUT_REGIONS.indexOf(v.region) < 0) errors.push("Choose a region.");
    const regulator = { id };
    if (isNew || v.mode === "edit") {
      if (isNew || name) regulator.name = name;
      regulator.short_name = String(v.shortName || "").trim();
      regulator.region = v.region;
      regulator.jurisdiction = String(v.jurisdiction || "").trim();
      regulator.languages = splitList(v.languages).map(item => item.toLowerCase());
      regulator.review_languages = splitList(v.reviewLanguages).map(item => item.toLowerCase());
      regulator.keywords = { relevant: splitLines(v.relevantKeywords), exclude: splitLines(v.excludeKeywords) };
      const hints = parsePathHints(v.pathHints);
      hints.errors.forEach(error => errors.push(error));
      regulator.path_hints = hints.hints;
      regulator.known_gaps = splitLines(v.knownGaps);
      if (v.mode === "edit") regulator.active = v.active !== false;
      if (isNew) regulator.prefer_https = true;
      const overlap = regulator.keywords.relevant.filter(term => regulator.keywords.exclude.some(other => other.toLowerCase() === term.toLowerCase()));
      if (overlap.length) errors.push("A keyword can't be both relevant and excluded: " + overlap.join(", "));
    }
    let channel = null;
    const url = String(v.channelUrl || "").trim();
    if (url) {
      let parsed = null;
      try { parsed = new URL(url); } catch (_) { parsed = null; }
      if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) errors.push("Enter the channel's full public address (https://…).");
      const label = String(v.channelLabel || "").trim();
      if (!label) errors.push("Give the channel a short label.");
      channel = { type: v.channelType || "feed", url, label };
      if (v.required === false) channel.required = false;
      if (channel.type === "listing") {
        if (String(v.contentSelector || "").trim()) channel.content_selector = String(v.contentSelector).trim();
        if (String(v.linkPrefix || "").trim()) channel.link_prefixes = [String(v.linkPrefix).trim()];
        if (String(v.pageParam || "").trim()) {
          const pages = Math.max(1, Math.min(50, parseInt(v.maxPages, 10) || 5));
          channel.pagination = { param: String(v.pageParam).trim(), max_pages: pages, baseline_pages: Math.min(2, pages) };
        }
      }
    } else if (v.mode !== "edit") {
      errors.push("Enter the address of the feed, site map or listing page.");
    }
    const request = { version: 1, regulator, channel };
    const what = isNew ? "add the regulator " + name : v.mode === "edit" ? (channel ? "update " + id + " and add a channel" : "update the details of " + id) : "add a channel to " + id;
    const body = [
      SCOUT_SOURCE_MARKER, "",
      "Please " + what + " in Scout (config/scout.json).", "",
      "```json", JSON.stringify(request, null, 2), "```", "",
      "This request was created from the ChangeSentinel dashboard."
    ].join("\n");
    const title = "[ChangeSentinel] Scout source: " + (isNew ? "add " + (name || id) : v.mode === "edit" ? "edit " + id : "add channel to " + id);
    return { errors, title, body, request };
  }

  /* ---------- Reporting items, dates, review decisions and exports ---------- */

  // One edited line as inline redline markup (struck before, underlined after).
  function renderWordEdit(before, after) { return renderSegments(wordDiff(before, after)); }

  // "1 added, 2 amended (RCON1234, RCON2170, …)": the line alerts carry, worded
  // exactly as regmon/item_codes.py describe() words it.
  function describeItemCodes(codes) {
    if (!codes || typeof codes !== "object") return "";
    const counts = codes.counts || {};
    const parts = ["added", "removed", "amended"].filter(key => counts[key]).map(key => counts[key] + " " + key);
    if (!parts.length) return "";
    let list = codes.codes;
    if (!Array.isArray(list)) list = [].concat(...["added", "removed", "amended"].map(key => (codes[key] || []).map(entry => entry.code)));
    const shown = list.slice(0, 4).join(", ") + (list.length > 4 ? ", …" : "");
    return parts.join(", ") + (shown ? " (" + shown + ")" : "");
  }

  /* ---------- Structured spec changes (regmon/spec_diff.py) ---------- */

  const SPEC_CATEGORIES = ["added", "added_version", "severity", "logic", "retired", "reinstated", "effective", "message",
    "definition", "description", "removed", "metadata", "cosmetic"];
  const SPEC_LABELS_BASE = {
    added: "New field", added_version: "New version of existing field", severity: "Severity changed", logic: "Derivation changed",
    retired: "Retired", reinstated: "Reinstated", effective: "Effective dates changed", message: "Message changed",
    definition: "Definition changed", description: "Description changed", removed: "Removed from file", metadata: "Metadata only", cosmetic: "Cosmetic only"
  };
  // Mirrors CATEGORY_LABELS in regmon/spec_diff.py.
  const SPEC_LABELS = {
    rules: Object.assign({}, SPEC_LABELS_BASE, { added: "New rule", added_version: "New version of existing rule", logic: "Logic changed" }),
    fields: SPEC_LABELS_BASE,
    concepts: Object.assign({}, SPEC_LABELS_BASE, { added: "New element", removed: "Element removed" }),
    types: Object.assign({}, SPEC_LABELS_BASE, { added: "New type", removed: "Type removed" }),
    codes: { added: "New code", removed: "Code removed", description: "Label changed", definition: "Definition changed", metadata: "Metadata only", cosmetic: "Cosmetic only" },
    labels: { added: "New label", removed: "Label removed", description: "Label changed", definition: "Definition changed", metadata: "Metadata only", cosmetic: "Cosmetic only" }
  };
  const SPEC_KIND_NOUNS = { rules: "Rule table", fields: "Field table", concepts: "Schema elements", types: "Schema types", codes: "Code list", labels: "Labels" };
  const SPEC_QUIET = ["metadata", "cosmetic"];
  function specCategoryLabel(kind, category) {
    const labels = SPEC_LABELS[kind] || SPEC_LABELS.fields;
    return labels[category] || SPEC_LABELS_BASE[category] || String(category || "");
  }
  // Group a table's changes by category in importance order; filter is
  // "all", "attention" (no metadata/cosmetic) or "mismatch".
  function specGroups(table, filter) {
    const changes = (table && Array.isArray(table.changes) ? table.changes : []).filter(change => change && typeof change === "object")
      .filter(change => filter === "attention" ? SPEC_QUIET.indexOf(change.category) < 0 : filter === "mismatch" ? !!change.mismatch : true);
    const order = SPEC_CATEGORIES.concat(Array.from(new Set(changes.map(change => change.category))).filter(name => SPEC_CATEGORIES.indexOf(name) < 0));
    return order.map(category => ({ category, label: specCategoryLabel(table.kind, category), changes: changes.filter(change => change.category === category) }))
      .filter(group => group.changes.length);
  }
  // "2 new, 1 retired (1 escalated) — 531 v1, …": the line alerts carry,
  // worded exactly as regmon/spec_diff.py describe() words it.
  function describeSpec(spec) {
    if (!spec || typeof spec !== "object") return "";
    const counts = spec.counts || {};
    if (spec.declared && !Object.keys(counts).length) return String(spec.headline || "");
    const names = [["added", "new"], ["added_version", "new versions"], ["severity", "severity changed"], ["logic", "logic changed"],
      ["retired", "retired"], ["reinstated", "reinstated"], ["effective", "dates changed"], ["message", "message changed"],
      ["definition", "redefined"], ["description", "description changed"], ["removed", "removed"]];
    const parts = names.filter(([key]) => counts[key]).map(([key, label]) => counts[key] + " " + (key === "added_version" && counts[key] === 1 ? "new version" : label));
    if (!parts.length) return "";
    const labels = Array.isArray(spec.labels) ? spec.labels : [];
    const shown = labels.slice(0, 4).join(", ") + (labels.length > 4 ? ", …" : "");
    let text = parts.join(", ");
    if (spec.escalated) text += " (" + spec.escalated + " escalated)";
    return text + (shown ? " — " + shown : "");
  }
  // One CSV row per changed item, for the analyst's own sign-off sheet.
  function specCsvRows(spec) {
    const rows = [["Table", "Category", "Item", "Field", "Effective", "Severity", "What changed", "Note", "Declared in file", "Mismatch", "Also"]];
    (spec && Array.isArray(spec.tables) ? spec.tables : []).forEach(table => {
      (Array.isArray(table.changes) ? table.changes : []).forEach(change => {
        const severity = change.severity ? change.severity.before + " → " + change.severity.after + " (" + change.severity.direction + ")" : "";
        const what = (Array.isArray(change.columns) ? change.columns : []).filter(column => column.kind !== "systematic")
          .map(column => column.column + ": " + (column.before || "(blank)") + " → " + (column.after || "(blank)")).join("; ") ||
          Object.keys(change.values || {}).map(key => key + ": " + change.values[key]).join(" · ");
        rows.push([table.name || "", specCategoryLabel(table.kind, change.category), change.label || "", change.field || "", change.effective || "",
          severity, what, change.note || "", change.declared || "", change.mismatch || "",
          (change.also || []).map(name => specCategoryLabel(table.kind, name)).join(", ")]);
      });
    });
    return rows;
  }

  /* ---------- Item registry (regmon/registry.py) ---------- */

  const REGISTRY_KIND_NOUNS = { table: ["table", "tables"], view: ["view", "views"], model: ["model", "models"], pipeline: ["pipeline", "pipelines"],
    report: ["report", "reports"], code: ["code path", "code paths"], check: ["check", "checks"], dashboard: ["dashboard", "dashboards"],
    submission: ["submission", "submissions"], other: ["asset", "assets"] };
  const REGISTRY_SCHEMES = { MDRM: "Federal Reserve MDRM", FRY14: "FR Y-14 data-dictionary field", FFIEC: "FFIEC Call Report item / edit",
    DPM: "EBA DPM data point / template cell", BIRD: "ECB BIRD variable", OSFI: "OSFI return data point (DPA, measure)",
    SUCAVE: "SBS Peru SUCAVE code", BCB5050: "Banco Central do Brasil document 5050 account", OTHER: "Other identifier" };
  const REGISTRY_CHANGE_WORDS = { added: "added", added_version: "new version", removed: "removed", amended: "amended", retired: "retired",
    reinstated: "reinstated", severity: "severity changed", logic: "logic changed", effective: "dates changed", message: "message changed",
    definition: "redefined", description: "relabelled", mentioned: "named in the change" };
  function registryNorm(code) { return String(code || "").replace(/\s+/g, "").toUpperCase(); }
  function globMatch(value, pattern) {
    const source = "^" + String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
    return new RegExp(source).test(value);
  }
  // The registry as the dashboard reads it, with lineage.json mappings folded in
  // as rules (mirrors regmon/registry.py load()).
  function registryModel(registry, lineage) {
    const consumers = new Map();
    const items = [];
    const rules = [];
    if (registry && typeof registry === "object") {
      (Array.isArray(registry.consumers) ? registry.consumers : []).forEach(consumer => {
        if (consumer && consumer.id) consumers.set(String(consumer.id), Object.assign({ kind: "other", name: consumer.id }, consumer));
      });
      (Array.isArray(registry.items) ? registry.items : []).forEach(item => {
        if (!item || !item.code) return;
        items.push(Object.assign({ scheme: "OTHER", aliases: [], equivalents: [], consumers: [] }, item));
      });
      (Array.isArray(registry.rules) ? registry.rules : []).forEach(rule => { if (rule && rule.match) rules.push(Object.assign({ consumers: [] }, rule)); });
    }
    (lineage && Array.isArray(lineage.mappings) ? lineage.mappings : []).forEach(mapping => {
      if (!mapping || typeof mapping !== "object") return;
      const ids = (Array.isArray(mapping.assets) ? mapping.assets : []).map(asset => {
        const id = "lineage:" + String(asset).replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 70);
        if (!consumers.has(id)) consumers.set(id, { id, kind: "other", name: String(asset), owner: String(mapping.owner || ""), note: String(mapping.note || "") });
        return id;
      });
      (mapping.codes || []).forEach(code => rules.push({ match: code, scheme: "MDRM", consumers: ids }));
      (mapping.series || []).forEach(series => rules.push({ match: series + "*", scheme: "MDRM", consumers: ids }));
    });
    const byCode = new Map();
    items.forEach(item => [item.code].concat(item.aliases || []).forEach(name => {
      const key = registryNorm(name);
      if (!byCode.has(key)) byCode.set(key, []);
      if (byCode.get(key).indexOf(item) < 0) byCode.get(key).push(item);
    }));
    return { consumers, items, rules, byCode };
  }
  function registryConsumerLink(consumer) {
    if (!consumer) return "";
    if (consumer.url) return String(consumer.url);
    if (consumer.repo && consumer.path) return "https://github.com/" + consumer.repo + "/blob/" + (consumer.ref || "HEAD") + "/" + String(consumer.path).replace(/^\/+/, "");
    return "";
  }
  function registryRuleConsumers(model, code, scheme) {
    const value = registryNorm(code);
    const out = [];
    model.rules.forEach(rule => {
      if (rule.scheme && scheme && rule.scheme !== scheme) return;
      if (globMatch(value, registryNorm(rule.match))) (rule.consumers || []).forEach(id => { if (out.indexOf(id) < 0) out.push(id); });
    });
    return out;
  }
  function registryQuarterKey(quarter) {
    const match = /Q(\d) (\d{4})/.exec(quarter || "");
    return match ? Number(match[2]) * 10 + Number(match[1]) : 99999;
  }
  function registryQuarterOf(value) {
    const text = String(value || "");
    let match = /\b(?:Q([1-4])\s*(20\d\d)|(20\d\d)\s*Q([1-4]))\b/i.exec(text);
    if (match) return "Q" + (match[1] || match[4]) + " " + (match[2] || match[3]);
    match = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(text);
    return match ? "Q" + (Math.floor((Number(match[2]) - 1) / 3) + 1) + " " + match[1] : "";
  }
  // What a change touched (mirrors touched_codes): item codes, then spec rows.
  function registryTouched(itemCodes, spec) {
    const touched = new Map();
    const add = (code, change, quarter, effective) => {
      code = String(code || "").replace(/\s+/g, " ").trim();
      if (!code) return;
      const key = registryNorm(code);
      if (touched.has(key) && touched.get(key).change !== "mentioned") return;
      touched.set(key, { code, change, quarter: quarter || "", effective: effective || "" });
    };
    ["added", "removed", "amended"].forEach(kind => ((itemCodes && itemCodes[kind]) || []).forEach(entry => { if (entry && entry.code) add(entry.code, kind); }));
    ((spec && spec.tables) || []).forEach(table => (table.changes || []).forEach(change => {
      if (change.category === "metadata" || change.category === "cosmetic") return;
      let code = change.field || (["fields", "concepts", "codes"].indexOf(table.kind) >= 0 ? change.label : "");
      if (table.kind === "concepts" && code) code = String(code).split("/").pop();
      add(code, change.category || "amended", change.quarter || registryQuarterOf(change.effective), change.effective);
    }));
    return Array.from(touched.values());
  }
  function registryWhere(item) {
    if (item.form && item.schedule) return item.form + " " + item.schedule;
    return item.form || item.schedule || REGISTRY_SCHEMES[item.scheme] || item.scheme || "";
  }
  // Registered items a change touched, who reads them, and the sentence (mirrors impact()).
  function registryImpact(touched, model, effective) {
    if (!Array.isArray(touched) || !touched.length || !model) return null;
    const items = [];
    const consumers = new Map();
    const unregistered = [];
    touched.forEach(entry => {
      const matches = model.byCode.get(registryNorm(entry.code)) || [];
      const ruleIds = registryRuleConsumers(model, entry.code, matches.length ? matches[0].scheme : "");
      if (!matches.length && !ruleIds.length) { unregistered.push(entry.code); return; }
      const records = matches.length ? matches : [{ code: entry.code, scheme: "", jurisdiction: "", form: "", schedule: "", line: "", label: "", equivalents: [], consumers: [], owner: "" }];
      records.forEach(record => {
        const ids = Array.from(new Set((record.consumers || []).concat(ruleIds)));
        items.push({ code: record.code, scheme: record.scheme || "", jurisdiction: record.jurisdiction || "", form: record.form || "", schedule: record.schedule || "",
          line: record.line || "", label: record.label || "", registered: !!matches.length, equivalents: record.equivalents || [], change: entry.change,
          quarter: entry.quarter || "", effective: entry.effective || "", consumers: ids, owner: record.owner || "" });
        ids.forEach(id => {
          const consumer = model.consumers.get(id);
          if (!consumer) return;
          if (!consumers.has(id)) consumers.set(id, Object.assign({}, consumer, { link: registryConsumerLink(consumer), codes: [] }));
          const row = consumers.get(id);
          if (row.codes.indexOf(record.code) < 0) row.codes.push(record.code);
        });
      });
    });
    const result = { items, consumers: Array.from(consumers.values()), unregistered, unregistered_count: unregistered.length };
    result.sentence = registrySentence(result, effective || "");
    return result;
  }
  function registrySentence(result, effective) {
    const items = (result && result.items) || [];
    if (!items.length) return "";
    const groups = new Map();
    items.forEach(item => { const where = registryWhere(item) || "registered items"; if (!groups.has(where)) groups.set(where, []); groups.get(where).push(item); });
    const fallback = registryQuarterOf(effective);
    const parts = [];
    Array.from(groups.entries()).slice(0, 3).forEach(([where, group]) => {
      const many = group.length > 1;
      const changes = new Set(group.map(item => item.change));
      const quarters = Array.from(new Set(group.map(item => item.quarter).filter(Boolean))).sort((a, b) => registryQuarterKey(a) - registryQuarterKey(b));
      const when = quarters[0] || fallback;
      const only = allowed => Array.from(changes).every(change => allowed.indexOf(change) >= 0);
      const head = many ? "These " + group.length + " fields" : "This field";
      const codes = group.slice(0, 6).map(item => item.code).join(", ") + (group.length > 6 ? ", …" : "");
      if (only(["retired", "removed"])) parts.push(head + " in " + where + " " + (many ? "are" : "is") + " retired" + (when && changes.has("retired") ? " (last reported " + when + ")" : "") + ": " + codes);
      else if (only(["added", "added_version"])) parts.push(head + " in " + where + " " + (many ? "are" : "is") + " new" + (when ? " from " + when : "") + ": " + codes);
      else if (changes.size === 1 && changes.has("mentioned")) parts.push(head + " in " + where + " " + (many ? "are" : "is") + " named in the change: " + codes);
      else if (!["retired", "removed", "added", "added_version"].some(kind => changes.has(kind))) parts.push(head + " in " + where + " " + (many ? "change" : "changes") + (when ? " from " + when : "") + ": " + codes);
      else {
        const clauses = [];
        [["retired", ["retired", "removed"], "is retired", "are retired"], ["new", ["added", "added_version"], "is new", "are new"], ["changed", null, "changes", "change"]].forEach(([label, kinds, one, more]) => {
          const members = group.filter(item => kinds ? kinds.indexOf(item.change) >= 0 : ["retired", "removed", "added", "added_version"].indexOf(item.change) < 0);
          if (!members.length) return;
          const memberQuarters = Array.from(new Set(members.map(item => item.quarter).filter(Boolean))).sort((a, b) => registryQuarterKey(a) - registryQuarterKey(b));
          const memberWhen = memberQuarters[0] || (label !== "retired" ? fallback : "");
          const suffix = memberWhen ? (label === "retired" ? " (last reported " + memberWhen + ")" : " from " + memberWhen) : "";
          const names = members.slice(0, 4).map(item => item.code).join(", ") + (members.length > 4 ? ", …" : "");
          clauses.push(names + " " + (members.length > 1 ? more : one) + suffix);
        });
        parts.push(head + " in " + where + " change: " + clauses.join("; "));
      }
    });
    if (groups.size > 3) parts.push((groups.size - 3) + " more forms or schedules are affected");
    let text = parts.join(". ") + ".";
    const consumers = result.consumers || [];
    if (consumers.length) {
      const byKind = new Map();
      consumers.forEach(consumer => { if (!byKind.has(consumer.kind)) byKind.set(consumer.kind, []); byKind.get(consumer.kind).push(consumer.name); });
      const bits = Array.from(byKind.entries()).map(([kind, names]) => {
        const nouns = REGISTRY_KIND_NOUNS[kind] || REGISTRY_KIND_NOUNS.other;
        return names.length + " " + (names.length === 1 ? nouns[0] : nouns[1]) + " (" + names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "") + ")";
      });
      text += " " + (items.length === 1 ? "It is" : "They are") + " read by " + (bits.length > 1 ? bits.slice(0, -1).join(", ") + " and " + bits[bits.length - 1] : bits[0]) + ".";
    } else {
      text += " No consumer is mapped yet.";
    }
    const equivalents = Array.from(new Set([].concat(...items.map(item => item.equivalents || []))));
    if (equivalents.length) text += " Equivalent items elsewhere: " + equivalents.slice(0, 4).join(", ") + (equivalents.length > 4 ? ", …" : "") + ".";
    return text.slice(0, 900);
  }
  // Codes a timeline entry is known to have touched (from its stored summaries).
  function registryEntryCodes(entry) {
    const codes = [];
    const add = code => { const key = registryNorm(code); if (key && codes.indexOf(key) < 0) codes.push(key); };
    if (entry && entry.impact && Array.isArray(entry.impact.codes)) entry.impact.codes.forEach(add);
    if (entry && entry.item_codes && Array.isArray(entry.item_codes.codes)) entry.item_codes.codes.forEach(add);
    if (entry && entry.spec && Array.isArray(entry.spec.fields)) entry.spec.fields.forEach(add);
    return codes;
  }

  /* ---------- Measured precision (regmon/precision.py) ---------- */

  const PRECISION_POSITIVE = ["material", "action_required"];
  const PRECISION_NEGATIVE = ["not_material"];
  const PRECISION_ALERTABLE = ["CHANGED_URL", "NEW_URL", "REMOVED_URL", "VISUAL_CHANGED"];
  const PRECISION_SCORED = PRECISION_ALERTABLE.concat(["HTML_SOURCE_CHANGED"]);
  const PRECISION_QUIET = ["ai_irrelevant", "condition_not_met"];
  const PRECISION_STOPWORDS = new Set(("a an and are as at be been by for from has have in into is it its of on or that the this to was were will with not no new " +
    "change changes changed update updates updated page pages webpage website site content text entry entries item items section " +
    "document documents file files link links list removal removed added addition date dates version minor federal reserve board " +
    "regulator regulatory report reports reporting form forms the www html pdf xlsx after before about other its their than also").split(/\s+/));
  function round3(value) { return Math.round(value * 1000) / 1000; }
  function wilson(successes, total) {
    if (total <= 0) return null;
    const z = 1.96, p = successes / total, denominator = 1 + z * z / total;
    const centre = (p + z * z / (2 * total)) / denominator;
    const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
    return [round3(Math.max(0, centre - margin)), round3(Math.min(1, centre + margin))];
  }
  function precisionAlerted(eventId, sent) {
    for (const key of [eventId, eventId + "#ai"]) {
      if (!Object.prototype.hasOwnProperty.call(sent || {}, key)) continue;
      const record = sent[key];
      const variant = record && typeof record === "object" ? record.variant : null;
      if (PRECISION_QUIET.indexOf(variant) >= 0) continue;
      return [true, String(variant || "alert")];
    }
    return [false, ""];
  }
  function precisionOutcomes(inventory, sent, ledger, sources) {
    const shadow = new Set((sources || []).filter(source => source && source.shadow === true).map(source => String(source.id)));
    const reviews = (ledger && ledger.reviews) || {};
    const rows = new Map();
    Object.entries((inventory && inventory.sources) || {}).forEach(([sourceId, group]) => {
      if (!group || typeof group !== "object") return;
      Object.values(group).forEach(item => {
        if (!item || typeof item !== "object") return;
        (item.change_history || []).forEach(entry => {
          if (!entry || PRECISION_SCORED.indexOf(entry.event_type) < 0 || !entry.event_id) return;
          const eventId = String(entry.event_id);
          if (rows.has(eventId)) return;
          let [alerted, variant] = PRECISION_ALERTABLE.indexOf(entry.event_type) >= 0 ? precisionAlerted(eventId, sent || {}) : [false, ""];
          if (!alerted && shadow.has(String(sourceId)) && PRECISION_ALERTABLE.indexOf(entry.event_type) >= 0) {
            alerted = entry.ai_relevant === true || entry.ai_condition_met === true;
            variant = alerted ? "would_alert" : "";
          }
          const review = reviews[eventId] && typeof reviews[eventId] === "object" ? reviews[eventId] : null;
          const decision = review ? review.decision : null;
          const outcome = PRECISION_POSITIVE.indexOf(decision) >= 0 ? (alerted ? "tp" : "fn")
            : PRECISION_NEGATIVE.indexOf(decision) >= 0 ? (alerted ? "fp" : "tn") : (alerted ? "unreviewed_alert" : "unreviewed");
          rows.set(eventId, { event_id: eventId, source_id: String(sourceId), event_type: entry.event_type, timestamp: entry.timestamp,
            url: item.canonical_url, alerted, variant, decision: decision === undefined ? null : decision, outcome,
            ai_relevant: entry.ai_relevant === undefined ? null : entry.ai_relevant, condition_met: entry.ai_condition_met === undefined ? null : entry.ai_condition_met,
            topic: String(entry.ai_topic || ""), summary: String(entry.ai_summary || ""), rationale: String((review && review.rationale) || "") });
        });
      });
    });
    return Array.from(rows.values()).sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  }
  function precisionScores(rows, misses) {
    const counts = new Map();
    const bump = (id, key) => { if (!counts.has(id)) counts.set(id, {}); const c = counts.get(id); c[key] = (c[key] || 0) + 1; };
    rows.forEach(row => bump(row.source_id, row.outcome));
    (misses || []).forEach(miss => { if (miss && miss.source_id) bump(String(miss.source_id), "missed"); });
    const out = {};
    counts.forEach((c, id) => {
      const tp = c.tp || 0, fp = c.fp || 0, fn = c.fn || 0, tn = c.tn || 0, missed = c.missed || 0;
      const precision = tp + fp ? round3(tp / (tp + fp)) : null;
      const recall = tp + fn + missed ? round3(tp / (tp + fn + missed)) : null;
      out[id] = { tp, fp, fn, tn, missed, alerts: tp + fp + (c.unreviewed_alert || 0), unreviewed_alerts: c.unreviewed_alert || 0,
        reviewed: tp + fp + fn + tn, unreviewed: c.unreviewed || 0, precision, precision_ci: wilson(tp, tp + fp),
        recall, recall_ci: wilson(tp, tp + fn + missed), f1: precision && recall ? round3(2 * precision * recall / (precision + recall)) : null };
    });
    return out;
  }
  function precisionWords(text) {
    return (String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter(word => !PRECISION_STOPWORDS.has(word) && !/^\d+$/.test(word));
  }
  function precisionDistinct(group, other, limit) {
    if (!group.length) return [];
    const otherWords = new Set([].concat(...other.map(row => precisionWords(row.topic + " " + row.summary))));
    const counts = new Map();
    const order = [];
    group.forEach(row => Array.from(new Set(precisionWords(row.topic + " " + row.summary))).forEach(word => {
      if (!counts.has(word)) { counts.set(word, 0); order.push(word); }
      counts.set(word, counts.get(word) + 1);
    }));
    const needed = group.length >= 2 ? 2 : 1;
    // Most frequent first; ties keep first-seen order (as Python's Counter.most_common).
    return order.map((word, index) => [word, counts.get(word), index]).sort((a, b) => b[1] - a[1] || a[2] - b[2])
      .filter(([word, count]) => !otherWords.has(word) && count >= needed).map(([word]) => word).slice(0, limit || 3);
  }
  function precisionJoin(words) { return words.length === 1 ? words[0] : words.slice(0, -1).join(", ") + " or " + words[words.length - 1]; }
  function precisionSuggestions(source, rows, score) {
    if (!score) return [];
    const out = [];
    source = source || {};
    const condition = String(source.alert_condition || "").split(/\s+/).filter(Boolean).join(" ");
    const only = !!source.alert_only_on_condition;
    const tps = rows.filter(row => row.outcome === "tp"), fps = rows.filter(row => row.outcome === "fp"), fns = rows.filter(row => row.outcome === "fn");
    const noise = precisionDistinct(fps, tps.concat(fns)), signal = precisionDistinct(tps.concat(fns), fps), hidden = precisionDistinct(fns, fps);
    const trimEnd = text => text.replace(/[. ]+$/, "");
    if (fps.length >= 2 && (score.precision === null || score.precision < 0.6)) {
      const generic = fps.filter(row => row.variant === "generic").length;
      if (!condition) {
        let text = signal.length ? "Alert me when the change concerns " + precisionJoin(signal) + "." : "Alert me when requirements, deadlines, data items or validation rules change.";
        if (noise.length) text += " Ignore changes about " + precisionJoin(noise) + ".";
        out.push({ kind: "add_condition", title: "Add an alert condition",
          why: fps.length + " of " + (score.tp + score.fp) + " reviewed alerts were not material" + (noise.length ? "; they kept mentioning " + precisionJoin(noise) : "") + ".",
          condition: text.slice(0, 500), only: fps.length >= 3 });
      } else if (fps.some(row => row.condition_met === true)) {
        const text = trimEnd(condition) + "." + (noise.length ? " Ignore changes about " + precisionJoin(noise) + "." : " Only when it changes what must be reported or by when.");
        out.push({ kind: "narrow_condition", title: "Narrow the alert condition",
          why: "The condition was met on " + fps.filter(row => row.condition_met === true).length + " change(s) reviewed as not material.", condition: text.slice(0, 500), only });
      }
      if (generic) out.push({ kind: "ai_unavailable", title: "Some false alarms were technical-change alerts",
        why: "AI review was unavailable for " + generic + " of the false alarms, so the change alerted without being read. Nothing to change in the condition; check the AI Smoke Test if this keeps happening." });
    }
    if (fns.length) {
      const suppressed = fns.filter(row => row.condition_met === false);
      if (condition && only && suppressed.length) {
        const text = trimEnd(condition) + "." + (hidden.length ? " Also alert when it concerns " + precisionJoin(hidden) + "." : "");
        out.push({ kind: "broaden_condition", title: "Broaden the alert condition",
          why: suppressed.length + " material change(s) stayed quiet because the condition was not met.", condition: text.slice(0, 500), only: hidden.length ? only : false });
      } else if (!condition && out.some(tip => tip.kind === "add_condition")) {
        const tip = out.find(candidate => candidate.kind === "add_condition");
        tip.why += " It would also have alerted on " + fns.length + " material change(s) that stayed quiet.";
      } else if (!condition) {
        const text = "Alert me when the change concerns " + (hidden.length ? precisionJoin(hidden) : "requirements, deadlines or data items") + ".";
        out.push({ kind: "add_condition", title: "Name what must always alert",
          why: fns.length + " material change(s) were judged not relevant and stayed quiet. A condition makes these alert whatever the general relevance.",
          condition: text.slice(0, 500), only: false });
      }
    }
    if (score.missed) {
      const every = source.check_every_hours;
      out.push({ kind: "missed", title: "Changes were missed", why: score.missed + " change(s) were reported as missed. Check the monitor's scope and selectors" +
        (typeof every === "number" && every > 6 ? ", and whether scanning every " + every + " hours is often enough" : "") + "." });
    }
    if (score.fp >= 5 && score.tp === 0 && !source.shadow) out.push({ kind: "shadow", title: "Consider shadow mode",
      why: "None of " + score.fp + " reviewed alerts was material. Shadow mode keeps recording changes without sending them." });
    return out;
  }
  function precisionBuild(inventory, sent, ledger, sources) {
    const rows = precisionOutcomes(inventory, sent, ledger, sources);
    const misses = ((ledger && ledger.misses) || []).filter(miss => miss && typeof miss === "object");
    const perSource = precisionScores(rows, misses);
    const byId = new Map((sources || []).filter(Boolean).map(source => [String(source.id), source]));
    const monitors = Object.entries(perSource).map(([id, score]) => Object.assign({ source_id: id, name: (byId.get(id) || {}).name || id }, score,
      { suggestions: precisionSuggestions(byId.get(id) || {}, rows.filter(row => row.source_id === id), score) }));
    const totals = precisionScores(rows.map(row => Object.assign({}, row, { source_id: "all" })), misses.map(miss => Object.assign({}, miss, { source_id: "all" }))).all || null;
    monitors.sort((a, b) => (b.reviewed + b.missed) - (a.reviewed + a.missed) || String(a.name).localeCompare(String(b.name)));
    return { schema_version: 1, monitors, totals, outcomes: rows.slice(0, 500) };
  }
  const MISSED_CHANGE_MARKER = "<!-- changesentinel:missed-change:v1 -->";
  function missedChangeRequest(values) {
    const v = values || {};
    const errors = [];
    const monitor = oneLine(v.monitor, 120), url = oneLine(v.url, 600), seen = oneLine(v.seenOn, 10), what = oneLine(v.what, 600), evidence = oneLine(v.evidence, 600);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(monitor)) errors.push("This monitor has no id that can be reported against.");
    if (url && !/^https?:\/\/\S+$/.test(url)) errors.push("The page must be a link beginning with https://.");
    if (evidence && !/^https?:\/\/\S+$/.test(evidence)) errors.push("The evidence must be a link beginning with https://.");
    if (seen && !/^\d{4}-\d{2}-\d{2}$/.test(seen)) errors.push("Seen on must be a date such as 2026-10-20.");
    if (what.length < 10) errors.push("Say what was missed (at least 10 characters).");
    const body = [MISSED_CHANGE_MARKER, "", "Please record this missed change.", "", "Monitor: " + monitor, "URL: " + (url || "(none)"),
      "Seen on: " + (seen || "(none)"), "What was missed: " + what, "Evidence: " + (evidence || "(none)"), "",
      "Only requests opened by the repository owner are recorded. A missed change counts against the monitor's recall.", "",
      "This request was created from the ChangeSentinel dashboard."].join("\n");
    return { errors, title: "[ChangeSentinel] Change review: missed change on " + monitor, body };
  }

  /* ---------- Recorded browser steps (regmon/browser_actions.py) ---------- */

  const BROWSER_ACTIONS = ["click", "type", "select", "check", "uncheck", "press", "scroll", "wait", "wait_for"];
  const BROWSER_KEYS = ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"];
  // Mirrors validate_actions(): the steps in canonical form, or the first problem.
  function validateBrowserSteps(value) {
    if (value === null || value === undefined || (Array.isArray(value) && !value.length)) return { steps: [], error: "" };
    if (!Array.isArray(value)) return { steps: [], error: "Steps must be a list." };
    if (value.length > 20) return { steps: [], error: "At most 20 steps." };
    const steps = [];
    let wait = 0;
    const okSelector = text => typeof text === "string" && text.trim() && text.length <= 200 && !/[\r\n]/.test(text);
    for (let index = 0; index < value.length; index += 1) {
      const step = value[index];
      const at = "Step " + (index + 1) + ": ";
      if (!step || typeof step !== "object" || Array.isArray(step)) return { steps: [], error: at + "must be an object." };
      if (BROWSER_ACTIONS.indexOf(step.action) < 0) return { steps: [], error: at + "action must be one of " + BROWSER_ACTIONS.join(", ") + "." };
      const clean = { action: step.action };
      const needs = ["click", "type", "select", "check", "uncheck", "wait_for"].indexOf(step.action) >= 0;
      if (needs || step.selector !== undefined) {
        if (!okSelector(step.selector)) return { steps: [], error: at + "needs a CSS selector of at most 200 characters." };
        if (step.action !== "wait") clean.selector = step.selector.trim();
      }
      if (step.action === "type") {
        if (typeof step.text !== "string" || step.text.length > 200 || /[\r\n]/.test(step.text)) return { steps: [], error: at + "text must be one line of at most 200 characters." };
        clean.text = step.text;
      }
      if (step.action === "select") {
        if (typeof step.value !== "string" || !step.value || step.value.length > 200) return { steps: [], error: at + "needs the option's value or text." };
        clean.value = step.value;
      }
      if (step.action === "press") {
        const key = step.key === undefined ? "Enter" : step.key;
        if (BROWSER_KEYS.indexOf(key) < 0) return { steps: [], error: at + "key must be one of " + BROWSER_KEYS.join(", ") + "." };
        clean.key = key;
      }
      if (step.action === "wait" || step.action === "wait_for") {
        const seconds = step.seconds === undefined ? (step.action === "wait_for" ? 10 : 1) : step.seconds;
        if (typeof seconds !== "number" || !(seconds > 0 && seconds <= 30)) return { steps: [], error: at + "seconds must be more than 0 and at most 30." };
        clean.seconds = seconds;
        wait += seconds;
      }
      if (typeof step.note === "string" && step.note) clean.note = step.note.slice(0, 200);
      steps.push(clean);
    }
    if (wait > 90) return { steps: [], error: "The steps wait " + wait + " seconds in total; the limit is 90." };
    return { steps, error: "" };
  }
  function describeBrowserStep(step) {
    const target = step.selector || "";
    switch (step.action) {
      case "click": return "Click " + target;
      case "type": return "Type “" + step.text + "” into " + target;
      case "select": return "Choose “" + step.value + "” in " + target;
      case "check": return "Tick " + target;
      case "uncheck": return "Untick " + target;
      case "press": return "Press " + (step.key || "Enter") + (target ? " in " + target : "");
      case "scroll": return target ? "Scroll to " + target : "Scroll to the bottom";
      case "wait": return "Wait " + (step.seconds || 1) + " s";
      case "wait_for": return "Wait up to " + (step.seconds || 10) + " s for " + target;
      default: return String(step.action || "");
    }
  }
  // The recorder: run on the portal (as a bookmarklet) in the reviewer's own
  // browser, it writes down clicks, choices and typing as steps. It keeps the
  // steps across page loads in that tab (click the bookmarklet again after a
  // page loads), never records what is typed into a password field, and only
  // copies the list; it sends nothing anywhere.
  const RECORDER_SOURCE = String.raw`(()=>{const K="cs-recorder-steps";if(window.__csRec){window.__csRec.show();return}
let steps=[];try{steps=JSON.parse(sessionStorage.getItem(K)||"[]")}catch(e){}
const q=v=>window.CSS&&CSS.escape?CSS.escape(v):String(v).replace(/[^\w-]/g,"\\$&");
const one=s=>{try{return document.querySelectorAll(s).length===1}catch(e){return false}};
const sel=el=>{if(el.id&&one("#"+q(el.id)))return"#"+q(el.id);for(const a of["name","data-testid","aria-label","title","value"]){const v=el.getAttribute&&el.getAttribute(a);if(v&&v.length<80){const s=el.tagName.toLowerCase()+"["+a+"=\""+v.replace(/"/g,"\\\"")+"\"]";if(one(s))return s}}const parts=[];let n=el;while(n&&n.nodeType===1&&n!==document.body&&parts.length<6){if(n.id&&one("#"+q(n.id))){parts.unshift("#"+q(n.id));break}let p=n.tagName.toLowerCase();const sib=n.parentElement?Array.from(n.parentElement.children).filter(c=>c.tagName===n.tagName):[];if(sib.length>1)p+=":nth-of-type("+(sib.indexOf(n)+1)+")";parts.unshift(p);n=n.parentElement}return parts.join(" > ")};
const box=document.createElement("div");box.setAttribute("data-cs-recorder","");box.style.cssText="position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;max-height:50vh;overflow:auto;background:#1c130d;color:#fff4e4;font:13px/1.45 system-ui,sans-serif;border:1px solid #4a3626;box-shadow:0 12px 40px rgba(0,0,0,.4);padding:12px";
const say=t=>{const m=box.querySelector("[data-m]");if(m)m.textContent=t};
const render=()=>{box.innerHTML="<b style=\"color:#ff9f1c\">ChangeSentinel recorder</b> · "+steps.length+" step"+(steps.length===1?"":"s")+"<ol style=\"margin:8px 0;padding-left:18px\">"+steps.map(s=>"<li>"+(s.action+" "+(s.selector||"")+(s.value?" = "+s.value:"")+(s.text!==undefined?" = "+s.text:"")).replace(/[<&]/g,c=>c==="<"?"&lt;":"&amp;")+"</li>").join("")+"</ol><div data-m style=\"color:#a08a74\">Use the page as usual. Steps are kept in this tab.</div><p style=\"display:flex;gap:8px;margin:8px 0 0\"><button data-a=\"copy\">Copy steps</button><button data-a=\"wait\">+ Wait for…</button><button data-a=\"undo\">Undo</button><button data-a=\"clear\">Clear</button><button data-a=\"stop\">Stop</button></p>"};
const save=()=>{try{sessionStorage.setItem(K,JSON.stringify(steps))}catch(e){}render()};
const add=s=>{const last=steps[steps.length-1];if(last&&s.action==="type"&&last.action==="type"&&last.selector===s.selector)steps.pop();steps.push(s);save()};
const mine=e=>e.target&&e.target.closest&&e.target.closest("[data-cs-recorder]");
const onClick=e=>{if(mine(e)){const a=e.target.getAttribute("data-a");if(!a)return;e.preventDefault();if(a==="copy"){const t=JSON.stringify(steps,null,2);(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>say("Copied. Paste into Steps before reading."),()=>{prompt("Copy the steps:",t)})}if(a==="undo"){steps.pop();save()}if(a==="clear"){steps=[];save()}if(a==="wait"){const s=prompt("CSS selector of what to wait for (for example table.results):");if(s)add({action:"wait_for",selector:s,seconds:10})}if(a==="stop")stop();return}
const t=e.target;if(!(t instanceof Element))return;const tag=t.tagName.toLowerCase(),type=String(t.type||"").toLowerCase();
if(tag==="select"||tag==="option"||tag==="textarea"||(tag==="input"&&["checkbox","radio","submit","button","image","reset"].indexOf(type)<0))return;
if(tag==="input"&&(type==="checkbox"||type==="radio")){add({action:t.checked?"check":"uncheck",selector:sel(t)});return}
const target=t.closest("a,button,[role=button],[role=tab],[role=option],[role=menuitem],input[type=submit],summary,label,[onclick]")||t;add({action:"click",selector:sel(target)})};
const onChange=e=>{if(mine(e))return;const t=e.target;if(!(t instanceof Element))return;const tag=t.tagName.toLowerCase(),type=String(t.type||"").toLowerCase();
if(tag==="select"){add({action:"select",selector:sel(t),value:t.value});return}
if((tag==="input"&&["checkbox","radio","submit","button","image","reset","file"].indexOf(type)<0)||tag==="textarea"){if(type==="password"){say("Password fields are never recorded.");return}add({action:"type",selector:sel(t),text:String(t.value).slice(0,200)})}};
const onKey=e=>{if(mine(e))return;if(e.key==="Enter"&&e.target instanceof Element&&e.target.tagName==="INPUT"&&String(e.target.type||"").toLowerCase()!=="password"){onChange(e);add({action:"press",key:"Enter",selector:sel(e.target)})}};
const stop=()=>{document.removeEventListener("click",onClick,true);document.removeEventListener("change",onChange,true);document.removeEventListener("keydown",onKey,true);box.remove();delete window.__csRec};
document.addEventListener("click",onClick,true);document.addEventListener("change",onChange,true);document.addEventListener("keydown",onKey,true);
window.__csRec={show:()=>{if(!box.isConnected)document.body.appendChild(box);render()},steps:()=>steps.slice()};window.__csRec.show()})();`;
  function recorderBookmarklet() { return "javascript:" + encodeURIComponent(RECORDER_SOURCE); }

  // What config/lineage.json says consumes an item code: exact-code mappings
  // before whole-series ones, each asset once. Mirrors regmon/lineage.py assets_for.
  function lineageFor(code, lineage) {
    const value = String(code || "").toUpperCase();
    const mappings = lineage && Array.isArray(lineage.mappings) ? lineage.mappings.filter(mapping => mapping && typeof mapping === "object") : [];
    const out = [];
    const seen = new Set();
    [true, false].forEach(exact => {
      mappings.forEach(mapping => {
        const keys = exact ? mapping.codes : mapping.series;
        if (!Array.isArray(keys) || keys.indexOf(exact ? value : value.slice(0, 4)) < 0) return;
        (Array.isArray(mapping.assets) ? mapping.assets : []).forEach(asset => {
          const name = String(asset || "").trim();
          if (!name || seen.has(name)) return;
          seen.add(name);
          out.push({ asset: name, owner: String(mapping.owner || ""), via: exact ? value : value.slice(0, 4) + "*" });
        });
      });
    });
    return out;
  }

  // Calendar dates are plain days ("2027-03-31"). They are compared as days in
  // the viewer's own calendar, never parsed as UTC midnight (which shows the
  // day before anywhere west of Greenwich).
  const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
  function localIsoDate(date) {
    const d = date instanceof Date ? date : new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function isoDayToDate(iso) {
    const match = ISO_DAY.exec(String(iso || ""));
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  }
  function daysBetween(fromIso, toIso) {
    const from = ISO_DAY.exec(String(fromIso || "")), to = ISO_DAY.exec(String(toIso || ""));
    if (!from || !to) return null;
    return Math.round((Date.UTC(+to[1], +to[2] - 1, +to[3]) - Date.UTC(+from[1], +from[2] - 1, +from[3])) / 86400000);
  }
  function dueLabel(dateIso, todayIso) {
    const days = daysBetween(todayIso, dateIso);
    if (days === null) return "";
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days === -1) return "Yesterday";
    return days > 0 ? "In " + days + " days" : days * -1 + " days ago";
  }
  function calendarList(calendar) {
    return calendar && Array.isArray(calendar.entries)
      ? calendar.entries.filter(entry => entry && typeof entry === "object" && ISO_DAY.test(String(entry.date || "")))
      : [];
  }
  function upcomingDates(calendar, todayIso, limit) {
    return calendarList(calendar).filter(entry => entry.date >= todayIso)
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.title || "").localeCompare(String(b.title || "")))
      .slice(0, limit || 5);
  }
  function datesForChange(calendar, eventId) {
    return calendarList(calendar).filter(entry => entry.event_id === eventId).sort((a, b) => a.date.localeCompare(b.date));
  }

  // The body regmon/reviews.py parses: one Decision, Rationale, Owner and Ticket
  // line, then one "- <event id> | <url>" line per change.
  const CHANGE_REVIEW_MARKER = "<!-- changesentinel:change-review:v1 -->";
  const REVIEW_DECISIONS = { material: "Material", not_material: "Not material", acknowledged: "Acknowledged", action_required: "Action required" };
  function changeReviewRequest(values) {
    const v = values || {};
    const errors = [];
    const decision = Object.prototype.hasOwnProperty.call(REVIEW_DECISIONS, v.decision) ? v.decision : "";
    const rationale = oneLine(v.rationale, 600);
    const owner = oneLine(v.owner, 600);
    const ticket = oneLine(v.ticket, 600);
    const changes = (Array.isArray(v.changes) ? v.changes : []).filter(change => change && /^[0-9a-f]{64}$/.test(String(change.event_id || "")));
    if (!decision) errors.push("Choose a decision.");
    if (decision === "not_material" && rationale.length < 10) errors.push("Say why the change is not material (at least 10 characters).");
    if (ticket && !/^https?:\/\/\S+$/.test(ticket)) errors.push("The ticket must be a link beginning with https://.");
    if (!changes.length) errors.push("This change has no recorded identifier, so it can't be reviewed.");
    if (changes.length > 50) errors.push("Review at most 50 changes in one request.");
    const lines = [
      CHANGE_REVIEW_MARKER, "",
      "Please record this review decision.", "",
      "Decision: " + decision.replace("_", " "),
      "Rationale: " + (rationale || "(none)"),
      "Owner: " + (owner || "(none)"),
      "Ticket: " + (ticket || "(none)"), "",
      "Changes:"
    ];
    changes.forEach(change => {
      const url = String(change.url || "");
      lines.push("- " + change.event_id + (url && !/\s/.test(url) ? " | " + url : ""));
    });
    lines.push("", "Only requests opened by the repository owner are recorded. Earlier decisions stay in the ledger's log.", "",
      "This request was created from the ChangeSentinel dashboard.");
    return {
      errors,
      title: "[ChangeSentinel] Change review: " + (REVIEW_DECISIONS[decision] || "decision") + (changes.length > 1 ? " (" + changes.length + ")" : ""),
      body: lines.join("\n")
    };
  }

  // A spreadsheet runs a cell that starts with =, +, - or @ as a formula. Page
  // titles and quotes come from outside sites, so such cells are prefixed with
  // an apostrophe (OWASP's CSV-injection advice) before quoting.
  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) || text !== text.trim() ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  function toCsv(rows) { return rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n"; }
  function fileSlug(text, max) {
    return String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max || 48).replace(/-+$/, "") || "change";
  }

  /* ---------- Add a link: links found by exploring or following a page ----------
   *
   * The dialog collects links two ways (exploring a page, or following its
   * links by level) and ends in one checklist. Nothing here ranks, hides or
   * approves a link: what is shown is what the pages linked to, and only the
   * links the owner ticks are submitted.
   */
  const PICK_FORMATS = [
    [/\.pdf$/, "PDF"], [/\.(xlsx|xls|xlsm|csv)$/, "Spreadsheet"], [/\.(docx|doc)$/, "Word"], [/\.(pptx|ppt)$/, "Slides"],
    [/\.zip$/, "ZIP"], [/\.(xml|xsd|xbrl)$/, "XML"], [/\.json$/, "JSON"], [/\.txt$/, "Text"]
  ];
  const PICK_MAX_LINKS = 25;
  const PICK_MAX_REQUEST_LENGTH = 7000;

  function pickFormat(url) {
    let path = "";
    try { path = new URL(url).pathname.toLowerCase(); } catch (_) { return "Web page"; }
    const match = PICK_FORMATS.find(([pattern]) => pattern.test(path));
    return match ? match[1] : "Web page";
  }
  // Readable words from an address when a link has no text of its own.
  function pickSlug(url) {
    try {
      const segments = new URL(url).pathname.split("/").filter(Boolean);
      while (segments.length) {
        const words = decodeURIComponent(segments.pop()).replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_+.]+/g, " ").trim();
        if (words && !/^[\d\s]+$/.test(words)) return words.charAt(0).toUpperCase() + words.slice(1);
      }
      return new URL(url).hostname;
    } catch (_) { return String(url || ""); }
  }

  // Whether following-by-level may read this page: the starting host, and the
  // chosen folder when there is one. Links outside are still listed, not read.
  function pickInScope(url, startUrl, prefix) {
    try {
      const target = new URL(canonicalUrl(url));
      const start = new URL(canonicalUrl(startUrl));
      if (target.hostname.toLowerCase() !== start.hostname.toLowerCase()) return false;
      if (!prefix) return true;
      const folder = new URL(prefix).pathname.replace(/\/+$/, "");
      const path = target.pathname.replace(/\/+$/, "");
      return path === folder || path.indexOf(folder + "/") === 0;
    } catch (_) {
      return false;
    }
  }

  function pickSections(items) {
    const groups = [];
    const index = new Map();
    (items || []).forEach(item => {
      const label = item.section || "";
      if (!index.has(label)) { index.set(label, groups.length); groups.push({ section: label, items: [] }); }
      groups[index.get(label)].items.push(item);
    });
    return groups;
  }

  function pickMatches(item, filters) {
    const f = filters || {};
    if (f.format && f.format !== "ALL") {
      const known = ["PDF", "Web page", "Spreadsheet", "Word"];
      if (f.format === "OTHER" ? known.includes(item.format) : item.format !== f.format) return false;
    }
    if (f.selectedKeys && f.show === "SELECTED" && !f.selectedKeys.has(item.key)) return false;
    const query = String(f.query || "").trim().toLowerCase();
    if (!query) return true;
    return [item.title, item.url, item.section, item.parentTitle].join(" ").toLowerCase().indexOf(query) >= 0;
  }

  // The checklist: links grouped by the page they were found on, then by the
  // heading they sat under, in the order they were found.
  function pickGroupBy(items, filters) {
    const groups = [];
    const index = new Map();
    (items || []).filter(item => pickMatches(item, filters)).forEach(item => {
      const key = urlKey(item.parentUrl || "") + "\u0000" + (item.section || "");
      if (!index.has(key)) {
        index.set(key, groups.length);
        groups.push({ key, parentUrl: item.parentUrl || "", parentTitle: item.parentTitle || pickSlug(item.parentUrl || ""), section: item.section || "", items: [] });
      }
      groups[index.get(key)].items.push(item);
    });
    return groups;
  }

  // What will happen when the selection is submitted, counted honestly.
  function pickSummary(selection, monitoredKeys) {
    const rows = Array.isArray(selection) ? selection : [];
    const seen = new Set();
    let duplicates = 0;
    let monitored = 0;
    const pending = [];
    rows.forEach(row => {
      const key = urlKey(row && row.url);
      if (!key) return;
      if (seen.has(key)) { duplicates += 1; return; }
      seen.add(key);
      if (monitoredKeys && monitoredKeys.has(key)) monitored += 1;
      else pending.push(row);
    });
    return { selected: seen.size, monitored, duplicates, pending, toRequest: pending.length };
  }

  // Split the URLs to request into owner-approved bulk requests: at most 25 links
  // and a prefilled address short enough for GitHub. Nothing is ever dropped:
  // a link too long for any request is reported, not truncated.
  function pickBatches(rows, buildUrl, maxLinks, maxLength) {
    const limit = maxLinks || PICK_MAX_LINKS;
    const lengthLimit = maxLength || PICK_MAX_REQUEST_LENGTH;
    const batches = [];
    const tooLong = [];
    let current = [];
    (rows || []).forEach(row => {
      if (buildUrl([row]).length > lengthLimit) { tooLong.push(row); return; }
      const candidate = current.concat([row]);
      if (current.length && (candidate.length > limit || buildUrl(candidate).length > lengthLimit)) {
        batches.push(current);
        current = [row];
      } else {
        current = candidate;
      }
    });
    if (current.length) batches.push(current);
    return { batches, tooLong };
  }

  // A descriptive monitor name: the link text, with its section when the text alone is thin.
  function pickMonitorName(item) {
    const title = String((item && item.title) || "").replace(/[\r\n]+/g, " ").trim();
    const section = String((item && item.section) || "").replace(/[\r\n]+/g, " ").trim();
    const thin = title.length < 18 && section && title.toLowerCase().indexOf(section.toLowerCase()) < 0;
    return (thin ? section + ": " + title : title).slice(0, 100);
  }

  // Plain-language choices for where discovery may read pages, from one URL.
  function pickScopeOptions(value) {
    let url;
    try { url = new URL(canonicalUrl(value)); } catch (_) { return []; }
    const path = url.pathname.replace(/\/+$/, "");
    const segments = path.split("/").filter(Boolean);
    const options = [];
    if (segments.length) options.push({ id: "page", prefix: url.origin + path + "/", path: path + "/", label: "Only pages under this page" });
    if (segments.length > 1) {
      const parent = "/" + segments.slice(0, -1).join("/") + "/";
      options.push({ id: "section", prefix: url.origin + parent, path: parent, label: "Pages in the same section" });
    }
    options.push({ id: "site", prefix: "", path: "/", label: "Anywhere on " + url.hostname });
    return options;
  }

  function pickHosts(value, startUrl) {
    let start = "";
    try { start = new URL(startUrl).hostname.toLowerCase(); } catch (_) {}
    const hosts = [];
    const invalid = [];
    String(value || "").split(/[\s,]+/).forEach(raw => {
      const host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
      if (!host) return;
      const ok = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) &&
        !/(^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home$)/.test(host) && !/^\d+(\.\d+){3}$/.test(host);
      if (!ok) invalid.push(raw.trim());
      else if (host !== start && hosts.indexOf(host) < 0) hosts.push(host);
    });
    return { hosts, invalid };
  }

  // The Add Link request that sets up discovery only: the owner workflow saves a
  // Scout channel and adds no monitor. Field order matters to the parser: the
  // scope fields come before the selector fields.
  function pickDiscoveryRequest(options) {
    const o = options || {};
    const depth = [1, 2, 3].indexOf(Number(o.depth)) >= 0 ? Number(o.depth) : 2;
    const body = [
      "<!-- changesentinel:add-monitor:v1 -->", "",
      "Please re-check this page weekly for new links. Do not add it as a monitor; new links appear in Scout for review.", "",
      "URL: " + o.url,
      "Name: " + String(o.name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 100),
      "Crawl depth: " + depth,
      "Scout discovery: yes",
      "Discovery only: yes",
      "Explore within: " + (o.explore || ""),
      "Document hosts: " + (o.documentHosts || []).join(", "),
      "Include selector: ",
      "Ignore selectors:", "(none)", "",
      "This request was created from the ChangeSentinel dashboard."
    ];
    return { title: "[ChangeSentinel] Add monitor request: weekly link check", body: body.join("\n") };
  }


  /* ---------- Smarter picking: likely-relevant links, older versions, similar links, rules ---------- */
  const PICK_GOOD_WORDS = [
    [/\binstructions?\b/i, "Instructions"], [/\btemplates?\b/i, "Template"], [/\breporting forms?\b|\bforms?\b(?! of)/i, "Form"],
    [/technical spec|specifications?\b/i, "Technical specification"], [/taxonom|\bxbrl\b|\bxsd\b|schema/i, "Taxonomy / schema"],
    [/validation (rule|check)|edit checks?/i, "Validation rules"], [/\bfaq\b|q&a|questions and answers/i, "Q&A"],
    [/\bguidance\b|\bguidelines?\b|\bmanual\b/i, "Guidance"], [/\bcircular\b|\bnotice\b|\bletter\b|\bbulletin\b/i, "Notice"],
    [/\bconsultation\b|\bproposal\b|\bdraft\b/i, "Consultation"], [/\brule\b|\bregulation\b|\bstandard\b/i, "Rule"],
    [/\breturns?\b|\bschedules?\b|\breporting\b|\bfiling\b/i, "Reporting"], [/\bsample\b/i, "Sample file"]
  ];
  const PICK_BAD_WORDS = /\b(news|press|event|webinar|career|job|vacanc|contact|privacy|cookie|terms of use|accessibility|login|log in|sign in|subscribe|newsletter|sitemap|search|facebook|twitter|linkedin|youtube|instagram|share|print|back to top|skip to|home)\b/i;
  const PICK_OLD_WORDS = /\b(archived?|historical|previous|superseded|obsolete|former|old version|legacy|withdrawn|retired)\b/i;
  const PICK_DOC_FORMATS = { PDF: 2, Spreadsheet: 3, ZIP: 2, XML: 2, Word: 1, JSON: 1 };
  // How likely a link is to be something a compliance team would monitor, with the reasons.
  function pickScore(link) {
    const text = String((link && (link.text || link.title)) || "");
    const url = String((link && link.url) || "").toLowerCase();
    const haystack = text + " " + (link && link.section || "") + " " + url.replace(/[-_/.]+/g, " ");
    const reasons = [];
    let score = PICK_DOC_FORMATS[link && link.format] || 0;
    if (score) reasons.push(link.format === "Spreadsheet" ? "Excel file" : link.format + " file");
    PICK_GOOD_WORDS.forEach(([pattern, label]) => { if (pattern.test(haystack) && reasons.indexOf(label) < 0) { score += 2; reasons.push(label); } });
    if (link && link.chrome) score -= 3;
    if (PICK_BAD_WORDS.test(text)) score -= 3;
    const older = PICK_OLD_WORDS.test(haystack);
    if (older) score -= 1;
    return { score, reasons: reasons.slice(0, 3), older };
  }
  // Links that are the same document in another year or version: all but the newest
  // of each family are marked older. A family is the link text and address with the
  // years, dates and version numbers taken out.
  function pickVersions(links) {
    const stem = link => (String(link.text || link.title || "") + " " + String(link.url || "").replace(/^https?:\/\/[^/]+/, ""))
      .toLowerCase().replace(/\b(19|20)\d{2}\b|\bq[1-4]\b|\bv(ersion)?\s*\d+(\.\d+)*\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\d+/g, "#").replace(/[^a-z#]+/g, " ").trim();
    const weight = link => {
      const source = String(link.text || link.title || "") + " " + String(link.url || "");
      const years = (source.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
      const version = (source.match(/\bv(?:ersion)?\s*(\d+(?:\.\d+)*)/i) || [])[1];
      const quarter = (source.match(/\bq([1-4])\b/i) || [])[1];
      return (years.length ? Math.max(...years) : 0) * 100 + (quarter ? Number(quarter) * 10 : 0) + (version ? parseFloat(version) : 0);
    };
    const families = new Map();
    (links || []).forEach((link, index) => {
      const key = stem(link);
      if (!key || key.replace(/[# ]/g, "").length < 3) return;
      if (!families.has(key)) families.set(key, []);
      families.get(key).push({ index, weight: weight(link) });
    });
    const older = new Set();
    families.forEach(members => {
      if (members.length < 2) return;
      const best = Math.max(...members.map(member => member.weight));
      if (!best) return;
      members.forEach(member => { if (member.weight < best) older.add(member.index); });
    });
    return older;
  }
  function folderOf(url) {
    try { const u = new URL(url); return u.origin + u.pathname.replace(/[^/]*$/, ""); } catch (_) { return ""; }
  }
  function firstWords(text, n) { return String(text || "").trim().split(/\s+/).slice(0, n).join(" "); }
  function escapeRegex(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  // Rules that describe the picked links and find more like them on the page.
  // Returns [{ id, label, keys: [...] }] for rules that would add at least one link.
  /* ---------- Alert-condition suggestions generated from a page ----------
   * Plain-language "Alert me when" starting points drawn from what the page
   * actually holds: its report codes, the kinds of documents it links, and
   * words about deadlines, versions, validation rules, layouts or
   * consultations, in the languages regulators publish in. The owner edits or
   * replaces them; nothing is saved until they submit the request.
   */
  const CONDITION_SIGNALS = [
    ["validation", /validation rule|edit check|validaç(ão|oes|ões)|regras? de valida|reglas? de valida|validierungsregel|contrôles? de validation|quality check/i,
      "A validation rule is added or removed, or its severity changes"],
    ["taxonomy", /\bxsd\b|xbrl|taxonom|schema|esquema|leiaute|layout|formato|data point model|\bdpm\b/i,
      "The file layout, schema or taxonomy changes (fields added, removed or renamed)"],
    ["deadline", /deadline|due date|filing date|effective|as-of date|reporting date|vig[eê]ncia|prazo|data-base|fecha de|plazo|entr[ée]e en vigueur|date limite|stichtag|frist/i,
      "A filing deadline, reporting date or effective date changes"],
    ["version", /\bversion\b|\brelease\b|\bv\d+(\.\d+)+\b|vers[ãa]o|versi[oó]n|release notes|errata|change log|changelog|revis(ed|ion)/i,
      "A new version, release or errata is published"],
    ["consultation", /consultation|request for comment|proposed|draft|consulta p[uú]blica|audiencia p[uú]blica|proyecto de/i,
      "A consultation or proposal opens, or its comment deadline changes"],
    ["instructions", /instruction|guidance|manual|user guide|guia|gu[ií]a|orientaç|circular|carta circular|notice/i,
      "Instructions or guidance for a report change"]
  ];
  function conditionSuggestionsFrom(page, options = {}) {
    const p = page || {};
    const links = Array.isArray(p.links) ? p.links.filter(link => link && !link.chrome) : [];
    const text = [p.title, String(p.text || "").slice(0, 60000), links.slice(0, 400).map(link => link.text || link.title || "").join(" \n ")].join(" \n ");
    const out = [];
    const add = value => { if (value && out.indexOf(value) < 0) out.push(value); };
    const codes = reportCodes(text).filter(code => code.length >= 4).slice(0, 2);
    const pretty = code => code.replace(/^FRY/, "FR Y-").replace(/^FR(?=\d)/, "FR ").replace(/^FFIEC(?=\d)/, "FFIEC ");
    if (codes.length) add("A field, schedule or instruction for " + codes.map(pretty).join(" or ") + " changes");
    const formats = {};
    links.forEach(link => { if (link.format && link.format !== "Web page") formats[link.format] = (formats[link.format] || 0) + 1; });
    const topFormat = Object.keys(formats).sort((a, b) => formats[b] - formats[a])[0];
    const isDocument = options.format && options.format !== "Web page";
    if (!isDocument && topFormat) {
      const noun = { PDF: "PDF", Spreadsheet: "spreadsheet", Word: "Word document", ZIP: "ZIP bundle", XML: "XML file", CSV: "CSV file" }[topFormat] || topFormat.toLowerCase();
      add("A new " + noun + " is added to this page, or an existing one is replaced");
    }
    CONDITION_SIGNALS.forEach(([, pattern, sentence]) => { if (pattern.test(text)) add(sentence); });
    if (isDocument) add("A field, schedule, instruction or validation rule in this document changes");
    if (!out.length) add(isDocument ? "The effective date or reporting period changes" : "A new document, form or user guide is added to this page");
    add("A requirement, threshold or reporting scope changes");
    return out.slice(0, options.limit || 4);
  }

  /* ---------- Find similar: pages like one monitored page ----------
   * Ranks links found around a monitored page by how much they resemble it:
   * another edition of the same address (a different year), the same report
   * code (FR Y-9C, BCAR, 5050), the same folder and file type, and shared
   * words in the title and address. Nothing is ticked; the owner decides.
   */
  const SIMILAR_STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "page", "pages", "www", "http", "https", "html", "htm", "php", "aspx",
    "pdf", "xlsx", "xls", "zip", "csv", "doc", "docx", "index", "default", "files", "file", "content", "uploads", "sites", "documents", "document",
    "download", "view", "data", "apps", "report", "reports", "gov", "org", "com", "los", "las", "del", "des", "der", "die", "und", "por", "para"]);
  const REPORT_CODE = /\b(FR|FFIEC|BCAR|LCR|NSFR|SUCAVE|COSIF|DPM|BIRD|COREP|FINREP|CCAR|LRR|CAR)(?:[ -]?(?=[A-Z0-9-]*\d)[A-Z0-9]{1,6}(?:-[A-Z0-9]{1,4})?)?\b/gi;
  function similarWords(text) {
    return Array.from(new Set(String(text || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/).filter(word => word.length >= 3 && !SIMILAR_STOP.has(word) && !/^\d+$/.test(word))));
  }
  function reportCodes(text) {
    // A trailing year is an edition, not a different report: BCAR 2027 is BCAR.
    // No regex lookbehind anywhere in this file: it is a parse error on Safari
    // 16.3 and older, and this classic script has no build step (audit CS-20).
    return Array.from(new Set((String(text || "").match(REPORT_CODE) || []).map(code => code.toUpperCase().replace(/[\s-]+/g, "").replace(/([A-Z])20\d{2}$/, "$1"))))
      .filter(code => code.length >= 3);
  }
  function yearless(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, "") + u.pathname.toLowerCase().replace(/(^|[^0-9])20\d{2}(?![0-9])/g, "$1{y}").replace(/\.(pdf|xlsx?|zip|csv|docx?)$/, "");
    } catch (_) { return ""; }
  }
  function pathOf(url) { try { return new URL(url).pathname; } catch (_) { return ""; } }
  function similarityTo(target, link) {
    const t = target || {}, l = link || {};
    const reasons = [];
    let score = 0;
    if (!l.url || urlKey(l.url) === urlKey(t.url)) return { score: -1, reasons };
    const ty = yearless(t.url), ly = yearless(l.url);
    if (ty && ty === ly && ty.indexOf("{y}") >= 0) { score += 6; reasons.push("another year's edition"); }
    const codes = reportCodes((t.title || "") + " " + pathOf(t.url).replace(/[-_/]+/g, " "));
    const shared = codes.filter(code => reportCodes((l.title || l.text || "") + " " + pathOf(l.url).replace(/[-_/]+/g, " ")).indexOf(code) >= 0);
    if (shared.length) { score += 4; reasons.push("same report " + shared[0]); }
    if (folderOf(t.url) && folderOf(t.url) === folderOf(l.url)) { score += 2; reasons.push("same folder"); }
    if (t.format && l.format === t.format) { score += 1.5; if (t.format !== "Web page") reasons.push("also a " + t.format); }
    const a = similarWords((t.title || "") + " " + pathOf(t.url)), b = similarWords((l.title || l.text || "") + " " + pathOf(l.url));
    const common = a.filter(word => b.indexOf(word) >= 0);
    const jaccard = a.length && b.length ? common.length / new Set(a.concat(b)).size : 0;
    if (jaccard > 0) { score += jaccard * 8; if (common.length >= 2) reasons.push("shares \u201c" + common.slice(0, 3).join(" ") + "\u201d"); }
    return { score: Math.round(score * 10) / 10, reasons };
  }
  // links: [{ key?, url, title|text, format }] -> the most similar first, above a floor.
  function rankSimilar(target, links, options = {}) {
    const floor = options.floor == null ? 4 : options.floor;
    const limit = options.limit || 30;
    return (links || []).map(link => Object.assign({ link }, similarityTo(target, link)))
      .filter(entry => entry.score >= floor).sort((x, y) => y.score - x.score || String(x.link.url).localeCompare(String(y.link.url))).slice(0, limit);
  }
  // Pages to start looking from, best first.
  function similarStarts(target, options = {}) {
    const out = [];
    const add = url => { if (url && out.indexOf(url) < 0 && url !== target.url) out.push(url); };
    (options.parents || []).forEach(add);
    if (target.format === "Web page") out.push(target.url);
    try {
      const u = new URL(target.url);
      const parts = u.pathname.split("/").filter(Boolean);
      // File-store folders (wp-content/uploads, sites/default/files) rarely list their files.
      for (let depth = parts.length - 1; depth >= 1; depth--) {
        const folder = "/" + parts.slice(0, depth).join("/") + "/";
        if (!/\/(wp-content|uploads|sites|files|media|assets|documents|docs)\//i.test(folder)) add(u.origin + folder);
      }
      add(u.origin + "/");
    } catch (_) {}
    return out.slice(0, 6);
  }

  function pickSimilar(picked, links, keyOf) {
    const key = keyOf || (link => urlKey(link.url));
    const chosen = (picked || []).filter(Boolean);
    const all = (links || []).filter(link => link && !link.chrome);
    if (!chosen.length || !all.length) return [];
    const have = new Set(chosen.map(key));
    const rules = [];
    const formats = Array.from(new Set(chosen.map(link => link.format)));
    const sections = Array.from(new Set(chosen.map(link => link.section || "")));
    const folders = Array.from(new Set(chosen.map(link => folderOf(link.url))));
    const format = formats.length === 1 ? formats[0] : "";
    const kind = format && format !== "Web page" ? (format === "Spreadsheet" ? "Excel files" : format + "s") : "links";
    // A shared first word or two ("Current", "Form FR"): the way regulators label the live version.
    for (let words = 2; words >= 1; words -= 1) {
      const prefixes = Array.from(new Set(chosen.map(link => firstWords(link.text || link.title, words).toLowerCase())));
      if (prefixes.length === 1 && prefixes[0].length >= 4 && !/^(the|a|an|download|view|click|link)$/.test(prefixes[0])) {
        const prefix = firstWords(chosen[0].text || chosen[0].title, words);
        rules.push({ id: "text:" + prefix, label: "All " + kind + " starting “" + prefix + "”", pattern: "^" + escapeRegex(prefix), test: link => (!format || link.format === format) && firstWords(link.text || link.title, words).toLowerCase() === prefixes[0] });
        break;
      }
    }
    if (sections.length === 1 && sections[0]) rules.push({ id: "section:" + sections[0], label: "All " + kind + " under “" + sections[0] + "”", test: link => (link.section || "") === sections[0] && (!format || link.format === format) });
    if (folders.length === 1 && folders[0]) {
      let path = folders[0];
      try { path = new URL(folders[0]).pathname; } catch (_) {}
      if (path !== "/") rules.push({ id: "folder:" + folders[0], label: "All " + kind + " in " + path, prefix: folders[0], test: link => folderOf(link.url) === folders[0] && (!format || link.format === format) });
    }
    if (format && format !== "Web page") rules.push({ id: "format:" + format, label: "Every " + kind.replace(/s$/, "") + " on this page", test: link => link.format === format });
    const seen = new Set();
    return rules.map(rule => ({ id: rule.id, label: rule.label, pattern: rule.pattern || "", prefix: rule.prefix || "", keys: all.filter(rule.test).map(key) }))
      .filter(rule => {
        const extra = rule.keys.filter(k => !have.has(k)).length;
        const signature = rule.keys.slice().sort().join("|");
        if (!extra || seen.has(signature)) return false;
        seen.add(signature);
        rule.extra = extra;
        return true;
      });
  }
  // A monitoring rule from what was picked on one page: watch the page, follow the
  // documents it links to, but only those labelled like the picked ones and only
  // under their folder. The owner workflow turns it into the monitor's settings.
  function pickRecipe(pageUrl, picked, links) {
    let host = "";
    try { host = new URL(pageUrl).host; } catch (_) { return null; }
    const docs = (picked || []).filter(link => link && link.format !== "Web page");
    if (!docs.length) return null;
    // The label the picked documents share: "Current", "Current FR Y-9C"…
    let textPattern = "";
    for (let words = 3; words >= 1 && !textPattern; words -= 1) {
      const prefixes = Array.from(new Set(docs.map(link => firstWords(link.text || link.title, words).toLowerCase())));
      if (prefixes.length === 1 && prefixes[0].length >= 4 && firstWords(docs[0].text || docs[0].title, words + 1).split(/\s+/).length > words &&
        !/^(the|a|an|download|view|click|link|pdf|file)$/.test(prefixes[0])) {
        textPattern = "^" + escapeRegex(firstWords(docs[0].text || docs[0].title, words));
      }
    }
    // A shared first word alone is often the version marker ("Current", "Final"): prefer it when every pick has it.
    const firstWord = Array.from(new Set(docs.map(link => firstWords(link.text || link.title, 1).toLowerCase())));
    if (firstWord.length === 1 && /^(current|final|latest|new|revised|updated|effective)$/.test(firstWord[0])) {
      textPattern = "^" + escapeRegex(firstWords(docs[0].text || docs[0].title, 1));
    }
    const textRule = textPattern ? { pattern: textPattern } : null;
    const sameHost = docs.every(link => { try { return new URL(link.url).host === host; } catch (_) { return false; } });
    const folders = Array.from(new Set(docs.map(link => folderOf(link.url))));
    const prefix = sameHost && folders.length === 1 ? folders[0] : "";
    const matches = (links || []).filter(link => link && !link.chrome && link.format !== "Web page" &&
      (!textRule || new RegExp(textRule.pattern, "i").test(String(link.text || link.title || ""))) && (!prefix || String(link.url).indexOf(prefix) === 0));
    return { url: pageUrl, depth: 1, textPattern: textRule ? textRule.pattern : "", prefix, count: matches.length };
  }

  // The links on a page a document rule would monitor today: documents (not web
  // pages) under one of the folders whose link text matches the pattern, the way
  // the monitor's discovery reads them (case-insensitive search, folder prefix).
  function pickRuleMatches(links, rule) {
    const r = rule || {};
    let pattern = null;
    const text = String(r.pattern || "").trim();
    if (text.length > 200) return { error: "Use a pattern of at most 200 characters.", keys: [], count: 0 };
    if (text) {
      try { pattern = new RegExp(text, "i"); } catch (error) { return { error: "That pattern isn't valid: " + String(error.message || error), keys: [], count: 0 }; }
    }
    const folders = (Array.isArray(r.folders) ? r.folders : [r.folder]).map(pickRuleFolder).filter(Boolean);
    if (r.folder && !folders.length) return { error: "Enter the folder as a full address beginning with https://.", keys: [], count: 0 };
    const keys = [];
    (links || []).forEach(link => {
      if (!link || link.format === "Web page") return;
      const url = String(link.url || "");
      if (folders.length && !folders.some(folder => url.indexOf(folder) === 0)) return;
      if (pattern && !pattern.test(String(link.text || link.title || ""))) return;
      const key = urlKey(url);
      if (keys.indexOf(key) < 0) keys.push(key);
    });
    return { error: "", keys, count: keys.length, folders };
  }
  // A folder address as the owner workflow stores it: "…/forms/" for "…/forms",
  // "…/forms/" for "…/forms/FR_Y9C.pdf".
  function pickRuleFolder(value) {
    let u;
    try { u = new URL(String(value || "").trim()); } catch (_) { return ""; }
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return "";
    const last = u.pathname.split("/").pop();
    const path = u.pathname.endsWith("/") || last.indexOf(".") < 0 ? u.pathname.replace(/\/*$/, "/") : u.pathname.replace(/[^/]*$/, "");
    return u.origin + path;
  }
  // The owner-approved request for a document rule. The rule fields sit before
  // "Include selector", where the workflow reads them.
  function pickRuleRequest(options) {
    const o = options || {};
    const folders = (o.folders || [o.folder]).map(pickRuleFolder).filter(Boolean).slice(0, 5);
    const ignore = (o.ignore || []).map(value => String(value).replace(/[\r\n]+/g, " ").trim()).filter(Boolean).slice(0, 20);
    const body = [
      "<!-- changesentinel:add-monitor:v1 -->", "",
      "Please register this page with a document rule: watch the page and the documents it links to that match the rule, and nothing else on the site.", "",
      "URL: " + o.url,
      "Name: " + String(o.name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 100),
      "Crawl depth: 1",
      "Scout discovery: no",
      "Documents under: " + folders.join(" "),
      "Document link text matches: " + String(o.pattern || "").replace(/[\r\n]+/g, " ").trim(),
      "Include selector: " + String(o.include || "").replace(/[\r\n]+/g, " ").trim(),
      "Ignore selectors:"
    ].concat(ignore.length ? ignore.map(value => "- " + value) : ["(none)"], ["", "This request was created from the ChangeSentinel dashboard."]);
    return { title: "[ChangeSentinel] Add monitor request: document rule", body: body.join("\n") };
  }


  /* ---------- Cadence: filing planner, weekly load, calendar links ---------- */
  function isoAdd(iso, days) {
    const d = isoDayToDate(iso);
    if (!d) return "";
    d.setDate(d.getDate() + days);
    return localIsoDate(d);
  }
  function isWeekend(iso) { const d = isoDayToDate(iso); return !!d && (d.getDay() === 0 || d.getDay() === 6); }
  // Move forward (or back, for negative counts) by business days: Monday–Friday.
  // Public holidays differ by jurisdiction and are not modelled.
  function businessShift(iso, count) {
    let date = iso;
    const step = count < 0 ? -1 : 1;
    let left = Math.abs(count);
    while (left > 0) { date = isoAdd(date, step); if (!isWeekend(date)) left -= 1; }
    return date;
  }
  function nextBusinessDay(iso) { let date = iso; while (isWeekend(date)) date = isoAdd(date, 1); return date; }
  function monthEnd(year, month) { return localIsoDate(new Date(year, month + 1, 0)); }
  // The next filing cycles of a periodic return: period end, due date and the
  // team's preparation milestones before it.
  // options: { frequency: "monthly"|"quarterly"|"yearly", yearEndMonth (0-11), lag (days),
  //   lagLast (days for the year-end period), business (roll weekends), milestones: [{ label, offset }]
  //   (business days before the due date), cycles, from (ISO day: plan periods due on/after it) }
  function cadencePlan(options) {
    const o = options || {};
    const frequency = ["monthly", "quarterly", "yearly"].indexOf(o.frequency) >= 0 ? o.frequency : "quarterly";
    const step = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
    const yearEnd = Number.isInteger(o.yearEndMonth) ? ((o.yearEndMonth % 12) + 12) % 12 : 11;
    const lag = Math.max(0, Math.min(365, Number(o.lag) || 0));
    const lagLast = Math.max(0, Math.min(365, Number(o.lagLast) || lag));
    const cycles = Math.max(1, Math.min(24, Number(o.cycles) || 4));
    const from = ISO_DAY.test(String(o.from || "")) ? o.from : localIsoDate(new Date());
    const start = isoDayToDate(from);
    // Walk period ends aligned to the year end, starting a year back so periods
    // already closed but not yet due are included.
    let year = start.getFullYear() - 1;
    let month = yearEnd;
    while (true) { const next = month - step; if (next < 0) break; month = next; }
    const plan = [];
    for (let guard = 0; guard < 400 && plan.length < cycles; guard += 1) {
      const end = monthEnd(year, month);
      const isLast = month === yearEnd;
      let due = isoAdd(end, isLast ? lagLast : lag);
      const rolled = o.business && isWeekend(due);
      if (o.business) due = nextBusinessDay(due);
      if (due >= from) {
        const endDate = isoDayToDate(end);
        const fiscalOffset = (endDate.getMonth() - yearEnd + 12) % 12;
        const label = frequency === "monthly" ? endDate.toLocaleDateString("en-GB", { month: "short", year: "numeric" })
          : frequency === "yearly" ? "Year to " + endDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
          : "Q" + (Math.floor(((fiscalOffset + 11) % 12) / 3) + 1) + " · " + endDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        const milestones = (o.milestones || []).filter(m => m && String(m.label || "").trim() && Number(m.offset) > 0).map(m => ({
          label: String(m.label).trim().slice(0, 80), offset: Math.min(120, Math.round(Number(m.offset))),
          date: businessShift(due, -Math.min(120, Math.round(Number(m.offset))))
        })).sort((a, b) => a.date.localeCompare(b.date));
        plan.push({ period: label, periodEnd: end, due, rolled: !!rolled, milestones });
      }
      month += step;
      if (month > 11) { month -= 12; year += 1; }
    }
    return plan;
  }
  // Open work per week, for the load strip: entries and dates in each of the
  // next weeks (weeks start on Monday), with deadlines counted apart.
  function cadenceWeeks(events, today, weeks) {
    const base = isoDayToDate(today);
    if (!base) return [];
    const monday = isoAdd(today, -((base.getDay() + 6) % 7));
    const rows = [];
    for (let i = 0; i < Math.max(1, Math.min(26, weeks || 12)); i += 1) rows.push({ start: isoAdd(monday, i * 7), end: isoAdd(monday, i * 7 + 6), total: 0, deadlines: 0, titles: [] });
    const seen = new Set();
    (events || []).forEach(event => {
      if (!event || !event.date || event.completed) return;
      const key = event.key || (event.date + "|" + event.title);
      if (seen.has(key)) return;
      seen.add(key);
      const row = rows.find(week => event.date >= week.start && event.date <= week.end);
      if (!row) return;
      row.total += 1;
      if (event.deadline) row.deadlines += 1;
      if (row.titles.length < 6) row.titles.push(String(event.title || ""));
    });
    const peak = Math.max(1, ...rows.map(row => row.total));
    rows.forEach(row => { row.level = row.total ? Math.max(1, Math.round(4 * row.total / peak)) : 0; row.busy = row.deadlines >= 3; });
    return rows;
  }
  // A one-click "add to Google Calendar" link for an all-day entry.
  function googleCalendarLink(entry) {
    const e = entry || {};
    const start = String(e.date || "").replace(/-/g, "");
    if (!/^\d{8}$/.test(start)) return "";
    const end = String(isoAdd(e.endDate || e.date, 1)).replace(/-/g, "");
    const params = new URLSearchParams();
    params.set("action", "TEMPLATE");
    params.set("text", String(e.title || "Regulatory date").slice(0, 200));
    params.set("dates", start + "/" + end);
    const details = [String(e.details || "").slice(0, 1200), e.url ? String(e.url) : ""].filter(Boolean).join("\n\n");
    if (details) params.set("details", details);
    return "https://calendar.google.com/calendar/render?" + params.toString();
  }

  /* ---------- Link lineage (data/link-lineage.json) ---------- */

  // Every monitored page that lists, or listed, this exact address.
  function linkListings(lineage, url) {
    const key = urlKey(url);
    const out = [];
    const pages = (lineage && lineage.pages) || {};
    Object.keys(pages).forEach(pageUrl => {
      const page = pages[pageUrl] || {};
      Object.keys(page.links || {}).forEach(linkUrl => {
        if (urlKey(linkUrl) !== key) return;
        const entry = page.links[linkUrl] || {};
        out.push({ page: pageUrl, url: linkUrl, text: entry.text || "", firstSeen: entry.first_seen || "", removedAt: entry.removed_at || "",
          restoredAt: entry.restored_at || "", trackingSince: page.tracking_since || "", lastScan: page.last_scan || "" });
      });
    });
    // Removed listings first (newest removal first), then current ones.
    return out.sort((a, b) => (b.removedAt ? 1 : 0) - (a.removedAt ? 1 : 0) || String(b.removedAt).localeCompare(String(a.removedAt)) || a.page.localeCompare(b.page));
  }
  // Addresses or link texts containing every word typed, across every page.
  function linkLineageSearch(lineage, query, limit) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    if (!words.length) return out;
    const pages = (lineage && lineage.pages) || {};
    Object.keys(pages).forEach(pageUrl => {
      const page = pages[pageUrl] || {};
      Object.keys(page.links || {}).forEach(linkUrl => {
        const entry = page.links[linkUrl] || {};
        const hay = (linkUrl + " " + (entry.text || "")).toLowerCase();
        if (!words.every(word => hay.indexOf(word) >= 0)) return;
        out.push({ page: pageUrl, url: linkUrl, text: entry.text || "", firstSeen: entry.first_seen || "", removedAt: entry.removed_at || "", trackingSince: page.tracking_since || "" });
      });
    });
    out.sort((a, b) => (b.removedAt ? 1 : 0) - (a.removedAt ? 1 : 0) || String(b.removedAt).localeCompare(String(a.removedAt)) || a.url.localeCompare(b.url));
    return out.slice(0, limit || 200);
  }
  // What one page lists: current links, removed links (newest first), and the
  // links added after tracking began.
  function pageLinkLineage(lineage, pageUrl) {
    const pages = (lineage && lineage.pages) || {};
    const key = urlKey(pageUrl);
    const found = Object.keys(pages).find(url => urlKey(url) === key);
    if (!found) return null;
    const page = pages[found] || {};
    const current = [], removed = [], added = [];
    Object.keys(page.links || {}).forEach(url => {
      const entry = page.links[url] || {};
      const row = { url, text: entry.text || "", menu: !!entry.menu, firstSeen: entry.first_seen || "", removedAt: entry.removed_at || "" };
      if (row.removedAt) removed.push(row);
      else current.push(row);
      if (!row.removedAt && row.firstSeen && page.tracking_since && row.firstSeen > page.tracking_since) added.push(row);
    });
    removed.sort((a, b) => String(b.removedAt).localeCompare(String(a.removedAt)));
    added.sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
    return { page: found, trackingSince: page.tracking_since || "", lastScan: page.last_scan || "", current, removed, added };
  }
  // Settings requests that add `page` to each monitor's listed_on (the pages a
  // scan reads to record where its link is listed). Monitors that would end
  // with the same list share one request; at most 5 pages a monitor.
  function listedOnPayloads(sources, page) {
    const groups = new Map();
    (sources || []).forEach(source => {
      if (!source || !source.id) return;
      const current = Array.isArray(source.listed_on) ? source.listed_on.map(String) : [];
      if (current.some(url => urlKey(url) === urlKey(page))) return;
      const next = current.concat([page]).slice(-5);
      const key = JSON.stringify(next);
      if (!groups.has(key)) groups.set(key, { monitors: [], set: { listed_on: next }, clear: [] });
      groups.get(key).monitors.push(String(source.id));
    });
    return Array.from(groups.values());
  }
  // The links a page gained and lost in the scan at `at` (one change event).
  function linkEventsAt(lineage, pageUrl, at) {
    const key = urlKey(pageUrl);
    const when = new Date(at).getTime();
    return ((lineage && lineage.events) || []).filter(event => urlKey(event.page) === key && Math.abs(new Date(event.at).getTime() - when) < 1000);
  }

  return {
    pickFormat, pickSlug, pickInScope, pickSections, pickMatches, pickGroupBy, pickSummary, pickBatches, pickMonitorName,
    pickScopeOptions, pickHosts, pickDiscoveryRequest, PICK_MAX_LINKS, PICK_MAX_REQUEST_LENGTH, pickScore, pickVersions, pickSimilar, pickRecipe, pickRuleMatches, pickRuleFolder, pickRuleRequest,
    diffSequences, alignLines, changedWords, readWorkbook, workbookDiff, csvWorkbook, parseCsv, zipListing, zipFile, readDocx, columnName, cellRef,
    esc, nextScheduledScan, scanCycle, runColumns, conditionSuggestionsFrom, similarityTo, rankSimilar, similarStarts, reportCodes, importColumns, importFrequencyHours, importIsPaused, importRows, shadowCompare, shadowRows, IMPORT_ALIASES, validTag, parseLabels, workspaceOf, labelsOf, scopeMatches, organisePayload, payloadIsEmpty, SETTINGS_PRESETS, presetPayload, LABEL_MAX, scanSchedule, scanScheduleIsDefault, scanScheduleLabel, scanAllows, scanIsDue, scanSlots, scanSchedulePayload, settingsRequests, SETTINGS_MARKER, SCAN_WEEKDAYS, SCAN_BUSINESS_DAYS, SCAN_INTERVALS, slotColumns, columnCellState, pendingScan,
    timelineModel, timelineGapWords, TIMELINE_KINDS, healthInsights, healthLight, botCheckWait, BOT_CHECK_GRACE_HOURS,
    fieldWindow, mergeCellStates, rowActivity, fieldCounts, fieldRows, FIELD_RANGES, FIELD_LENSES, regulatorFor, jurisdictionForHost, hostOf, pageKind, normalizeTrigger, workflowRunTrigger, fbm, formatDuration, SCAN_INTERVAL_HOURS,
    eventLabel, eventTone, EVENT_LABELS,
    parseUnifiedDiff, tokenize, wordDiff, similarity, redlineRows, redlineSummary, renderRedline, renderUnifiedDiff, isTableLine,
    splitMarkdownTableRow, isMarkdownTableSeparator, relativeTime, dayHeading,
    foldWhitespace, inlineMarkdown, xlsxFirstSheetRows, normalizeForMatch, changedPartOffsets, tableCellsMatch,
    canonicalUrl, urlKey, scoutBucket, scoutBuckets, scoutSentence, scoutReviewIssue, nextScoutSweep, scoutStrength, scoutGroups,
    SCOUT_FILTERS, SCOUT_OUTCOMES, SCOUT_CONFIDENCE, SCOUT_STATUS, SCOUT_CHANNEL_STATUS, SCOUT_NOUNS, SCOUT_REVIEW_MARKER,
    scoutSlug, splitList, splitLines, parsePathHints, pathHintsText, scoutSourceRequest, SCOUT_SOURCE_MARKER, SCOUT_TOPIC_IDS, SCOUT_REGIONS,
    renderWordEdit, describeItemCodes, lineageFor, validateBrowserSteps, describeBrowserStep, recorderBookmarklet, RECORDER_SOURCE, precisionBuild, precisionOutcomes, precisionScores, precisionSuggestions, wilson, missedChangeRequest, MISSED_CHANGE_MARKER, registryModel, registryTouched, registryImpact, registryRuleConsumers, registrySentence, registryConsumerLink, registryNorm, registryEntryCodes, REGISTRY_SCHEMES, REGISTRY_CHANGE_WORDS, REGISTRY_KIND_NOUNS, describeSpec, specGroups, specCategoryLabel, specCsvRows, SPEC_CATEGORIES, SPEC_KIND_NOUNS, localIsoDate, isoDayToDate, daysBetween, dueLabel, upcomingDates, datesForChange,
    changeReviewRequest, CHANGE_REVIEW_MARKER, REVIEW_DECISIONS, csvCell, toCsv, fileSlug,
    cadencePlan, cadenceWeeks, businessShift, nextBusinessDay, googleCalendarLink,
    linkListings, listedOnPayloads, linkLineageSearch, pageLinkLineage, linkEventsAt
  };
}));
