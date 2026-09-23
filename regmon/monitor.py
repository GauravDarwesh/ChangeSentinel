"""Compatibility CLI for the scalable monitoring engine.

The orchestration now lives in regmon.engine; these re-exports preserve the
original module entrypoint and useful helper imports for existing tests/tools.
"""
from regmon.ai import AIConfig, AI_REQUIRED_KEYS, parse_json, validate_analysis
from regmon.change import build_event_id, classify_change, make_diff, make_id, write_evidence
from regmon.content import normalize_html, normalize_text, extract_content
from regmon.discovery import canonical, discover, in_scope, parse_discovered_urls
from regmon.engine import load_previous, make_current_item, process_source, run, save_outputs
from regmon.fetch import fetch

main = __import__("regmon.engine", fromlist=["main"]).main

__all__ = [
    "AIConfig", "AI_REQUIRED_KEYS", "parse_json", "validate_analysis",
    "build_event_id", "classify_change", "make_diff", "make_id", "write_evidence",
    "normalize_html", "normalize_text", "extract_content",
    "canonical", "discover", "in_scope", "parse_discovered_urls",
    "load_previous", "make_current_item", "process_source", "run", "save_outputs",
    "fetch", "main",
]

if __name__ == "__main__":
    main()
