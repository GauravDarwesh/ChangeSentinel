"""Proposed revisions (regmon/proposals.py) and the dates items and proposals put on the calendar."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from regmon import catalog, deadlines, proposals

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
SEEN = "2026-10-18T06:09:31+00:00"
HEADING = "October 2026 Call Report Revisions Related to the 21st Century ROAD to Housing Act – Effective March 31, 2027"
NOTICE = "https://www.federalregister.gov/documents/2026/10/27/2026-21841/proposed-agency-information-collection-activities-comment-request"


def link(text: str, section: str, **extra) -> dict:
    return {"text": text, "section": section, "first_seen": SEEN, "menu": False, **extra}


def lineage() -> dict:
    review = {f"https://www.federalregister.gov/d/2025-{n:05d}": link(f"FR {4000 + n} · link", "Information Collections Currently under Review")
              for n in range(1, 14)}
    review["https://www.federalregister.gov/d/2025-06863"] = link("FR Y-14A/Q/M R-1866 · link", "Information Collections Currently under Review")
    review["https://www.federalregister.gov/d/2026-20246"] = link("FR Y-14A/Q/M R-1866 · link", "Information Collections Currently under Review")
    review["https://www.federalregister.gov/d/2023-16896"] = link("link 1", "Information Collections Currently under Review")
    return {"schema_version": 1, "events": [], "pages": {
        "https://www.ffiec.gov/resources/reporting-forms/ffiec031": {"links": {
            NOTICE: link("Initial Federal Register Notice for Revisions to the FFIEC 031, FFIEC 041, and FFIEC 051 Call Reports", HEADING),
            "https://www.ffiec.gov/sites/default/files/data/reporting-forms/FFIEC031_20261027_f_draft.pdf":
                link("Redlined Draft FFIEC 031 Reporting Form", HEADING),
            "https://www.federalregister.gov/d/2025-21621": link("Federal Register Notice for Request for Comment",
                                                                "December 2025 Request for Information on Streamlining the Call Reports"),
            "https://www.federalregister.gov/d/2018-21105": link("Initial Federal Register Notice for Proposed Revisions to the FFIEC 031",
                                                                "September 2018 Proposed Call Report Revisions – Effective March 31, 2019",
                                                                removed_at="2026-10-20T00:00:00+00:00"),
            "https://www.ffiec.gov/resources/reporting-forms/ffiec031-instructions": link("Instructions", "Call Report"),
        }},
        "https://www.ffiec.gov/resources/reporting-forms/ffiec041": {"links": {
            "https://www.federalregister.gov/d/2026-21841": link("Initial Federal Register Notice for Revisions to the FFIEC 031, FFIEC 041", HEADING),
            "https://www.federalregister.gov/d/2026-22000": link("Final Federal Register Notice for Revisions to the FFIEC 031, FFIEC 041", HEADING),
        }},
        "https://www.ffiec.gov/resources/reporting-forms/ffiec102": {"links": {
            "https://www.federalregister.gov/d/2025-15000": link("Initial Federal Register Notice for FFIEC 102", "May 2025 FFIEC 102 Extension without Revision"),
        }},
        "https://www.federalreserve.gov/apps/reportingforms/review": {"links": review},
    }}


class ReadingTest(unittest.TestCase):
    def test_forms_named_in_text(self):
        self.assertEqual(proposals.forms_in("Revisions to the FFIEC 031, FFIEC 041, and FFIEC 051; FFIEC 009/009a; FR Y-14 A/Q/M; FR 2052a; FR K R-1835"),
                         {"FFIEC 031", "FFIEC 041", "FFIEC 051", "FFIEC 009", "FFIEC 009A", "FR Y-14A", "FR Y-14Q", "FR Y-14M", "FR 2052a", "FR K"})
        self.assertEqual(proposals.page_form("https://www.ffiec.gov/resources/reporting-forms/ffiec031-supplemental"), "FFIEC 031")
        self.assertEqual(proposals.page_form("https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_Y-9C"), "FR Y-9C")
        self.assertEqual(proposals.normalize_form("FFIEC102"), "FFIEC 102")

    def test_effective_dates_are_the_ones_after_effective(self):
        self.assertEqual(proposals.effective_dates("September 2015 Proposed Revisions – Effective September 30, 2016, and March 31, 2017"),
                         ["2016-09-30", "2017-03-31"])
        self.assertEqual(proposals.effective_dates("Proposed Revisions with Proposed Effective Dates of June 30, 2021, and December 31, 2021"),
                         ["2021-06-30", "2021-12-31"])
        self.assertEqual(proposals.effective_dates("Published June 21, 2019. Effective for the June 30, 2026, report date"), ["2026-06-30"])
        self.assertEqual(proposals.effective_dates("Letter of March 3, 2020 about the revisions"), [])

    def test_document_kinds_and_titles(self):
        self.assertEqual(proposals.kind_of(NOTICE, "Final Federal Register Notice for Proposed Revisions"), "final_notice")
        self.assertEqual(proposals.kind_of("https://x.gov/FFIEC031_20240126_f_draft.pdf", "Redlined Draft FFIEC 031 Reporting Form"), "draft")
        self.assertEqual(proposals.kind_of("https://x.gov/FIL3_202401.pdf", "FIL-3-2024 Proposed Revisions"), "letter")
        self.assertEqual(proposals.title_of("FR 4205 R-1746 · link"), "FR 4205 R-1746")
        self.assertEqual(proposals.title_of("link 1", "https://www.federalregister.gov/d/2023-16896"), "Federal Register notice 2023-16896")
        self.assertEqual(proposals.fr_number(NOTICE), "2026-21841")
        self.assertEqual(proposals.published(NOTICE), "2026-10-27")


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.built = proposals.build(lineage())
        self.by_title = {proposal["title"]: proposal for proposal in self.built["proposals"]}

    def test_one_proposal_across_form_pages(self):
        road = self.by_title[HEADING]
        self.assertEqual(road["forms"], ["FFIEC 031", "FFIEC 041", "FFIEC 051"])
        self.assertEqual(road["stage"], "final")  # a final notice is listed on the 041 page
        self.assertEqual(road["effective"], ["2027-03-31"])
        self.assertEqual((road["date"], road["date_basis"]), ("2026-10-27", "published"))
        self.assertEqual(len(road["pages"]), 2)
        notices = [doc for doc in road["documents"] if doc["kind"] in ("initial_notice", "final_notice")]
        self.assertEqual(len(notices), 2)  # the same notice under two addresses is one document
        self.assertNotIn("removed_at", road)

    def test_stages_and_lists_of_notices(self):
        self.assertEqual(self.by_title["December 2025 Request for Information on Streamlining the Call Reports"]["stage"], "request")
        self.assertEqual(self.by_title["May 2025 FFIEC 102 Extension without Revision"]["stage"], "extension")
        removed = self.by_title["September 2018 Proposed Call Report Revisions – Effective March 31, 2019"]
        self.assertEqual((removed["stage"], removed["removed_at"][:10]), ("proposed", "2026-10-20"))
        # The Fed's list of notices: one proposal per notice, joined by their OMB number.
        y14 = self.by_title["FR Y-14A/Q/M R-1866"]
        self.assertEqual((y14["forms"], len(y14["documents"]), y14["stage"]), (["FR Y-14A", "FR Y-14M", "FR Y-14Q"], 2, "under_review"))
        self.assertEqual(self.by_title["FR 4005"]["forms"], ["FR 4005"])
        self.assertEqual(self.built["unlinked"], 1)  # "link 1"
        self.assertIn("Federal Register notice 2023-16896", self.by_title)

    def test_by_form_newest_first(self):
        found = proposals.for_forms(self.built, ["ffiec 031"])
        self.assertEqual(found[0]["title"], HEADING)
        self.assertEqual([proposal["date"] for proposal in found], sorted((proposal["date"] for proposal in found), reverse=True))
        self.assertEqual(self.built["forms"]["FFIEC 041"], [self.by_title[HEADING]["id"]])

    def test_write_is_stable_and_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "link-lineage.json").write_text(json.dumps(lineage()), encoding="utf-8")
            self.assertTrue(proposals.write(data, now="2026-10-31T00:00:00+00:00")["written"])
            self.assertFalse(proposals.write(data, now="2026-11-01T00:00:00+00:00")["written"])
            self.assertEqual(proposals.validate(data), [])
            payload = proposals.load(data)
            payload["forms"]["FFIEC 031"].append("nope")
            (data / proposals.FILE_NAME).write_text(json.dumps(payload), encoding="utf-8")
            self.assertIn("unknown proposal", " ".join(proposals.validate(data)))


class FormsTest(unittest.TestCase):
    def test_item_forms(self):
        templates = [{"form": "FFIEC 031/041", "code_prefixes": ["RCON"]}, {"form": "FR Y-9C", "code_prefixes": ["BHCK"]}]
        self.assertEqual(catalog.item_forms("RCON2170", [{"document": "call-report051-2026-09-30-v301-ec.xml"}], templates),
                         ["FFIEC 031", "FFIEC 041", "FFIEC 051"])
        self.assertEqual(catalog.item_forms("BHCK2170", [], templates), ["FR Y-9C"])
        self.assertEqual(catalog.item_forms("MRRRS298", [{"attrs": {"form": "FFIEC 102"}}], templates), ["FFIEC 102"])
        self.assertEqual(catalog.form_name("FFIEC102"), "FFIEC 102")
        self.assertEqual(catalog.form_name("Published Validity"), "")

    def test_edit_checks_carry_their_form(self):
        rows = [{"series": "FFIEC102", "etype": "Validity", "id": "1", "field": "MRRRS298", "start": "20161231", "end": "99991231"}]
        self.assertEqual(catalog.edit_facts(rows)["MRRRS298"]["form"], "FFIEC 102")


class CalendarTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data"
        (self.data / "snapshots").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_items_and_proposals_become_dated_entries(self):
        dictionary = ("[FILE] MDRM_CSV.csv (csv)\nMDRM | Mnemonic | Item Code | Start Date | End Date | Item Name | Description |\n"
                      "BHCKPZ01 | BHCK | PZ01 | 3/31/2027 12:00:00 AM | 12/31/9999 12:00:00 AM | NEW ONE | A. |\n"
                      "BHCKPZ02 | BHCK | PZ02 | 3/31/2027 12:00:00 AM | 12/31/9999 12:00:00 AM | NEW TWO | B. |\n"
                      "BHCK2170 | BHCK | 2170 | 6/30/1981 12:00:00 AM | 12/31/2026 12:00:00 AM | TOTAL ASSETS | C. |\n"
                      "BHCK0001 | BHCK | 0001 | 6/30/1981 12:00:00 AM | 12/31/9999 12:00:00 AM | OLD | D. |\n")
        location = "data/snapshots/mdrm.txt"
        (self.data.parent / location).write_text(dictionary, encoding="utf-8")
        latest = {"schema_version": 2, "sources": {"mdrm": {"u1": {"canonical_url": "https://x.gov/MDRM.zip", "snapshot_location": location,
                                                                  "normalized_hash": "h", "raw_hash": "r"}}}}
        (self.data / "latest.json").write_text(json.dumps(latest), encoding="utf-8")
        catalog.update(self.data, latest, root=self.data.parent, now="2026-10-31T00:00:00+00:00")
        (self.data / "link-lineage.json").write_text(json.dumps(lineage()), encoding="utf-8")
        proposals.write(self.data)
        config = self.data.parent / "sources.json"
        config.write_text(json.dumps({"sources": []}), encoding="utf-8")
        entries = deadlines.build(self.data, config, today=date(2026, 10, 31))["entries"]
        stated = {(entry["kind"], entry["date"]): entry for entry in entries}
        start = stated[("items_start", "2027-03-31")]
        self.assertEqual((start["title"], start["codes"], start["count"], start["label"]),
                         ("FR Y-9C · 2 items", ["BHCKPZ01", "BHCKPZ02"], 2, "Items take effect"))
        self.assertEqual(stated[("items_end", "2026-12-31")]["codes"], ["BHCK2170"])
        self.assertNotIn(("items_start", "1981-06-30"), stated)  # long past
        road = stated[("revisions_effective", "2027-03-31")]
        self.assertEqual((road["title"], road["forms"], road["basis"]), (HEADING, ["FFIEC 031", "FFIEC 041", "FFIEC 051"], "proposal"))
        self.assertNotIn(("proposed_effective", "2019-03-31"), stated)
        ics = deadlines.to_ics({"entries": entries}, "2026-10-31T00:00:00+00:00", "https://example.test/")
        self.assertIn("Items take effect: FR Y-9C · 2 items", ics.replace("\r\n ", ""))
        self.assertIn("#registry", ics)


class McpTest(unittest.TestCase):
    def test_item_code_history_lists_proposals_for_its_forms(self):
        from regmon import mcp_server
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data").mkdir()
            (root / "config").mkdir()
            (root / "config" / "sources.json").write_text(json.dumps({"sources": []}), encoding="utf-8")
            (root / "data" / "link-lineage.json").write_text(json.dumps(lineage()), encoding="utf-8")
            proposals.write(root / "data")
            record = mcp_server.Record(root)
            result = mcp_server.item_code_history(record, {"code": "RCON2170"})
            self.assertEqual(result["proposals"][0]["title"], HEADING)
            self.assertIn(NOTICE, result["proposals"][0]["notices"])


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class DashboardTest(unittest.TestCase):
    def test_the_dashboard_finds_the_same_proposals(self):
        built = proposals.build(lineage())
        script = (f"const L = require({json.dumps(str(ROOT / 'dashboard-lib.js'))}); const payload = {json.dumps(built)};"
                  "const templates = [{form: 'FFIEC 031/041', code_prefixes: ['RCON']}];"
                  "const forms = L.catalogForms({code: 'RCON2170', current: [{document: 'call-report051-2026-09-30-v301-ec.xml', attrs: {}}]}, templates, []);"
                  "const found = L.proposalsFor(payload, forms, 3);"
                  "console.log(JSON.stringify({forms, titles: found.map(p => p.title), labels: found.map(L.proposalDateLabel),"
                  "norm: [L.normalizeForm('ffiec102'), L.normalizeForm('FR_Y-9C'), L.normalizeForm('fr 2052A')],"
                  "names: L.formsInName('https://x.gov/FFIEC102_ValidityEdits_20260630.xls'), extra: L.catalogForms({code: 'X', current: []}, [], ['FR Y-14Q'])}));")
        out = json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True).stdout)
        self.assertEqual(out["forms"], catalog.item_forms("RCON2170", [{"document": "call-report051-2026-09-30-v301-ec.xml"}],
                                                          [{"form": "FFIEC 031/041", "code_prefixes": ["RCON"]}]))
        self.assertEqual(out["titles"], [proposal["title"] for proposal in proposals.for_forms(built, out["forms"], 3)])
        self.assertEqual(out["labels"][0], "27 Oct 2026")
        self.assertEqual(out["norm"], ["FFIEC 102", "FR Y-9C", "FR 2052a"])
        self.assertEqual(out["names"], ["FFIEC 102"])
        self.assertEqual(out["extra"], ["FR Y-14Q"])


class WiringTest(unittest.TestCase):
    def test_scan_dashboard_and_pages(self):
        engine = (ROOT / "regmon" / "engine.py").read_text(encoding="utf-8")
        self.assertLess(engine.index("proposals.write(DATA)"), engine.index("catalog.update(DATA, payload, root=ROOT)"))
        self.assertLess(engine.index("catalog.update(DATA, payload, root=ROOT)"), engine.index("deadlines.write(DATA, DEFAULT_CONFIG_PATH)"))
        dashboard = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertEqual(dashboard.count('<div id="registryProposals"></div>'), 2)
        pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn("cp data/proposals.json site/data/proposals.json", pages)
        self.assertIn('"data/proposals.json"', pages)


if __name__ == "__main__":
    unittest.main()
