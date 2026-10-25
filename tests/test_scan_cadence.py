"""Per-monitor scan cadence: configuration, the due queue, overdue checks and settings requests."""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from regmon import health, monitor_settings, schedule
from regmon.config import SourceConfig
from regmon.schedule import Cadence

ROOT = Path(__file__).resolve().parents[1]
MON = datetime(2026, 11, 2, 6, 40, tzinfo=timezone.utc)  # a Monday, a late-started 06:00 slot


def source(source_id="s1", **extra):
    return {
        "id": source_id, "name": source_id.upper(), "regulator": "Reg", "active": True,
        "seed_urls": ["https://reg.test/page"], "allowed_prefixes": ["https://reg.test/"],
        "allowed_domains": ["reg.test"], **extra,
    }


class CadenceConfigTests(unittest.TestCase):
    def test_defaults_keep_the_six_hourly_scan(self):
        config = SourceConfig.from_dict(source())
        cadence = Cadence.from_source(config)
        self.assertTrue(cadence.is_default)
        self.assertEqual(cadence.describe(), "Every 6 hours")

    def test_valid_cadence_is_read(self):
        config = SourceConfig.from_dict(source(
            check_every_hours=24, check_days=["fri", "mon", "tue", "wed", "thu"],
            check_hours=[8, 18], check_timezone="America/Sao_Paulo",
        ))
        cadence = Cadence.from_source(config)
        self.assertEqual(cadence.days, ("mon", "tue", "wed", "thu", "fri"))
        self.assertEqual(cadence.describe(), "Daily, weekdays, 08:00–18:00 America/Sao_Paulo")

    def test_invalid_cadence_is_rejected(self):
        bad = [
            {"check_every_hours": 5}, {"check_every_hours": True}, {"check_every_hours": "24"},
            {"check_days": []}, {"check_days": ["monday"]}, {"check_days": ["mon", "mon"]},
            {"check_hours": [9, 12]}, {"check_hours": [18, 8]}, {"check_hours": [0, 25]}, {"check_hours": "8-18"},
            {"check_timezone": "Mars/Base"}, {"check_timezone": ""},
        ]
        for extra in bad:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                SourceConfig.from_dict(source(**extra))

    def test_committed_configuration_still_loads(self):
        from regmon.config import load_config

        _payload, sources = load_config(ROOT / "config" / "sources.json")
        self.assertTrue(sources)


