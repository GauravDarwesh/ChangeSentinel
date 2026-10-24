"""Per-monitor alert conditions ("Alert me when ...")."""
from __future__ import annotations

import dataclasses
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from engine_harness import ANALYSIS, SOURCE, Sandbox, html, ok
from regmon import ai
from regmon.config import SourceConfig
from regmon.notify import build_notifications, enqueue_notifications

CONDITION = "Alert me when a new XML user guide is added"
BASE = {
    "id": "manual-x", "name": "X", "regulator": "Fed", "seed_urls": ["https://example.test/a"],
    "allowed_prefixes": ["https://example.test/"], "allowed_domains": ["example.test"],
}


def ai_result(relevant=True, met=None, only=False, status="ok", event_id="evt-1"):
    result = {
        "event": "CHANGED_URL", "event_id": event_id, "url": "https://example.test/a",
        "ai": {"status": status, "analysis": dict(ANALYSIS, relevant=relevant)} if status == "ok"
        else {"status": status, "reason": "provider down"},
    }
    if met is not None:
        result["ai"]["condition"] = {"text": CONDITION, "met": met, "reason": "Row XML Guide added"}
        result["alert_condition"] = CONDITION
        result["alert_only_on_condition"] = only
    return result


def report(*results):
    return {
        "events": [{"event_id": r["event_id"], "event_type": "CHANGED_URL", "url": r["url"]} for r in results],
        "ai_results": list(results),
    }


class TestConfig(unittest.TestCase):
    def test_condition_is_parsed_and_whitespace_normalised(self):
        source = SourceConfig.from_dict(dict(BASE, alert_condition="  new   guide ", alert_only_on_condition=True))
        self.assertEqual(source.alert_condition, "new guide")
        self.assertTrue(source.alert_only_on_condition)

    def test_defaults_keep_existing_monitors_unchanged(self):
        source = SourceConfig.from_dict(BASE)
        self.assertEqual(source.alert_condition, "")
        self.assertFalse(source.alert_only_on_condition)

    def test_invalid_conditions_are_rejected(self):
        for bad in (
            {"alert_only_on_condition": True},
            {"alert_condition": "", "alert_only_on_condition": True},
            {"alert_condition": 5},
            {"alert_condition": "x" * 501},
            {"alert_condition": "ok", "alert_only_on_condition": "yes"},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                SourceConfig.from_dict(dict(BASE, **bad))


class TestAIContract(unittest.TestCase):
    def test_condition_keys_are_required_only_when_a_condition_is_set(self):
        with_condition = dict(ANALYSIS, condition_met=True, condition_reason="New guide row")
        self.assertEqual(ai.parse_json(json.dumps(with_condition), condition=True)["condition_met"], True)
        with self.assertRaises(ValueError):
            ai.parse_json(json.dumps(ANALYSIS), condition=True)
        with self.assertRaises(ValueError):
            ai.parse_json(json.dumps(with_condition))
        with self.assertRaises(ValueError):
            ai.parse_json(json.dumps(dict(with_condition, condition_met="yes")), condition=True)

    def test_analyze_splits_condition_from_the_nine_key_analysis(self):
        content = json.dumps(dict(ANALYSIS, condition_met=False, condition_reason="Only a footer changed"))
        response = Mock(status_code=200, headers={})
        response.json.return_value = {"model": "m", "choices": [{"message": {"content": content}}]}
        with patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), patch("regmon.ai.requests.post", return_value=response) as post:
            result = ai.analyze("Fed", "https://example.test/a", "CHANGED_URL", "-a\n+b", "b", ai.AIConfig(attempts=1), condition=CONDITION)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(set(result["analysis"]), ai.AI_REQUIRED_KEYS)
        self.assertEqual(result["condition"], {"text": CONDITION, "met": False, "reason": "Only a footer changed"})
        system = post.call_args.kwargs["json"]["messages"][0]["content"]
        self.assertIn(json.dumps(CONDITION), system)
        self.assertNotIn(CONDITION, post.call_args.kwargs["json"]["messages"][1]["content"])

    def test_analyze_without_condition_keeps_the_original_prompt(self):
        response = Mock(status_code=200, headers={})
        response.json.return_value = {"choices": [{"message": {"content": json.dumps(ANALYSIS)}}]}
        with patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), patch("regmon.ai.requests.post", return_value=response) as post:
            result = ai.analyze("Fed", "u", "NEW_URL", "", "text", ai.AIConfig(attempts=1))
        self.assertNotIn("condition", result)
        self.assertEqual(post.call_args.kwargs["json"]["messages"][0]["content"], ai.SYSTEM_PROMPT)


class TestEngine(unittest.TestCase):
    def test_condition_reaches_the_model_and_the_timeline(self):
        source = dataclasses.replace(SOURCE, alert_condition=CONDITION, alert_only_on_condition=True)
        verdict = {"status": "ok", "analysis": ANALYSIS, "condition": {"text": CONDITION, "met": True, "reason": "r"}}
        with Sandbox(source=source) as box:
            box.scan(lambda *_a, **_k: ok(html("<p>Guide v1</p>")))
            result = box.scan(lambda *_a, **_k: ok(html("<p>Guide v2</p>")), analyze_result=verdict)
            self.assertEqual(result["analyze_mock"].call_args.kwargs["condition"], CONDITION)
            ai_result = result["report"]["ai_results"][0]
            self.assertEqual(ai_result["alert_condition"], CONDITION)
            self.assertTrue(ai_result["alert_only_on_condition"])
            history = next(iter(result["inventory"].values()))["change_history"]
            self.assertTrue(history[0]["ai_condition_met"])


