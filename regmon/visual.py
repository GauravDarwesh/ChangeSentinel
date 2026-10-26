"""Visual diff of two page screenshots (opt-in, browser-rendered monitors).

For a portal whose meaning lives in layout, images or canvas rather than in
extractable text, a monitor can keep a screenshot of each render
(``visual_compare: true``). Two screenshots are compared pixel by pixel after
padding to a common size; small differences (anti-aliasing, a blinking caret)
are ignored by a per-pixel threshold, and what remains is summarised as the
share of the page that looks different and up to a few dozen changed regions
(boxes on a coarse grid, merged when they touch). An overlay image marks the
regions on the new screenshot for the reviewer.

The text comparison stays the source of truth for CHANGED_URL. A visual
difference alone raises VISUAL_CHANGED only when the monitor sets
``visual_alert_threshold`` (the share of the page, 0.001-1) and the text and
markup are unchanged.

Pillow is used if it is installed (it comes with the PDF tooling); without it
screenshots are still kept and no comparison is made.
"""
from __future__ import annotations

import hashlib
import io

PIXEL_THRESHOLD = 48       # summed RGB difference below which a pixel counts as the same
CELL = 24                  # grid cell size for regions, in pixels
CELL_SHARE = 0.02          # share of a cell's pixels that must differ to mark it
MAX_REGIONS = 40
MAX_HEIGHT = 8000
OVERLAY_FILL = (255, 159, 28, 70)
OVERLAY_EDGE = (255, 120, 0, 255)


def available() -> bool:
    try:
        import PIL  # noqa: F401
    except ImportError:
        return False
    return True


def _image(png: bytes):
    from PIL import Image

    image = Image.open(io.BytesIO(png))
    image.load()
    image = image.convert("RGB")
    if image.height > MAX_HEIGHT:
        image = image.crop((0, 0, image.width, MAX_HEIGHT))
    return image


def _pad(image, width: int, height: int):
    from PIL import Image

    if image.size == (width, height):
        return image
    canvas = Image.new("RGB", (width, height), (255, 255, 255))
    canvas.paste(image, (0, 0))
    return canvas


def _regions(cells: list[list[bool]]) -> list[list[int]]:
    """Bounding boxes (in cells) of touching changed cells, largest first."""
    rows, cols = len(cells), len(cells[0]) if cells else 0
    seen = [[False] * cols for _ in range(rows)]
    boxes = []
    for r in range(rows):
        for c in range(cols):
            if not cells[r][c] or seen[r][c]:
                continue
            stack = [(r, c)]
            seen[r][c] = True
            top, left, bottom, right, size = r, c, r, c, 0
            while stack:
                y, x = stack.pop()
                size += 1
                top, left, bottom, right = min(top, y), min(left, x), max(bottom, y), max(right, x)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < rows and 0 <= nx < cols and cells[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            stack.append((ny, nx))
            boxes.append([left, top, right + 1, bottom + 1, size])
    boxes.sort(key=lambda box: -box[4])
    return boxes


def compare(before_png: bytes, after_png: bytes) -> dict:
    """Share of the page that looks different, changed regions, and an overlay PNG."""
    from PIL import Image, ImageChops, ImageDraw

    before, after = _image(before_png), _image(after_png)
    width, height = max(before.width, after.width), max(before.height, after.height)
    a, b = _pad(before, width, height), _pad(after, width, height)
    difference = ImageChops.difference(a, b).convert("RGB")
    # Sum the channels, then keep pixels that differ by more than the threshold.
    red, green, blue = difference.split()
    summed = ImageChops.add(ImageChops.add(red, green), blue)
    mask = summed.point(lambda value: 255 if value > PIXEL_THRESHOLD else 0, mode="L")
    histogram = mask.histogram()
    changed = histogram[255]
    total = width * height
    rows, cols = (height + CELL - 1) // CELL, (width + CELL - 1) // CELL
    small = mask.resize((cols, rows), resample=Image.Resampling.BOX)
    cells = [[small.getpixel((x, y)) > 255 * CELL_SHARE for x in range(cols)] for y in range(rows)]
    boxes = _regions(cells)
    regions = [[left * CELL, top * CELL, min(width, right * CELL), min(height, bottom * CELL)] for left, top, right, bottom, _size in boxes[:MAX_REGIONS]]
    overlay = b.convert("RGBA")
    layer = Image.new("RGBA", overlay.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for left, top, right, bottom in regions:
        draw.rectangle([left, top, right - 1, bottom - 1], fill=OVERLAY_FILL, outline=OVERLAY_EDGE, width=3)
    overlay = Image.alpha_composite(overlay, layer).convert("RGB")
    buffer = io.BytesIO()
    overlay.save(buffer, format="PNG", optimize=True)
    return {
        "changed_ratio": round(changed / total, 5) if total else 0.0,
        "changed_pixels": changed,
        "regions": regions,
        "region_count": len(boxes),
        "size_before": list(before.size),
        "size_after": list(after.size),
        "overlay_png": buffer.getvalue(),
    }


def digest(png: bytes) -> str:
    return hashlib.sha256(png).hexdigest()