class DueQueueTests(unittest.TestCase):
    def test_default_cadence_is_due_on_every_tick(self):
        cadence = Cadence()
        self.assertTrue(schedule.is_due(cadence, MON, MON + timedelta(minutes=20)))
        self.assertTrue(schedule.is_due(cadence, MON, MON + timedelta(hours=6)))

    def test_never_scanned_and_paused_sources_are_always_due(self):
        weekly = Cadence(every_hours=168)
        self.assertTrue(schedule.is_due(weekly, None, MON))
        self.assertTrue(schedule.is_due(weekly, MON, MON + timedelta(hours=6), paused=True))

    def test_daily_cadence_tolerates_late_starts(self):
        daily = Cadence(every_hours=24)
        self.assertFalse(schedule.is_due(daily, MON, MON + timedelta(hours=18)))
        # Tuesday's 06:00 run starting on time, 23 h 20 min after Monday's late one.
        self.assertTrue(schedule.is_due(daily, MON, datetime(2026, 11, 3, 6, 0, tzinfo=timezone.utc)))

    def test_weekdays_only_skips_the_weekend(self):
        weekdays = Cadence(every_hours=24, days=schedule.BUSINESS_DAYS)
        friday = datetime(2026, 11, 6, 6, 10, tzinfo=timezone.utc)
        saturday = friday + timedelta(days=1)
        monday = friday + timedelta(days=3)
        self.assertFalse(schedule.is_due(weekdays, friday, saturday))
        self.assertTrue(schedule.is_due(weekdays, friday, monday))
        # The first weekday slot after the weekend is Monday 00:00 UTC.
        self.assertEqual(schedule.next_due(weekdays, friday, saturday), monday.replace(hour=0, minute=0, second=0))

    def test_local_hour_window_in_the_monitors_time_zone(self):
        window = Cadence(every_hours=12, hours=(8, 18), tz="America/Sao_Paulo")  # UTC-3
        # 12:00 UTC is 09:00 in São Paulo (inside); 00:00 UTC is 21:00 (outside).
        self.assertTrue(window.allows(datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)))
        self.assertFalse(window.allows(datetime(2026, 11, 2, 0, 0, tzinfo=timezone.utc)))

    def test_next_due_skips_the_slot_already_scanned(self):
        self.assertEqual(schedule.next_due(Cadence(), MON, MON), MON.replace(hour=12, minute=0))

    def test_overdue_is_never_stricter_than_fourteen_hours_for_the_default(self):
        self.assertEqual(schedule.overdue_after(Cadence(), MON), MON + timedelta(hours=14))
        weekly = schedule.overdue_after(Cadence(every_hours=168), MON)
        self.assertGreater(weekly, MON + timedelta(days=7))

    def test_load_slots_counts_each_monitor_when_due(self):
        start = datetime(2026, 11, 2, 0, 30, tzinfo=timezone.utc)
        slots = schedule.load_slots({
            "fast": (Cadence(), start, 2),
            "daily": (Cadence(every_hours=24), start, 10),
        }, start, days=1)
        self.assertEqual(len(slots), 4)
        self.assertEqual(sum(slot["pages"] for slot in slots), 4 * 2 + 10)


class EngineDueSelectionTests(unittest.TestCase):
    def test_due_only_run_scans_due_sources_and_writes_nothing_when_none_are_due(self):
        from regmon import engine

        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            (data / "reports").mkdir()
            (data / "discovery").mkdir()
            fast = SourceConfig.from_dict(source("fast"))
            weekly = SourceConfig.from_dict(source("weekly", check_every_hours=168))
            fresh = SourceConfig.from_dict(source("fresh", check_every_hours=168))
            for sid in ("fast", "weekly"):
                (data / "reports" / f"{sid}.json").write_text(json.dumps(
                    {"source": {"id": sid}, "generated_at": MON.isoformat()}), encoding="utf-8")
            due, waiting = engine.due_sources([fast, weekly, fresh], MON + timedelta(hours=6), data)
            self.assertEqual([item.id for item in due], ["fast", "fresh"])
            self.assertEqual(waiting[0]["source_id"], "weekly")
            self.assertEqual(waiting[0]["cadence"], "Weekly")

            # A paused crawl continues whatever its cadence says.
            (data / "discovery" / "weekly.json").write_text(json.dumps({"source_id": "weekly", "state": "PAUSED"}), encoding="utf-8")
            due, _ = engine.due_sources([weekly], MON + timedelta(hours=6), data)
            self.assertEqual([item.id for item in due], ["weekly"])

    def test_nothing_due_returns_without_saving(self):
        from regmon import engine

        weekly = SourceConfig.from_dict(source("weekly", check_every_hours=168))
        with mock.patch.object(engine, "load_config", return_value=({}, {"weekly": weekly})), \
                mock.patch.object(engine, "due_sources", return_value=([], [{"source_id": "weekly"}])), \
                mock.patch.object(engine, "save_outputs") as save, \
                mock.patch.object(engine, "process_source") as process:
            result = engine.run("all", due_only=True)
        save.assert_not_called()
        process.assert_not_called()
        self.assertEqual(result["outcome"]["not_due"], [{"source_id": "weekly"}])

    def test_named_source_ignores_cadence(self):
        from regmon import engine

        weekly = SourceConfig.from_dict(source("weekly", check_every_hours=168))
        with mock.patch.object(engine, "load_config", return_value=({}, {"weekly": weekly})), \
                mock.patch.object(engine, "due_sources") as due, \
                mock.patch.object(engine, "save_outputs", return_value={}), \
                mock.patch.object(engine, "process_source", return_value={}), \
                mock.patch.object(engine, "configure_timeout_registry"):
            engine.run("weekly", due_only=True)
        due.assert_not_called()


