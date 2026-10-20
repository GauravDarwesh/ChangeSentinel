# Operations

The active production scope consists of two bounded Federal Reserve sources: the reporting-forms overview pilot (two exact URLs) and the selected-detail pilot (five exact form URLs for recently updated forms). The detail pilot additionally admits only links labelled `Current` under `/apps/reportingforms/Download/`; historical downloads and other catalogue pages remain excluded. Current PDF and ZIP attachment content is compared alongside each landing page. ZIP bundles are read in memory only; archive member paths, entry counts, compression ratios, and uncompressed size are checked, and unsupported member types fail extraction rather than silently dropping content. Both sources use exact page allowlists; the detail pilot establishes a quiet baseline on its first successful scan. Newly configured sources may have no discovery metadata until their first scan; the CI validator allows that bootstrap state only when no prior inventory, report, history, checkpoint, or discovery ledger exists. The monitoring workflow runs every six hours and can also be started manually for an active configured source. Historical EBA configuration and discovery data remain in the repository for audit and recovery purposes but are inactive.

## Required secrets

- **OPENROUTER_API_KEY** enables AI analysis. Deterministic comparison and evidence collection can still run if AI is unavailable.
- **NTFY_TOPIC** is the optional destination for ntfy alerts. If it is not configured, notification candidates are retained in the notification outbox and can be delivered after a topic is configured.
- **HEALTHCHECK_PING_URL** (optional) is pinged after every successful scan. Point it at an external dead-man's-switch service (for example a healthchecks.io check with a 14-hour period) so you are alerted even when GitHub Actions cannot start jobs at all.
- **AI smoke test**: `.github/workflows/ai-smoke-test.yml` publishes a status for every pull request, but only calls the model when AI-relevant source/evaluator files change; documentation-only and unrelated PRs retain a successful workflow check without consuming provider calls. Relevant `main` pushes and manual dispatches also run the evaluation. The workflow validates the nine-field output contract and evaluates 15 historical parser-artifact cases plus 12 semantic-AI cases (6 relevant regulatory changes and 6 cosmetic/irrelevant changes). Each semantic-AI case runs twice; end-to-end accuracy, semantic-AI-only accuracy, and repeat verdict agreement must each be at least 80%, with zero decision-source mismatches. The JSON output reports actual provider model IDs per call so free-router selection changes are observable. Every fixture must declare its expected decision source. The free router remains the default; invalid/empty responses count as incorrect and unstable. Fork PRs skip the secret-dependent model job but still run normal CI. The workflow does not change monitoring state or send ntfy notifications.

## Workflow behavior

- **RegMonitor CI** tests code pushes to main and pull requests. Pushes affecting only monitoring data are intentionally excluded from CI.
- **Regulatory Monitor** runs every six hours or on manual dispatch. Post-run validation considers only active sources selected for that run; inactive historical metadata must not block an active run.
- A paused discovery source must have a valid, non-empty resumable checkpoint. The workflow queues continuation runs for every selected source that is paused.
- Monitoring state, snapshots, history, notification delivery state, and pending notifications are committed under the data directory.
- **Deploy Monitoring Console** publishes index.html, dashboard.js and the core JSON files (`dashboard-v2.html` now only redirects to the main page). Snapshot and evidence files are read from the repository's raw-content endpoints.
- **Monitor Freshness Check** runs every three hours and alerts (ntfy) when no scan has been saved for 14 hours.
- **RegMonitor CI** also runs the golden extraction corpus check and full persisted-state validation.

## Alert reliability

Every run queues its notification candidates in the durable outbox and commits the monitoring state **before** anything is sent; delivery happens only after that commit succeeds, and the delivery ledger is committed afterwards. If the state commit cannot be published, nothing has been sent and the next run re-detects the same events. The commit helper (`scripts/commit_state.sh`) rebases the data-only commit when `main` advanced with code-only commits, and refuses when another run committed `data/` in the meantime.

