"""Connect-time destination checks for outbound monitoring requests.

``validate_public_http_url(..., resolve_dns=True)`` resolves a hostname before a
request is sent, but the HTTP client resolves it again when it opens the socket.
A record with a short TTL can answer a public address to the check and a
private one (cloud metadata, loopback, the runner's network) to the connection:
DNS rebinding, a time-of-check/time-of-use gap.

Inside ``public_destinations_only()``, every TCP connection the requests/urllib3
stack opens resolves the host itself, refuses if any returned address is not
globally routable, and connects to exactly the address it just checked. TLS is
unaffected: urllib3 still sends the original hostname as SNI and verifies the
certificate against it, because only the socket address is substituted.

Connections to a configured HTTP(S) proxy are left alone: the proxy resolves
the target, so the preflight check is the only one possible there. Outside the
context manager (AI and notification calls to fixed public APIs), behaviour is
unchanged.
"""
from __future__ import annotations

import contextlib
import ipaddress
import socket
import threading
import urllib.request
from typing import Iterator
from urllib.parse import urlsplit

from urllib3.util import connection as _connection


class BlockedDestination(ValueError):
    """The host resolved to a non-public address when the connection was opened.

    A ValueError, like every other scope or safety violation in regmon, so
    callers record it and never retry it.
    """


_state = threading.local()
_original_create_connection = _connection.create_connection


def _proxy_hosts() -> set[str]:
    hosts = set()
    for value in urllib.request.getproxies().values():
        try:
            host = urlsplit(value if "://" in value else "//" + value).hostname
        except ValueError:
            continue
        if host:
            hosts.add(host.rstrip(".").lower())
    return hosts


def _public_addresses(host: str, port: int) -> list[str]:
    answers = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    addresses: list[str] = []
    for _family, _type, _proto, _name, sockaddr in answers:
        text = str(sockaddr[0]).split("%", 1)[0]
        address = ipaddress.ip_address(text)
        if not address.is_global:
            raise BlockedDestination(
                f"{host} resolved to the non-public address {text} when the connection was opened"
            )
        if text not in addresses:
            addresses.append(text)
    if not addresses:
        raise socket.gaierror(f"{host} did not resolve to an address")
    return addresses


def _guarded_create_connection(address, *args, **kwargs):
    if not getattr(_state, "depth", 0):
        return _original_create_connection(address, *args, **kwargs)
    host, port = address
    bare = str(host).strip("[]").rstrip(".").lower()
    if bare in _proxy_hosts():
        return _original_create_connection(address, *args, **kwargs)
    last_error: OSError | None = None
    for ip in _public_addresses(bare, port):
        try:
            return _original_create_connection((ip, port), *args, **kwargs)
        except OSError as exc:
            last_error = exc
    raise last_error or OSError(f"Could not connect to {host}")


def install() -> None:
    """Route urllib3's connections through the guard (idempotent).

    The guard is inert unless a thread is inside public_destinations_only().
    """
    if _connection.create_connection is not _guarded_create_connection:
        _connection.create_connection = _guarded_create_connection


@contextlib.contextmanager
def public_destinations_only() -> Iterator[None]:
    """Refuse, at connect time, any connection to a non-public address."""
    install()
    _state.depth = getattr(_state, "depth", 0) + 1
    try:
        yield
    finally:
        _state.depth -= 1
