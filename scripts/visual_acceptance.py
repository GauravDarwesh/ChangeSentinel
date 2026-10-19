#!/usr/bin/env python3
"""Temporary post-deployment visual acceptance checks for ChangeSentinel.

The browser tests target the deployed GitHub Pages URL. PDF pages are rendered
from the saved, committed evidence files so reviewers can visually inspect the
same source documents used by the Docling regression test.
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "qa-artifacts"
OUT.mkdir(parents=True, exist_ok=True)
BASE_URL = os.environ.get(
    "CHANGESENTINEL_DASHBOARD_URL",
    "https://gauravdarwesh.github.io/ChangeSentinel/",
).rstrip("/") + "/"

PDF_FIXTURES = {
    "fr-2028bs": ROOT / (
        "data/snapshots/files/"
        "b6f72f741a1c310ad512e3f1482069fbd7f08af4b0e35d12535f15804e72c7e0-"
        "4ccc5bb26f325b80df4fc87d6e84f047b9a2124a3ca59f5cd595473420134b4a.pdf"
    ),
    "fr-2028d": ROOT / (
        "data/snapshots/files/"
        "5ccb64a08420a94259ab9286787d345cf0ec757a33ff3919d6d8efe4bcbd41db-"
        "db4bcb7b0f68a4208041e61f6fb6800f8e82ded8b26e1f7cfc461ebd06bb9cf4.pdf"
    ),
}

results: dict = {
    "dashboard_url": BASE_URL,
    "browser_checks": [],
    "pdf_renders": [],
    "errors": [],
    "console_errors": [],
}


def record_error(message: str) -> None:
    results["errors"].append(message)
    print("FAIL:", message, file=sys.stderr)


def render_saved_pdf_fixtures() -> None:
    import fitz

    for label, path in PDF_FIXTURES.items():
        if not path.is_file():
            record_error(f"Missing saved PDF fixture: {path}")
            continue
        try:
            document = fitz.open(path)
            # Render the first page and pages containing the critical tabular
            # labels used by the corresponding extraction regression.
            targets = {0}
            keywords = (
                ("Date Made", "Face Amount", "Rate of Interest", "Risk Rating")
                if label == "fr-2028bs"
                else ("QSBL", "Not Important", "Very Important", "HR19")
            )
            matched = []
            for page_index, page in enumerate(document):
                text = page.get_text("text")
                lowered = text.casefold()
                page_hits = [word for word in keywords if word.casefold() in lowered]
                if page_hits:
                    targets.add(page_index)
                    matched.extend(page_hits)
            for page_index in sorted(targets)[:6]:
                page = document[page_index]
                pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
                target = OUT / f"pdf-{label}-page-{page_index + 1:02d}.png"
                pixmap.save(target)
                results["pdf_renders"].append({
                    "fixture": label,
                    "page": page_index + 1,
                    "page_count": len(document),
                    "width": pixmap.width,
                    "height": pixmap.height,
                    "image": str(target.relative_to(ROOT)),
                    "matched_labels": sorted(set(matched)),
                })
            if len(document) == 0:
                record_error(f"PDF fixture has zero pages: {label}")
            document.close()
        except Exception as exc:
            record_error(f"Unable to render PDF fixture {label}: {type(exc).__name__}: {exc}")


def run_browser_checks() -> None:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        viewports = [
            ("desktop-1440", 1440, 1000),
            ("mobile-390", 390, 844),
            ("narrow-mobile-320", 320, 740),
        ]
        for name, width, height in viewports:
            context = browser.new_context(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
                is_mobile=width <= 650,
                has_touch=width <= 650,
            )
            page = context.new_page()
            js_errors = []
            console_errors = []
            failed_data_requests = []
            page.on("pageerror", lambda exc: js_errors.append(str(exc)))
            page.on(
                "console",
                lambda msg: console_errors.append(msg.text)
                if msg.type == "error" else None,
            )
            page.on(
                "requestfailed",
                lambda request: failed_data_requests.append({
                    "url": request.url,
                    "failure": request.failure,
                }) if "/data/" in request.url or "/config/" in request.url else None,
            )
            check = {
                "viewport": name,
                "width": width,
                "height": height,
                "url": BASE_URL,
                "http_status": None,
                "dashboard_status": None,
                "monitor_cards": 0,
                "document_width": None,
                "horizontal_overflow": None,
                "mobile_wordmark_visible": None,
                "javascript_errors": js_errors,
                "data_request_failures": failed_data_requests,
                "console_errors": console_errors,
            }
            results["browser_checks"].append(check)
            try:
                response = page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)
                check["http_status"] = response.status if response else None
                if response and response.status >= 400:
                    record_error(f"{name}: dashboard returned HTTP {response.status}")
                page.wait_for_function(
                    """() => {
                      const node = document.querySelector('#connectionStatus');
                      return node && node.textContent.trim() &&
                        !node.textContent.includes('Connecting to stored monitoring data');
                    }""",
                    timeout=45000,
                )
                page.wait_for_timeout(700)
                check["dashboard_status"] = page.locator("#connectionStatus").inner_text().strip()
                if "Stored data unavailable" in check["dashboard_status"]:
                    record_error(f"{name}: dashboard reports unavailable data: {check['dashboard_status']}")
                if "Could not load dashboard data" in page.locator("body").inner_text():
                    record_error(f"{name}: dashboard displayed a data-loading error")
                check["monitor_cards"] = page.locator(".monitor-card").count()
                if check["monitor_cards"] < 1:
                    record_error(f"{name}: no monitor cards rendered")
                if width <= 650:
                    wordmark = page.locator(".mobile-wordmark").first
                    check["mobile_wordmark_visible"] = wordmark.count() > 0 and wordmark.is_visible()
                    if not check["mobile_wordmark_visible"]:
                        record_error(f"{name}: mobile ChangeSentinel wordmark is missing or hidden")
                dims = page.evaluate("""() => ({
                  viewport: window.innerWidth,
                  document: document.documentElement.scrollWidth,
                  body: document.body.scrollWidth,
                  headingVisible: (() => {
                    const node = document.querySelector('#monitorsHeading');
                    if (!node) return false;
                    const r = node.getBoundingClientRect();
                    const s = getComputedStyle(node);
                    return s.display !== 'none' && s.visibility !== 'hidden' &&
                      r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth;
                  })()
                })""")
                check["document_width"] = dims["document"]
                check["horizontal_overflow"] = dims["document"] > width + 2
                check["dimensions"] = dims
                if check["horizontal_overflow"]:
                    record_error(f"{name}: document overflows horizontally ({dims['document']}px > {width}px)")
                if not dims["headingVisible"]:
                    record_error(f"{name}: primary dashboard heading is not visible")
                page.screenshot(path=str(OUT / f"dashboard-{name}-viewport.png"), full_page=False)
                page.screenshot(path=str(OUT / f"dashboard-{name}.png"), full_page=True)
                if js_errors:
                    record_error(f"{name}: JavaScript page errors: {js_errors}")
            except Exception as exc:
                record_error(f"{name}: {type(exc).__name__}: {exc}")
                traceback.print_exc()
                try:
                    page.screenshot(path=str(OUT / f"dashboard-{name}-failure.png"), full_page=True)
                except Exception:
                    pass
            finally:
                check["console_errors"] = console_errors[:30]
                check["data_request_failures"] = failed_data_requests[:30]
                context.close()

        # Exercise the saved PDF preview on the live dashboard, then view the
        # same page at mobile width and in the expanded reader state.
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        pdf_check = {
            "name": "pdf-preview-desktop-and-mobile",
            "found_matching_monitor": False,
            "preview_opened": False,
            "expanded_reader_opened": False,
            "mobile_overflow": None,
            "javascript_errors": [],
        }
        results["browser_checks"].append(pdf_check)
        try:
            page.on("pageerror", lambda exc: pdf_check["javascript_errors"].append(str(exc)))
            page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_function(
                "() => !!document.querySelector('#connectionStatus') && !document.querySelector('#connectionStatus').textContent.includes('Connecting')",
                timeout=45000,
            )
            # This saved PDF is one of the fixtures already validated by CI.
            card = page.locator(".monitor-card").filter(
                has_text="58f18be6-92e4-497c-ad0d-db006caa2e03"
            ).first
            if card.count() == 0:
                record_error("PDF preview QA: the FR 2028B/S saved-PDF monitor card was not rendered")
            else:
                pdf_check["found_matching_monitor"] = True
                card.locator('[data-monitor-id]').click()
                page.locator('[data-detail-tab="snapshot"]').click()
                page.wait_for_selector("#pdfViewerShell", timeout=45000)
                shell = page.locator("#pdfViewerShell")
                frame = page.locator("#pdfViewerShell iframe[title='Saved PDF snapshot']")
                pdf_check["preview_opened"] = shell.is_visible() and frame.is_visible()
                pdf_check["iframe_src_prefix"] = (frame.get_attribute("src") or "")[:20]
                if not pdf_check["preview_opened"]:
                    record_error("PDF preview QA: saved PDF iframe is not visible")
                frame.scroll_into_view_if_needed()
                page.wait_for_timeout(1800)  # Trigger loading=lazy and allow the PDF viewer to paint.
                page.screenshot(path=str(OUT / "dashboard-pdf-preview-desktop-viewport.png"), full_page=False)
                page.screenshot(path=str(OUT / "dashboard-pdf-preview-desktop.png"), full_page=True)
                frame.screenshot(path=str(OUT / "dashboard-pdf-frame-desktop.png"))

                page.set_viewport_size({"width": 390, "height": 844})
                page.wait_for_timeout(500)
                width_state = page.evaluate("""() => ({
                  viewport: innerWidth,
                  document: document.documentElement.scrollWidth,
                  frameWidth: document.querySelector('#pdfViewerShell iframe')?.getBoundingClientRect().width || 0,
                  frameHeight: document.querySelector('#pdfViewerShell iframe')?.getBoundingClientRect().height || 0
                })""")
                pdf_check["mobile_dimensions"] = width_state
                pdf_check["mobile_overflow"] = width_state["document"] > 392
                if pdf_check["mobile_overflow"]:
                    record_error(f"PDF preview QA: mobile detail page overflows horizontally: {width_state}")
                if width_state["frameWidth"] < 250 or width_state["frameHeight"] < 250:
                    record_error(f"PDF preview QA: mobile PDF frame is too small: {width_state}")
                frame.scroll_into_view_if_needed()
                page.wait_for_timeout(1200)
                page.screenshot(path=str(OUT / "dashboard-pdf-preview-mobile-viewport.png"), full_page=False)
                page.screenshot(path=str(OUT / "dashboard-pdf-preview-mobile.png"), full_page=True)
                frame.screenshot(path=str(OUT / "dashboard-pdf-frame-mobile.png"))
                page.locator('[data-pdf-action="expand"]').click()
                page.wait_for_function(
                    "() => document.querySelector('#pdfViewerShell')?.classList.contains('is-expanded')",
                    timeout=10000,
                )
                pdf_check["expanded_reader_opened"] = True
                page.screenshot(path=str(OUT / "dashboard-pdf-preview-mobile-expanded-viewport.png"), full_page=False)
                page.screenshot(path=str(OUT / "dashboard-pdf-preview-mobile-expanded.png"), full_page=True)
        except Exception as exc:
            record_error(f"PDF preview QA: {type(exc).__name__}: {exc}")
            traceback.print_exc()
            try:
                page.screenshot(path=str(OUT / "dashboard-pdf-preview-failure.png"), full_page=True)
            except Exception:
                pass
        finally:
            context.close()
            browser.close()


def main() -> None:
    render_saved_pdf_fixtures()
    try:
        run_browser_checks()
    except Exception as exc:
        record_error(f"Browser QA infrastructure failure: {type(exc).__name__}: {exc}")
        traceback.print_exc()
    summary_path = OUT / "visual-acceptance-summary.json"
    summary_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2))
    if results["errors"]:
        raise SystemExit(f"Visual acceptance failed with {len(results['errors'])} issue(s); see {summary_path}")
    print(f"Visual acceptance passed; artifacts in {OUT}")


if __name__ == "__main__":
    main()
