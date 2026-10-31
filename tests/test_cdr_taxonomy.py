"""FFIEC CDR Call Report taxonomies through the CDR's JSON router (regmon/cdr_taxonomy.py)."""
from __future__ import annotations

import base64
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine_harness import Sandbox
from regmon import cdr_taxonomy, discovery
from regmon.config import SourceConfig

URL = "https://cdr.ffiec.gov/public/DownloadTaxonomy.aspx?form=031"
SPEC = {"kind": "ffiec_cdr_call_taxonomy", "form": "031"}

EDITS = """<?xml version="1.0" encoding="utf-8"?>
<link:linkbase xmlns="https://www.cdr.ffiec.gov/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:link="http://www.xbrl.org/2003/linkbase">
  <formulaLink xlink:type="extended">
    <loc xlink:type="locator" xlink:href="call-report031.xsd#ffiec031_0110" xlink:label="ffiec031_0110" />
    <formulaArc xlink:type="arc" xlink:from="ffiec031_0110" xlink:to="ffiec031_0110_formula" />
    <formula xlink:type="resource" xlink:role="https://www.cdr.ffiec.gov/xbrl/rule/ruleType2" xlink:label="ffiec031_0110_formula" select="{logic}" />
  </formulaLink>
</link:linkbase>
"""


def taxonomy(logic: str = "cc:RCON2170[P0] &gt; 0", stamp=(2026, 9, 22, 14, 20, 0)) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(zipfile.ZipInfo("call-report031-2026-09-30-v301-ec.xml", stamp), EDITS.replace("{logic}", logic))
        archive.writestr(zipfile.ZipInfo("concepts.xsd", stamp), "<schema/>")
    return buffer.getvalue()


class Response:
    def __init__(self, data, status: int = 200, raw: bytes | None = None):
        self.status_code = status
        self.content = raw if raw is not None else json.dumps(data).encode()
        self._data = data

    def json(self):
        if self._data is ValueError:
            raise ValueError("not json")
        return self._data


class FakeCDR:
    """The router as DownloadTaxonomy.js uses it."""

    def __init__(self, dates=None, files=None, wrap=lambda data: data):
        self.dates = dates if dates is not None else [
            {"taxonomyid": 41, "formatteddate": "06/30/2026"},
            {"taxonomyid": 42, "formatteddate": "09/30/2026"},
            {"taxonomyid": 40, "formatteddate": "03/31/2026"},
        ]
        self.files = files if files is not None else {
            "Message": "success", "FileName031": "Call__09302026_Form031.zip",
            "Content031Base64": base64.b64encode(taxonomy()).decode(), "FileName041": "", "Content041Base64": "",
        }
        self.wrap = wrap
        self.posts: list[dict] = []
        self.headers = {}

    def get(self, url, **_kw):
        assert url == cdr_taxonomy.PAGE
        return Response(None, raw=b"<html></html>")

    def post(self, url, data=None, **_kw):
        assert url == cdr_taxonomy.ROUTER
        payload = json.loads(data)
        self.posts.append(payload)
        if payload.get("RequestorID") == "TaxonomyEndDateList":
            return Response(self.wrap(self.dates))
        assert payload == {"RequestorID": "PDDManagement", "Subject": "PDDActions", "Action": "GetCallTaxonomyFiles", "TaxonomyId": 42}
        return Response(self.wrap([self.files]))


