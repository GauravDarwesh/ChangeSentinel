"""Public spec changelog: what changed in each reporting form, as an append-only, hash-chained record.

Regulators publish new editions of forms, instructions, edit checks and taxonomies,
but rarely say what changed. Every substantive change ChangeSentinel detects is
written once to ``data/changelog/ledger.jsonl`` and never rewritten:

    {"seq": 12, "id": "<event id>", "at": "<detected>", "recorded": "<appended>",
     "type": "NEW_URL", "forms": ["OSFI BCAR"], "regulator": "OSFI", "title": "...",
     "url": "<the regulator's file>", "severity": {"level": 4, "label": "Edit check changed", ...},
     "effective": "Q1 2027", "summary": "<the structured diff's own headline>",
     "counts": {...}, "codes": [["BHCK2170", "amended", "Q1 2027"], ...],
     "predecessor": "<the edition it replaces>", "evidence": "data/evidence/<id>.json",
     "prev": "<hash of entry 11>", "hash": "<sha256 of this entry without hash>"}

``hash`` is the SHA-256 of the entry's canonical JSON (keys sorted, no spaces,
UTF-8) without ``hash``; ``prev`` is the hash before it (64 zeros for the first).
Changing, removing or reordering any entry breaks every hash after it, and git
history shows when each line was added. ``verify`` checks the chain; the public
page (changelog.html) checks it again in the reader's browser.

Only substantive changes are recorded: text, items, edit checks (severity 1+ in
data/change-facts.json, regmon/applicability.py). Markup-only page changes and
fetch errors are not. Everything is deterministic; AI summaries are never used.
An entry keeps what was known when it was appended: a later, better reading of
the same event does not rewrite it.

Views, rebuilt from the ledger after each scan and published on Pages:
``index.json`` (forms, counts, the chain head), ``<form>.json`` and ``<form>.atom``
per form, ``all.json`` and ``all.atom``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

from .fsutil import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG = ROOT / "config"
DIR_NAME = "changelog"
LEDGER = "ledger.jsonl"
SCHEMA_VERSION = 1
GENESIS = "0" * 64
TYPES = ("CHANGED_URL", "NEW_URL", "REMOVED_URL", "VISUAL_CHANGED")
MIN_LEVEL = 1
MAX_CODES = 20
MAX_SUMMARY = 600
FEED_JSON_ENTRIES = 500
FEED_ATOM_ENTRIES = 100
PAGES_URL = os.environ.get("CHANGESENTINEL_PAGES_URL", "https://gauravdarwesh.github.io/ChangeSentinel/").rstrip("/") + "/"
REPOSITORY = os.environ.get("GITHUB_REPOSITORY", "GauravDarwesh/ChangeSentinel")
FILE_DETAILS = re.compile(r"\s*\((?:PDF|XLSX?|ZIP|CSV|XML|XSD|DOCX?|HTML)[^)]*\)", re.I)
ALLOWLIST_NOTE = re.compile(r"\s*\([^)]*allowlist[^)]*\)", re.I)


def canonical(entry: dict) -> bytes:
    """The bytes an entry's hash is taken over: canonical JSON without ``hash`` (and the feeds' ``links``)."""
    body = {key: value for key, value in entry.items() if key not in ("hash", "links")}
    return json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def entry_hash(entry: dict) -> str:
    return hashlib.sha256(canonical(entry)).hexdigest()


def slug(form: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(form or "").lower()).strip("-") or "other"


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def read_ledger(data_dir: Path = DATA) -> list[dict]:
    path = data_dir / DIR_NAME / LEDGER
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    return [json.loads(line) for line in lines if line.strip()]


def verify(entries: list[dict]) -> list[str]:
    """Problems with the chain; an empty list means every entry is intact and in order."""
    problems = []
    prev = GENESIS
    seen = set()
    for index, entry in enumerate(entries, start=1):
        if entry.get("seq") != index:
            problems.append(f"entry {index}: seq is {entry.get('seq')!r}, expected {index}")
        if entry.get("prev") != prev:
            problems.append(f"entry {index}: prev does not match the hash of entry {index - 1}")
        if entry.get("hash") != entry_hash(entry):
            problems.append(f"entry {index}: hash does not match its content")
        if entry.get("id") in seen:
            problems.append(f"entry {index}: event {entry.get('id')} is recorded twice")
        seen.add(entry.get("id"))
        prev = entry.get("hash")
        if len(problems) >= 20:
            break
    return problems


def _title(source: dict, url: str) -> str:
    name = ALLOWLIST_NOTE.sub("", FILE_DETAILS.sub("", str(source.get("name") or ""))).strip()
    tail = url.rstrip("/").rsplit("/", 1)[-1].split("?", 1)[0]
    file_name = tail if re.search(r"\.[A-Za-z0-9]{2,5}$", tail) else ""
    if name and file_name and file_name.lower() not in name.lower():
        return f"{name} · {file_name}"
    return name or file_name or url


def _diff_lines(diff: str) -> tuple[int, int]:
    added = removed = 0
    for line in str(diff or "").splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed


def _plural(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def _summary(entry: dict, evidence: dict) -> tuple[str, dict]:
    """A deterministic one-paragraph account of the change, and its counts."""
    spec = evidence.get("spec_diff") or {}
    counts: dict = {}
    if spec.get("counts"):
        counts["spec"] = {key: int(value) for key, value in sorted(spec["counts"].items()) if isinstance(value, (int, float)) and value}
    codes = (evidence.get("item_codes") or {}).get("counts") or {}
    code_counts = {key: int(codes[key]) for key in ("added", "removed", "amended") if isinstance(codes.get(key), (int, float)) and codes[key]}
    if code_counts:
        counts["codes"] = code_counts
    added, removed = _diff_lines(evidence.get("diff"))
    if added or removed:
        counts["lines"] = {"added": added, "removed": removed}
    event_type = entry.get("event_type")
    lines = " and ".join(part for part in (_plural(added, "line added", "lines added") if added else "",
                                            _plural(removed, "line removed", "lines removed") if removed else "") if part) or "wording within lines changed"
    if spec.get("headline") and spec.get("tables"):
        text = str(spec["headline"])
    elif event_type == "REMOVED_URL":
        successor = entry.get("successor") or evidence.get("successor") or {}
        successor = successor.get("url") if isinstance(successor, dict) else ""
        text = "Removed from the regulator's site" + (f"; replaced by {successor}" if successor else "") + "."
    elif event_type == "VISUAL_CHANGED":
        text = "The rendered page looks different; its text did not change."
    elif isinstance(entry.get("predecessor"), dict) and entry["predecessor"].get("url"):
        text = f"New edition of {entry['predecessor']['url'].rstrip('/').rsplit('/', 1)[-1]}: {lines} in the extracted text."
    else:
        text = f"Text changed: {lines}."
    return (text if len(text) <= MAX_SUMMARY else text[: MAX_SUMMARY - 1].rstrip() + "…"), counts


def candidates(data_dir: Path = DATA, config_dir: Path = CONFIG) -> list[dict]:
    """Every substantive change event, oldest first, as an entry without seq, prev or hash."""
    facts = (_read_json(data_dir / "change-facts.json", {}) or {}).get("events") or {}
    latest = (_read_json(data_dir / "latest.json", {}) or {}).get("sources") or {}
    sources = {source.get("id"): source for source in (_read_json(config_dir / "sources.json", {}) or {}).get("sources") or [] if isinstance(source, dict)}
    regulators = [row for row in (_read_json(config_dir / "regulators.json", {}) or {}).get("regulators") or [] if isinstance(row, dict)]

    def regulator_of(url: str, stated: str) -> str:
        host = re.sub(r"^www\.", "", (re.match(r"^https?://([^/]+)", url or "") or [None, ""])[1].lower())
        for row in regulators:
            if any(host == known or host.endswith("." + known) for known in row.get("hosts") or []):
                return str(row.get("short_name") or row.get("name") or "")
        return stated
    out = []
    seen = set()
    for source_id, records in latest.items():
        for record in (records or {}).values():
            for history in record.get("change_history") or []:
                event_id = history.get("event_id")
                fact = facts.get(event_id or "")
                if not event_id or event_id in seen or not fact or history.get("event_type") not in TYPES:
                    continue
                severity = fact.get("severity") or {}
                if int(severity.get("level") or 0) < MIN_LEVEL:
                    continue
                seen.add(event_id)
                location = history.get("evidence_location") or ""
                evidence = _read_json(data_dir / location[len("data/"):], {}) if location.startswith("data/evidence/") else {}
                url = record.get("canonical_url") or evidence.get("url") or ""
                source = sources.get(source_id) or {}
                summary, counts = _summary(history, evidence)
                entry = {
                    "id": event_id, "at": history.get("timestamp") or fact.get("at") or "", "type": history.get("event_type"),
                    "forms": sorted({row["form"] for row in fact.get("forms") or [] if row.get("form")}),
                    "regulator": regulator_of(url, str(source.get("regulator") or record.get("regulator") or "")),
                    "title": _title(source, url), "url": url,
                    "severity": {key: severity[key] for key in ("level", "kind", "label", "detail") if severity.get(key) not in (None, "")},
                    "summary": summary,
                }
                effective = (fact.get("effective") or {}).get("quarter") or (fact.get("effective") or {}).get("date") or ""
                if effective:
                    entry["effective"] = effective
                if counts:
                    entry["counts"] = counts
                codes = [row[:3] for row in fact.get("codes") or [] if isinstance(row, list) and row][:MAX_CODES]
                if codes:
                    entry["codes"] = codes
                    if len(fact.get("codes") or []) > MAX_CODES:
                        entry["codes_total"] = len(fact["codes"])
                predecessor = history.get("predecessor") or evidence.get("predecessor")
                if isinstance(predecessor, dict) and predecessor.get("url"):
                    entry["predecessor"] = predecessor["url"]
                if location.startswith("data/evidence/"):
                    entry["evidence"] = location
                out.append(entry)
    out.sort(key=lambda entry: (entry["at"], entry["id"]))
    return out


def append(entries: list[dict], new: list[dict], now: str) -> list[dict]:
    """The ledger with every event it doesn't hold yet appended, chained to the last entry."""
    known = {entry.get("id") for entry in entries}
    out = list(entries)
    prev = out[-1]["hash"] if out else GENESIS
    for candidate in new:
        if candidate["id"] in known:
            continue
        entry = {"seq": len(out) + 1, **candidate, "recorded": now, "prev": prev}
        entry["hash"] = entry_hash(entry)
        out.append(entry)
        known.add(candidate["id"])
        prev = entry["hash"]
    return out


