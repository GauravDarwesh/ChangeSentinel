# Roadmap: reporting-spec impact engine

Positioning: the most trustworthy change detector for regulatory reporting
specifications, that tells a reporting team exactly which of its reports, items
and controls a change touches. Detection stays deterministic; AI explains, a
person decides.

## M0 audit (2026-10-30, main at c0475fe, PRs #250 and #251 open)

### Already built

| Capability | Where | State |
|---|---|---|
| Row-level spec diff: rule tables, field tables, XSD, XBRL linkbases and instances; categories, declared-vs-detected, effective quarters | `regmon/spec_diff.py` | Done, tested |
| Item-code add/remove/amend (MDRM-style codes) | `regmon/item_codes.py` | Done |
| Owner registry: items, consumers (tables, pipelines, checks, owners), pattern rules, CSV import, impact sentence in alerts | `regmon/registry.py`, `config/registry.json` | Wired into engine and notify; **registry is empty** |
| Implementation-vs-spec gap check (retired_in_use, missing, differs, extra) | `regmon/spec_conformance.py` | Offline CLI only |
| Dates from AI and diff text into calendar.json / .ics | `regmon/deadlines.py` | Done |
| Append-only review decisions | `regmon/reviews.py`, `data/reviews/ledger.json` | Done |
| Item history over recorded changes | `regmon/mcp_server.py` `item_code_history` | Reconstructed from events |
| PDF rule tables row by row (FR Y-9C edits, 2,195 rows) | PR #250 | Open, CI green, mergeable |
| Registry UI, report templates, seed 1,709 items from rule tables | PR #251 (stacked on #250) | Open, CI green, mergeable |

### Gaps found

1. **The spec engine has never fired on real data.** 0 of 24 real CHANGED_URL
   events (and 0 events in 526 history runs) carry a spec or item-code result.
   All real changes so far are HTML pages.
2. **New-period files are never compared to the previous period.** Regulators
   publish each period under a new name (`FFIEC031_202609_f.pdf`,
   `bcar27-…-2026-09-10.xsd`). That arrives as NEW_URL, and
   `engine.structured_spec` only takes an inventory of a NEW_URL; it does not
   diff it against its predecessor. This is the main reason for gap 1.
3. **Machine-readable spec sources are thin.** 238 URLs: 115 PDF, 54 HTML,
   43 XML, 23 spreadsheets. Missing: MDRM data dictionary, FFIEC CDR Call
   Report taxonomy and edits. EBA sources are inactive.
4. **No regulator-side item catalog.** `config/registry.json` is the owner's
   list (what we report and what reads it). There is no versioned record of
   what the regulator says each item is over time (definition, type, edits
   that read it, effective dates). PR #250's `data/rule-tables/` is per
   snapshot.
5. **No proposed → final link.** Link lineage already sees Federal Register
   proposal notices on FFIEC pages; nothing ties them to the forms they revise.
6. **No owner / due date / status per impacted item.** Reviews record a
   decision per change, not remediation per item.
7. **Noise:** 205 of 395 evidence files are FETCH_ERROR.

## Plan

**Step 0. Land #250, then #251.** Both green and cleanly mergeable.

**M1. Version chaining.** When a NEW_URL is the next period of a monitored
document (same directory and filename once period, date and version tokens are
removed, reusing `spec_diff._doc_identity`; or it replaces that link on the same
listing page per link lineage), diff it against the predecessor's snapshot and
run `item_codes`, `spec_diff` and `registry.impact` exactly as for CHANGED_URL.
The event records `predecessor`. Done when a synthetic 202606 → 202609 pair
yields an item-level change list and an unrelated new file does not chain.

**M2. Spec source coverage.** Add the MDRM data dictionary, FFIEC CDR Call
Report taxonomy and edits for 031/041/051, and FR Y-9C edits. Separately, a
ticket to cut FETCH_ERROR noise.

**M3. Item catalog.** `data/items/` built from rule tables, spec inventories
and item-code diffs: one versioned history per scheme + form + code
(definition, type, edits that read it, effective from/to, source citation with
page). `item_code_history` and the Registry item sheet read it.

**M4. Proposed → final and effective dates.** Link proposal notices to the
forms they revise; mark item versions proposed / final / superseded; feed
first-applicable quarter into the calendar.

**M5. Applicability.** Mostly exists (registry, templates, seed, CSV import).
Add a report-level "we file" list so a changed item in a filed report that is
not mapped yet shows as *applicable, unmapped* instead of being silent.

**M6. Remediation per item.** Extend the review ledger: owner (from consumer
owner), due date (from effective quarter), status; out to Slack / Jira via
webhook. Dashboard follows the existing UI language.

**M7. Historical replay demo.** Two or three real FR Y-9C / Call Report
revisions end to end, as the pitch asset.

Paused until M3: Scout expansion, hosting move, Ask Sentinel features.
