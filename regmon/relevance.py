"""High-recall deterministic triage for regulatory monitoring candidates."""

from pathlib import Path
from urllib.parse import urlparse


REGULATORY_SIGNALS = (
    "guideline",
    "regulatory",
    "technical-standard",
    "technical_standard",
    "standard",
    "consultation",
    "opinion",
    "decision",
    "recommendation",
    "supervisory",
    "report",
    "policy",
    "requirement",
    "rule",
    "directive",
    "regulation",
    "mandate",
    "disclosure",
    "governance",
    "risk",
    "consumer-protection",
)

UTILITY_PATH_SEGMENTS = {
    "about",
    "contact",
    "careers",
    "jobs",
    "privacy",
    "accessibility",
    "cookies",
    "login",
    "sitemap",
}

DOCUMENT_SUFFIXES = (
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".zip",
    ".csv",
)


def triage(url, page_text="", content_type=""):
    """
    Apply only high-recall deterministic rules.

    False is reserved for obvious utility pages. Regulatory pages without
    an explicit keyword remain candidates so the gate cannot silently hide
    material changes. AI remains the final semantic relevance decision.
    """
    parsed = urlparse(url)
    path = parsed.path.lower()
    segments = {segment for segment in path.split("/") if segment}

    if any(path.endswith(suffix) for suffix in DOCUMENT_SUFFIXES):
        return {
            "candidate": True,
            "reason": "Document/file requires downstream content analysis",
            "signals": [],
        }

    utility_hits = sorted(segments.intersection(UTILITY_PATH_SEGMENTS))
    if utility_hits:
        return {
            "candidate": False,
            "reason": "Obvious site utility page",
            "signals": utility_hits,
        }

    haystack = (url + "\n" + (page_text or "")).lower()
    signals = sorted({signal for signal in REGULATORY_SIGNALS if signal in haystack})
    if signals:
        return {
            "candidate": True,
            "reason": "Regulatory signal detected",
            "signals": signals,
        }

    return {
        "candidate": True,
        "reason": "No exclusion signal; retained for high-recall review",
        "signals": [],
    }
