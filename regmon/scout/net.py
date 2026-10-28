"""A polite, budgeted HTTP client for one regulator's sweep.

Every request goes through the same gates, in order:

1. the host must be one of the regulator's declared hosts and a public address;
2. robots.txt for that host must allow the path (fetched once per sweep);
3. the per-host delay is respected (robots Crawl-delay, never below the floor);
4. the regulator's request and time budget must not be spent.

Errors are typed so a channel can say *why* it stopped: a budget limit, a
robots rule, an access block (401/403/451), a server asking Scout to come
back later (429/503 with a long Retry-After), or an ordinary failure.

A 403/429/503 that is really a bot-check page (Cloudflare "Just a moment…",
regmon/botcheck.py) is not a refusal: the page is loaded once in a headless
browser (regmon/browser_fetch.py), which runs the check and returns the
server's own response. That load counts against the request budget, and a
host whose check the browser cannot pass is not tried again in the sweep.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlparse

from regmon.scout import robots as robots_mod
from regmon.scout.profiles import Defaults, Regulator
from regmon.scout.urls import host as host_of
from regmon.scout.urls import path_and_query
from regmon.security import REDIRECT_STATUSES, USER_AGENT, validate_public_http_url

MAX_REDIRECTS = 5
RETRYABLE_SERVER = {500, 502, 504}
DEFERRING = {429, 503}
BLOCKING = {401, 403, 451}
ROBOTS_MAX_BYTES = 512_000
CHALLENGE_STATUSES = {403, 405, 406, 429, 503}
REFUSALS = {403, 406}  # a bare refusal gets one browser attempt per host
CHALLENGE_MAX_BYTES = 600_000  # enough of an error body to recognise a bot check


class ScoutFetchError(Exception):
    kind = "failed"

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


class BudgetExhausted(ScoutFetchError):
    kind = "budget"


class RobotsDisallowed(ScoutFetchError):
    kind = "robots"


class AccessBlocked(ScoutFetchError):
    kind = "blocked"


class Deferred(ScoutFetchError):
    kind = "deferred"


class FetchFailed(ScoutFetchError):
    kind = "failed"


@dataclass(frozen=True)
class Response:
    url: str
    status: int
    headers: dict
    body: bytes

    @property
    def content_type(self) -> str:
        return str(self.headers.get("content-type", "")).split(";", 1)[0].strip().lower()


def requests_transport(url: str, headers: dict, timeout: float, max_bytes: int):
    """Default transport: one request, no redirects, decoded body capped at max_bytes."""
    import requests  # imported lazily so the review workflow needs no third-party packages

    from regmon.safe_http import BlockedDestination, public_destinations_only

    try:
        # Feeds and listings link to addresses Scout has never seen: the
        # connection itself refuses non-public addresses (DNS rebinding).
        with public_destinations_only():
            response = requests.get(url, headers=headers, timeout=timeout, allow_redirects=False, stream=True)
    except BlockedDestination as exc:
        raise FetchFailed(str(exc)) from exc
    try:
        status = response.status_code
        response_headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
        if status in CHALLENGE_STATUSES:
            # Keep the start of the body: a bot-check page is not a refusal.
            body = b""
            for chunk in response.iter_content(chunk_size=64 * 1024):
                body += chunk or b""
                if len(body) >= CHALLENGE_MAX_BYTES:
                    break
            return status, response_headers, body[:CHALLENGE_MAX_BYTES]
        if status in REDIRECT_STATUSES or status >= 400:
            return status, response_headers, b""
        declared = response_headers.get("content-length", "")
        if declared.isdigit() and int(declared) > max_bytes:
            raise FetchFailed(f"{url} declares {declared} bytes, over the {max_bytes}-byte limit", status=status)
        chunks, total = [], 0
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > max_bytes:
                raise FetchFailed(f"{url} exceeded the {max_bytes}-byte limit", status=status)
            chunks.append(chunk)
        return status, response_headers, b"".join(chunks)
    finally:
        response.close()


def retry_after_seconds(value, now: datetime) -> float | None:
    """Retry-After as seconds: a delta-seconds value or an HTTP-date (RFC 9110)."""
    if value is None:
        return None
    text = str(value).strip()
    if text.isdigit():
        return float(text)
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - now).total_seconds())


def is_challenge(status: int | None, headers: dict, body: bytes) -> str | None:
    """The bot-check vendor when a response is a challenge, else None.

    Headers count whatever the status (AWS WAF challenges with a 202); a page
    body only on the statuses challenges use.
    """
    from regmon import botcheck

    announced = botcheck.detect_headers(headers, status)
    if announced:
        return announced
    if status not in CHALLENGE_STATUSES:
        return None
    return botcheck.detect(body, status)


def browser_loader():
    """``load(url, in_scope, max_bytes)`` through headless Chrome, or None when no browser is installed."""
    try:
        from regmon import browser_fetch
    except ImportError:  # pragma: no cover - the review workflow has no browser
        return None
    if not browser_fetch.available():
        return None

    def load(url: str, in_scope, max_bytes: int):
        return browser_fetch.render(url, want="resource", in_scope=in_scope, max_bytes=max_bytes)

    return load


_DEFAULT = object()


class PoliteClient:
    def __init__(
        self,
        regulator: Regulator,
        defaults: Defaults,
        *,
        transport=None,
        browser=_DEFAULT,
        resolve_dns: bool = True,
        monotonic=time.monotonic,
        sleep=time.sleep,
        wall_clock=lambda: datetime.now(timezone.utc),
    ):
        self.regulator = regulator
        self.defaults = defaults
        self.transport = transport or requests_transport
        # Tests passing their own transport get no browser unless they ask.
        self.browser = (browser_loader() if transport is None else None) if browser is _DEFAULT else browser
        self.browser_refused: set[str] = set()
        self.browser_loads = 0
        self.resolve_dns = resolve_dns
        self.monotonic = monotonic
        self.sleep = sleep
        self.wall_clock = wall_clock
        self.max_requests = regulator.max_requests or defaults.max_requests_per_regulator
        self.max_seconds = regulator.max_seconds or defaults.max_seconds_per_regulator
        self.started = monotonic()
        self.requests = 0
        self.robots: dict[str, robots_mod.RobotsPolicy] = {}
        self.last_request_at: dict[str, float] = {}
        # Hosts whose robots.txt Crawl-delay exceeds max_crawl_delay_seconds.
        self.slow_hosts: dict[str, float] = {}
        self.headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}

    # ---- budget -----------------------------------------------------------------
    def elapsed(self) -> float:
        return self.monotonic() - self.started

    def remaining_requests(self) -> int:
        return max(0, self.max_requests - self.requests)

    def delay_for(self, host: str) -> float:
        policy = self.robots.get(host)
        crawl_delay = policy.crawl_delay if policy and policy.crawl_delay is not None else 0.0
        # Honour a site's Crawl-delay in full; never go below Scout's own floor.
        # A delay beyond max_crawl_delay_seconds is still honoured (being polite
        # is the point), but recorded so the sweep says why a channel stopped
        # early instead of only reporting a spent budget (CS-161).
        if float(crawl_delay) > float(self.defaults.max_crawl_delay_seconds):
            self.slow_hosts[host] = float(crawl_delay)
        return max(float(self.defaults.min_delay_seconds), float(crawl_delay))

    def can_afford(self, host: str, requests: int = 1) -> bool:
        if self.requests + requests > self.max_requests:
            return False
        return self.elapsed() + self.delay_for(host) * requests <= self.max_seconds

    def _spend(self, host: str, *, exempt: bool = False) -> None:
        if not exempt:
            if self.requests >= self.max_requests:
                raise BudgetExhausted(f"Request budget of {self.max_requests} reached")
            if self.elapsed() + self._wait_needed(host) > self.max_seconds:
                raise BudgetExhausted(f"Time budget of {int(self.max_seconds)}s reached")
        wait = self._wait_needed(host)
        if wait > 0:
            self.sleep(wait)
        self.last_request_at[host] = self.monotonic()
        self.requests += 1

    def _wait_needed(self, host: str) -> float:
        last = self.last_request_at.get(host)
        if last is None:
            return 0.0
        return max(0.0, last + self.delay_for(host) - self.monotonic())

    # ---- gates -----------------------------------------------------------------
    def _check_destination(self, url: str) -> str:
        host = host_of(url)
        if host not in self.regulator.hosts:
            raise FetchFailed(f"{url} is outside the hosts declared for {self.regulator.short_name}")
        try:
            validate_public_http_url(url, resolve_dns=self.resolve_dns)
        except ValueError as exc:
            raise FetchFailed(str(exc)) from exc
        return host

    def robots_for(self, url: str) -> robots_mod.RobotsPolicy:
        host = host_of(url)
        if host in self.robots:
            return self.robots[host]
        scheme = "https" if host in self.regulator.https_hosts else (urlparse(url).scheme or "https")
        target = f"{scheme}://{host}/robots.txt"
        policy = robots_mod.RobotsPolicy.disallow_all("unreachable")
        try:
            for hop in range(MAX_REDIRECTS + 1):
                # RFC 9309 asks crawlers to follow robots.txt redirects, even to
                # another host (Banxico serves it from anterior.banxico.org.mx).
                # The target must still be public; it never widens what Scout fetches.
                if hop == 0:
                    self._check_destination(target)
                else:
                    try:
                        validate_public_http_url(target, resolve_dns=self.resolve_dns)
                    except ValueError as exc:
                        raise FetchFailed(str(exc)) from exc
                status, headers, body = self._robots_request(target)
                if status in REDIRECT_STATUSES and headers.get("location"):
                    target = urljoin(target, headers["location"])
                    continue
                if 200 <= status < 300:
                    policy = robots_mod.parse(body.decode("utf-8", errors="replace"))
                elif status == 429:
                    # Rate limiting is an instruction to slow down, not a missing
                    # robots.txt: never read it as "allow everything".
                    policy = robots_mod.RobotsPolicy.disallow_all("unreachable")
                elif 400 <= status < 500:
                    policy = robots_mod.RobotsPolicy.allow_all("unavailable")
                break
        except ScoutFetchError:
            policy = robots_mod.RobotsPolicy.disallow_all("unreachable")
        except Exception:  # network failure: RFC 9309 treats robots as unreachable
            policy = robots_mod.RobotsPolicy.disallow_all("unreachable")
        self.robots[host] = policy
        return policy

    def _robots_request(self, target: str):
        """robots.txt with one retry on a transport error, 5xx or 429.

        Every other request already gets a second attempt; robots.txt had none,
        so one CDN blip blocked the whole regulator for the week's sweep.
        """
        status, headers, body = 0, {}, b""
        for attempt in (1, 2):
            self._spend(host_of(target), exempt=True)
            try:
                status, headers, body = self.transport(target, self.headers, self.defaults.request_timeout_seconds, ROBOTS_MAX_BYTES)
            except ScoutFetchError:
                raise
            except Exception:
                if attempt == 1 and self.can_afford(host_of(target)):
                    continue
                raise
            if (status >= 500 or status == 429) and attempt == 1 and self.can_afford(host_of(target)):
                continue
            break
        return status, headers, body

    def allowed_by_robots(self, url: str) -> bool:
        return self.robots_for(url).allowed(path_and_query(url))

    # ---- fetch -----------------------------------------------------------------
    def get(self, url: str, *, max_bytes: int | None = None) -> Response:
        cap = int(max_bytes or self.defaults.max_response_bytes)
        current = url
        visited = {current}
        for _hop in range(MAX_REDIRECTS + 1):
            host = self._check_destination(current)
            if not self.allowed_by_robots(current):
                policy = self.robots.get(host)
                if policy and policy.status == "unreachable":
                    raise AccessBlocked(f"robots.txt for {host} could not be read, so Scout must not crawl it this sweep")
                raise RobotsDisallowed(f"robots.txt for {host} disallows {path_and_query(current)}")
            status, headers = None, {}
            body = b""
            for attempt in (1, 2):
                self._spend(host)
                try:
                    status, headers, body = self.transport(current, self.headers, self.defaults.request_timeout_seconds, cap)
                except ScoutFetchError:
                    raise
                except Exception as exc:
                    if attempt == 1 and self.can_afford(host):
                        continue
                    raise FetchFailed(f"Request to {current} failed: {type(exc).__name__}: {exc}") from exc
                vendor = is_challenge(status, headers, body)
                if vendor:
                    return self._through_browser(current, host, status, vendor, cap)
                if status in DEFERRING:
                    wait = retry_after_seconds(headers.get("retry-after"), self.wall_clock())
                    wait = 30.0 if wait is None else wait
                    if attempt == 1 and wait <= self.defaults.retry_after_cap_seconds and self.elapsed() + wait <= self.max_seconds and self.remaining_requests() > 0:
                        self.sleep(wait)
                        continue
                    raise Deferred(f"{host} answered HTTP {status} and asked Scout to wait {int(wait)}s", status=status)
                if status in RETRYABLE_SERVER and attempt == 1 and self.can_afford(host):
                    continue
                break
            if status in REDIRECT_STATUSES:
                location = headers.get("location")
                if not location:
                    raise FetchFailed(f"Redirect from {current} had no Location header", status=status)
                target = urljoin(current, location)
                if target in visited:
                    raise FetchFailed(f"Redirect loop at {target}", status=status)
                visited.add(target)
                current = target
                continue
            if status in REFUSALS and self.browser is not None and host not in self.browser_refused:
                # A bare refusal is often aimed at non-browser clients (or at
                # cloud addresses, which the browser's own route may avoid).
                return self._through_browser(current, host, status, f"HTTP {status} refusal", cap)
            if status in BLOCKING:
                raise AccessBlocked(f"{host} refused access (HTTP {status})", status=status)
            if status is None or status >= 400:
                raise FetchFailed(f"HTTP {status} for {current}", status=status)
            return Response(url=current, status=status, headers=headers, body=body)
        raise FetchFailed(f"More than {MAX_REDIRECTS} redirects for {url}")

    def _through_browser(self, url: str, host: str, status: int, vendor: str, cap: int) -> Response:
        """Load a URL that answered with a bot check in the browser; the check runs there."""
        if self.browser is None:
            raise AccessBlocked(f"{host} answered with {vendor if vendor.startswith('HTTP') else 'a ' + vendor + ' bot check'} (HTTP {status}) and no browser is available to get past it", status=status)
        if host in self.browser_refused:
            raise AccessBlocked(f"{host} kept blocking the browser earlier in this sweep ({vendor})", status=status)
        self._spend(host)
        self.browser_loads += 1
        try:
            rendered = self.browser(url, lambda target: host_of(target) in self.regulator.hosts, cap)
        except Exception as exc:
            if type(exc).__name__ == "ChallengeNotPassed":
                self.browser_refused.add(host)
                raise AccessBlocked(f"{host} showed a {vendor} bot check that the browser could not get past", status=status) from exc
            raise FetchFailed(f"Browser load of {url} failed: {type(exc).__name__}: {exc}", status=status) from exc
        if rendered.status in BLOCKING | REFUSALS | {429}:
            self.browser_refused.add(host)
            raise AccessBlocked(f"{host} refused access (HTTP {rendered.status}), also in a browser", status=rendered.status)
        if rendered.status >= 400:
            raise FetchFailed(f"HTTP {rendered.status} for {url} (loaded in a browser)", status=rendered.status)
        response_headers = {str(k).lower(): str(v) for k, v in (rendered.headers or {}).items()}
        response_headers.setdefault("content-type", rendered.content_type)
        final = rendered.final_url or url
        if host_of(final) not in self.regulator.hosts:
            raise FetchFailed(f"{url} ended outside the hosts declared for {self.regulator.short_name}: {final}")
        return Response(url=final, status=rendered.status, headers=response_headers, body=rendered.body or b"")
