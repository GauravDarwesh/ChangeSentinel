# Regulatory Monitoring Engine

A scalable regulatory monitoring pipeline using the European Banking Authority as the first live source.

## End-to-end flow

Source configuration
-> URL discovery and canonicalization
-> concurrent HTTP fetching
-> HTML/PDF/DOCX/XLSX/PPTX/CSV/text extraction
-> deterministic normalization
-> normalized SHA-256 comparison
-> NEW / CHANGED / UNCHANGED / REMOVED / FETCH_ERROR / EXTRACTION_ERROR
-> immutable evidence and unified diff
-> high-recall relevance triage
-> structured OpenRouter analysis
-> ntfy notifications
-> Git state
-> GitHub Pages operations console

AI is downstream intelligence. It does not determine whether a page technically changed.

## Current source

The first configured source is EBA Consumer Protection. The source definition lives in config/sources.json, so additional regulators can be added without rewriting the orchestration layer.

The EBA scope is configured at 250 discovered URLs per source.

## State

- data/latest.json: current inventory grouped by source
- data/reports/: latest per-source reports
- data/report.json: aggregate latest report
- data/report.md: aggregate human-readable report
- data/snapshots/: latest normalized snapshots
- data/evidence/: immutable event evidence and diffs
- data/history/: run history
- data/notifications.json: notification idempotency ledger

## AI

Required GitHub Actions secret: OPENROUTER_API_KEY

The strict nine-field contract is:
relevant, topic, change_type, summary, impact, effective_date, affected_scope, actions, reason

Changed pages send the actual before/after unified diff to the model. New URLs send their normalized content.

## Notifications

Default ntfy topic: RegMonitoringWebCrawlerNTFY

Optional secret: NTFY_TOPIC

The manual workflow includes a controlled delivery-test switch that does not modify the monitoring baseline.

## Automation

The monitoring workflow runs every six hours and supports manual source selection. A concurrency lock prevents overlapping state writers.

GitHub Pages uses a dedicated deployment workflow and the dashboard reads state from the main branch.

## Validation

Run locally:

python -m unittest discover -s tests -p "test*.py"
python -m compileall -q regmon
