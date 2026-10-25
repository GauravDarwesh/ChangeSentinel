"""Apply owner-submitted monitor settings to config/sources.json.

The dashboard cannot write configuration. To change settings on one monitor or
on many at once (a settings preset), it opens a prefilled GitHub issue that
carries a JSON payload; the owner-only Update Monitor Settings workflow runs
this module and commits the result.

    <!-- changesentinel:update-monitors:v1 -->
    SETTINGS_JSON:
    {"monitors": ["id-1", "id-2"], "set": {"check_every_hours": 24}, "clear": ["check_hours"],
     "add_labels": ["Spec"], "remove_labels": ["Draft"]}

Only the keys in SETTABLE_KEYS can be changed this way: scope, selectors and
URLs stay with the add/delete requests that validate them. Every changed
source is re-validated with the same rules the engine loads configuration with,
and nothing is written unless every source in the request is valid.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

from regmon.config import SourceConfig, validate_config

REQUEST_MARKER = "<!-- changesentinel:update-monitors:v1 -->"
ISSUE_TITLE_PREFIX = "[ChangeSentinel] Update monitors"
MAX_MONITORS = 200
# Settings a request may set or clear. Clearing returns a key to its default.
SETTABLE_KEYS = {
    "check_every_hours", "check_days", "check_hours", "check_timezone", "workspace", "labels",
}
# Label edits that keep each monitor's other labels (a preset adds "Spec" to
# fifty monitors without wiping what each already carries).
LABEL_OPS = ("add_labels", "remove_labels")


def _validated_body(event: dict, repository: str) -> str:
    issue = event.get("issue") or {}
    if not str(issue.get("title") or "").startswith(ISSUE_TITLE_PREFIX):
        raise ValueError("This issue is not a ChangeSentinel monitor settings request.")
    owner = str(repository or "").split("/", 1)[0].lower()
    author = str(((issue.get("user") or {}).get("login")) or "").lower()
    if not owner or author != owner:
        raise ValueError("Only the repository owner can change monitor settings through the dashboard.")
    body = str(issue.get("body") or "")
    if REQUEST_MARKER not in body:
        raise ValueError("The issue is missing the ChangeSentinel settings marker.")
    return body


def request_from_issue(event: dict, repository: str) -> dict:
    body = _validated_body(event, repository).replace("\r\n", "\n")
    match = re.search(r"(?ms)^SETTINGS_JSON:[ \t]*\n(\{.*?\})[ \t]*(?:\n\n|\Z)", body)
    if not match:
        raise ValueError("No SETTINGS_JSON payload was found in the request.")
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise ValueError(f"The settings request contains invalid JSON: {exc.msg}.") from exc
    if not isinstance(payload, dict):
        raise ValueError("SETTINGS_JSON must be an object.")
    unknown = sorted(set(payload) - {"monitors", "set", "clear", *LABEL_OPS})
    if unknown:
        raise ValueError(f"Unknown SETTINGS_JSON fields: {', '.join(unknown)}")
    monitors = payload.get("monitors")
    if not isinstance(monitors, list) or not monitors or not all(isinstance(item, str) and item for item in monitors):
        raise ValueError("monitors must be a non-empty list of source IDs.")
    if len(set(monitors)) > MAX_MONITORS:
        raise ValueError(f"A settings request can change at most {MAX_MONITORS} monitors.")
    changes = payload.get("set") or {}
    clear = payload.get("clear") or []
    if not isinstance(changes, dict) or not isinstance(clear, list) or not all(isinstance(key, str) for key in clear):
        raise ValueError("set must be an object and clear a list of setting names.")
    not_allowed = sorted((set(changes) | set(clear)) - SETTABLE_KEYS)
    if not_allowed:
        raise ValueError(f"These settings cannot be changed from the dashboard: {', '.join(not_allowed)}")
    both = sorted(set(changes) & set(clear))
    if both:
        raise ValueError(f"A setting cannot be both set and cleared: {', '.join(both)}")
    label_ops = {}
    for op in LABEL_OPS:
        values = payload.get(op) or []
        if not isinstance(values, list) or not all(isinstance(item, str) and item.strip() for item in values):
            raise ValueError(f"{op} must be a list of labels.")
        label_ops[op] = [item.strip() for item in values]
    if (label_ops["add_labels"] or label_ops["remove_labels"]) and ("labels" in changes or "labels" in clear):
        raise ValueError("Use either labels or add_labels/remove_labels, not both.")
    if not changes and not clear and not any(label_ops.values()):
        raise ValueError("The request does not set or clear any setting.")
    return {"monitors": list(dict.fromkeys(monitors)), "set": changes, "clear": clear, **label_ops}


def apply_settings(config: dict, request: dict) -> list[str]:
    """Apply the request to the config in place; returns the IDs that changed."""
    sources = config.get("sources")
    if not isinstance(sources, list):
        raise ValueError("config/sources.json must contain a sources array.")
    by_id = {str(source.get("id")): source for source in sources if isinstance(source, dict)}
    missing = [source_id for source_id in request["monitors"] if source_id not in by_id]
    if missing:
        raise ValueError(f"Unknown monitors: {', '.join(missing[:10])}")
    changed = []
    for source_id in request["monitors"]:
        source = by_id[source_id]
        before = json.dumps(source, sort_keys=True)
        for key in request["clear"]:
            source.pop(key, None)
        for key, value in request["set"].items():
            source[key] = value.strip() if isinstance(value, str) else value
        if request.get("add_labels") or request.get("remove_labels"):
            removed = {label.casefold() for label in request.get("remove_labels") or []}
            labels = [label for label in source.get("labels") or [] if label.casefold() not in removed]
            for label in request.get("add_labels") or []:
                if label.casefold() not in {existing.casefold() for existing in labels}:
                    labels.append(label)
            source["labels"] = labels
        if "labels" in source and not source["labels"]:
            source.pop("labels")
        if "workspace" in source and not str(source["workspace"]).strip():
            source.pop("workspace")
        # Defaults are not written out: a six-hourly, every-day monitor keeps the
        # same configuration it had before cadences existed.
        if source.get("check_every_hours") == 6:
            source.pop("check_every_hours")
        if sorted(source.get("check_days") or []) == sorted(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]):
            source.pop("check_days")
        if source.get("check_timezone") == "UTC":
            source.pop("check_timezone")
        try:
            SourceConfig.from_dict(source)
        except ValueError as exc:
            raise ValueError(f"{source_id}: {exc}") from exc
        if json.dumps(source, sort_keys=True) != before:
            changed.append(source_id)
    validate_config(config, [SourceConfig.from_dict(source) for source in sources])
    return changed


def update_from_issue(event: dict, config_path: Path, repository: str) -> dict:
    request = request_from_issue(event, repository)
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    changed = apply_settings(config, request)
    if changed:
        Path(config_path).write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    described = ", ".join(
        [f"{key} = {json.dumps(value, ensure_ascii=False)}" for key, value in request["set"].items()]
        + [f"{key} back to its default" for key in request["clear"]]
        + ([f"labels added: {', '.join(request['add_labels'])}"] if request.get("add_labels") else [])
        + ([f"labels removed: {', '.join(request['remove_labels'])}"] if request.get("remove_labels") else [])
    )
    return {
        "requested": len(request["monitors"]),
        "changed": changed,
        "settings": described,
        "message": (
            f"Updated {len(changed)} of {len(request['monitors'])} monitor(s): {described}."
            if changed else f"All {len(request['monitors'])} monitor(s) already had these settings: {described}."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--event", type=Path, required=True, help="GitHub issues event JSON")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    event = json.loads(args.event.read_text(encoding="utf-8"))
    result = update_from_issue(event, args.config, str(os.environ.get("GITHUB_REPOSITORY") or ""))
    encoded = json.dumps(result, ensure_ascii=False)
    if args.output:
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
