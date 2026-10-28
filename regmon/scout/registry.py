"""Scout's durable state under data/scout/ (standard library only).

Files
-----
registry/<regulator>.json  every URL Scout has observed for a regulator, with
                           first-seen time, origin (new or baseline), the
                           evidence it came with and the latest assessment.
                           Records change only when something about them
                           changes, so weekly commits stay small.
decisions.json             reviewer decisions (dismiss / restore) per candidate
                           plus an append-only log.
review.json                the dashboard's review queue, rebuilt from the above.
latest.json                the latest sweep's coverage ledger.
history.json               compact summaries of recent sweeps.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from regmon.fsutil import atomic_write_text
from regmon.scout import RULES_VERSION, SCHEMA_VERSION
from regmon.scout.urls import canonical, candidate_id, slug_title

EVIDENCE_FIELDS = (
    "title", "anchor_text", "title_attr", "context", "parent_url", "description", "categories", "published", "lastmod",
    "date_hint", "language", "alternates", "page_title", "heading", "meta_description", "page_type", "page_published",
    "page_modified", "page_language", "canonical_link", "keywords", "near_monitored", "robots_disallowed", "enriched",
    "enrich_error", "original_url", "depth", "section",
)
DECISIONS = ("dismissed", "restored")


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def dump(value) -> str:
    return json.dumps(value, indent=1, ensure_ascii=False, sort_keys=True) + "\n"


def dump_compact(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        # Corrupt state must stop the run, not silently restart Scout's memory
        # (which would re-surface every known URL as a baseline).
        raise ValueError(f"{path} is not valid JSON: {exc}") from exc


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    atomic_write_text(path, text)
    return True


class Registry:
    def __init__(self, regulator_id: str, data: dict | None = None):
        data = data or {}
        if data and (data.get("schema_version") != SCHEMA_VERSION or data.get("regulator_id") != regulator_id):
            raise ValueError(f"Scout registry for {regulator_id} has an unexpected schema or regulator id")
        self.regulator_id = regulator_id
        self.candidates: dict[str, dict] = dict(data.get("candidates") or {})
        self.channels: dict[str, dict] = dict(data.get("channels") or {})

    @classmethod
    def load(cls, data_dir: Path, regulator_id: str) -> "Registry":
        return cls(regulator_id, read_json(registry_path(data_dir, regulator_id), {}))

    def to_json(self) -> dict:
        return {"schema_version": SCHEMA_VERSION, "regulator_id": self.regulator_id,
                "candidates": self.candidates, "channels": self.channels}

    def save(self, data_dir: Path) -> bool:
        return write_if_changed(registry_path(data_dir, self.regulator_id), dump_registry(self.to_json()))

    def channel_baselined(self, channel_id: str) -> bool:
        return bool((self.channels.get(channel_id) or {}).get("baselined_at"))

    def observe(self, observation, *, sweep_id: str, now: str, new_if_unknown: bool, https_hosts=frozenset()) -> tuple[str, bool]:
        """Record one observation. Returns (candidate id, created)."""
        url = canonical(observation.url, https_hosts)
        cid = candidate_id(url)
        record = self.candidates.get(cid)
        created = record is None
        if created:
            record = {
                "id": cid,
                "url": url,
                "first_seen": now,
                "first_sweep": sweep_id,
                "origin": "new" if new_if_unknown else "baseline",
                "channels": [],
                "evidence": {},
            }
            self.candidates[cid] = record
        if observation.channel_id not in record["channels"]:
            record["channels"] = sorted(set(record["channels"]) | {observation.channel_id})
        if (record.get("relationship") or {}).get("type") == "translation":
            return cid, created  # the linked original keeps the evidence
        evidence = record.setdefault("evidence", {})
        values = {
            "title": observation.title, "anchor_text": observation.anchor_text, "title_attr": observation.title_attr,
            "context": observation.context,
            "parent_url": observation.parent_url, "description": observation.description, "categories": observation.categories,
            "published": observation.published, "lastmod": observation.lastmod, "date_hint": observation.date_hint,
            "language": observation.language,
            # Depth-limited listings only (0 / "" elsewhere, so never stored):
            # hops from the listing root and the heading the link sat under.
            "depth": getattr(observation, "depth", 0),
            "section": getattr(observation, "section", ""),
            "alternates": {code: href for code, href in (observation.alternates or {}).items()
                           if canonical(href, https_hosts) != url},
            "original_url": observation.original_url if _meaningfully_different(observation.original_url, url) else "",
        }
        from regmon.scout.channels import is_generic

        for key, value in values.items():
            if not value:
                continue
            current = evidence.get(key)
            # Fill gaps only: first evidence is kept, so re-observing a URL every
            # week does not rewrite its record. A button label ("Download
            # document") or a bare fragment is the exception: a channel that
            # gives the real title replaces it.
            if not current:
                evidence[key] = value
            elif key == "anchor_text" and is_generic(current) and not is_generic(value):
                evidence[key] = value
            elif key == "context" and len(str(current)) < 25 and len(str(value)) > len(str(current)):
                evidence[key] = value
        return cid, created


def _meaningfully_different(original: str, url: str) -> bool:
    """Keep the published spelling only when it differs by more than scheme or a trailing slash."""
    value = re.sub(r"^http://", "https://", str(original or "").split("#", 1)[0].strip().rstrip("/"))
    target = re.sub(r"^http://", "https://", url.rstrip("/"))
    return bool(original) and value.lower() != target.lower()


def registry_path(data_dir: Path, regulator_id: str) -> Path:
    return Path(data_dir) / "registry" / f"{regulator_id}.json"


def best_title(record: dict) -> str:
    """The most descriptive name Scout has for a URL.

    Feed and page titles first; then the link text, unless it is a button
    label, a file size or a bare number ("12/2026"), in which case the listed
    item's text is used; the address slug is the last resort.
    """
    from regmon.scout.channels import is_generic, tidy_label

    evidence = record.get("evidence") or {}
    for key in ("title", "heading", "page_title"):
        value = str(evidence.get(key) or "").strip()
        if value and not is_generic(value):
            return value[:300]
    anchor = str(evidence.get("anchor_text") or "").strip()
    context = tidy_label(evidence.get("context") or "")
    weak_anchor = not anchor or is_generic(anchor) or len(anchor) < 14 or not re.search(r"[A-Za-zÀ-ÿ]{4}", anchor)
    if weak_anchor and context and len(context) > len(anchor):
        return context
    if anchor and not is_generic(anchor):
        return anchor[:300]
    title_attr = str(evidence.get("title_attr") or "").strip()
    if title_attr:
        return title_attr[:300]
    return slug_title(record.get("url") or "")


def dump_review(data: dict) -> str:
    """The review queue with one candidate per line (it was one 580 KB line, so
    every sweep rewrote the whole line and its diffs and blame were unreadable).
    Same JSON, same key order as dump_compact, so readers see no difference."""
    lines = ["{"]
    keys = sorted(data)
    for index, key in enumerate(keys):
        end = "," if index < len(keys) - 1 else ""
        value = data[key]
        if isinstance(value, list) and value:
            items = [json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")) for item in value]
            lines.append(json.dumps(key) + ":[")
            lines.append(",\n".join(items))
            lines.append("]" + end)
        else:
            lines.append(json.dumps(key) + ":" + json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + end)
    lines.append("}")
    return "\n".join(lines) + "\n"


def dump_registry(data: dict) -> str:
    """One candidate per line: compact on disk, and a weekly diff touches only new lines."""
    head = {key: value for key, value in data.items() if key != "candidates"}
    lines = ["{"]
    for key in sorted(head):
        lines.append(json.dumps(key) + ":" + json.dumps(head[key], ensure_ascii=False, sort_keys=True, separators=(",", ":")) + ",")
    candidates = data.get("candidates") or {}
    lines.append('"candidates":{')
    entries = [json.dumps(cid) + ":" + json.dumps(candidates[cid], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
               for cid in sorted(candidates)]
    lines.append(",\n".join(entries))
    lines.append("}}")
    return "\n".join(lines) + "\n"


def compact_assessment(assessment: dict) -> dict:
    """What the registry keeps of an assessment; the review queue carries the full one."""
    kind = assessment.get("publication_type") or {}
    return {"outcome": assessment.get("outcome"), "confidence": assessment.get("confidence"),
            "type": kind.get("id", ""), "rules_version": assessment.get("rules_version")}


# ---------------------------------------------------------------- monitored URLs

def monitored_urls(config_path: Path, latest_path: Path, https_hosts=frozenset()) -> dict[str, list[str]]:
    """Canonical URL -> monitoring source ids, from config/sources.json and data/latest.json."""
    known: dict[str, set[str]] = {}

    def add(url: str, source_id: str):
        if url:
            known.setdefault(canonical(url, https_hosts), set()).add(source_id)

    config = read_json(Path(config_path), {"sources": []})
    for source in config.get("sources") or []:
        if not isinstance(source, dict):
            continue
        source_id = str(source.get("id") or "")
        for url in list(source.get("seed_urls") or []) + list(source.get("allowed_urls") or []):
            add(str(url), source_id)
    latest = read_json(Path(latest_path), {"sources": {}})
    for source_id, rows in (latest.get("sources") or {}).items():
        for row in (rows or {}).values():
            if isinstance(row, dict) and row.get("active") is not False:
                add(str(row.get("canonical_url") or ""), source_id)
    return {url: sorted(ids) for url, ids in known.items()}


def near_monitored(url: str, monitored: dict[str, list[str]], depth: int = 3) -> str:
    """A monitored URL sharing at least `depth` leading path segments with url ("" if none)."""
    from urllib.parse import urlparse

    target = urlparse(url)
    segments = [item for item in target.path.split("/") if item]
    if len(segments) <= depth:
        return ""
    prefix = "/" + "/".join(segments[:depth]) + "/"
    for known in monitored:
        parsed = urlparse(known)
        if parsed.netloc == target.netloc and (parsed.path + "/").startswith(prefix):
            return known
    return ""


# ---------------------------------------------------------------- decisions

def decisions_path(data_dir: Path) -> Path:
    return Path(data_dir) / "decisions.json"


def load_decisions(data_dir: Path) -> dict:
    data = read_json(decisions_path(data_dir), {"schema_version": SCHEMA_VERSION, "decisions": {}, "log": []})
    if data.get("schema_version") != SCHEMA_VERSION or not isinstance(data.get("decisions"), dict) or not isinstance(data.get("log"), list):
        raise ValueError("data/scout/decisions.json has an unexpected shape")
    return data


def apply_decision(decisions: dict, *, key: str, regulator_id: str, url: str, decision: str, reason: str, actor: str, request: str, now: str) -> None:
    if decision not in DECISIONS:
        raise ValueError(f"Unknown decision {decision}")
    entry = {"decision": decision, "reason": reason, "decided_at": now, "decided_by": actor, "request": request,
             "regulator_id": regulator_id, "url": url}
    decisions["log"].append({"candidate": key, **entry})
    if decision == "restored":
        # Restoring returns the candidate to review; the log keeps the history.
        decisions["decisions"].pop(key, None)
    else:
        decisions["decisions"][key] = entry


# ---------------------------------------------------------------- review queue

def build_review(config, data_dir: Path, *, monitored: dict[str, list[str]], decisions: dict, generated_at: str, sweep_id: str) -> dict:
    """The dashboard's review queue: new arrivals, a capped backlog and decided items."""
    from regmon.scout.assess import assess

    defaults = config.defaults
    now = parse_iso(generated_at) or utc_now()
    recent_cutoff = now - timedelta(days=defaults.review_new_days)
    items, omitted = [], {}
    for regulator in config.regulators:
        registry = Registry.load(data_dir, regulator.id)
        translations: dict[str, list[dict]] = {}
        for record in registry.candidates.values():
            relation = record.get("relationship") or {}
            if relation.get("type") == "translation" and relation.get("of"):
                translations.setdefault(relation["of"], []).append({"language": relation.get("language", ""), "url": record["url"]})
        backlog = []
        for cid, record in registry.candidates.items():
            if (record.get("relationship") or {}).get("type") == "translation":
                continue
            key = f"{regulator.id}:{cid}"
            decision = decisions["decisions"].get(key)
            monitored_ids = monitored.get(canonical(record["url"], regulator.https_hosts), [])
            assessment = assess(record, regulator, config.objective)
            first_seen = parse_iso(record.get("first_seen")) or now
            item = {
                "key": key,
                "id": cid,
                "regulator_id": regulator.id,
                "url": record["url"],
                "title": best_title(record),
                "origin": record.get("origin", "baseline"),
                "first_seen": record.get("first_seen"),
                "first_sweep": record.get("first_sweep"),
                "channels": record.get("channels") or [],
                "evidence": {key: value for key, value in (record.get("evidence") or {}).items()
                             if key in EVIDENCE_FIELDS and value and key != "alternates"},
                "assessment": assessment,
                "decision": decision,
                "monitored_by": monitored_ids,
                "translations": translations.get(cid, []),
            }
            if decision or monitored_ids:
                decided_at = parse_iso((decision or {}).get("decided_at") or "") or first_seen
                if record.get("origin") == "new" or decision:
                    if decided_at >= recent_cutoff or first_seen >= recent_cutoff:
                        items.append(item)
                continue
            if record.get("origin") == "new":
                if first_seen >= recent_cutoff or assessment.get("outcome") != "irrelevant":
                    items.append(item)
            elif assessment.get("outcome") == "relevant":
                backlog.append(item)
        # Newest publications first (by any date the publisher gave), strongest evidence next.
        backlog.sort(key=lambda item: (
            str(item["evidence"].get("published") or item["evidence"].get("page_published")
                or item["evidence"].get("lastmod") or item["evidence"].get("date_hint") or ""),
            item["assessment"].get("rank") or 0,
        ), reverse=True)
        limit = defaults.review_backlog_limit
        if len(backlog) > limit:
            omitted[regulator.id] = len(backlog) - limit
        items.extend(backlog[:limit])
    items.sort(key=lambda item: (item["first_seen"] or "", item["assessment"].get("rank") or 0), reverse=True)
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "sweep_id": sweep_id,
        "rules_version": RULES_VERSION,
        "objective": {"id": config.objective.id, "description": config.objective.description},
        "regulators": [
            {"id": item.id, "name": item.name, "short_name": item.short_name, "region": item.region,
             "jurisdiction": item.jurisdiction, "active": item.active,
             "channels": [{"id": channel.id, "label": channel.label, "type": channel.type, "url": channel.url} for channel in item.channels]}
            for item in config.regulators
        ],
        "candidates": items,
        "omitted_backlog": omitted,
    }
