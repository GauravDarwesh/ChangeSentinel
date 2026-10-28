"""ChangeSentinel as a Model Context Protocol server (stdio, read-only).

Lets an assistant such as Claude Desktop, Claude Code or any MCP client answer
questions from a local clone of the monitoring record, with the same evidence a
reviewer sees on the dashboard and no model in between:

    monitoring_status    the latest saved scan, per source, and whether it is complete
    list_changes         recorded changes and problems, newest first, with AI verdicts
    get_change           one change: the redline, AI review, reporting items and dates
    item_code_history    every recorded change that touched a reporting item code,
                         where the code appears now, and its mapped downstream assets
    upcoming_dates       dates stated in detected changes (the .ics feed's entries)
    search_text          where the current saved copies mention a phrase
    verify_snapshot      recompute a saved file's SHA-256 against its recorded fingerprint

Nothing is fetched and nothing is written: answers come from data/ and config/
as committed (pull the clone to refresh). Configure a client with, for example:

    {"mcpServers": {"changesentinel": {"command": "python3",
      "args": ["-m", "regmon.mcp_server", "--root", "/path/to/ChangeSentinel"]}}}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from regmon.config import is_active
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "changesentinel", "version": "1.0.0"}
CHANGE_TYPES = {"CHANGED_URL", "NEW_URL", "REMOVED_URL", "HTML_SOURCE_CHANGED", "VISUAL_CHANGED"}
PROBLEM_TYPES = {"FETCH_ERROR", "EXTRACTION_ERROR"}
MAX_DIFF_LINES = 400


class ToolError(Exception):
    """A request the tool cannot answer; reported to the client as isError."""


class Record:
    """Read-only view of a ChangeSentinel checkout."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        if not (self.root / "data").is_dir() or not (self.root / "config" / "sources.json").is_file():
            raise SystemExit(f"{self.root} is not a ChangeSentinel checkout (data/ and config/sources.json are required)")

    def json(self, relative: str, default: Any = None) -> Any:
        path = self.safe_path(relative)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def safe_path(self, relative: str) -> Path:
        path = (self.root / str(relative)).resolve()
        if path != self.root and self.root not in path.parents:
            raise ToolError("Paths must stay inside the checkout")
        return path

    def data_path(self, relative: str) -> Path:
        """A location taken from committed state: confined to data/.

        Snapshot and evidence locations come from JSON in the checkout; a
        crafted one must not read .git/ or any other file through the tools.
        """
        path = self.safe_path(relative)
        data = self.root / "data"
        if data not in path.parents:
            raise ToolError("Recorded locations must stay inside data/")
        return path

    def data_json(self, relative: str, default: Any = None) -> Any:
        try:
            path = self.data_path(relative)
        except ToolError:
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def sources(self) -> list[dict]:
        return [source for source in (self.json("config/sources.json", {}) or {}).get("sources", []) if isinstance(source, dict)]

    def active_ids(self) -> set[str]:
        return {str(source.get("id")) for source in self.sources() if is_active(source)}

    def inventory(self) -> dict[str, dict]:
        payload = self.json("data/latest.json", {}) or {}
        return payload.get("sources", {}) if isinstance(payload.get("sources"), dict) else {}

    def items(self, active_only: bool = True) -> list[dict]:
        active = self.active_ids()
        out = []
        for source_id, group in self.inventory().items():
            if active_only and source_id not in active or not isinstance(group, dict):
                continue
            out.extend(item for item in group.values() if isinstance(item, dict) and item.get("active") is not False)
        return out

    def analyses(self) -> dict[str, dict]:
        """Latest AI result per event id across every saved run."""
        found: dict[str, dict] = {}
        for path in sorted((self.root / "data" / "history").glob("*.json")):
            if path.name == "index.json":
                continue
            try:
                report = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            for result in report.get("ai_results") or []:
                if isinstance(result, dict) and result.get("event_id"):
                    found[str(result["event_id"])] = result.get("ai") or {}
        return found

    def changes(self) -> list[dict]:
        """The dashboard's change log: per-page timelines plus the latest report's problems."""
        entries: dict[str, dict] = {}
        for item in self.items():
            for change in item.get("change_history") or []:
                if isinstance(change, dict) and change.get("event_id") and change.get("event_type") in CHANGE_TYPES | PROBLEM_TYPES:
                    entries.setdefault(str(change["event_id"]), {**change, "url": item.get("canonical_url"),
                                                                  "url_id": item.get("url_id"), "source_id": item.get("source_id")})
        report = self.json("data/report.json", {}) or {}
        for event in report.get("events") or []:
            if isinstance(event, dict) and event.get("event_type") in PROBLEM_TYPES and event.get("event_id"):
                entries.setdefault(str(event["event_id"]), {key: event.get(key) for key in (
                    "event_id", "event_type", "timestamp", "url", "url_id", "source_id", "evidence_location")})
        return sorted(entries.values(), key=lambda entry: str(entry.get("timestamp") or ""), reverse=True)


