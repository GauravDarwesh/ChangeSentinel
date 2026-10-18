# Operations

The active production source is the bounded Federal Reserve reporting-forms pilot, containing two exact URLs. The monitoring workflow runs every six hours and can also be started manually for an active configured source. Historical EBA configuration and discovery data remain in the repository for audit and recovery purposes but are inactive.

## Required secrets

- **OPENROUTER_API_KEY** enables AI analysis. Deterministic comparison and evidence collection can still run if AI is unavailable.
- **NTFY_TOPIC** is the optional destination for ntfy alerts. If it is not configured, notification candidates are retained in the notification outbox and can be delivered after a topic is configured.

## Workflow behavior

- **RegMonitor CI** tests code pushes to main and pull requests. Pushes affecting only data/** are intentionally excluded from CI.
- **Regulatory Monitor** runs every six hours or on manual dispatch. Post-run validation considers only active sources selected for that run; inactive historical metadata must not block an active run.
- A paused discovery source must have a valid, non-empty resumable checkpoint. The workflow queues continuation runs for every selected source that is paused.
- Monitoring state, snapshots, history, notification delivery state, and pending notifications are committed under data/.
- **Deploy Monitoring Console** publishes index.html, dashboard-v2.html, and dashboard.js. The dashboard reads monitoring JSON from the repository's raw-content endpoints.

## Alert reliability

Notification events are persisted to an outbox before delivery. Successful deliveries are removed from the outbox and recorded in the notification ledger; failures remain queued for the next scheduled or manual run. Delivery is at-least-once: interruption after remote acceptance but before the state commit can cause a duplicate.

## Safe monitor registration

The dashboard registration workflow is owner-only. Registration rejects credential-bearing URLs and obvious private/internal addresses, bounds each manually registered source to one exact URL, and validates CSS selectors. A duplicate URL with different CSS selectors is rejected rather than silently reusing the old configuration.

Redirect targets are checked and discovery redirects must stay within the current monitor scope. DNS preflight checks reduce SSRF risk but cannot fully prevent deliberate DNS rebinding; use outbound network egress controls for high-assurance deployments.

## Manual verification checklist

1. Require RegMonitor CI to pass before merging code changes.
2. Dispatch Regulatory Monitor for fed-reporting-forms-pilot; confirm the state commit and dashboard refresh.
3. Configure NTFY_TOPIC and dispatch test_notification=true to verify delivery.
4. Keep regression coverage for transient delivery failures, confirming queued events persist and are retried.
5. Do not reactivate eba-full-site to clear stale metadata. Select and bound the intended source explicitly.