The ledger is saved after each successful delivery, so a cancelled or crashed job can re-send at most one message. Delivery is at-least-once: interruption after ntfy accepts a message but before the ledger commit can still cause a duplicate.

Persistent fetch or extraction errors alert once per episode (URL + error class + onset), not on every run; each observation still writes its own evidence. A failed workflow run sends a "Regulatory Monitor run failed" ntfy alert, and the **Monitor Freshness Check** workflow alerts when no scan has been saved for 14 hours (two missed six-hourly slots; GitHub routinely delays scheduled runs by an hour or more).

## Legacy canonical URL collisions

Run `python scripts/migrate_legacy_url_collisions.py --source eba-consumer-protection` for a read-only preflight. It groups inventory IDs using the current canonicalization rule and reports the survivor it would choose, whether normalized hashes/snapshots agree, and any reason a group is unsafe. The tool is dry-run by default.

Applying a migration requires an explicit source selection: `python scripts/migrate_legacy_url_collisions.py --source eba-consumer-protection --apply`. The tool only modifies `data/latest.json`, only for inactive sources, and only where every record has the same non-empty normalized hash and a valid text snapshot and there are no conflicting pending AI work items. It prefers a trusted baseline, then the exact configured URL spelling, then the most recently checked record, then a deterministic lexical tie-break. Duplicate change histories are merged into the survivor; immutable evidence, snapshots, historical reports, run history, and the notification ledger are left untouched. Conflicting baselines or missing snapshots are reported and skipped for manual review.

Do not reactivate either EBA source just to test this migration. Review the dry-run plan, apply one selected inactive source in a reviewed change, run state validation and CI, and verify the following scan does not emit a removal for the query-order duplicate.

## Safe monitor registration

The dashboard registration workflow is owner-only. Registration rejects credential-bearing URLs and obvious private/internal addresses, bounds each manually registered source to one exact URL, and validates CSS selectors. A duplicate URL with different CSS selectors is rejected rather than silently reusing the old configuration.

Redirect targets are checked and discovery redirects must stay within the current monitor scope. DNS preflight checks reduce SSRF risk but cannot fully prevent deliberate DNS rebinding; use outbound network egress controls for high-assurance deployments.

## Manual verification checklist

1. Require RegMonitor CI to pass before merging code changes.
2. Run AI Smoke Test after changing AI configuration and confirm it reports `smoke_test: passed`.
3. Verify a genuine changed-content run yields an AI status of `ok`, `invalid`, `error`, or `skipped` in the report counts before concluding the AI path is healthy.
4. Confirm the existing `fed-reporting-forms-pilot` remains complete and `fed-reporting-forms-detail-pilot` completes its landing-page plus current-attachment baseline. Verify historical links and non-allowlisted report pages are absent from the discovered inventory, then confirm the state commit and dashboard refresh. Check that ZIP attachments have `extraction_type=zip` with no extraction errors.
5. Configure NTFY_TOPIC and dispatch test_notification=true to verify delivery.
6. Keep regression coverage for transient delivery failures, confirming queued events persist and are retried.
7. Do not reactivate eba-full-site to clear stale metadata. Select and bound the intended source explicitly.
8. If a REMOVAL_HELD alert arrives, inspect the source first. Only when the pages were really retired, dispatch **Regulatory Monitor** with `source_id` and `allow_mass_removal` both set to that source ID.
9. After any prompt, model, evaluation fixture, or drift-guard change, require AI Smoke Test to pass the 80% end-to-end, 80% semantic-AI-only, and 80% repeated-verdict-agreement gates; confirm zero decision-source mismatches and that all 12 semantic-AI cases ran twice.
10. Dependencies are pinned exactly. To upgrade one, change `requirements.txt` in a PR; if the golden corpus check fails, either pin back or bump `CONTENT_EXTRACTOR_VERSION` deliberately.
