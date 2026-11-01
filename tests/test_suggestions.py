"""Suggested updates (Phase 4.4): briefs from the spec diff, drafts from free models only, decisions."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from regmon import controls as K
from regmon import suggestions as S

ROOT = Path(__file__).resolve().parent.parent
EVENT = "a" * 64

EVIDENCE = {"spec_diff": {"tables": [{"kind": "rules", "name": "Conventional Rules", "changes": [
    {"category": "retired", "id": "R-1", "quarter": "Q1 2027", "values": {"id": "R-1", "description": "BA:100 >= 0"}},
    {"category": "logic", "id": "R-4", "quarter": "Q1 2027", "columns": [
        {"column": "Rule Description", "role": "description", "before": "BA:200 >= 0", "after": "BA:200 >= 0 and BA:201 >= 0", "kind": "substantive"},
        {"column": "Comments", "role": "comments", "before": "x", "after": "x ", "kind": "cosmetic"}]},
    {"category": "added", "id": "R-6", "quarter": "Q1 2027", "values": {"id": "R-6", "description": "BA:300 between[(M4:1045) - 10, (M4:1045) + 10]"}},
]}]}}
REGISTRY = {"schema_version": 1, "consumers": [
    {"id": "suite", "kind": "check", "name": "BCAR suite", "owner": "Controls", "path": "checks/bcar.sql", "implements": ["OSFI BCAR | R-1", "OSFI BCAR | R-4"]},
    {"id": "py", "kind": "check", "name": "Python checks", "path": "src/checks.py:12", "implements": ["R-4"]}]}


def answer(drafts, model="nvidia/nemotron-3-super-120b-a12b:free", status=200):
    response = mock.Mock(status_code=status)
    response.json.return_value = {"model": model, "choices": [{"message": {"content": json.dumps({"drafts": drafts})}}]}
    return response


class Fixture:
    def __init__(self, tmp: Path):
        self.data, self.config = tmp / "data", tmp / "config"
        (self.data / "evidence").mkdir(parents=True)
        self.config.mkdir()
        (self.data / "evidence" / f"{EVENT}.json").write_text(json.dumps(EVIDENCE))
        facts = {"at": "2026-10-30T22:17:00+00:00", "type": "NEW_URL", "forms": [{"form": "OSFI BCAR", "basis": ["monitor"]}], "rules": K.rule_changes(EVIDENCE)}
        (self.data / "change-facts.json").write_text(json.dumps({"schema_version": 1, "events": {EVENT: facts, "b" * 64: {"forms": [], "rules": []}}}))
        (self.data / "latest.json").write_text(json.dumps({"sources": {"s": {"u": {"canonical_url": "https://www.osfi-bsif.gc.ca/bcar.xlsx",
                                                                                 "change_history": [{"event_id": EVENT, "evidence_location": f"data/evidence/{EVENT}.json"}]}}}}))
        (self.config / "registry.json").write_text(json.dumps(REGISTRY))


class BriefTest(unittest.TestCase):
    def test_briefs_carry_the_regulators_text_and_what_to_do(self):
        facts = {"forms": [{"form": "OSFI BCAR"}], "rules": K.rule_changes(EVIDENCE)}
        briefs = {brief["id"]: brief for brief in S.briefs(facts, REGISTRY, None, EVIDENCE)}
        self.assertEqual(set(briefs), {"R-1", "R-4", "R-6"})
        self.assertEqual(briefs["R-1"]["action"], "Retire or disable BCAR suite for R-1 from Q1 2027; the regulator has retired it.")
        self.assertEqual(briefs["R-4"]["action"], "Update Python checks, BCAR suite so R-4 tests what the regulator now states from Q1 2027.")
        self.assertEqual(briefs["R-4"]["columns"], [{"column": "Rule Description", "role": "description", "before": "BA:200 >= 0", "after": "BA:200 >= 0 and BA:201 >= 0"}])
        self.assertEqual([check["language"] for check in briefs["R-4"]["checks"]], ["Python", "SQL"])
        self.assertEqual(briefs["R-6"]["finding"], "missing")
        self.assertIn("BA:300", briefs["R-6"]["values"]["description"])

    def test_language_hints(self):
        self.assertEqual(S.language_for({"path": "models/x.sql"}), "SQL")
        self.assertEqual(S.language_for({"system": "Snowflake"}), "SQL")
        self.assertEqual(S.language_for({"system": "AxiomSL"}), "AxiomSL rule (pseudo-code)")
        self.assertEqual(S.language_for({}), "pseudo-code")


class DraftTest(unittest.TestCase):
    def setUp(self):
        facts = {"forms": [{"form": "OSFI BCAR"}], "rules": K.rule_changes(EVIDENCE)}
        self.briefs = S.briefs(facts, REGISTRY, None, EVIDENCE)
        self.event = {"forms": ["OSFI BCAR"], "url": "https://x"}

    def test_only_free_models(self):
        self.assertTrue(S.free_model("openrouter/free"))
        self.assertTrue(S.free_model("openai/gpt-oss-120b:free"))
        self.assertFalse(S.free_model("openai/gpt-oss-120b"))
        self.assertFalse(S.free_model("anthropic/claude-sonnet-4"))
        post = mock.Mock()
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}):
            result = S.draft(self.event, self.briefs, model="openai/gpt-oss-120b", post=post)
        self.assertEqual(result["status"], "skipped")
        self.assertIn("Only free OpenRouter models", result["reason"])
        post.assert_not_called()  # a paid model is never called

    def test_drafts_only_for_changed_and_new_rules_and_only_ids_asked(self):
        post = mock.Mock(return_value=answer([{"id": "r-4", "language": "SQL", "draft": "select ... where ba_200 < 0 or ba_201 < 0", "notes": "n"},
                                              {"id": "R-1", "draft": "x"}, {"id": "INVENTED-9", "draft": "y"}, {"id": "R-6", "draft": ""}]))
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}, clear=False):
            os.environ.pop("OPENROUTER_MODEL", None)
            result = S.draft(self.event, self.briefs, post=post)
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], "openrouter/free")
        self.assertIn("Rule R-4", payload["messages"][1]["content"])
        self.assertNotIn("Rule R-1", payload["messages"][1]["content"])  # retired rules need no draft
        self.assertEqual(result["status"], "ok")
        self.assertEqual(sorted(result["drafts"]), ["R-4"])
        self.assertEqual(result["missing"], ["R-6"])
        self.assertEqual(len(result["drafts"]["R-4"]["hash"]), 16)

    def test_outages_and_garbage_never_raise(self):
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}):
            self.assertEqual(S.draft(self.event, self.briefs, post=mock.Mock(return_value=answer([], status=429)))["status"], "unavailable")
            self.assertEqual(S.draft(self.event, self.briefs, post=mock.Mock(side_effect=TimeoutError("slow")))["status"], "unavailable")
            bad = mock.Mock(status_code=200)
            bad.json.return_value = {"choices": [{"message": {"content": "no json here"}}]}
            self.assertEqual(S.draft(self.event, self.briefs, post=mock.Mock(return_value=bad))["status"], "invalid")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(S.draft(self.event, self.briefs, post=mock.Mock())["status"], "skipped")


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.f = Fixture(Path(self.tmp.name))

    def build(self, post=None, now="2026-11-01T06:00:00Z"):
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}):
            os.environ.pop("OPENROUTER_MODEL", None)
            return S.build(self.f.data, self.f.config, now=now, post=post)

    def test_build_drafts_keeps_and_rebuilds(self):
        post = mock.Mock(return_value=answer([{"id": "R-4", "language": "SQL", "draft": "check R-4"}, {"id": "R-6", "language": "SQL", "draft": "check R-6"}]))
        self.assertEqual(self.build(post), {"changes": 1, "written": 1, "drafted": 1})
        doc = json.loads((self.f.data / "suggestions" / f"{EVENT}.json").read_text())
        self.assertEqual((doc["ai"]["status"], sorted(doc["ai"]["drafts"])), ("ok", ["R-4", "R-6"]))
        index = json.loads((self.f.data / "suggestions" / "index.json").read_text())["changes"][EVENT]
        self.assertEqual((index["rules"], index["ai"], index["findings"]["missing"]), (3, "ok", 1))
        # Nothing changed: no new call, nothing rewritten.
        again = mock.Mock()
        self.assertEqual(self.build(again, now="2026-11-01T09:00:00Z"), {"changes": 1, "written": 0, "drafted": 0})
        again.assert_not_called()
        self.assertEqual(S.validate(self.f.data), [])
        # The checks changed: the briefs are rebuilt and the draft is asked for again.
        registry = json.loads((self.f.config / "registry.json").read_text())
        registry["consumers"][0]["path"] = "checks/bcar.py"
        (self.f.config / "registry.json").write_text(json.dumps(registry))
        third = mock.Mock(return_value=answer([], status=503))
        self.assertEqual(self.build(third)["written"], 1)
        third.assert_called_once()
        self.assertEqual(json.loads((self.f.data / "suggestions" / f"{EVENT}.json").read_text())["ai"]["status"], "unavailable")
        # Nothing implemented any more: the suggestions go.
        (self.f.config / "registry.json").write_text(json.dumps({"schema_version": 1, "consumers": [{"id": "x", "implements": ["OTHER | Z-1"]}]}))
        self.build(mock.Mock())
        self.assertFalse((self.f.data / "suggestions" / f"{EVENT}.json").exists())
        self.assertEqual(json.loads((self.f.data / "suggestions" / "index.json").read_text())["changes"], {})

    def test_at_most_three_changes_drafted_per_run(self):
        facts = json.loads((self.f.data / "change-facts.json").read_text())
        history = []
        for n in range(5):
            event_id = f"{n:064d}"
            facts["events"][event_id] = dict(facts["events"][EVENT], at=f"2026-10-2{n}T00:00:00+00:00")
            (self.f.data / "evidence" / f"{event_id}.json").write_text(json.dumps(EVIDENCE))
            history.append({"event_id": event_id, "evidence_location": f"data/evidence/{event_id}.json"})
        (self.f.data / "change-facts.json").write_text(json.dumps(facts))
        latest = json.loads((self.f.data / "latest.json").read_text())
        latest["sources"]["s"]["u"]["change_history"].extend(history)
        (self.f.data / "latest.json").write_text(json.dumps(latest))
        post = mock.Mock(return_value=answer([{"id": "R-4", "draft": "d"}]))
        result = self.build(post)
        self.assertEqual((result["changes"], result["drafted"], post.call_count), (6, 3, 3))
        self.assertEqual(self.build(post)["drafted"], 3)
        self.assertEqual(self.build(post)["drafted"], 0)  # all six drafted over two runs


class DecisionTest(unittest.TestCase):
    def test_owner_decision_is_recorded_with_the_draft_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Fixture(Path(tmp))
            with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "k"}):
                S.build(f.data, f.config, post=mock.Mock(return_value=answer([{"id": "R-4", "draft": "check R-4"}])))
            doc = json.loads((f.data / "suggestions" / f"{EVENT}.json").read_text())
            draft_hash = doc["ai"]["drafts"]["R-4"]["hash"]

            def event(request, user="o", title=S.REQUEST_TITLE + ": approved R-4"):
                body = S.REQUEST_MARKER + "\n\n```json\n" + json.dumps(request) + "\n```\n"
                return {"issue": {"user": {"login": user}, "title": title, "body": body, "number": 7}, "repository": {"owner": {"login": "o"}}}

            request = {"version": 1, "event_id": EVENT, "rule": "r-4", "decision": "approved", "draft_hash": draft_hash, "note": "matches our SQL"}
            with self.assertRaisesRegex(S.DecisionError, "owner"):
                S.apply_event(event(request, user="someone"), data_dir=f.data)
            with self.assertRaisesRegex(S.DecisionError, "draft changed"):
                S.apply_event(event({**request, "draft_hash": "0" * 16}), data_dir=f.data)
            with self.assertRaisesRegex(S.DecisionError, "no rule"):
                S.apply_event(event({**request, "rule": "R-404"}), data_dir=f.data)
            result = S.apply_event(event(request), data_dir=f.data, now="2026-11-01T07:00:00Z")
            self.assertEqual(result["summary"], "approved the suggested update for R-4")
            ledger = json.loads((f.data / "reviews" / "suggestions.json").read_text())
            self.assertEqual(ledger["decisions"][EVENT]["R-4"], {"decision": "approved", "at": "2026-11-01T07:00:00Z", "by": "o", "issue": 7,
                                                                 "draft_hash": draft_hash, "note": "matches our SQL"})
            self.assertEqual(len(ledger["log"]), 1)


class WiringTest(unittest.TestCase):
    def test_scan_workflow_pages_and_dashboard(self):
        engine = (ROOT / "regmon" / "engine.py").read_text()
        self.assertLess(engine.index("controls.write(DATA"), engine.index("suggestions.build(DATA"))
        pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text()
        self.assertIn("cp data/suggestions/*.json site/data/suggestions/", pages)
        self.assertIn("data/reviews/suggestions.json", pages)
        workflow = (ROOT / ".github" / "workflows" / "suggestion-review.yml").read_text()
        self.assertIn("github.event.issue.user.login == github.repository_owner", workflow)
        self.assertIn("python -m regmon.suggestions apply-issue", workflow)
        self.assertIn("git add -- data/reviews/suggestions.json", workflow)
        js = (ROOT / "dashboard.js").read_text()
        for needle in ("fillSuggestions(entry.event_id, stillCurrent)", "[data-suggest-decide]", "[data-registry-import]", S.REQUEST_MARKER, S.REQUEST_TITLE):
            self.assertIn(needle, js)
        self.assertIn(".suggestion-draft", (ROOT / "index.html").read_text())


if __name__ == "__main__":
    unittest.main()
