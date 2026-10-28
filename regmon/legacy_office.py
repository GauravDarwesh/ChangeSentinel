"""Text from Word 97-2003 (.doc) files.

A .doc is an OLE2 compound file. Its text lives in the "WordDocument" stream as
pieces listed by the piece table (the CLX in the "0Table"/"1Table" stream): each
piece is either 8-bit Windows-1252 text or UTF-16LE text. Reading the pieces in
order gives the document's characters, with Word's control marks in place of
paragraph ends, table cells and fields. Those marks are turned into lines, cell
separators and field results, so a .doc reads like the .docx extractor's output:
paragraphs on their own lines and table rows as `| a | b |`.

Only text is read: no embedded objects, macros or images.
"""
from __future__ import annotations

import io
import struct

MAX_CHARACTERS = 20_000_000

_FIB_FLAGS = 0x000A          # FibBase flags; bit 9 (fWhichTblStm) picks 1Table over 0Table
_FIB_ENCRYPTED = 0x0100      # fEncrypted
_FIB_CLX = 0x01A2            # FibRgFcLcb97.fcClx / lcbClx


def _pieces(clx: bytes) -> list[tuple[int, int, int, bool]]:
    """(cp_start, cp_end, file_offset, compressed) for each piece of the CLX."""
    pos = 0
    while pos < len(clx) and clx[pos] == 0x01:        # Prc: property modifiers, skipped
        size = struct.unpack_from("<H", clx, pos + 1)[0]
        pos += 3 + size
    if pos >= len(clx) or clx[pos] != 0x02:
        raise ValueError("The Word file has no piece table")
    length = struct.unpack_from("<I", clx, pos + 1)[0]
    table = clx[pos + 5: pos + 5 + length]
    count = (len(table) - 4) // 12
    if count <= 0:
        raise ValueError("The Word file's piece table is empty")
    cps = struct.unpack_from(f"<{count + 1}I", table, 0)
    pieces = []
    for index in range(count):
        descriptor = table[4 * (count + 1) + 8 * index: 4 * (count + 1) + 8 * (index + 1)]
        fc = struct.unpack_from("<I", descriptor, 2)[0]
        compressed = bool(fc & 0x40000000)
        offset = (fc & 0x3FFFFFFF) // 2 if compressed else fc & 0x3FFFFFFF
        pieces.append((cps[index], cps[index + 1], offset, compressed))
    return pieces


def _characters(word: bytes, clx: bytes, text_length: int) -> str:
    out = []
    total = 0
    for start, end, offset, compressed in _pieces(clx):
        if start >= text_length:
            break
        count = min(end, text_length) - start
        if count <= 0:
            continue
        total += count
        if total > MAX_CHARACTERS:
            raise ValueError(f"The Word file has more than {MAX_CHARACTERS:,} characters")
        if compressed:
            out.append(word[offset: offset + count].decode("cp1252", "replace"))
        else:
            out.append(word[offset: offset + 2 * count].decode("utf-16-le", "replace"))
    return "".join(out)


def _clean(raw: str) -> list[str]:
    """Word's control marks to text lines; table rows become markdown rows."""
    # Fields: \x13 instruction \x14 result \x15 -> keep the result only.
    text, depth_stack = [], []
    for char in raw:
        if char == "\x13":
            depth_stack.append(False)       # inside the instruction
            continue
        if char == "\x14" and depth_stack:
            depth_stack[-1] = True          # result follows
            continue
        if char == "\x15" and depth_stack:
            depth_stack.pop()
            continue
        if depth_stack and not depth_stack[-1]:
            continue
        text.append(char)
    value = "".join(text)
    lines: list[str] = []
    cells: list[str] = []
    current: list[str] = []
    last_was_cell_end = False
    for char in value:
        if char == "\x07":                  # end of a cell, or of a row when no text follows
            cell = "".join(current).strip()
            current = []
            if cell == "" and cells and last_was_cell_end:
                # Two marks in a row: the second is the row-end mark. (An empty last
                # cell reads the same way; the piece text cannot tell them apart.)
                lines.append("| " + " | ".join(part.replace("|", r"\|") for part in cells) + " |")
                cells = []
            else:
                cells.append(cell)
            last_was_cell_end = True
            continue
        last_was_cell_end = False
        if char in "\r\x0b\x0c":           # paragraph, line break, page/section break
            line = "".join(current).strip()
            current = []
            if cells:
                current = [line, " "]       # a paragraph inside a table cell
                continue
            lines.append(line)
            continue
        if char == "\t":
            current.append("\t")
            continue
        if ord(char) < 32 or char in "�":
            continue                        # picture anchors, footnote marks, etc.
        current.append(char)
    tail = "".join(current).strip()
    if cells:
        lines.append("| " + " | ".join(part.replace("|", r"\|") for part in cells + ([tail] if tail else [])) + " |")
    elif tail:
        lines.append(tail)
    return lines


