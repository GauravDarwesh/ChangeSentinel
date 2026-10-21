"""Downstream lineage for reporting-item codes (config/lineage.json).

A reporting team keeps, somewhere, a mapping from form items to what consumes
them: warehouse columns, dbt models, regulatory submissions, edit checks. This
file is where ChangeSentinel reads that mapping, so a change to item BHCK2170
can say "feeds warehouse.fr_y9c.total_assets (Regulatory Reporting)" instead of
leaving the reader to look it up. The mapping is the owner's; the repository
ships it empty rather than guessing.

    {
      "schema_version": 1,
      "mappings": [
        {"codes": ["BHCK2170"], "assets": ["warehouse.fr_y9c.total_assets"], "owner": "Regulatory Reporting"},
        {"series": ["QTFL"], "assets": ["dbt: fr_2028.positions"], "note": "Every FR 2028B/S item"}
      ]
    }
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINEAGE_PATH = ROOT / "config" / "lineage.json"
CODE = re.compile(r"^[A-Z]{4}[A-Z0-9]{4}$")
SERIES = re.compile(r"^[A-Z]{4}$")
MAX_MAPPINGS = 2000
MAX_ASSETS = 50
MAX_TEXT = 200


def validate(payload: object) -> list[dict]:
    """The mappings in a lineage file, or ValueError naming the first problem."""
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise ValueError("lineage.json must be an object with schema_version 1")
    mappings = payload.get("mappings")
    if not isinstance(mappings, list):
        raise ValueError("lineage.json needs a mappings list (it may be empty)")
    if len(mappings) > MAX_MAPPINGS:
        raise ValueError(f"lineage.json has more than {MAX_MAPPINGS} mappings")
    clean = []
    for index, mapping in enumerate(mappings, start=1):
        where = f"mapping {index}"
        if not isinstance(mapping, dict):
            raise ValueError(f"{where} must be an object")
        unknown = set(mapping) - {"codes", "series", "assets", "owner", "note"}
        if unknown:
            raise ValueError(f"{where} has unknown keys: {', '.join(sorted(unknown))}")
        codes = mapping.get("codes") or []
        series = mapping.get("series") or []
        if not isinstance(codes, list) or not isinstance(series, list) or not (codes or series):
            raise ValueError(f"{where} needs a codes or series list")
        for code in codes:
            if not isinstance(code, str) or not CODE.match(code):
                raise ValueError(f"{where}: {code!r} is not an item code such as BHCK2170")
        for prefix in series:
            if not isinstance(prefix, str) or not SERIES.match(prefix):
                raise ValueError(f"{where}: {prefix!r} is not a four-letter series such as BHCK")
        assets = mapping.get("assets")
        if not isinstance(assets, list) or not assets or len(assets) > MAX_ASSETS:
            raise ValueError(f"{where} needs between 1 and {MAX_ASSETS} assets")
        for asset in assets:
            if not isinstance(asset, str) or not asset.strip() or len(asset) > MAX_TEXT:
                raise ValueError(f"{where}: assets must be non-empty text of at most {MAX_TEXT} characters")
        for key in ("owner", "note"):
            if key in mapping and (not isinstance(mapping[key], str) or len(mapping[key]) > MAX_TEXT):
                raise ValueError(f"{where}: {key} must be text of at most {MAX_TEXT} characters")
        clean.append({
            "codes": sorted(set(codes)), "series": sorted(set(series)),
            "assets": [asset.strip() for asset in assets],
            "owner": str(mapping.get("owner") or ""), "note": str(mapping.get("note") or ""),
        })
    return clean


def load(path: Path = LINEAGE_PATH) -> list[dict]:
    if not path.exists():
        return []
    return validate(json.loads(path.read_text(encoding="utf-8")))


def assets_for(code: str, mappings: list[dict]) -> list[dict]:
    """Every asset mapped to this code, exact matches before series matches."""
    out, seen = [], set()
    for exact in (True, False):
        for mapping in mappings:
            hit = code in mapping["codes"] if exact else code[:4] in mapping["series"]
            if not hit:
                continue
            for asset in mapping["assets"]:
                if asset in seen:
                    continue
                seen.add(asset)
                out.append({"asset": asset, "owner": mapping["owner"], "via": code if exact else code[:4] + "*"})
    return out
