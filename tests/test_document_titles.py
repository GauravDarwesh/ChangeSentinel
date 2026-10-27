"""Document titles read from a PDF's own heading (dashboard.js deriveDocumentTitle).

Regression: the FFIEC 009a instructions were titled "FR Y-9C instructions"
because the first FR code cited in the text was taken as the document's own.
"""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def derive(text: str, kind: str = "pdf"):
    script = (
        "const fs = require('fs'); const src = fs.readFileSync(" + json.dumps(str(ROOT / "dashboard.js")) + ", 'utf8');"
        "const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);"
        "const derive = eval('(() => {' + src.slice(src.indexOf('function normalizeHeadText'), src.indexOf('function titleCacheKey')) + '; return deriveDocumentTitle; })()');"
        "console.log(JSON.stringify(derive(" + json.dumps(text) + ", " + json.dumps(kind) + ")));"
    )
    return json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True).stdout)


@unittest.skipUnless(NODE, "node is required for dashboard title tests")
class DocumentTitleTests(unittest.TestCase):
    def test_an_ffiec_instructions_heading_names_the_ffiec_form(self):
        text = ("Federal Financial Institutions Examination Council Instructions for the Preparation of Country Exposure "
                "Information Report Reporting Form FFIEC 009a Effective December 2022 ... banks that file the FR Y-9C ...")
        self.assertEqual(derive(text), {"title": "FFIEC 009a instructions", "subtitle": "Country Exposure Information Report"})

    def test_an_fr_code_cited_inside_an_ffiec_document_is_not_its_title(self):
        text = "FFIEC 102 Market Risk Regulatory Report. Holding companies that file the FR Y-9C must also ..."
        self.assertIsNone(derive(text))

    def test_federal_reserve_titles_are_unchanged(self):
        text = "Instructions for Preparation of Consolidated Financial Statements for Holding Companies Reporting Form FR Y-9C"
        self.assertEqual(derive(text)["title"], "FR Y-9C instructions")


if __name__ == "__main__":
    unittest.main()
