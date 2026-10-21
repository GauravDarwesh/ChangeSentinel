"""Regression tests for platform hardening (assessment M-07, M-08, M-10, M-11, M-15,
O-02, O-04, L-02, L-08)."""
from __future__ import annotations

import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from engine_harness import Sandbox, html, ok
from regmon.config import SourceConfig, load_config

ROOT = Path(__file__).resolve().parents[1]
BASE_SOURCE = {
    "id": "s", "name": "n", "regulator": "r", "seed_urls": ["https://a.test/page"],
    "allowed_prefixes": ["https://a.test/"], "allowed_domains": ["a.test"],
}


def write_config(directory: Path, sources: list[dict], **top) -> Path:
    path = directory / "sources.json"
    path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": sources, **top}), encoding="utf-8")
    return path


class TestConfigValidation(unittest.TestCase):
    """M-10: misconfiguration was silently misread."""

    def assert_rejected(self, sources, message, **top):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, message):
                load_config(write_config(Path(temporary), sources, **top))

    def test_repository_configuration_is_valid(self):
        _payload, sources = load_config(ROOT / "config" / "sources.json")
        self.assertIn("fed-reporting-forms-detail-pilot", sources)

    def test_duplicate_ids_are_rejected(self):
        self.assert_rejected([BASE_SOURCE, dict(BASE_SOURCE, name="second")], "Duplicate source id")

    def test_string_booleans_are_rejected(self):
        self.assert_rejected([dict(BASE_SOURCE, active="false")], "active must be true or false")

    def test_unknown_keys_are_rejected(self):
        self.assert_rejected([dict(BASE_SOURCE, allowed_url=["https://a.test/page"])], "unknown configuration keys: allowed_url")
        self.assert_rejected([BASE_SOURCE], "Unknown defaults keys", defaults={"fetch_timeout": 3})

    def test_invalid_link_text_regex_is_rejected_at_load(self):
        self.assert_rejected([dict(BASE_SOURCE, resource_link_text_patterns=["(unclosed"])], "invalid resource_link_text_patterns")

    def test_active_seed_outside_its_scope_is_rejected(self):
        self.assert_rejected([dict(BASE_SOURCE, seed_urls=["https://other.test/page"])], "outside its own scope")


class TestFetchHardening(unittest.TestCase):
    def response(self, status=200, headers=None, content=b"<html>ok</html>", chunks=None):
        mock = MagicMock(status_code=status, headers=headers or {"content-type": "text/html"}, content=content)
        served = list(chunks) if chunks is not None else [content[i:i + 4] for i in range(0, len(content), 4)]
        mock.consumed = []

        def iter_content(chunk_size=1):
            for chunk in served:
                mock.consumed.append(chunk)
                yield chunk

        mock.iter_content.side_effect = iter_content
        return mock

    @patch("regmon.fetch.validate_public_http_url", return_value=None)
    @patch("regmon.fetch.requests.get")
    def test_redirect_into_an_excluded_area_is_refused(self, get, _validate):
        """M-11: fetch followed redirects that discovery would reject."""
        from regmon.fetch import fetch

        get.side_effect = [self.response(302, {"location": "/user/login"}), self.response()]
        with self.assertRaisesRegex(ValueError, "excluded area"):
            fetch("https://www.example.com/rules", allowed_domains=("www.example.com",),
                  allowed_prefixes=("https://www.example.com/",), excluded_prefixes=("https://www.example.com/user/",))

    @patch("regmon.fetch.time.sleep")
    @patch("regmon.fetch.requests.get")
    def test_transient_dns_failure_is_retried(self, get, _sleep):
        """M-07: a resolver hiccup failed the fetch with no retry."""
        from regmon.fetch import fetch

        get.return_value = self.response()
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        with patch("regmon.security.socket.getaddrinfo", side_effect=[socket.gaierror(-3, "Temporary failure"), public]):
            result = fetch("https://www.example.com/rules", attempts=2, backoff_seconds=0)
        self.assertEqual(result.status_code, 200)

    @patch("regmon.fetch.validate_public_http_url", return_value=None)
    @patch("regmon.fetch.time.sleep")
    @patch("regmon.fetch.requests.get")
    def test_retry_after_is_honoured(self, get, sleep, _validate):
        """M-15"""
        from regmon.fetch import fetch

        get.side_effect = [self.response(429, {"retry-after": "11"}), self.response()]
        fetch("https://www.example.com/rules", attempts=2, backoff_seconds=1)
        sleep.assert_called_once_with(11.0)

    @patch("regmon.fetch.validate_public_http_url", return_value=None)
    @patch("regmon.fetch.requests.get")
    def test_oversized_responses_are_refused(self, get, _validate):
        """M-15: bodies were read fully into memory with no limit."""
        from regmon.fetch import fetch

        get.return_value = self.response(headers={"content-type": "application/pdf", "content-length": "999999"})
        with self.assertRaisesRegex(ValueError, "limit is 1000"):
            fetch("https://www.example.com/a.pdf", max_bytes=1000)
        get.return_value = self.response(headers={"content-type": "application/pdf"}, content=b"x" * 2000)
        with self.assertRaisesRegex(ValueError, "limit is 1000"):
            fetch("https://www.example.com/a.pdf", max_bytes=1000)

    @patch("regmon.fetch.validate_public_http_url", return_value=None)
    @patch("regmon.fetch.requests.get")
    def test_undeclared_oversized_body_is_cut_off_while_streaming(self, get, _validate):
        """A body with no Content-Length used to be read fully before the size check."""
        from regmon.fetch import fetch

        response = self.response(headers={"content-type": "application/pdf"}, chunks=[b"x" * 600] * 10)
        get.return_value = response
        with self.assertRaisesRegex(ValueError, "exceeded 1000 bytes"):
            fetch("https://www.example.com/a.pdf", max_bytes=1000)
        self.assertEqual(len(response.consumed), 2)  # stopped at the chunk that crossed the cap
        self.assertTrue(get.call_args.kwargs["stream"])
        response.close.assert_called()

    @patch("regmon.fetch.validate_public_http_url", return_value=None)
    @patch("regmon.fetch.requests.get")
    def test_streamed_body_within_the_cap_is_returned_intact(self, get, _validate):
        from regmon.fetch import fetch

        get.return_value = self.response(headers={"content-type": "application/pdf"}, chunks=[b"%PDF", b"", b"-1.7"])
        result = fetch("https://www.example.com/a.pdf", max_bytes=1000)
        self.assertEqual(result.body, b"%PDF-1.7")
        self.assertEqual(len(result.raw_hash), 64)

    def test_discovery_classifies_dns_failures_as_retryable(self):
        """M-07: discovery recorded permanent_http and skipped the retry round."""
        from regmon.discovery import _fetch_links

        source = SourceConfig(id="d", name="d", regulator="r", seed_urls=("https://www.example.com/",),
                              allowed_prefixes=("https://www.example.com/",), allowed_domains=("www.example.com",))
        with patch("regmon.security.socket.getaddrinfo", side_effect=socket.gaierror(-3, "Temporary failure")), \
             patch("regmon.discovery.time.sleep"):
            _url, _links, failure = _fetch_links("https://www.example.com/", source, 5)
        self.assertEqual(failure["retry_classification"], "retryable_exhausted")


