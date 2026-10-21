"""The read-only MCP server over a synthetic checkout, in-process and over stdio."""
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from regmon import mcp_server

ROOT = Path(__file__).resolve().parents[1]
EVENT = "a" * 64
TEXT = "| 1 | A | Total |  | BHCK2170 |  |\n| 2 | A | Other |  | BHCK3210 |  |\n| 3 | A | More |  | BHCK3545 |  |\nComments are due by March 2, 2027."


def checkout(root: Path) -> Path:
    (root / "config").mkdir()
    (root / "data" / "evidence").mkdir(parents=True)
    (root / "data" / "history").mkdir()
    (root / "data" / "snapshots").mkdir()
    (root / "config" / "sources.json").write_text(json.dumps({"sources": [{"id": "fed", "name": "Fed forms", "regulator": "Fed", "active": True}]}))
    (root / "config" / "lineage.json").write_text(json.dumps({"schema_version": 1, "mappings": [{"codes": ["BHCK2170"], "assets": ["warehouse.total_assets"]}]}))
    digest = hashlib.sha256(TEXT.encode()).hexdigest()
    snapshot = f"data/snapshots/u1-{digest}.txt"
    (root / snapshot).write_text(TEXT)
    evidence = {"diff": "--- before\n+++ after\n@@ -1 +1 @@\n-old\n+Comments are due by March 2, 2027.",
                "item_codes": {"counts": {"added": 1, "removed": 0, "amended": 0}, "added": [{"code": "BHCK2170", "context": "| 1 | A | Total |"}], "removed": [], "amended": []},
                "before": {}, "after": {"snapshot_location": snapshot}}
    (root / "data" / "evidence" / f"{EVENT}.json").write_text(json.dumps(evidence))
    item = {"url_id": "u1", "source_id": "fed", "canonical_url": "https://fed.example/FR_Y-9C", "active": True,
            "snapshot_location": snapshot, "normalized_hash": digest, "extraction_type": "html",
            "change_history": [{"event_id": EVENT, "event_type": "CHANGED_URL", "timestamp": "2026-10-20T06:00:00+00:00",
                                "evidence_location": f"data/evidence/{EVENT}.json", "item_codes": {"counts": {"added": 1}}}]}
    (root / "data" / "latest.json").write_text(json.dumps({"schema_version": 2, "sources": {"fed": {"u1": item}}}))
    (root / "data" / "report.json").write_text(json.dumps({"run_id": "r1", "generated_at": "2026-10-20T06:00:00+00:00",
                                                          "baseline_update_allowed": True, "counts": {"changed": 1},
                                                          "discovery": [{"source_id": "fed", "state": "COMPLETE"}], "events": []}))
    (root / "data" / "history" / "r1.json").write_text(json.dumps({"ai_results": [{"event_id": EVENT, "ai": {"status": "ok", "analysis": {
        "relevant": True, "topic": "Deadline", "summary": "Comment deadline set", "effective_date": "Not stated"}}}]}))
    return root


class TestMcpTools(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.record = mcp_server.Record(checkout(Path(self.tmp.name)))

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, name, arguments=None):
        response = mcp_server.handle(self.record, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}})
        return response["result"]

    def test_tools_are_listed_with_schemas(self):
        response = mcp_server.handle(self.record, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        tools = {tool["name"]: tool for tool in response["result"]["tools"]}
        self.assertEqual(set(tools), set(mcp_server.TOOLS))
        self.assertEqual(tools["get_change"]["inputSchema"]["required"], ["event_id"])

    def test_changes_come_with_verdicts_and_item_impact(self):
        result = self.call("list_changes", {"relevant_only": True})["structuredContent"]
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["changes"][0]["verdict"], "relevant")
        change = self.call("get_change", {"event_id": EVENT})["structuredContent"]
        self.assertIn("+Comments are due", change["diff"])
        self.assertEqual(change["item_codes"]["added"][0]["code"], "BHCK2170")

    def test_item_code_history_includes_presence_and_lineage(self):
        result = self.call("item_code_history", {"code": "bhck 2170"})["structuredContent"]
        self.assertEqual(result["code"], "BHCK2170")
        self.assertEqual(result["changes"][0]["how"], "added")
        self.assertEqual(result["present_in"][0]["url"], "https://fed.example/FR_Y-9C")
        self.assertEqual(result["downstream"][0]["asset"], "warehouse.total_assets")

    def test_dates_are_built_when_no_calendar_is_committed(self):
        result = self.call("upcoming_dates", {"from": "2026-01-01"})["structuredContent"]
        self.assertEqual([entry["date"] for entry in result["dates"]], ["2027-03-02"])

    def test_snapshots_verify_against_recorded_fingerprints(self):
        self.assertTrue(self.call("verify_snapshot", {"url_id": "u1"})["structuredContent"]["all_verified"])
        snapshot = next(Path(self.tmp.name, "data", "snapshots").glob("*.txt"))
        snapshot.write_text(TEXT + "tampered")
        self.assertFalse(self.call("verify_snapshot", {"url_id": "u1"})["structuredContent"]["all_verified"])

    def test_bad_arguments_are_tool_errors_not_crashes(self):
        self.assertTrue(self.call("get_change", {"event_id": "../../etc"})["isError"])
        self.assertTrue(self.call("item_code_history", {"code": "nope"})["isError"])
        self.assertTrue(self.call("list_changes", {"since": "yesterday"})["isError"])
        with self.assertRaises(mcp_server.ToolError):
            self.record.safe_path("../outside.json")

    def test_status_reports_completeness(self):
        status = self.call("monitoring_status")["structuredContent"]
        self.assertTrue(status["complete"])
        self.assertEqual(status["pages_monitored"], 1)

    def test_stdio_round_trip(self):
        stdin = io.StringIO("\n".join(json.dumps(message) for message in [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "nope"},
        ]) + "\nnot json\n")
        stdout = io.StringIO()
        mcp_server.serve(self.record, stdin, stdout)
        lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(lines[0]["result"]["serverInfo"]["name"], "changesentinel")
        self.assertEqual(lines[1]["error"]["code"], -32601)
        self.assertEqual(lines[2]["error"]["code"], -32700)
        self.assertEqual(len(lines), 3)


class TestMcpOnThisRepository(unittest.TestCase):
    def test_the_server_starts_on_the_repository_checkout(self):
        message = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "monitoring_status", "arguments": {}}})
        result = subprocess.run([sys.executable, "-m", "regmon.mcp_server", "--root", str(ROOT)], input=message + "\n",
                                capture_output=True, text=True, timeout=60, cwd=ROOT, check=True)
        payload = json.loads(result.stdout.splitlines()[0])["result"]["structuredContent"]
        self.assertIn("run_id", payload)


if __name__ == "__main__":
    unittest.main()
