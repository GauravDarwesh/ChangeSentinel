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

  // The scheduled six-hour slots ending with the one in progress, oldest first.
  function scanSlots(reference = new Date(), count = 28) {
    const periodMs = SCAN_INTERVAL_HOURS * 3600 * 1000;
    const currentStart = nextScheduledScan(reference).getTime() - periodMs;
    const slots = [];
    for (let i = count - 1; i >= 0; i--) {
      const start = currentStart - i * periodMs;
      slots.push({ start, end: start + periodMs, current: i === 0 });
    }
    return slots;
  }

  // One LED in the change field: what happened to one page during one slot.
  //   "on"  a scan in this slot found a content change
  //   "new" the page first appeared in this slot
  //   "bad" a scan in this slot could not fetch or read the page
  //   "dim" the page was scanned and nothing changed
  //   "none" no scan covered the page (not yet monitored, or no run)
  // Scans are runs of the page's source; a scheduled run often lands hours
  // into its slot, so anything inside [start, end) belongs to that slot.
  function slotState(slot, page) {
    const inSlot = time => {
      const t = new Date(time).getTime();
      return !Number.isNaN(t) && t >= slot.start && t < slot.end;
    };
    const firstSeen = page.firstSeen ? new Date(page.firstSeen).getTime() : null;
    if (firstSeen !== null && !Number.isNaN(firstSeen) && slot.end <= firstSeen) return "none";
    const events = (page.events || []).filter(event => inSlot(event.timestamp));
    if (events.some(event => event.event_type === "FETCH_ERROR" || event.event_type === "EXTRACTION_ERROR")) return "bad";
    if (page.problemAt && inSlot(page.problemAt)) return "bad";
    if (events.some(event => event.event_type === "NEW_URL")) return "new";
    if (events.some(event => event.event_type === "CHANGED_URL" || event.event_type === "REMOVED_URL" || event.event_type === "HTML_SOURCE_CHANGED")) return "on";
    if ((page.scans || []).some(inSlot)) return "dim";
    return "none";
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

  return {
    esc, nextScheduledScan, scanCycle, scanSlots, slotState, formatDuration, SCAN_INTERVAL_HOURS,
    eventLabel, eventTone, EVENT_LABELS,
    parseUnifiedDiff, tokenize, wordDiff, similarity, redlineRows, redlineSummary, renderRedline, renderUnifiedDiff,
    splitMarkdownTableRow, isMarkdownTableSeparator, relativeTime, dayHeading
  };
}));