def _verdict(ai: dict | None, change: dict) -> dict:
    if isinstance(ai, dict) and ai.get("status") == "ok" and isinstance(ai.get("analysis"), dict):
        analysis = ai["analysis"]
        return {"state": "relevant" if analysis.get("relevant") else "not relevant", **analysis}
    if isinstance(change.get("ai_relevant"), bool):
        return {"state": "relevant" if change["ai_relevant"] else "not relevant", "topic": change.get("ai_topic"), "summary": change.get("ai_summary")}
    if isinstance(ai, dict) and ai.get("status"):
        return {"state": "not reviewed", "reason": f"AI review {ai.get('status')}: {ai.get('reason', '')}".strip()}
    return {"state": "not reviewed"}


def _since(value: str | None) -> str:
    if not value:
        return ""
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date().isoformat()
    except ValueError as exc:
        raise ToolError("since must be an ISO date such as 2026-10-01") from exc


def monitoring_status(record: Record, _args: dict) -> dict:
    report = record.json("data/report.json", {}) or {}
    generated = report.get("generated_at")
    age_hours = None
    if generated:
        try:
            age_hours = round((datetime.now(timezone.utc) - datetime.fromisoformat(generated)).total_seconds() / 3600, 1)
        except ValueError:
            pass
    discovery = report.get("discovery") or []
    return {
        "run_id": report.get("run_id"), "generated_at": generated, "age_hours": age_hours,
        "stale": age_hours is not None and age_hours > 8,
        "complete": bool(report.get("baseline_update_allowed")) and all(str((d or {}).get("state")) == "COMPLETE" for d in discovery),
        "counts": report.get("counts", {}),
        "sources": [{"id": source.get("id"), "name": source.get("name"), "regulator": source.get("regulator"),
                     "active": is_active(source)} for source in record.sources()],
        "discovery": [{"source_id": d.get("source_id"), "state": d.get("state"), "reason": d.get("reason")} for d in discovery if isinstance(d, dict)],
        "pages_monitored": len(record.items()),
    }


def list_changes(record: Record, args: dict) -> dict:
    since = _since(args.get("since"))
    source = str(args.get("source_id") or "")
    relevant_only = bool(args.get("relevant_only"))
    limit = max(1, min(100, int(args.get("limit") or 25)))
    analyses = record.analyses()
    out = []
    for change in record.changes():
        if since and str(change.get("timestamp") or "")[:10] < since:
            continue
        if source and change.get("source_id") != source:
            continue
        verdict = _verdict(analyses.get(str(change["event_id"])), change)
        if relevant_only and verdict["state"] != "relevant":
            continue
        out.append({
            "event_id": change["event_id"], "event_type": change.get("event_type"), "timestamp": change.get("timestamp"),
            "url": change.get("url"), "source_id": change.get("source_id"),
            "verdict": verdict["state"], "summary": verdict.get("summary"), "item_codes": change.get("item_codes"),
            "spec": change.get("spec"), "evidence_location": change.get("evidence_location"),
        })
        if len(out) >= limit:
            break
    return {"count": len(out), "changes": out}


def get_change(record: Record, args: dict) -> dict:
    event_id = str(args.get("event_id") or "").strip()
    if not re.fullmatch(r"[0-9a-f]{64}", event_id):
        raise ToolError("event_id must be the 64-character id shown by list_changes")
    change = next((entry for entry in record.changes() if entry["event_id"] == event_id), None)
    if change is None:
        raise ToolError("No recorded change has that id")
    evidence = record.data_json(change["evidence_location"], {}) if change.get("evidence_location") else {}
    diff = str((evidence or {}).get("diff") or "").splitlines()
    calendar = record.json("data/calendar.json", {}) or {}
    return {
        "event_id": event_id, "event_type": change.get("event_type"), "timestamp": change.get("timestamp"),
        "url": change.get("url"), "source_id": change.get("source_id"),
        "verdict": _verdict(record.analyses().get(event_id), change),
        "diff": "\n".join(diff[:MAX_DIFF_LINES]) + ("\n… (truncated)" if len(diff) > MAX_DIFF_LINES else ""),
        "item_codes": (evidence or {}).get("item_codes"),
        "spec_diff": (evidence or {}).get("spec_diff") or (evidence or {}).get("spec_inventory"),
        "dates": [entry for entry in calendar.get("entries", []) if entry.get("event_id") == event_id],
        "before": (evidence or {}).get("before"), "after": (evidence or {}).get("after"),
        "error": (evidence or {}).get("error"), "evidence_location": change.get("evidence_location"),
    }


