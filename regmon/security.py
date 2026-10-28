"""URL safety checks shared by URL registration, fetching, and redirects."""
from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit

REDIRECT_STATUSES = {301, 302, 303, 307, 308}
USER_AGENT = "Mozilla/5.0 (compatible; ChangeSentinel/0.6; +https://github.com/GauravDarwesh/ChangeSentinel)"
# The headers an ordinary browser sends, for one retry when a site refuses the
# monitor's own agent outright (the page reader does the same).
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


class DNSResolutionError(ValueError):
    """A hostname could not be resolved right now.

    Subclasses ValueError for backward compatibility, but callers must treat it
    as transient: a resolver hiccup is not proof that a URL is unsafe or gone.
    """


def retry_delay(response, default: float, cap: float = 60.0) -> float:
    """Honour a numeric Retry-After header (seconds), bounded by cap."""
    headers = getattr(response, "headers", None) or {}
    try:
        value = float(headers.get("retry-after"))
    except (TypeError, ValueError):
        return default
    return max(0.0, min(cap, value))


NUMERIC_LABEL = re.compile(r"(?:0x[0-9a-f]*|[0-9]+)")
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".arpa")
RESERVED_TEST_SUFFIXES = (".test", ".example", ".invalid")


def validate_public_http_url(value: str, *, resolve_dns: bool = False) -> str:
    """Reject non-HTTP URLs and obvious private/internal destinations.

    DNS resolution checks every returned address. Preflight reduces risk but
    does not completely prevent deliberate DNS rebinding; deployments needing
    stronger protection should also enforce outbound network egress policy.
    """
    raw = str(value or "").strip()
    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Only complete public HTTP(S) URLs can be monitored.")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URLs containing credentials are not allowed.")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("The URL contains an invalid port.") from exc
    if port == 0:
        raise ValueError("The URL contains an invalid port.")

    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith(BLOCKED_SUFFIXES):
        raise ValueError("Local or internal hostnames cannot be monitored.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        if not address.is_global:
            raise ValueError("Private, loopback, link-local, or reserved IP addresses are not allowed.")
        return raw

    if "." not in host or host.startswith(".") or ".." in host:
        raise ValueError("A public fully qualified hostname is required.")
    # No top-level domain is numeric, so a host ending in a number is an IPv4
    # address in shorthand form (127.1, 10.1, 0x7f.0.0.1). Resolvers and
    # browsers expand these to the address they encode, which could be
    # loopback or private, so they are refused even when DNS is not checked.
    if NUMERIC_LABEL.fullmatch(host.rsplit(".", 1)[-1]):
        raise ValueError("Use a hostname or a standard dotted IP address.")
    if resolve_dns and not host.endswith(RESERVED_TEST_SUFFIXES):
        try:
            answers = socket.getaddrinfo(
                host,
                port or (443 if scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except OSError as exc:
            raise DNSResolutionError(f"Could not resolve public hostname {host}: {exc}") from exc
        addresses = {answer[4][0].split("%", 1)[0] for answer in answers}
        if not addresses:
            raise ValueError(f"Hostname {host} did not resolve to an address.")
        for item in addresses:
            try:
                resolved = ipaddress.ip_address(item)
            except ValueError as exc:
                raise ValueError(f"Invalid DNS address for {host}: {item}") from exc
            if not resolved.is_global:
                raise ValueError(f"Hostname {host} resolves to a non-public address.")
    return raw
