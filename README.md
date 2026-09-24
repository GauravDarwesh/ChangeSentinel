# Regulatory Monitoring Engine

A continuously running regulatory monitoring pipeline with the European Banking Authority as the first live source.

## Current monitoring scope

The active EBA source starts at the EBA homepage and discovers same-host public links across the site. The homepage exposes major sections including Activities, Risk and data analysis, Publications and media, the Interactive Single Rulebook, consultations, news and events. The crawler follows internal links from the homepage rather than a hand-maintained list. citeturn949757search0turn516358search0

The full-site source uses uncapped discovery (max_urls: 0). Direct HTTP link discovery is the reliable primary path; stealth-crawler remains available as a browser fallback. The monitor job has a 120-minute operational guardrail.

Login/user and site-search paths are excluded to avoid crawling authentication or search utility surfaces. Linked regulatory documents remain eligible for content extraction and monitoring.

## End-to-end flow

Homepage -> resilient URL discovery -> canonicalization -> concurrent fetch -> HTML/PDF/DOCX/XLSX/PPTX/CSV/text extraction -> deterministic normalization -> normalized SHA-256 -> N vs N-1 event detection -> immutable evidence/diff -> high-recall relevance -> structured AI analysis -> ntfy -> historical state -> live console.

The technical change detector is deterministic. AI interprets evidence after the technical event has been created.

## First full crawl

The first full-site crawl is configured as a silent baseline. It builds the complete current inventory and snapshots without generating AI analysis or notification noise for every discovered page. Subsequent six-hour runs compare against that baseline and process actual changes.

## Automation

The monitoring workflow runs every six hours (cron: 0 */6 * * *).

It can also be started manually with source selection and a controlled notification test. Discovery first walks reachable HTML links over HTTP; if that path cannot establish a usable inventory, the configured stealth-crawler browser path is attempted. A concurrency lock prevents overlapping state writers.

The workflow runs tests, compiles the engine, checks EBA reachability, performs the crawl, publishes idempotent notifications, and commits monitoring state.

## AI

Required GitHub Actions secret: OPENROUTER_API_KEY

The AI contract is strictly nine fields:
relevant, topic, change_type, summary, impact, effective_date, affected_scope, actions, reason

CHANGED_URL analysis receives the actual before/after diff. NEW_URL analysis receives normalized current content.

AI execution is bounded to four concurrent requests with a per-run candidate ceiling to avoid uncontrolled provider load.

## State

- data/latest.json: current active source inventory
- data/reports/: latest per-source reports
- data/report.json: aggregate latest report
- data/report.md: human-readable report
- data/snapshots/: latest normalized page snapshots
- data/evidence/: immutable event evidence and diffs
- data/history/: compact index plus full per-run reports
- data/notifications.json: notification idempotency ledger

## Dashboard

GitHub Pages publishes the dependency-free operations console in index.html. It reads live state from main and refreshes periodically.

## Validation

Local/CI checks:

python -m unittest discover -s tests -p "test*.py"
python -m compileall -q regmon
