# Regulatory Monitoring Engine v2

## Pipeline

Source configuration -> discovery -> URL registry -> concurrent fetch -> content extraction -> normalization -> SHA-256 change detection -> evidence -> high-recall relevance -> structured AI analysis -> ntfy -> Git state -> GitHub Pages console.

The monitoring layer is deterministic. It emits NEW_URL, CHANGED_URL, UNCHANGED_URL, REMOVED_URL, FETCH_ERROR, EXTRACTION_ERROR, and BASELINE_MIGRATION. AI is downstream intelligence and cannot change the deterministic change classification.

## State

- data/latest.json: current URL inventory grouped by source.
- data/snapshots/<url_id>.txt: latest normalized snapshot.
- data/evidence/<event_id>.json: immutable event evidence and unified diff.
- data/reports/<source_id>.json: latest per-source report.
- data/history/index.json: compact run history.
- data/history/<run_id>.json: full run report.
- data/notifications.json: notification idempotency ledger.

## Scale

Fetching is concurrent and AI analysis uses bounded concurrency. Source definitions are configuration-driven. PDF, DOCX, XLSX, PPTX, CSV and text resources are extracted before comparison.

## AI

CHANGED_URL analysis receives the actual before/after unified diff. NEW_URL analysis receives the current normalized content. The model must return exactly nine fields: relevant, topic, change_type, summary, impact, effective_date, affected_scope, actions, reason.
