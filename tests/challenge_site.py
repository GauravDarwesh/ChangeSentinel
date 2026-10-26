"""A local stand-in for bot-protected regulator sites, for real-browser tests.

``/forms/...`` behaves like www.ffiec.gov did on 26 Oct 2026 (Cloudflare):

* without a clearance cookie every URL answers 403 with a "Just a moment..."
  managed-challenge page whose widget loads in a frame from another host
  (Cloudflare's is challenges.cloudflare.com);
* the widget reports success only after a moment, and the site issues its
  HttpOnly ``cf_clearance`` cookie only to a browser that does not announce
  itself as headless or automated, then the page reloads itself;
* with the cookie, pages and a PDF larger than one DevTools message are served.

Other vendors and blocks, by path prefix:

* ``/hard/...``    a check that wants a person: its widget never succeeds.
* ``/imperva/...`` an Imperva-style page whose hCaptcha widget frame comes from
  ``newassets.hcaptcha.com`` (tests map that name to the widget server).
* ``/waf/...``     AWS WAF: HTTP 202 announced only by ``x-amzn-waf-action``.
* ``/kasada/...``  Kasada: a bare 429 with ``x-kpsdk-*`` headers and an ips.js check.
* ``/ua/...``      refuses any user agent that is not a browser (plain 403).
* ``/net/...``     refuses everything (plain 403) unless the request arrives
  through the owner's proxy (``serve_proxy``), like a site blocking cloud addresses.
"""
from __future__ import annotations

import base64
import hashlib
import http.client
import http.server
import threading
from contextlib import contextmanager
from urllib.parse import parse_qs, unquote, urlsplit

PDF = b"%PDF-1.4\n" + b"".join(hashlib.sha256(str(i).encode()).digest() * 64 for i in range(6000)) + b"\n%%EOF\n"  # ~12 MB
PAGE = (b"<!DOCTYPE html><html><head><title>Reporting Forms | FFIEC</title></head><body><main><h1>FFIEC 031 reporting forms</h1>"
        b"<p>Instructions for the September 2026 report date are available.</p><a href='/forms/big.pdf'>Instructions (PDF)</a>"
        b"</main><script>document.body.insertAdjacentHTML('beforeend','<p id=rendered>Rendered by script</p>')</script></body></html>")
TOKEN = "cleared-token"
HCAPTCHA_HOST = "newassets.hcaptcha.com"
# Clearance cookie per protected area.
COOKIES = {"/forms/": "cf_clearance", "/hard/": "cf_clearance", "/imperva/": "incap_ses_1", "/waf/": "aws-waf-token", "/kasada/": "KP_UIDz"}

# Every check below ends the same way: the page's script asks the site to
# verify, which only succeeds for a browser that is not flagged as headless or
# automated, and then reloads.
_VERIFY = ("fetch('/cdn-cgi/challenge-platform/verify?wd=' + String(navigator.webdriver) + '&path=' + encodeURIComponent(location.pathname), "
           "{method: 'POST'}).then(function (r) { if (r.ok) location.reload(); });")
_ON_SOLVED = "<script>window.addEventListener('message', function (event) { if (event.data === 'solved') { " + _VERIFY + " } });</script>"


def challenge_page(widget_origin: str, path: str) -> bytes:
    return f"""<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<script>window._cf_chl_opt={{cvId: '3',cZone: 'site.test',cType: 'managed',cRay: 'a507624efde45414'}};</script></head>
<body><div class="main-wrapper"><h1>Verifying you are human. This may take a few seconds.</h1>
<div id="widget"><iframe src="{widget_origin}/turnstile?path={path}" width="300" height="65"></iframe></div>
<input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-z9ita_response">
<div style="display:none">Verification successful. Waiting for site.test to respond</div></div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
{_ON_SOLVED}</body></html>""".encode("utf-8")


def imperva_page(widget_port: int, path: str) -> bytes:
    return (f"<!DOCTYPE html><html><head><title>Request unsuccessful</title></head><body>"
            f"<iframe src='http://{HCAPTCHA_HOST}:{widget_port}/hcaptcha?path={path}' width='300' height='80'></iframe>"
            f"<p>Request unsuccessful. Incapsula incident ID: 1234-5678</p>{_ON_SOLVED}</body></html>").encode()


WAF_PAGE = ("<!DOCTYPE html><html><head><title></title></head><body><div id='challenge-container'></div>"
            "<script>setTimeout(function () { " + _VERIFY + " }, 500);</script></body></html>").encode()
KASADA_PAGE = (b"<!DOCTYPE html><html><head></head><body><script>window.KPSDK={};KPSDK.now=0;KPSDK.start=KPSDK.now;</script>"
               b"<script src='/149e9513/2d206a39/ips.js?x=1'></script></body></html>")
KASADA_SCRIPT = _VERIFY.encode()


