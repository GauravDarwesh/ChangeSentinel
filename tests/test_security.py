import socket
import unittest
from unittest.mock import patch

from regmon.security import validate_public_http_url


class TestPublicUrlValidation(unittest.TestCase):
    def test_rejects_private_ip_addresses_and_url_credentials(self):
        for url in (
            "http://127.0.0.1/private",
            "http://10.0.0.5/admin",
            "https://user:pass@example.com/path",
            "http://localhost/status",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    validate_public_http_url(url)

    def test_dns_preflight_rejects_private_resolution(self):
        private_answer = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", 443))
        ]
        with patch("regmon.security.socket.getaddrinfo", return_value=private_answer):
            with self.assertRaisesRegex(ValueError, "non-public address"):
                validate_public_http_url(
                    "https://monitor.example.org/page",
                    resolve_dns=True,
                )

    def test_dns_preflight_accepts_public_resolution(self):
        public_answer = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))
        ]
        with patch("regmon.security.socket.getaddrinfo", return_value=public_answer):
            self.assertEqual(
                validate_public_http_url(
                    "https://monitor.example.org/page",
                    resolve_dns=True,
                ),
                "https://monitor.example.org/page",
            )


if __name__ == "__main__":
    unittest.main()