def item_code_history(record: Record, args: dict) -> dict:
    from regmon import item_codes, lineage

    code = re.sub(r"\s+", "", str(args.get("code") or "")).upper()
    if not re.fullmatch(r"[A-Z]{4}[A-Z0-9]{4}", code):
        raise ToolError("code must be a reporting item code such as BHCK2170 or QTFL 1596")
    touched = []
    for change in record.changes():
        if change.get("event_type") != "CHANGED_URL" or not change.get("evidence_location"):
            continue
        evidence = record.data_json(change["evidence_location"], {}) or {}
        impact = evidence.get("item_codes") or {}
        for kind in ("added", "removed", "amended"):
            for entry in impact.get(kind) or []:
                if entry.get("code") == code:
                    touched.append({"event_id": change["event_id"], "timestamp": change.get("timestamp"), "url": change.get("url"), "how": kind, **{
                        key: entry[key] for key in ("context", "before", "after") if key in entry}})
    present = []
    for item in record.items():
        location = item.get("snapshot_location")
        if not location:
            continue
        try:
            text = record.data_path(location).read_text(encoding="utf-8")
        except (OSError, ToolError):
            continue
        if code in item_codes.codes_in(text):
            present.append({"url": item.get("canonical_url"), "extraction_type": item.get("extraction_type"), "snapshot_location": location})
    try:
        assets = lineage.assets_for(code, lineage.load(record.root / "config" / "lineage.json"))
    except ValueError as exc:
        assets = [{"error": f"config/lineage.json is invalid: {exc}"}]
    return {"code": code, "changes": touched, "present_in": present, "downstream": assets}


def upcoming_dates(record: Record, args: dict) -> dict:
    calendar = record.json("data/calendar.json", None)
    if calendar is None:
        from regmon import deadlines
        calendar = deadlines.build(record.root / "data", record.root / "config" / "sources.json")
    start = _since(args.get("from")) or date.today().isoformat()
    entries = [entry for entry in calendar.get("entries", []) if str(entry.get("date")) >= start]
    limit = max(1, min(200, int(args.get("limit") or 50)))
    return {"from": start, "count": len(entries[:limit]), "dates": entries[:limit], "subscribe": calendar.get("subscribe")}


def search_text(record: Record, args: dict) -> dict:
    query = str(args.get("query") or "").strip()
    if len(query) < 3:
        raise ToolError("query must be at least three characters")
    pattern = re.compile(re.escape(query), re.I)
    limit = max(1, min(50, int(args.get("limit") or 20)))
    hits = []
    for item in record.items():
        location = item.get("snapshot_location")
        if not location:
            continue
        try:
            text = record.data_path(location).read_text(encoding="utf-8")
        except (OSError, ToolError):
            continue
        for match in pattern.finditer(text):
            start, end = max(0, match.start() - 120), min(len(text), match.end() + 120)
            hits.append({"url": item.get("canonical_url"), "snapshot_location": location,
                         "excerpt": re.sub(r"\s+", " ", text[start:end]).strip()})
            if len(hits) >= limit:
                return {"query": query, "count": len(hits), "matches": hits, "truncated": True}
    return {"query": query, "count": len(hits), "matches": hits}


def verify_snapshot(record: Record, args: dict) -> dict:
    """SHA-256 of saved files against the fingerprints the scan recorded."""
    wanted = str(args.get("url_id") or args.get("url") or "").strip()
    item = next((candidate for candidate in record.items(active_only=False)
                 if wanted and wanted in {candidate.get("url_id"), candidate.get("canonical_url")}), None)
    if item is None:
        raise ToolError("Give url_id or url of a monitored page (see list_changes or monitoring_status)")
    checks = []
    for label, key, expected in (
        ("extracted text", "snapshot_location", item.get("normalized_hash")),
        ("saved HTML", "html_snapshot_location", item.get("html_hash")),
        ("original file", "file_snapshot_location", item.get("raw_hash")),
    ):
        location = item.get(key)
        if not location:
            continue
        try:
            digest = hashlib.sha256(record.data_path(location).read_bytes()).hexdigest()
        except (OSError, ToolError):
            checks.append({"file": label, "location": location, "verified": False, "reason": "file missing from the checkout"})
            continue
        named = re.search(r"-([0-9a-f]{64})\.[a-z]+$", location)
        checks.append({
            "file": label, "location": location, "sha256": digest, "recorded": expected,
            "verified": digest == expected and (not named or named.group(1) == digest),
        })
    return {"url": item.get("canonical_url"), "all_verified": bool(checks) and all(check["verified"] for check in checks), "files": checks}


