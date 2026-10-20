import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class TestAskSentinelContract(unittest.TestCase):
    def test_ask_sentinel_is_an_isolated_sidebar_feature(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertIn('id="askSentinelLaunch"', html)
        self.assertIn('id="askSentinelView"', html)
        self.assertIn('id="askSentinelForm"', html)
        self.assertIn('id="askSentinelTranscript"', html)
        self.assertIn('id="askSentinelQuota"', html)
        self.assertIn('data-view="notifications"', html)
        self.assertIn('ASK_SENTINEL_ENDPOINT = window.CHANGESENTINEL_ASK_ENDPOINT || ""', js)
        self.assertIn('askSentinel: "askSentinelView"', js)
        self.assertIn('name === "ask-sentinel"', js)

    def test_chat_context_comes_from_loaded_real_monitoring_records(self):
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in (
            "function askSentinelHistoryContext()",
            "state.report",
            "state.inventory",
            "state.history",
            "changeLogEntries()",
            "notificationLists()",
            "data/evidence/*",
            "data/snapshots/*",
            "dashboard_context: askSentinelHistoryContext()",
        ):
            with self.subTest(token=token):
                self.assertIn(token, js)

    def test_browser_never_contains_an_openrouter_key_or_fake_quota_enforcement(self):
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertNotRegex(js + html, r"sk-or-v1-[A-Za-z0-9]{16,}")
        self.assertIn("client-side quota", js)
        self.assertIn("atomically", js)
        self.assertIn("Daily limit reached", js)

    def test_prompt_shortcuts_submit_through_the_same_endpoint(self):
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("data-ask-prompt=", html)
        self.assertIn("askSentinelSendQuestion(prompt.dataset.askPrompt)", js)
        self.assertIn("fetch(ASK_SENTINEL_ENDPOINT", js)
        self.assertIn("response.status === 429", js)

    def test_sidebar_and_chat_use_existing_theme_and_preserve_mobile_navigation(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        for token in ("var(--pane)", "var(--accent)", "var(--ink)", "var(--line)", "@media (max-width:980px)", ".rail-ask { display:none; }"):
            with self.subTest(token=token):
                self.assertIn(token, html)
        self.assertIn("grid-template-columns:repeat(6,minmax(0,1fr))", html)
        self.assertIn('data-view="askSentinel"', html)
        self.assertIn('$("askSentinelMessages").addEventListener("click"', read("dashboard.js"))
        self.assertIn("pages: pages.slice(0, 80)", read("dashboard.js"))
        self.assertIn('askLauncher.classList.toggle("active", state.view === "askSentinel")', read("dashboard.js"))
        self.assertIn(".ask-sentinel-launch.active", html)


if __name__ == "__main__":
    unittest.main()
