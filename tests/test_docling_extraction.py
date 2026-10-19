import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from regmon.docling_extractor import extract_pdf_with_docling


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

    def test_page_safety_limit_skips_model_conversion(self):
        from regmon.docling_extractor import MAX_DOCLING_PAGES

        with patch("regmon.docling_extractor._build_converter") as build:
            text, error = extract_pdf_with_docling(
                b"%PDF-1.7 synthetic", expected_pages=MAX_DOCLING_PAGES + 1
            )
        self.assertIsNone(text)
        self.assertIn("safety limit", error)
        build.assert_not_called()


class TestDoclingPdfFallback(unittest.TestCase):
    def test_table_rich_docling_output_replaces_flattened_fragmented_text(self):
        from regmon.content import _extract_pdf

        raw = "\n".join(["field" + str(index) for index in range(24)])
        page = Mock()
        page.extract_text.return_value = raw
        reader = Mock()
        reader.is_encrypted = False
        reader.pages = [page]

        pdfplumber_module = types.ModuleType("pdfplumber")
        document_context = Mock()
        document_context.__enter__.return_value.pages = [Mock()]
        pdfplumber_module.open = Mock(return_value=document_context)
        docling_markdown = (
            "# Reporting schedule\n\n"
            + "Recovered fields: " + " ".join("field" + str(index) for index in range(24))
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
