import io
import sys
import zipfile
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from regmon.docling_extractor import KNOWN_TIMEOUT_PDF_SHA256, extract_pdf_with_docling


class TestDoclingAdapter(unittest.TestCase):
    def _mock_docling_stream_module(self):
        docling = types.ModuleType("docling")
        datamodel = types.ModuleType("docling.datamodel")
        base_models = types.ModuleType("docling.datamodel.base_models")
        base_models.DocumentStream = lambda **kwargs: kwargs
        return {
            "docling": docling,
            "docling.datamodel": datamodel,
            "docling.datamodel.base_models": base_models,
        }

    def test_known_timeout_pdf_is_skipped_before_model_initialization(self):
        known_hash = next(iter(KNOWN_TIMEOUT_PDF_SHA256))
        with patch("regmon.docling_extractor.hashlib.sha256") as sha256, patch(
            "regmon.docling_extractor._build_converter"
        ) as build:
            sha256.return_value.hexdigest.return_value = known_hash
            text, error = extract_pdf_with_docling(b"%PDF-1.7 synthetic", expected_pages=1)

        self.assertIsNone(text)
        self.assertIn("intentionally skipped", error)
        self.assertIn(known_hash, error)
        build.assert_not_called()

    def _timeout_converter(self):
        converter = Mock()
        document = Mock()
        document.pages = {1: object()}
        converter.convert.return_value = types.SimpleNamespace(
            status=types.SimpleNamespace(name="PARTIAL_SUCCESS"), document=document
        )
        return converter

    def _run_with_clock(self, converter, body, elapsed):
        ticks = iter([1000.0, 1000.0 + elapsed])
        with patch.dict(sys.modules, self._mock_docling_stream_module()), patch(
            "regmon.docling_extractor._CONVERTER", converter
        ), patch("regmon.docling_extractor.time.monotonic", side_effect=lambda: next(ticks)):
            return extract_pdf_with_docling(body, expected_pages=1)

    def test_time_budget_timeout_is_learned_persisted_and_skipped_next_run(self):
        import json
        import regmon.docling_extractor as de

        with tempfile.TemporaryDirectory() as tmp:
            registry = Path(tmp) / "docling-timeouts.json"
            de.configure_timeout_registry(registry, persist=True)
            try:
                body = b"%PDF-1.7 heavy vector rules"
                converter = self._timeout_converter()
                text, error = self._run_with_clock(converter, body, elapsed=de.DOCUMENT_TIMEOUT_SECONDS)
                self.assertIsNone(text)
                self.assertIn("did not complete successfully", error)
                saved = json.loads(registry.read_text(encoding="utf-8"))["time_budget_exhausted"]
                digest = de.hashlib.sha256(body).hexdigest()
                self.assertIn(digest, saved)

                # A fresh process reading the committed file skips the same bytes before conversion.
                de.configure_timeout_registry(registry, persist=True)
                converter.convert.reset_mock()
                text, error = self._run_with_clock(converter, body, elapsed=0)
                self.assertIn("intentionally skipped", error)
                converter.convert.assert_not_called()

                # A republished revision (different bytes) is evaluated normally.
                self._run_with_clock(converter, body + b" revised", elapsed=1)
                converter.convert.assert_called_once()
            finally:
                de.configure_timeout_registry(None)

    def test_fast_partial_success_is_not_learned_and_dry_run_never_writes(self):
        import regmon.docling_extractor as de

        with tempfile.TemporaryDirectory() as tmp:
            registry = Path(tmp) / "docling-timeouts.json"
            de.configure_timeout_registry(registry, persist=True)
            try:
                self._run_with_clock(self._timeout_converter(), b"%PDF-1.7 quick partial", elapsed=3)
                self.assertFalse(registry.exists())
                de.configure_timeout_registry(registry, persist=False)
                self._run_with_clock(self._timeout_converter(), b"%PDF-1.7 dry", elapsed=de.DOCUMENT_TIMEOUT_SECONDS)
                self.assertFalse(registry.exists())
            finally:
                de.configure_timeout_registry(None)

    def test_corrupt_timeout_registry_is_ignored_and_never_overwritten(self):
        import regmon.docling_extractor as de

        with tempfile.TemporaryDirectory() as tmp:
            registry = Path(tmp) / "docling-timeouts.json"
            registry.write_text("{not json", encoding="utf-8")
            with self.assertLogs("regmon.docling_extractor", level="WARNING"):
                de.configure_timeout_registry(registry, persist=True)
            try:
                self._run_with_clock(self._timeout_converter(), b"%PDF-1.7 x", elapsed=de.DOCUMENT_TIMEOUT_SECONDS)
                self.assertEqual(registry.read_text(encoding="utf-8"), "{not json")
            finally:
                de.configure_timeout_registry(None)

    def test_success_requires_every_page_and_returns_markdown(self):
        document = Mock()
        document.pages = {1: object()}
        document.export_to_markdown.return_value = (
            "# Instructions\n\n| Field | Value |\n| --- | --- |\n| Threshold | 15% |"
        )
        converter = Mock()
        converter.convert.return_value = types.SimpleNamespace(
            status=types.SimpleNamespace(name="SUCCESS"),
            document=document,
        )
        with patch.dict(sys.modules, self._mock_docling_stream_module()), patch(
            "regmon.docling_extractor._CONVERTER", converter
        ):
            text, error = extract_pdf_with_docling(b"%PDF-1.7 synthetic", expected_pages=1)

        self.assertIsNone(error)
        self.assertIn("| Threshold | 15% |", text)
        source = converter.convert.call_args.args[0]
        self.assertEqual(source["name"], "changesentinel-input.pdf")
        self.assertEqual(converter.convert.call_args.kwargs["max_num_pages"], 1)

    def test_partial_success_is_rejected(self):
        document = Mock()
        document.pages = {1: object()}
        document.export_to_markdown.return_value = "Partial output"
        converter = Mock()
        converter.convert.return_value = types.SimpleNamespace(
            status=types.SimpleNamespace(name="PARTIAL_SUCCESS"),
            document=document,
        )
        with patch.dict(sys.modules, self._mock_docling_stream_module()), patch(
            "regmon.docling_extractor._CONVERTER", converter
        ):
            text, error = extract_pdf_with_docling(b"%PDF-1.7 synthetic", expected_pages=1)

        self.assertIsNone(text)
        self.assertIn("did not complete successfully", error)

    def test_page_count_mismatch_is_rejected(self):
        document = Mock()
        document.pages = {1: object()}
        converter = Mock()
        converter.convert.return_value = types.SimpleNamespace(
            status=types.SimpleNamespace(name="SUCCESS"),
            document=document,
        )
        with patch.dict(sys.modules, self._mock_docling_stream_module()), patch(
            "regmon.docling_extractor._CONVERTER", converter
        ):
            text, error = extract_pdf_with_docling(b"%PDF-1.7 synthetic", expected_pages=2)

        self.assertIsNone(text)
        self.assertIn("page-count mismatch", error)

    def test_non_pdf_input_is_rejected_without_loading_models(self):
        with patch("regmon.docling_extractor._build_converter") as build:
            text, error = extract_pdf_with_docling(b"not a PDF", expected_pages=1)
        self.assertIsNone(text)
        self.assertIn("not a PDF", error)
        build.assert_not_called()


