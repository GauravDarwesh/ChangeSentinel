# ChangeSentinel: next phases

*Updated 2026-10-30. Builds on [ROADMAP.md](ROADMAP.md) (M0 audit) and the external product review.*

## 1. Direction

The review's central point stands: **detecting a change is not compliance.** Buyers pay to know what they must do about a change, who does it, and how they prove it was done. Its target lifecycle is:

> **DETECT → UNDERSTAND → ASSESS → CONNECT → ACT → VERIFY**

We follow that lifecycle, but **inside one niche**, not as a broad CUBE / Corlytics competitor:

> *The most trustworthy change detector for regulatory reporting specifications, which tells a reporting team exactly which of its reports, items, systems and controls a change touches, and tracks the fix to evidence.*

Why the niche:

- Incumbents mostly read legal text. Reporting specs (MDRM items, edit checks, XBRL/XSD taxonomies, data dictionaries) are structured, so most of the lifecycle can be **deterministic**, not AI guesswork.
- That is the review's open question 5 ("beyond coverage, what makes us better?"). We are exact where others are approximate.
- It is buildable by a small team.

### The review's concepts, translated to reporting specs

| Review concept | In ChangeSentinel |
|---|---|
| Regulation / document | Monitored source: form, instructions, edit checklist, taxonomy, data dictionary |
| Obligation | **Reporting item** (MDRM code, FFIEC item, DPM data point) and the **edit checks** that apply to it |
| Obligation register | **Item catalog**: what the regulator says each item is, versioned |
| Applicability | Reports the entity files; filer type and thresholds |
| Policy / procedure | Out of scope for now (legal-text world) |
| Control | Internal validation checks, data mappings, reconciliations: registry **consumers** of kind `check` / `table` / `pipeline` / `model` |
| Business owner | Consumer **owner** |
| Remediation | Task per impacted item and consumer |
| Evidence | Git audit trail, before/after snapshots, conformance re-run, submission validation |

## 2. Where we are

