"""The public spec changelog: an append-only, hash-chained record of substantive spec changes."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from regmon import changelog as C
from regmon import validate_state

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
DIFF = "--- before\n+++ after\n@@ -1,3 +1,3 @@\n same\n-old line\n+new line\n+another\n"


def event(event_id: str, at: str, event_type: str = "CHANGED_URL", **extra) -> dict:
    return {"event_id": event_id, "event_type": event_type, "timestamp": at, "evidence_location": f"data/evidence/{event_id}.json", **extra}


class Fixture:
    def __init__(self, tmp: Path):
        self.data = tmp / "data"
        self.config = tmp / "config"
        (self.data / "evidence").mkdir(parents=True)
        self.config.mkdir()
        (self.config / "sources.json").write_text(json.dumps({"sources": [
            {"id": "s1", "name": "FR Y-9C instructions (PDF, 2.1 MB)"}, {"id": "s2", "name": "OSFI BCAR technical specification"}]}))
        (self.config / "regulators.json").write_text(json.dumps({"regulators": [
            {"id": "fed", "short_name": "Federal Reserve", "hosts": ["federalreserve.gov"]}, {"id": "osfi", "short_name": "OSFI", "hosts": ["osfi-bsif.gc.ca"]}]}))
        self.records = {"s1": {}, "s2": {}}
        self.facts = {}

    def add(self, source: str, url: str, entry: dict, facts: dict, evidence: dict | None = None):
        record = self.records[source].setdefault(url, {"canonical_url": url, "url_id": url[-8:], "change_history": []})
        record["change_history"].append(entry)
        self.facts[entry["event_id"]] = {"at": entry["timestamp"], "type": entry["event_type"], **facts}
        (self.data / "evidence" / f"{entry['event_id']}.json").write_text(json.dumps({"url": url, "diff": DIFF, **(evidence or {})}))
        self.save()

    def save(self):
        (self.data / "latest.json").write_text(json.dumps({"sources": self.records}))
        (self.data / "change-facts.json").write_text(json.dumps({"events": self.facts}))


TEXT = {"forms": [{"form": "FR Y-9C", "basis": ["monitor"]}], "severity": {"level": 1, "kind": "text", "label": "Text changed"}}
MARKUP = {"forms": [{"form": "FR Y-9C", "basis": ["monitor"]}], "severity": {"level": 0, "kind": "markup", "label": "Markup only (text unchanged)"}}
EDITS = {"forms": [{"form": "OSFI BCAR", "basis": ["monitor"]}], "severity": {"level": 4, "kind": "edit", "label": "Edit check changed", "detail": "59 edit checks changed"},
         "effective": {"quarter": "Q1 2027", "date": "2027-01-01"}, "codes": [[f"BHCK{n:04d}", "amended", "Q1 2027", ["FR Y-9C"]] for n in range(25)]}
SPEC = {"spec_diff": {"headline": "Conventional Rules: new rule 1 (CR-1); logic changed 33.", "counts": {"added": 1, "logic": 33}, "tables": [{"kind": "rules"}]}}


class ChangelogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.f = Fixture(Path(self.tmp.name))
        self.f.add("s1", "https://www.federalreserve.gov/y9c.pdf", event("a1", "2026-10-20T00:00:00+00:00"), TEXT)
        self.f.add("s1", "https://www.federalreserve.gov/y9c.pdf", event("a0", "2026-10-21T00:00:00+00:00", "HTML_SOURCE_CHANGED"), MARKUP)
        self.f.add("s2", "https://www.osfi-bsif.gc.ca/bcar-2026-10-30.xlsx",
                   event("b1", "2026-10-30T22:17:00+00:00", "NEW_URL", predecessor={"url": "https://www.osfi-bsif.gc.ca/bcar-2026-09-10.xlsx"}), EDITS, SPEC)

    def write(self, now="2026-11-01T03:00:00Z"):
        return C.write(self.f.data, self.f.config, now=now)

    def ledger(self):
        return C.read_ledger(self.f.data)

    def test_records_substantive_changes_once_in_a_verifiable_chain(self):
        result = self.write()
        self.assertEqual((result["entries"], result["added"]), (2, 2))
        entries = self.ledger()
        self.assertEqual([entry["id"] for entry in entries], ["a1", "b1"])  # markup-only a0 left out
        self.assertEqual(C.verify(entries), [])
        self.assertEqual(entries[0]["prev"], C.GENESIS)
        self.assertEqual(entries[1]["prev"], entries[0]["hash"])
        first, second = entries
        self.assertEqual(first["title"], "FR Y-9C instructions · y9c.pdf")
        self.assertEqual(first["regulator"], "Federal Reserve")
        self.assertEqual(first["summary"], "Text changed: 2 lines added and 1 line removed.")
        self.assertEqual(second["summary"], "Conventional Rules: new rule 1 (CR-1); logic changed 33.")
        self.assertEqual((second["effective"], second["predecessor"], len(second["codes"]), second["codes_total"]),
                         ("Q1 2027", "https://www.osfi-bsif.gc.ca/bcar-2026-09-10.xlsx", 20, 25))
        self.assertEqual(second["codes"][0], ["BHCK0000", "amended", "Q1 2027"])
        self.assertEqual(second["counts"], {"lines": {"added": 2, "removed": 1}, "spec": {"added": 1, "logic": 33}})

    def test_append_only_and_idempotent(self):
        self.write()
        folder = self.f.data / "changelog"
        before = {path.name: path.read_text() for path in folder.iterdir()}
        self.assertEqual(self.write("2026-11-02T03:00:00Z")["added"], 0)
        self.assertEqual({path.name: path.read_text() for path in folder.iterdir()}, before)  # nothing rewritten, not even the stamp
        head = self.ledger()[-1]["hash"]
        # A later, better reading of a recorded event never rewrites it.
        self.f.facts["a1"]["severity"] = {"level": 3, "kind": "item", "label": "Reported items changed"}
        self.f.add("s1", "https://www.federalreserve.gov/y9c.pdf", event("a2", "2026-10-19T00:00:00+00:00"), TEXT)  # backfilled, older
        self.assertEqual(self.write("2026-11-03T03:00:00Z")["added"], 1)
        entries = self.ledger()
        self.assertEqual([entry["id"] for entry in entries], ["a1", "b1", "a2"])
        self.assertEqual(entries[0]["severity"]["level"], 1)
        self.assertEqual((entries[2]["prev"], entries[2]["recorded"]), (head, "2026-11-03T03:00:00Z"))
        self.assertEqual(C.verify(entries), [])

    def test_tampering_is_detected_and_the_chain_is_not_extended(self):
        self.write()
        path = self.f.data / "changelog" / C.LEDGER
        path.write_text(path.read_text().replace("2 lines added", "3 lines added"))
        self.assertIn("entry 1: hash does not match its content", C.verify(self.ledger()))
        self.assertTrue(C.validate(self.f.data))
        # Reported, and refused by CI, but never a reason to stop a scan from committing.
        self.assertIn("changelog", " ".join(validate_state.persisted_state_warnings(self.f.data)))
        self.assertNotIn("changelog", " ".join(validate_state.validate_persisted_state(self.f.data, set())))
        self.f.add("s1", "https://www.federalreserve.gov/y9c.pdf", event("a3", "2026-10-31T00:00:00+00:00"), TEXT)
        with self.assertRaisesRegex(ValueError, "broken"):
            self.write()
        lines = path.read_text().splitlines()
        path.write_text("\n".join([lines[1], lines[0]]) + "\n")  # reordered
        self.assertTrue(any("seq" in problem or "prev" in problem for problem in C.verify(self.ledger())))

    def test_feeds(self):
        self.write()
        folder = self.f.data / "changelog"
        index = json.loads((folder / "index.json").read_text())
        self.assertEqual(index["head"], self.ledger()[-1]["hash"])
        self.assertEqual([form["slug"] for form in index["forms"]], ["fr-y-9c", "osfi-bcar"])
        self.assertEqual(index["forms"][1]["levels"]["4"], 1)
        feed = json.loads((folder / "osfi-bcar.json").read_text())
        entry = feed["entries"][0]
        self.assertEqual(entry["links"]["evidence"], f"https://github.com/{C.REPOSITORY}/blob/main/data/evidence/b1.json")
        self.assertEqual(C.entry_hash(entry), entry["hash"])  # the links sit outside the hash
        atom = ET.fromstring((folder / "osfi-bcar.atom").read_text())
        ns = {"a": "http://www.w3.org/2005/Atom"}
        entries = atom.findall("a:entry", ns)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].find("a:id", ns).text, "urn:changesentinel:event:b1")
        self.assertIn("OSFI BCAR: Edit check changed", entries[0].find("a:title", ns).text)
        self.assertIn("Takes effect: Q1 2027.", entries[0].find("a:content", ns).text)
        self.assertEqual(len(ET.fromstring((folder / "all.atom").read_text()).findall("a:entry", ns)), 2)
        # A form no entry names any more loses its view; the ledger is kept.
        (folder / "old-form.json").write_text("{}")
        self.write()
        self.assertFalse((folder / "old-form.json").exists())

    @unittest.skipUnless(NODE, "node is required for the page's own check")
    def test_the_public_page_hashes_entries_exactly_as_python(self):
        self.f.facts["a1"]["forms"] = [{"form": "FR Y-9C — “HC-R”", "basis": ["monitor"]}]  # non-ASCII, quotes
        self.f.save()
        self.write()
        page = (ROOT / "changelog.html").read_text()
        functions = "\n".join(re.search(r"(    function canonical\(value\) \{.*?\n    \})", page, re.S).groups())
        lines = (self.f.data / "changelog" / C.LEDGER).read_text().splitlines()
        script = (functions + "\nconst crypto = require('crypto');\n" +
                  f"const lines = {json.dumps(lines)};\n" +
                  "console.log(JSON.stringify(lines.map(line => { const e = JSON.parse(line); const b = {}; Object.keys(e).forEach(k => { if (k !== 'hash' && k !== 'links') b[k] = e[k]; });"
                  " return crypto.createHash('sha256').update(canonical(b), 'utf8').digest('hex') === e.hash; })));")
        result = json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30, check=True).stdout)
        self.assertEqual(result, [True, True])


class RealDataTest(unittest.TestCase):
    def test_the_recorded_changes_build_a_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            data.mkdir()
            for name in ("latest.json", "change-facts.json"):
                shutil.copy(ROOT / "data" / name, data / name)
            shutil.copytree(ROOT / "data" / "evidence", data / "evidence")
            result = C.write(data, ROOT / "config", now="2026-11-01T00:00:00Z")
            entries = C.read_ledger(data)
            self.assertEqual(C.verify(entries), [])
            self.assertEqual(result["entries"], len(entries))
            facts = json.loads((ROOT / "data" / "change-facts.json").read_text())["events"]
            self.assertEqual({entry["id"] for entry in entries}, {event_id for event_id, fact in facts.items()
                                                                  if fact["severity"]["level"] >= 1 and fact["type"] in C.TYPES})
            self.assertTrue(all(entry["summary"] for entry in entries))


class WiringTest(unittest.TestCase):
    def test_scan_pages_and_state_check(self):
        engine = (ROOT / "regmon" / "engine.py").read_text()
        self.assertIn("changelog.write(DATA, DEFAULT_CONFIG_PATH.parent)", engine)
        self.assertLess(engine.index("applicability.write(DATA"), engine.index("changelog.write(DATA"))
        pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text()
        self.assertIn("cp changelog.html site/changelog.html", pages)
        self.assertIn("cp data/changelog/* site/data/changelog/", pages)
        self.assertIn("return changelog.validate(data_dir)", (ROOT / "regmon" / "validate_state.py").read_text())
        self.assertIn("python -m regmon.changelog verify", (ROOT / ".github" / "workflows" / "ci.yml").read_text())


if __name__ == "__main__":
    unittest.main()
