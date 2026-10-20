# Regulatory Monitoring Engine v2

## Pipeline

Source configuration -> resilient discovery -> URL registry -> concurrent fetch -> content extraction -> normalization -> SHA-256 change detection -> immutable evidence -> high-recall relevance -> structured AI analysis -> durable notification outbox -> ntfy -> Git state -> GitHub Pages console.

The monitoring layer is deterministic. It emits NEW_URL, CHANGED_URL, HTML_SOURCE_CHANGED, UNCHANGED_URL, REMOVED_URL, FETCH_ERROR, EXTRACTION_ERROR, and BASELINE_MIGRATION. A CHANGED_URL requires a changed source: when the raw bytes (or, for HTML, the comparison signature that ignores Cloudflare's rotating tokens) are unchanged, a text difference is recorded as BASELINE_MIGRATION with `migration_reason` `extractor_version` or `extraction_drift`. An empty "complete" discovery is treated as FAILED, and a mass removal is held for confirmation. AI is downstream intelligence and cannot change the deterministic change classification. Evidence writes are append-only; repeated operational observations have observation-specific event IDs so later failures do not overwrite evidence referenced by earlier reports.

## State

- data/latest.json: current URL inventory grouped by source; each record keeps a bounded `change_history` (newest first, with any AI verdict) and `last_changed_at`.
- data/snapshots/<url_id>-<content_hash>.txt: immutable normalized-text snapshots.
- data/snapshots/html/: immutable complete fetched HTML response snapshots. A new file is written only when the HTML comparison signature changes.
- data/evidence/<event_id>.json: event evidence and unified diffs; existing files are not overwritten.
- data/reports/<source_id>.json: latest per-source report. data/report.json combines the latest report of every active source (`source_runs` names each one's run).
- data/history/index.json: compact run history, the newest `history_runs` entries per source.
- data/history/<run_id>.json: full historical run report.
- data/notifications.json: notification idempotency ledger for delivered events.
- data/notification-outbox.json: durable pending notification events awaiting delivery.
- data/discovery/: source metadata, sharded inventories, checkpoints, and failure ledgers.

## Scale and safety

HTTP discovery resolves relative and absolute links with bounded concurrency; browser discovery remains an optional fallback. Fetching is concurrent and AI analysis uses bounded concurrency. Exact URL allowlists are part of the discovery checkpoint fingerprint, and recovered checkpoint inventories are filtered through the current source scope. Redirects are bounded and checked for internal/private destinations; DNS preflight reduces SSRF risk but is not a complete defense against DNS rebinding.

PDF, DOCX, XLSX, PPTX, CSV, JSON, XML, and text resources are normalized before comparison. Previous trusted baselines are preserved when discovery is incomplete.

## Quality gates

- `scripts/golden_corpus_check.py` (CI) re-extracts every saved original produced by the current extractor version and fails if its text no longer reproduces the baseline. Hash-scoped quality sentinels also check minimum text coverage and critical form/instruction markers on three known difficult, table-heavy PDFs; repeating a truncated baseline does not by itself count as fidelity.
- `python -m regmon.validate_state` checks discovery metadata, inventory/report/ledger/outbox integrity and every snapshot/evidence pointer; the monitor runs it before committing state.
- `scripts/ai_eval.py` (AI Smoke Test workflow) scores the full decision pipeline on 15 historical parser-artifact diffs and 12 model-routed cases split evenly between relevant regulatory changes and cosmetic/irrelevant changes. Every model-routed case runs twice; release gates require at least 80% end-to-end accuracy, 80% semantic-AI-only accuracy, and 80% per-case repeat verdict agreement, plus zero decision-source mismatches. The workflow retries transient/invalid provider responses, reports the actual provider model ID per call to expose router variance, and keeps `openrouter/free` as the default. The workflow publishes a stable status on every PR, but invokes the provider only when AI-relevant files change.

## AI

CHANGED_URL analysis receives the actual before/after unified diff; work resumed from the backlog is diffed against the snapshot from before the change. NEW_URL analysis receives the current normalized content. The model must return exactly nine fields: relevant, topic, change_type, summary, impact, effective_date, affected_scope, actions, reason. AI is downstream to technical detection, and notification delivery failures do not discard generated alerts. When AI completes after a generic "Technical change detected" alert was delivered, an AI_ASSESSMENT follow-up is sent.
