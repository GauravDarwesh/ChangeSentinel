"""A new edition taking over a "Current" link (regmon/succession.py label handovers)."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine_harness import Sandbox, ok
from regmon import channels, link_lineage, notify, succession
from regmon.config import SourceConfig
from regmon.discovery import canonical
from regmon.validate_state import validate_persisted_state

ROOT = Path(__file__).resolve().parent.parent
FED = "https://www.federalreserve.gov"
PAGE = FED + "/apps/reportingforms/Report/Index/FR_Y-9C"
DOWNLOAD = FED + "/apps/reportingforms/Download/DownloadAttachment?guid="
OLD_FORM = DOWNLOAD + "dd598245-8cad-4674-917a-56235b919d88"
OLD_BOOK = DOWNLOAD + "698a2ee2-3603-4151-ac3e-49d695e29e8f"
NEW_FORM = DOWNLOAD + "11111111-2222-3333-4444-555555555555"
NEW_BOOK = DOWNLOAD + "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
# The FR Y-9C page as the monitor saved it (data/snapshots/html/).
SAVED_PAGE = ROOT / "data" / "snapshots" / "html" / (
    "37911bd09d89903249bb2a2c80c4d97aef75d8198f6af86a6d80123643c92e6f-"
    "6a39ed4abb404f7ada425dd70dce9e6ac4cfb615482c058dfb77b372da04c865.html")


def fed_page(form: str, book: str, history: tuple[tuple[str, str], ...] = ()) -> str:
    """A Federal Reserve form page: Form and Instructions each with a "Current" link, then dated history."""
    rows = "".join(f'<p><a href="{href[len(FED):]}">{label}</a></p>' for href, label in history)
    return (
        "<html><body><div id='content'><div id='article'><h3>FR Y-9C</h3>"
        f"<h6>Form:</h6><p><a href=\"{form[len(FED):]}\">Current (1.5 MB .PDF)</a></p>"
        f"<h6>Instructions:</h6><p><a href=\"{book[len(FED):]}\">Current (2.7 MB .PDF)</a></p>"
        "<h6>Description:</h6><p>Consolidated financial statements.</p>"
        f"<h4>Forms and Instructions</h4>{rows}"
        "<p><a href='/apps/reportingforms/Download/DownloadAttachment?guid=cfb2ba45-d1f0-407e-b9bc-724e356c5fe1'>December 2025 (164.0 KB .PDF)</a></p>"
        "<p><a href='/apps/reportingforms/Download/DownloadAttachment?guid=dc2bfff3-82ff-4ef7-9ac1-57b47378b6c2'>September 2025 (146.4 KB .PDF)</a></p>"
        "</div></div></body></html>"
    )


def recorded(html: str, page: str = PAGE) -> dict:
    lineage = link_lineage.load(Path("/nonexistent"))
    link_lineage.observe(lineage, page, link_lineage.extract_links(html, page), "2026-10-01T00:00:00+00:00")
    return lineage


def reading(html: str, page: str = PAGE) -> list[dict]:
    return [{"page": page, "links": link_lineage.extract_links(html, page)}]


class SlotTest(unittest.TestCase):
    def test_label_without_size_and_type(self):
        self.assertEqual(succession.slot("Current (2.7 MB .PDF)"), ("current", "pdf"))
        self.assertEqual(succession.slot("Current (234.8 KB .PDF)"), ("current", "pdf"))
        self.assertEqual(succession.slot("FR Y-9C Instructions (XLSX, 1.2 MB)"), ("fr y 9c instructions", "xlsx"))
        self.assertEqual(succession.display_label("September 2026 (2.7 MB .PDF)"), "September 2026")

    def test_generic_labels_are_not_followed(self):
        for text in ("PDF", "Download", "here", "", "XLSX"):
            self.assertIsNone(succession.slot(text), text)

    def test_links_carry_their_section(self):
        links = link_lineage.extract_links(fed_page(OLD_FORM, OLD_BOOK), PAGE)
        self.assertEqual((links[OLD_FORM]["section"], links[OLD_BOOK]["section"]), ("Form:", "Instructions:"))
        self.assertEqual(links[DOWNLOAD + "cfb2ba45-d1f0-407e-b9bc-724e356c5fe1"]["section"], "Forms and Instructions")


class HandoverTest(unittest.TestCase):
    def test_a_new_edition_takes_over_current_and_the_old_one_is_relabelled(self):
        before = recorded(fed_page(OLD_FORM, OLD_BOOK))
        after = fed_page(OLD_FORM, NEW_BOOK, history=((OLD_BOOK, "September 2026 (2.7 MB .PDF)"),))
        found = succession.handovers(before, reading(after))
        self.assertEqual(len(found), 1)
        entry = found[0]
        self.assertEqual((entry["from"], entry["to"], entry["rule"]), (OLD_BOOK, NEW_BOOK, "label_handover"))
        self.assertEqual((entry["section"], entry["label"], entry["from_period"], entry["to_period"]),
                         ("Instructions:", "Current", "September 2026", "Current"))
        self.assertEqual(entry["page"], PAGE)

    def test_an_old_edition_dropped_from_the_page_is_a_handover_too(self):
        found = succession.handovers(recorded(fed_page(OLD_FORM, OLD_BOOK)), reading(fed_page(OLD_FORM, NEW_BOOK)))
        self.assertEqual([(e["from"], e["to"], e["from_period"]) for e in found], [(OLD_BOOK, NEW_BOOK, "")])

    def test_two_at_once_are_paired_by_section(self):
        found = succession.handovers(recorded(fed_page(OLD_FORM, OLD_BOOK)), reading(fed_page(NEW_FORM, NEW_BOOK)))
        self.assertEqual(sorted((e["from"], e["to"]) for e in found), sorted([(OLD_FORM, NEW_FORM), (OLD_BOOK, NEW_BOOK)]))

    def test_two_at_once_without_recorded_sections_is_left_alone(self):
        before = recorded(fed_page(OLD_FORM, OLD_BOOK))
        for entry in before["pages"][PAGE]["links"].values():
            entry.pop("section", None)  # a record made before sections were kept
        self.assertEqual(succession.handovers(before, reading(fed_page(NEW_FORM, NEW_BOOK))), [])
        # One at a time is still unambiguous.
        found = succession.handovers(before, reading(fed_page(OLD_FORM, NEW_BOOK)))
        self.assertEqual([(e["from"], e["to"]) for e in found], [(OLD_BOOK, NEW_BOOK)])

    def test_nothing_moved_nothing_found(self):
        html = fed_page(OLD_FORM, OLD_BOOK)
        self.assertEqual(succession.handovers(recorded(html), reading(html)), [])
        # A link added with a label nobody lost is just a new link.
        more = fed_page(OLD_FORM, OLD_BOOK, history=((NEW_BOOK, "Current (9 KB .PDF)"),))
        self.assertEqual(succession.handovers(recorded(html), reading(more)), [])

    def test_unread_pages_and_pages_without_a_record_are_skipped(self):
        before = recorded(fed_page(OLD_FORM, OLD_BOOK))
        self.assertEqual(succession.handovers(before, [{"page": PAGE, "links": None}]), [])
        self.assertEqual(succession.handovers(before, reading(fed_page(OLD_FORM, NEW_BOOK), page=FED + "/other")), [])

    def test_a_collapsed_reading_is_not_a_handover(self):
        before = recorded(fed_page(OLD_FORM, OLD_BOOK, history=tuple((DOWNLOAD + f"{i:08d}", f"June 20{i:02d} (1 MB .PDF)") for i in range(10, 22))))
        stub = "<html><body><h6>Instructions:</h6><p><a href='/apps/reportingforms/Download/DownloadAttachment?guid=new'>Current (1 KB .PDF)</a></p></body></html>"
        self.assertEqual(succession.handovers(before, reading(stub)), [])

    @unittest.skipUnless(SAVED_PAGE.exists(), "the saved FR Y-9C page is not in this checkout")
    def test_the_real_fr_y9c_page(self):
        html = SAVED_PAGE.read_text(encoding="utf-8")
        before = recorded(html)
        # The Fed posts a new instruction book: the old one moves into the dated list.
        edition = html.replace("guid=698a2ee2-3603-4151-ac3e-49d695e29e8f\" target=\"_blank\">Current (2.7 MB .PDF)",
                               "guid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\" target=\"_blank\">Current (2.8 MB .PDF)", 1)
        edition = edition.replace("<a href=\"/apps/reportingforms/Download/DownloadAttachment?guid=cfb2ba45",
                                  "<a href=\"/apps/reportingforms/Download/DownloadAttachment?guid=698a2ee2-3603-4151-ac3e-49d695e29e8f\">"
                                  "September 2026 (2.7 MB .PDF)</a></p><p><a href=\"/apps/reportingforms/Download/DownloadAttachment?guid=cfb2ba45", 1)
        self.assertNotEqual(edition, html)
        found = succession.handovers(before, reading(edition), canon=canonical)
        self.assertEqual([(e["from"], e["to"], e["section"], e["from_period"]) for e in found],
                         [(OLD_BOOK, NEW_BOOK, "Instructions:", "September 2026")])
        # The page as saved, read again: no handover.
        self.assertEqual(succession.handovers(before, reading(html)), [])


class UpdateTest(unittest.TestCase):
    def test_a_single_file_monitor_follows_the_new_edition(self):
        handover = succession.handovers(recorded(fed_page(OLD_FORM, OLD_BOOK)), reading(fed_page(OLD_FORM, NEW_BOOK)))
        entries = succession.from_handovers(handover, {OLD_BOOK: "manual-book"}, [], at="t")
        self.assertEqual([(e["from"], e["to"], e["source_id"], e["follow"]) for e in entries], [(OLD_BOOK, NEW_BOOK, "manual-book", True)])
        self.assertEqual(succession.validate({"schema_version": 1, "successions": entries}), [])
        # Already monitored (the crawling monitor read it in the same scan): recorded, not fetched twice.
        entries = succession.from_handovers(handover, {OLD_BOOK: "fed", NEW_BOOK: "fed"}, [], at="t")
        self.assertEqual((entries[0]["follow"], entries[0]["monitored_by"]), (False, "fed"))
        # An unmonitored old link, or one that already has a successor, records nothing.
        self.assertEqual(succession.from_handovers(handover, {}, [], at="t"), [])
        self.assertEqual(succession.from_handovers(handover, {OLD_BOOK: "x"}, [{"from": OLD_BOOK, "to": "y"}], at="t"), [])


DICTIONARY = "| MDRM | Schedule | Line | Description | Data Type |\n| --- | --- | --- | --- | --- |\n"
OLD_TEXT = DICTIONARY + ("| BHCK2170 | HC | 12 | Total assets | Numeric |\n"
                         "| BHCKPU98 | HC-B | M7A | Securities memo | Numeric |\n"
                         "| BHCK0081 | HC | 1a | Noninterest-bearing balances | Numeric |")
NEW_TEXT = DICTIONARY + ("| BHCK2170 | HC | 12 | Total assets | Numeric |\n"
                         "| BHCKPU98 | HC-B | M7A | Securities held, memo 7 | Numeric |\n"
                         "| BHCKPV23 | HC-N | M9A | Off-balance-sheet memo | Numeric |")
CRAWLER = SourceConfig(
    id="fed-detail", name="Federal Reserve forms detail", regulator="Federal Reserve",
    seed_urls=(PAGE,), allowed_prefixes=(FED + "/apps/reportingforms/Report/Index/",), allowed_domains=("www.federalreserve.gov",),
    allowed_urls=(PAGE,), allowed_resource_prefixes=(FED + "/apps/reportingforms/Download/",),
    resource_link_text_patterns=("^Current",),
)


class EngineTest(unittest.TestCase):
    """The monitor that crawls "Current" links reads the new edition against the old one in the same scan."""

    def setUp(self):
        self.page_html = fed_page(OLD_FORM, OLD_BOOK)

    def fetch(self, url, **_kw):
        if url == PAGE:
            return ok(self.page_html.encode())
        return ok(("%PDF-1.4 " + url).encode(), "application/pdf")

    @staticmethod
    def extract(url, content_type, body, **kw):
        if "html" in content_type:
            from regmon.content import extract_content
            return extract_content(url, content_type, body, **kw)
        return (NEW_TEXT if url == NEW_BOOK else OLD_TEXT), "pdf", None

    def scan(self, sandbox):
        return sandbox.scan(self.fetch, extract=self.extract)

    def test_new_edition_is_compared_and_the_old_one_is_marked_replaced(self):
        with Sandbox(source=CRAWLER) as sandbox:
            sandbox.discovered = [PAGE, OLD_FORM, OLD_BOOK]
            first = self.scan(sandbox)
            # What save_outputs records after the scan: the page's links.
            link_lineage.apply(sandbox.data, first["link_observations"])

            # The Fed posts a new instruction book.
            self.page_html = fed_page(OLD_FORM, NEW_BOOK, history=((OLD_BOOK, "September 2026 (2.7 MB .PDF)"),))
            sandbox.discovered = [PAGE, OLD_FORM, NEW_BOOK]
            second = self.scan(sandbox)
            events = {event["event_type"]: event for event in second["report"]["events"] if event["url"] != PAGE}
            self.assertEqual(set(events), {"NEW_URL", "REMOVED_URL"})

            new = events["NEW_URL"]
            self.assertEqual(new["url"], NEW_BOOK)
            self.assertEqual((new["predecessor"]["url"], new["predecessor"]["rule"], new["predecessor"]["section"]),
                             (OLD_BOOK, "label_handover", "Instructions:"))
            self.assertEqual(new["predecessor"]["from_period"], "September 2026")
            self.assertEqual(new["item_codes"]["counts"], {"added": 1, "removed": 1, "amended": 1})
            self.assertIn("description changed 1 (BHCKPU98)", json.dumps(new["spec"]))
            evidence = json.loads((sandbox.root / new["evidence_location"]).read_text(encoding="utf-8"))
            self.assertEqual(evidence["predecessor"]["url"], OLD_BOOK)
            self.assertIn("+| BHCKPV23", evidence["diff"])
            # The AI reads the difference from the previous edition.
            self.assertTrue(any(call.args[2] == "NEW_URL" and "BHCKPV23" in call.args[3] for call in second["analyze_mock"].call_args_list))

            removed = events["REMOVED_URL"]
            self.assertEqual(removed["url"], OLD_BOOK)
            self.assertEqual((removed["successor"]["to"], removed["successor"]["rule"]), (NEW_BOOK, "label_handover"))

            # The alerts say so.
            alerts = {alert["kind"]: alert for alert in notify.build_notifications(second["report"])}
            self.assertEqual(alerts["NEW_URL"]["previous_version"],
                             "New edition of Instructions · Current; the previous one is now listed as September 2026; compared with it")
            self.assertEqual(alerts["REMOVED_URL"]["topic"], "Replaced by a new edition")
            self.assertEqual(alerts["REMOVED_URL"]["replaced_by"], NEW_BOOK)
            self.assertEqual(channels.webhook_payload(alerts["REMOVED_URL"], "")["alert"]["replaced_by"], NEW_BOOK)
            self.assertEqual([p for p in validate_persisted_state(sandbox.data, {CRAWLER.id}) if "successions" in p], [])

    def test_a_new_link_that_took_no_label_is_an_ordinary_new_url(self):
        with Sandbox(source=CRAWLER) as sandbox:
            sandbox.discovered = [PAGE, OLD_FORM, OLD_BOOK]
            link_lineage.apply(sandbox.data, self.scan(sandbox)["link_observations"])
            self.page_html = fed_page(OLD_FORM, OLD_BOOK, history=((NEW_BOOK, "Supplemental (1 MB .PDF)"),))
            sandbox.discovered = [PAGE, OLD_FORM, OLD_BOOK, NEW_BOOK]
            second = self.scan(sandbox)
            new = [event for event in second["report"]["events"] if event["event_type"] == "NEW_URL"]
            self.assertEqual([event["url"] for event in new], [NEW_BOOK])
            self.assertNotIn("predecessor", new[0])
            self.assertNotIn("item_codes", new[0])


if __name__ == "__main__":
    unittest.main()