class TestZipExtractionProfile(unittest.TestCase):
    @staticmethod
    def _archive_bytes() -> bytes:
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("a-form.pdf", b"%PDF-fake-a")
            archive.writestr("b-instructions.pdf", b"%PDF-fake-b")
        return stream.getvalue()

    def _extract_with_profiles(self, body: bytes, profiles: dict[str, str]):
        from regmon.content import _extract_zip_bundle

        def fake_extract(name, content_type, member_bytes, _extraction_profile=None, **kwargs):
            _extraction_profile["profile"] = profiles[name]
            return f"stable content for {name}", "pdf", None

        profile = {}
        with patch("regmon.content.extract_content", side_effect=fake_extract):
            text, kind, error = _extract_zip_bundle(body, profile)
        self.assertIsNone(error)
        self.assertEqual(kind, "zip")
        self.assertIn("stable content for a-form.pdf", text)
        return profile["profile"]

    def test_zip_profile_fingerprint_tracks_each_member_deterministically(self):
        body = self._archive_bytes()
        mixed = {
            "a-form.pdf": "fallback",
            "b-instructions.pdf": "docling",
        }
        all_docling = {
            "a-form.pdf": "docling",
            "b-instructions.pdf": "docling",
        }

        first = self._extract_with_profiles(body, mixed)
        repeat = self._extract_with_profiles(body, mixed)
        changed = self._extract_with_profiles(body, all_docling)

        self.assertTrue(first.startswith("zipprofile-"))
        self.assertEqual(first, repeat)
        self.assertNotEqual(first, changed)

    def test_zip_profile_change_on_identical_bytes_is_a_baseline_migration(self):
        from regmon.content import CONTENT_EXTRACTOR_VERSION
        from regmon.engine import should_rebaseline_extractor

        old = {
            "extraction_type": "zip",
            "extractor_version": CONTENT_EXTRACTOR_VERSION + "-zipprofile-aaaaaaaaaaaaaaaa",
            "raw_hash": "identical-zip-bytes",
            "normalized_hash": "old-member-parser-output",
        }
        current = {
            "extraction_type": "zip",
            "extractor_version": CONTENT_EXTRACTOR_VERSION + "-zipprofile-bbbbbbbbbbbbbbbb",
            "raw_hash": "identical-zip-bytes",
            "normalized_hash": "new-member-parser-output",
        }
        self.assertTrue(should_rebaseline_extractor(old, current))

        current["raw_hash"] = "different-zip-bytes"
        self.assertFalse(should_rebaseline_extractor(old, current))


