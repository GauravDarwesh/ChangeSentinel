# Regulatory Monitoring Engine v2

## Pipeline

Source configuration -> resilient discovery -> URL registry -> concurrent fetch -> content extraction -> normalization -> SHA-256 change detection -> immutable evidence -> high-recall relevance -> structured AI analysis -> durable notification outbox -> ntfy -> Git state -> GitHub Pages console.

The monitoring layer is deterministic. It emits NEW_URL, CHANGED_URL, UNCHANGED_URL, REMOVED_URL, FETCH_ERROR, EXTRACTION_ERROR, and BASELINE_MIGRATION. AI is downstream intelligence and cannot change the deterministic change classification. Evidence writes are append-only; repeated operational observations have observation-specific event IDs so later failures do not overwrite evidence referenced by earlier reports.

## State

- data/latest.json: current URL inventory grouped by source.
- data/snapshots/<url_id>-<content_hash>.txt: immutable normalized-text snapshots.
- data/snapshots/html/: immutable complete fetched HTML response snapshots.
- data/evidence/<event_id>.json: event evidence and unified diffs; existing files are not overwritten.
- data/reports/<source_id>.json: latest per-source report.
- data/history/index.json: compact run history.
- data/history/<run_id>.json: full historical run report.
- data/notifications.json: notification idempotency ledger for delivered events.
- data/notification-outbox.json: durable pending notification events awaiting delivery.
- data/discovery/: source metadata, sharded inventories, checkpoints, and failure ledgers.

## Scale and safety

HTTP discovery resolves relative and absolute links with bounded concurrency; browser discovery remains an optional fallback. Fetching is concurrent and AI analysis uses bounded concurrency. Exact URL allowlists are part of the discovery checkpoint fingerprint, and recovered checkpoint inventories are filtered through the current source scope. Redirects are bounded and checked for internal/private destinations; DNS preflight reduces SSRF risk but is not a complete defense against DNS rebinding.

PDF, DOCX, XLSX, PPTX, CSV, JSON, XML, and text resources are normalized before comparison. Previous trusted baselines are preserved when discovery is incomplete.

## AI

CHANGED_URL analysis receives the actual before/after unified diff. NEW_URL analysis receives the current normalized content. The model must return exactly nine fields: relevant, topic, change_type, summary, impact, effective_date, affected_scope, actions, reason. AI is downstream to technical detection, and notification delivery failures do not discard generated alerts.
