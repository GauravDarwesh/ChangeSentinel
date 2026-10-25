"""Alert-condition suggestions generated from a page (dashboard-lib.js)."""
from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def suggest(page, options=None):
    script = ("const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n"
              "console.log(JSON.stringify(L.conditionSuggestionsFrom(" + json.dumps(page) + ", " + json.dumps(options or {}) + ")));")
    return json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True).stdout)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class SuggestionTests(unittest.TestCase):
    def test_report_codes_documents_and_dates_shape_the_suggestions(self):
        out = suggest({"title": "FR Y-9C reporting forms", "text": "Instructions. Effective March 31, 2027.",
                       "links": [{"text": "FR Y-9C instructions", "format": "PDF"}, {"text": "Form", "format": "PDF"}]})
        self.assertEqual(out[0], "A field, schedule or instruction for FR Y-9C changes")
        self.assertIn("A new PDF is added to this page, or an existing one is replaced", out)
        self.assertIn("A filing deadline, reporting date or effective date changes", out)
        self.assertLessEqual(len(out), 4)

    def test_portuguese_and_spanish_pages(self):
        out = suggest({"title": "Leiaute do documento 5050", "text": "Regras de validação aplicáveis a partir da data-base."}, {"format": "PDF"})
        self.assertIn("A validation rule is added or removed, or its severity changes", out)
        self.assertIn("The file layout, schema or taxonomy changes (fields added, removed or renamed)", out)
        spanish = suggest({"title": "SUCAVE", "text": "Plazo de envío y nueva versión del formato"})
        self.assertIn("A filing deadline, reporting date or effective date changes", spanish)
        self.assertIn("A new version, release or errata is published", spanish)

    def test_a_document_never_gets_page_only_suggestions_and_empty_pages_get_defaults(self):
        doc = suggest({"title": "Annual report", "links": [{"text": "x", "format": "PDF"}]}, {"format": "PDF"})
        self.assertNotIn("A new PDF is added to this page, or an existing one is replaced", doc)
        self.assertEqual(suggest({}), ["A new document, form or user guide is added to this page", "A requirement, threshold or reporting scope changes"])


class ContractTests(unittest.TestCase):
    def test_both_dialogs_use_page_suggestions(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        self.assertIn('id="reviewConditionSuggestions"', html)
        self.assertIn("renderReviewConditionSuggestions();", js)
        self.assertIn("L.conditionSuggestionsFrom({ title: itemTitle(item), text }", js)
        self.assertNotIn("Nothing is generated from the page itself", js)


if __name__ == "__main__":
    unittest.main()
