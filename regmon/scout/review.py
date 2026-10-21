"""Apply a reviewer's decision from an owner-opened GitHub issue.

The dashboard is a static page with no write access, so "Not relevant" and
"Restore" open a prefilled issue. The owner-only workflow passes the issue
event here. Each decision applies to the listed URLs only: a dismissal never
becomes a rule for a path, a topic or a regulator.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from regmon.fsutil import atomic_write_text
from regmon.scout.registry import Registry, apply_decision, decisions_path, dump, iso, load_decisions, utc_now

MARKER = "<!-- changesentinel:scout-review:v1 -->"
TITLE_PREFIX = "[ChangeSentinel] Scout review"
MAX_CANDIDATES = 50
LINE_RE = re.compile(r"^\s*[-*]\s+([a-z0-9][a-z0-9-]{0,62}):([0-9a-f]{16})\s+\|\s+(https?://\S+)\s*$")
VERBS = {"dismiss": "dismissed", "dismissed": "dismissed", "not relevant": "dismissed", "restore": "restored", "restored": "restored"}


class ReviewError(ValueError):
    pass


def parse_request(body: str) -> dict:
    text = str(body or "").replace("\r\n", "\n")
    if MARKER not in text:
        raise ReviewError("The issue is not a Scout review request (marker missing)")
    decision = reason = None
    candidates = []
    for line in text.split("\n"):
        stripped = line.strip()
        lowered = stripped.lower()
        if lowered.startswith("decision:"):
            verb = stripped.split(":", 1)[1].strip().lower()
            if verb not in VERBS:
                raise ReviewError(f"Unknown decision {verb!r}; use dismiss or restore")
            decision = VERBS[verb]
        elif lowered.startswith("reason:"):
            value = re.sub(r"\s+", " ", stripped.split(":", 1)[1]).strip()
            reason = "" if value.lower() in {"", "(none)", "none"} else value[:300]
        else:
            match = LINE_RE.match(line)
            if match:
                candidates.append({"regulator_id": match.group(1), "id": match.group(2), "url": match.group(3)})
    if decision is None:
        raise ReviewError("The request has no Decision line")
    if not candidates:
        raise ReviewError("The request lists no candidates")
    if len(candidates) > MAX_CANDIDATES:
        raise ReviewError(f"At most {MAX_CANDIDATES} candidates can be reviewed in one request")
    keys = [f"{item['regulator_id']}:{item['id']}" for item in candidates]
    if len(set(keys)) != len(keys):
        raise ReviewError("The request lists a candidate more than once")
    return {"decision": decision, "reason": reason or "", "candidates": candidates}


def apply_event(event: dict, data_dir: Path) -> dict:
    issue = event.get("issue") or {}
    repository = event.get("repository") or {}
    actor = str((issue.get("user") or {}).get("login") or "")
    owner = str((repository.get("owner") or {}).get("login") or "")
    if not actor or actor != owner:
        raise ReviewError("Only the repository owner can record Scout review decisions")
    if not str(issue.get("title") or "").startswith(TITLE_PREFIX):
        raise ReviewError("The issue title is not a Scout review request")
    request = parse_request(issue.get("body") or "")
    data_dir = Path(data_dir)
    registries: dict[str, Registry] = {}
    for item in request["candidates"]:
        registry = registries.get(item["regulator_id"])
        if registry is None:
            path = data_dir / "registry" / f"{item['regulator_id']}.json"
            if not path.exists():
                raise ReviewError(f"Scout has no registry for regulator {item['regulator_id']}")
            registry = registries[item["regulator_id"]] = Registry.load(data_dir, item["regulator_id"])
        record = registry.candidates.get(item["id"])
        if not record:
            raise ReviewError(f"Candidate {item['regulator_id']}:{item['id']} is not in Scout's registry")
        if record["url"] != item["url"]:
            raise ReviewError(f"Candidate {item['regulator_id']}:{item['id']} does not match {item['url']}")
    decisions = load_decisions(data_dir)
    now = iso(utc_now())
    reference = f"issue #{issue.get('number')}" if issue.get("number") else "issue"
    for item in request["candidates"]:
        apply_decision(decisions, key=f"{item['regulator_id']}:{item['id']}", regulator_id=item["regulator_id"], url=item["url"],
                       decision=request["decision"], reason=request["reason"], actor=actor, request=reference, now=now)
    atomic_write_text(decisions_path(data_dir), dump(decisions))
    return {"decision": request["decision"], "count": len(request["candidates"]),
            "keys": [f"{item['regulator_id']}:{item['id']}" for item in request["candidates"]]}


def load_event(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))