class TestSavedOutputs(unittest.TestCase):
    """M-08, L-08: single-source runs truncated history and narrowed report.json."""

    def two_source_config(self, sandbox):
        other = dict(BASE_SOURCE, id="other-source", seed_urls=["https://example.test/other"],
                     allowed_prefixes=["https://example.test/"], allowed_domains=["example.test"])
        mine = dict(BASE_SOURCE, id=sandbox.source.id, seed_urls=list(sandbox.source.seed_urls),
                    allowed_prefixes=list(sandbox.source.allowed_prefixes), allowed_domains=list(sandbox.source.allowed_domains))
        return write_config(sandbox.root, [mine, other])

    def test_history_is_capped_per_source_and_report_keeps_other_active_sources(self):
        from regmon import engine

        with Sandbox() as sandbox:
            config = self.two_source_config(sandbox)
            history = [{"run_id": f"o{i}", "generated_at": f"2026-10-{i % 28 + 1:02d}T00:00:00+00:00", "source_id": "other-source", "counts": {}} for i in range(90)]
            history += [{"run_id": f"m{i}", "generated_at": f"2026-10-{i % 28 + 1:02d}T01:00:00+00:00", "source_id": sandbox.source.id, "counts": {}} for i in range(90)]
            (sandbox.data / "history" / "index.json").write_text(json.dumps(history), encoding="utf-8")
            other_report = {"schema_version": 2, "run_id": "older-run", "generated_at": "2026-10-18T00:00:00+00:00",
                            "source": {"id": "other-source", "name": "Other", "regulator": "r"}, "counts": {"discovered": 3},
                            "discovery": {"source_id": "other-source", "state": "COMPLETE"}, "baseline_update_allowed": True,
                            "events": [], "ai_results": [], "ai_contract": {}}
            (sandbox.data / "reports" / "other-source.json").write_text(json.dumps(other_report), encoding="utf-8")
            result = sandbox.scan(lambda *a, **k: ok(html("<p>x</p>")), persist=False)
            with patch("regmon.engine.load_config", side_effect=lambda *a, **k: load_config(config)):
                engine.save_outputs([result], "single")
            kept = json.loads((sandbox.data / "history" / "index.json").read_text())
            self.assertEqual(sum(1 for r in kept if r["source_id"] == "other-source"), 90)
            self.assertEqual(sum(1 for r in kept if r["source_id"] == sandbox.source.id), 90)
            report = json.loads((sandbox.data / "report.json").read_text())
            self.assertEqual({s["id"] for s in report["sources"]}, {sandbox.source.id, "other-source"})
            self.assertEqual(report["source_runs"]["other-source"]["run_id"], "older-run")
            history_file = json.loads((sandbox.data / "history" / "single.json").read_text())
            self.assertEqual([s["id"] for s in history_file["sources"]], [sandbox.source.id])

    def test_history_records_what_started_each_run(self):
        from regmon import engine

        with Sandbox() as sandbox:
            config = self.two_source_config(sandbox)
            result = sandbox.scan(lambda *a, **k: ok(html("<p>x</p>")), persist=False)
            env = {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_ACTOR": "GauravDarwesh", "GITHUB_RUN_ID": "123456"}
            with patch.dict("os.environ", env), \
                 patch("regmon.engine.load_config", side_effect=lambda *a, **k: load_config(config)):
                engine.save_outputs([result], "manual-run")
            entry = json.loads((sandbox.data / "history" / "index.json").read_text())[0]
            self.assertEqual((entry["trigger"], entry["workflow_run_id"]), ("manual", "123456"))
            report = json.loads((sandbox.data / "report.json").read_text())
            self.assertEqual(report["trigger"], "manual")
            self.assertEqual(report["source_runs"][sandbox.source.id]["trigger"], "manual")

    def test_run_trigger_tells_scheduled_manual_and_continuation_apart(self):
        from regmon.engine import run_trigger

        self.assertEqual(run_trigger({"GITHUB_EVENT_NAME": "schedule", "GITHUB_RUN_ID": "9"}), {"trigger": "scheduled", "workflow_run_id": "9"})
        self.assertEqual(run_trigger({"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_ACTOR": "someone"})["trigger"], "manual")
        self.assertEqual(run_trigger({"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_ACTOR": "github-actions[bot]"})["trigger"], "continuation")
        self.assertEqual(run_trigger({}), {"trigger": "local", "workflow_run_id": None})

    def test_events_are_saved_in_a_stable_order(self):
        from regmon.engine import _sort_events

        events = [{"url": "b", "event_type": "X", "event_id": "2"}, {"url": "a", "event_type": "Y", "event_id": "1"}]
        self.assertEqual([e["url"] for e in _sort_events(events)], ["a", "b"])

    def test_atomic_writes_leave_no_temporary_files(self):
        from regmon.fsutil import atomic_write_text

        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "state.json"
            atomic_write_text(target, "{}")
            atomic_write_text(target, '{"a": 1}')
            self.assertEqual(target.read_text(), '{"a": 1}')
            self.assertEqual([p.name for p in Path(temporary).iterdir()], ["state.json"])


class TestPersistedStateValidation(unittest.TestCase):
    """O-04: validate_state only looked at discovery metadata."""

    def valid_tree(self, root: Path) -> Path:
        data = root / "data"
        (data / "snapshots").mkdir(parents=True)
        (data / "snapshots" / "a.txt").write_text("text", encoding="utf-8")
        record = {"canonical_url": "https://a.test/page", "normalized_hash": "h", "snapshot_location": "data/snapshots/a.txt",
                  "extraction_type": "text"}
        (data / "latest.json").write_text(json.dumps({"schema_version": 2, "sources": {"s": {"u": record}}}), encoding="utf-8")
        (data / "report.json").write_text(json.dumps({"schema_version": 2, "events": []}), encoding="utf-8")
        (data / "notifications.json").write_text(json.dumps({"sent_events": {}}), encoding="utf-8")
        (data / "notification-outbox.json").write_text(json.dumps({"pending_events": {}}), encoding="utf-8")
        return data

    def test_consistent_state_passes_and_problems_are_reported(self):
        from regmon.validate_state import validate_persisted_state

        with tempfile.TemporaryDirectory() as temporary:
            data = self.valid_tree(Path(temporary))
            self.assertEqual(validate_persisted_state(data, {"s"}), [])
            (data / "snapshots" / "a.txt").unlink()
            (data / "notifications.json").write_text("{", encoding="utf-8")
            problems = validate_persisted_state(data, {"s"})
            self.assertTrue(any("missing file" in p for p in problems))
            self.assertTrue(any("Refusing to reset notification state" in p for p in problems))

    def test_repository_state_is_consistent(self):
        from regmon.validate_state import validate_persisted_state

        config = json.loads((ROOT / "config" / "sources.json").read_text(encoding="utf-8"))
        active = {s["id"] for s in config["sources"] if s.get("active", True)}
        self.assertEqual(validate_persisted_state(ROOT / "data", active), [])


class TestCredentialScoping(unittest.TestCase):
    """O-02: the write token sat in .git/config while untrusted documents were parsed."""

    def test_scan_checkout_does_not_persist_credentials_and_only_commits_get_the_token(self):
        workflow = (ROOT / ".github" / "workflows" / "regulatory-monitor.yml").read_text(encoding="utf-8")
        checkout = workflow[workflow.index("- name: Checkout current main"):workflow.index("- name: Setup Python")]
        self.assertIn("persist-credentials: false", checkout)
        engine_step = workflow[workflow.index("- name: Run monitoring engine"):workflow.index("- name: Validate monitoring state")]
        self.assertNotIn("github.token", engine_step)
        commit_step = workflow[workflow.index("- name: Commit monitoring state"):workflow.index("- name: Publish notifications")]
        self.assertIn("GH_TOKEN: ${{ github.token }}", commit_step)


if __name__ == "__main__":
    unittest.main()
