# ChangeSentinel - Intelligent Web Crawler

A configuration-driven web monitoring system that discovers public web pages, fetches their content, detects changes, uses AI to explain meaningful changes, sends notifications, and keeps a searchable monitoring history.

The repository currently ships with the **European Banking Authority (EBA)** as the example/live source.

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

\`config/sources.json\`

Each source can define:

- starting URL(s)
- allowed domains
- allowed URL prefixes
- excluded URL prefixes
- crawler settings
- discovery limits
- fetch settings
- AI limits

The current EBA source starts at:

\`https://www.eba.europa.eu/homepage\`

The current configuration uses:

- same-host discovery
- unlimited URL discovery (\`max_urls: 0\`)
- \`/user/\` and \`/search\` exclusions
- direct HTTP recursive discovery as the primary path
- \`stealth-crawler\` as a browser fallback

Adding another monitored source is intended to be a configuration task rather than a rewrite of the monitoring engine.

---

## 2. URL discovery

The discovery layer is implemented in:

\`regmon/discovery.py\`

The current system uses two discovery paths.

### Primary: direct HTTP discovery

The crawler fetches HTML pages and extracts links using:

- \`requests\`
- \`BeautifulSoup\`
- \`urljoin\`
- URL canonicalization
- bounded concurrency

It recursively follows reachable in-scope links.

This path is fast and predictable for normal public HTML sites.

### Fallback: stealth-crawler

\`stealth-crawler\` uses a headless browser and is retained for sites where browser-rendered navigation is necessary.

The project originally depended on this path alone. The production flow now attempts the direct HTTP route first so a browser failure does not automatically kill the monitoring run.

### What gets discovered?

The discovery layer records URLs, not just HTML pages.

For example, a discovered PDF URL is kept in the inventory so the later fetch/extraction stages can process it.

---

## 3. URL canonicalization and scope filtering

Before URLs are stored, \`regmon/discovery.py\` normalizes them.

Canonicalization currently:

- removes fragments such as \`#section\`
- normalizes scheme and host casing
- removes trailing slashes where appropriate
- removes common tracking parameters such as \`utm_*\`, \`fbclid\`, and \`gclid\`
- preserves semantic query parameters
- sorts query parameters for stable identity

The scope filter then makes sure a URL:

- belongs to an allowed domain
- matches an allowed prefix
- does not match an excluded path

This prevents the crawler from wandering onto unrelated websites or utility areas such as login/search surfaces.

---

## 4. Fetching

\`regmon/fetch.py\` is responsible for retrieving individual resources.

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

\`regmon/content.py\` converts different resource types into normalized text.

Currently supported:

- HTML
- PDF
- DOCX
- XLSX
- PPTX
- CSV
- plain text

For HTML, the extractor removes common non-content material such as:

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

\`regmon/change.py\` handles technical change classification.

The primary identity is a SHA-256 hash of normalized content.

The comparison is therefore:

**previous normalized hash vs current normalized hash**

Possible technical events include:

| Event | Meaning |
| --- | --- |
| \`NEW_URL\` | URL is newly discovered |
| \`CHANGED_URL\` | Normalized content changed |
| \`UNCHANGED_URL\` | Normalized content is unchanged |
| \`REMOVED_URL\` | Previously monitored URL is no longer discovered |
| \`FETCH_ERROR\` | URL could not be fetched successfully |
| \`EXTRACTION_ERROR\` | Resource was fetched but could not be converted into usable text |
| \`BASELINE_MIGRATION\` | Older state is being migrated to the current hashing model |

The change detector is deterministic. AI is not involved in this decision.

---

## 8. Evidence and diffs

When a meaningful technical event occurs, the project stores evidence under:

\`data/evidence/\`

For changes, the evidence includes a unified before/after diff.

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

\`regmon/relevance.py\` performs a high-recall first pass.

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

\`regmon/ai.py\` is the interpretation layer.

The AI receives the evidence for a detected change and must return exactly nine fields:

1. \`relevant\`
2. \`topic\`
3. \`change_type\`
4. \`summary\`
5. \`impact\`
6. \`effective_date\`
7. \`affected_scope\`
8. \`actions\`
9. \`reason\`

The prompt also instructs the model to use only the supplied evidence and to use \`Not stated\` when the evidence does not establish a value.

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

\`regmon/notify.py\` sends notifications through [ntfy](https://ntfy.sh/).

Notifications are generated for:

- AI-confirmed relevant changes
- removed monitored URLs
- fetch errors
- extraction errors

The notification state is stored in:

\`data/notifications.json\`

Each event has an ID, allowing the notifier to avoid sending the same event repeatedly.

---

## 12. Persistence and monitoring history

Runtime state is stored under:

\`data/\`

The important files are:

| Path | Purpose |
| --- | --- |
| \`data/latest.json\` | Current monitored URL inventory |
| \`data/report.json\` | Latest aggregate report |
| \`data/report.md\` | Human-readable latest report |
| \`data/reports/\` | Per-source reports |
| \`data/snapshots/\` | Latest normalized page snapshots |
| \`data/evidence/\` | Immutable event evidence and diffs |
| \`data/history/index.json\` | Compact run history |
| \`data/history/<run_id>.json\` | Full historical run report |
| \`data/notifications.json\` | Notification idempotency state |
| \`data/http-discovery-output.txt\` | Latest HTTP discovery diagnostics |
| \`data/stealth-output.txt\` | Browser crawler diagnostics |

The monitoring workflow commits this state back to the repository so each run leaves a Git-backed record.

---

# GitHub Actions automation

The project is designed to run without a permanently running server.

There are two main workflows.

## \`RegMonitor CI\`

File:

\`.github/workflows/ci.yml\`

Runs on pushes and pull requests.

It checks:

- dependency installation
- unit/regression tests
- Python compilation
- dashboard JavaScript syntax

This is the safety net for code changes.

## \`Regulatory Monitor\`

File:

\`.github/workflows/regulatory-monitor.yml\`

This is the actual monitoring pipeline.

It:

1. checks out the repository
2. installs dependencies
3. runs the tests
4. compiles the Python code
5. checks EBA reachability
6. discovers the monitored site
7. fetches and analyzes the discovered resources
8. writes reports and evidence
9. publishes notifications
10. commits the updated monitoring state

### Schedule

The default schedule is every six hours:

\`0 */6 * * *\`

The workflow also supports manual execution.

---

# First run vs later runs

The first run is special.

The EBA source is configured with:

\`baseline_on_first_run: true\`

That means the first successful inventory establishes the baseline.

The purpose is to avoid generating hundreds or thousands of "new page" notifications simply because the system has never seen the site before.

After the baseline exists:

**Run N** is compared with **Run N-1**.

That is when actual changes become interesting.

---

# Dashboard

The repository includes a dependency-free operations console:

\`index.html\`

GitHub Pages publishes it.

The dashboard reads the monitoring JSON from the repository and exposes things such as:

- discovered URL count
- changed/new/removed counts
- errors
- AI-reviewed results
- event filters
- URL inventory
- run history
- evidence links

Live dashboard:

https://gauravdarwesh.github.io/ChangeSentinel/

---

# Running it locally

## Requirements

- Python 3.13
- Git
- network access to the monitored website
- an OpenRouter API key if AI analysis is required
- an ntfy topic if notifications are required

Install dependencies:

\`\`\`bash
python -m pip install -r requirements.txt
\`\`\`

Run the tests:

\`\`\`bash
python -m unittest discover -s tests -p "test*.py" -v
\`\`\`

Compile the code:

\`\`\`bash
python -m compileall -q regmon
\`\`\`

Run a monitoring pass:

\`\`\`bash
python -m regmon.monitor --source all
\`\`\`

Run a specific source:

\`\`\`bash
python -m regmon.monitor --source eba-full-site
\`\`\`

Run without writing monitoring state:

\`\`\`bash
python -m regmon.monitor --source eba-full-site --dry-run
\`\`\`

---

# GitHub Actions secrets

The live workflow expects:

### Required for AI

\`OPENROUTER_API_KEY\`

### Optional for notifications

\`NTFY_TOPIC\`

If no topic secret is supplied, the workflow uses its configured default topic.

The repository should never contain actual API keys or other credentials.

---

# Customizing the monitored website

The main extension point is:

\`config/sources.json\`

A new source can define its own:

- seed URL
- allowed domain(s)
- allowed URL prefix(es)
- excluded paths
- discovery behavior
- URL limit
- AI limits

The rest of the pipeline is intentionally shared.

Conceptually:

\`\`\`text
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
\`\`\`

---

# Project structure

\`\`\`text
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
├── requirements.txt
└── README.md
\`\`\`

### What each Python module owns

| Module | Responsibility |
| --- | --- |
| \`config.py\` | Load and validate source configuration |
| \`discovery.py\` | Discover URLs, canonicalize them, apply scope rules |
| \`fetch.py\` | Retrieve resources with retries and metadata |
| \`content.py\` | Extract normalized text from supported formats |
| \`change.py\` | Hashes, event classification, diffs, evidence |
| \`relevance.py\` | High-recall candidate triage |
| \`ai.py\` | Structured AI interpretation |
| \`notify.py\` | Idempotent ntfy notifications |
| \`engine.py\` | End-to-end orchestration and persistence |
| \`monitor.py\` | Compatibility CLI entry point |

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

The current EBA setup represents the **reachable public site from the configured seed within the configured scope**.

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
- \`data/http-discovery-output.txt\`
- \`data/stealth-output.txt\`

### Pages are being reported as changed too often

Check the normalization rules in:

\`regmon/content.py\`

A changing navigation/banner/footer should generally not affect normalized content.

### AI is not running

Check that:

\`OPENROUTER_API_KEY\`

exists in the GitHub Actions secrets.

### Notifications are not arriving

Check:

- \`NTFY_TOPIC\`
- ntfy availability
- the notification ledger in \`data/notifications.json\`

### The dashboard looks stale

The dashboard is backed by files committed to the repository. Check the most recent monitoring run and whether its state was committed successfully.

---

# Project status

This repository is an actively evolving monitoring engine rather than a generic drop-in crawler library.

The current implementation is configured around EBA monitoring, but the architecture is intentionally source-driven so additional public regulatory or policy websites can be added through configuration.

The main components are:

**discovery → fetching → extraction → deterministic comparison → evidence → relevance → AI → notifications → history → dashboard**

---

## License

No license is currently specified in this repository. See GitHub's documentation on repository licensing before reusing the project in another project or organization.