def extract_doc(body: bytes):
    """Return (text, "doc", error) for a Word 97-2003 document."""
    from regmon.content import normalize_text

    try:
        import olefile

        ole = olefile.OleFileIO(io.BytesIO(body))
        try:
            if not ole.exists("WordDocument"):
                raise ValueError("This Office file is not a Word 97-2003 document")
            word = ole.openstream("WordDocument").read()
            if len(word) < _FIB_CLX + 8:
                raise ValueError("The Word file header is truncated")
            flags = struct.unpack_from("<H", word, _FIB_FLAGS)[0]
            if flags & _FIB_ENCRYPTED:
                raise ValueError("The Word file is password-protected, so its text cannot be read")
            table_name = "1Table" if flags & 0x0200 else "0Table"
            if not ole.exists(table_name):
                raise ValueError(f"The Word file has no {table_name} stream")
            table = ole.openstream(table_name).read()
            fc_clx, lcb_clx = struct.unpack_from("<II", word, _FIB_CLX)
            # FibRgLw97: ccpText, ccpFtn, ccpHdd, ... The stories sit back to back in that order.
            ccp = struct.unpack_from("<8I", word, 0x004C)
            text_length = ccp[0] + ccp[1] + ccp[2]   # main text, footnotes, headers (contiguous)
            raw = _characters(word, table[fc_clx: fc_clx + lcb_clx], text_length)
        finally:
            ole.close()
        lines = _clean(raw)
        text = normalize_text("\n".join(lines))
        if not text.strip():
            return None, "doc", "The Word file contains no readable text"
        return text, "doc", None
    except Exception as exc:
        return None, "doc", f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------------------
# PowerPoint 97-2003 (.ppt): slide text is held in TextCharsAtom (UTF-16LE) and
# TextBytesAtom (8-bit) records of the "PowerPoint Document" stream. Records are
# walked in stream order, each SlideContainer starting a [SLIDE] section, so the
# output reads like the .pptx extractor's.
# ---------------------------------------------------------------------------

_PPT_SLIDE = 0x03EE
_PPT_NOTES = 0x03F0
_PPT_MAIN_MASTER = 0x03F8
_PPT_TEXT_CHARS = 0x0FA0
_PPT_TEXT_BYTES = 0x0FA8
_PPT_CSTRING = 0x0FBA


def _ppt_records(data: bytes, start: int, end: int, out: list, context: list, depth: int = 0) -> None:
    pos = start
    while pos + 8 <= end:
        ver_instance, rec_type, length = struct.unpack_from("<HHI", data, pos)
        body_start, body_end = pos + 8, min(end, pos + 8 + length)
        if (ver_instance & 0x000F) == 0x000F and depth < 32:
            if rec_type in (_PPT_SLIDE, _PPT_NOTES, _PPT_MAIN_MASTER):
                context.append(rec_type)
                if rec_type == _PPT_SLIDE:
                    out.append(("slide", ""))
                elif rec_type == _PPT_NOTES:
                    out.append(("notes", ""))
                _ppt_records(data, body_start, body_end, out, context, depth + 1)
                context.pop()
            else:
                _ppt_records(data, body_start, body_end, out, context, depth + 1)
        elif _PPT_MAIN_MASTER not in context:
            if rec_type == _PPT_TEXT_CHARS:
                out.append(("text", data[body_start:body_end].decode("utf-16-le", "replace")))
            elif rec_type == _PPT_TEXT_BYTES:
                out.append(("text", data[body_start:body_end].decode("cp1252", "replace")))
        pos = body_start + length


def extract_ppt(body: bytes):
    """Return (text, "ppt", error) for a PowerPoint 97-2003 presentation."""
    from regmon.content import normalize_text

    try:
        import olefile

        ole = olefile.OleFileIO(io.BytesIO(body))
        try:
            if not ole.exists("PowerPoint Document"):
                raise ValueError("This Office file is not a PowerPoint 97-2003 presentation")
            if ole.exists("EncryptedSummary"):
                raise ValueError("The presentation is password-protected, so its text cannot be read")
            stream = ole.openstream("PowerPoint Document").read()
        finally:
            ole.close()
        events: list = []
        _ppt_records(stream, 0, len(stream), events, [])
        # Sections in stream order: slides first, then each slide's notes page.
        # "*" is the slide-number placeholder; the notes master comes before the
        # first slide and carries only placeholders, so it is dropped.
        sections: list[tuple[str, list[str]]] = []
        for kind, value in events:
            if kind in ("slide", "notes"):
                sections.append((kind, []))
                continue
            text = value.replace("\r", "\n").replace("\x0b", "\n").strip()
            if text and text != "*" and sections:
                sections[-1][1].append(text)
        lines, slide = [], 0
        for kind, texts in sections:
            if kind == "slide":
                slide += 1
                lines.append(f"[SLIDE] {slide}")
                lines.extend(texts)
            elif texts and slide:
                lines.append("[NOTES] " + "\n".join(texts))
        text = normalize_text("\n".join(lines))
        if not any(not line.startswith("[SLIDE]") for line in text.splitlines()):
            return None, "ppt", "The presentation contains no readable text"
        return text, "ppt", None
    except Exception as exc:
        return None, "ppt", f"{type(exc).__name__}: {exc}"


def ole_kind(body: bytes) -> str | None:
    """'xls', 'doc' or 'ppt' for an OLE2 compound file, from its stream names."""
    try:
        import olefile

        ole = olefile.OleFileIO(io.BytesIO(body))
        try:
            if ole.exists("Workbook") or ole.exists("Book"):
                return "xls"
            if ole.exists("WordDocument"):
                return "doc"
            if ole.exists("PowerPoint Document"):
                return "ppt"
        finally:
            ole.close()
    except Exception:
        return None
    return None
