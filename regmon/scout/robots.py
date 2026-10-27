"""robots.txt handling per RFC 9309, plus the non-standard Crawl-delay.

urllib.robotparser ignores the * and $ wildcards that regulator sites use
(OSFI, EBA), so matching is implemented here: the longest matching rule wins
and Allow wins a tie. Crawl-delay is outside the RFC grammar but is honoured
conservatively when present.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import unquote

PRODUCT_TOKEN = "changesentinel"


@dataclass
class RobotsPolicy:
    rules: list[tuple[bool, str]] = field(default_factory=list)  # (allow, pattern)
    crawl_delay: float | None = None
    sitemaps: list[str] = field(default_factory=list)
    # "parsed", "unavailable" (4xx: everything allowed) or "unreachable" (5xx or
    # network failure: everything disallowed, RFC 9309 section 2.3.1.4).
    status: str = "parsed"

    @classmethod
    def allow_all(cls, status: str = "unavailable") -> "RobotsPolicy":
        return cls(status=status)

    @classmethod
    def disallow_all(cls, status: str = "unreachable") -> "RobotsPolicy":
        return cls(rules=[(False, "/")], status=status)

    def allowed(self, path_and_query: str) -> bool:
        target = _normalise(path_and_query or "/")
        best_length, best_allow = -1, True
        for allow, pattern in self.rules:
            if pattern == "":
                continue
            if _matches(pattern, target):
                length = len(pattern)
                if length > best_length or (length == best_length and allow and not best_allow):
                    best_length, best_allow = length, allow
        return best_allow


def _normalise(value: str) -> str:
    # Compare decoded forms so "%7E" and "~" match; keep "/" and "?" structure.
    try:
        return unquote(value)
    except Exception:  # pragma: no cover - unquote is lenient
        return value


_PATTERN_CACHE: dict[str, re.Pattern] = {}


def _matches(pattern: str, target: str) -> bool:
    compiled = _PATTERN_CACHE.get(pattern)
    if compiled is None:
        anchored = pattern.endswith("$")
        body = _normalise(pattern[:-1] if anchored else pattern)
        regex = "".join(".*" if ch == "*" else re.escape(ch) for ch in body)
        compiled = re.compile("^" + regex + ("$" if anchored else ""), re.DOTALL)
        _PATTERN_CACHE[pattern] = compiled
    return compiled.match(target) is not None


def parse(text: str, agent: str = PRODUCT_TOKEN) -> RobotsPolicy:
    """Parse robots.txt for `agent`, falling back to the * group."""
    agent = agent.lower()
    groups: list[tuple[list[str], list[tuple[bool, str]], list[float]]] = []
    sitemaps: list[str] = []
    current_agents: list[str] = []
    current_rules: list[tuple[bool, str]] = []
    current_delay: list[float] = []
    in_rules = False

    def close():
        if current_agents:
            groups.append((list(current_agents), list(current_rules), list(current_delay)))

    # RFC 9309 2.5: a UTF-8 byte order mark must be accepted. Left in place it
    # made line 1 "\ufeffuser-agent", so every rule was dropped (fail-open).
    for raw_line in str(text or "").lstrip("\ufeff").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = key.strip().lower(), value.strip()
        if key == "sitemap":
            if value:
                sitemaps.append(value)
            continue
        if key == "user-agent":
            if in_rules:
                close()
                current_agents, current_rules, current_delay = [], [], []
                in_rules = False
            current_agents.append(value.lower())
            continue
        if not current_agents:
            continue
        if key in {"allow", "disallow"}:
            in_rules = True
            current_rules.append((key == "allow", value))
        elif key == "crawl-delay":
            in_rules = True
            try:
                delay = float(value)
            except ValueError:
                continue
            if delay >= 0:
                current_delay.append(delay)
    close()

    specific = [group for group in groups if any(name != "*" and name == agent for name in group[0])]
    chosen = specific or [group for group in groups if "*" in group[0]]
    rules = [rule for group in chosen for rule in group[1]]
    delays = [delay for group in chosen for delay in group[2]]
    return RobotsPolicy(rules=rules, crawl_delay=max(delays) if delays else None, sitemaps=sitemaps, status="parsed")
