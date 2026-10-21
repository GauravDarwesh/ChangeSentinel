"""Check Scout's persisted state before it is committed."""
from __future__ import annotations

from pathlib import Path

from regmon.scout import SCHEMA_VERSION
from regmon.scout.registry import Registry, load_decisions, read_json
from regmon.scout.sweep import STATUS_ORDER
from regmon.scout.urls import candidate_id

OUTCOMES = {"relevant", "uncertain", "irrelevant"}
CONFIDENCE = {"strong", "supported", "weak", "conflicting"}
ORIGINS = {"new", "baseline"}


def validate(config, data_dir: Path) -> list[str]:
    data_dir = Path(data_dir)
    problems: list[str] = []
    registries: dict[str, Registry] = {}
    for regulator in config.regulators:
        path = data_dir / "registry" / f"{regulator.id}.json"
        if not path.exists():
            continue
        try:
            registry = Registry.load(data_dir, regulator.id)
        except ValueError as exc:
            problems.append(str(exc))
            continue
        registries[regulator.id] = registry
        for cid, record in registry.candidates.items():
            if candidate_id(record.get("url", "")) != cid or record.get("id") != cid:
                problems.append(f"{regulator.id}: candidate {cid} does not match its URL")
            if record.get("origin") not in ORIGINS:
                problems.append(f"{regulator.id}: candidate {cid} has origin {record.get('origin')!r}")
            assessment = record.get("assessment") or {}
            if assessment.get("outcome") not in OUTCOMES or assessment.get("confidence") not in CONFIDENCE:
                problems.append(f"{regulator.id}: candidate {cid} has no valid assessment")
            relation = record.get("relationship") or {}
            if relation and relation.get("of") not in registry.candidates:
                problems.append(f"{regulator.id}: candidate {cid} is linked to a missing candidate")

    latest_path = data_dir / "latest.json"
    if latest_path.exists():
        latest = read_json(latest_path, {})
        if latest.get("schema_version") != SCHEMA_VERSION or not isinstance(latest.get("regulators"), list):
            problems.append("latest.json has an unexpected shape")
        elif latest.get("status") not in STATUS_ORDER + ("NOT_RUN",):
            problems.append(f"latest.json has status {latest.get('status')!r}")
        else:
            for entry in latest["regulators"]:
                if entry.get("status") not in STATUS_ORDER + ("NOT_RUN",):
                    problems.append(f"latest.json: {entry.get('id')} has status {entry.get('status')!r}")

    review_path = data_dir / "review.json"
    if review_path.exists():
        review = read_json(review_path, {})
        candidates = review.get("candidates")
        if review.get("schema_version") != SCHEMA_VERSION or not isinstance(candidates, list):
            problems.append("review.json has an unexpected shape")
        else:
            keys = set()
            for item in candidates:
                key = item.get("key")
                if key in keys:
                    problems.append(f"review.json lists {key} twice")
                keys.add(key)
                registry = registries.get(item.get("regulator_id"))
                if registry is None or item.get("id") not in registry.candidates:
                    problems.append(f"review.json lists {key}, which is not in a registry")
                elif registry.candidates[item["id"]]["url"] != item.get("url"):
                    problems.append(f"review.json URL for {key} does not match the registry")
                if not str(item.get("url", "")).startswith(("http://", "https://")):
                    problems.append(f"review.json lists {key} with a non-HTTP URL")

    try:
        decisions = load_decisions(data_dir)
    except ValueError as exc:
        problems.append(str(exc))
    else:
        for key, entry in decisions["decisions"].items():
            regulator_id, _, cid = key.partition(":")
            registry = registries.get(regulator_id)
            if registry is None or cid not in registry.candidates:
                problems.append(f"decisions.json refers to {key}, which is not in a registry")
            elif registry.candidates[cid]["url"] != entry.get("url"):
                problems.append(f"decisions.json URL for {key} does not match the registry")
    history = read_json(data_dir / "history.json", [])
    if not isinstance(history, list):
        problems.append("history.json must be a list")
    return problems
