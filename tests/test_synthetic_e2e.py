"""Offline end-to-end synthetic monitoring run.

The test exercises the real engine, snapshot/evidence writers, report persistence,
notification construction, and durable outbox while replacing every external input
(discovery, HTTP fetch, and AI assessment) with deterministic fixtures.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from regmon.change import html_comparison_hash, make_id
from regmon.config import SourceConfig
from regmon.notify import build_notifications, enqueue_notifications, load_outbox, save_outbox


class TestSyntheticEndToEndRun(unittest.TestCase):
    def test_changed_document_flows_through_evidence_ai_report_and_notification_queue(self):
        from regmon.engine import run

        url = "https://example.test/regulatory/quarterly-reporting-form"
        source = SourceConfig(
            id="synthetic-e2e",
            name="Synthetic Regulatory Source",
            regulator="Synthetic Regulator",
            seed_urls=(url,),
            allowed_prefixes=("https://example.test/regulatory/",),
            allowed_domains=("example.test",),
            allowed_urls=(url,),
            baseline_on_first_run=False,
        )
        uid = make_id(url)
        before_text = "Quarterly Reporting Form\nThreshold: 10 percent."
        before_html = (
            b"<html><body><main><h1>Quarterly Reporting Form</h1>"
            b"<p>Threshold: 10 percent.</p></main></body></html>"
        )
        after_html = (
            b"<html><body><main><h1>Quarterly Reporting Form</h1>"
            b"<p>Threshold: 25 percent. Effective next quarter.</p>"
            b"</main></body></html>"
        )
        before_raw_hash = hashlib.sha256(before_html).hexdigest()
        after_raw_hash = hashlib.sha256(after_html).hexdigest()
        before_text_hash = hashlib.sha256(before_text.encode("utf-8")).hexdigest()
        analysis = {
            "relevant": True,
            "topic": "Synthetic reporting threshold amendment",
            "change_type": "amendment",
            "summary": "The reporting threshold increased from 10 to 25 percent.",
            "impact": "Teams using the form should review the revised threshold.",
            "effective_date": "Next quarter",
            "affected_scope": "Quarterly Reporting Form",
            "actions": "Review the updated form and determine whether reporting processes need changes.",
            "reason": "The before/after diff shows a substantive threshold change.",
        }

        with tempfile.TemporaryDirectory(prefix="changesentinel-synthetic-e2e-") as temporary:
            root = Path(temporary)
            data = root / "data"
            snapshots = data / "snapshots"
            html_snapshots = snapshots / "html"
            discovery_dir = data / "discovery"
            history_dir = data / "history"
            reports_dir = data / "reports"
            for path in (snapshots, html_snapshots, discovery_dir, history_dir, reports_dir):
                path.mkdir(parents=True, exist_ok=True)

            before_text_path = snapshots / "before.txt"
            before_text_path.write_text(before_text, encoding="utf-8")
            before_html_path = html_snapshots / "before.html"
            before_html_path.write_bytes(before_html)

            previous_item = {
                "schema_version": 2,
                "url_id": uid,
                "source_id": source.id,
                "regulator": source.regulator,
                "canonical_url": url,
                "first_seen": "2026-10-01T00:00:00+00:00",
                "last_seen": "2026-10-17T00:00:00+00:00",
                "last_checked": "2026-10-17T00:00:00+00:00",
                "last_full_fetch": "2026-10-16T00:00:00+00:00",
                "active": True,
                "http_status": 200,
                "content_type": "text/html; charset=utf-8",
                "content_length": len(before_html),
                "etag": '"before-etag"',
                "last_modified": "Fri, 16 Oct 2026 00:00:00 GMT",
                "raw_hash": before_raw_hash,
                "normalized_hash": before_text_hash,
                "html_hash": before_raw_hash,
                "html_comparison_hash": html_comparison_hash(before_html),
                "html_snapshot_location": "data/snapshots/html/before.html",
                "extraction_type": "html",
                "extraction_error": None,
                "fetch_error": None,
                "snapshot_location": "data/snapshots/before.txt",
                "evidence_location": None,
                "relevance": {"candidate": True, "reason": "synthetic test baseline"},
                "not_modified": False,
            }
            (data / "latest.json").write_text(
                json.dumps({"schema_version": 2, "sources": {source.id: {uid: previous_item}}}, indent=2),
                encoding="utf-8",
            )
            (discovery_dir / f"{source.id}.json").write_text(
                json.dumps({
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
                }, indent=2),
                encoding="utf-8",
            )

            fetched_response = Mock(
                status_code=200,
                content_type="text/html; charset=utf-8",
                content_length=len(after_html),
                etag='"after-etag"',
                last_modified="Sun, 18 Oct 2026 10:00:00 GMT",
                raw_hash=after_raw_hash,
                body=after_html,
                not_modified=False,
            )

            with (
                patch("regmon.engine.ROOT", root),
                patch("regmon.engine.DATA", data),
                patch("regmon.engine.SNAPSHOTS", snapshots),
                patch("regmon.engine.HTML_SNAPSHOTS", html_snapshots),
                patch("regmon.engine.HISTORY", history_dir),
                patch("regmon.engine.REPORTS", reports_dir),
                patch("regmon.engine.DISCOVERY", discovery_dir),
                patch("regmon.engine.load_config", return_value=({}, {source.id: source})),
                patch("regmon.engine.discover", return_value=[url]) as discover_mock,
                patch("regmon.engine.fetch", return_value=fetched_response) as fetch_mock,
                patch("regmon.engine.triage", return_value={
                    "candidate": True, "reason": "synthetic substantive-change fixture"
                }),
                patch("regmon.engine.analyze", return_value={
                    "status": "ok", "analysis": analysis
                }) as analyze_mock,
            ):
                run_result = run(source.id, dry_run=False)

            # Real engine + real output/evidence/snapshot writers all operate inside
            # this temporary directory. No production data directory is touched.
            self.assertEqual(run_result["outcome"]["sources"], [source.id])
            result = run_result["results"][0]
            report = result["report"]
            self.assertEqual(report["counts"]["changed"], 1)
            self.assertEqual(report["counts"]["ai_ok"], 1)
            self.assertEqual(report["counts"]["fetch_error"], 0)
            self.assertEqual(report["counts"]["extraction_error"], 0)
            self.assertEqual(discover_mock.call_count, 1)
            self.assertEqual(fetch_mock.call_count, 1)
            self.assertEqual(analyze_mock.call_count, 1)

            event = next(event for event in report["events"] if event["event_type"] == "CHANGED_URL")
            ai_result = next(ai for ai in report["ai_results"] if ai["event"] == "CHANGED_URL")
            self.assertEqual(event["event_id"], ai_result["event_id"])
            self.assertTrue(event["evidence_location"])
            evidence_path = root / event["evidence_location"]
            self.assertTrue(evidence_path.is_file())

            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            self.assertEqual(evidence["event_id"], event["event_id"])
            self.assertIn("10 percent", evidence["diff"])
            self.assertIn("25 percent", evidence["diff"])
            self.assertIn("10 percent", evidence["html_diff"])
            self.assertIn("25 percent", evidence["html_diff"])

            current_item = result["inventory"][uid]
            self.assertTrue(current_item["snapshot_location"])
            self.assertTrue(current_item["html_snapshot_location"])
            self.assertTrue((root / current_item["snapshot_location"]).is_file())
            self.assertTrue((root / current_item["html_snapshot_location"]).is_file())

            # Verify the normal save_outputs() path exposed the same event, AI
            # result, and snapshot paths in the durable report and inventory.
            saved_report = json.loads((data / "report.json").read_text(encoding="utf-8"))
            saved_inventory = json.loads((data / "latest.json").read_text(encoding="utf-8"))
            saved_events = [item for item in saved_report["events"] if item["event_id"] == event["event_id"]]
            self.assertEqual(len(saved_events), 1)
            self.assertIn(uid, saved_inventory["sources"][source.id])
            self.assertEqual(
                saved_inventory["sources"][source.id][uid]["snapshot_location"],
                current_item["snapshot_location"],
            )

            # Build and persist the real notification payload, but deliberately do
            # not call publish() or make any outbound notification request.
            notifications = build_notifications(report)
            self.assertEqual(len(notifications), 1)
            self.assertEqual(notifications[0]["event_id"], event["event_id"])
            self.assertEqual(notifications[0]["topic"], analysis["topic"])
            outbox_path = data / "notification-outbox.json"
            outbox = load_outbox(outbox_path)
            enqueue_notifications(outbox, notifications, {})
            save_outbox(outbox, outbox_path)
            persisted_outbox = load_outbox(outbox_path)
            self.assertIn(event["event_id"], persisted_outbox["pending_events"])
            self.assertEqual(
                persisted_outbox["pending_events"][event["event_id"]]["summary"],
                analysis["summary"],
            )

            # Check the same evidence link/data fields used by the dashboard UI.
            dashboard_js = (Path(__file__).resolve().parents[1] / "dashboard.js").read_text(encoding="utf-8")
            self.assertIn("event.evidence_location", dashboard_js)
            self.assertIn('fetch(bust(RAW + "/" + event.evidence_location)', dashboard_js)
            self.assertIn("evidence.html_diff", dashboard_js)
            self.assertIn("evidence.diff", dashboard_js)


if __name__ == "__main__":
    unittest.main()
