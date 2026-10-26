"""Measured alert precision per monitor, from reviewer verdicts.

Every change a monitor records ends in one of two places: the reviewer was
alerted, or the change stayed quiet (AI judged it not relevant, an alert
condition was not met, a markup-only edit, shadow mode). Reviewers then record
a decision on changes (regmon/reviews.py) and can report a change the monitor
missed entirely. Put together, that is a confusion matrix per monitor:

    alerted     + material      true positive   (the alert was worth it)
    alerted     + not material  false positive  (noise)
    not alerted + material      false negative  (the filter hid something)
    not alerted + not material  true negative
    reported missed             false negative  (never detected)

Precision = TP / (TP + FP); recall = TP / (TP + FN). With the handful of
reviews a monitor gets, a single number misleads, so each comes with a 95%
Wilson interval and the counts behind it.

From the same records, ``suggestions`` proposes how to tune the monitor's
alert condition: wording that kept appearing in noise becomes an exclusion,
wording in material changes it hid becomes something to alert on, and an
"alert only when met" that suppressed material changes is flagged. The owner
applies a suggestion through the usual condition request; nothing changes on
its own. ``acknowledged`` decisions are neither material nor not material and
are left out.

Shadow monitors send no content alerts; for them "alerted" means the change
would have alerted (AI relevant or condition met), which is what a shadow
comparison needs to judge.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter
from pathlib import Path

POSITIVE = {"material", "action_required"}
NEGATIVE = {"not_material"}
ALERTABLE = {"CHANGED_URL", "NEW_URL", "REMOVED_URL", "VISUAL_CHANGED"}
SCORED = ALERTABLE | {"HTML_SOURCE_CHANGED"}
QUIET_VARIANTS = {"ai_irrelevant", "condition_not_met"}  # as regmon/notify.py names them
STOPWORDS = frozenset("""
a an and are as at be been by for from has have in into is it its of on or that the this to was were will with not no new
change changes changed update updates updated page pages webpage website site content text entry entries item items section
document documents file files link links list removal removed added addition date dates version minor federal reserve board
regulator regulatory report reports reporting form forms the www html pdf xlsx after before about other its their than also
""".split())
MIN_REVIEWS_FOR_SUGGESTION = 2


def _r3(value: float) -> float:
    """Round half up to 3 places, exactly as the dashboard does."""
    return math.floor(value * 1000 + 0.5) / 1000


def wilson(successes: int, total: int, z: float = 1.96) -> list[float] | None:
    """95% Wilson score interval for a proportion, rounded to 3 places."""
    if total <= 0:
        return None
    p = successes / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    margin = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return [_r3(max(0.0, centre - margin)), _r3(min(1.0, centre + margin))]


def _alerted(event_id: str, sent_events: dict) -> tuple[bool, str]:
    for key in (event_id, event_id + "#ai"):
        record = sent_events.get(key)
        if record is None:
            continue
        variant = record.get("variant") if isinstance(record, dict) else None
        if variant in QUIET_VARIANTS:
            continue
        return True, str(variant or "alert")
    return False, ""


def outcomes(inventory: dict, sent_events: dict, ledger: dict, sources: list[dict] | None = None) -> list[dict]:
    """One row per recorded change: was it alerted, what did the reviewer decide."""
    shadow = {str(source.get("id")) for source in sources or [] if isinstance(source, dict) and source.get("shadow") is True}
    reviews = (ledger or {}).get("reviews") or {}
    rows: dict[str, dict] = {}
    for source_id, group in ((inventory or {}).get("sources") or {}).items():
        if not isinstance(group, dict):
            continue
        for item in group.values():
            if not isinstance(item, dict):
                continue
            for entry in item.get("change_history") or []:
                if not isinstance(entry, dict) or entry.get("event_type") not in SCORED or not entry.get("event_id"):
                    continue
                event_id = str(entry["event_id"])
                if event_id in rows:
                    continue
                alerted, variant = _alerted(event_id, sent_events or {}) if entry["event_type"] in ALERTABLE else (False, "")
                if not alerted and str(source_id) in shadow and entry["event_type"] in ALERTABLE:
                    alerted = entry.get("ai_relevant") is True or entry.get("ai_condition_met") is True
                    variant = "would_alert" if alerted else ""
                review = reviews.get(event_id) if isinstance(reviews.get(event_id), dict) else None
                decision = review.get("decision") if review else None
                if decision in POSITIVE:
                    outcome = "tp" if alerted else "fn"
                elif decision in NEGATIVE:
                    outcome = "fp" if alerted else "tn"
                else:
                    outcome = "unreviewed_alert" if alerted else "unreviewed"
                rows[event_id] = {
                    "event_id": event_id, "source_id": str(source_id), "event_type": entry["event_type"], "timestamp": entry.get("timestamp"),
                    "url": item.get("canonical_url"), "alerted": alerted, "variant": variant, "decision": decision, "outcome": outcome,
                    "ai_relevant": entry.get("ai_relevant"), "condition_met": entry.get("ai_condition_met"),
                    "topic": str(entry.get("ai_topic") or ""), "summary": str(entry.get("ai_summary") or ""),
                    "rationale": str((review or {}).get("rationale") or ""),
                }
    return sorted(rows.values(), key=lambda row: str(row.get("timestamp") or ""), reverse=True)


def scores(rows: list[dict], misses: list[dict] | None = None) -> dict[str, dict]:
    """Confusion counts, precision and recall (with 95% intervals) per monitor."""
    out: dict[str, dict] = {}
    for row in rows:
        counts = out.setdefault(row["source_id"], Counter())
        counts[row["outcome"]] += 1
    for miss in misses or []:
        if isinstance(miss, dict) and miss.get("source_id"):
            out.setdefault(str(miss["source_id"]), Counter())["missed"] += 1
    result = {}
    for source_id, counts in out.items():
        tp, fp, fn, tn, missed = (counts.get(key, 0) for key in ("tp", "fp", "fn", "tn", "missed"))
        alerts_reviewed = tp + fp
        material = tp + fn + missed
        precision = _r3(tp / alerts_reviewed) if alerts_reviewed else None
        recall = _r3(tp / material) if material else None
        result[source_id] = {
            "tp": tp, "fp": fp, "fn": fn, "tn": tn, "missed": missed,
            "alerts": tp + fp + counts.get("unreviewed_alert", 0), "unreviewed_alerts": counts.get("unreviewed_alert", 0),
            "reviewed": tp + fp + fn + tn, "unreviewed": counts.get("unreviewed", 0),
            "precision": precision, "precision_ci": wilson(tp, alerts_reviewed),
            "recall": recall, "recall_ci": wilson(tp, material),
            "f1": _r3(2 * precision * recall / (precision + recall)) if precision and recall else None,
        }
    return result


def _words(text: str) -> list[str]:
    return [word for word in re.findall(r"[a-z][a-z0-9-]{2,}", str(text or "").lower()) if word not in STOPWORDS and not word.isdigit()]


def _distinct(group: list[dict], other: list[dict], limit: int = 3) -> list[str]:
    """Words that recur in one group's topics and summaries and never in the other's."""
    if not group:
        return []
    other_words = {word for row in other for word in _words(row["topic"] + " " + row["summary"])}
    counts = Counter(word for row in group for word in dict.fromkeys(_words(row["topic"] + " " + row["summary"])))
    needed = 2 if len(group) >= 2 else 1
    ranked = [word for word, count in counts.most_common() if word not in other_words and count >= needed]
    return ranked[:limit]


def _join(words: list[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " or " + words[-1]


def suggestions(source: dict, rows: list[dict], score: dict | None) -> list[dict]:
    """How to tune this monitor's alert condition, from its reviewed changes."""
    if not score:
        return []
    out = []
    condition = " ".join(str(source.get("alert_condition") or "").split())
    only = bool(source.get("alert_only_on_condition"))
    tps = [row for row in rows if row["outcome"] == "tp"]
    fps = [row for row in rows if row["outcome"] == "fp"]
    fns = [row for row in rows if row["outcome"] == "fn"]
    noise = _distinct(fps, tps + fns)
    signal = _distinct(tps + fns, fps)
    hidden = _distinct(fns, fps)
    if len(fps) >= MIN_REVIEWS_FOR_SUGGESTION and (score["precision"] is None or score["precision"] < 0.6):
        generic = sum(1 for row in fps if row["variant"] == "generic")
        if not condition:
            text = ("Alert me when the change concerns " + _join(signal) + ".") if signal else "Alert me when requirements, deadlines, data items or validation rules change."
            if noise:
                text += " Ignore changes about " + _join(noise) + "."
            out.append({"kind": "add_condition", "title": "Add an alert condition",
                        "why": f"{len(fps)} of {score['tp'] + score['fp']} reviewed alerts were not material" +
                               (f"; they kept mentioning {_join(noise)}" if noise else "") + ".",
                        "condition": text[:500], "only": len(fps) >= 3})
        elif any(row["condition_met"] is True for row in fps):
            text = condition.rstrip(". ") + "." + (" Ignore changes about " + _join(noise) + "." if noise else " Only when it changes what must be reported or by when.")
            out.append({"kind": "narrow_condition", "title": "Narrow the alert condition",
                        "why": f"The condition was met on {sum(1 for row in fps if row['condition_met'] is True)} change(s) reviewed as not material.",
                        "condition": text[:500], "only": only})
        if generic:
            out.append({"kind": "ai_unavailable", "title": "Some false alarms were technical-change alerts",
                        "why": f"AI review was unavailable for {generic} of the false alarms, so the change alerted without being read. "
                               "Nothing to change in the condition; check the AI Smoke Test if this keeps happening."})
    if fns:
        suppressed_by_condition = [row for row in fns if row["condition_met"] is False]
        if condition and only and suppressed_by_condition:
            text = condition.rstrip(". ") + "." + (" Also alert when it concerns " + _join(hidden) + "." if hidden else "")
            out.append({"kind": "broaden_condition", "title": "Broaden the alert condition",
                        "why": f"{len(suppressed_by_condition)} material change(s) stayed quiet because the condition was not met.",
                        "condition": text[:500], "only": only if hidden else False})
        elif not condition and any(tip["kind"] == "add_condition" for tip in out):
            # The condition proposed for the noise already names what material changes share.
            tip = next(tip for tip in out if tip["kind"] == "add_condition")
            tip["why"] += f" It would also have alerted on {len(fns)} material change(s) that stayed quiet."
        elif not condition:
            text = "Alert me when the change concerns " + (_join(hidden) if hidden else "requirements, deadlines or data items") + "."
            out.append({"kind": "add_condition", "title": "Name what must always alert",
                        "why": f"{len(fns)} material change(s) were judged not relevant and stayed quiet. A condition makes these alert whatever the general relevance.",
                        "condition": text[:500], "only": False})
    if score["missed"]:
        every = source.get("check_every_hours")
        out.append({"kind": "missed", "title": "Changes were missed",
                    "why": f"{score['missed']} change(s) were reported as missed. Check the monitor's scope and selectors"
                           + (f", and whether scanning every {every} hours is often enough" if isinstance(every, (int, float)) and every > 6 else "") + "."})
    if score["fp"] >= 5 and score["tp"] == 0 and not source.get("shadow"):
        out.append({"kind": "shadow", "title": "Consider shadow mode",
                    "why": f"None of {score['fp']} reviewed alerts was material. Shadow mode keeps recording changes without sending them."})
    return out


