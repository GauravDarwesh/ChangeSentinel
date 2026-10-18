# Operations

The active production scope consists of two bounded Federal Reserve sources: the reporting-forms overview pilot (two exact URLs) and the selected-detail pilot (five exact form URLs for recently updated forms). The detail pilot additionally admits only links labelled `Current` under `/apps/reportingforms/Download/`; historical downloads and other catalogue pages remain excluded. Current PDF and ZIP attachment content is compared alongside each landing page. ZIP bundles are read in memory only; archive member paths, entry counts, compression ratios, and uncompressed size are checked, and unsupported member types fail extraction rather than silently dropping content. Both sources use exact page allowlists; the detail pilot establishes a quiet baseline on its first successful scan. Newly configured sources may have no discovery metadata until their first scan; the CI validator allows that bootstrap state only when no prior inventory, report, history, checkpoint, or discovery ledger exists. The monitoring workflow runs every six hours and can also be started manually for an active configured source. Historical EBA configuration and discovery data remain in the repository for audit and recovery purposes but are inactive.

## Required secrets

- **OPENROUTER_API_KEY** enables AI analysis. Deterministic comparison and evidence collection can still run if AI is unavailable.
- **NTFY_TOPIC** is the optional destination for ntfy alerts. If it is not configured, notification candidates are retained in the notification outbox and can be delivered after a topic is configured.
- **AI smoke test**: run `.github/workflows/ai-smoke-test.yml` manually to call the configured OpenRouter model with synthetic evidence and validate its nine-field output contract. This test does not change monitoring state or send ntfy notifications.

## Workflow behavior

- **RegMonitor CI** tests code pushes to main and pull requests. Pushes affecting only monitoring data are intentionally excluded from CI.
- **Regulatory Monitor** runs every six hours or on manual dispatch. Post-run validation considers only active sources selected for that run; inactive historical metadata must not block an active run.
- A paused discovery source must have a valid, non-empty resumable checkpoint. The workflow queues continuation runs for every selected source that is paused.
- Monitoring state, snapshots, history, notification delivery state, and pending notifications are committed under the data directory.
- **Deploy Monitoring Console** publishes index.html, dashboard-v2.html, and dashboard.js. The dashboard reads monitoring JSON from the repository's raw-content endpoints.

## Alert reliability

Notification events are persisted to an outbox before delivery. Successful deliveries are removed from the outbox and recorded in the notification ledger; failures remain queued for the next scheduled or manual run. Delivery is at-least-once: interruption after remote acceptance but before the state commit can cause a duplicate.

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