class HealthCadenceTests(unittest.TestCase):
    def build(self, now):
        config = {"sources": [source("weekly", check_every_hours=168), source("fast")]}
        latest = {"sources": {
            "weekly": {"1": {"canonical_url": "https://reg.test/page", "active": True, "first_seen": MON.isoformat()}},
            "fast": {"2": {"canonical_url": "https://reg.test/page", "active": True, "first_seen": MON.isoformat()}},
        }}
        history = [
            {"source_id": "weekly", "generated_at": MON.isoformat(), "counts": {"unchanged": 1}},
            {"source_id": "fast", "generated_at": MON.isoformat(), "counts": {"unchanged": 1}},
        ]
        return health.build_health(config, latest, history, {}, now)

    def test_overdue_follows_each_monitors_cadence(self):
        report = self.build(MON + timedelta(days=3))
        status = {monitor["source_id"]: monitor["status"] for monitor in report["monitors"]}
        self.assertEqual(status, {"weekly": "healthy", "fast": "stale"})
        weekly = next(monitor for monitor in report["monitors"] if monitor["source_id"] == "weekly")
        self.assertEqual(weekly["cadence"]["label"], "Weekly")
        self.assertTrue(weekly["next_due"].startswith("2026-11-09"))

    def test_schedule_load_is_reported(self):
        load = self.build(MON + timedelta(hours=1))["schedule_load"]
        self.assertEqual(len(load["slots"]), 28)
        self.assertEqual({entry["label"] for entry in load["by_cadence"]}, {"Weekly", "Every 6 hours"})
        self.assertAlmostEqual(load["page_checks_per_day"], 4.1, places=1)

    def test_freshness_check_lists_only_overdue_monitors(self):
        with tempfile.TemporaryDirectory() as temporary:
            reports = Path(temporary)
            for sid in ("weekly", "fast"):
                (reports / f"{sid}.json").write_text(json.dumps({"generated_at": MON.isoformat()}), encoding="utf-8")
            config = {"sources": [source("weekly", check_every_hours=168), source("fast")]}
            overdue = schedule.overdue_sources(config, reports, MON + timedelta(days=3))
        self.assertEqual([entry["source_id"] for entry in overdue], ["fast"])


def issue(payload, author="owner", title="[ChangeSentinel] Update monitors (2)", marker=True):
    body = (monitor_settings.REQUEST_MARKER + "\n" if marker else "") + "SETTINGS_JSON:\n" + json.dumps(payload) + "\n\nThis request was created from the ChangeSentinel dashboard."
    return {"issue": {"title": title, "user": {"login": author}, "body": body}}


class SettingsRequestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "sources.json"
        self.path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [source("a"), source("b", check_every_hours=24)]}), encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def sources(self):
        return {item["id"]: item for item in json.loads(self.path.read_text(encoding="utf-8"))["sources"]}

    def test_preset_is_applied_to_every_listed_monitor(self):
        result = monitor_settings.update_from_issue(issue({
            "monitors": ["a", "b"], "set": {"check_every_hours": 24, "check_days": ["mon", "tue", "wed", "thu", "fri"]},
        }), self.path, "owner/repo")
        self.assertEqual(result["changed"], ["a", "b"])
        self.assertEqual(self.sources()["a"]["check_days"], ["mon", "tue", "wed", "thu", "fri"])

    def test_defaults_are_not_written_out(self):
        monitor_settings.update_from_issue(issue({"monitors": ["b"], "set": {"check_every_hours": 6}}), self.path, "owner/repo")
        self.assertNotIn("check_every_hours", self.sources()["b"])

    def test_invalid_values_change_nothing(self):
        before = self.path.read_text(encoding="utf-8")
        with self.assertRaises(ValueError):
            monitor_settings.update_from_issue(issue({"monitors": ["a", "b"], "set": {"check_hours": [9, 10]}}), self.path, "owner/repo")
        self.assertEqual(self.path.read_text(encoding="utf-8"), before)

    def test_scope_and_unknown_keys_cannot_be_changed(self):
        for payload in (
            {"monitors": ["a"], "set": {"seed_urls": ["https://evil.test/"]}},
            {"monitors": ["a"], "set": {"active": False}},
            {"monitors": ["zzz"], "set": {"check_every_hours": 24}},
            {"monitors": ["a"], "set": {}, "clear": []},
            {"monitors": ["a"], "set": {"check_every_hours": 24}, "clear": ["check_every_hours"]},
        ):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                monitor_settings.update_from_issue(issue(payload), self.path, "owner/repo")

    def test_only_the_owner_with_the_marker_may_change_settings(self):
        payload = {"monitors": ["a"], "set": {"check_every_hours": 24}}
        for event in (issue(payload, author="someone"), issue(payload, marker=False), issue(payload, title="Update monitors")):
            with self.subTest(event=event["issue"]["title"]), self.assertRaises(ValueError):
                monitor_settings.update_from_issue(event, self.path, "owner/repo")

    def test_clear_returns_a_setting_to_its_default(self):
        monitor_settings.update_from_issue(issue({"monitors": ["b"], "clear": ["check_every_hours"]}), self.path, "owner/repo")
        self.assertNotIn("check_every_hours", self.sources()["b"])


class WorkflowCadenceTests(unittest.TestCase):
    def test_scheduled_runs_scan_only_due_monitors(self):
        workflow = (ROOT / ".github" / "workflows" / "regulatory-monitor.yml").read_text(encoding="utf-8")
        self.assertIn("github.event_name == 'schedule' && '--due-only'", workflow)
        self.assertIn('--source "$REGMON_SOURCE" $REGMON_DUE_ONLY', workflow)

    def test_freshness_is_judged_per_monitor(self):
        workflow = (ROOT / ".github" / "workflows" / "monitor-freshness.yml").read_text(encoding="utf-8")
        self.assertIn("python3 -m regmon.schedule", workflow)
        self.assertNotIn("age_hours > 14", workflow)

    def test_settings_workflow_is_owner_only(self):
        workflow = (ROOT / ".github" / "workflows" / "update-monitors.yml").read_text(encoding="utf-8")
        self.assertIn("github.event.issue.user.login == github.repository_owner", workflow)
        self.assertIn("startsWith(github.event.issue.title, '[ChangeSentinel] Update monitors')", workflow)
        self.assertIn("python -m regmon.monitor_settings", workflow)
        self.assertIn("git add config/sources.json", workflow)


if __name__ == "__main__":
    unittest.main()


import shutil
import subprocess

NODE = shutil.which("node")


