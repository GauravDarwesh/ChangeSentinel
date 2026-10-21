# ChangeSentinel - Intelligent Web Crawler

A configuration-driven web monitoring system that discovers public web pages, fetches their content, detects changes, uses AI to explain meaningful changes, sends notifications, and keeps a searchable monitoring history.

The active monitoring scope has two bounded Federal Reserve sources: a two-page reporting-forms overview pilot and a five-page selected-detail pilot based on recent form updates. For those five detail pages, the second pilot also follows only links labelled "Current" under the Federal Reserve reporting-forms download route, so the monitor compares their current forms/instructions as well as the landing-page text. The previous EBA configurations and historical monitoring data are retained but inactive.

[![RegMonitor CI](https://github.com/GauravDarwesh/ChangeSentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/GauravDarwesh/ChangeSentinel/actions/workflows/ci.yml)
[![Regulatory Monitor](https://github.com/GauravDarwesh/ChangeSentinel/actions/workflows/regulatory-monitor.yml/badge.svg)](https://github.com/GauravDarwesh/ChangeSentinel/actions/workflows/regulatory-monitor.yml)

**Live operations dashboard:**  
https://gauravdarwesh.github.io/ChangeSentinel/

---

## What this project does

Imagine you have a regulator, government agency, standards body, or other public website that you need to watch continuously.

Instead of manually checking hundreds or thousands of pages, this project turns that into a repeatable pipeline:

**Start URL → Discover links → Fetch pages → Extract content → Normalize → Compare with the previous run → Detect changes → Filter likely relevant changes → Ask AI to interpret them → Notify the team → Store the evidence and history → Show the results in a dashboard**

The important design decision is that **AI does not decide whether something technically changed**.

The crawler and deterministic SHA-256 comparison establish the fact that content changed. AI is used afterwards to explain what the change means.

---

## Why it exists

Websites change constantly:

- new publications appear
- existing pages are amended
- consultation deadlines change
- guidance is updated
- documents are replaced
- pages disappear or move
- navigation and cosmetic elements change without the underlying regulatory content changing

A useful monitoring system therefore needs to distinguish between:

1. **A technical change** — something in the monitored content changed.
2. **A meaningful change** — the change appears relevant to the monitoring objective.

This project separates those two jobs.

---

# How the system works

## 1. Source configuration

The monitoring scope lives in:

`config/sources.json`

Each source can define:

- starting URL(s)
- allowed domains
- allowed URL prefixes
- excluded URL prefixes
- crawler settings
- discovery limits
- fetch settings
- AI limits

The core reporting-forms pilot is deliberately limited to these two overview pages:

- https://www.federalreserve.gov/apps/reportingforms/review
- https://www.federalreserve.gov/apps/reportingforms/recentupdates

A separate selected-detail pilot adds only these five form pages that the Federal Reserve's recent-updates page identifies as recently updated:

- https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-9C
- https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2028bs
- https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2028D
- https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14M
- https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-14Q

The detail pilot's landing pages remain restricted to the five exact URLs above. Only their links whose visible text begins with "Current" are admitted from the separate `/apps/reportingforms/Download/` path; historical downloads and links to other form pages are excluded. Current PDFs and ZIP bundles can therefore be compared without crawling the full catalogue. Its first successful run establishes a quiet baseline rather than treating these pre-existing pages and documents as changes. The previous EBA full-site scope and seven-page pilot are inactive; their saved inventory and history are retained.

Adding another monitored source is intended to be a configuration task rather than a rewrite of the monitoring engine.

---

## 2. URL discovery

The discovery layer is implemented in:

`regmon/discovery.py`

The current system uses two discovery paths.

### Primary: direct HTTP discovery

The crawler fetches HTML pages and extracts links using:

- `requests`
- `BeautifulSoup`
- `urljoin`
- URL canonicalization
- bounded concurrency

It recursively follows reachable in-scope links.

This path is fast and predictable for normal public HTML sites.

### Fallback: stealth-crawler

`stealth-crawler` uses a headless browser and is retained for sites where browser-rendered navigation is necessary.

The project originally depended on this path alone. The production flow now attempts the direct HTTP route first so a browser failure does not automatically kill the monitoring run.

### What gets discovered?

The discovery layer records URLs, not just HTML pages.

For example, a discovered PDF URL is kept in the inventory so the later fetch/extraction stages can process it.

---

## 3. URL canonicalization and scope filtering

Before URLs are stored, `regmon/discovery.py` normalizes them.

Canonicalization currently:

- removes fragments such as `#section`
- normalizes scheme and host casing
- removes trailing slashes where appropriate
- removes common tracking parameters such as `utm_*`, `fbclid`, and `gclid`
- preserves semantic query parameters
- sorts query parameters for stable identity

The scope filter then makes sure a URL:

- belongs to an allowed domain
- matches an allowed prefix
- does not match an excluded path

This prevents the crawler from wandering onto unrelated websites or utility areas such as login/search surfaces.

---

## 4. Fetching

`regmon/fetch.py` is responsible for retrieving individual resources.

It handles:

- HTTP requests
- timeouts
- retries
- retry backoff
- HTTP error handling
- response metadata
- raw SHA-256 hashing

The fetch layer records metadata such as:

- HTTP status
- content type
- content length
- ETag
- Last-Modified
- raw content hash

The fetch layer is intentionally separate from discovery. Discovering a URL and monitoring its content are two different jobs.

---

## 5. Content extraction

JSON responses are parsed and serialized with stable, sorted object keys before comparison, so property-order-only changes do not trigger alerts. XML responses are canonicalized and deterministically formatted before comparison, reducing noise from attribute ordering and indentation while preserving meaningful element and value changes.

`regmon/content.py` converts different resource types into normalized text.

Currently supported:

- HTML, including per-source CSS inclusion and ignore selectors
- JSON with stable object-key ordering
- XML with canonicalized formatting
- PDF
- DOCX
- XLSX
- PPTX
- CSV
- plain text
- ZIP bundles containing supported PDF, Office Open XML, CSV, JSON, XML, and text files (validated in memory with member-count, path, and uncompressed-size limits)

ZIP members are never extracted to the filesystem. Unsupported or unsafe archive contents become explicit extraction errors, preserving the prior trusted baseline instead of silently comparing partial content.

### Adaptive PDF extraction

PDFs use a fast-first cascade so ordinary text-layer documents do not pay the cost of a layout model on every scan:

1. **Native text first:** pypdf extracts ordinary text-layer PDFs, with conservative joining of wrapped lines and split words.
2. **Ruled-grid reconstruction (`regmon/pdf_grid.py`):** pages whose native text looks fragmented, or that hold dot-leader line items next to item codes, are rebuilt from the table's drawn ruling lines. Every cell and its row/column span comes from the lines; each character is assigned to the cell containing its centre, and sideways (rotated) header text is read in its own direction. Three layouts are rendered:
   - **Fill-in report forms** (a header row of item codes such as `QTFL 1596`, a row of column numbers, blank entry rows): one row per reported item — `No. | Section | Field | Options | Item code | Entry` — with rotated option labels listed under their item and blank entry rows counted.
   - **Line-item schedules** (labels with dot leaders outside the boxes, codes in boxes, line numbers on the right, as in FR Y-9C): `Item | Line item | <box columns>`, with wrapped labels joined, notes and headings kept as their own rows, code prefixes combined (`BHDM 1420`) and codes printed above their entry box paired with that box's label.
   - **Ordinary tables:** rows under combined multi-level header labels.
   Prose around the tables is read in column order (recursive XY-cut), including text beside a narrow table. A rebuilt page is used only when it keeps at least 90% of the page's words; otherwise the next step applies. When any page is rebuilt, the document's tables are exact, so Docling is not run.
3. **Layout/table fallback:** remaining fragmented pages are reprocessed with pdfplumber's ruled-table and alignment-based table detection.
4. **Docling for difficult layouts without ruled tables:** when a PDF has fragmented page text and no ruled grid, the full document is offered to Docling's accurate table-structure pipeline. Docling output replaces the existing candidate only when it contains structured Markdown tables and passes a conservative text-quality comparison. Conversion must report success and preserve the expected page count; partial results are rejected. The inventory records whether a PDF used Docling or the established fallback; if model availability changes while the original bytes stay identical, that parser-profile transition is recorded as a baseline migration rather than a regulatory change. ZIP bundles fingerprint the extraction profile of each supported member, so a fallback/Docling switch in one PDF inside an archive cannot be hidden by the aggregate profile of its other files. Converter initialization and inference are serialized to limit concurrent model memory on GitHub-hosted runners.
5. **OCR only when needed:** pages with little extractable text and visual content are rendered by PDFium and passed to Tesseract. Docling's OCR is disabled in this path so the existing selective OCR fallback remains responsible for scanned pages.
6. **Fail safely:** password-protected PDFs, unusable scans, OCR failures, Docling failures, and oversized OCR workloads do not replace the trusted normalized snapshot with missing or partial text.

Docling is pinned and its model artifacts are cached by the scheduled GitHub Actions workflow. The converter has a 120-second per-document timeout, constrained CPU concurrency, and a 100-page limit. These settings reduce risk but do not guarantee correct interpretation of every complex form; representative real-document regression tests remain necessary.

The OCR fallback is capped at 1,000 image/low-text pages per PDF, 15 seconds per page, and 120 seconds total per PDF by default. These guardrails prevent one unusually large scan from consuming the entire scheduled-run budget; they can be raised for a known workload. OCR is best-effort and cannot guarantee perfect recovery from handwriting, damaged files, very low-resolution scans, or every unusual PDF structure.

HTML extraction is block-aware: inline elements no longer introduce artificial sentence breaks, and HTML tables are serialized with their row and column boundaries. The dashboard also renders extracted Markdown tables as actual tables.

The normalized output for HTML, PDF, and ZIP resources carries an extractor version. During the first successful run after this upgrade, if the original response bytes are unchanged, the engine records a baseline migration instead of a regulatory change. Real source-byte changes continue through the normal change detector. This prevents extraction improvements from generating false change alerts.

The monitor preserves the complete fetched HTML response body as an immutable `.html` snapshot, while separately extracting normalized text for regulatory-content comparison. The dashboard can render the stored HTML response, show its source code, and display a formatted HTML source diff alongside an extracted-text diff.

For text comparison, the extractor removes common non-content material such as:

- scripts
- styles
- navigation
- footer content
- hidden elements
- common cookie/share/popup/banner containers

It then selects the most useful main-content region when one is available.

This matters because a website can change its navigation, footer, cookie banner, or other dynamic markup without changing the regulatory material that people actually care about.

---

## 6. Normalization

Extracted content is normalized before comparison.

Normalization removes irrelevant formatting differences such as:

- repeated whitespace
- empty lines
- Unicode representation differences
- surrounding page structure that was intentionally excluded

The result is the text that the change detector actually compares.

---

## 7. Deterministic change detection

`regmon/change.py` handles technical change classification.

The primary identity is a SHA-256 hash of normalized content.

The comparison is therefore:

**previous normalized hash vs current normalized hash**

If extracted text stays the same but the stable HTML comparison signature changes, the monitor records an `HTML_SOURCE_CHANGED` event. The signature normalizes Cloudflare's rotating JavaScript-detection Ray ID and timestamp fields, which are request metadata rather than page content. The raw HTML body and raw hash are still preserved for audit evidence. Other markup-only changes remain visible in the dashboard but are not sent to AI or notifications by default.

Possible technical events include:

| Event | Meaning |
| --- | --- |
| `NEW_URL` | URL is newly discovered |
| `CHANGED_URL` | Normalized content changed |
| `HTML_SOURCE_CHANGED` | HTML response markup changed while extracted text stayed the same |
| `UNCHANGED_URL` | Normalized content is unchanged |
| `REMOVED_URL` | Previously monitored URL is no longer discovered. If more than half of a source (at least 3 URLs) disappears in one run, the removals are held and one `REMOVAL_HELD` alert is sent instead; confirm with `REGMON_ALLOW_MASS_REMOVAL=<source id>`. With browser-only discovery, a URL must also be missing from two consecutive complete crawls before it is reported removed |
| `FETCH_ERROR` | URL could not be fetched successfully |
| `EXTRACTION_ERROR` | Resource was fetched but could not be converted into usable text |
| `BASELINE_MIGRATION` | Extracted text changed but the source did not (`migration_reason`: `extractor_version` after a parser upgrade, `extraction_drift` when identical bytes extract differently). Never alerted, never sent to AI |

The change detector is deterministic. AI is not involved in this decision.

---

## 8. Evidence and diffs

When a meaningful technical event occurs, the project stores evidence under:

`data/evidence/`

For changes, evidence includes a unified extracted-text diff and a formatted HTML source diff. HTML snapshots use content-addressed paths, so later runs do not overwrite older snapshots referenced by evidence.

This gives the monitoring result an audit trail instead of only saying:

> "Something changed."

The system can instead preserve:

- what URL changed
- what hashes were involved
- what the previous snapshot was
- what the current snapshot is
- what the textual diff looks like

---

## 9. Relevance triage

`regmon/relevance.py` performs a high-recall first pass.

The goal here is **not** to make the final semantic decision.

It looks for:

- regulatory keywords
- regulatory URL patterns
- document resources
- obvious utility pages

The philosophy is intentionally conservative:

> It is better to send a plausible regulatory candidate to the AI layer than to silently discard a potentially important change too early.

---

## 10. AI analysis

`regmon/ai.py` is the interpretation layer.

The AI receives the evidence for a detected change and must return exactly nine fields:

1. `relevant`
2. `topic`
3. `change_type`
4. `summary`
5. `impact`
6. `effective_date`
7. `affected_scope`
8. `actions`
9. `reason`

The prompt also instructs the model to use only the supplied evidence and to use `Not stated` when the evidence does not establish a value.

### What AI does

AI answers questions such as:

- Is this change actually relevant?
- What changed?
- What topic does it concern?
- What impact might it have?
- Is there an effective date?
- Who is affected?
- What action may need to be considered?

### What AI does not do

AI is **not** the technical change detector.

If a page changed, the deterministic layer records that first.

---

## 11. Notifications

`regmon/notify.py` sends notifications through [ntfy](https://ntfy.sh/).

Notifications are generated for:

- AI-confirmed relevant changes
- removed monitored URLs
- fetch errors
- extraction errors

The notification state is stored in:

`data/notifications.json`

Each event has an ID, allowing the notifier to avoid sending the same event repeatedly.

---

## 12. Persistence and monitoring history

Runtime state is stored under:

`data/`

The important files are:

| Path | Purpose |
| --- | --- |
| `data/latest.json` | Current monitored URL inventory |
| `data/report.json` | Latest aggregate report |
| `data/report.md` | Human-readable latest report |
| `data/reports/` | Per-source reports |
| `data/snapshots/` | Immutable content-addressed normalized-text snapshots and full HTML response snapshots under `html/` |
| `data/evidence/` | Immutable event evidence and diffs |
| `data/history/index.json` | Compact run history |
| `data/history/<run_id>.json` | Full historical run report |
| `data/notifications.json` | Notification idempotency state |
| `data/notification-outbox.json` | Durable queue for notifications not yet delivered |
| `data/stealth-output.txt` | Browser crawler diagnostics |

The monitoring workflow commits this state back to the repository so each run leaves a Git-backed record.

---

# GitHub Actions automation

The project is designed to run without a permanently running server.

There are four main workflows: CI, scheduled monitoring, AI integration testing, and dashboard deployment.

## `RegMonitor CI`

File:

`.github/workflows/ci.yml`

Runs on pushes and pull requests.

It checks:

- dependency installation
- unit/regression tests
- Python compilation
- dashboard JavaScript syntax

This is the safety net for code changes.

## `Regulatory Monitor`

File:

`.github/workflows/regulatory-monitor.yml`

This is the actual monitoring pipeline.

It:

1. checks out the current `main` (without persisting the write token)
2. installs the exactly pinned dependencies
3. checks reachability of the selected active source's seed URLs
4. discovers the monitored site within its configured allowlist
5. fetches resources and extracts normalized content
6. compares the content with the previous baseline (identical source bytes can only produce a quiet `BASELINE_MIGRATION`)
7. runs structured AI analysis for new/substantively changed candidates (when configured)
8. writes reports, evidence and the per-URL change timeline
9. validates all persisted state and queues notifications in the durable outbox
10. commits the monitoring state (`scripts/commit_state.sh`)
11. only then delivers notifications, and commits the delivery ledger
12. sends an ntfy alert if any step failed, and pings the optional heartbeat URL on success

Tests and compilation run in **RegMonitor CI**, not in the monitoring workflow.

### Schedule

The default schedule is every six hours:

`0 */6 * * *`

The workflow also supports manual execution.

## `AI Smoke Test`

File:

`.github/workflows/ai-smoke-test.yml`

This manual, non-mutating workflow calls the configured OpenRouter model using a synthetic example and checks the same strict nine-field JSON contract used by the monitor. It does not crawl the regulator, change the baseline, write monitoring data, or send ntfy messages. It fails clearly if `OPENROUTER_API_KEY` is missing, the provider fails, or the model response is not valid against the schema.

Use it after changing the AI provider/model or when you need to verify that AI interpretation is working independently of whether a real regulatory change happened. Set the repository secret `OPENROUTER_API_KEY` first.

## `Scout` and `Scout Review Decision`

Files:

`.github/workflows/scout.yml` and `.github/workflows/scout-review.yml`

`Scout` runs every Monday at 04:17 UTC (and on manual dispatch, for all regulators or a comma-separated list). It reads the discovery channels in `config/scout.json`, validates its state and commits only `data/scout/`. `Scout Review Decision` processes the owner's "Not relevant" / "Restore" requests from the dashboard, and `Scout Source Request` (`.github/workflows/scout-source.yml`) applies "Add a source" / "Edit details" requests to `config/scout.json`. None of them touches monitoring configuration or monitoring state. See [Scout](#scout-finding-new-regulator-pages) below.

## `Deploy Monitoring Console`

File:

`.github/workflows/pages.yml`

Publishes `index.html`, `dashboard-v2.html`, `dashboard.js` and `dashboard-lib.js` to GitHub Pages when the dashboard code changes, or when manually dispatched. Monitoring JSON is fetched from the repository at runtime, so data-only monitoring commits update the dashboard without requiring a static-site rebuild.

---

# First run vs later runs

The first run is special.

The active Federal Reserve reporting-forms source is configured with:

`baseline_on_first_run: true`

That means the first successful Federal Reserve inventory establishes the baseline.

The purpose is to avoid generating hundreds or thousands of "new page" notifications simply because the system has never seen the site before.

After the baseline exists:

**Run N** is compared with **Run N-1**.

That is when actual changes become interesting.

---

# Dashboard

The repository includes a dependency-free review workspace (`index.html`, `dashboard.js`, `dashboard-lib.js`), published by GitHub Pages. It has no build step.

The layout is three panes: a rail on the left (Overview, Changes, Pages, Runs, Alerts, then Scout and Ask Sentinel set apart by a rule), a list, and the selected item. The page itself never scrolls; each pane scrolls on its own. On phones the rail becomes a bottom bar and the list and detail are separate screens. A dark theme is the default, with a light theme one click away.

- **Overview** opens with a one-sentence status, the next-scan countdown, and the **LED change field**: one row per monitored page, one cell per six-hour scan over the last few days. Amber cells are scans that found a change, red cells hit a problem, dim cells were checked with no change, and the outlined column is the scan in progress. Hover a cell for the page and scan; click to open the page.
- **Changes** lists every change across runs, newest first, and opens the newest one straight away. Each change shows the AI assessment and a **redline** of the extracted text: deleted words struck through, inserted words underlined, edits within a line marked word by word, and unchanged stretches collapsed. Text and HTML diffs are one click away.
- **Pages** shows each monitored page with its change history, the saved copy (rendered HTML or the original PDF), the extracted text, the fetched HTML source, and its fingerprints.
- **Runs** and **Alerts** show scan results and the notification outbox and delivery ledger.
- **Scout** lists new regulator pages that are not monitored yet, each with the evidence and signals behind Scout's judgement, plus the last sweep's coverage. See [Scout](#scout-finding-new-regulator-pages).

`dashboard-lib.js` holds the pure logic (redline, scan schedule, LED cell states, wording); `tests/test_dashboard_lib.py` runs it through Node.

Live dashboard:

https://gauravdarwesh.github.io/ChangeSentinel/

---

The dashboard now provides an **Add a monitor** flow. It creates a prefilled GitHub issue rather than writing repository credentials into the browser. After the repository owner submits the request, the `Register Dashboard Monitor` workflow validates the public URL, adds a one-page bounded source to `config/sources.json`, commits the configuration, and dispatches the first scan. The dashboard then reads the new source from the shared configuration and displays its stored inventory once the scan has committed.

# Scout: finding new regulator pages

The monitor watches pages that are already configured. **Scout** answers a different question: *what has a regulator published that ChangeSentinel is not monitoring yet?* Finding a URL, judging whether it looks relevant and registering it for monitoring are three separate decisions; Scout only does the first two, and a person makes the third.

**Where it looks.** Each regulator has a profile in `config/scout.json` that declares its channels: RSS/Atom/RDF feeds, XML site maps (including indexes and gzip) and listing pages (paginated, newest first). Scout never starts at a home page and crawls everything. The pilot covers all four regions: Federal Reserve and OSFI (NAM), EBA and the Bank of England's PRA (EMEA), APRA (APAC) and Banco de México (LATAM). Adding a regulator is a configuration change, never a new crawler.

**How it behaves on the wire.** One polite client per regulator: robots.txt is read per host (RFC 9309 wildcards, and `Crawl-delay` honoured in full; an unreachable robots.txt means *do not crawl*), requests are paced (at least 3 seconds apart), every destination and redirect must be a public address on the regulator's declared hosts, responses are size-capped, XML with entity declarations is refused, and each regulator has a request and time budget. A 429/503 with a long `Retry-After` (seconds or HTTP-date) defers the channel instead of hammering it.

**New versus baseline.** The first successful read of a channel is a quiet *baseline*: what the regulator already publishes is recorded, not announced. Afterwards a URL is *new* when a channel that already had a baseline shows it for the first time. Listings are read newest first until Scout reaches items it has already seen. URLs that ChangeSentinel already monitors (from `config/sources.json` and `data/latest.json`) are recognised and kept out of the review list. "First seen" is when Scout noticed a URL, not proof of when it was published.

**Judging relevance.** Deterministic, explainable rules map titles, link text, listing text, feed categories, page metadata and addresses onto publication types (rule, consultation, guidance, technical standard, reporting form, supervisory letter, Q&A, enforcement, decision) and topics (capital, liquidity, reporting, AML, payments, resilience, …), with a few curated path hints per regulator. Each finding gets one of three outcomes with a confidence band and the signals behind it:

- **Looks relevant** - positive evidence for a publication type or topic the objective covers;
- **Unsure** - thin or conflicting evidence (for example a PDF known only by its file name);
- **Not relevant** - explicit evidence of exclusion: a site utility page, or a type the objective leaves out (research, statistics, events, jobs) with no regulatory signal pointing the other way.

Missing evidence is never treated as irrelevance. For new web pages with no title, Scout reads the page once (robots permitting) for its title, heading and metadata. AI is not used: the rules are reproducible and free, and the review step catches what they miss.

**Coverage, honestly.** Every sweep records a ledger per regulator and channel: `COMPLETE` (every declared channel read as planned), `PARTIAL` (a budget or window limit stopped a channel before it caught up, or a feed may have rolled past items), `DEGRADED` (a required channel failed), `BLOCKED` (robots.txt or the server refused every required channel) or `FAILED`. Each profile lists its known gaps. Complete never means "every page on the site was seen".

**Reviewing in the dashboard.** The **Scout** view sits in the rail between Alerts and Ask Sentinel. *To review* lists new findings; *Backlog* lists relevant pages that were already published when Scout started; *Set aside* keeps Scout's own exclusions so its judgement can be checked; *Decided* holds dismissed and now-monitored pages. **Monitor this page** opens the existing add-a-page dialog with the address filled in (the owner-only registration workflow does the rest). **Not relevant** and **Restore** open a prefilled issue that the owner-only `Scout Review Decision` workflow records in `data/scout/decisions.json`; a decision applies to that one address, never to a path or topic. **Coverage** shows the last sweep's ledger and each regulator's gaps.

**Adding sources and tuning metadata.** *Sources* in the Scout view lists every regulator with its channels and what its profile configures. **Add a source** creates a regulator profile (name, short name, region, jurisdiction) with its first channel, or adds a channel to an existing regulator: a feed, a site map, or any listing page (a "what's new", circulars or press-release page), with an optional CSS selector, link prefix and page parameter. **Edit details** changes a regulator's metadata: languages and the language to review in, *relevant keywords* (count as relevant evidence), *exclusion keywords* (set a page aside only when nothing regulatory points the other way), *path hints* (`/en/guidance/ = guidance`, `/x/ = topic:capital`, `/events/ = exclude`), known gaps, and whether it is swept at all. Each form opens a prefilled issue; the owner-only `Scout Source Request` workflow validates the request against the same rules as every sweep, commits `config/scout.json`, and queues a sweep of that regulator (a new channel's first read is a quiet baseline). Channels are added, never removed, from the dashboard.

**State.** Everything lives under `data/scout/`: `registry/<regulator>.json` (every URL observed, one per line, with first-seen time, origin, evidence and a compact assessment), `review.json` (the dashboard's queue), `latest.json` (the coverage ledger), `history.json` and `decisions.json`. `scripts/commit_state.sh` scopes each job to its own state, so a Scout commit never blocks a monitor commit and vice versa.

Run it locally (writes `data/scout/`; use `--data-dir` to experiment elsewhere):

```bash
python -m regmon.scout sweep --regulator eba --data-dir /tmp/scout
python -m regmon.scout validate --data-dir /tmp/scout
```

---

# Running it locally

## Requirements

- Python 3.13
- Git
- network access to the monitored website
- an OpenRouter API key if AI analysis is required
- an ntfy topic if notifications are required

Install dependencies:

```bash
python -m pip install -r requirements.txt
```

Run the tests:

```bash
python -m unittest discover -s tests -p "test*.py" -v
```

Compile the code:

```bash
python -m compileall -q regmon
```

Run a monitoring pass:

```bash
python -m regmon.monitor --source all
```

Run a specific source:

```bash
python -m regmon.monitor --source fed-reporting-forms-pilot
```

Run without writing monitoring state (still makes network requests):

```bash
python -m regmon.monitor --source fed-reporting-forms-detail-pilot --dry-run
```

---

# GitHub Actions secrets

The live workflow expects:

### Required for AI

`OPENROUTER_API_KEY`

### Optional for notifications

`NTFY_TOPIC`

If no topic secret is supplied, alerts remain queued in the notification outbox and are not delivered until a topic is configured.

The repository should never contain actual API keys or other credentials.

---

# Customizing the monitored website

The main extension point is:

`config/sources.json`

A new source can define its own:

- seed URL
- allowed domain(s)
- allowed URL prefix(es)
- excluded paths
- optional include_selector to restrict HTML comparison to a CSS-selected region
- optional ignore_selectors list to remove page elements before text comparison
- discovery behavior
- URL limit
- AI limits

Example configuration:

{
  "include_selector": "main .consultation-content",
  "ignore_selectors": [".cookie-banner", ".breadcrumb", ".last-visited"]
}

Selectors are validated when registered. If an inclusion selector stops matching during a later fetch, ChangeSentinel records an extraction error rather than silently monitoring the entire page. The original fetched HTML response is still preserved as evidence.

The rest of the pipeline is intentionally shared.

Conceptually:

```text
Your website
     ↓
source configuration
     ↓
discovery
     ↓
fetch
     ↓
content extraction
     ↓
normalization
     ↓
change detection
     ↓
relevance triage
     ↓
AI interpretation
     ↓
notifications
     ↓
history + dashboard
```

---

# Project structure

```text
.
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── pages.yml
│       └── regulatory-monitor.yml
│
├── config/
│   └── sources.json
│
├── data/
│   ├── evidence/
│   ├── history/
│   ├── snapshots/
│   ├── reports/
│   ├── latest.json
│   ├── report.json
│   ├── report.md
│   ├── notifications.json
│   └── discovery diagnostics
│
├── docs/
│   ├── ARCHITECTURE.md
│   └── OPERATIONS.md
│
├── regmon/
│   ├── ai.py
│   ├── change.py
│   ├── config.py
│   ├── content.py
│   ├── discovery.py
│   ├── engine.py
│   ├── fetch.py
│   ├── monitor.py
│   ├── notify.py
│   └── relevance.py
│
├── tests/
│   ├── test_config.py
│   ├── test_monitor.py
│   └── test_notify.py
│
├── index.html
├── dashboard-v2.html
├── dashboard.js
├── dashboard-lib.js
├── requirements.txt
└── README.md
```

### What each Python module owns

| Module | Responsibility |
| --- | --- |
| `config.py` | Load and validate source configuration |
| `discovery.py` | Discover URLs, canonicalize them, apply scope rules |
| `fetch.py` | Retrieve resources with retries and metadata |
| `content.py` | Extract normalized text from supported formats |
| `change.py` | Hashes, event classification, diffs, evidence |
| `relevance.py` | High-recall candidate triage |
| `ai.py` | Structured AI interpretation |
| `notify.py` | Idempotent ntfy notifications |
| `engine.py` | End-to-end orchestration and persistence |
| `monitor.py` | Compatibility CLI entry point |

---

# Design principles

### Deterministic first

Technical change detection should be reproducible.

### AI downstream

AI interprets evidence; it does not redefine whether a technical change happened.

### Evidence over assertions

Every important event should leave enough information to understand why it was raised.

### High recall before semantic filtering

The relevance gate should reduce noise without aggressively hiding potentially important changes.

### Configuration over rewrites

Adding a monitored source should generally happen in configuration rather than by cloning the crawler.

### Git-backed state

Monitoring state, history, and evidence remain inspectable through normal Git history.

---

# Current scope and limitations

For recursive sources, the inventory represents the **reachable public site from the configured seed within the configured scope**. The current Federal Reserve sources are deliberately exact-URL pilots rather than recursive whole-site crawls.

That means:

- orphaned pages with no reachable link from the seed may not be discovered
- utility/search/login surfaces are deliberately excluded
- JavaScript-only links that never appear in fetched HTML may require the browser fallback
- AI interpretation depends on the configured model/provider being available
- a large website can take substantial time to crawl and fetch
- the first baseline is intentionally quiet

This is a monitoring system, not a guarantee that every possible page on a website is discoverable.

---

# Contributing

The safest way to contribute is:

1. make a focused change
2. add or update regression tests
3. run the test suite locally
4. run the compile check
5. open a pull request

Core monitoring behavior should come with tests because a small crawler change can affect the entire pipeline.

---

# Troubleshooting

### The monitor says no URLs were discovered

Check:

- the source seed URL
- the allowed domain
- the allowed prefix
- `data/http-discovery-output.txt`
- `data/stealth-output.txt`

### Pages are being reported as changed too often

Check the normalization rules in:

`regmon/content.py`

A changing navigation/banner/footer should generally not affect normalized content.

### AI is not running

Check that:

`OPENROUTER_API_KEY`

exists in the GitHub Actions secrets.

### Notifications are not arriving

- Confirm the GitHub Actions secret named `NTFY_TOPIC` is set to the exact topic name (for example, `RegMonitoringWebCrawlerNTFY`).
- Check ntfy availability and the delivery ledger in `data/notifications.json`.
- Check `data/notification-outbox.json` for failed or undelivered candidates. Source-only HTML noise is intentionally not queued.


### The dashboard looks stale

The dashboard is backed by files committed to the repository. Check the most recent monitoring run and whether its state was committed successfully.

---

# Project status

This repository is an actively evolving monitoring engine rather than a generic drop-in crawler library.

The current active source is a tightly bounded Federal Reserve reporting-forms pilot. Older EBA configurations and the large historical inventory remain preserved but inactive. The architecture is source-driven so additional public regulatory or policy websites can be added through configuration.

The main components are:

**discovery → fetching → extraction → deterministic comparison → evidence → relevance → AI → notifications → history → dashboard**

---

# Notification delivery and operational safeguards

Notification candidates are persisted in the repository's notification outbox. Successful ntfy sends are recorded in the delivery ledger; failed sends stay queued for later runs. Delivery is at-least-once, so a crash after remote acceptance but before committing state can produce a duplicate alert.

The production workflow validates discovery metadata only for active sources selected in the current run. Historical inactive-source state must not block the active Federal Reserve pilot. Exact URL allowlists are included in checkpoint fingerprints and recovered inventories are filtered to the current scope.

Manually registered URLs are bounded to one exact URL. Redirects are validated, and duplicate monitor registrations with different CSS selectors are rejected rather than silently ignored. Every HTTP request the scanner, discovery and Scout make also checks its destination when the socket is opened (`regmon/safe_http.py`): the host is resolved again, any non-public address refuses the connection, and the socket connects to exactly the address that was checked, so a record that rebinds between the preflight and the connection is refused. TLS still verifies the original hostname. The browser-based discovery fallback and traffic through a configured proxy rely on the preflight alone; high-assurance deployments should still add outbound egress controls.

## License

No license is currently specified in this repository. See GitHub's documentation on repository licensing before reusing the project in another project or organization.


## Ask Sentinel

Ask Sentinel is integrated into the existing dashboard theme and navigation. It uses the dedicated Supabase Edge Function at `https://pysoukwmnwwgilkwafdy.supabase.co/functions/v1/ask-sentinel` and Groq's `openai/gpt-oss-20b` model via the server-side `GROQ_API` secret. No Groq API key is shipped to the browser.

### Repository knowledge and retrieval

The Edge Function reads the current `main` commit of `GauravDarwesh/ChangeSentinel`, indexes readable repository text and caches it in private Supabase tables. It covers the committed run history, monitoring reports, source configuration, URL registry, notification ledgers, change evidence, extracted text snapshots, discovery inventory text, documentation, source code, tests, scripts and workflows. Binary PDF and ZIP files are not sent directly to the model; the committed extracted text snapshots and evidence JSON are indexed instead. Each question retrieves relevant records from this text corpus within a conservative prompt budget for the stated free Groq limit. It does not attempt to paste the entire repository into one prompt. The corpus is refreshed automatically when a new `main` commit is detected on the next warm-up.

The model is instructed to distinguish currently configured active sources from inactive/archived records, and verified source changes from baseline migrations, extraction drift, superseded alerts and fetch/extraction failures. It should report when retrieved evidence is insufficient instead of making up an answer.

### Authentication and daily quota

The frontend first attempts a Supabase anonymous Auth session. If anonymous sign-ins are unavailable, it falls back to a stable UUID stored in that browser's local storage. The Edge Function validates a Supabase session when present; otherwise it accepts the visitor UUID and applies the same atomic server-side limit of three accepted requests per identity per UTC calendar day. This fallback keeps a prototype presentation usable without an Auth-provider toggle, but it is not strong authentication: visitors can clear browser storage or deliberately choose another UUID to reset their identity. Enable anonymous sign-ins for stronger per-user continuity when possible.

`GROQ_API` must be present under Edge Function secrets. The function platform JWT gate is disabled because the handler validates bearer tokens itself when Supabase Auth is used, and validates the UUID format when using prototype visitor identity. Only the Supabase publishable key is included in the dashboard. The Supabase secret/service-role key and Groq API key remain server-side. Retrieved evidence is capped at 8,500 characters, recent chat history is tightly bounded, and model output is capped at 800 tokens to leave headroom under the stated 8K-token input budget.
