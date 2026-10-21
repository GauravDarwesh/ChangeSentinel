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
        # 2.121.0 was never published; a missing client silently disabled sign-in.
        self.assertIn('supabase-js@2.118.0/dist/umd/supabase.js', html)
        self.assertNotIn('supabase-js@2.121.0', html)
        self.assertIn('src="dashboard.js?v=20261021-hardening-1"', html)
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
        self.assertIn('workflows: ["Regulatory Monitor", "Scout", "Scout Review Decision", "Scout Source Request"]', workflow)
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
        self.assertFalse(indexer.is_indexable("data/scout/registry/osfi.json", 10, inactive))
        self.assertTrue(indexer.is_indexable("data/scout/review.json", 10, inactive))
        for path in ("data/history/r.json", "data/evidence/e.json", "data/snapshots/s.txt", "README.md", "regmon/engine.py"):
            with self.subTest(path=path):
                self.assertTrue(indexer.is_indexable(path, 10, inactive))
        chunks = indexer.split_content("x\n" * 5000)
        self.assertTrue(all(len(c) <= indexer.CHUNK_CHARS for c in chunks))
        chunks = indexer.build_chunks(ROOT, "0" * 40)
        paths = {c["path"] for c in chunks}
        for required in ("__repo_overview__", "__current_report__", "__current_scope__", "__current_inventory__", "__recent_history__", "data/report.json"):
            with self.subTest(required=required):
                self.assertIn(required, paths)
        scope = "\n".join(c["content"] for c in chunks if c["path"] == "__current_scope__")
        self.assertIn("fed-reporting-forms-pilot", scope)
        self.assertIn("fed-reporting-forms-detail-pilot", scope)
        self.assertIn("manual-f1df3c7d3e94", scope)
        self.assertIn("eba-full-site", scope)
        self.assertIn("INACTIVE / ARCHIVED - NOT CURRENTLY MONITORED", scope)
        self.assertIn("eba-consumer-protection", scope)
        self.assertIn("NOT PRESENT IN config/sources.json", scope)
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
        # Seven tabs since Scout joined the bar between Alerts and Ask.
        self.assertIn("grid-template-columns: repeat(7, auto)", html)
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


    def test_grounding_uses_question_relevant_evidence_not_unconditional_core_docs(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertIn("type AskSentinelEvidence = { context: string; sources: string[] };", backend)
        self.assertIn("const searchResults = docs", backend)
        self.assertIn(".filter((doc: any) => doc.is_core !== true)", backend)
        self.assertIn("return { context: context.join", backend)
        self.assertNotIn("for (const d of core) addContext", backend)

    def test_answers_require_citations_to_selected_evidence(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertIn("function validateGroundedCitations(answer: string, allowedSources: string[]): CitationValidation", backend)
        self.assertIn("validateGroundedCitations(answer, evidence.sources)", backend)
        self.assertIn("context_sources: evidence.sources", backend)
        self.assertIn("temperature: 0,", backend)
        self.assertIn("Conversation history is supplied only to resolve follow-up references. It is not evidence.", backend)

    def test_backend_emits_phase_diagnostics_without_request_content(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertIn("event: 'ask_sentinel_stage'", backend)
        self.assertIn("event: 'ask_sentinel_error'", backend)
        self.assertIn("phase, elapsed_ms:", backend)
        self.assertNotIn("console.info(question", backend)
        self.assertNotIn("console.info(answer", backend)


    def test_citation_validator_accepts_only_paths_in_supplied_evidence(self):
        import re

        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertIn("function validateGroundedCitations(answer: string, allowedSources: string[]): CitationValidation {", backend)
        citation_pattern = re.compile(r"\[Source:\s*([^\]]+)\]", re.IGNORECASE)

        def validate(answer, allowed_sources):
            citations = [match.group(1).strip() for match in citation_pattern.finditer(answer)]
            return bool(citations) and all(path in set(allowed_sources) for path in citations)

        self.assertTrue(validate("A fact. [Source: data/report.json]", ["data/report.json"]))
        self.assertFalse(validate("A fact with no citation.", ["data/report.json"]))
        self.assertFalse(validate("A fact. [Source: data/made-up.json]", ["data/report.json"]))
        self.assertFalse(validate("A fact. [Source: data/report.json] [Source: invented.json]", ["data/report.json"]))
        self.assertIn("const invalidCitationCount = citations.filter((path) => !allowed.has(path)).length;", backend)
        self.assertIn("else if (invalidCitationCount > 0) reason = 'unapproved_source';", backend)

    def test_evidence_headers_make_exact_citation_paths_unambiguous(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertIn("const marker = 'Source path: ' + path + ' | Document type: ' + String(doc.doc_type || 'text');", backend)
        self.assertIn("cite only that exact path and exclude the Document type label or any other suffix.", backend)
        self.assertIn("reason: citationValidation.reason", backend)
        self.assertIn("invalid_citation_count: citationValidation.invalid_citation_count", backend)
        self.assertIn("uncited_line_count: citationValidation.uncited_line_count", backend)

    def test_live_grounding_eval_runs_after_smoke_failure_if_health_passes(self):
        workflow = (ROOT / ".github/workflows/ask-sentinel-health.yml").read_text(encoding="utf-8")
        self.assertIn("id: endpoint_health", workflow)
        condition = "if: ${{ always() && steps.endpoint_health.outcome == 'success' && github.event_name != 'pull_request' }}"
        self.assertGreaterEqual(workflow.count(condition), 2)
        self.assertIn("name: Evaluate live grounding against current dashboard records", workflow)

    def test_live_questions_do_not_spend_the_provider_budget_on_every_push(self):
        workflow = (ROOT / ".github/workflows/ask-sentinel-health.yml").read_text(encoding="utf-8")
        triggers = workflow[workflow.index("on:"):workflow.index("permissions:")]
        self.assertNotIn('"index.html"', triggers)
        self.assertNotIn('"dashboard.js"', triggers)
        self.assertIn("schedule:", triggers)
        smoke = workflow[workflow.index("- name: Index the repository and ask a real Groq question"):]
        self.assertIn("if: ${{ github.event_name != 'pull_request' }}", smoke[:400])

    def test_abuse_limits_do_not_depend_on_the_callers_identity(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        migration = (ROOT / "supabase/migrations/20261021120000_ask_sentinel_abuse_limits.sql").read_text(encoding="utf-8")
        self.assertIn("rpc/consume_ask_sentinel_request_v2", backend)
        self.assertIn("req.headers.get('cf-connecting-ip')", backend)
        self.assertIn("name: 'HMAC', hash: 'SHA-256'", backend)
        self.assertIn("'global_limit'", migration)
        self.assertIn("'ip_limit'", migration)
        # The address itself is never stored.
        self.assertNotRegex(migration, r"\bip_address\b|\binet\b")
        # Locks in one order: service day, network, then user.
        body = migration[migration.index("function public.consume_ask_sentinel_request_v2"):]
        self.assertLess(body.index("from public.ask_sentinel_daily_usage d"), body.index("from public.ask_sentinel_ip_usage i"))
        self.assertLess(body.index("from public.ask_sentinel_ip_usage i"), body.index("from public.ask_sentinel_usage u"))

    def test_ci_runs_the_edge_function_against_fakes(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertIn("npx deno test --allow-env supabase/functions/ask-sentinel/index_test.ts", ci)
        tests = (ROOT / "supabase/functions/ask-sentinel/index_test.ts").read_text(encoding="utf-8")
        self.assertIn("fresh visitor IDs cannot get past the network limit", tests)

    def test_service_failures_refund_the_question_and_hide_internal_errors(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertEqual(backend.count("await refundRequest(actor.id)"), 2)
        self.assertIn("if (error instanceof PublicError) return respond(req, { error: error.message }, error.status);", backend)
        self.assertNotIn("return respond(req, { error: message }, status);", backend)
        self.assertIn("'Access-Control-Expose-Headers': 'Retry-After'", backend)

    def test_run_and_evidence_ids_are_pinned_to_exact_indexed_paths(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertIn("function exactRunId(question: string): string | null", backend)
        self.assertIn("function exactEvidencePath(question: string): string | null", backend)
        self.assertIn("'data/history/' + requestedRunId + '.json'", backend)
        self.assertIn("fetchDocsByPath(requestedEvidencePath)", backend)
        self.assertIn("exact_run_not_found", backend)
        self.assertIn("No answer was generated from another run.", backend)

    def test_operational_retrieval_excludes_manifest_and_unrelated_snapshots(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertIn("doc.doc_type !== 'repository file manifest'", backend)
        self.assertIn("!asksInventory(question) || doc.path !== '__current_inventory__'", backend)
        self.assertIn("!['source code or workflow', 'project documentation', 'repository file', 'extracted page snapshot'].includes", backend)

    def test_every_answer_line_requires_a_valid_selected_source_citation(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        self.assertIn("Require a source marker in every substantive paragraph and every explicit list item.", backend)
        self.assertIn("if (!/\\[Source:", backend)


    def test_grounding_errors_use_http_errors_the_existing_frontend_displays(self):
        backend = (ROOT / "supabase/functions/ask-sentinel/index.ts").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertIn("No answer was generated from another run.'", backend)
        self.assertIn("I cannot verify that evidence file in the indexed committed records.' }, 404)", backend)
        self.assertIn("supporting indexed evidence for this question.", backend)
        self.assertIn("}, 422);", backend)
        self.assertIn("could not verify the generated answer against the retrieved source citations.", backend)
        self.assertIn("if (!response.ok)", js)
        self.assertIn("typeof payload.error === \"string\" ? payload.error", js)


if __name__ == "__main__":
    unittest.main()
