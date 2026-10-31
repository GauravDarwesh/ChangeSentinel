"""Find the regulatory items your own code reads, and propose them as registry consumers.

The registry links each reported item to the tables, views, pipelines and code that read
it; filling it by hand is the slow part. This reads a repository (SQL, dbt models, Python,
SAS, R, Scala/Java, LookML, Tableau workbooks, pipeline configs) for MDRM codes, in any
case and with an optional underscore (``RCON2170``, ``rcon_2170``), and writes one row per
item and consumer in the mapping format ``python -m regmon.registry import`` reads.

* A code counts when the item catalog (data/items/) knows it, or when its series is one the
  catalog or a report template (config/registry-templates.json) knows and its item part
  carries a digit. ``--all-series`` also accepts other series once three distinct codes of
  it appear, as the scan's own item-code reader does.
* A SQL ``CREATE TABLE`` / ``VIEW`` is its own consumer (the codes in its statement); a dbt
  model is the table named by its file; a file on a checks or validation path is a ``check``;
  pipeline configs are ``pipeline``; any other file is a ``code`` consumer at its path.
* Nothing leaves the machine and nothing is written unless asked: ``--out`` writes the CSV,
  ``--merge`` merges it into config/registry.json (validated as a whole, as an import is).

    python -m regmon.find_consumers ../warehouse ../etl --repo bank/warehouse --out mapping.csv
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

from regmon import catalog, item_codes, registry

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
# Four letters, an optional underscore, four letters or digits; not inside a longer word.
CODE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{4})_?([A-Za-z0-9]{4})(?![A-Za-z0-9])")
CREATE = re.compile(r"\bcreate\s+(?:or\s+replace\s+)?(?:(?:global\s+|local\s+)?temp(?:orary)?\s+)?(materialized\s+view|view|table)\s+"
                    r"(?:if\s+not\s+exists\s+)?([\w.$\"`\[\]]+)", re.I)
SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "venv", ".venv", "env", "__pycache__", "dist", "build", "target", ".tox",
             ".mypy_cache", ".pytest_cache", ".idea", ".vscode", "site-packages", "dbt_packages", "logs"}
# Extension → consumer kind. Documentation (.md, .txt, .pdf) mentions items without reading them.
KINDS = {
    ".sql": "code", ".ddl": "code", ".hql": "code", ".pls": "code", ".pks": "code", ".pkb": "code", ".prc": "code",
    ".py": "code", ".ipynb": "code", ".sas": "code", ".r": "code", ".scala": "code", ".java": "code", ".kt": "code",
    ".cs": "code", ".go": "code", ".js": "code", ".ts": "code", ".rb": "code", ".vb": "code", ".bas": "code", ".m": "code",
    ".dax": "code", ".lkml": "view", ".twb": "dashboard", ".yml": "pipeline", ".yaml": "pipeline", ".json": "pipeline",
    ".xml": "pipeline", ".conf": "pipeline", ".csv": "other", ".tsv": "other",
}
MAX_BYTES = 4_000_000
COLUMNS = ["code", "scheme", "form", "label", "consumer", "consumer kind", "repo", "path", "occurrences", "first line", "known"]


def _known(data_dir: Path) -> tuple[set[str], set[str]]:
    """Item codes the catalog holds, and the series the catalog or a report template knows."""
    codes: set[str] = set()
    series: set[str] = set()
    directory = data_dir / "items"
    for path in sorted(directory.glob("*.json")) if directory.exists() else []:
        if path.stem == "index":
            continue
        series.add(path.stem.upper())
        codes |= {code.upper() for code in catalog.load_series(data_dir, path.stem).get("items") or {}}
    try:
        for template in registry.load_templates():
            series |= {prefix.upper() for prefix in template.get("code_prefixes") or () if len(prefix) == 4}
    except (OSError, ValueError):
        pass
    return codes, series


def _text(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_BYTES:
            return None
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\0" in raw[:4096]:
        return None
    text = raw.decode("utf-8", "replace")
    if path.suffix.lower() == ".ipynb":
        try:
            cells = json.loads(text).get("cells") or []
            text = "\n".join("".join(cell.get("source") or []) for cell in cells if cell.get("cell_type") == "code")
        except (ValueError, AttributeError):
            pass
    return text


def files(roots: list[Path]):
    for root in roots:
        if root.is_file():
            yield root, root.parent
            continue
        for directory, subdirs, names in os.walk(root):
            subdirs[:] = sorted(name for name in subdirs if name not in SKIP_DIRS and not name.startswith("."))
            for name in sorted(names):
                path = Path(directory) / name
                if path.suffix.lower() in KINDS:
                    yield path, root


def _objects(text: str, relative: str, suffix: str) -> list[tuple[str, str, int, str]]:
    """(consumer name, kind, first line number, text) parts of one file."""
    parts = []
    if suffix in {".sql", ".ddl", ".hql"}:
        found = list(CREATE.finditer(text))
        start = found[0].start() if found else len(text)
        head = text[:start]
        if head.strip():
            parts.append((relative, "code", 1, head))
        for index, match in enumerate(found):
            end = found[index + 1].start() if index + 1 < len(found) else len(text)
            name = re.sub(r"[\"`\[\]]", "", match.group(2))
            kind = "table" if match.group(1).lower() == "table" else "view"
            parts.append((name, kind, text.count("\n", 0, match.start()) + 1, text[match.start():end]))
        if not found and "models" in Path(relative).parts:
            # A dbt model: the table its file names.
            parts = [(Path(relative).stem, "table", 1, text)]
        return parts
    kind = KINDS.get(suffix, "code")
    lowered = relative.lower()
    if kind == "pipeline" and not re.search(r"(dag|airflow|pipeline|workflow|job|etl|elt|dbt|prefect|dagster|luigi|adf|glue)", lowered):
        kind = "code"
    if kind == "code" and re.search(r"(^|[/_.-])(checks?|validations?|edits?|rules?|tests?)([/_.-]|$)", lowered):
        kind = "check"  # the team's own validation rules (config/registry.json kind "check")
    return [(relative, kind, 1, text)]


def scan(roots: list[Path], data_dir: Path = DATA, all_series: bool = False, registry_payload: dict | None = None) -> dict:
    """{rows: [mapping rows], files, codes, consumers, new_links, unknown_series} for the paths given."""
    known_codes, known_series = _known(data_dir)
    hits: dict[tuple[str, str], dict] = {}
    families: dict[str, set[str]] = defaultdict(set)
    scanned = 0
    for path, root in files(roots):
        text = _text(path)
        if text is None:
            continue
        scanned += 1
        relative = path.relative_to(root).as_posix() if path != root else path.name
        for name, kind, first, part in _objects(text, relative, path.suffix.lower()):
            for match in CODE.finditer(part):
                series, item = match.group(1).upper(), match.group(2).upper()
                code = series + item
                if series in item_codes.STOP_SERIES or not re.search(r"\d", item):
                    continue
                state = "catalog" if code in known_codes else "series" if series in known_series else ""
                if not state and not all_series:
                    continue
                families[series].add(code)
                line = first + part.count("\n", 0, match.start())
                key = (code, name)
                hit = hits.get(key)
                if hit is None:
                    context = part.splitlines()[part.count("\n", 0, match.start())] if part else ""
                    hits[key] = {"code": code, "consumer": name, "kind": kind, "path": f"{relative}:{line}", "occurrences": 1,
                                 "context": " ".join(context.split())[:160], "known": state or "pattern"}
                else:
                    hit["occurrences"] += 1
    rows = [hit for hit in hits.values() if hit["known"] != "pattern" or len(families[hit["code"][:4]]) >= item_codes.MIN_FAMILY]
    forms_of: dict[str, tuple[str, str]] = {}
    current = registry_payload or {}
    registered = {registry.norm(item.get("code", "")): item for item in current.get("items") or []}
    linked = {(registry.norm(item.get("code", "")), consumer) for item in current.get("items") or [] for consumer in item.get("consumers") or []}
    consumer_ids = {consumer.get("name"): consumer.get("id") for consumer in current.get("consumers") or []}
    for code in sorted({row["code"] for row in rows}):
        item = registered.get(code)
        if item is not None:
            forms_of[code] = (item.get("form", ""), item.get("label", ""))
            continue
        history = catalog.history(data_dir, code) if code in known_codes else None
        forms = (history or {}).get("forms") or []
        label = ""
        for facet in ((history or {}).get("current") or {}).values():
            attrs = facet.get("attrs") or {}
            label = label or str(attrs.get("label") or attrs.get("description") or "")
        forms_of[code] = (forms[0] if len(forms) == 1 else "", label[:200])
    out = []
    for row in sorted(rows, key=lambda row: (row["consumer"], row["code"])):
        form, label = forms_of.get(row["code"], ("", ""))
        identifier = consumer_ids.get(row["consumer"]) or re.sub(r"[^A-Za-z0-9_.:-]+", "-", row["consumer"]).strip("-")[:80]
        out.append({**row, "form": form, "label": label, "new": (row["code"], identifier) not in linked})
    return {"rows": out, "files": scanned, "codes": len({row["code"] for row in out}), "consumers": len({row["consumer"] for row in out}),
            "new_links": sum(1 for row in out if row["new"]), "unregistered": len({row["code"] for row in out} - set(registered))}


def to_csv(result: dict, repo: str = "") -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(COLUMNS)
    for row in result["rows"]:
        writer.writerow([row["code"], "MDRM", row["form"], row["label"], row["consumer"], row["kind"], repo, row["path"], row["occurrences"],
                         row["context"], row["known"]])
    return buffer.getvalue()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m regmon.find_consumers", description="Find the regulatory items your code reads and propose registry consumers")
    parser.add_argument("paths", nargs="+", type=Path, help="repositories, folders or files to read")
    parser.add_argument("--repo", default="", help="repository name recorded on each consumer (owner/name)")
    parser.add_argument("--out", type=Path, help="write the mapping CSV here (default: print it)")
    parser.add_argument("--merge", action="store_true", help="merge into the registry and write it")
    parser.add_argument("--registry", type=Path, default=registry.REGISTRY_PATH)
    parser.add_argument("--all-series", action="store_true", help="also accept series the catalog doesn't know, once three codes of one appear")
    parser.add_argument("--only-new", action="store_true", help="leave out item and consumer pairs the registry already links")
    args = parser.parse_args(argv)
    missing = [str(path) for path in args.paths if not path.exists()]
    if missing:
        print("Not found: " + ", ".join(missing), file=sys.stderr)
        return 2
    current = json.loads(args.registry.read_text(encoding="utf-8")) if args.registry.exists() else {"schema_version": 1}
    result = scan(args.paths, all_series=args.all_series, registry_payload=current)
    if args.only_new:
        result["rows"] = [row for row in result["rows"] if row["new"]]
    text = to_csv(result, args.repo)
    print(f"{result['files']} files read: {result['codes']} items in {result['consumers']} consumers, "
          f"{result['new_links']} links not in the registry, {result['unregistered']} items not registered", file=sys.stderr)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    elif not args.merge:
        sys.stdout.write(text)
    if args.merge:
        merged = registry.import_csv(text, current)
        args.registry.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Wrote {args.registry}: {len(merged['items'])} items, {len(merged['consumers'])} consumers", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
