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
    const staleAfter = Number((h.thresholds || {}).stale_after_hours) || 14;
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
    const recovered = monitors.filter(m => m.status !== "failing" && Number(m.failures_7d) > 0).sort((a, b) => b.failures_7d - a.failures_7d);
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
    if (stale.length) out.push({ tone: "warn", key: "stale", targets: ids(stale), text: many(stale.length, "monitor hasn't", "monitors haven't") + " been scanned in over " + staleAfter + " hours: " + names(stale) + "." });
    const quiet = monitors.filter(m => m.status === "inactive");
    if (quiet.length) out.push({ tone: "warn", key: "quiet", targets: ids(quiet), text: many(quiet.length, "monitor has", "monitors have") + " been quiet for " + quietAfter + "+ days. The page may have moved; check the regulator's site." });
    const soon = monitors.filter(m => m.status !== "inactive" && Number(m.days_without_change) >= quietAfter - 14 && Number(m.days_without_change) < quietAfter)
      .sort((a, b) => b.days_without_change - a.days_without_change);
    if (soon.length) out.push({ tone: "info", key: "soon-quiet", targets: ids(soon), text: many(soon.length, "monitor reaches", "monitors reach") + " the " + quietAfter + "-day quiet mark within two weeks: " + names(soon) + "." });
    const year = Array.isArray(h.year_bound) ? h.year_bound : [];
    if (year.length) out.push({ tone: "info", key: "year", targets: year.map(y => String(y.source_id)), text: many(year.length, "address carries", "addresses carry") + " a past year. Next year's list may be published at a new address." });
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
      out.push({ tone: "ok", key: "coverage", text: "Every monitor was covered by the last scan" + (scans.length > 1 ? ", all within " + Math.max(1, Math.round(spread)) + " min of each other" : "") + "; " + (Math.round(Number(week.success_rate || 0) * 1000) / 10) + "% of " + Number(week.checks).toLocaleString() + " checks succeeded this week." });
    }
    return out;
  }
  // The colour a monitor's light takes in the fleet matrix.
  function healthLight(monitor, now = Date.now()) {
    const m = monitor || {};
    if (m.status === "failing") return "bad";
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

  // "change" | "markup" | "problem" | "info" — markup-only events remain visible,
  // but are visually quieter than changes to extracted regulatory content.
  function eventTone(type) {
    if (type === "FETCH_ERROR" || type === "EXTRACTION_ERROR") return "problem";
    if (type === "HTML_SOURCE_CHANGED") return "markup";
    if (type === "CHANGED_URL" || type === "NEW_URL" || type === "REMOVED_URL") return "change";
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
  function canonicalUrl(value) {
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
  function urlKey(value) {
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

  return {
    pickFormat, pickSlug, pickInScope, pickSections, pickMatches, pickGroupBy, pickSummary, pickBatches, pickMonitorName,
    pickScopeOptions, pickHosts, pickDiscoveryRequest, PICK_MAX_LINKS, PICK_MAX_REQUEST_LENGTH, pickScore, pickVersions, pickSimilar, pickRecipe, pickRuleMatches, pickRuleFolder, pickRuleRequest,
    diffSequences, alignLines, changedWords, readWorkbook, workbookDiff, csvWorkbook, parseCsv, zipListing, zipFile, readDocx, columnName, cellRef,
    esc, nextScheduledScan, scanCycle, runColumns, slotColumns, columnCellState, pendingScan,
    timelineModel, timelineGapWords, TIMELINE_KINDS, healthInsights, healthLight,
    fieldWindow, mergeCellStates, rowActivity, fieldCounts, fieldRows, FIELD_RANGES, FIELD_LENSES, regulatorFor, jurisdictionForHost, hostOf, pageKind, normalizeTrigger, workflowRunTrigger, fbm, formatDuration, SCAN_INTERVAL_HOURS,
    eventLabel, eventTone, EVENT_LABELS,
    parseUnifiedDiff, tokenize, wordDiff, similarity, redlineRows, redlineSummary, renderRedline, renderUnifiedDiff,
    splitMarkdownTableRow, isMarkdownTableSeparator, relativeTime, dayHeading,
    foldWhitespace, inlineMarkdown, xlsxFirstSheetRows, normalizeForMatch, changedPartOffsets, tableCellsMatch,
    canonicalUrl, urlKey, scoutBucket, scoutBuckets, scoutSentence, scoutReviewIssue, nextScoutSweep, scoutStrength, scoutGroups,
    SCOUT_FILTERS, SCOUT_OUTCOMES, SCOUT_CONFIDENCE, SCOUT_STATUS, SCOUT_CHANNEL_STATUS, SCOUT_NOUNS, SCOUT_REVIEW_MARKER,
    scoutSlug, splitList, splitLines, parsePathHints, pathHintsText, scoutSourceRequest, SCOUT_SOURCE_MARKER, SCOUT_TOPIC_IDS, SCOUT_REGIONS,
    renderWordEdit, describeItemCodes, lineageFor, localIsoDate, isoDayToDate, daysBetween, dueLabel, upcomingDates, datesForChange,
    changeReviewRequest, CHANGE_REVIEW_MARKER, REVIEW_DECISIONS, csvCell, toCsv, fileSlug,
    cadencePlan, cadenceWeeks, businessShift, nextBusinessDay, googleCalendarLink
  };
}));
