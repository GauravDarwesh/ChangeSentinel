"""Pre-flight: run the regulator's own edit checks on a filing before it is due.

The FFIEC CDR publishes every Call Report edit (FFIEC 031/041/051) as a formula in its
taxonomy (``-ec.xml``, about 3,600 per form; ruleType1 = Validity, ruleType2 = Quality),
with its message (``-ec-mess.xml``). The scan already saves each taxonomy version. This
module:

* ``edits_from_text`` reads a saved taxonomy into edits ``{id, type, formula, message}``;
* ``build`` writes them per form and taxonomy date to ``data/edits/`` (regulator side,
  public) after each scan, so the dashboard can fetch the newest set and the one before;
* ``evaluate`` runs one formula on a filing's values with three-valued logic: a value the
  filing doesn't hold makes an edit *not evaluated* (naming what's missing), never a pass
  or a fail. ``ExistingOf(x, d)`` and ``ExistsNonEmpty(x)`` are how the regulator says a
  value may be absent;
* ``read_filing`` reads a filing: an XBRL instance (the file submitted to the CDR) or a CSV
  of ``code,value[,period]``;
* ``run`` / ``compare`` give pass / fail / not evaluated per edit, and what would newly fail
  under a new edit set (new edits, changed formulas) that passes today.

The dashboard runs the same evaluator in the browser (``L.preflight*`` in dashboard-lib.js,
kept equal by a parity test over every real formula), so a bank's numbers never leave its
machine. Nothing here is AI.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from pathlib import Path

from .fsutil import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DIRECTORY = "edits"
SCHEMA_VERSION = 1
RULE_TYPES = {"ruleType1": "Validity", "ruleType2": "Quality"}
TAXONOMY_NAME = re.compile(r"call-report(0\d\d)-(20\d\d-\d\d-\d\d)-v(\d+)")
FORMULA = re.compile(r'<ns\d+:formula select="([^"]*)" ns\d+:label="([^"]*)" ns\d+:role="[^"]*/(ruleType\d)"')
MESSAGE = re.compile(r'<ns\d+:label ns\d+:label="([^"]*?)_lbl_\d+" ns\d+:role="[^"]*/ruleMessage\d"[^>]*>(.*?)</ns\d+:label>', re.S)
MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


# --------------------------------------------------------------------------- edits from a taxonomy


def edits_from_text(text: str) -> dict | None:
    """{form, date, version, edits: [{id, type, formula, message}]} from a saved CDR taxonomy, or None."""
    name = TAXONOMY_NAME.search(text or "")
    if not name:
        return None
    form, day, version = name.group(1), name.group(2), name.group(3)
    messages: dict[str, str] = {}
    for label, body in MESSAGE.findall(text):
        quoted = re.search(r"'((?:[^']|'')*)'", html.unescape(body))
        if quoted and label not in messages:
            # "… SHOULD BE NON-NEGATIVE || Amt Reported =": filing software appends the value after "||".
            messages[label] = " ".join(quoted.group(1).replace("''", "'").split("||")[0].split())[:400]
    edits = []
    seen = set()
    for formula, label, role in FORMULA.findall(text):
        identifier = re.sub(r"_formula$", "", label)
        if identifier in seen or role not in RULE_TYPES:
            continue
        seen.add(identifier)
        edits.append({"id": re.sub(r"^ffiec0\d\d_", "", identifier), "type": RULE_TYPES[role],
                      "formula": " ".join(html.unescape(formula).split()), "message": messages.get(identifier, "")})
    if not edits:
        return None
    edits.sort(key=lambda edit: (edit["type"], edit["id"]))
    return {"form": "FFIEC " + form, "date": day, "version": version, "edits": edits}


# --------------------------------------------------------------------------- the formula language


class FormulaError(ValueError):
    pass


TOKEN = re.compile(r"""\s*(?:
    (?P<num>\d+(?:\.\d+)?|\.\d+)
  | (?P<str>"[^"]*")
  | (?P<ref>cc:[A-Za-z0-9]+\[[^\]]+\])
  | (?P<ctx>Context\.Period\.EndDate)
  | (?P<name>[A-Za-z_][A-Za-z_0-9]*)
  | (?P<op><>|>=|<=|=|<|>|\+|-|\*|/|\(|\)|,|&)
)""", re.X)
BINARY = {"or": 1, "and": 2, "=": 3, "<>": 3, "<": 3, ">": 3, "<=": 3, ">=": 3, "&": 4, "+": 5, "-": 5, "*": 6, "/": 6}


def tokenize(formula: str) -> list[tuple[str, str]]:
    tokens, at = [], 0
    text = formula or ""
    while at < len(text):
        if not text[at:].strip():
            break
        match = TOKEN.match(text, at)
        if not match or match.end() == at:
            raise FormulaError(f"cannot read the formula at {text[at:at + 20]!r}")
        kind = match.lastgroup
        value = match.group(kind)
        if kind == "name" and value.lower() in {"and", "or"}:
            kind, value = "op", value.lower()
        tokens.append((kind, value))
        at = match.end()
    return tokens


def parse(formula: str):
    """The formula as a small tree: ("num", x) ("str", s) ("bool", b) ("ref", code, ctx) ("date",)
    ("call", name, args) ("neg", x) ("op", op, a, b). Precedence: or < and < comparison < & < + - < * /."""
    tokens = tokenize(formula)
    position = 0

    def peek():
        return tokens[position] if position < len(tokens) else ("end", "")

    def take(expected: str | None = None):
        nonlocal position
        token = peek()
        if expected is not None and token[1] != expected:
            raise FormulaError(f"expected {expected!r}, found {token[1]!r}")
        position += 1
        return token

    def primary():
        kind, value = take()
        if kind == "num":
            return ("num", float(value))
        if kind == "str":
            return ("str", value[1:-1])
        if kind == "ref":
            code, ctx = re.fullmatch(r"cc:([A-Za-z0-9]+)\[([^\]]+)\]", value).groups()
            return ("ref", code.upper(), ctx)
        if kind == "ctx":
            return ("date",)
        if kind == "op" and value == "(":
            node = expression(1)
            take(")")
            return node
        if kind == "op" and value == "-":
            return ("neg", primary())
        if kind == "name":
            lower = value.lower()
            if lower in {"true", "false"} and peek()[1] != "(":
                return ("bool", lower == "true")
            take("(")
            args = []
            if peek()[1] != ")":
                args.append(expression(1))
                while peek()[1] == ",":
                    take(",")
                    args.append(expression(1))
            take(")")
            return ("call", lower, args)
        raise FormulaError(f"unexpected {value!r}")

    def expression(minimum: int):
        left = primary()
        while True:
            kind, value = peek()
            if kind != "op" or value not in BINARY or BINARY[value] < minimum:
                return left
            take()
            left = ("op", value, left, expression(BINARY[value] + 1))

    node = expression(1)
    if position != len(tokens):
        raise FormulaError(f"unexpected {peek()[1]!r} after the end of the formula")
    return node


class Missing:
    """A value the filing doesn't hold. Propagates through arithmetic and comparison."""

    def __init__(self, refs):
        self.refs = tuple(sorted(set(refs)))

    def __repr__(self):
        return f"Missing({', '.join(self.refs)})"