class TestDoclingPdfFallback(unittest.TestCase):
    def test_table_rich_docling_output_replaces_flattened_fragmented_text(self):
        from regmon.content import _extract_pdf

        raw = "\n".join([f"field{index}" for index in range(24)])
        page = Mock()
        page.extract_text.return_value = raw
        reader = Mock()
        reader.is_encrypted = False
        reader.pages = [page]

        pdfplumber_module = types.ModuleType("pdfplumber")
        document_context = MagicMock()
        document_context.__enter__.return_value.pages = [Mock()]
        pdfplumber_module.open = Mock(return_value=document_context)
        docling_markdown = (
            "# Reporting schedule\n\n"
            + "Recovered fields: " + " ".join(f"field{index}" for index in range(24))
            + "\n\n| Field | Threshold |\n| --- | --- |\n| Required reporting | 15% |"
        )

        with patch("pypdf.PdfReader", return_value=reader), patch(
            "regmon.content._page_has_image_xobject", return_value=False
        ), patch(
            "regmon.content._extract_pdfplumber_page", return_value=raw
        ), patch.dict(sys.modules, {"pdfplumber": pdfplumber_module}), patch(
            "regmon.content.extract_pdf_with_docling",
            return_value=(docling_markdown, None),
        ) as docling:
            text, error = _extract_pdf(b"%PDF-1.7 synthetic")

        self.assertIsNone(error)
        self.assertIn("| Required reporting | 15% |", text)
        docling.assert_called_once()
        self.assertEqual(docling.call_args.kwargs["expected_pages"], 1)


if __name__ == "__main__":
    unittest.main()


class TestDoclingFormTableTidy(unittest.TestCase):
    def test_blank_entry_rows_and_duplicate_columns_are_removed(self):
        from regmon.content import tidy_docling_markdown

        markdown = "\n".join([
            "Intro text",
            "| Day | Rate | Rate |",
            "|---|---|---|",
            "| Monday | 8.500 | 8.500 |",
            "| | | 1 |",
            "| 2 | | |",
            "Outro",
        ])
        out = tidy_docling_markdown(markdown).splitlines()
        self.assertEqual(out[0], "Intro text")
        self.assertIn("| Day | Rate |", out)
        self.assertIn("| Monday | 8.500 |", out)
        self.assertIn("(2 blank entry rows)", out)
        self.assertEqual(out[-1], "Outro")

    def test_wide_form_grid_stays_a_table_without_blank_rows(self):
        from regmon.content import tidy_docling_markdown

        header = "| " + " | ".join(f"Column {i}" for i in range(1, 10)) + " |"
        codes = "| " + " | ".join(f"QTFL {9000 + i}" for i in range(1, 10)) + " |"
        markdown = "\n".join([header, "|" + "---|" * 9, codes] + ["| 1 |" + " |" * 8] * 3)
        out = tidy_docling_markdown(markdown).splitlines()
        self.assertEqual(out[0], header)
        self.assertEqual(out[2], codes)
        self.assertEqual(out[-1], "(3 blank entry rows)")
        self.assertEqual(len(out), 4)

    def test_text_without_tables_is_unchanged(self):
        from regmon.content import tidy_docling_markdown

        text = "## Heading\nA | pipe in prose\n- a list"
        self.assertEqual(tidy_docling_markdown(text), text)
