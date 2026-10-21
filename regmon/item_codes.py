"""Reporting-item codes in form documents, and what a change did to them.

Regulatory report forms identify every reported data point by a code: a
four-letter series mnemonic and a four-character item number, for example
``BHCK2170`` (FR Y-9C total assets) or ``QTFL 1596`` (FR 2028B/S). Downstream
reporting pipelines, data warehouses and edit checks are keyed by these codes,
so the question a reporting team asks about a changed form is not "which lines
of text moved" but "which items were added, retired or redefined".

``diff()`` answers that deterministically from the before and after text the
engine already compares (no model, same answer on every machine):

* added    codes present after the change and not before
* removed  codes present before and not after
* amended  codes whose table row (``| ... |`` lines, as pdf_grid.py and the PDF
           table extractors write them) reads differently, i.e. the item's
           label, options or instructions in the form's grid changed

A candidate counts as an item code only when its series has at least
``MIN_FAMILY`` distinct items in the same document and its item part carries a
digit, which keeps words such as "YEAR 2026" or "FORM 2028" out. Results are
capped so a rewritten document cannot bloat evidence files.
"""
from __future__ import annotations

import re
from collections import defaultdict

ITEM_CODE = re.compile(r"\b([A-Z]{4})\s?([A-Z0-9]{4})\b")
MIN_FAMILY = 3
MAX_ENTRIES = 300
MAX_CONTEXT = 240
# Four-letter words that precede a number in ordinary prose and are never a
# reporting series.
STOP_SERIES = frozenset({
    "CODE", "DATE", "FILE", "FORM", "ITEM", "JULY", "JUNE", "LINE", "NOTE", "PAGE", "PART",
    "RATE", "ROOM", "RULE", "SECT", "SIZE", "TIER", "WEEK", "YEAR", "ZONE",
})


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _signature(row: str) -> str:
    return re.sub(r"[^0-9a-z]", "", row.lower())


def _context(line: str, start: int, end: int) -> str:
    line = str(line)
    if len(line) <= MAX_CONTEXT:
        return _clean(line)
    half = (MAX_CONTEXT - (end - start)) // 2
    left = max(0, start - half)
    right = min(len(line), end + half)
    return ("…" if left else "") + _clean(line[left:right]) + ("…" if right < len(line) else "")


def _scan(text: str) -> tuple[dict[str, str], dict[str, list[str]]]:
    """First context line per code, and every table row each code appears in."""
    contexts: dict[str, str] = {}
    rows: dict[str, list[str]] = defaultdict(list)
    families: dict[str, set[str]] = defaultdict(set)
    found: list[tuple[str, str, int, int, bool]] = []
    for line in str(text or "").splitlines():
        is_row = line.lstrip().startswith("|")
        for match in ITEM_CODE.finditer(line):
            series, item = match.group(1), match.group(2)
            if series in STOP_SERIES or not re.search(r"\d", item):
                continue
            code = series + item
            families[series].add(code)
            found.append((code, line, match.start(), match.end(), is_row))
    accepted = {series for series, codes in families.items() if len(codes) >= MIN_FAMILY}
    for code, line, start, end, is_row in found:
        if code[:4] not in accepted:
            continue
        contexts.setdefault(code, _context(line, start, end))
        if is_row:
            row = _clean(line)
            if row not in rows[code]:
                rows[code].append(row)
    return contexts, dict(rows)


def codes_in(text: str) -> set[str]:
    """Every reporting-item code the text contains."""
    return set(_scan(text)[0])


def diff(before_text: str | None, after_text: str | None) -> dict | None:
    """Item-level summary of a change, or None when neither side has item codes."""
    before, before_rows = _scan(before_text or "")
    after, after_rows = _scan(after_text or "")
    if not before and not after:
        return None
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    amended = []
    for code in sorted(set(before) & set(after)):
        old_rows, new_rows = before_rows.get(code, []), after_rows.get(code, [])
        # A code repeated in many rows is a cross-reference (an edit test, a
        # total); only an item defined in a few grid rows has a definition.
        if not old_rows or not new_rows or len(old_rows) > 3 or len(new_rows) > 3:
            continue
        # Compare letters and digits only: a parser that splits one cell into
        # several ("sho | uld") or re-wraps a row has not redefined the item.
        if sorted(map(_signature, old_rows)) == sorted(map(_signature, new_rows)):
            continue
        new_signatures = {_signature(row) for row in new_rows}
        old_signatures = {_signature(row) for row in old_rows}
        gone = [row for row in old_rows if _signature(row) not in new_signatures]
        came = [row for row in new_rows if _signature(row) not in old_signatures]
        amended.append({
            "code": code,
            "before": (gone or old_rows)[0][:MAX_CONTEXT * 2],
            "after": (came or new_rows)[0][:MAX_CONTEXT * 2],
        })
    series = sorted({code[:4] for code in set(before) | set(after)})
    result = {
        "version": 1,
        "series": series,
        "before_count": len(before),
        "after_count": len(after),
        "counts": {"added": len(added), "removed": len(removed), "amended": len(amended)},
        "added": [{"code": code, "context": after[code]} for code in added[:MAX_ENTRIES]],
        "removed": [{"code": code, "context": before[code]} for code in removed[:MAX_ENTRIES]],
        "amended": amended[:MAX_ENTRIES],
    }
    if len(added) > MAX_ENTRIES or len(removed) > MAX_ENTRIES or len(amended) > MAX_ENTRIES:
        result["truncated"] = True
    return result


def summary(result: dict | None, sample: int = 6) -> dict | None:
    """The small part kept on the event and in the page's change timeline."""
    if not result or not any(result.get("counts", {}).values()):
        return None
    codes = [entry["code"] for key in ("added", "removed", "amended") for entry in result.get(key, [])]
    return {"counts": dict(result["counts"]), "codes": codes[:sample], "series": list(result.get("series", []))[:8]}


def describe(result_or_summary: dict | None) -> str:
    """"2 added, 1 removed, 3 amended (BHCK2170, …)" for alerts; "" when nothing changed."""
    if not result_or_summary:
        return ""
    counts = result_or_summary.get("counts") or {}
    parts = [f"{counts[key]} {key}" for key in ("added", "removed", "amended") if counts.get(key)]
    if not parts:
        return ""
    codes = result_or_summary.get("codes")
    if codes is None:
        codes = [entry["code"] for key in ("added", "removed", "amended") for entry in result_or_summary.get(key, [])]
    shown = ", ".join(codes[:4]) + (", …" if len(codes) > 4 else "")
    return ", ".join(parts) + (f" ({shown})" if shown else "")
