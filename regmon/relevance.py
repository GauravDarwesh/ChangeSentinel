"""High-recall deterministic triage."""
from __future__ import annotations
import re
from urllib.parse import urlparse

REGULATORY_SIGNALS = (
    "guideline","regulatory","technical-standard","technical_standard","standard",
    "consultation","opinion","decision","recommendation","supervisory","report",
    "policy","requirement","rule","directive","regulation","mandate","disclosure",
    "governance","risk","consumer-protection",
)
# Only segments that are site utilities on any regulator site. Words such as
# "privacy", "about" or "accessibility" are also regulatory subjects
# (/rules/privacy, /about/regulations) and used to suppress AI and alerts.
UTILITY_PATH_SEGMENTS = {"contact","contact-us","careers","jobs","login","logout","sign-in","sitemap","cookies","cookie-policy"}
DOCUMENT_SUFFIXES = (".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".zip",".csv")

def triage(url: str, page_text: str="", content_type: str="") -> dict:
    parsed = urlparse(url)
    path = parsed.path.lower()
    segments = {s for s in path.split("/") if s}
    if any(path.endswith(suffix) for suffix in DOCUMENT_SUFFIXES):
        return {"candidate":True,"reason":"Document/file requires downstream content analysis","signals":[]}
    utility_hits = sorted(segments.intersection(UTILITY_PATH_SEGMENTS))
    if utility_hits:
        return {"candidate":False,"reason":"Obvious site utility page","signals":utility_hits}
    haystack = f"{url}\n{page_text or ''}".lower()
    signals = []
    for signal in REGULATORY_SIGNALS:
        normalized = signal.replace("_","-")
        if re.search(rf"(?<![a-z0-9-]){re.escape(normalized)}(?![a-z0-9-])", haystack):
            signals.append(signal)
    return {
        "candidate":True,
        "reason":"Regulatory signal detected" if signals else "No exclusion signal; retained for high-recall review",
        "signals":sorted(set(signals)),
    }