class ClientTest(unittest.TestCase):
    def setUp(self):
        cdr_taxonomy._CACHE.clear()

    def fetch(self, cdr: FakeCDR, spec=SPEC, url=URL):
        with patch.object(cdr_taxonomy, "_session", return_value=cdr):
            return cdr_taxonomy.fetch(spec, url)

    def test_newest_taxonomy_for_the_form(self):
        cdr = FakeCDR()
        result = self.fetch(cdr)
        self.assertEqual((result.status_code, result.content_type), (200, "application/zip"))
        self.assertTrue(result.body.startswith(b"PK"))
        self.assertEqual(result.raw_hash, cdr_taxonomy.content_hash(taxonomy()))
        self.assertEqual(cdr.posts[0], cdr_taxonomy.DATE_LIST)

    def test_the_router_answer_may_be_wrapped(self):
        for wrap in (lambda data: {"d": data}, lambda data: json.dumps(data), lambda data: {"d": json.dumps(data)}):
            cdr_taxonomy._CACHE.clear()
            self.assertTrue(self.fetch(FakeCDR(wrap=wrap)).body.startswith(b"PK"))

    def test_one_scan_asks_the_cdr_once_for_all_three_forms(self):
        cdr = FakeCDR()
        self.fetch(cdr)
        self.fetch(cdr)
        self.assertEqual(len(cdr.posts), 2)

    def test_the_fingerprint_ignores_archive_timestamps(self):
        self.assertEqual(cdr_taxonomy.content_hash(taxonomy(stamp=(2026, 9, 22, 14, 20, 0))),
                         cdr_taxonomy.content_hash(taxonomy(stamp=(2026, 10, 31, 1, 2, 4))))
        self.assertNotEqual(cdr_taxonomy.content_hash(taxonomy()), cdr_taxonomy.content_hash(taxonomy("cc:RCON2170[P0] &gt;= 0")))

    def test_failures_are_named(self):
        cases = [
            (FakeCDR(files={"Message": "No files for the selected date"}), "No files for the selected date"),
            (FakeCDR(dates=[]), "listed no Call Report taxonomies"),
            (FakeCDR(files={"Message": "success", "Content031Base64": "not base64!"}), "not valid base64"),
            (FakeCDR(files={"Message": "success", "Content031Base64": base64.b64encode(b"<html>").decode()}), "not a ZIP"),
            (FakeCDR(files={"Message": "success", "Content041Base64": "x"}), "has no FFIEC 031 file"),
        ]
        for cdr, message in cases:
            cdr_taxonomy._CACHE.clear()
            with self.assertRaises(cdr_taxonomy.CDRError) as caught:
                self.fetch(cdr)
            self.assertIn(message, str(caught.exception))

    def test_a_page_instead_of_json(self):
        class Blocked(FakeCDR):
            def post(self, url, data=None, **_kw):
                return Response(ValueError, raw=b"<html>Just a moment...</html>")
        with self.assertRaises(cdr_taxonomy.CDRError) as caught:
            self.fetch(Blocked())
        self.assertIn("did not answer with JSON", str(caught.exception))

    def test_only_cdr_addresses(self):
        with self.assertRaises(cdr_taxonomy.CDRError):
            self.fetch(FakeCDR(), url="https://example.gov/x?form=031")

    def test_latest_by_date_or_first(self):
        self.assertEqual(cdr_taxonomy.latest([{"taxonomyid": 1, "formatteddate": "12/31/2025"},
                                             {"taxonomyid": 2, "formatteddate": "9/30/2026"}])["taxonomyid"], 2)
        self.assertEqual(cdr_taxonomy.latest([{"taxonomyid": 7, "formatteddate": "?"}, {"taxonomyid": 8}])["taxonomyid"], 7)

    def test_config_validation(self):
        cdr_taxonomy.validate(SPEC)
        for bad in ({"kind": "other", "form": "031"}, {"kind": cdr_taxonomy.KIND, "form": "002"},
                    {"kind": cdr_taxonomy.KIND, "form": "031", "x": 1}, "031"):
            with self.assertRaises(ValueError):
                cdr_taxonomy.validate(bad)


SOURCE = SourceConfig(id="cdr-031", name="FFIEC 031 Call Report taxonomy", regulator="FFIEC", seed_urls=(URL,),
                      allowed_prefixes=("https://cdr.ffiec.gov/",), allowed_domains=("cdr.ffiec.gov",), allowed_urls=(URL,),
                      fetch_api=SPEC)


class EngineTest(unittest.TestCase):
    def test_discovery_reports_the_seed_without_fetching(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(discovery, "http_discover", side_effect=AssertionError("crawled")):
            self.assertEqual(discovery.discover(SOURCE, Path(tmp)), [URL])
            self.assertEqual(json.loads((Path(tmp) / "discovery" / "cdr-031.json").read_text())["state"], "COMPLETE")

    def test_next_quarter_is_an_edit_by_edit_change(self):
        def served(logic, stamp):
            body = taxonomy(logic, stamp)
            return lambda *_a, **_k: cdr_taxonomy.FetchResult(200, "application/zip", len(body), None, None,
                                                              cdr_taxonomy.content_hash(body), body, False)
        with Sandbox(source=SOURCE) as sandbox:
            with patch("regmon.engine.cdr_taxonomy.fetch", side_effect=served("cc:RCON2170[P0] &gt; 0", (2026, 9, 22, 0, 0, 0))):
                sandbox.scan(lambda *a, **k: self.fail("a page fetch for an API monitor"))
            # The same taxonomy built again: nothing new, nothing saved twice.
            with patch("regmon.engine.cdr_taxonomy.fetch", side_effect=served("cc:RCON2170[P0] &gt; 0", (2026, 10, 1, 0, 0, 0))):
                again = sandbox.scan(lambda *a, **k: self.fail("a page fetch for an API monitor"))
            self.assertEqual(again["report"]["events"], [])
            self.assertEqual(len(list((sandbox.data / "snapshots" / "files").glob("*.zip"))), 1)
            with patch("regmon.engine.cdr_taxonomy.fetch", side_effect=served("cc:RCON2170[P0] &gt;= 0", (2026, 12, 20, 0, 0, 0))):
                changed = sandbox.scan(lambda *a, **k: self.fail("a page fetch for an API monitor"))
            event = next(e for e in changed["report"]["events"] if e["event_type"] == "CHANGED_URL")
            self.assertIn("logic changed 1 (0110)", event["spec"]["headline"])


if __name__ == "__main__":
    unittest.main()
