"""Validate persisted discovery state for active, selected sources only."""
from __future__ import annotations

import argparse
import json
import os
from regmon import applicability, catalog, changelog, preflight, proposals, succession
from regmon.config import is_active
from pathlib import Path, PurePosixPath
from typing import Any

POINTER_KEYS = ("snapshot_location", "html_snapshot_location", "file_snapshot_location", "visual_snapshot_location", "evidence_location",
                "rule_tables_location")


def _has_prior_source_state(source_id: str, discovery_dir: Path) -> bool:
    """Return whether any durable state proves this source has run before."""
    data_dir = discovery_dir.parent

    latest_path = data_dir / "latest.json"
    if latest_path.exists():
        try:
            latest = json.loads(latest_path.read_text(encoding="utf-8"))
            source_groups = latest.get("sources")
            if isinstance(source_groups, dict) and source_id in source_groups:
                return True
            # Compatibility with an older flat inventory.
            if isinstance(latest, dict) and any(
                isinstance(record, dict) and record.get("source_id") == source_id
                for record in latest.values()
            ):
                return True
        except (OSError, json.JSONDecodeError):
            # Invalid persisted inventory is not treated as evidence of a clean bootstrap.
            return True

    report_path = data_dir / "reports" / f"{source_id}.json"
    if report_path.exists():
        return True

    history_path = data_dir / "history" / "index.json"
    if history_path.exists():
        try:
            history = json.loads(history_path.read_text(encoding="utf-8"))
            if isinstance(history, list) and any(
                isinstance(row, dict) and row.get("source_id") == source_id
                for row in history
            ):
                return True
        except (OSError, json.JSONDecodeError):
            return True

    # A checkpoint, shard, or failure ledger means discovery has started and must
    # not be silently treated as a never-run source if its main metadata vanished.
    if any(discovery_dir.glob(f"{source_id}*")):
        return True
    return False


def validate_selected_state(
    requested: str,
    config_path: Path,
    discovery_dir: Path,
) -> tuple[list[tuple[str, str]], list[str]]:
    config: dict[str, Any] = json.loads(config_path.read_text(encoding="utf-8"))
    source_items = config.get("sources", [])
    source_map = {str(item.get("id")): item for item in source_items if item.get("id")}
    active_ids = {sid for sid, item in source_map.items() if is_active(item)}

    if requested in {"all", "*"}:
        selected_ids = sorted(active_ids)
    else:
        if requested not in source_map:
            raise ValueError(f"Unknown source selection: {requested}")
        if requested not in active_ids:
            raise ValueError(f"Source {requested} is inactive and cannot be run by the production workflow")
        selected_ids = [requested]
    if not selected_ids:
        raise ValueError("No active monitoring sources are configured for this run")

    states: list[tuple[str, str]] = []
    paused_sources: list[str] = []
    for source_id in selected_ids:
        metadata_path = discovery_dir / f"{source_id}.json"
        if not metadata_path.exists():
            if _has_prior_source_state(source_id, discovery_dir):
                raise ValueError(f"Discovery metadata missing for previously monitored source {source_id}")
            # A source added to configuration has no state until its first monitoring
            # run. It is safe to bootstrap it; the production workflow will perform
            # discovery before its post-run state validation.
            states.append((source_id, "UNINITIALIZED"))
            continue
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        if str(payload.get("source_id") or source_id) != source_id:
            raise ValueError(f"Discovery metadata source mismatch for {source_id}")
        state = str(payload.get("state") or "FAILED").upper()
        states.append((source_id, state))
        if state != "PAUSED":
            continue

        checkpoint_path = discovery_dir / f"{source_id}-checkpoint.json"
        if not checkpoint_path.exists() or checkpoint_path.stat().st_size == 0:
            raise ValueError(f"{source_id} is PAUSED but its checkpoint is missing or empty")
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if checkpoint.get("state") != "PAUSED" or checkpoint.get("source_id") != source_id:
            raise ValueError(f"{source_id} has an invalid PAUSED checkpoint")
        pending = checkpoint.get("pending")
        retry_pending = checkpoint.get("retry_pending", [])
        if not isinstance(pending, list) or not isinstance(retry_pending, list):
            raise ValueError(f"{source_id} has invalid checkpoint queue types")
        if not pending and not retry_pending:
            raise ValueError(f"{source_id} is PAUSED with no resumable work in its checkpoint")
        paused_sources.append(source_id)

    return states, paused_sources


def _load_json(path: Path, label: str, errors: list[str]):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"{label} is missing")
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{label} is unreadable or invalid JSON: {exc}")
    return None