class TestNotifications(unittest.TestCase):
    def test_unmet_condition_on_alert_only_monitor_does_not_alert(self):
        notes = build_notifications(report(ai_result(relevant=True, met=False, only=True)))
        self.assertEqual([n["variant"] for n in notes], ["condition_not_met"])
        outbox = enqueue_notifications({"pending_events": {}}, notes, {})
        self.assertEqual(outbox["pending_events"], {})

    def test_unmet_condition_follows_up_a_delivered_generic_alert(self):
        notes = build_notifications(report(ai_result(relevant=True, met=False, only=True)))
        outbox = enqueue_notifications({"pending_events": {}}, notes, {"evt-1": {"variant": "generic"}})
        follow_up = outbox["pending_events"]["evt-1#ai"]
        self.assertEqual(follow_up["topic"], "AI assessment: alert condition not met")
        self.assertEqual(follow_up["priority"], 2)

    def test_met_condition_alerts_even_when_ai_calls_it_not_relevant(self):
        notes = build_notifications(report(ai_result(relevant=False, met=True, only=True)))
        self.assertEqual([n["variant"] for n in notes], ["ai"])
        self.assertTrue(notes[0]["condition"].startswith("Met — " + CONDITION))

    def test_condition_without_alert_only_still_alerts_on_relevance(self):
        notes = build_notifications(report(ai_result(relevant=True, met=False, only=False)))
        self.assertEqual([n["variant"] for n in notes], ["ai"])
        self.assertTrue(notes[0]["condition"].startswith("Not met"))

    def test_failed_ai_keeps_the_generic_alert_for_alert_only_monitors(self):
        result = ai_result(status="error")
        result["alert_condition"], result["alert_only_on_condition"] = CONDITION, True
        notes = build_notifications(report(result))
        self.assertEqual([n["variant"] for n in notes], ["generic"])

    def test_condition_line_is_published(self):
        from regmon.notify import publish

        notes = build_notifications(report(ai_result(relevant=True, met=True, only=True)))
        with patch("regmon.notify.requests.post") as post:
            publish(notes[0], "topic", "https://ntfy.example")
        self.assertIn("Alert condition: Met — " + CONDITION, post.call_args.kwargs["json"]["message"])


class TestRegistration(unittest.TestCase):
    def setUp(self):
        import regmon.register_monitor as module

        self.module = module
        self._resolve = module._resolve_redirects
        module._resolve_redirects = lambda url: url

    def tearDown(self):
        self.module._resolve_redirects = self._resolve

    def _event(self, *lines):
        body = "\n".join([
            self.module.REQUEST_MARKER, "", "URL: https://example.test/guides", "Name: Guides",
            *lines, "Include selector: ", "Ignore selectors:", "(none)",
            "", "This request was created from the ChangeSentinel dashboard.",
        ])
        return {"issue": {"title": "[ChangeSentinel] Add monitor request", "body": body, "user": {"login": "GauravDarwesh"}}}

    def _register(self, config_path, *lines):
        return self.module.register_request(self._event(*lines), config_path, "GauravDarwesh/ChangeSentinel")

    def test_condition_is_set_updated_and_cleared(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "sources.json"
            config_path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            result = self._register(config_path, f"Alert me when: {CONDITION}", "Alert only when condition met: yes")
            source = json.loads(config_path.read_text())["sources"][0]
            self.assertEqual(source["alert_condition"], CONDITION)
            self.assertTrue(source["alert_only_on_condition"])
            self.assertTrue(result["alert_only_on_condition"])
            SourceConfig.from_dict(source)

            self._register(config_path, "Alert only when condition met: no")
            source = json.loads(config_path.read_text())["sources"][0]
            self.assertEqual(source["alert_condition"], CONDITION)
            self.assertNotIn("alert_only_on_condition", source)

            self._register(config_path)
            self.assertEqual(json.loads(config_path.read_text())["sources"][0]["alert_condition"], CONDITION)

            result = self._register(config_path, "Alert me when:")
            source = json.loads(config_path.read_text())["sources"][0]
            self.assertNotIn("alert_condition", source)
            self.assertIn("Alert condition cleared", result["message"])

    def test_alert_only_without_condition_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "sources.json"
            config_path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": []}), encoding="utf-8")
            with self.assertRaises(ValueError):
                self._register(config_path, "Alert only when condition met: yes")
            self.assertEqual(json.loads(config_path.read_text())["sources"], [])

    def test_condition_is_refused_on_a_shared_multi_page_source(self):
        shared = dict(
            BASE, id="pilot", seed_urls=["https://example.test/guides", "https://example.test/other"],
            allowed_urls=["https://example.test/guides", "https://example.test/other"], active=True,
        )
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "sources.json"
            config_path.write_text(json.dumps({"version": 4, "defaults": {}, "sources": [shared]}), encoding="utf-8")
            with self.assertRaises(ValueError):
                self._register(config_path, f"Alert me when: {CONDITION}")
            self.assertNotIn("alert_condition", json.loads(config_path.read_text())["sources"][0])


if __name__ == "__main__":
    unittest.main()
