"""English translations of non-English extracted text: a reading aid only.

The original text stays what is hashed and compared; translations are
line-aligned, content-addressed, budgeted per scan and never fail a scan.
"""
from __future__ import annotations

import json
import re
import unittest
from unittest.mock import patch

from engine_harness import Sandbox, ok
from regmon import translate
from regmon.config import SourceConfig

SPANISH = "\n".join([
    "Circular Externa 012 de 2026",
    "Las entidades deberán reportar el formato 5050 a la Superintendencia por el canal electrónico.",
    "| Código | Concepto | Valor |",
    "| 101 | Depósitos de ahorro | 2.500 |",
    "La presente circular rige a partir de la fecha de su publicación y deroga las disposiciones que le sean contrarias.",
    "Los reportes se presentarán con la periodicidad mensual que se indica en el anexo técnico.",
] * 3)
ENGLISH = ("The institutions must report the form to the supervisor through the electronic channel. "
           "This circular is effective from the date of its publication and the reports are filed monthly. ") * 5
BILINGUAL = ENGLISH + " " + ("Les institutions doivent déclarer le formulaire au surintendant par le canal électronique. " * 2)
GLOSSARY = {
    "Circular Externa 012 de 2026": "External Circular 012 of 2026",
    "Las entidades deberán reportar el formato 5050 a la Superintendencia por el canal electrónico.": "Institutions must report form 5050 to the Superintendency through the electronic channel.",
    "| Código | Concepto | Valor |": "| Code | Concept | Value |",
    "| 101 | Depósitos de ahorro | 2.500 |": "| 101 | Savings deposits | 2.500 |",
}


class FakeResponse:
    def __init__(self, content: str, status: int = 200):
        self.status_code = status
        self._content = content
        self.headers = {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return {"model": "test/model", "choices": [{"message": {"content": self._content}}]}


def fake_model(drop: set[str] = frozenset(), calls: list | None = None):
    """Echo every marked line back translated (from GLOSSARY, else upper-cased)."""
    def post(url, headers=None, json=None, timeout=None):
        body = json["messages"][1]["content"]
        if calls is not None:
            calls.append(body)
        out = []
        for line in body.splitlines():
            match = re.match(r"^⟦(\d+)⟧ (.*)$", line)
            if match and match.group(2) not in drop:
                out.append(f"⟦{match.group(1)}⟧ " + GLOSSARY.get(match.group(2), match.group(2).upper()))
        return FakeResponse("\n".join(out))
    return post


class TestLanguageDetection(unittest.TestCase):
    def test_regulator_languages_are_recognised(self):
        self.assertEqual(translate.detect_language(SPANISH)[0], "es")
        self.assertEqual(translate.detect_language(ENGLISH)[0], "en")
        portuguese = "As instituições devem enviar o documento ao Banco Central do Brasil conforme o leiaute 5050 e não podem alterar os campos da tabela. " * 3
        self.assertEqual(translate.detect_language(portuguese)[0], "pt")

    def test_english_and_largely_english_bilingual_documents_are_not_translated(self):
        self.assertFalse(translate.needs_translation(*translate.detect_language(ENGLISH)))
        self.assertFalse(translate.needs_translation(*translate.detect_language(BILINGUAL)))
        self.assertTrue(translate.needs_translation(*translate.detect_language(SPANISH)))

    def test_too_little_text_has_no_language(self):
        self.assertEqual(translate.detect_language("Formato 5050"), (None, {}))


class TestTranslateText(unittest.TestCase):
    def config(self, **kw):
        return translate.TranslationConfig(attempts=1, concurrency=1, **kw)

    def test_the_translation_lines_up_with_the_original(self):
        calls = []
        with patch("regmon.translate.requests.post", fake_model(calls=calls)):
            result = translate.translate_text(SPANISH, "es", self.config(), key="k")
        self.assertEqual(result["status"], "complete")
        original, english = SPANISH.split("\n"), result["text"].split("\n")
        self.assertEqual(len(english), len(original))
        self.assertEqual(english[0], "External Circular 012 of 2026")
        self.assertEqual(english[3], "| 101 | Savings deposits | 2.500 |")
        # Repeated lines go out once.
        self.assertEqual(sum(body.count("⟦") for body in calls), 6)
        self.assertIn("<UNTRUSTED_TEXT>", calls[0])

    def test_a_dropped_line_keeps_its_original_and_is_partial(self):
        dropped = "| 101 | Depósitos de ahorro | 2.500 |"
        with patch("regmon.translate.requests.post", fake_model(drop={dropped})):
            result = translate.translate_text(SPANISH, "es", self.config(), key="k")
        self.assertEqual(result["status"], "partial")
        self.assertIn(dropped, result["text"].split("\n"))

    def test_the_document_cap_leaves_the_rest_in_the_original(self):
        with patch("regmon.translate.requests.post", fake_model()):
            result = translate.translate_text(SPANISH, "es", self.config(max_document_chars=120), key="k")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["text"].split("\n")[-1], SPANISH.split("\n")[-1])

    def test_no_key_means_no_call(self):
        with patch.dict("os.environ", {}, clear=True), patch("regmon.translate.requests.post") as post:
            result = translate.translate_text(SPANISH, "es", self.config())
        post.assert_not_called()
        self.assertEqual(result["status"], "skipped")

    def test_a_provider_failure_returns_nothing_rather_than_guessing(self):
        with patch("regmon.translate.requests.post", lambda *a, **k: FakeResponse("", 503)):
            result = translate.translate_text(SPANISH, "es", self.config(), key="k")
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["text"])


