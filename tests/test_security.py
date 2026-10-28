import socket
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from regmon.security import DNSResolutionError, retry_delay, validate_public_http_url


def _answers(*addresses):
    return [
        (socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))
        for address in addresses
    ]


class TestPublicUrlValidation(unittest.TestCase):
    def assertRejected(self, url, pattern=None, **kwargs):
        with self.subTest(url=url):
            if pattern:
                with self.assertRaisesRegex(ValueError, pattern):
                    validate_public_http_url(url, **kwargs)
            else:
                with self.assertRaises(ValueError):
                    validate_public_http_url(url, **kwargs)

    def test_rejects_private_ip_addresses_and_url_credentials(self):
        for url in (
            "http://127.0.0.1/private",
            "http://10.0.0.5/admin",
            "https://user:pass@example.com/path",
            "https://user@example.com/path",
            "http://localhost/status",
        ):
            self.assertRejected(url)

    def test_rejects_every_non_public_address_family(self):
        for url in (
            "http://169.254.169.254/latest/meta-data/",  # cloud metadata
            "http://[::1]/",                             # IPv6 loopback
            "http://[::ffff:127.0.0.1]/",                # IPv4-mapped loopback
            "http://[fe80::1%25eth0]/",                  # link-local with zone id
            "http://[fd00::1]/",                         # unique local
            "http://[2001:db8::1]/",                     # documentation range
            "http://100.64.0.1/",                        # carrier-grade NAT
            "http://0.0.0.0/",
            "http://192.168.1.1/",
            "http://172.16.0.1/",
        ):
            self.assertRejected(url, "IP addresses are not allowed")

    def test_rejects_ipv4_shorthand_that_resolvers_expand(self):
        # 127.1 and 0x7f.0.0.1 both mean 127.0.0.1 to getaddrinfo and browsers;
        # they must be refused even when DNS is not consulted.
        for url in (
            "http://127.1/",
            "http://10.1/",
            "http://0x7f.0.0.1/",
            "http://0x7f000001/",
            "http://2130706433/",
            "http://017700000001/",
            "http://1.2.3.4.5/",
        ):
            self.assertRejected(url)

    def test_rejects_local_and_internal_hostnames(self):
        for url in (
            "http://LOCALHOST./",
            "http://localhost.localdomain/",
            "http://api.localhost/",
            "http://printer.lan/",
            "http://nas.home/",
            "http://service.internal/",
            "http://mac.local/",
            "http://1.0.0.127.in-addr.arpa/",
            "http://intranet/",
        ):
            self.assertRejected(url)

    def test_rejects_non_http_schemes_and_incomplete_urls(self):
        for url in (
            "ftp://example.com/file",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<p>x</p>",
            "gopher://example.com/",
            "example.com/page",
            "//example.com/page",
            "http:///no-host",
            "",
            None,
        ):
            self.assertRejected(url, "Only complete public HTTP")

    def test_rejects_invalid_ports(self):
        for url in ("http://example.com:99999/", "http://example.com:0/", "http://example.com:abc/"):
            self.assertRejected(url, "invalid port")

    def test_accepts_public_urls_and_returns_them_trimmed(self):
        self.assertEqual(validate_public_http_url("  https://www.example.com/a?b=1  "), "https://www.example.com/a?b=1")
        self.assertEqual(validate_public_http_url("HTTPS://Example.COM:8443/x"), "HTTPS://Example.COM:8443/x")
        self.assertEqual(validate_public_http_url("http://8.8.8.8/"), "http://8.8.8.8/")
        self.assertEqual(validate_public_http_url("http://[2606:4700:4700::1111]/"), "http://[2606:4700:4700::1111]/")
        self.assertEqual(validate_public_http_url("https://www.rbi.org.in/Scripts/x.aspx"), "https://www.rbi.org.in/Scripts/x.aspx")

    def test_dns_preflight_rejects_private_resolution(self):
        with patch("regmon.security.socket.getaddrinfo", return_value=_answers("10.0.0.8")):
            with self.assertRaisesRegex(ValueError, "non-public address"):
                validate_public_http_url("https://monitor.example.org/page", resolve_dns=True)

    def test_dns_preflight_rejects_when_any_answer_is_private(self):
        # Round-robin records must all be public: the client may pick any one.
        for private in ("127.0.0.1", "169.254.169.254", "::1", "fe80::1%eth0"):
            with self.subTest(private=private), patch(
                "regmon.security.socket.getaddrinfo", return_value=_answers("93.184.216.34", private)
            ):
                with self.assertRaisesRegex(ValueError, "non-public address"):
                    validate_public_http_url("https://monitor.example.org/page", resolve_dns=True)

    def test_dns_preflight_accepts_public_resolution(self):
        with patch("regmon.security.socket.getaddrinfo", return_value=_answers("93.184.216.34", "2606:2800:220:1::1")):
            self.assertEqual(
                validate_public_http_url("https://monitor.example.org/page", resolve_dns=True),
                "https://monitor.example.org/page",
            )

    def test_dns_preflight_uses_the_url_port_or_the_scheme_default(self):
        with patch("regmon.security.socket.getaddrinfo", return_value=_answers("93.184.216.34")) as lookup:
            validate_public_http_url("https://monitor.example.org/page", resolve_dns=True)
            validate_public_http_url("http://monitor.example.org/page", resolve_dns=True)
            validate_public_http_url("https://monitor.example.org:8443/page", resolve_dns=True)
        self.assertEqual([call.args[1] for call in lookup.call_args_list], [443, 80, 8443])

    def test_resolver_failure_is_transient_not_unsafe(self):
        with patch("regmon.security.socket.getaddrinfo", side_effect=socket.gaierror("temporary failure")):
            with self.assertRaises(DNSResolutionError) as caught:
                validate_public_http_url("https://monitor.example.org/page", resolve_dns=True)
        # Still a ValueError for older callers that catch only that.
        self.assertIsInstance(caught.exception, ValueError)

    def test_empty_or_malformed_dns_answers_are_rejected(self):
        with patch("regmon.security.socket.getaddrinfo", return_value=[]):
            with self.assertRaisesRegex(ValueError, "did not resolve"):
                validate_public_http_url("https://monitor.example.org/page", resolve_dns=True)
        with patch("regmon.security.socket.getaddrinfo", return_value=_answers("not-an-address")):
            with self.assertRaisesRegex(ValueError, "Invalid DNS address"):
                validate_public_http_url("https://monitor.example.org/page", resolve_dns=True)

    def test_reserved_test_domains_and_literal_ips_skip_dns(self):
        with patch("regmon.security.socket.getaddrinfo") as lookup:
            validate_public_http_url("https://fixture.example/page", resolve_dns=True)
            validate_public_http_url("https://site.test/page", resolve_dns=True)
            validate_public_http_url("https://8.8.8.8/page", resolve_dns=True)
        lookup.assert_not_called()

    def test_without_dns_preflight_no_lookup_happens(self):
        with patch("regmon.security.socket.getaddrinfo") as lookup:
            validate_public_http_url("https://monitor.example.org/page")
        lookup.assert_not_called()


class TestRetryDelay(unittest.TestCase):
    def response(self, headers):
        return SimpleNamespace(headers=headers)

    def test_numeric_retry_after_is_honoured(self):
        self.assertEqual(retry_delay(self.response({"retry-after": "7"}), 2.0), 7.0)
        self.assertEqual(retry_delay(self.response({"retry-after": "1.5"}), 2.0), 1.5)

    def test_retry_after_is_bounded(self):
        self.assertEqual(retry_delay(self.response({"retry-after": "86400"}), 2.0), 60.0)
        self.assertEqual(retry_delay(self.response({"retry-after": "86400"}), 2.0, cap=10.0), 10.0)
        self.assertEqual(retry_delay(self.response({"retry-after": "-5"}), 2.0), 0.0)

    def test_unusable_retry_after_falls_back_to_the_default(self):
        for headers in ({}, {"retry-after": ""}, {"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"}, None):
            with self.subTest(headers=headers):
                self.assertEqual(retry_delay(self.response(headers), 3.0), 3.0)
        self.assertEqual(retry_delay(None, 4.0), 4.0)
        self.assertEqual(retry_delay(object(), 4.0), 4.0)


if __name__ == "__main__":
    unittest.main()