TOOLS: dict[str, tuple[Callable[[Record, dict], dict], str, dict]] = {
    "monitoring_status": (monitoring_status, "The latest saved scan: run id, age, whether every source completed, counts, sources and the number of monitored pages.", {"type": "object", "properties": {}}),
    "list_changes": (list_changes, "Recorded changes and fetch/extraction problems, newest first, each with its AI verdict, summary, reporting-item impact and evidence file.", {
        "type": "object", "properties": {
            "since": {"type": "string", "description": "ISO date; only changes on or after it"},
            "source_id": {"type": "string", "description": "Only this configured source"},
            "relevant_only": {"type": "boolean", "description": "Only changes the AI review judged relevant"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100}}}),
    "get_change": (get_change, "One recorded change by event id: the unified diff, the AI review, reporting items added/removed/amended, stated dates, and before/after snapshot pointers.", {
        "type": "object", "required": ["event_id"], "properties": {"event_id": {"type": "string", "description": "64-character id from list_changes"}}}),
    "item_code_history": (item_code_history, "Every recorded change that added, removed or amended a reporting item code (e.g. BHCK2170), the current saved documents that contain it, and its downstream assets from config/lineage.json.", {
        "type": "object", "required": ["code"], "properties": {"code": {"type": "string", "description": "Item code such as BHCK2170 or QTFL 1596"}}}),
    "upcoming_dates": (upcoming_dates, "Comment deadlines, effective dates and first report dates stated in detected changes, from today (or a given date), each with the sentence it came from.", {
        "type": "object", "properties": {"from": {"type": "string", "description": "ISO date; default today"}, "limit": {"type": "integer", "minimum": 1, "maximum": 200}}}),
    "search_text": (search_text, "Find a phrase in the current saved text of every actively monitored page and document, with excerpts.", {
        "type": "object", "required": ["query"], "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 50}}}),
    "verify_snapshot": (verify_snapshot, "Recompute the SHA-256 of a page's saved text, HTML and original file and compare each with the fingerprint the scan recorded.", {
        "type": "object", "properties": {"url_id": {"type": "string"}, "url": {"type": "string"}}}),
}


def handle(record: Record, message: dict) -> dict | None:
    """One JSON-RPC message in, its response out (None for notifications)."""
    method = message.get("method")
    request_id = message.get("id")
    if request_id is None:
        return None
    def result(value):
        return {"jsonrpc": "2.0", "id": request_id, "result": value}
    if method == "initialize":
        requested = (message.get("params") or {}).get("protocolVersion")
        return result({"protocolVersion": requested or PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": False}},
                       "serverInfo": SERVER_INFO,
                       "instructions": "Read-only access to a ChangeSentinel monitoring record. Cite event ids and evidence files; AI verdicts are review aids, not determinations."})
    if method == "ping":
        return result({})
    if method == "tools/list":
        return result({"tools": [{"name": name, "description": description, "inputSchema": schema}
                                 for name, (_fn, description, schema) in TOOLS.items()]})
    if method == "tools/call":
        params = message.get("params") or {}
        tool = TOOLS.get(str(params.get("name")))
        if tool is None:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": f"Unknown tool: {params.get('name')}"}}
        try:
            value = tool[0](record, params.get("arguments") or {})
            return result({"content": [{"type": "text", "text": json.dumps(value, indent=2, default=str)}], "structuredContent": value, "isError": False})
        except ToolError as exc:
            return result({"content": [{"type": "text", "text": str(exc)}], "isError": True})
        except (TypeError, ValueError) as exc:
            return result({"content": [{"type": "text", "text": f"Invalid arguments: {exc}"}], "isError": True})
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}


def serve(record: Record, stdin=sys.stdin, stdout=sys.stdout) -> None:
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            response = handle(record, message) if isinstance(message, dict) else {
                "jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
        if response is not None:
            stdout.write(json.dumps(response, default=str) + "\n")
            stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description="ChangeSentinel MCP server (stdio, read-only)")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parent.parent), help="Path to a ChangeSentinel checkout")
    args = parser.parse_args()
    serve(Record(Path(args.root)))


if __name__ == "__main__":
    main()
