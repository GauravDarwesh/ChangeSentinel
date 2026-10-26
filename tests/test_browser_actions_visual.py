"""Recorded browser steps and visual diffs: validation (Python and dashboard),
step replay and its failures, screenshot comparison, the engine's storage and
VISUAL_CHANGED event, alerts, settings and state validation.

The in-page step script and the recorder are exercised in a real Chromium by
scripts/browser_steps_check.mjs (CI, dashboard-smoke job)."""
from __future__ import annotations

import asyncio
import dataclasses
import io
import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from engine_harness import SOURCE, Sandbox, html, ok
from regmon import browser_actions, browser_fetch, monitor_settings, visual
from regmon.config import SourceConfig, _validate_source_types

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
STEPS = [{"action": "select", "selector": "#report", "value": "FFIEC 031"}, {"action": "click", "selector": "#search"},
         {"action": "wait_for", "selector": "table.results", "seconds": 5}]


class TestValidation(unittest.TestCase):
    def test_good_steps_are_canonicalised(self):
        steps = browser_actions.validate_actions(STEPS + [{"action": "press"}, {"action": "wait"}, {"action": "scroll"}])
        self.assertEqual(steps[3], {"action": "press", "key": "Enter"})
        self.assertEqual(steps[4], {"action": "wait", "seconds": 1})
        self.assertEqual(steps[2]["seconds"], 5)

    def test_problems_are_named(self):
        cases = [
            ("nope", "must be a list"),
            ([{"action": "hover", "selector": "a"}], "action must be one of"),
            ([{"action": "click"}], "selector must be a CSS selector"),
            ([{"action": "click", "selector": "a\nb"}], "selector must be a CSS selector"),
            ([{"action": "type", "selector": "#q"}], "text must be"),
            ([{"action": "press", "key": "F5"}], "key must be one of"),
            ([{"action": "wait", "seconds": 31}], "at most 30"),
            ([{"action": "wait", "seconds": 30}] * 4, "limit is 90"),
            ([{"action": "click", "selector": "a", "url": "x"}], "unknown keys"),
            ([{"action": "click", "selector": "a"}] * 21, "more than 20 steps"),
        ]
        for value, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(browser_actions.ActionError) as caught:
                    browser_actions.validate_actions(value)
                self.assertIn(message, str(caught.exception))

    def test_configuration_rules(self):
        base = {"id": "portal", "name": "Portal", "regulator": "Synthetic", "seed_urls": ["https://example.test/"],
                "allowed_prefixes": ["https://example.test/"], "allowed_domains": ["example.test"]}
        _validate_source_types({**base, "fetch_mode": "browser", "browser_actions": STEPS, "visual_compare": True, "visual_alert_threshold": 0.02})
        for extra, message in (({"browser_actions": STEPS}, "need fetch_mode"), ({"visual_compare": True}, "needs fetch_mode"),
                               ({"fetch_mode": "browser", "visual_alert_threshold": 0.02}, "needs visual_compare"),
                               ({"fetch_mode": "browser", "visual_compare": True, "visual_alert_threshold": 2}, "0.001 to 1"),
                               ({"fetch_mode": "browser", "browser_actions": [{"action": "click"}]}, "selector")):
            with self.subTest(message=message):
                with self.assertRaises(ValueError) as caught:
                    _validate_source_types({**base, **extra})
                self.assertIn(message, str(caught.exception))
        config = SourceConfig.from_dict({**base, "fetch_mode": "browser", "browser_actions": STEPS, "visual_compare": True, "visual_alert_threshold": 0.02})
        self.assertEqual(len(config.browser_actions), 3)
        self.assertEqual(config.visual_alert_threshold, 0.02)

    def test_settings_requests_can_set_them(self):
        for key in ("browser_actions", "visual_compare", "visual_alert_threshold"):
            self.assertIn(key, monitor_settings.SETTABLE_KEYS)


