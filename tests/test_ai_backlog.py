"""Regression tests for durable AI backlog selection."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from regmon.change import html_comparison_hash, make_id
from regmon.config import SourceConfig
from regmon.content import CONTENT_EXTRACTOR_VERSION
from regmon.engine import (
    build_ai_candidate_pool,
    candidate_event_type,
    make_current_item,
    process_source,
)
from regmon.fetch import FetchResult


def source_config() -> SourceConfig:
    return SourceConfig(
        id="synthetic-ai-backlog",
        name="Synthetic AI backlog source",
        regulator="Synthetic Regulator",
        seed_urls=("https://example.test/policy",),
        allowed_prefixes=("https://example.test/",),
        allowed_domains=("example.test",),
        allowed_urls=("https://example.test/policy",),
    )


class TestAIDeferredBacklog(unittest.TestCase):
    def test_unchanged_deferred_items_return_to_the_candidate_pool(self):
        fresh = {"url_id": "a", "relevance": {"candidate": True}}
        changed = {"url_id": "b", "relevance": {"candidate": True}}
        queued = {
            "url_id": "c",
            "relevance": {"candidate": True},
            "ai_pending": {
                "event_type": "NEW_URL",
                "event_id": "original-event-c",
                "after_hash": "stable-hash-c",
            },
        }
        unchanged = {"url_id": "d", "relevance": {"candidate": True}}

        candidates = build_ai_candidate_pool(
            [fresh], [{"after": changed}], [unchanged, queued]
        )

        self.assertEqual([item["url_id"] for item in candidates], ["a", "b", "c"])
        self.assertIs(candidates[2], queued)

    def test_pending_item_is_not_duplicated_when_its_content_changes_again(self):
        queued_changed = {
            "url_id": "c",
            "relevance": {"candidate": True},
            "ai_pending": {"event_type": "NEW_URL", "event_id": "old-event"},
        }
        candidates = build_ai_candidate_pool(
            [],
            [{"after": queued_changed}],
            [queued_changed],
        )

        self.assertEqual(len(candidates), 1)
        self.assertIs(candidates[0], queued_changed)
        self.assertEqual(
            candidate_event_type(queued_changed, set(), {"c"}), "CHANGED_URL"
        )

    def test_unchanged_retry_keeps_the_original_event_type(self):
        item = {
            "url_id": "c",
            "ai_pending": {"event_type": "NEW_URL", "event_id": "original-event"},
        }
        self.assertEqual(candidate_event_type(item, set(), set()), "NEW_URL")
        self.assertEqual(candidate_event_type(item, {"c"}, set()), "NEW_URL")
        self.assertEqual(candidate_event_type(item, set(), {"c"}), "CHANGED_URL")

    def test_first_baseline_does_not_create_ai_backlog(self):
        queued = {
            "url_id": "c",
            "ai_pending": {"event_type": "CHANGED_URL", "event_id": "old-event"},
        }
        self.assertEqual(
            build_ai_candidate_pool([], [], [queued], initial_baseline=True), []
        )

    def test_deferred_change_is_analyzed_on_later_unchanged_run(self):
        url = "https://example.test/policy"
        source = source_config()
        uid = make_id(url)
        now_old = "2026-10-17T00:00:00+00:00"
        before_html = (
            b"<html><body><main><h1>Quarterly reporting form</h1>"
            b"<p>Threshold: 10 percent.</p></main></body></html>"
        )
        after_html = (
            b"<html><body><main><h1>Quarterly reporting form</h1>"
            b"<p>Threshold: 25 percent, effective next quarter.</p>"
            b"</main></body></html>"
        )
        before_text = "Quarterly reporting form\nThreshold: 10 percent."
        before_raw_hash = hashlib.sha256(before_html).hexdigest()
        before_text_hash = hashlib.sha256(before_text.encode("utf-8")).hexdigest()
        old_html_path = "data/snapshots/html/before.html"
        old_text_path = "data/snapshots/before.txt"
        old_item = {
            "schema_version": 2,
            "url_id": uid,
            "source_id": source.id,
            "regulator": source.regulator,
            "canonical_url": url,
            "first_seen": now_old,
            "last_seen": now_old,
            "last_checked": now_old,
            "last_full_fetch": now_old,
            "active": True,
            "terminal_file": False,
            "http_status": 200,
            "content_type": "text/html; charset=utf-8",
            "content_length": len(before_html),
            "etag": '"before-etag"',
            "last_modified": "Fri, 16 Oct 2026 00:00:00 GMT",
            "raw_hash": before_raw_hash,
            "normalized_hash": before_text_hash,
            "html_hash": before_raw_hash,
            "html_comparison_hash": html_comparison_hash(before_html),
            "html_snapshot_location": old_html_path,
            "file_snapshot_location": None,
            "extraction_type": "html",
            "extractor_version": CONTENT_EXTRACTOR_VERSION,
            "extraction_error": None,
            "fetch_error": None,
            "snapshot_location": old_text_path,
            "evidence_location": None,
            "relevance": {"candidate": True, "reason": "synthetic baseline"},
            "not_modified": False,
        }

        with tempfile.TemporaryDirectory(prefix="changesentinel-ai-backlog-") as temporary:
            root = Path(temporary)
            data = root / "data"
            snapshots = data / "snapshots"
            html_snapshots = snapshots / "html"
            discovery = data / "discovery"
            history = data / "history"
            reports = data / "reports"
            for directory in (snapshots, html_snapshots, discovery, history, reports):
                directory.mkdir(parents=True, exist_ok=True)
            (snapshots / "before.txt").write_text(before_text, encoding="utf-8")
            (html_snapshots / "before.html").write_bytes(before_html)
            (data / "latest.json").write_text(
                json.dumps({"schema_version": 2, "sources": {source.id: {uid: old_item}}}),
                encoding="utf-8",
            )

            defaults = {
                "conditional_refresh_interval_hours": 24,
                "fetch_timeout_seconds": 30,
                "fetch_attempts": 3,
                "fetch_backoff_seconds": 2,
                "max_ai_candidates": 0,
                "ai_timeout_seconds": 60,
                "ai_attempts": 2,
                "max_ai_chars": 14000,
                "max_diff_lines": 250,
                "ai_concurrency": 1,
            }
            discovery_meta = {
                "source_id": source.id,
                "method": "synthetic-fixture",
                "state": "COMPLETE",
                "discovered": 1,
                "html_processed": 1,
                "successful_pages": 1,
                "failed_pages": 0,
                "capped": False,
                "pending": 0,
                "unresolved_failures": 0,
            }

            def fake_fetch(_url, **kwargs):
                if kwargs.get("etag") == '"after-etag"':
                    return FetchResult(
                        status_code=304,
                        content_type="text/html; charset=utf-8",
                        content_length=None,
                        etag='"after-etag"',
                        last_modified="Sun, 18 Oct 2026 10:00:00 GMT",
                        raw_hash="",
                        body=b"",
                        not_modified=True,
                    )
                return FetchResult(
                    status_code=200,
                    content_type="text/html; charset=utf-8",
                    content_length=len(after_html),
                    etag='"after-etag"',
                    last_modified="Sun, 18 Oct 2026 10:00:00 GMT",
                    raw_hash=hashlib.sha256(after_html).hexdigest(),
                    body=after_html,
                    not_modified=False,
                )

            analysis = {
                "relevant": True,
                "topic": "Synthetic threshold amendment",
                "change_type": "amendment",
                "summary": "The threshold changed from 10 to 25 percent.",
                "impact": "Review the reporting form and downstream processes.",
                "effective_date": "Next quarter",
                "affected_scope": "Quarterly reporting form",
                "actions": "Review and update reporting processes if applicable.",
                "reason": "The supplied before/after evidence records a threshold change.",
            }

            with (
                patch("regmon.engine.ROOT", root),
                patch("regmon.engine.DATA", data),
                patch("regmon.engine.SNAPSHOTS", snapshots),
                patch("regmon.engine.HTML_SNAPSHOTS", html_snapshots),
                patch("regmon.engine.HISTORY", history),
                patch("regmon.engine.REPORTS", reports),
                patch("regmon.engine.DISCOVERY", discovery),
                patch("regmon.engine.DEFAULTS", defaults),
                patch("regmon.engine.load_config", return_value=({}, {source.id: source})),
                patch("regmon.engine.discover", return_value=[url]),
                patch("regmon.engine.load_discovery_metadata", return_value=discovery_meta),
                patch("regmon.engine.fetch", side_effect=fake_fetch),
                patch("regmon.engine.analyze", return_value={"status": "ok", "analysis": analysis}) as analyze_mock,
            ):
                first = process_source(source, "synthetic-first")
                deferred_item = first["inventory"][uid]
                self.assertIn("ai_pending", deferred_item)
                original_event_id = deferred_item["ai_pending"]["event_id"]
                self.assertEqual(first["report"]["counts"]["ai_deferred"], 1)
                self.assertEqual(analyze_mock.call_count, 0)

                (data / "latest.json").write_text(
                    json.dumps({
                        "schema_version": 2,
                        "sources": {source.id: first["inventory"]},
                    }),
                    encoding="utf-8",
                )
                defaults["max_ai_candidates"] = 1
                second = process_source(source, "synthetic-second")

            self.assertEqual(analyze_mock.call_count, 1)
            self.assertEqual(second["report"]["counts"]["ai_ok"], 1)
            self.assertEqual(second["report"]["counts"]["ai_backlog_pending"], 0)
            self.assertNotIn("ai_pending", second["inventory"][uid])
            ai_result = second["report"]["ai_results"][0]
            self.assertEqual(ai_result["event_id"], original_event_id)
            self.assertEqual(ai_result["ai"]["status"], "ok")
            self.assertTrue(
                any(event["event_id"] == original_event_id for event in second["report"]["events"])
            )

    def test_inventory_item_preserves_backlog_across_a_304_response(self):
        url = "https://example.test/policy"
        now = "2026-10-19T12:00:00+00:00"
        pending = {
            "event_type": "CHANGED_URL",
            "event_id": "original-change-event",
            "after_hash": "stable-normalized-hash",
            "first_deferred_at": "2026-10-19T06:00:00+00:00",
            "deferral_count": 1,
            "attempt_count": 0,
        }
        old = {
            "url_id": "old-id",
            "canonical_url": url,
            "first_seen": "2026-10-10T00:00:00+00:00",
            "last_full_fetch": now,
            "content_type": "text/plain",
            "extraction_type": "text",
            "extractor_version": "legacy-text",
            "raw_hash": "raw-hash",
            "normalized_hash": "stable-normalized-hash",
            "snapshot_location": "data/snapshots/example.txt",
            "ai_pending": pending,
        }
        result = FetchResult(
            status_code=304,
            content_type="text/plain",
            content_length=None,
            etag=None,
            last_modified=None,
            raw_hash="",
            body=b"",
            not_modified=True,
        )
        with patch("regmon.engine.fetch", return_value=result):
            item, text, html_body = make_current_item(
                url, old, source_config(), now
            )

        self.assertIsNone(text)
        self.assertIsNone(html_body)
        self.assertEqual(item["ai_pending"], pending)
        self.assertTrue(item["not_modified"])


if __name__ == "__main__":
    unittest.main()
