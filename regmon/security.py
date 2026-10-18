"""URL safety checks shared by URL registration, fetching, and redirects."""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

REDIRECT_STATUSES = {301, 302, 303, 307, 308}
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
    if resolve_dns and not host.endswith(RESERVED_TEST_SUFFIXES):
        try:
            answers = socket.getaddrinfo(
                host,
                port or (443 if scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except OSError as exc:
            raise ValueError(f"Could not resolve public hostname {host}: {exc}") from exc
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
