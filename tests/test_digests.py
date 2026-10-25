"""Scheduled AI digests (regmon/digest.py)."""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from regmon import channels, digest, monitor_settings, notify

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)  # a Saturday


def source(source_id, url, **extra):
    host = url.split("/")[2]
    return {"id": source_id, "name": source_id.upper() + " (Exact URL Allowlist)", "regulator": host, "active": True,
            "seed_urls": [url], "allowed_prefixes": [f"https://{host}/"], "allowed_domains": [host], **extra}


class Fixture:
    def __init__(self, root: Path):
        self.data, self.config = root / "data", root / "config"
        (self.data / "history").mkdir(parents=True)
        (self.data / "evidence").mkdir(parents=True)
        self.config.mkdir()
        (self.config / "regulators.json").write_text(json.dumps({"schema_version": 1, "regulators": [
            {"id": "bcb", "name": "Banco Central do Brasil", "region": "LATAM", "hosts": ["bcb.gov.br"]}]}), encoding="utf-8")
        (self.config / "sources.json").write_text(json.dumps({"version": 4, "defaults": {}, "sources": [
            source("bcb", "https://www.bcb.gov.br/leiaute"),
            source("fed", "https://www.federalreserve.gov/forms", workspace="NTS", labels=["FR Y-9C"]),
        ]}), encoding="utf-8")
        self.index = []

    def run(self, run_id, at, events, ai=(), initial=()):
        payload = {"run_id": run_id, "sources": [{"id": sid, "initial_baseline": sid in initial} for sid in {e["source_id"] for e in events}],
                   "events": events, "ai_results": list(ai)}
        (self.data / "history" / f"{run_id}.json").write_text(json.dumps(payload), encoding="utf-8")
        for sid in {event["source_id"] for event in events}:
            self.index.append({"run_id": run_id, "source_id": sid, "generated_at": at.isoformat()})
        (self.data / "history" / "index.json").write_text(json.dumps(self.index), encoding="utf-8")

    def evidence(self, event_id, diff):
        path = self.data / "evidence" / f"{event_id}.json"
        path.write_text(json.dumps({"diff": diff}), encoding="utf-8")
        return str(path)

    def digests(self, items):
        (self.config / "digests.json").write_text(json.dumps({"version": 1, "digests": items}), encoding="utf-8")


def event(event_id, sid, url, at, kind="CHANGED_URL", evidence=None):
    return {"event_id": event_id, "event_type": kind, "url": url, "source_id": sid, "timestamp": at.isoformat(), "evidence_location": evidence}


def ai(event_id, relevant, summary):
    return {"event_id": event_id, "ai": {"status": "ok", "analysis": {"relevant": relevant, "topic": "t", "summary": summary,
                                                                      "effective_date": "2027-01-01" if relevant else "Not stated"}}}


