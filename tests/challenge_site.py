"""A local stand-in for a Cloudflare-protected regulator site, for real-browser tests.

It behaves like www.ffiec.gov did on 26 Oct 2026 in the ways that matter:

* without a clearance cookie every URL answers 403 with a "Just a moment..."
  managed-challenge page whose widget loads in a frame from another host
  (Cloudflare's is challenges.cloudflare.com);
* the widget reports success only after a moment, and the site issues its
  HttpOnly ``cf_clearance`` cookie only to a browser that does not announce
  itself as headless or automated, then the page reloads itself;
* with the cookie, pages and a PDF larger than one DevTools message are served.

``/hard/...`` stands for a check that wants a person: its widget never succeeds.
"""
from __future__ import annotations

import hashlib
import http.server
import threading
from contextlib import contextmanager

PDF = b"%PDF-1.4\n" + b"".join(hashlib.sha256(str(i).encode()).digest() * 64 for i in range(6000)) + b"\n%%EOF\n"  # ~12 MB
PAGE = (b"<!DOCTYPE html><html><head><title>Reporting Forms | FFIEC</title></head><body><main><h1>FFIEC 031 reporting forms</h1>"
        b"<p>Instructions for the September 2026 report date are available.</p><a href='/forms/big.pdf'>Instructions (PDF)</a>"
        b"</main><script>document.body.insertAdjacentHTML('beforeend','<p id=rendered>Rendered by script</p>')</script></body></html>")
TOKEN = "cleared-token"


def challenge_page(widget_origin: str, path: str) -> bytes:
    return f"""<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<script>window._cf_chl_opt={{cvId: '3',cZone: 'site.test',cType: 'managed',cRay: 'a507624efde45414'}};</script></head>
<body><div class="main-wrapper"><h1>Verifying you are human. This may take a few seconds.</h1>
<div id="widget"><iframe src="{widget_origin}/turnstile?path={path}" width="300" height="65"></iframe></div>
<input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-z9ita_response">
<div style="display:none">Verification successful. Waiting for site.test to respond</div></div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
<script>
window.addEventListener('message', function (event) {{
  if (event.data !== 'solved') return;
  fetch('/cdn-cgi/challenge-platform/verify?wd=' + String(navigator.webdriver), {{method: 'POST'}})
    .then(function (r) {{ if (r.ok) location.reload(); }});
}});
</script></body></html>""".encode("utf-8")


def widget_page(solvable: bool) -> bytes:
    script = "setTimeout(function(){parent.postMessage('solved','*')},800);" if solvable else ""
    return f"<!DOCTYPE html><html><body><label><input type=checkbox> Verify you are human</label><script>{script}</script></body></html>".encode()


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

        def cleared(self):
            return f"cf_clearance={TOKEN}" in (self.headers.get("Cookie") or "")

        def do_POST(self):
            hits.append(("POST", self.path))
            agent = self.headers.get("User-Agent") or ""
            if self.path.startswith("/cdn-cgi/challenge-platform/verify"):
                if "HeadlessChrome" in agent or "wd=true" in self.path:
                    return self.send(403, b"denied")
                return self.send(200, b"ok", "text/plain", [("Set-Cookie", f"cf_clearance={TOKEN}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax")])
            self.send(404, b"")

        def do_GET(self):
            hits.append(("GET", self.path))
            if self.path.startswith("/cdn-cgi/challenge-platform/h/"):
                return self.send(200, b"/* challenge orchestration */", "application/javascript")
            path = self.path.split("?", 1)[0]
            if not self.cleared() or path.startswith("/hard/"):
                return self.send(403, challenge_page(holder["widget"], path), extra=[("cf-mitigated", "challenge")])
            if path.endswith(".pdf"):
                return self.send(200, PDF, "application/pdf", [("Last-Modified", "Mon, 26 Oct 2026 06:00:00 GMT")])
            return self.send(200, PAGE)

    class Widget(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            hits.append(("WIDGET", self.path))
            body = widget_page(solvable="path=/hard/" not in self.path)
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    site = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
    widget = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Widget)
    holder["widget"] = f"http://localhost:{widget.server_address[1]}"
    for server in (site, widget):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{site.server_address[1]}", holder["widget"], hits
    finally:
        site.shutdown()
        widget.shutdown()