URL = "https://example.test/circular-012.html"
SOURCE = SourceConfig(id="es-circular", name="Circular", regulator="Synthetic Regulator", seed_urls=(URL,),
                      allowed_prefixes=("https://example.test/",), allowed_domains=("example.test",), allowed_urls=(URL,))


def page(text: str) -> bytes:
    return ("<html><body><main>" + "".join(f"<p>{line}</p>" for line in text.split("\n")) + "</main></body></html>").encode("utf-8")


class TestTranslationInScans(unittest.TestCase):
    def test_a_spanish_page_gets_english_text_and_detection_is_unchanged(self):
        with Sandbox(source=SOURCE) as sandbox, patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), \
                patch("regmon.translate.requests.post", fake_model()):
            first = sandbox.scan(lambda *a, **k: ok(page(SPANISH)))
            record = next(iter(sandbox.inventory().values()))
            self.assertEqual(record["language"], "es")
            self.assertEqual(record["translation"]["status"], "complete")
            self.assertEqual(record["translation_location"], translate.translation_path(record["snapshot_location"]))
            english = (sandbox.root / record["translation_location"]).read_text(encoding="utf-8")
            self.assertIn("External Circular 012 of 2026", english)
            self.assertEqual(first["report"]["counts"]["translation_written"], 1)
            original_hash = record["normalized_hash"]
            again = sandbox.scan(lambda *a, **k: ok(page(SPANISH)))
            self.assertEqual(again["report"]["counts"]["translation_written"], 0)
            self.assertEqual(next(iter(sandbox.inventory().values()))["normalized_hash"], original_hash)
            self.assertFalse([e for e in again["report"]["events"] if e["event_type"] == "CHANGED_URL"])

    def test_a_changed_page_is_translated_again_and_both_versions_have_english(self):
        with Sandbox(source=SOURCE) as sandbox, patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), \
                patch("regmon.translate.requests.post", fake_model()):
            sandbox.scan(lambda *a, **k: ok(page(SPANISH)))
            before = next(iter(sandbox.inventory().values()))
            changed = sandbox.scan(lambda *a, **k: ok(page(SPANISH.replace("5050", "5051"))))
            after = next(iter(sandbox.inventory().values()))
            event = next(e for e in changed["report"]["events"] if e["event_type"] == "CHANGED_URL")
            evidence = json.loads((sandbox.root / event["evidence_location"]).read_text(encoding="utf-8"))
            for side, record in (("before", before), ("after", after)):
                path = translate.translation_path(evidence[side]["snapshot_location"])
                self.assertTrue((sandbox.root / path).is_file(), side)
            self.assertNotEqual(before["translation_location"], after["translation_location"])

    def test_without_a_key_only_the_language_is_recorded(self):
        with Sandbox(source=SOURCE) as sandbox, patch.dict("os.environ", {}, clear=True):
            report = sandbox.scan(lambda *a, **k: ok(page(SPANISH)))
            record = next(iter(sandbox.inventory().values()))
            self.assertEqual(record["language"], "es")
            self.assertIsNone(record["translation_location"])
            self.assertEqual(report["report"]["counts"]["translation_pending"], 1)

    def test_an_english_page_is_left_alone(self):
        with Sandbox(source=SOURCE) as sandbox, patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), \
                patch("regmon.translate.requests.post") as post:
            sandbox.scan(lambda *a, **k: ok(page(ENGLISH)))
            post.assert_not_called()
            self.assertEqual(next(iter(sandbox.inventory().values()))["language"], "en")

    def test_a_translation_error_never_fails_the_scan(self):
        def boom(*a, **k):
            raise RuntimeError("network down")
        with Sandbox(source=SOURCE) as sandbox, patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), \
                patch("regmon.translate.requests.post", boom), patch("regmon.translate.time.sleep"):
            report = sandbox.scan(lambda *a, **k: ok(page(SPANISH)))
            record = next(iter(sandbox.inventory().values()))
            self.assertEqual(record["translation"]["status"], "failed")
            self.assertEqual(report["report"]["counts"]["translation_failed"], 1)
            self.assertTrue(record["normalized_hash"])

    def test_the_run_budget_defers_documents(self):
        with Sandbox(source=SOURCE, defaults={"translation_max_chars_per_run": 50}) as sandbox, \
                patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), patch("regmon.translate.requests.post") as post:
            report = sandbox.scan(lambda *a, **k: ok(page(SPANISH)))
            post.assert_not_called()
            self.assertEqual(report["report"]["counts"]["translation_pending"], 1)


class TestTranslationSettings(unittest.TestCase):
    def payload(self, **defaults):
        return {"version": 4, "defaults": defaults, "sources": []}

    def test_the_switch_and_budgets_are_checked(self):
        from regmon.config import validate_config

        validate_config(self.payload(translate_to_english=False, translation_max_chars_per_run=0, translation_model="openrouter/free"), [])
        for bad in ({"translate_to_english": "no"}, {"translation_max_chars_per_run": -1}, {"translation_model": ""}):
            with self.assertRaises(ValueError):
                validate_config(self.payload(**bad), [])

    def test_switched_off_means_no_detection_and_no_calls(self):
        with Sandbox(source=SOURCE, defaults={"translate_to_english": False}) as sandbox, \
                patch.dict("os.environ", {"OPENROUTER_API_KEY": "k"}), patch("regmon.translate.requests.post") as post:
            sandbox.scan(lambda *a, **k: ok(page(SPANISH)))
            post.assert_not_called()
            self.assertIsNone(next(iter(sandbox.inventory().values()))["language"])


if __name__ == "__main__":
    unittest.main()