def build(inventory: dict, sent_events: dict, ledger: dict, sources: list[dict]) -> dict:
    """Everything the dashboard and MCP server show: per-monitor scores, suggestions and the fleet total."""
    rows = outcomes(inventory, sent_events, ledger, sources)
    misses = [miss for miss in (ledger or {}).get("misses") or [] if isinstance(miss, dict)]
    per_source = scores(rows, misses)
    by_id = {str(source.get("id")): source for source in sources or [] if isinstance(source, dict)}
    monitors = []
    for source_id, score in per_source.items():
        own = [row for row in rows if row["source_id"] == source_id]
        monitors.append({"source_id": source_id, "name": by_id.get(source_id, {}).get("name") or source_id, **score,
                         "suggestions": suggestions(by_id.get(source_id, {}), own, score)})
    totals = scores([{**row, "source_id": "all"} for row in rows], [{**miss, "source_id": "all"} for miss in misses]).get("all")
    monitors.sort(key=lambda row: (-(row["reviewed"] + row["missed"]), row["name"]))
    return {"schema_version": 1, "monitors": monitors, "totals": totals, "outcomes": rows[:500]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.precision", description="Alert precision and recall per monitor from review decisions")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parent.parent / "data")
    parser.add_argument("--config", type=Path, default=Path(__file__).resolve().parent.parent / "config" / "sources.json")
    args = parser.parse_args(argv)

    def read(path: Path, default):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    result = build(read(args.data_dir / "latest.json", {}), (read(args.data_dir / "notifications.json", {}) or {}).get("sent_events") or {},
                   read(args.data_dir / "reviews" / "ledger.json", {}), (read(args.config, {}) or {}).get("sources") or [])
    for monitor in result["monitors"]:
        precision = "—" if monitor["precision"] is None else f"{monitor['precision']:.0%}"
        recall = "—" if monitor["recall"] is None else f"{monitor['recall']:.0%}"
        print(f"{monitor['name'][:60]:60}  precision {precision:>4}  recall {recall:>4}  "
              f"tp {monitor['tp']} fp {monitor['fp']} fn {monitor['fn']} tn {monitor['tn']} missed {monitor['missed']}")
        for suggestion in monitor["suggestions"]:
            print(f"    → {suggestion['title']}: {suggestion['why']}" + (f" Suggested: {suggestion['condition']}" if suggestion.get("condition") else ""))
    if not result["monitors"]:
        print("No recorded changes yet.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