class TestReplay(unittest.TestCase):
    """run_steps drives any page through evaluate(); the in-page script is tested in Chromium."""

    def run_steps(self, answers, steps):
        calls = []
        now = [0.0]

        async def evaluate(expression):
            # Hand the fake page the step itself (the script text names every action).
            step = "document.readyState" if expression == "document.readyState" else json.loads(expression[expression.rindex(")({") + 2:-1])
            calls.append(step)
            return answers(step)

        async def sleep(seconds):
            now[0] += seconds

        result = asyncio.run(browser_fetch.run_steps(evaluate, browser_actions.validate_actions(steps), sleep=sleep, clock=lambda: now[0]))
        return result, calls, now[0]

    def test_steps_run_in_order_and_wait_for_the_page(self):
        polls = {"n": 0}

        def answers(step):
            if step == "document.readyState":
                return "complete"
            if step["action"] == "wait_for":
                polls["n"] += 1
                return "ok" if polls["n"] >= 3 else "wait"
            return "ok"

        result, calls, elapsed = self.run_steps(answers, STEPS)
        self.assertEqual(result, 3)
        self.assertEqual(calls[0]["action"], "select")
        self.assertEqual(polls["n"], 3)
        self.assertGreater(elapsed, 0.5)

    def test_a_failing_step_names_itself(self):
        with self.assertRaises(RuntimeError) as caught:
            self.run_steps(lambda step: "complete" if step == "document.readyState" else
                           ("error: nothing matches #search" if step["action"] == "click" else "ok"), STEPS)
        self.assertEqual(str(caught.exception), "Step 2 (Click #search): nothing matches #search")
        with self.assertRaises(RuntimeError) as caught:
            self.run_steps(lambda step: "complete" if step == "document.readyState" else ("wait" if step["action"] == "wait_for" else "ok"), STEPS)
        self.assertIn("Step 3 (Wait up to 5 s for table.results): nothing appeared within 5 s", str(caught.exception))

    def test_the_step_script_is_the_one_the_browser_check_runs(self):
        expression = browser_actions.step_expression({"action": "click", "selector": "#a"})
        self.assertTrue(expression.startswith("(step =>"))
        self.assertTrue(expression.endswith('({"action": "click", "selector": "#a"})'))


def png(boxes=(), size=(400, 300), colour=(20, 90, 200)) -> bytes:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", size, (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.text((10, 10), "Reporting portal", fill=(0, 0, 0))
    for box in boxes:
        draw.rectangle(box, fill=colour)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@unittest.skipUnless(visual.available(), "Pillow is needed for visual comparison")
class TestVisualCompare(unittest.TestCase):
    def test_identical_screenshots_do_not_differ(self):
        result = visual.compare(png(), png())
        self.assertEqual((result["changed_ratio"], result["regions"]), (0.0, []))

    def test_a_changed_block_is_measured_and_boxed(self):
        result = visual.compare(png(), png(boxes=[(100, 100, 199, 149)]))
        self.assertAlmostEqual(result["changed_ratio"], 100 * 50 / (400 * 300), places=4)
        self.assertEqual(result["region_count"], 1)
        left, top, right, bottom = result["regions"][0]
        self.assertTrue(left <= 100 and top <= 100 and right >= 200 and bottom >= 150)
        self.assertTrue(result["overlay_png"].startswith(b"\x89PNG"))

    def test_different_sizes_are_padded(self):
        result = visual.compare(png(size=(400, 300)), png(size=(400, 360)))
        self.assertEqual(result["size_before"], [400, 300])
        self.assertEqual(result["size_after"], [400, 360])
        self.assertEqual(result["changed_ratio"], 0.0)  # the added strip is white, like the padding

    def test_faint_noise_is_ignored(self):
        result = visual.compare(png(boxes=[(0, 200, 399, 299)], colour=(250, 250, 250)), png())
        self.assertEqual(result["changed_ratio"], 0.0)


def portal_source(**overrides) -> SourceConfig:
    return dataclasses.replace(SOURCE, fetch_mode="browser", visual_compare=True, **overrides)


