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
        self.assertIn('window.CHANGESENTINEL_ASK_ENDPOINT', html)
        self.assertIn('https://pysoukwmnwwgilkwafdy.supabase.co/functions/v1/ask-sentinel', html)
        self.assertIn('supabase-js@2.121.0/dist/umd/supabase.js', html)
        self.assertIn('src="dashboard.js?v=20261021-sync-3"', html)
        self.assertIn('ASK_SENTINEL_ENDPOINT = window.CHANGESENTINEL_ASK_ENDPOINT || ""', js)
        self.assertIn('askSentinel: "askSentinelView"', js)
        self.assertIn('name === "ask-sentinel"', js)

    def test_backend_reads_index_but_never_indexes_in_a_request(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        for token in ("ask_sentinel_chunks", "search_ask_sentinel_chunks", "__current_inventory__",
                      "readIndexState", "openai/gpt-oss-20b", "GROQ_API", "MAX_CONTEXT_CHARS = 8500"):
            with self.subTest(token=token):
                self.assertIn(token, backend)
        for forbidden in ("api.github.com", "raw.githubusercontent.com", "syncRepository", "ask_sentinel_documents"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, backend)

    def test_index_is_built_in_github_actions_after_monitor_runs(self):
        workflow = (ROOT / ".github/workflows/ask-sentinel-index.yml").read_text(encoding="utf-8")
        self.assertIn('workflows: ["Regulatory Monitor"]', workflow)
        self.assertIn("secrets.SUPABASE_SECRET_KEY", workflow)
        self.assertIn("python scripts/ask_sentinel_index.py", workflow)

    def test_indexer_covers_monitoring_corpus_and_skips_archived_discovery(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("indexer", ROOT / "scripts/ask_sentinel_index.py")
        indexer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(indexer)
        inactive = {"eba-full-site"}
        self.assertFalse(indexer.is_indexable("data/discovery/eba-full-site-inventory-0001.txt", 10, inactive))
        self.assertFalse(indexer.is_indexable("data/discovery/eba-full-site.json", 10, inactive))
        self.assertTrue(indexer.is_indexable("data/discovery/fed-reporting-forms-pilot.json", 10, inactive))
        self.assertFalse(indexer.is_indexable("data/snapshots/files/x.txt", 10, inactive))
        self.assertFalse(indexer.is_indexable("data/snapshots/a.pdf", 10, inactive))
        for path in ("data/history/r.json", "data/evidence/e.json", "data/snapshots/s.txt", "README.md", "regmon/engine.py"):
            with self.subTest(path=path):
                self.assertTrue(indexer.is_indexable(path, 10, inactive))
        chunks = indexer.split_content("x\n" * 5000)
        self.assertTrue(all(len(c) <= indexer.CHUNK_CHARS for c in chunks))
        chunks = indexer.build_chunks(ROOT, "0" * 40)
        paths = {c["path"] for c in chunks}
        for required in ("__repo_overview__", "__current_report__", "__current_inventory__", "__recent_history__", "data/report.json"):
            with self.subTest(required=required):
                self.assertIn(required, paths)
        keys = [(c["path"], c["chunk_index"]) for c in chunks]
        self.assertEqual(len(keys), len(set(keys)))

    def test_daily_limit_is_enforced_in_private_database_not_browser(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        migration = (ROOT / "supabase/migrations/20261020080000_ask_sentinel_backend.sql").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("consume_ask_sentinel_request", backend)
        self.assertIn("where u.request_count < 3", migration)
        self.assertIn("GROQ_API", backend)
        self.assertIn("openai/gpt-oss-20b", backend)
        self.assertNotRegex(js + html, r"gsk_[A-Za-z0-9]{20,}")
        self.assertIn("client-side quota", js)
        self.assertIn("atomic database quota", backend)

    def test_prompt_shortcuts_use_authenticated_endpoint(self):
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("data-ask-prompt=", html)
        self.assertIn("askSentinelSendQuestion(prompt.dataset.askPrompt)", js)
        self.assertIn("fetch(ASK_SENTINEL_ENDPOINT", js)
        self.assertIn('"?mode=warm"', js)
        self.assertIn("askSentinelIdentityHeaders(identity)", js)
        self.assertIn("x-ask-sentinel-visitor-id", js)
        self.assertIn("response.status === 429", js)
        self.assertIn('$("askSentinelMessages").addEventListener("click"', js)
        self.assertNotIn("dashboard_context: askSentinelHistoryContext()", js)

    def test_sidebar_and_chat_use_existing_theme_and_preserve_mobile_navigation(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        for token in ("var(--pane)", "var(--accent)", "var(--ink)", "var(--line)", "@media (max-width: 980px)", ".nav-ask-short { display: inline; }"):
            with self.subTest(token=token):
                self.assertIn(token, html)
        self.assertIn("grid-template-columns: repeat(6, minmax(0, 1fr))", html)
        self.assertIn('data-view="askSentinel"', html)
        self.assertIn('$("askSentinelMessages").addEventListener("click"', js)
        self.assertIn('askLauncher.classList.toggle("active", state.view === "askSentinel")', js)
        self.assertIn('class="nav-button nav-button-ask" id="askSentinelLaunch" data-view="askSentinel"', html)
        self.assertNotIn("rail-ask", html)
        self.assertIn("window.supabase.createClient", js)
        self.assertIn("changesentinel-ask-visitor-id", js)
        self.assertIn("x-ask-sentinel-visitor-id", (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8"))
    def test_cors_preflight_returns_bodyless_204(self):
        # Regression: new Response('ok', {status: 204}) throws in Deno, so every browser
        # preflight returned 500 and the dashboard could never reach the function.
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertIn("return new Response(null, { status: c.allowed ? 204 : 403, headers: c.headers });", backend)
        self.assertNotRegex(backend, r"new Response\('[^']*',\s*\{\s*status:\s*c\.allowed \? 204")

    def test_answers_render_markdown_safely(self):
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertIn("function askSentinelMarkdown(", js)
        self.assertIn("askSentinelEscapedText(", js)
        self.assertIn("ask-sentinel-sources", js)


if __name__ == "__main__":
    unittest.main()
