"""Ruled-grid reconstruction on synthetic report forms (regmon/pdf_grid.py).

The fixtures recreate the two layouts the extractor targets: a fill-in report form
(merged multi-level headers, sideways option labels, an item-code row, a column-number
row and blank entry rows) and a line-item schedule (labels with dot leaders outside
the boxes, item codes in boxes, line numbers on the right).
"""
import io
import unittest

try:
    import pdfplumber
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.pdfgen import canvas
except ImportError:  # pragma: no cover - reportlab is installed in CI
    canvas = None

from regmon.content import normalize_pdf_prose
from regmon.pdf_grid import cell_text, rebuild_page


def _rect(c, x, y, w, h):
    c.rect(x, y, w, h, stroke=1, fill=0)


def build_form_pdf() -> bytes:
    """A small FR 2028B-style form, landscape, with prose in three columns above it."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=landscape(letter))
    width, height = landscape(letter)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(40, height - 50, "Survey of Terms of Lending")
    c.setFont("Helvetica", 8)
    columns = [
        ["This report is authorized", "by law and your voluntary", "cooperation is needed."],
        ["The Federal Reserve may", "not conduct or sponsor a", "collection without a number."],
        ["Individual information is", "regarded as confidential", "by the Federal Reserve."],
    ]
    for i, lines in enumerate(columns):
        for j, line in enumerate(lines):
            c.drawString(40 + i * 230, height - 80 - j * 10, line)
    # Grid geometry: columns at x, header rows from the top.
    xs = [40, 120, 200, 240, 280, 320, 400]
    top = height - 140
    rows = [30, 90, 14, 12, 12] + [14] * 3  # group, labels, codes, numbers, entry hints, 3 blank rows
    ys = [top]
    for h in rows:
        ys.append(ys[-1] - h)
    # Header row 0: "Date Made" spans rows 0-1 in col 0; "Rate" spans cols 1; "Insurance Status" spans cols 2-4.
    _rect(c, xs[0], ys[2], xs[1] - xs[0], ys[0] - ys[2])
    _rect(c, xs[1], ys[1], xs[2] - xs[1], ys[0] - ys[1])
    _rect(c, xs[1], ys[2], xs[2] - xs[1], ys[1] - ys[2])
    _rect(c, xs[2], ys[1], xs[5] - xs[2], ys[0] - ys[1])
    for k in range(2, 5):
        _rect(c, xs[k], ys[2], xs[k + 1] - xs[k], ys[1] - ys[2])
    _rect(c, xs[5], ys[2], xs[6] - xs[5], ys[0] - ys[2])
    c.setFont("Helvetica", 8)
    c.drawString(xs[0] + 4, ys[1] + 10, "Date Made")
    c.drawString(xs[1] + 4, ys[0] - 18, "Rate of Interest")
    c.drawString(xs[1] + 4, ys[2] + 30, "Nominal Rate")
    c.drawString(xs[2] + 4, ys[0] - 18, "Insurance Status")
    c.drawString(xs[5] + 4, ys[1] + 10, "Risk Rating")
    for k, (letter_, label) in enumerate([("(a)", "Insured by FSA"), ("(b)", "Insured by Others"), ("(c)", "Not Insured")]):
        x = xs[2 + k]
        c.drawString(x + 10, ys[2] + 4, letter_)
        c.saveState()
        c.translate(x + 26, ys[2] + 16)
        c.rotate(90)  # sideways option label, reading bottom to top
        c.drawString(0, 0, label)
        c.restoreState()
    # Code, number and entry-hint rows: merged cells over the three options.
    codes = [("QTFL 9912", 0, 1), ("QTFL 7924", 1, 2), ("QTFL 6133", 2, 5), ("QTFL A344", 5, 6)]
    numbers = [("(1)", 0, 1), ("(2)", 1, 2), ("(3)", 2, 5), ("(4)", 5, 6)]
    hints = [("Mo. Day", 0, 1), ("Percent", 1, 2), ("Check one", 2, 5), ("", 5, 6)]
    for row, values in ((2, codes), (3, numbers), (4, hints)):
        for text, a, b in values:
            _rect(c, xs[a], ys[row + 1], xs[b] - xs[a], ys[row] - ys[row + 1])
            if text:
                c.drawString(xs[a] + 4, ys[row + 1] + 3, text)
    for row in range(5, 8):
        for k in range(6):
            _rect(c, xs[k], ys[row + 1], xs[k + 1] - xs[k], ys[row] - ys[row + 1])
    c.showPage()
    c.save()
    return buf.getvalue()


def build_line_item_pdf() -> bytes:
    """A Y-9C-style schedule: dot-leader labels left, code and amount boxes, line numbers right."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    width, height = letter
    c.setFont("Helvetica-Bold", 11)
    c.drawString(40, height - 50, "Schedule HI")
    c.setFont("Helvetica", 8)
    box_x, code_w, amount_w, row_h = 400, 30, 80, 12
    top = height - 80
    _rect(c, box_x, top - row_h, code_w, row_h)
    _rect(c, box_x + code_w, top - row_h, amount_w, row_h)
    c.drawString(box_x + 3, top - row_h + 3, "BHCK")
    c.drawString(box_x + code_w + 20, top - row_h + 3, "Amount")
    c.drawString(250, top - row_h + 3, "Dollar Amounts in Thousands")
    items = [
        ("1. Net interest income on a fully", "taxable equivalent basis", "4519", "M.1."),
        ("2. Net income before taxes", None, "4592", "M.2."),
        ("3. Number of employees", None, "4150", "M.3."),
        ("4. Income from fiduciary activities", None, "4070", "M.4."),
        ("5. Service charges on deposits", None, "4080", "M.5."),
        ("6. Trading revenue", None, "A220", "M.6."),
    ]
    y = top - row_h
    for first, second, code, number in items:
        if second:
            # A wrapped label: its first line sits in a shaded spacer row above the box.
            _rect(c, box_x, y - row_h, code_w + amount_w, row_h)
            c.drawString(40, y - row_h + 3, first)
            y -= row_h
            label_line = second
        else:
            label_line = first
        _rect(c, box_x, y - row_h, code_w, row_h)
        _rect(c, box_x + code_w, y - row_h, amount_w, row_h)
        c.drawString(box_x + 3, y - row_h + 3, code)
        x = 40 if not second else 52
        leaders = label_line + " "
        while c.stringWidth(leaders + ".", "Helvetica", 8) < box_x - 4 - x:
            leaders += "."  # dot leaders run up to the box, as on the real forms
        c.drawString(x, y - row_h + 3, leaders)
        c.drawString(box_x + code_w + amount_w + 20, y - row_h + 3, number)
        y -= row_h
    c.drawString(40, y - 30, "1. Asset-size test is based on prior-year total assets.")
    c.showPage()
    c.save()
    return buf.getvalue()


