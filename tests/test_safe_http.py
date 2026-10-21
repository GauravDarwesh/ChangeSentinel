"""Connect-time destination checks (DNS rebinding between preflight and socket)."""
import os
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import requests

from regmon import safe_http
from regmon.fetch import fetch
from regmon.safe_http import BlockedDestination, public_destinations_only

REAL_GETADDRINFO = socket.getaddrinfo


class _Ok(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<html><body>internal</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def no_proxy_env():
    return {key: value for key, value in os.environ.items() if "proxy" not in key.lower()}


class TestConnectTimeGuard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Ok)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def rebinding(self, host, port, *args, **kwargs):
        # The attacker's record now answers loopback.
        if host == "rebind.example":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
        return REAL_GETADDRINFO(host, port, *args, **kwargs)

    def test_a_host_that_rebinds_to_loopback_is_refused_at_connect_time(self):
        with patch.dict(os.environ, no_proxy_env(), clear=True), patch("socket.getaddrinfo", side_effect=self.rebinding):
            # Without the guard the request reaches the internal server...
            self.assertEqual(requests.get(f"http://rebind.example:{self.port}/", timeout=5).status_code, 200)
            # ...with it, the socket is never opened.
            with public_destinations_only(), self.assertRaises(BlockedDestination):
                requests.get(f"http://rebind.example:{self.port}/", timeout=5)

    def test_fetch_refuses_a_rebinding_host_even_after_a_public_preflight(self):
        with patch.dict(os.environ, no_proxy_env(), clear=True), \
                patch("socket.getaddrinfo", side_effect=self.rebinding), \
                patch("regmon.fetch.validate_public_http_url", return_value=None):
            with self.assertRaises(ValueError) as caught:
                fetch(f"http://rebind.example:{self.port}/", attempts=1, max_bytes=1024)
        self.assertIn("non-public address", str(caught.exception))

    def test_the_connection_goes_to_the_address_that_was_checked(self):
        calls = []
        with patch.object(safe_http, "_original_create_connection", side_effect=lambda address, *a, **k: calls.append(address) or "sock"), \
                patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]), \
                patch.object(safe_http, "_proxy_hosts", return_value=set()):
            with public_destinations_only():
                self.assertEqual(safe_http._guarded_create_connection(("public.example", 443), 5), "sock")
        self.assertEqual(calls, [("93.184.216.34", 443)])

    def test_any_private_answer_refuses_the_whole_host(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80)),
                   (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 80))]
        with patch("socket.getaddrinfo", return_value=answers), patch.object(safe_http, "_proxy_hosts", return_value=set()):
            with public_destinations_only(), self.assertRaises(BlockedDestination):
                safe_http._guarded_create_connection(("mixed.example", 80), 5)

    def test_a_configured_proxy_is_not_second_guessed(self):
        calls = []
        with patch.object(safe_http, "_original_create_connection", side_effect=lambda address, *a, **k: calls.append(address) or "sock"), \
                patch.object(safe_http, "_proxy_hosts", return_value={"proxy.internal"}):
            with public_destinations_only():
                safe_http._guarded_create_connection(("proxy.internal", 3128), 5)
        self.assertEqual(calls, [("proxy.internal", 3128)])

    def test_the_guard_is_inert_outside_the_context(self):
        calls = []
        safe_http.install()
        with patch.object(safe_http, "_original_create_connection", side_effect=lambda address, *a, **k: calls.append(address) or "sock"):
            safe_http._guarded_create_connection(("127.0.0.1", 80), 5)
        self.assertEqual(calls, [("127.0.0.1", 80)])


class TestNotModifiedClosesItsConnection(unittest.TestCase):
    def test_a_304_response_is_closed(self):
        from unittest.mock import MagicMock
        response = MagicMock(status_code=304, headers={"etag": '"v2"'})
        with patch("regmon.fetch.requests.get", return_value=response), patch("regmon.fetch.validate_public_http_url", return_value=None):
            result = fetch("https://example.org/page", etag='"v1"', max_bytes=1024)
        self.assertTrue(result.not_modified)
        response.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
