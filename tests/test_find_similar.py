"""On-demand "Find similar" for one monitored page (dashboard-lib.js)."""
from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
BASE = "https://www.osfi-bsif.gc.ca/sites/default/files/documents/"
TARGET = {"url": BASE + "2027-bcar-rnfpb-rtn-rel-2026-09-10-en.xlsx", "title": "BA - 2027 BCAR sample return (clean)", "format": "Spreadsheet"}
LINKS = [
    {"key": "a", "url": BASE + "2026-bcar-rnfpb-rtn-rel-2025-09-10-en.xlsx", "title": "BA - 2026 BCAR sample return (clean)", "format": "Spreadsheet"},
    {"key": "b", "url": BASE + "2027-bcar-instr-en.pdf", "title": "2027 BCAR instructions", "format": "PDF"},
    {"key": "c", "url": "https://www.osfi-bsif.gc.ca/en/about-osfi/careers", "title": "Careers", "format": "Web page"},
    {"key": "d", "url": TARGET["url"], "title": "Itself", "format": "Spreadsheet"},
]


def run_js(body: str):
    script = "const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");\n" + body
    return json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True).stdout)


@unittest.skipUnless(NODE, "node is required for dashboard library tests")
class RankingTests(unittest.TestCase):
    def test_editions_and_same_report_rank_first_and_noise_is_dropped(self):
        out = run_js("console.log(JSON.stringify(L.rankSimilar(" + json.dumps(TARGET) + ", " + json.dumps(LINKS) + ").map(e => [e.link.key, e.reasons])));")
        self.assertEqual([key for key, _ in out], ["a", "b"])
        self.assertIn("another year's edition", out[0][1])
        self.assertIn("same report BCAR", out[1][1])

    def test_report_codes(self):
        out = run_js("console.log(JSON.stringify(['FR Y-9C schedule HC-R', 'BA - 2027 BCAR sample', 'FR 2028D instructions', 'Careers at the bank'].map(L.reportCodes)));")
        self.assertEqual(out, [["FRY9C"], ["BCAR"], ["FR2028D"], []])

    def test_start_pages_prefer_known_parents_and_skip_file_stores(self):
        out = run_js("console.log(JSON.stringify(L.similarStarts(" + json.dumps(TARGET) + ", { parents: ['https://www.osfi-bsif.gc.ca/en/data-forms/reporting-returns'] })));")
        self.assertEqual(out, ["https://www.osfi-bsif.gc.ca/en/data-forms/reporting-returns", "https://www.osfi-bsif.gc.ca/"])
        page = {"url": "https://www.bcb.gov.br/estabilidadefinanceira/leiautes/5050", "title": "Leiaute 5050", "format": "Web page"}
        starts = run_js("console.log(JSON.stringify(L.similarStarts(" + json.dumps(page) + ")));")
        self.assertEqual(starts[:2], ["https://www.bcb.gov.br/estabilidadefinanceira/leiautes/5050", "https://www.bcb.gov.br/estabilidadefinanceira/leiautes/"])


class ContractTests(unittest.TestCase):
    def test_find_similar_uses_the_review_step_and_ticks_nothing(self):
        js = (ROOT / "dashboard.js").read_text(encoding="utf-8")
        start = js.index("async function findSimilar(")
        module = js[start:js.index("/* ---------- Confirm ---------- */", start)]
        self.assertIn("await crawlStart(start, 2, scope);", module)
        self.assertIn("evidence.parent_url", module)
        self.assertNotIn("a.picked.set", module)
        self.assertIn("data-find-similar", js)
        self.assertIn('Most like \\u201c', js)


if __name__ == "__main__":
    unittest.main()
