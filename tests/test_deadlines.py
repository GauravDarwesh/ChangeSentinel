"""Regulatory dates from detected changes: calendar.json and the .ics feed."""
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from regmon import deadlines

TODAY = date(2026, 10, 21)
DIFF = "\n".join([
    "--- before", "+++ after", "@@ -1,3 +1,4 @@", " Proposed revisions to the FR 2028D",
    "-Comments must be received on or before January 4, 2027.",
    "+Comments must be received on or before February 1, 2027.",
    "+The revised form is effective for the June 30, 2027, report date.",
    "+This authority has applied effective as of July 21, 2011.",
    " Contact us",
])


class TestDateFinding(unittest.TestCase):
    def test_phrases_and_formats(self):
        text = ("Comments must be received on or before March 2, 2027. The revised form is effective for the "
                "June 30, 2027, report date. Effective as of 31 December 2026 the threshold rises. Reports are due by 04/15/2027.")
        found = [(hit["kind"], hit["date"]) for hit in deadlines.dates_in_text(text, TODAY)]
        self.assertEqual(found, [("comments_due", "2027-03-02"), ("report_date", "2027-06-30"),
                                 ("effective", "2026-12-31"), ("due", "2027-04-15")])

    def test_each_quote_is_its_own_sentence(self):
        hit = deadlines.dates_in_text("Background. Comments are due by March 2, 2027. Other text.", TODAY)[0]
        self.assertEqual(hit["quote"], "Comments are due by March 2, 2027.")

    def test_dates_without_a_recognised_phrase_are_ignored(self):
        self.assertEqual(deadlines.dates_in_text("Published March 2, 2027. Last updated 2026-10-01.", TODAY), [])

    def test_impossible_and_far_future_dates_are_ignored(self):
        self.assertEqual(deadlines.dates_in_text("Effective February 30, 2027. Effective January 1, 2099.", TODAY), [])

    def test_only_added_diff_lines_count(self):
        self.assertNotIn("January 4, 2027", deadlines.added_lines(DIFF))
        self.assertIn("February 1, 2027", deadlines.added_lines(DIFF))


class TestCalendarBuild(unittest.TestCase):
    def make_tree(self, root: Path, ai_relevant=None, analysis=None):
        data = root / "data"
        (data / "evidence").mkdir(parents=True)
        (data / "history").mkdir()
        (root / "config").mkdir()
        (root / "config" / "sources.json").write_text(json.dumps({"sources": [{"id": "fed", "active": True}, {"id": "old", "active": False}]}))
        (data / "evidence" / "e1.json").write_text(json.dumps({"diff": DIFF}))
        change = {"event_id": "e1", "event_type": "CHANGED_URL", "timestamp": "2026-10-20T06:00:00+00:00", "evidence_location": "data/evidence/e1.json"}
        if ai_relevant is not None:
            change["ai_relevant"] = ai_relevant
        item = {"canonical_url": "https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2028D", "change_history": [change]}
        (data / "latest.json").write_text(json.dumps({"schema_version": 2, "sources": {"fed": {"u1": item}, "old": {"u2": item}}}))
        if analysis is not None:
            (data / "history" / "run.json").write_text(json.dumps({"ai_results": [{"event_id": "e1", "ai": {"status": "ok", "analysis": analysis}}]}))
        return data, root / "config" / "sources.json"

    def test_dates_from_the_change_and_its_ai_review(self):
        analysis = {"relevant": True, "topic": "FR 2028D comment period extended", "effective_date": "Effective for the June 30, 2027 report date"}
        with tempfile.TemporaryDirectory() as tmp:
            data, config = self.make_tree(Path(tmp), analysis=analysis)
            entries = deadlines.build(data, config, TODAY)["entries"]
        found = [(entry["date"], entry["kind"], entry["basis"]) for entry in entries]
        # The AI and the text agree on 30 June; the AI's statement is kept once alongside the text's.
        self.assertIn(("2027-02-01", "comments_due", "text"), found)
        self.assertIn(("2027-06-30", "report_date", "text"), found)
        self.assertIn(("2027-06-30", "ai_effective", "ai"), found)
        # A date restated from 2011 is history, not a deadline; inactive sources are skipped.
        self.assertFalse(any(entry["date"].startswith("2011") for entry in entries))
        self.assertTrue(all(entry["source_id"] == "fed" and entry["title"] == "FR 2028D comment period extended" for entry in entries))

    def test_a_change_judged_not_relevant_contributes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, config = self.make_tree(Path(tmp), ai_relevant=False)
            self.assertEqual(deadlines.build(data, config, TODAY)["entries"], [])

    def test_unreviewed_changes_still_contribute_their_stated_dates(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, config = self.make_tree(Path(tmp))
            entries = deadlines.build(data, config, TODAY)["entries"]
        self.assertEqual({entry["title"] for entry in entries}, {"FR 2028D reporting form"})

    def test_feed_is_valid_ics_and_only_rewritten_on_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, config = self.make_tree(Path(tmp))
            self.assertTrue(deadlines.write(data, config, TODAY))
            first = (data / "calendar.ics").read_bytes()
            self.assertFalse(deadlines.write(data, config, TODAY))
            self.assertEqual((data / "calendar.ics").read_bytes(), first)
        text = first.decode("utf-8")
        self.assertTrue(text.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"))
        self.assertTrue(text.endswith("END:VCALENDAR\r\n"))
        self.assertIn("DTSTART;VALUE=DATE:20270201", text)
        self.assertIn("SUMMARY:Comments due: FR 2028D reporting form", text)
        self.assertIn("#changes/e1", text.replace("\r\n ", ""))
        self.assertTrue(all(len(line.encode("utf-8")) <= 75 for line in text.split("\r\n")))
        self.assertRegex(text, r"DTSTAMP:\d{8}T\d{6}Z")


if __name__ == "__main__":
    unittest.main()
