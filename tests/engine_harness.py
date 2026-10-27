"""Run regmon.engine.process_source against an isolated temporary data tree.

Used by regression tests that need several consecutive scans. Network,
discovery and AI are mocked; nothing touches the repository's real data/.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from regmon import engine
from regmon.config import SourceConfig
from regmon.fetch import FetchResult

URL = "https://example.test/policy"
SOURCE = SourceConfig(
    id="synthetic",
    name="Synthetic source",
    regulator="Synthetic Regulator",
    seed_urls=(URL,),
    allowed_prefixes=("https://example.test/",),
    allowed_domains=("example.test",),
    allowed_urls=(URL,),
)
COMPLETE = {
    "source_id": SOURCE.id, "method": "fixture", "state": "COMPLETE", "discovered": 1,
    "successful_pages": 1, "failed_pages": 0, "unresolved_failures": 0,
}
DEFAULTS = {
    "conditional_refresh_interval_hours": 0, "fetch_timeout_seconds": 5, "fetch_attempts": 1,
    "fetch_backoff_seconds": 0, "max_ai_candidates": 10, "ai_timeout_seconds": 5, "ai_attempts": 1,
    "max_ai_chars": 14000, "max_diff_lines": 250, "ai_concurrency": 1, "history_runs": 90,
    "fetch_workers": 2,
}
ANALYSIS = {
    "relevant": True, "topic": "Synthetic topic", "change_type": "amendment", "summary": "Synthetic summary",
    "impact": "Review", "effective_date": "Not stated", "affected_scope": "Synthetic scope",
    "actions": "Review", "reason": "Synthetic reason",
}


def html(body: str) -> bytes:
    return f"<html><body><main>{body}</main></body></html>".encode("utf-8")


def ok(body: bytes, content_type: str = "text/html; charset=utf-8") -> FetchResult:
    return FetchResult(200, content_type, len(body), None, None, hashlib.sha256(body).hexdigest(), body, False)


class Sandbox:
    """A temporary data/ tree with the engine's paths patched to point at it."""

    def __init__(self, defaults: dict | None = None, source: SourceConfig = SOURCE):
        self.defaults = dict(DEFAULTS, **(defaults or {}))
        self.source = source
        self.discovered = [url for url in source.seed_urls]
        self.discovery_meta = dict(COMPLETE, source_id=source.id)
        self._stack = contextlib.ExitStack()

    def __enter__(self):
        self.root = Path(self._stack.enter_context(tempfile.TemporaryDirectory()))
        self.data = self.root / "data"
        paths = {
            "SNAPSHOTS": self.data / "snapshots",
            "HTML_SNAPSHOTS": self.data / "snapshots" / "html",
            "HISTORY": self.data / "history",
            "REPORTS": self.data / "reports",
            "DISCOVERY": self.data / "discovery",
        }
        for directory in paths.values():
            directory.mkdir(parents=True, exist_ok=True)
        self._stack.enter_context(patch("regmon.engine.ROOT", self.root))
        self._stack.enter_context(patch("regmon.engine.DATA", self.data))
        for name, value in paths.items():
            self._stack.enter_context(patch(f"regmon.engine.{name}", value))
        self._stack.enter_context(patch("regmon.engine.DEFAULTS", self.defaults))
        self._stack.enter_context(patch.dict("regmon.engine._BROWSER_GIVEN_UP", clear=True))
        self._stack.enter_context(patch.dict("regmon.engine._BROWSER_LAST_FAILURE", clear=True))
        # Rechecks of a sudden 404/5xx wait seconds in production; not here.
        self.recheck_sleep = self._stack.enter_context(patch("regmon.engine._recheck_sleep"))
        self._stack.enter_context(patch("regmon.engine.discover", side_effect=lambda *_a, **_k: list(self.discovered)))
        self._stack.enter_context(
            patch("regmon.engine.load_discovery_metadata", side_effect=lambda *_a, **_k: dict(self.discovery_meta))
        )
        return self

    def __exit__(self, *exc):
        return self._stack.__exit__(*exc)

    def scan(self, fetch_side_effect, analyze_result=None, extract=None, persist=True):
        """Run one scan; persist the inventory as the workflow would."""
        result_value = analyze_result or {"status": "ok", "analysis": ANALYSIS}
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch("regmon.engine.fetch", side_effect=fetch_side_effect))
            analyze_mock = stack.enter_context(patch("regmon.engine.analyze", return_value=result_value))
            if extract is not None:
                stack.enter_context(patch("regmon.engine.extract_content", side_effect=extract))
            result = engine.process_source(self.source, "synthetic-run")
        if persist and result["report"]["baseline_update_allowed"]:
            self.write_inventory(result["inventory"])
        result["analyze_mock"] = analyze_mock
        return result

    def inventory(self) -> dict:
        path = self.data / "latest.json"
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))["sources"].get(self.source.id, {})

    def write_inventory(self, inventory: dict) -> None:
        (self.data / "latest.json").write_text(
            json.dumps({"schema_version": 2, "sources": {self.source.id: inventory}}), encoding="utf-8"
        )