def run_js(body: str):
    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    result = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class DashboardScheduleTests(unittest.TestCase):
    CASES = [
        {},
        {"check_every_hours": 24},
        {"check_every_hours": 24, "check_days": ["mon", "tue", "wed", "thu", "fri"]},
        {"check_every_hours": 168, "check_days": ["fri", "mon"]},
        {"check_every_hours": 12, "check_hours": [8, 18]},
        {"check_every_hours": 24, "check_days": ["mon", "tue", "wed", "thu", "fri"], "check_hours": [8, 18], "check_timezone": "America/Sao_Paulo"},
    ]

    def test_labels_match_the_engine(self):
        labels = run_js("console.log(JSON.stringify(" + json.dumps(self.CASES) + ".map(c => L.scanScheduleLabel(L.scanSchedule(c)))));")
        expected = [Cadence.from_source(source(**case)).describe() for case in self.CASES]
        self.assertEqual(labels, expected)

    def test_preview_slots_match_the_engine(self):
        start = datetime(2026, 11, 2, 1, 0, tzinfo=timezone.utc)
        for case in self.CASES:
            with self.subTest(case=case):
                js = run_js("console.log(JSON.stringify(L.scanSlots(L.scanSchedule(" + json.dumps(case) + "), " +
                            str(int(start.timestamp() * 1000)) + ", 7, " + str(int(start.timestamp() * 1000)) + ").filter(s => s.due).map(s => s.at)));")
                slots = schedule.load_slots({"x": (Cadence.from_source(source(**case)), start, 1)}, start, days=7)
                engine = [int(datetime.fromisoformat(slot["at"]).timestamp() * 1000) for slot in slots if slot["pages"]]
                self.assertEqual(js, engine)

    def test_request_payload_is_accepted_by_the_settings_workflow(self):
        out = run_js(
            "const p = L.scanSchedulePayload(['a','b'], L.scanSchedule({check_every_hours: 24, check_days: ['mon','tue','wed','thu','fri']}));"
            "const reset = L.scanSchedulePayload(['a'], L.scanSchedule({}));"
            "console.log(JSON.stringify({ p, reset, requests: L.settingsRequests(p, 'Daily'), split: L.settingsRequests({ monitors: Array.from({length: 250}, (_, i) => 'm' + i), set: {}, clear: ['check_days'] }).map(r => r.count) }));"
        )
        self.assertEqual(out["p"]["set"], {"check_every_hours": 24, "check_days": ["mon", "tue", "wed", "thu", "fri"]})
        self.assertEqual(sorted(out["reset"]["clear"]), sorted(monitor_settings.SETTABLE_KEYS & {"check_every_hours", "check_days", "check_hours", "check_timezone"}))
        self.assertEqual(out["split"], [120, 120, 10])
        request = out["requests"][0]
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sources.json"
            path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [source("a"), source("b")]}), encoding="utf-8")
            event = {"issue": {"title": request["title"], "user": {"login": "owner"}, "body": request["body"].replace("\n", "\r\n")}}
            result = monitor_settings.update_from_issue(event, path, "owner/repo")
        self.assertEqual(result["changed"], ["a", "b"])


    def test_a_scheduled_run_with_nothing_due_counts_as_done(self):
        out = run_js(
            "const now = Date.UTC(2026, 10, 2, 7, 30);"
            "const runs = [{ id: 1, event: 'schedule', status: 'completed', conclusion: 'success', created_at: new Date(Date.UTC(2026, 10, 2, 6, 40)).toISOString(), updated_at: new Date(Date.UTC(2026, 10, 2, 6, 45)).toISOString() }];"
            "console.log(JSON.stringify([L.pendingScan(new Date(now), [], runs).phase, L.pendingScan(new Date(now), [], []).phase]));"
        )
        self.assertEqual(out, ["waiting", "late"])


class DashboardScheduleContractTests(unittest.TestCase):
    def test_schedule_dialog_and_hooks_are_present(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for element in ("scanScheduleDialog", "scanScheduleForm", "scanEvery", "scanDayPicks", "scanWindowOn", "scanZone", "scanPreview", "scanScheduleReset"):
            self.assertIn('id="' + element + '"', html)
        self.assertIn("[data-edit-schedule]", js)
        self.assertIn("if (data.editSchedule) return openScanSchedule(", js)
        self.assertIn("healthScheduleSheet(health)", js)
        # The settings marker the dashboard writes is the one the workflow requires.
        lib = (ROOT / "dashboard-lib.js").read_text(encoding="utf-8")
        self.assertIn('const SETTINGS_MARKER = "' + monitor_settings.REQUEST_MARKER + '"', lib)
