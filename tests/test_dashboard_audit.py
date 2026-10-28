"""Dashboard follow-ups to the 25 Oct audit (part 4/5).

Contrast is computed from the theme tokens themselves; the rest pin the
mechanisms (guarded bindings, revalidating polls, queued reloads, the scan
field's keyboard model) that the browser checks exercised.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "index.html").read_text(encoding="utf-8")
JS = (ROOT / "dashboard.js").read_text(encoding="utf-8")


def luminance(hex_colour: str) -> float:
    value = hex_colour.lstrip("#")
    channels = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def theme(name: str) -> dict[str, str]:
    block = re.search(r':root\[data-theme="' + name + r'"\]\s*\{(.*?)\n    \}', HTML, re.S).group(1)
    return dict(re.findall(r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", block))


class TestContrast(unittest.TestCase):
    def test_tertiary_text_meets_aa_on_panes_in_both_themes(self):
        # CS-73: --ink-3 labels the 8-12 px meta text; AA needs 4.5:1.
        for name in ("light", "dark"):
            tokens = theme(name)
            for surface in ("pane", "raise"):
                self.assertGreaterEqual(contrast(tokens["ink-3"], tokens[surface]), 4.5, f"{name} ink-3 on {surface}")

    def test_tertiary_stays_lighter_than_secondary(self):
        tokens = theme("light")
        self.assertLess(contrast(tokens["ink-3"], tokens["pane"]), contrast(tokens["ink-2"], tokens["pane"]))


class TestDashboardMechanisms(unittest.TestCase):
    def test_module_level_bindings_are_guarded(self):
        # CS-83: one missing element used to throw and leave every later binding unset.
        self.assertIsNone(re.search(r'^\$\("[A-Za-z0-9_-]+"\)\.addEventListener\(', JS, re.M))
        self.assertIn('function bind(id, type, handler, options) {', JS)
        self.assertIn("if (!element) { console.warn(", JS)

    def test_background_polls_revalidate_and_explicit_loads_bust(self):
        # CS-81
        self.assertIn('background ? await fetch(url, { cache: "no-cache" }) : await fetch(bust(url), { cache: "no-store" })', JS)
        self.assertIn("fetchAssets(full ? SMALL_ASSETS.concat(LARGE_ASSETS) : SMALL_ASSETS, background)", JS)

    def test_a_reload_asked_for_during_a_load_is_queued(self):
        # CS-65
        body = JS[JS.index("function loadData(showErrors) {"):JS.index("async function loadDataOnce(")]
        self.assertIn("state.reloadQueued = true", body)
        self.assertIn("while (state.reloadQueued)", body)
        self.assertNotIn(".then(() => loadDataOnce(true))", body)

    def test_scan_times_use_todays_offsets(self):
        # CS-63
        body = JS[JS.index("function scheduleTimes() {"):JS.index("function triggerWords(")]
        self.assertNotIn("Date.UTC(2026, 0, 1)", body)
        self.assertIn("now.getUTCDate()", body)

    def test_the_scan_field_has_a_keyboard_model(self):
        # CS-71: roving tabindex, arrows, Home/End, Enter, tip on keyboard focus only.
        for token in ('bind("signalVisual", "keydown"', "ArrowLeft: [-1, 0]", 'event.key === "Home" || event.key === "End"',
                      'light.matches(":focus-visible")', "fieldFocusRestore(field, refocus)", 'target.setAttribute("tabindex", "0")'):
            self.assertIn(token, JS)

    def test_selected_rows_say_aria_current(self):
        # CS-84: aria-selected is ignored on plain buttons.
        self.assertNotIn("' aria-selected=\"true\"'", JS)
        self.assertIn("' aria-selected=\"true\" aria-current=\"true\"'", JS)

    def test_no_plugin_content_loads(self):
        # CS-89 (the part a document policy can carry without breaking srcdoc previews).
        self.assertIn('<meta http-equiv="Content-Security-Policy" content="object-src \'none\'">', HTML)


if __name__ == "__main__":
    unittest.main()