def _line(entry: dict) -> str:
    return json.dumps(entry, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _public(entry: dict) -> dict:
    """An entry as the feeds show it: the ledger entry plus absolute links (outside the hash)."""
    links = {"source": entry.get("url") or ""}
    if entry.get("evidence"):
        links["evidence"] = f"https://github.com/{REPOSITORY}/blob/main/{entry['evidence']}"
    return {**entry, "links": links}


def _atom(title: str, feed_slug: str, entries: list[dict], updated: str, head: str) -> str:
    self_url = f"{PAGES_URL}data/{DIR_NAME}/{feed_slug}.atom"
    parts = ['<?xml version="1.0" encoding="utf-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom">',
             f"  <title>{escape(title)}</title>",
             f"  <subtitle>{escape('What changed in the regulator’s published specifications, detected by ChangeSentinel. Chain head ' + head)}</subtitle>",
             f'  <link rel="self" type="application/atom+xml" href="{escape(self_url)}"/>',
             f'  <link rel="alternate" type="text/html" href="{escape(PAGES_URL + "changelog.html#" + feed_slug)}"/>',
             f"  <id>{escape(self_url)}</id>", f"  <updated>{escape(updated)}</updated>", "  <author><name>ChangeSentinel</name></author>"]
    for entry in entries[:FEED_ATOM_ENTRIES]:
        forms = ", ".join(entry.get("forms") or []) or "Regulator page"
        lines = [entry.get("summary") or ""]
        if entry.get("effective"):
            lines.append(f"Takes effect: {entry['effective']}.")
        if entry.get("predecessor"):
            lines.append(f"Replaces: {entry['predecessor']}")
        lines.append(f"Source: {entry.get('url') or ''}")
        lines.append(f"Ledger entry {entry['seq']}, SHA-256 {entry['hash']} (previous {entry['prev']}).")
        parts += ["  <entry>",
                  f"    <title>{escape(forms + ': ' + str((entry.get('severity') or {}).get('label') or 'Changed') + ' · ' + str(entry.get('title') or ''))}</title>",
                  f"    <id>urn:changesentinel:event:{escape(entry['id'])}</id>",
                  f"    <updated>{escape(entry.get('at') or updated)}</updated>",
                  f"    <published>{escape(entry.get('at') or updated)}</published>",
                  f'    <link rel="alternate" href="{escape(entry.get("url") or self_url)}"/>']
        parts += [f'    <category term="{escape(form)}"/>' for form in entry.get("forms") or []]
        parts += [f'    <content type="text">{escape(chr(10).join(lines))}</content>', "  </entry>"]
    parts.append("</feed>")
    return "\n".join(parts) + "\n"


def views(entries: list[dict], now: str) -> dict[str, str]:
    """{file name: text} for every published view of the ledger."""
    head = entries[-1]["hash"] if entries else GENESIS
    newest = list(reversed(entries))
    by_form: dict[str, list[dict]] = {}
    for entry in newest:
        for form in entry.get("forms") or []:
            by_form.setdefault(form, []).append(entry)
    files: dict[str, str] = {}
    about = ("Substantive changes to regulators' published reporting specifications, detected deterministically by ChangeSentinel. "
             "Each entry is appended once to ledger.jsonl and chained: hash = SHA-256 of the entry's canonical JSON "
             "(keys sorted, no spaces, UTF-8) without 'hash' and 'links'; prev = the previous entry's hash.")
    forms = []
    for form in sorted(by_form, key=lambda name: (-len(by_form[name]), name)):
        rows = by_form[form]
        feed = slug(form)
        forms.append({"form": form, "slug": feed, "entries": len(rows), "latest": rows[0].get("at") or "",
                      "regulator": next((row.get("regulator") for row in rows if row.get("regulator")), ""),
                      "levels": {str(level): sum(1 for row in rows if (row.get("severity") or {}).get("level") == level) for level in range(5, 0, -1)},
                      "json": f"data/{DIR_NAME}/{feed}.json", "atom": f"data/{DIR_NAME}/{feed}.atom"})
        files[f"{feed}.json"] = json.dumps({"schema_version": SCHEMA_VERSION, "form": form, "updated_at": now, "head": head, "about": about,
                                            "entries": [_public(row) for row in rows[:FEED_JSON_ENTRIES]]}, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
        files[f"{feed}.atom"] = _atom(f"{form}: specification changes", feed, rows, now, head)
    files["all.json"] = json.dumps({"schema_version": SCHEMA_VERSION, "form": "", "updated_at": now, "head": head, "about": about,
                                    "entries": [_public(row) for row in newest[:FEED_JSON_ENTRIES]]}, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    files["all.atom"] = _atom("Regulatory reporting specification changes", "all", newest, now, head)
    files["index.json"] = json.dumps({"schema_version": SCHEMA_VERSION, "updated_at": now, "entries": len(entries), "head": head,
                                      "first": entries[0].get("at") if entries else "", "about": about, "ledger": f"data/{DIR_NAME}/{LEDGER}",
                                      "all": {"json": f"data/{DIR_NAME}/all.json", "atom": f"data/{DIR_NAME}/all.atom"}, "forms": forms},
                                     ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    return files


def write(data_dir: Path = DATA, config_dir: Path = CONFIG, now: str | None = None) -> dict:
    """Append new changes to the ledger and rebuild the views. Refuses to extend a broken chain."""
    now = now or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    folder = data_dir / DIR_NAME
    entries = read_ledger(data_dir)
    problems = verify(entries)
    if problems:
        raise ValueError("The changelog ledger is broken; nothing was appended: " + "; ".join(problems[:3]))
    updated = append(entries, candidates(data_dir, config_dir), now)
    added = len(updated) - len(entries)
    folder.mkdir(parents=True, exist_ok=True)
    if added or not (folder / LEDGER).exists():
        atomic_write_text(folder / LEDGER, "".join(_line(entry) + "\n" for entry in updated))
    stamp = now if added else (_read_json(folder / "index.json", {}) or {}).get("updated_at") or now
    files = views(updated, stamp)
    wanted = set(files) | {LEDGER}
    for name, text in files.items():
        path = folder / name
        try:
            if path.read_text(encoding="utf-8") == text:
                continue
        except OSError:
            pass
        atomic_write_text(path, text)
    for path in folder.iterdir():
        if path.is_file() and path.name not in wanted:
            path.unlink()  # a form no entry names any more (views only; the ledger is never pruned)
    return {"entries": len(updated), "added": added, "forms": sum(1 for name in files if name.endswith(".json")) - 2, "head": updated[-1]["hash"] if updated else GENESIS}


def validate(data_dir: Path = DATA) -> list[str]:
    """validate_state's check: the ledger, when present, chains and parses."""
    path = data_dir / DIR_NAME / LEDGER
    if not path.exists():
        return []
    try:
        entries = read_ledger(data_dir)
    except ValueError as exc:
        return [f"data/{DIR_NAME}/{LEDGER}: a line does not parse ({exc})"]
    return [f"data/{DIR_NAME}/{LEDGER}: {problem}" for problem in verify(entries)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.changelog", description="The public, hash-chained spec changelog")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build", help="Append new changes and rebuild the feeds")
    sub.add_parser("verify", help="Check the hash chain")
    pending = sub.add_parser("pending", help="List changes not yet in the ledger")
    pending.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "verify":
        entries = read_ledger(DATA)
        problems = verify(entries)
        for problem in problems:
            print(problem, file=sys.stderr)
        if not problems:
            print(f"OK: {len(entries)} entries, head {entries[-1]['hash'] if entries else GENESIS}")
        return 1 if problems else 0
    if args.command == "pending":
        known = {entry.get("id") for entry in read_ledger(DATA)}
        rows = [entry for entry in candidates(DATA, CONFIG) if entry["id"] not in known]
        print(json.dumps(rows, indent=1, ensure_ascii=False) if args.json else "\n".join(f"{row['at']}  {', '.join(row['forms']) or '-'}  {row['title']}" for row in rows))
        return 0
    result = write(DATA, CONFIG)
    print(f"Changelog: {result['entries']} entries ({result['added']} new) across {result['forms']} forms; head {result['head'][:16]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