| Lifecycle step | Status | What exists |
|---|---|---|
| **DETECT** | ✅ Strong | SHA-256 change detection, parser-drift isolation (`BASELINE_MIGRATION`), 238 monitored URLs, link lineage, Scout discovery |
| **UNDERSTAND** | 🟡 Partly | Row-level spec diff (rules, fields, XSD, XBRL); PDF rule tables (FR Y-9C: 2,195 edits, #250); next-period file chaining for FFIEC/OSFI names (#253) |
| **ASSESS** | 🔴 Missing | No applicability model; severity only from spec-diff categories |
| **CONNECT** | 🟡 Started | Registry with 1,709 FR Y-9C items (seeded) and 3 demo consumers mapped (#251); impact sentence in alerts; offline `spec_conformance` gap check |
| **ACT** | 🔴 Missing | Review ledger records a decision per change, not tasks per impacted item |
| **VERIFY** | 🔴 Missing | Evidence of *detection* is strong; evidence of *remediation* doesn't exist |

**Known gaps from M0:**

- The spec engine had never fired on real data. Fixed for period-named files by #253; first real result on 2026-10-30, when OSFI replaced the five 2027 BCAR return files (tech spec v4.1: 5 DPAs retired, 82 removed, 38 rule-logic changes; XSD: 3 elements removed, risk-weight codes 861–864 added).
- Federal Reserve `guid` documents are now chained by label handover (#261).
- The FFIEC Call Report taxonomy is read correctly but not yet fetched automatically (1.3c).
- 52% of evidence files were fetch errors, from one incident; fixed so an episode writes one file.

## 3. Phases

Each phase ends in something demonstrable. Size: S = days, M = 1–2 weeks, L = several weeks.

### Phase 1 · Finish DETECT + UNDERSTAND at item level

*Goal: every new edition of a monitored spec is compared item by item with the previous one, automatically.*

| # | Work | Size | Status |
|---|---|---|---|
| 1.1 | **Next-edition chaining:** period-named files (#253) and labels such as the Fed's "Current" link (#261) | M | ✅ Done. #253 compared OSFI's 2027 BCAR revision in production on 2026-10-30; #261 found exactly the 5 real handovers in 256 recorded page changes |
| 1.2 | **CSV as tables:** CSV/TSV text read by `spec_diff` | S | ✅ Done (#261) |
| 1.3a | **FFIEC 101 and 102 edit workbooks** (validity; quality/intraseries/interseries) | S | ✅ Monitors added (#261); chain to each new edition by file-name period |
| 1.3b | **MDRM data dictionary** (`MDRM.zip`) | M | ✅ Monitor added with a table filter: the FR Y-9C series of the 91 MB file (3,258 items, 3.5 MB), keyed by MDRM + start date |
| 1.3c | **FFIEC CDR Call Report taxonomy** (edits, concepts, labels) | M | 🟡 Reading done: 3,615 FFIEC 031 edits from the CDR's own formula format, tested on the real Sept 2026 taxonomies. Fetching needs the CDR download form (next) |
| 1.4 | **Fetch-error triage** | S | ✅ Done (#261): 0 of 243 monitors failing; 199 of 207 error files came from one Cloudflare day (26 Oct). A continuing failure now keeps one evidence file per episode |

### Phase 2 · Item catalog (the "obligation register")

*Goal: a versioned record of what the regulator says each item is, the review's §3.1.*

| # | Work | Size | Done when |
|---|---|---|---|
| 2.1 | `data/items/`: one history per scheme + form + code (label, definition, data type, schedule/line, edit checks that target or read it, effective from/to, source citation with page) | L | `item_code_history BHCK2170` answers from the catalog, not by scanning events |
| 2.2 | **Status of each version:** proposed / final / superseded / retired (review §6A) | M | Federal Register proposal notices (already seen by link lineage) linked to the form they revise |
| 2.3 | **Effective-date intelligence (review §6B):** publication, effective date, first report date, transition | M | Each item version carries a first applicable quarter; feeds the calendar |
| 2.4 | **Registry item page shows its timeline** | S | Item sheet lists every version with diff and source page |

**Rule kept from the review:** every item keeps the regulator's exact wording and page citation. AI summarises; it never replaces the source text.

### Phase 3 · ASSESS: applicability and priority

*Goal: no one reviews a change that doesn't apply to them (review §3.2).*

| # | Work | Size | Done when |
|---|---|---|---|
| 3.1 | **Entity profile:** reports filed, filer type, asset size, entities | S | `config/profile.json` with a dashboard editor |
| 3.2 | **Applicability filter:** deterministic rules (e.g. FR Y-9C applies to BHCs ≥ $3bn) | M | A change to an unfiled report is marked *not applicable* with the reason |
| 3.3 | **"Applicable but unmapped":** a changed item in a filed report with no consumer | S | Shown as a gap, not silently dropped |
| 3.4 | **Priority:** severity (blocking validity edit > quality edit > label), effective date and number of consumers | M | Changes list sorts by priority; reason shown |

### Phase 4 · CONNECT: controls and gap assessment

*Goal: link each change to the controls that implement it and find where they fall short (review §3.3).*

| # | Work | Size | Done when |
|---|---|---|---|
| 4.1 | **Mapping import from the dashboard:** upload a code → system / owner spreadsheet | S | 500-row mapping imported in one request (no URL-length limit) |
| 4.2 | **Controls as consumers:** `kind: check` for the team's own validation rules, with the edit check it implements | S | A Fed edit links to the internal check that mirrors it |
| 4.3 | **Live gap assessment:** run `spec_conformance` on every spec change against the team's rule library / data dictionary | M | Change shows *retired but still implemented*, *missing*, *logic differs*, *extra* |
| 4.4 | **Suggested updates:** AI drafts the changed check or mapping from the diff, linked to evidence; a human approves | M | Draft attached to the task, never applied automatically |

### Phase 5 · ACT: remediation workflow

*Goal: every impacted item has an owner, a due date and a status (review §3.4).*

| # | Work | Size | Done when |
|---|---|---|---|
| 5.1 | **Task per impacted item × consumer:** owner from consumer, due date from effective quarter | M | Change opens tasks automatically; ledger is append-only like reviews |
| 5.2 | **Status flow:** detected → assessed → assigned → in progress → done | S | Dashboard board and per-owner view |
| 5.3 | **Escalation:** due-soon and overdue reminders (calendar reminders already exist) | S | Owner and lead notified |
| 5.4 | **Outbound:** Jira / ServiceNow / Slack via the existing webhook channel | M | Task created in Jira with citation, diff link, items, due date |

### Phase 6 · VERIFY: evidence of completion

*Goal: prove the change was implemented, not only noticed (review §6C).*

For reporting the evidence chain is:

**mapping updated → validation check updated → test file passes → submission accepted.**

| # | Work | Size | Done when |
|---|---|---|---|
| 6.1 | Evidence states per task (review's policy → control → tested → verified, in reporting terms) | M | Task can't close without evidence for each state |
| 6.2 | **Automatic verification:** re-run conformance after the fix; attach the result | M | Gap disappears → evidence recorded with hashes |
| 6.3 | **Audit pack export:** per change, the source citation, diff, decision, tasks, evidence and timestamps | S | One PDF/ZIP per change for an examiner |

**Rule kept from the review:** the platform never declares compliance on its own. It shows evidence; a person signs off.

### Phase 7 · Prove it (runs alongside Phases 2–4)

| # | Work | Size | Done when |
|---|---|---|---|
| 7.1 | **Replay demo (M7):** two past FR Y-9C editions and one Call Report quarter end to end, using the demo mappings | M | One alert shows rule changes, affected items, systems, owners, due dates |
| 7.2 | **Validate competitor claims** (CUBE, Corlytics, AscentAI, Archer, MetricStream) against primary vendor documentation, as the review asks | S | One-page comparison with sources |
| 7.3 | **Design partners:** 3–5 regulatory reporting teams | M | Feedback on the demo; one pilot mapping imported |
| 7.4 | **Employment / IP check before commercial pilots** | S | Written confirmation of where you stand |

### Phase 8 · Enterprise readiness

*Goal: what a bank's security review requires (review §6D). Design decisions start now; build when a pilot needs it.*

| # | Work | Size |
|---|---|---|
| 8.1 | Move state from Git + Pages to a hosted service (planned VPS) with Postgres; keep Git-style immutable history for evidence | L |
| 8.2 | Authentication, role-based access (viewer / analyst / owner / admin), SSO | M |
| 8.3 | Multi-tenant isolation: per-customer registry, profile, tasks; shared regulator-side catalog | L |
| 8.4 | Encryption at rest, backups, retention and deletion policies, DR | M |
| 8.5 | Public API; GRC integrations (Archer, OpenPages, MetricStream) | L |
| 8.6 | Security posture: pen test, SOC 2 readiness | L |

**Design now so later moves are cheap:**

- Keep the **regulator side** (sources, catalog, diffs) separate from the **customer side** (profile, registry, tasks, evidence) in every new file.
- Every record carries a stable ID and timestamps.
- No customer data lands in the shared catalog.

## 4. Core data model (the review's open question 2)

```
Source ──< DocumentVersion ──< ItemVersion >── Item ──< EditCheck
                 │                   │
             Change ────────── ItemChange ──< Impact >── Consumer (system / control) ── Owner
                                     │                        │
                              Applicability (Profile)      Task ──< Evidence
```

- **Regulator side (shared):** Source, DocumentVersion, Item, ItemVersion, EditCheck, Change, ItemChange.
- **Customer side (per tenant):** Profile, Consumer, Owner, Impact, Task, Evidence.
- **Join:** `ItemChange × Applicability × Consumer → Impact → Task`.

The review's chain *Regulation → Change → Obligation → Applicability → Risk → Policy → Control → Owner → Remediation → Evidence → Verification* maps onto this one to one, with "Obligation" = item / edit check and "Policy" left out of scope.

## 5. Answers to the review's five open questions

1. **Architecture:** the deterministic engine stays the base and is never driven by AI. New layers (catalog, applicability, tasks) read its outputs; none of them can create or hide a detected change.
2. **Data model:** §4. Regulator side shared, customer side per tenant.
3. **Priorities:** Phase 1 → 2 → 3 → 4, with Phase 7 alongside. Workflow (5) only after impact is trustworthy; integrations last (as the review says).
4. **Enterprise readiness:** separation and IDs designed now (Phase 8 notes); hosting, auth and tenancy built when a pilot needs them.
5. **Differentiation:**
   - item- and edit-level precision on reporting specs;
   - deterministic, provable detection with no false alarms;
   - self-service monitoring of any regulator page;
   - an evidence trail an examiner can replay.

## 6. Kept, deferred, not doing

**Keep and deepen (review §5):**

- deterministic detection;
- parser-drift isolation;
- structured spec diffing as a core product;
- visual portal explorer.

**Deferred:**

- broad multi-jurisdiction source coverage;
- multilingual interpretation;
- GRC integrations;
- multi-tenant hosting (Phase 8).

**Not doing now:**

- obligation extraction from legal prose (KYC, AML and similar);
- policy and procedure registers;
- competing with incumbents on the number of sources.

## 7. Risks

- **Fed / regulator layout changes** break table reading. Mitigation: strict refusal checks (already in #250) and golden corpus in CI.
- **False successor chains.** Mitigation: unique-match only; ambiguous matches recorded, not followed; dry runs on real state before each release.
- **Mapping is the customer's work.** Without it impact is empty. Mitigation: CSV import, seed from rule tables, a future "propose consumers by scanning code repositories" helper.
- **Single maintainer.** Mitigation: tests per feature (1,163 today), docs per state file.