def _check_pointer(value, label: str, repo_root: Path, errors: list[str], non_empty: bool = False) -> None:
    if not value:
        return
    relative = PurePosixPath(str(value))
    if relative.is_absolute() or ".." in relative.parts or not relative.parts or relative.parts[0] != "data":
        errors.append(f"{label} must be a repository-relative path inside data/: {value}")
        return
    target = repo_root.joinpath(*relative.parts)
    if not target.is_file():
        errors.append(f"{label} points to a missing file: {value}")
    elif non_empty and target.stat().st_size == 0:
        errors.append(f"{label} points to an empty file: {value}")


def _walk_pointers(value, label: str, repo_root: Path, errors: list[str]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in POINTER_KEYS:
                _check_pointer(child, f"{label}.{key}", repo_root, errors, non_empty=(key == "file_snapshot_location"))
            else:
                _walk_pointers(child, f"{label}.{key}", repo_root, errors)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _walk_pointers(child, f"{label}[{index}]", repo_root, errors)


def validate_persisted_state(data_dir: Path, active_ids: set[str]) -> list[str]:
    """Check every state file a commit would publish, not only discovery metadata.

    Run before the state commit so a corrupt or dangling state is never pushed.
    Returns a list of problems; an empty list means the state is consistent.
    """
    errors: list[str] = []
    repo_root = data_dir.parent
    latest = _load_json(data_dir / "latest.json", "data/latest.json", errors)
    if latest is not None and (latest.get("schema_version") != 2 or not isinstance(latest.get("sources"), dict)):
        errors.append("data/latest.json must be schema_version 2 with a sources object")
        latest = None
    report = _load_json(data_dir / "report.json", "data/report.json", errors)
    if report is not None and (report.get("schema_version") != 2 or not isinstance(report.get("events"), list)):
        errors.append("data/report.json must be schema_version 2 with an events list")
        report = None
    try:
        from regmon.notify import load_outbox, load_state

        load_state(data_dir / "notifications.json")
        load_outbox(data_dir / "notification-outbox.json")
    except RuntimeError as exc:
        errors.append(str(exc))
    if latest is not None:
        _walk_pointers(latest, "latest", repo_root, errors)
        for source_id in sorted(active_ids):
            for url_id, item in (latest["sources"].get(source_id) or {}).items():
                label = f"active source {source_id}/{url_id}"
                if not isinstance(item, dict):
                    errors.append(f"{label} must be an object")
                    continue
                if item.get("normalized_hash") and not item.get("snapshot_location"):
                    errors.append(f"{label} has normalized content but no snapshot_location")
                if item.get("fetch_error") or item.get("active") is False:
                    # A failing or retired (replaced, then deleted) file keeps what it last had.
                    continue
                kind = str(item.get("extraction_type") or "").lower()
                if kind == "html" and not item.get("html_snapshot_location"):
                    errors.append(f"{label} is HTML but has no html_snapshot_location")
                # Workbooks keep their original from the structured extractor onward.
                workbook_original = kind in {"xlsx", "xls", "ods"} and str(item.get("extractor_version") or "").endswith("-xlsx2")
                if (kind in {"pdf", "zip"} or workbook_original) and not item.get("file_snapshot_location"):
                    errors.append(f"{label} is {kind.upper()} but has no file_snapshot_location")
    if report is not None:
        _walk_pointers(report, "report", repo_root, errors)
    errors.extend(catalog.validate(data_dir))
    errors.extend(proposals.validate(data_dir))
    errors.extend(applicability.validate(data_dir))
    errors.extend(preflight.validate(data_dir))
    errors.extend(changelog.validate(data_dir))
    if (data_dir / succession.FILE_NAME).exists():
        successions = _load_json(data_dir / succession.FILE_NAME, f"data/{succession.FILE_NAME}", errors)
        if successions is not None:
            errors.extend(succession.validate(successions))
    return errors


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=os.getenv("REGMON_SOURCE", "all"))
    parser.add_argument("--config", type=Path, default=Path("config/sources.json"))
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()

    states, paused_sources = validate_selected_state(
        args.source,
        args.config,
        args.data_dir / "discovery",
    )
    paused = bool(paused_sources)
    print(f"states={states}")
    print(f"paused_sources={paused_sources}")
    for source_id, state in states:
        if state in {"FAILED", "DEGRADED"}:
            print(f"warning: {source_id} discovery is {state}; its baseline was not updated")
    config = json.loads(args.config.read_text(encoding="utf-8"))
    active_ids = {str(item.get("id")) for item in config.get("sources", []) if item.get("id") and is_active(item)}
    problems = validate_persisted_state(args.data_dir, active_ids)
    if problems:
        for problem in problems[:50]:
            print(f"state error: {problem}")
        raise SystemExit(f"{len(problems)} persisted state problem(s) found; refusing to treat this state as valid")
    print("persisted state: ok")
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as handle:
            handle.write(f"paused={'true' if paused else 'false'}\n")
            handle.write(f"paused_source={paused_sources[0] if paused_sources else ''}\n")
            handle.write(f"paused_sources={','.join(paused_sources)}\n")


if __name__ == "__main__":
    main()