def widget_page(solvable: bool) -> bytes:
    script = "setTimeout(function(){parent.postMessage('solved','*')},800);" if solvable else ""
    return f"<!DOCTYPE html><html><body><label><input type=checkbox> Verify you are human</label><script>{script}</script></body></html>".encode()


def _area(path: str) -> str:
    return next((prefix for prefix in COOKIES if path.startswith(prefix)), "/forms/")


@contextmanager
def serve():
    """Yield (site_origin, widget_origin, hits). The two origins are different sites."""
    hits: list[tuple[str, str]] = []
    holder = {}

    class Site(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, status, body, content_type="text/html; charset=utf-8", extra=()):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for name, value in extra:
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def cleared(self, path):
            return f"{COOKIES[_area(path)]}={TOKEN}" in (self.headers.get("Cookie") or "")

        def content(self, path):
            if path.endswith(".pdf"):
                return self.send(200, PDF, "application/pdf", [("Last-Modified", "Mon, 26 Oct 2026 06:00:00 GMT")])
            return self.send(200, PAGE)

        def do_POST(self):
            hits.append(("POST", self.path))
            agent = self.headers.get("User-Agent") or ""
            if self.path.startswith("/cdn-cgi/challenge-platform/verify"):
                if "HeadlessChrome" in agent or "wd=true" in self.path:
                    return self.send(403, b"denied")
                path = unquote(parse_qs(urlsplit(self.path).query).get("path", ["/forms/"])[0])
                cookie = COOKIES[_area(path)]
                return self.send(200, b"ok", "text/plain", [("Set-Cookie", f"{cookie}={TOKEN}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax")])
            self.send(404, b"")

        def do_GET(self):
            hits.append(("GET", self.path))
            if self.path.startswith("/cdn-cgi/challenge-platform/h/"):
                return self.send(200, b"/* challenge orchestration */", "application/javascript")
            if "/ips.js" in self.path:
                return self.send(200, KASADA_SCRIPT, "application/javascript")
            path = self.path.split("?", 1)[0]
            agent = self.headers.get("User-Agent") or ""
            if path.startswith("/ua/"):
                return self.send(403, b"Forbidden", "text/plain") if "ChangeSentinel" in agent else self.content(path)
            if path.startswith("/net/"):
                if self.headers.get("X-Via-Proxy") != "1":
                    return self.send(403, b"<html><body><h1>Forbidden</h1></body></html>")
                return self.content(path)
            if path.startswith("/imperva/") and not self.cleared(path):
                return self.send(403, imperva_page(holder["widget_port"], path))
            if path.startswith("/waf/") and not self.cleared(path):
                return self.send(202, WAF_PAGE, extra=[("x-amzn-waf-action", "challenge")])
            if path.startswith("/kasada/") and not self.cleared(path):
                return self.send(429, KASADA_PAGE, extra=[("x-kpsdk-ct", "0abc"), ("x-kpsdk-r", "1-AA")])
            if not self.cleared(path) or path.startswith("/hard/"):
                return self.send(403, challenge_page(holder["widget"], path), extra=[("cf-mitigated", "challenge")])
            return self.content(path)

    class Widget(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            hits.append(("WIDGET", (self.headers.get("Host") or "") + self.path))
            body = widget_page(solvable="path=/hard/" not in self.path)
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    site = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
    widget = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Widget)
    holder["widget"] = f"http://localhost:{widget.server_address[1]}"
    holder["widget_port"] = widget.server_address[1]
    for server in (site, widget):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{site.server_address[1]}", holder["widget"], hits
    finally:
        site.shutdown()
        widget.shutdown()


@contextmanager
def serve_proxy(user: str = "owner", password: str = "s3cret"):
    """Yield (proxy_url_with_credentials, requests_seen): an HTTP proxy that needs Basic auth.

    It forwards plain-http requests and marks them ``X-Via-Proxy: 1``, so the
    ``/net/`` area can tell traffic that took the owner's route.
    """
    seen: list[str] = []
    expected = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    class Proxy(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def relay(self):
            if self.headers.get("Proxy-Authorization") != expected:
                self.send_response(407)
                self.send_header("Proxy-Authenticate", 'Basic realm="owner"')
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            seen.append(self.path)
            target = urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            payload = self.rfile.read(length) if length else None
            headers = {k: v for k, v in self.headers.items() if k.lower() not in {"proxy-authorization", "proxy-connection", "connection"}}
            headers["X-Via-Proxy"] = "1"
            connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=30)
            connection.request(self.command, (target.path or "/") + (("?" + target.query) if target.query else ""), body=payload, headers=headers)
            response = connection.getresponse()
            body = response.read()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in {"transfer-encoding", "connection", "content-length"}:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            connection.close()

        do_GET = relay
        do_POST = relay

    proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    try:
        yield f"http://{user}:{password}@127.0.0.1:{proxy.server_address[1]}", seen
    finally:
        proxy.shutdown()