@unittest.skipIf(canvas is None, "reportlab is required to build PDF fixtures")
class TestReportFormGrid(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with pdfplumber.open(io.BytesIO(build_form_pdf())) as pdf:
            cls.text = rebuild_page(pdf.pages[0], normalize_pdf_prose)

    def test_form_becomes_one_row_per_reported_item(self):
        self.assertIn("| No. | Section | Field | Options | Item code | Entry |", self.text)
        self.assertIn("| (1) |  | Date Made |  | QTFL 9912 | Mo. Day |", self.text)
        self.assertIn("| (2) | Rate of Interest | Nominal Rate |  | QTFL 7924 | Percent |", self.text)

    def test_sideways_option_labels_are_read_and_grouped_under_their_item(self):
        self.assertIn("(a) Insured by FSA; (b) Insured by Others; (c) Not Insured", self.text)
        self.assertIn("| QTFL 6133 | Check one |", self.text)

    def test_blank_entry_rows_are_counted_not_listed(self):
        self.assertIn("(3 blank entry rows)", self.text)
        self.assertNotIn("|  |  |  |  |  |  |", self.text)

    def test_prose_columns_are_read_one_column_at_a_time(self):
        first = "This report is authorized by law and your voluntary cooperation is needed."
        second = "The Federal Reserve may not conduct or sponsor a collection without a number."
        self.assertIn(first, self.text)
        self.assertIn(second, self.text)
        self.assertLess(self.text.index(first), self.text.index(second))


@unittest.skipIf(canvas is None, "reportlab is required to build PDF fixtures")
class TestLineItemSchedule(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with pdfplumber.open(io.BytesIO(build_line_item_pdf())) as pdf:
            cls.text = rebuild_page(pdf.pages[0], normalize_pdf_prose)

    def test_each_line_item_keeps_its_label_code_and_line_number(self):
        self.assertIn("| Item | Dollar Amounts in Thousands | BHCK | Amount |", self.text)
        self.assertIn("| M.1. | 1. Net interest income on a fully taxable equivalent basis | 4519 |  |", self.text)
        self.assertIn("| M.2. | 2. Net income before taxes | 4592 |  |", self.text)
        self.assertIn("| M.3. | 3. Number of employees | 4150 |  |", self.text)

    def test_dot_leaders_are_removed_and_footnotes_stay_prose(self):
        self.assertNotIn("....", self.text.split("| Item")[1].split("\n\n")[0])
        self.assertIn("| M.6. | 6. Trading revenue | A220 |  |", self.text)
        self.assertIn("1. Asset-size test is based on prior-year total assets.", self.text.split("| M.6.")[1])


class TestRotatedCellText(unittest.TestCase):
    def _char(self, text, x0, top, upright=True, up=True):
        size = 8.0
        if upright:
            return {"text": text, "x0": x0, "x1": x0 + 4, "top": top, "bottom": top + size, "size": size, "upright": True, "matrix": (8, 0, 0, 8, 0, 0)}
        return {"text": text, "x0": x0, "x1": x0 + size, "top": top, "bottom": top + 4, "size": size, "upright": False,
                "matrix": (0, 8, -8, 0, 0, 0) if up else (0, -8, 8, 0, 0, 0)}

    def test_upright_letter_then_bottom_to_top_label(self):
        chars = [self._char("(", 10, 100), self._char("a", 14, 100), self._char(")", 18, 100)]
        # "Farm" reading bottom to top: F lowest on the page.
        chars += [self._char(ch, 30, 90 - i * 4, upright=False) for i, ch in enumerate("Farm")]
        self.assertEqual(cell_text(chars), "(a) Farm")

    def test_top_to_bottom_label_is_read_in_its_own_direction(self):
        chars = [self._char(ch, 30, 50 + i * 4, upright=False, up=False) for i, ch in enumerate("Rate")]
        self.assertEqual(cell_text(chars), "Rate")


if __name__ == "__main__":
    unittest.main()