def _missing(*values) -> Missing | None:
    gone = [value for value in values if isinstance(value, Missing)]
    return Missing([ref for value in gone for ref in value.refs]) if gone else None


def _month_end(year: int, month: int) -> date:
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    return date(year, month, 29 if month == 2 and leap else MONTH_DAYS[month - 1])


def shift(day: date, ctx: str) -> date | None:
    """The period end a context names, from the report date: P0, -P1Q … -P7Q, -P1Y/-06-end."""
    if ctx == "P0":
        return day
    match = re.fullmatch(r"-P(\d+)Q", ctx)
    if match:
        months = day.year * 12 + day.month - 1 - 3 * int(match.group(1))
        return _month_end(months // 12, months % 12 + 1)
    match = re.fullmatch(r"-P(\d+)Y/-(\d\d)-end", ctx)
    if match:
        return _month_end(day.year - int(match.group(1)), int(match.group(2)))
    return None


def _number(value) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if re.fullmatch(r"-?\d+(\.\d+)?", text):
        return float(text)
    raise FormulaError(f"{value!r} is not a number")


def _equal(a, b) -> bool:
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if isinstance(a, str) or isinstance(b, str):
        try:
            return _number(a) == _number(b)
        except FormulaError:
            return str(a) == str(b)
    return abs(_number(a) - _number(b)) < 1e-9


def evaluate(node, values: dict, report_date: date):
    """The value of a parsed formula: a number, string, bool, date or Missing."""
    kind = node[0]
    if kind in {"num", "str", "bool"}:
        return node[1]
    if kind == "date":
        return report_date
    if kind == "ref":
        day = shift(report_date, node[2])
        key = (node[1], day.isoformat() if day else node[2])
        return values[key] if key in values else Missing([f"{node[1]}[{node[2]}]"])
    if kind == "neg":
        value = evaluate(node[1], values, report_date)
        return value if isinstance(value, Missing) else -_number(value)
    if kind == "op":
        _, op, a_node, b_node = node
        if op in {"and", "or"}:
            a = evaluate(a_node, values, report_date)
            if op == "and" and a is not None and not isinstance(a, Missing) and not a:
                return False
            if op == "or" and not isinstance(a, Missing) and bool(a):
                return True
            b = evaluate(b_node, values, report_date)
            if op == "and":
                if not isinstance(b, Missing) and not b:
                    return False
                return _missing(a, b) or True
            if not isinstance(b, Missing) and bool(b):
                return True
            return _missing(a, b) or False
        a = evaluate(a_node, values, report_date)
        b = evaluate(b_node, values, report_date)
        gone = _missing(a, b)
        if gone:
            return gone
        if op == "&":
            return f"{a}{b}"
        if op in {"=", "<>"}:
            same = _equal(a, b)
            return same if op == "=" else not same
        x, y = _number(a), _number(b)
        if op in {"<", ">", "<=", ">="}:
            return {"<": x < y, ">": x > y, "<=": x <= y, ">=": x >= y}[op]
        if op == "+":
            return x + y
        if op == "-":
            return x - y
        if op == "*":
            return x * y
        return Missing(["division by zero"]) if y == 0 else x / y
    if kind == "call":
        _, name, args = node
        if name == "if":
            if len(args) != 3:
                raise FormulaError("If needs three arguments")
            condition = evaluate(args[0], values, report_date)
            if isinstance(condition, Missing):
                return condition
            return evaluate(args[1] if condition else args[2], values, report_date)
        if name == "existingof":
            value = evaluate(args[0], values, report_date)
            return evaluate(args[1], values, report_date) if isinstance(value, Missing) else value
        if name == "existsnonempty":
            value = evaluate(args[0], values, report_date)
            return not isinstance(value, Missing) and str(value).strip() != ""
        evaluated = [evaluate(arg, values, report_date) for arg in args]
        gone = _missing(*evaluated)
        if gone:
            return gone
        if name in {"yearof", "monthof", "dayof"}:
            day = evaluated[0]
            if not isinstance(day, date):
                raise FormulaError(f"{name} needs a date")
            return float({"yearof": day.year, "monthof": day.month, "dayof": day.day}[name])
        if name in {"min", "max"}:
            numbers = [_number(value) for value in evaluated]
            return min(numbers) if name == "min" else max(numbers)
        if name == "truncate":
            return float(math.trunc(_number(evaluated[0])))
        if name == "abs":
            return abs(_number(evaluated[0]))
        if name == "len":
            return float(len(_text(evaluated[0])))
        if name == "upper":
            return _text(evaluated[0]).upper()
        if name == "not":
            return not bool(evaluated[0])
        raise FormulaError(f"unknown function {name}")
    raise FormulaError(f"unknown node {kind}")


def _text(value) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def check(edit: dict, values: dict, report_date: date) -> dict:
    """One edit on one filing: {id, type, result: pass|fail|not_evaluated|error, missing?, error?}."""
    out = {"id": edit["id"], "type": edit["type"]}
    try:
        value = evaluate(parse(edit["formula"]), values, report_date)
    except (FormulaError, ValueError, TypeError) as error:
        return {**out, "result": "error", "error": str(error)[:200]}
    if isinstance(value, Missing):
        return {**out, "result": "not_evaluated", "missing": list(value.refs)[:12]}
    return {**out, "result": "pass" if bool(value) else "fail"}


# --------------------------------------------------------------------------- filings


def _value(text: str):
    text = str(text or "").strip()
    if re.fullmatch(r"-?\d+(\.\d+)?", text.replace(",", "")):
        return float(text.replace(",", ""))
    if text.lower() in {"true", "false"}:
        return text.lower() == "true"
    return text


def read_filing(content: bytes | str) -> tuple[dict, date | None]:
    """{(CODE, period end ISO or "P0"): value} and the report date, from an XBRL instance or a CSV."""
    text = content.decode("utf-8-sig", "replace") if isinstance(content, bytes) else content.lstrip("﻿")
    return _read_xbrl(text) if text.lstrip().startswith("<") else _read_csv(text)


def _read_xbrl(text: str) -> tuple[dict, date | None]:
    root = ET.fromstring(text)
    periods: dict[str, str] = {}
    for context in root.iter():
        if context.tag.rsplit("}", 1)[-1] != "context":
            continue
        end = ""
        for child in context.iter():
            if child.tag.rsplit("}", 1)[-1] in {"instant", "endDate"} and child.text:
                end = child.text.strip()[:10]
        if context.get("id") and end:
            periods[context.get("id")] = end
    values: dict = {}
    for fact in root.iter():
        ref = fact.get("contextRef")
        if ref in periods and (fact.text or "").strip():
            values[(fact.tag.rsplit("}", 1)[-1].upper(), periods[ref])] = _value(fact.text or "")
    report = max(periods.values()) if periods else ""
    return values, (date.fromisoformat(report) if report else None)


def _read_csv(text: str) -> tuple[dict, date | None]:
    rows = [row for row in csv.reader(io.StringIO(text)) if any(cell.strip() for cell in row)]
    if not rows:
        return {}, None
    header = [cell.strip().lower() for cell in rows[0]]
    has_header = not re.fullmatch(r"[A-Z]{4}[A-Z0-9]{4}", re.sub(r"\s+", "", rows[0][0]).upper())
    find = lambda names, default: next((header.index(name) for name in names if name in header), default)
    code_at = find(("code", "mdrm", "item", "mdrm number"), 0) if has_header else 0
    value_at = find(("value", "amount", "reported value"), 1) if has_header else 1
    period_at = find(("period", "date", "as of", "report date"), None) if has_header else (2 if len(rows[0]) > 2 else None)
    values: dict = {}
    periods = set()
    for row in rows[1 if has_header else 0:]:
        if len(row) <= max(code_at, value_at) or not row[value_at].strip():
            continue
        code = re.sub(r"\s+", "", row[code_at]).upper()
        if not re.fullmatch(r"[A-Z]{4}[A-Z0-9]{4}", code):
            continue
        period = row[period_at].strip()[:10] if period_at is not None and period_at < len(row) else ""
        period = period if re.fullmatch(r"\d{4}-\d\d-\d\d", period) else "P0"
        if period != "P0":
            periods.add(period)
        values[(code, period)] = _value(row[value_at])
    report = max(periods) if periods else ""
    return values, (date.fromisoformat(report) if report else None)


def _rebase(values: dict, report_date: date) -> dict:
    """Rows without a period are for the report date."""
    return {(code, report_date.isoformat() if period == "P0" else period): value for (code, period), value in values.items()}


def run(edits: list[dict], values: dict, report_date: date) -> dict:
    values = _rebase(values, report_date)
    results = [check(edit, values, report_date) for edit in edits]
    counts: dict[str, dict[str, int]] = {}
    for result in results:
        bucket = counts.setdefault(result["type"], {})
        bucket[result["result"]] = bucket.get(result["result"], 0) + 1
    return {"report_date": report_date.isoformat(), "counts": counts, "results": results}


def compare(old: list[dict], new: list[dict], values: dict, report_date: date) -> dict:
    """Under the new edit set: what fails that doesn't under the old one (new or changed edits)."""
    before = {result["id"]: result for result in run(old, values, report_date)["results"]}
    old_formulas = {edit["id"]: edit["formula"] for edit in old}
    after = run(new, values, report_date)
    newly = []
    for result, edit in zip(after["results"], new):
        if result["result"] != "fail":
            continue
        change = "new edit" if edit["id"] not in old_formulas else ("formula changed" if old_formulas[edit["id"]] != edit["formula"] else "")
        previous = before.get(result["id"])
        if change and (previous is None or previous["result"] != "fail"):
            newly.append({**result, "change": change})
    new_ids = {edit["id"] for edit in new}
    return {**after, "newly_failing": newly,
            "edits": {"added": sum(1 for edit in new if edit["id"] not in old_formulas),
                      "changed": sum(1 for edit in new if edit["id"] in old_formulas and old_formulas[edit["id"]] != edit["formula"]),
                      "removed": len(set(old_formulas) - new_ids)}}


def to_csv(result: dict, edits: list[dict]) -> str:
    by_id = {edit["id"]: edit for edit in edits}
    newly = {row["id"]: row.get("change", "") for row in result.get("newly_failing") or []}
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Edit", "Type", "Result", "Change", "Missing", "Message", "Formula"])
    for row in result["results"]:
        edit = by_id.get(row["id"], {})
        writer.writerow([row["id"], row["type"], row["result"], newly.get(row["id"], ""), " ".join(row.get("missing") or []),
                         edit.get("message", ""), edit.get("formula", "")])
    return out.getvalue()


# --------------------------------------------------------------------------- data/edits/


def build(data_dir: Path = DATA, now: str | None = None) -> dict:
    """Write data/edits/cdr-<taxonomy date>-<content hash>.json for every saved CDR taxonomy (current and the
    versions before it in each change's evidence), and data/edits/index.json. A version once
    written is kept, so the set before a new taxonomy stays available for comparison."""
    latest = json.loads((data_dir / "latest.json").read_text(encoding="utf-8")).get("sources") or {}
    directory = data_dir / DIRECTORY
    locations: set[str] = set()
    for records in latest.values():
        for record in (records or {}).values():
            if "cdr.ffiec.gov" not in str(record.get("canonical_url") or "") or not record.get("snapshot_location"):
                continue
            locations.add(record["snapshot_location"])
            for entry in record.get("change_history") or []:
                if not entry.get("evidence_location"):
                    continue
                try:
                    evidence = json.loads((data_dir.parent / entry["evidence_location"]).read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                before = (evidence.get("before") or {}).get("snapshot_location")
                if before:
                    locations.add(before)
    sets: dict[tuple, dict] = {}
    for location in sorted(locations):
        try:
            payload = edits_from_text((data_dir.parent / location).read_text(encoding="utf-8"))
        except OSError:
            continue
        if not payload:
            continue
        # The CDR ships one edit set for the 031, 041 and 051: stored once, named by its content.
        digest = hashlib.sha256(json.dumps(payload["edits"], sort_keys=True).encode("utf-8")).hexdigest()[:12]
        entry = sets.setdefault((payload["date"], digest), {"date": payload["date"], "version": payload.get("version"),
                                                            "forms": set(), "edits": payload["edits"]})
        entry["forms"].add(payload["form"])
    written = 0
    for (day, digest), entry in sorted(sets.items()):
        path = directory / f"cdr-{day}-{digest}.json"
        try:
            known = set(json.loads(path.read_text(encoding="utf-8")).get("forms") or [])
        except (OSError, ValueError):
            known = set()
        body = json.dumps({"schema_version": SCHEMA_VERSION, "date": day, "version": entry["version"],
                           "forms": sorted(entry["forms"] | known), "edits": entry["edits"]},
                          ensure_ascii=False, separators=(",", ":")) + "\n"
        if not path.exists() or path.read_text(encoding="utf-8") != body:
            directory.mkdir(parents=True, exist_ok=True)
            atomic_write_text(path, body)
            written += 1
    forms: dict[str, list[dict]] = {}
    for path in sorted(directory.glob("cdr-*.json")) if directory.exists() else []:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        counts: dict[str, int] = {}
        for edit in payload.get("edits") or []:
            counts[edit["type"]] = counts.get(edit["type"], 0) + 1
        for form in payload.get("forms") or []:
            forms.setdefault(form, []).append({"date": payload["date"], "version": payload.get("version"),
                                               "file": f"data/{DIRECTORY}/{path.name}", "counts": dict(sorted(counts.items()))})
    for versions in forms.values():
        versions.sort(key=lambda row: row["date"], reverse=True)
    if forms:
        index_path = directory / "index.json"
        try:
            old = json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            old = None
        if not old or old.get("forms") != dict(sorted(forms.items())):
            atomic_write_text(index_path, json.dumps({"schema_version": SCHEMA_VERSION, "updated_at": now or datetime.now(timezone.utc).isoformat(),
                                                      "forms": dict(sorted(forms.items()))}, indent=1, ensure_ascii=False) + "\n")
    return {"written": written, "forms": {form: len(versions) for form, versions in sorted(forms.items())}}


def validate(data_dir: Path = DATA) -> list[str]:
    index = data_dir / DIRECTORY / "index.json"
    if not index.exists():
        return []
    try:
        payload = json.loads(index.read_text(encoding="utf-8"))
    except ValueError:
        return [f"data/{DIRECTORY}/index.json does not parse"]
    errors = []
    for form, versions in (payload.get("forms") or {}).items():
        for version in versions:
            if not (data_dir.parent / version["file"]).exists():
                errors.append(f"data/{DIRECTORY}/index.json: {form} {version['date']} names a missing file")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.preflight", description="Run CDR edit checks on a filing, before it is due")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build", help="write data/edits/ from the saved CDR taxonomies")
    runner = sub.add_parser("run", help="check a filing (XBRL instance, or CSV of code,value[,period])")
    runner.add_argument("filing", type=Path)
    runner.add_argument("--edits", type=Path, required=True, help="data/edits/cdr-<date>-<hash>.json")
    runner.add_argument("--previous", type=Path, help="the edit set before, to list what would newly fail")
    runner.add_argument("--report-date", help="YYYY-MM-DD; default: the filing's latest period")
    runner.add_argument("--csv", type=Path, help="write every result as CSV")
    args = parser.parse_args(argv)
    if args.command == "build":
        print(json.dumps(build()))
        return 0
    values, found = read_filing(args.filing.read_bytes())
    report_date = date.fromisoformat(args.report_date) if args.report_date else found
    if report_date is None:
        print("The filing names no period; pass --report-date.", file=sys.stderr)
        return 2
    new = json.loads(args.edits.read_text(encoding="utf-8"))["edits"]
    if args.previous:
        result = compare(json.loads(args.previous.read_text(encoding="utf-8"))["edits"], new, values, report_date)
    else:
        result = run(new, values, report_date)
    print(json.dumps({"report_date": result["report_date"], "counts": result["counts"],
                      "newly_failing": [row["id"] for row in result.get("newly_failing") or []][:50]}, indent=1))
    if args.csv:
        args.csv.write_text(to_csv(result, new), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