class ScheduleTests(unittest.TestCase):
    def test_latest_moment_for_daily_and_weekly(self):
        daily = {"id": "d", "workspace": "*", "frequency": "daily", "hour": 9, "timezone": "America/Sao_Paulo"}
        weekly = {"id": "w", "workspace": "*", "frequency": "weekly", "day": "mon", "hour": 8, "timezone": "UTC"}
        self.assertEqual(digest.latest_moment(daily, NOW), datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc))
        self.assertEqual(digest.latest_moment(daily, NOW - timedelta(minutes=1)), datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc))
        self.assertEqual(digest.latest_moment(weekly, NOW), datetime(2026, 10, 19, 8, 0, tzinfo=timezone.utc))

    def test_configuration_is_validated(self):
        good = {"id": "latam-weekly", "workspace": "LATAM", "frequency": "weekly", "day": "fri", "hour": 8, "timezone": "America/Lima"}
        self.assertEqual(digest.validate_digests({"version": 1, "digests": [good]}), [good])
        for bad in (
            {**good, "id": "Bad Id"}, {**good, "frequency": "hourly"}, {**good, "day": "friday"}, {**good, "hour": 24},
            {**good, "timezone": "Mars/Base"}, {**good, "workspace": "<b>"}, {**good, "extra": 1},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                digest.validate_digests({"version": 1, "digests": [bad]})
        with self.assertRaises(ValueError):
            digest.validate_digests({"version": 1, "digests": [good, good]})
        self.assertEqual(json.loads((ROOT / "config" / "digests.json").read_text(encoding="utf-8"))["digests"], [])


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.fx = Fixture(Path(self.temporary.name))
        at = NOW - timedelta(days=2)
        bcb_evidence = self.fx.evidence("e1", "--- a\n+++ b\n-Prazo de envio: 30 dias\n+Prazo de envio: 15 dias após a data-base\n")
        self.fx.run("r1", at, [
            event("e1", "bcb", "https://www.bcb.gov.br/leiaute", at, evidence=bcb_evidence),
            event("e2", "fed", "https://www.federalreserve.gov/forms", at),
            event("e3", "bcb", "https://www.bcb.gov.br/leiaute", at, kind="FETCH_ERROR"),
        ], ai=[ai("e1", True, "The filing deadline moves from 30 to 15 days."), ai("e2", False, "Navigation reordered.")])
        self.fx.run("r0", NOW - timedelta(days=9), [event("old", "bcb", "https://www.bcb.gov.br/leiaute", NOW - timedelta(days=9))])
        self.fx.run("rb", at, [event("base", "bcb", "https://www.bcb.gov.br/new", at, kind="NEW_URL")], initial={"bcb"})

    def tearDown(self):
        self.temporary.cleanup()

    def build(self, workspace):
        item = {"id": "x", "workspace": workspace, "frequency": "weekly", "day": "sat", "hour": 12, "timezone": "UTC"}
        config = json.loads((self.fx.config / "sources.json").read_text(encoding="utf-8"))
        with mock.patch.object(digest, "ROOT", Path("/")):
            return digest.build(item, NOW, self.fx.data, config, digest.Regions(self.fx.config), use_ai=False)

    def test_workspace_scope_period_quote_and_order(self):
        record = self.build("LATAM")
        self.assertEqual([item["event_id"] for item in record["items"]], ["e1"])  # region, period, no errors, no baseline
        item = record["items"][0]
        self.assertEqual(item["quote"], "Prazo de envio: 15 dias após a data-base")
        self.assertEqual(item["summary"], "The filing deadline moves from 30 to 15 days.")
        self.assertEqual(item["monitor"], "BCB")
        self.assertEqual(record["counts"]["relevant"], 1)

    def test_explicit_workspace_and_all_workspaces(self):
        self.assertEqual([item["event_id"] for item in self.build("NTS")["items"]], ["e2"])
        everything = self.build("*")
        self.assertEqual([item["event_id"] for item in everything["items"]], ["e1", "e2"])  # relevant first
        self.assertIn("2 changes on 2 monitors, 1 judged relevant", everything["overview"])

    def test_notification_lists_changes_with_quotes(self):
        note = digest.notification_for(self.build("*"))
        self.assertEqual(note["kind"], "DIGEST")
        self.assertTrue(note["event_id"].startswith("digest:x-"))
        self.assertIn("“Prazo de envio: 15 dias", note["impact"])
        self.assertIn("Weekly digest, all workspaces: 2 changes, 1 relevant", note["topic"])
        self.assertEqual(channels.impact_label(note), "Changes")
        self.assertIn("#alerts/digest%3Ax-", notify.dashboard_link(note, "https://example.test/cs/"))

    def test_ai_overview_is_used_when_available_and_falls_back_otherwise(self):
        items = self.build("*")["items"]
        response = mock.Mock(status_code=200)
        response.raise_for_status = lambda: None
        response.json = lambda: {"choices": [{"message": {"content": json.dumps({"overview": "BCB shortened a deadline."})}}]}
        with mock.patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), mock.patch.object(digest.requests, "post", return_value=response):
            self.assertEqual(digest.ai_overview(items, {"workspace": "*"}), ("BCB shortened a deadline.", "ok"))
        with mock.patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), mock.patch.object(digest.requests, "post", side_effect=RuntimeError("down")):
            overview, status = digest.ai_overview(items, {"workspace": "*"})
        self.assertEqual(status, "error")
        self.assertIn("2 changes", overview)

    def test_run_due_builds_once_per_moment_and_skips_catch_up_for_new_digests(self):
        self.fx.digests([{"id": "all-weekly", "workspace": "*", "frequency": "weekly", "day": "sat", "hour": 11, "timezone": "UTC"},
                         {"id": "old-weekly", "workspace": "LATAM", "frequency": "weekly", "day": "mon", "hour": 8, "timezone": "UTC"}])
        with mock.patch.object(digest, "ROOT", Path("/")):
            first = digest.run_due(self.fx.data, self.fx.config, now=NOW, enqueue=False, use_ai=False)
            again = digest.run_due(self.fx.data, self.fx.config, now=NOW + timedelta(hours=6), enqueue=False, use_ai=False)
        self.assertEqual([record["digest_id"] for record in first], ["all-weekly"])  # old-weekly waits for its next time
        self.assertEqual(again, [])
        index = json.loads((self.fx.data / "digests" / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(index["digests"]["all-weekly"]["latest"]["counts"]["changes"], 2)
        self.assertNotIn("latest", index["digests"]["old-weekly"])
        before = (self.fx.data / "digests" / "index.json").read_text(encoding="utf-8")
        with mock.patch.object(digest, "ROOT", Path("/")):
            digest.run_due(self.fx.data, self.fx.config, now=NOW + timedelta(hours=7), enqueue=False, use_ai=False)
        self.assertEqual((self.fx.data / "digests" / "index.json").read_text(encoding="utf-8"), before)  # no churn

    def test_digests_are_enqueued_with_the_runs_alerts(self):
        self.fx.digests([{"id": "all-weekly", "workspace": "*", "frequency": "weekly", "day": "sat", "hour": 11, "timezone": "UTC"}])
        outbox = {"pending_events": {}}
        with mock.patch.object(digest, "ROOT", Path("/")), \
                mock.patch.object(notify, "load_state", return_value={"sent_events": {}}), \
                mock.patch.object(notify, "load_outbox", return_value=outbox), \
                mock.patch.object(notify, "save_outbox") as save:
            digest.run_due(self.fx.data, self.fx.config, now=NOW, enqueue=True, use_ai=False)
        save.assert_called_once()
        self.assertEqual([value["kind"] for value in outbox["pending_events"].values()], ["DIGEST"])


class SettingsTests(unittest.TestCase):
    def test_a_digests_request_replaces_the_list(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "sources.json"
            config.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            item = {"id": "latam-weekly", "workspace": "LATAM", "frequency": "weekly", "day": "mon", "hour": 8, "timezone": "UTC"}
            body = monitor_settings.REQUEST_MARKER + "\n\nSETTINGS_JSON:\n" + json.dumps({"digests": [item]}) + "\n\nThis request was created from the ChangeSentinel dashboard."
            event = {"issue": {"title": "[ChangeSentinel] Update monitors (digests)", "user": {"login": "o"}, "body": body}}
            result = monitor_settings.update_from_issue(event, config, "o/r")
            self.assertEqual(json.loads((Path(temporary) / "digests.json").read_text(encoding="utf-8"))["digests"], [item])
            self.assertEqual(result["changed"], ["digests"])
            bad = body.replace('"hour": 8', '"hour": 30')
            with self.assertRaises(ValueError):
                monitor_settings.update_from_issue({"issue": {**event["issue"], "body": bad}}, config, "o/r")


class WorkflowAndDashboardTests(unittest.TestCase):
    def test_scans_build_digests_before_alerts_are_queued(self):
        workflow = (ROOT / ".github" / "workflows" / "regulatory-monitor.yml").read_text(encoding="utf-8")
        self.assertLess(workflow.index("python -m regmon.digest --due"), workflow.index("python -m regmon.notify --enqueue-only"))
        pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn("data/digests/index.json", pages)
        self.assertIn("config/digests.json", pages)
        settings = (ROOT / ".github" / "workflows" / "update-monitors.yml").read_text(encoding="utf-8")
        self.assertIn("git add config/sources.json config/digests.json", settings)

    def test_dashboard_reads_and_edits_digests(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for element in ("digestEntries", "digestDialog", "digestRows", "digestForm"):
            self.assertIn('id="' + element + '"', html)
        for hook in ('digests: "data/digests/index.json"', 'digestConfig: "config/digests.json"',
                     "return renderDigestDetail(pane);", 'JSON.stringify({ digests })', "digest-quote"):
            self.assertIn(hook, js)


if __name__ == "__main__":
    unittest.main()
