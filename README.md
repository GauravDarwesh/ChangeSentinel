# Regulatory Monitoring Crawler POC

Real regulator: European Banking Authority

Flow:

EBA -> Stealth Crawler -> URL manifest -> normalized change detection -> evidence -> relevance triage -> OpenRouter AI -> ntfy -> dashboard

This is a test POC, not a production compliance system.

## Monitoring

The monitoring workflow is currently manual (workflow_dispatch) so changes can be validated before scheduling.

The workflow is capped at 50 discovered URLs and stores:

- data/latest.json — current URL inventory
- data/report.json — latest monitoring report
- data/report.md — human-readable report
- data/snapshots/ — normalized page snapshots
- data/evidence/ — event evidence and diffs
- data/notifications.json — deterministic ntfy delivery ledger

## AI

Required GitHub Actions secret:

OPENROUTER_API_KEY

AI output is strictly validated to:

relevant, topic, summary, reason

## Notifications

The workflow publishes only validated relevant AI results, URL removals, and fetch-error alerts to ntfy.

Default topic:

RegMonitoringWebCrawlerNTFY

You can optionally override it with the GitHub Actions secret:

NTFY_TOPIC

The notifier keeps an event-ID ledger so the same deterministic event is not repeatedly published on subsequent runs.

## Dashboard

The GitHub Pages homepage is the live monitoring console in index.html.

The workflow prepares a GitHub Pages artifact containing the dashboard, monitoring report, URL inventory, notification ledger, and evidence files. The dashboard auto-refreshes every 15 seconds.

GitHub Pages must be configured to use GitHub Actions as the publishing source before the deployment job can publish the site. The dashboard deployment is isolated with continue-on-error so a Pages configuration issue cannot fail the monitoring job.

## Current validation state

The latest validated monitoring run discovered 16 URLs with 0 new, 0 changed, 0 removed, 16 unchanged, and 0 fetch errors.
