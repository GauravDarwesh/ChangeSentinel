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

  // One LED in the change field: what happened to one page in one scan.
  //   "on"   the scan found a content change
  //   "new"  the page first appeared in this scan
  //   "bad"  the scan could not fetch or read the page
  //   "dim"  the page was scanned and nothing changed
  //   "none" this scan did not cover the page (another source's run, or the
  //          page was not monitored yet); nothing is drawn
  function columnCellState(column, page) {
    const scannedAt = column.sources[page.sourceId];
    if (!scannedAt) return "none";
    const firstSeen = page.firstSeen ? Date.parse(page.firstSeen) : NaN;
    if (!Number.isNaN(firstSeen) && firstSeen > scannedAt + 1000) return "none";
    const inColumn = time => {
      const t = Date.parse(time);
      return !Number.isNaN(t) && t > column.prevAt && t <= column.at;
    };
    const events = (page.events || []).filter(event => inColumn(event.timestamp));
    if (events.some(event => event.event_type === "FETCH_ERROR" || event.event_type === "EXTRACTION_ERROR")) return "bad";
    if (page.problemAt && inColumn(page.problemAt)) return "bad";
    // Initial baselines intentionally suppress NEW_URL; first_seen identifies the first successful scan.
    // Only light it in a column that actually scanned this source, never earlier scans.
    if (Number.isFinite(firstSeen) && firstSeen > column.prevAt && firstSeen <= scannedAt + 1000) return "new";
    if (events.some(event => event.event_type === "NEW_URL")) return "new";
    if (events.some(event => event.event_type === "CHANGED_URL" || event.event_type === "REMOVED_URL" || event.event_type === "HTML_SOURCE_CHANGED")) return "on";
    return "dim";
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
    const scheduledDone = cols.some(column => column.at >= slot && (column.trigger === "scheduled" || column.trigger === "unknown"));
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
    FETCH_ERROR: "Couldn't fetch",
    EXTRACTION_ERROR: "Couldn't read content",
    BASELINE_MIGRATION: "Parser re-baseline"
  };

  function eventLabel(type) {
    return EVENT_LABELS[type] || "Monitoring event";
  }

  // "change" | "problem" | "info" — drives colour and filtering.
  function eventTone(type) {
    if (type === "FETCH_ERROR" || type === "EXTRACTION_ERROR") return "problem";
    if (type === "CHANGED_URL" || type === "NEW_URL" || type === "REMOVED_URL" || type === "HTML_SOURCE_CHANGED") return "change";
    return "info";
  }

  /* ---------- Unified diff parsing ---------- */

  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const TRUNCATION_RE = /^\.\.\. diff truncated after (\d+) lines$/;

  // Parse the engine's unified diff (difflib, 3 lines of context) into hunks.
  function parseUnifiedDiff(text) {
    const result = { hunks: [], truncated: false, truncatedAfter: null };
    let hunk = null;
    String(text || "").split(/\r?\n/).forEach(line => {
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
      if (!hunk || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\")) return;
      const marker = line.charAt(0);
      const body = line.slice(1);
      if (marker === "+") hunk.lines.push({ type: "add", text: body });
      else if (marker === "-") hunk.lines.push({ type: "del", text: body });
      else if (marker === " " || line === "") hunk.lines.push({ type: "ctx", text: marker === " " ? body : "" });
    });
    return result;
  }

  /* ---------- Word-level diff ---------- */

  const MAX_TOKENS = 600;

  function tokenize(text) {
    return String(text || "").match(/\s+|[A-Za-z0-9$%][A-Za-z0-9$%.,'’\/-]*[A-Za-z0-9%]|[A-Za-z0-9$%]|[^\sA-Za-z0-9]/g) || [];
  }

  // Longest-common-subsequence diff over tokens. Returns segments of
  // {type: "same"|"del"|"add", text}. Very long lines fall back to a whole-line
  // replacement rather than an expensive comparison.
  function wordDiff(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);
    if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
      return [{ type: "del", text: String(before || "") }, { type: "add", text: String(after || "") }]
        .filter(segment => segment.text);
    }
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = new Array(rows);
    for (let i = 0; i < rows; i++) table[i] = new Uint16Array(cols);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const segments = [];
    const push = (type, text) => {
      const last = segments[segments.length - 1];
      if (last && last.type === type) last.text += text;
      else segments.push({ type, text });
    };
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { push("same", a[i]); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) { push("del", a[i]); i++; }
      else { push("add", b[j]); j++; }
    }
    while (i < a.length) push("del", a[i++]);
    while (j < b.length) push("add", b[j++]);
    // Whitespace-only "same" runs between two edits read better folded into them.
    return segments;
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
  // and every changed line carries a change bar in the margin.
  function renderRedline(diffText) {
    const model = redlineRows(parseUnifiedDiff(diffText));
    if (!model.rows.length) {
      return { html: '<p class="rl-empty">No line-level text differences were recorded for this event.</p>', stats: model.stats, summary: redlineSummary(model.stats), truncated: model.truncated };
    }
    const html = model.rows.map(row => {
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
    }).join("");
    const tail = model.truncated
      ? '<div class="rl-gap rl-truncated" role="note">The stored diff stops after ' + esc(model.truncatedAfter) + " lines. Open the evidence file for the full before and after text.</div>"
      : "";
    return { html: html + tail, stats: model.stats, summary: redlineSummary(model.stats), truncated: model.truncated };
  }

  // Plain unified diff for technical review (HTML source and raw text diffs).
  function renderUnifiedDiff(diffText) {
    const text = String(diffText || "");
    if (!text.trim()) return '<p class="rl-empty">No differences were recorded in this evidence file.</p>';
    return '<div class="code-diff">' + text.split(/\r?\n/).map(line => {
      const cls = line.startsWith("+++") || line.startsWith("---") ? "cd-file"
        : line.startsWith("@@") ? "cd-hunk"
        : line.startsWith("+") ? "cd-add"
        : line.startsWith("-") ? "cd-del" : "";
      return '<div class="cd-line ' + cls + '">' + (esc(line) || "&nbsp;") + "</div>";
    }).join("") + "</div>";
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

  return {
    diffSequences, alignLines, changedWords,
    esc, nextScheduledScan, scanCycle, runColumns, columnCellState, pendingScan, normalizeTrigger, workflowRunTrigger, fbm, formatDuration, SCAN_INTERVAL_HOURS,
    eventLabel, eventTone, EVENT_LABELS,
    parseUnifiedDiff, tokenize, wordDiff, similarity, redlineRows, redlineSummary, renderRedline, renderUnifiedDiff,
    splitMarkdownTableRow, isMarkdownTableSeparator, relativeTime, dayHeading
  };
}));