@unittest.skipUnless(visual.available(), "Pillow is needed for visual comparison")
class TestEngine(unittest.TestCase):
    def scan(self, sandbox, shot, text="<p>Report results</p>"):
        def render(url, **kwargs):
            self.kwargs = kwargs
            return browser_fetch.Rendered(html(text), url, 0, "", screenshot=shot, steps=len(kwargs.get("steps") or []))
        with patch("regmon.browser_fetch.render", side_effect=render):
            return sandbox.scan(lambda *a, **k: ok(html("<div id='app'>Loading…</div>")))

    def test_screenshots_are_kept_compared_and_raise_visual_changed_above_the_threshold(self):
        src = portal_source(visual_alert_threshold=0.02, browser_actions=tuple(STEPS))
        with Sandbox(source=src) as sandbox:
            self.scan(sandbox, png())
            self.assertEqual(len(self.kwargs["steps"]), 3)
            self.assertTrue(self.kwargs["screenshot"])
            record = next(iter(sandbox.inventory().values()))
            first = record["visual_snapshot_location"]
            self.assertTrue((sandbox.root / first).is_file())
            self.assertEqual(record["browser"]["steps"], 3)
            # A render that looks the same keeps the same file.
            quiet = self.scan(sandbox, png(boxes=[(0, 0, 1, 1)]))
            self.assertFalse([e for e in quiet["report"]["events"] if e["event_type"] == "VISUAL_CHANGED"])
            self.assertEqual(next(iter(sandbox.inventory().values()))["visual_snapshot_location"], first)
            changed = self.scan(sandbox, png(boxes=[(50, 50, 349, 249)]))
            event = next(e for e in changed["report"]["events"] if e["event_type"] == "VISUAL_CHANGED")
            self.assertGreater(event["visual"]["changed_ratio"], 0.02)
            evidence = json.loads((sandbox.root / event["evidence_location"]).read_text(encoding="utf-8"))
            for key in ("before", "after", "overlay"):
                self.assertTrue((sandbox.root / evidence["visual"][key]).is_file(), key)
            self.assertEqual(evidence["visual"]["before"], first)
            entry = next(iter(sandbox.inventory().values()))["change_history"][0]
            self.assertEqual(entry["event_type"], "VISUAL_CHANGED")
            self.assertEqual(changed["report"]["counts"]["visual_changed"], 1)

    def test_without_a_threshold_a_visual_difference_is_evidence_only(self):
        with Sandbox(source=portal_source()) as sandbox:
            self.scan(sandbox, png())
            quiet = self.scan(sandbox, png(boxes=[(50, 50, 349, 249)]))
            self.assertFalse([e for e in quiet["report"]["events"] if e["event_type"] == "VISUAL_CHANGED"])
            self.assertGreater(next(iter(sandbox.inventory().values()))["visual"]["changed_ratio"], 0.1)
            changed = self.scan(sandbox, png(boxes=[(10, 200, 100, 290)]), text="<p>Report results, revised</p>")
            event = next(e for e in changed["report"]["events"] if e["event_type"] == "CHANGED_URL")
            evidence = json.loads((sandbox.root / event["evidence_location"]).read_text(encoding="utf-8"))
            self.assertIn("visual", evidence)
            self.assertIn("visual", event)


class TestAlertsAndState(unittest.TestCase):
    def test_visual_changes_alert_and_are_muted_in_shadow(self):
        from regmon import notify

        report = {"events": [{"event_id": "v1", "event_type": "VISUAL_CHANGED", "url": "https://example.test/", "source_id": "s",
                              "visual": {"changed_ratio": 0.084}}], "ai_results": [], "sources": [{"id": "s"}]}
        alert = next(item for item in notify.build_notifications(report) if item["event_id"] == "v1")
        self.assertEqual(alert["topic"], "Page looks different")
        self.assertIn("8.4% of the page", alert["summary"])
        report["sources"] = [{"id": "s", "shadow": True}]
        self.assertFalse([item for item in notify.build_notifications(report) if item["event_id"] == "v1"])

    def test_state_validation_checks_screenshot_pointers(self):
        from regmon import validate_state

        self.assertIn("visual_snapshot_location", validate_state.POINTER_KEYS)


def run_js(body: str):
    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    result = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class TestDashboardHalf(unittest.TestCase):
    def test_validation_and_wording_match(self):
        cases = [STEPS + [{"action": "press"}, {"action": "wait"}, {"action": "scroll"}, {"action": "type", "selector": "#q", "text": "BHCK2170"}],
                 [{"action": "hover"}], [{"action": "wait", "seconds": 30}] * 4, [{"action": "click"}]]
        out = run_js("console.log(JSON.stringify(" + json.dumps(cases) + ".map(c => { const r = L.validateBrowserSteps(c); "
                     "return [r.steps, !!r.error, r.steps.map(L.describeBrowserStep)]; })));")
        for case, (steps, failed, words) in zip(cases, out):
            try:
                expected = browser_actions.validate_actions(case)
            except browser_actions.ActionError:
                self.assertTrue(failed, case)
                continue
            self.assertFalse(failed, case)
            self.assertEqual(steps, expected)
            self.assertEqual(words, [browser_actions.describe(step) for step in expected])

    def test_the_recorder_is_a_bookmarklet(self):
        out = run_js("console.log(JSON.stringify([L.recorderBookmarklet().slice(0, 11), L.RECORDER_SOURCE.indexOf('password') >= 0]));")
        self.assertEqual(out, ["javascript:", True])


if __name__ == "__main__":
    unittest.main()
