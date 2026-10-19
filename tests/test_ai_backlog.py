"""Regression tests for durable AI backlog selection."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from regmon.config import SourceConfig
from regmon.engine import (
    base_item,
    build_ai_candidate_pool,
    candidate_event_type,
    make_current_item,
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
