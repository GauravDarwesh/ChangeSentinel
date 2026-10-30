"""Next-period documents (regmon/succession.py) and the engine reading them against their predecessor."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine_harness import Sandbox, ok
from regmon import succession
from regmon.config import SourceConfig
from regmon.discovery import canonical
from regmon.validate_state import validate_persisted_state

FORMS = "https://www.ffiec.gov/sites/default/files/data/reporting-forms/"
Q3 = FORMS + "FFIEC031_202609_f.pdf"
Q4 = FORMS + "FFIEC031_202612_f.pdf"
Q1 = FORMS + "FFIEC031_202703_f.pdf"
LISTING = "https://www.ffiec.gov/resources/reporting-forms/ffiec031"


def lineage(*links: str, page: str = LISTING, **extra: dict) -> dict:
    entries = {url: {"text": url.rsplit("/", 1)[-1], "menu": False, "first_seen": "2026-10-01T00:00:00+00:00"} for url in links}
    for url, fields in extra.items():
        entries[url].update(fields)
    return {"schema_version": 1, "pages": {page: {"tracking_since": "2026-10-01", "links": entries}}, "events": []}


class IdentityTest(unittest.TestCase):
    def label(self, url):
        ident = succession.identity(url)
        return ident.labels if ident else None

    def test_period_tokens(self):
        self.assertEqual(self.label(Q3), ("2026-09",))
        self.assertEqual(self.label("https://www.osfi-bsif.gc.ca/documents/2027-bcar-rnfpb-rtn-rel-2026-09-10-en.xlsx"),
                         ("2027", "2026-09-10"))
        self.assertEqual(self.label("https://www.frbservices.org/uploads/fr-2510-user-guide-12-31-2022.pdf"), ("2022-12-31",))
        self.assertEqual(self.label("https://x.test/eba/DPM_2026Q3_v2.zip"), ("2026Q3", "v2"))
        self.assertEqual(self.label("https://x.test/files/2026-12/FFIEC031_202612_f.pdf"), ("2026-12", "2026-12"))

    def test_cms_duplicate_suffix_is_ignored(self):
        self.assertEqual(succession.identity(FORMS + "FFIEC030_202503_f_0.pdf").key,
                         succession.identity(FORMS + "FFIEC030_202606_f.pdf").key)

    def test_form_numbers_and_document_numbers_are_not_periods(self):
        self.assertIsNone(succession.identity("https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2028D"))
        self.assertIsNone(succession.identity("https://www.federalreserve.gov/apps/reportingforms/Report/Index/FR_2004"))
        self.assertEqual(self.label("https://www.govinfo.gov/content/pkg/FR-2026-05-22/pdf/2026-10302.pdf"), ("2026-05-22",))
        self.assertIsNone(succession.identity("https://x.test/a/server2/report.pdf"))
        self.assertIsNone(succession.identity("https://x.test/policy"))

    def test_later_means_no_period_goes_back(self):
        q3, q4 = succession.identity(Q3), succession.identity(Q4)
        self.assertTrue(succession.is_later(q4, q3))
        self.assertFalse(succession.is_later(q3, q4))
        self.assertFalse(succession.is_later(q3, q3))
        mixed_a = succession.identity("https://x.test/2027-bcar-2026-09-10.xlsx")
        mixed_b = succession.identity("https://x.test/2028-bcar-2026-06-10.xlsx")
        self.assertFalse(succession.is_later(mixed_b, mixed_a))
        self.assertFalse(succession.is_later(succession.identity(FORMS + "FFIEC041_202612_f.pdf"), q3))


class FindTest(unittest.TestCase):
    def test_the_nearest_later_period_is_the_successor(self):
        found = succession.find(lineage(Q3, Q1, Q4), {Q3: "ffiec031"}, [], at="t")
        self.assertEqual(len(found), 1)
        entry = found[0]
        self.assertEqual((entry["from"], entry["to"], entry["source_id"], entry["follow"]), (Q3, Q4, "ffiec031", True))
        self.assertEqual((entry["from_period"], entry["to_period"], entry["page"]), ("2026-09", "2026-12", LISTING))

    def test_menu_and_removed_links_do_not_count(self):
        self.assertEqual(succession.find(lineage(Q3, Q4, **{Q4: {"removed_at": "x"}}), {Q3: "s"}, []), [])
        self.assertEqual(succession.find(lineage(Q3, Q4, **{Q4: {"menu": True}}), {Q3: "s"}, []), [])

    def test_a_file_with_a_successor_is_not_matched_again(self):
        known = [{"from": Q3, "to": Q4, "source_id": "s", "follow": True}]
        self.assertEqual(succession.find(lineage(Q3, Q4, Q1), {Q3: "s"}, known), [])

    def test_a_successor_monitored_elsewhere_is_recorded_not_followed(self):
        found = succession.find(lineage(Q3, Q4), {Q3: "a", Q4: "b"}, [])
        self.assertEqual(found[0]["follow"], False)
        self.assertEqual(found[0]["monitored_by"], "b")

    def test_a_tie_that_cannot_be_settled_is_not_followed(self):
        other = "https://www.ffiec.gov/sites/default/files/data/reporting-forms/FFIEC031_202612_f_0.pdf"
        found = succession.find(lineage(Q4, other, page="https://www.ffiec.gov/elsewhere"), {Q3: "s"}, [])
        self.assertFalse(found[0]["follow"])
        self.assertEqual(found[0]["candidates"], sorted([Q4, other]))
        # Listed on the page that lists the monitored file: that one wins.
        page = lineage(Q3, Q4)
        page["pages"]["https://www.ffiec.gov/elsewhere"] = lineage(other)["pages"][LISTING]
        found = succession.find(page, {Q3: "s"}, [])
        self.assertEqual((found[0]["to"], found[0]["follow"]), (Q4, True))

    def test_update_saves_once_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "link-lineage.json").write_text(json.dumps(lineage(Q3, Q4)), encoding="utf-8")
            latest = {"schema_version": 2, "sources": {"s": {"u": {"canonical_url": Q3}}}}
            self.assertEqual(succession.update(data, latest, now="t1"), {"added": 1, "total": 1})
            before = (data / succession.FILE_NAME).read_text(encoding="utf-8")
            self.assertEqual(succession.update(data, latest, now="t2"), {"added": 0, "total": 1})
            self.assertEqual((data / succession.FILE_NAME).read_text(encoding="utf-8"), before)
            self.assertEqual(succession.validate(json.loads(before)), [])
            self.assertEqual(succession.followed(data, "s", ("www.ffiec.gov",), ("https://www.ffiec.gov/",)), [Q4])
            self.assertEqual(succession.followed(data, "s", ("www.ffiec.gov",), ("https://www.ffiec.gov/other/",)), [])
            self.assertEqual(succession.followed(data, "s", ("example.test",)), [])
            self.assertEqual(succession.followed(data, "other"), [])

    def test_validate(self):
        good = {"schema_version": 1, "successions": [{"from": Q3, "to": Q4, "source_id": "s", "follow": True}]}
        self.assertEqual(succession.validate(good), [])
        bad = {"schema_version": 1, "successions": [{"from": Q3, "to": Q3, "source_id": "s", "follow": "yes"},
                                                    {"from": Q3, "to": Q1, "source_id": "s", "follow": True}]}
        problems = " ".join(succession.validate(bad))
        self.assertIn("succeeds itself", problems)
        self.assertIn("follow must be true or false", problems)
        self.assertIn("more than one successor", problems)


DICTIONARY = "| MDRM | Schedule | Line | Description | Data Type |\n| --- | --- | --- | --- | --- |\n"
Q3_TEXT = DICTIONARY + ("| BHCK2170 | HC | 12 | Total assets | Numeric |\n"
                        "| BHCK3210 | HC | 27a | Total equity capital | Numeric |\n"
                        "| BHCK0081 | HC | 1a | Noninterest-bearing balances | Numeric |")
Q4_TEXT = DICTIONARY + ("| BHCK2170 | HC | 12 | Total assets | Numeric |\n"
                        "| BHCK3210 | HC | 27a | Total bank holding company equity capital | Numeric |\n"
                        "| BHCKC447 | HC-R | 48 | Tier 1 leverage ratio | Percent |")
SOURCE = SourceConfig(
    id="ffiec031", name="Call Report Forms: FFIEC 031", regulator="www.ffiec.gov",
    seed_urls=(Q3,), allowed_prefixes=("https://www.ffiec.gov/",), allowed_domains=("www.ffiec.gov",), allowed_urls=(Q3,),
)


class EngineTest(unittest.TestCase):
    """The successor is fetched by the predecessor's monitor and read against it."""

    @staticmethod
    def extract(url, content_type, body, **_kw):
        return (Q4_TEXT if "202612" in url else Q3_TEXT), "pdf", None

    @staticmethod
    def fetch(url, **_kw):
        return ok(("%PDF-1.4 " + url).encode(), "application/pdf")

    def test_next_period_is_read_against_the_previous_one(self):
        with Sandbox(source=SOURCE) as sandbox:
            sandbox.scan(self.fetch, extract=self.extract)
            # The forms page now lists next quarter's file.
            (sandbox.data / "link-lineage.json").write_text(json.dumps(lineage(Q3, Q4)), encoding="utf-8")
            latest = json.loads((sandbox.data / "latest.json").read_text(encoding="utf-8"))
            self.assertEqual(succession.update(sandbox.data, latest, canon=canonical)["added"], 1)
            # A reporting team that maps total equity capital to its warehouse.
            (sandbox.root / "config").mkdir()
            (sandbox.root / "config" / "registry.json").write_text(json.dumps({
                "schema_version": 1,
                "consumers": [{"id": "hc-load", "kind": "pipeline", "name": "FR Y-9C HC load", "owner": "Reg Reporting"}],
                "items": [{"code": "BHCK3210", "scheme": "MDRM", "form": "FFIEC 031", "consumers": ["hc-load"]}],
                "rules": [],
            }), encoding="utf-8")

            second = sandbox.scan(self.fetch, extract=self.extract)
            events = second["report"]["events"]
            self.assertEqual([event["event_type"] for event in events], ["NEW_URL"])
            event = events[0]
            self.assertEqual(event["url"], Q4)
            self.assertEqual(event["predecessor"]["url"], Q3)
            self.assertEqual((event["predecessor"]["from_period"], event["predecessor"]["to_period"]), ("2026-09", "2026-12"))
            # Item by item, as for a changed page.
            self.assertEqual(event["item_codes"]["counts"], {"added": 1, "removed": 1, "amended": 1})
            self.assertEqual(sorted(event["item_codes"]["codes"]), ["BHCK0081", "BHCK3210", "BHCKC447"])
            self.assertIn("description changed 1 (BHCK3210)", json.dumps(event["spec"]))
            self.assertIn("FR Y-9C HC load", json.dumps(event["impact"]))
            evidence = json.loads((sandbox.root / event["evidence_location"]).read_text(encoding="utf-8"))
            self.assertEqual(evidence["predecessor"]["url"], Q3)
            q3_record = next(r for r in sandbox.inventory().values() if r["canonical_url"] == Q3)
            self.assertEqual(evidence["before"]["normalized_hash"], q3_record["normalized_hash"])
            self.assertIn("+| BHCKC447", evidence["diff"])
            self.assertIn("spec_diff", evidence)
            # The AI is given what changed from the previous period, not the whole file.
            args = second["analyze_mock"].call_args.args
            self.assertEqual(args[2], "NEW_URL")
            self.assertIn("BHCKC447", args[3])
            # Both files stay monitored; the timeline records the link.
            records = {r["canonical_url"]: r for r in sandbox.inventory().values()}
            self.assertEqual(set(records), {Q3, Q4})
            self.assertEqual(records[Q4]["change_history"][0]["predecessor"]["url"], Q3)
            self.assertEqual([p for p in validate_persisted_state(sandbox.data, {SOURCE.id}) if "successions" in p], [])

            third = sandbox.scan(self.fetch, extract=self.extract)
            self.assertEqual(third["report"]["events"], [])

    def test_an_unrelated_new_url_is_not_compared(self):
        with Sandbox(source=SOURCE) as sandbox:
            sandbox.scan(self.fetch, extract=self.extract)
            sandbox.discovered.append(Q4)
            result = sandbox.scan(self.fetch, extract=self.extract)
            event = result["report"]["events"][0]
            self.assertEqual(event["event_type"], "NEW_URL")
            self.assertNotIn("predecessor", event)
            self.assertNotIn("item_codes", event)
            self.assertEqual(result["analyze_mock"].call_args.args[3], "")

    def test_a_successor_outside_the_monitors_scope_is_not_fetched(self):
        narrow = SourceConfig(**{**SOURCE.__dict__, "allowed_prefixes": ("https://www.ffiec.gov/sites/default/files/data/other/",)})
        with Sandbox(source=narrow) as sandbox:
            sandbox.scan(self.fetch, extract=self.extract)
            (sandbox.data / "link-lineage.json").write_text(json.dumps(lineage(Q3, Q4)), encoding="utf-8")
            succession.update(sandbox.data, json.loads((sandbox.data / "latest.json").read_text(encoding="utf-8")), canon=canonical)
            result = sandbox.scan(self.fetch, extract=self.extract)
            self.assertEqual(result["report"]["events"], [])


class AlertTest(unittest.TestCase):
    def test_the_alert_names_the_previous_version(self):
        from regmon import channels, notify
        predecessor = {"url": Q3, "from_period": "2026-09", "to_period": "2026-12"}
        event = {"event_id": "e1", "event_type": "NEW_URL", "url": Q4, "predecessor": predecessor}
        analysis = {"relevant": True, "topic": "Call Report", "summary": "s", "reason": "r", "impact": "i"}
        report = {"events": [event], "ai_results": [{"event_id": "e1", "event": "NEW_URL", "url": Q4,
                                                     "ai": {"status": "ok", "analysis": analysis}}]}
        alert = notify.build_notifications(report)[0]
        self.assertEqual(alert["previous_version"], "Next period of FFIEC031_202609_f.pdf (2026-09 → 2026-12); compared with it")
        self.assertEqual(channels.webhook_payload(alert, "")["alert"]["previous_version"], alert["previous_version"])
        self.assertEqual(notify.succession_line(None), "")


if __name__ == "__main__":
    unittest.main()
