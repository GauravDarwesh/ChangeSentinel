"""Link lineage: which page listed which link, and when it was removed."""
import json
import tempfile
import unittest
from pathlib import Path

from regmon import link_lineage as ll

PAGE = "https://www.example.gov/reporting/central"


def html(*links, nav=()):
    body = "".join(f'<a href="{href}">{text}</a>' for href, text in links)
    menu = "".join(f'<a href="{href}">{text}</a>' for href, text in nav)
    return f"<html><body><nav>{menu}</nav><main>{body}</main></body></html>"


class TestExtract(unittest.TestCase):
    def test_links_are_absolute_deduplicated_and_marked_menu_or_content(self):
        page = ('<html><head><base href="https://www.example.gov/assets/"></head><body><nav><a href="/about">About</a>'
                '<a href="guide.pdf">Guide</a></nav><main><a href="guide.pdf#p2">FR 2028 user guide</a>'
                '<a href="mailto:x@example.gov">Mail</a><a href="#top">Top</a><a href="javascript:void(0)">JS</a>'
                f'<a href="{PAGE}">Self</a><a href="sample.xml"><img alt="Sample XML"></a></main></body></html>')
        links = ll.extract_links(page.encode(), PAGE)
        self.assertEqual(list(links), ["https://www.example.gov/about", "https://www.example.gov/assets/guide.pdf",
                                       "https://www.example.gov/assets/sample.xml"])
        self.assertTrue(links["https://www.example.gov/about"]["menu"])
        # Linked from a menu and from the content: content.
        self.assertFalse(links["https://www.example.gov/assets/guide.pdf"]["menu"])
        self.assertEqual(links["https://www.example.gov/assets/sample.xml"]["text"], "Sample XML")


class TestObserve(unittest.TestCase):
    def setUp(self):
        self.lineage = {"schema_version": 1, "pages": {}, "events": []}

    def scan(self, at, *links, nav=()):
        return ll.observe(self.lineage, PAGE, ll.extract_links(html(*links, nav=nav), PAGE), at)

    def test_first_scan_is_a_baseline_then_removals_and_additions_are_dated(self):
        guide = ("https://www.example.gov/fr2028-user-guide-xml.pdf", "FR 2028B/S user guide (XML)")
        sample = ("https://www.example.gov/fr2028b-xml-sample.xml", "FR 2028B sample")
        self.assertEqual(self.scan("2026-10-20T00:00:00+00:00", guide, sample), [])
        events = self.scan("2026-10-26T06:00:00+00:00", sample, ("https://www.example.gov/new.pdf", "New"))
        self.assertEqual([(e["change"], e["url"]) for e in events],
                         [("added", "https://www.example.gov/new.pdf"), ("removed", guide[0])])
        entry = self.lineage["pages"][PAGE]["links"][guide[0]]
        self.assertEqual(entry["removed_at"], "2026-10-26T06:00:00+00:00")
        self.assertEqual(entry["text"], "FR 2028B/S user guide (XML)")
        self.assertEqual(entry["first_seen"], "2026-10-20T00:00:00+00:00")
        rows = ll.find(self.lineage, "2028-user-guide")
        self.assertEqual([(row["page"], row["removed_at"]) for row in rows], [(PAGE, "2026-10-26T06:00:00+00:00")])
        # Back again: restored, no longer removed.
        events = self.scan("2026-10-27T06:00:00+00:00", guide, sample)
        self.assertIn(("restored", guide[0]), [(e["change"], e["url"]) for e in events])
        self.assertNotIn("removed_at", self.lineage["pages"][PAGE]["links"][guide[0]])

    def test_a_not_modified_check_changes_only_the_page_time(self):
        self.scan("2026-10-20T00:00:00+00:00", ("https://www.example.gov/a.pdf", "A"))
        before = json.dumps(self.lineage["pages"][PAGE]["links"])
        self.assertEqual(ll.observe(self.lineage, PAGE, None, "2026-10-21T00:00:00+00:00"), [])
        self.assertEqual(json.dumps(self.lineage["pages"][PAGE]["links"]), before)
        self.assertEqual(self.lineage["pages"][PAGE]["last_scan"], "2026-10-21T00:00:00+00:00")

    def test_a_page_that_suddenly_lists_almost_nothing_does_not_remove_everything(self):
        links = [(f"https://www.example.gov/doc{n}.pdf", f"Doc {n}") for n in range(20)]
        self.scan("2026-10-20T00:00:00+00:00", *links)
        self.assertEqual(self.scan("2026-10-21T00:00:00+00:00", links[0]), [])
        self.assertFalse(any(e.get("removed_at") for e in self.lineage["pages"][PAGE]["links"].values()))
        self.assertIn("last_collapse", self.lineage["pages"][PAGE])


class TestApplyAndBackfill(unittest.TestCase):
    def test_apply_saves_events_newest_first(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary) / "data"
            data.mkdir()
            ll.apply(data, [{"page": PAGE, "at": "2026-10-20T00:00:00+00:00", "links": {"https://x.gov/a": {"text": "A", "menu": False}}}])
            ll.apply(data, [{"page": PAGE, "at": "2026-10-21T00:00:00+00:00", "links": {"https://x.gov/b": {"text": "B", "menu": False}}}])
            saved = json.loads((data / ll.FILE_NAME).read_text())
            self.assertEqual([(e["change"], e["url"]) for e in saved["events"]], [("removed", "https://x.gov/a"), ("added", "https://x.gov/b")])

    def test_backfill_replays_saved_copies_so_past_removals_keep_their_dates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            (data / "evidence").mkdir(parents=True)
            (data / "snapshots" / "html").mkdir(parents=True)
            (data / "snapshots/html/old.html").write_text(html(("https://x.gov/a.pdf", "A"), ("https://x.gov/b.pdf", "B")))
            (data / "snapshots/html/new.html").write_text(html(("https://x.gov/b.pdf", "B")))
            (data / "latest.json").write_text(json.dumps({"schema_version": 2, "sources": {"s": {"u": {
                "canonical_url": PAGE, "first_seen": "2026-10-01T00:00:00+00:00", "last_full_fetch": "2026-10-25T00:00:00+00:00",
                "html_snapshot_location": "data/snapshots/html/new.html"}}}}))
            (data / "evidence/e.json").write_text(json.dumps({"event_type": "CHANGED_URL", "url": PAGE, "timestamp": "2026-10-22T04:00:00+00:00",
                "before": {"html_snapshot_location": "data/snapshots/html/old.html"}, "after": {"html_snapshot_location": "data/snapshots/html/new.html"}}))
            ll.backfill(data)
            page = ll.load(data)["pages"][PAGE]
            self.assertEqual(page["tracking_since"], "2026-10-01T00:00:00+00:00")
            self.assertEqual(page["links"]["https://x.gov/a.pdf"]["removed_at"], "2026-10-22T04:00:00+00:00")
            self.assertNotIn("removed_at", page["links"]["https://x.gov/b.pdf"])


class TestEngineHook(unittest.TestCase):
    def test_the_scan_records_links_for_trusted_sources_only(self):
        engine = (Path(__file__).resolve().parents[1] / "regmon/engine.py").read_text(encoding="utf-8")
        self.assertIn('link_observations.append({"page": url, "at": now, "links": link_lineage.extract_links(html_body, url)})', engine)
        self.assertIn('link_observations.append({"page": url, "at": now, "links": None})', engine)
        self.assertIn('if result["report"].get("baseline_update_allowed")', engine)
        self.assertIn("link_lineage.apply(DATA, observations)", engine)


if __name__ == "__main__":
    unittest.main()
