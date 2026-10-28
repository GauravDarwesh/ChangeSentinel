"""Scout: discovery of new regulator URLs.

Every network call goes through a fake transport, so these tests never touch a
real regulator site. They pin the behaviours the design depends on: polite
access (robots, delays, budgets, Retry-After), honest coverage statuses,
baseline-versus-new semantics, explainable relevance and the owner-only,
per-URL review decisions.
"""
from __future__ import annotations

import gzip
import json
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from regmon.scout import channels, robots
from regmon.scout.assess import assess
from regmon.scout.net import AccessBlocked, BudgetExhausted, Deferred, FetchFailed, PoliteClient, RobotsDisallowed, retry_after_seconds
from regmon.scout.profiles import ConfigError, load_config, parse_config
from regmon.scout.registry import Registry, apply_decision, best_title, load_decisions, read_json
from regmon.scout.review import ReviewError, apply_event, parse_request
from regmon.scout import sweep as sweep_mod
from regmon.scout.urls import canonical, candidate_id, slug_title
from regmon.scout.validate import validate

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")

FEED = """<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>{items}</channel></rss>"""
ITEM = "<item><title>{title}</title><link>{link}</link><pubDate>Fri, 2 Oct 2026 20:00:00 GMT</pubDate>{extra}</item>"


def feed(*items):
    return FEED.format(items="".join(ITEM.format(title=title, link=link, extra=extra) for title, link, extra in items)).encode()


def config_for(channels_list, **regulator):
    data = {
        "schema_version": 1,
        "objective": {"id": "test", "priority_types": ["rule", "consultation", "guidance", "reporting", "supervisory_letter", "enforcement",
                                                          "technical_standard", "qa", "decision_opinion"],
                      "out_of_objective_types": ["research", "statistics", "event", "media", "job"]},
        "defaults": {"min_delay_seconds": 1, "max_requests_per_regulator": 40, "max_seconds_per_regulator": 600},
        "regulators": [dict({
            "id": "ex", "name": "Example Regulator", "region": "EMEA", "hosts": ["reg.example.org"],
            "channels": channels_list,
        }, **regulator)],
    }
    return parse_config(data)


class FakeSite:
    """A scripted regulator site: url -> (status, headers, body) or a callable."""

    def __init__(self, pages=None, robots_txt="User-agent: *\nDisallow: /search/\n"):
        self.pages = dict(pages or {})
        self.robots_txt = robots_txt
        self.calls = []
        self.now = 0.0
        self.sleeps = []

    def transport(self, url, headers, timeout, cap):
        self.calls.append(url)
        if url.endswith("/robots.txt"):
            if isinstance(self.robots_txt, tuple):
                return self.robots_txt
            return 200, {"content-type": "text/plain"}, self.robots_txt.encode()
        page = self.pages.get(url)
        if callable(page):
            page = page()
        if page is None:
            return 404, {}, b""
        if isinstance(page, bytes):
            return 200, {"content-type": "text/html"}, page
        return page

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    def client(self, regulator, defaults):
        return PoliteClient(regulator, defaults, transport=self.transport, resolve_dns=False,
                            monotonic=self.monotonic, sleep=self.sleep)


class ScoutTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.sources = self.tmp / "sources.json"
        self.latest = self.tmp / "latest.json"
        self.sources.write_text(json.dumps({"sources": []}))
        self.latest.write_text(json.dumps({"schema_version": 2, "sources": {}}))
        self.data = self.tmp / "scout"

    def sweep(self, config, site, regulator="all"):
        return sweep_mod.run(config, self.data, sources_config=self.sources, latest_path=self.latest, regulator=regulator,
                             client_factory=lambda item: site.client(item, config.defaults), log=lambda *_: None)

    def registry(self, regulator_id="ex"):
        return Registry.load(self.data, regulator_id)

    def review(self):
        return json.loads((self.data / "review.json").read_text())


# ---------------------------------------------------------------- robots.txt

class TestRobots(unittest.TestCase):
    def test_wildcards_end_anchor_and_longest_match(self):
        policy = robots.parse("User-agent: *\nAllow: /core/*.css$\nDisallow: /core/\nDisallow: /*/media/oembed\nCrawl-delay: 10\nSitemap: https://x.org/s.xml\n")
        self.assertTrue(policy.allowed("/core/theme.css"))
        self.assertFalse(policy.allowed("/core/theme.css?v=1"))  # $ anchors the end
        self.assertFalse(policy.allowed("/core/script.js"))
        self.assertFalse(policy.allowed("/en/media/oembed"))
        self.assertTrue(policy.allowed("/publications"))
        self.assertEqual(policy.crawl_delay, 10.0)
        self.assertEqual(policy.sitemaps, ["https://x.org/s.xml"])

    def test_allow_wins_a_tie_and_specific_group_wins_over_star(self):
        policy = robots.parse("User-agent: *\nDisallow: /\n\nUser-agent: ChangeSentinel\nDisallow: /private\nAllow: /private\n")
        self.assertTrue(policy.allowed("/private/page"))
        self.assertTrue(policy.allowed("/anything"))

    def test_groups_for_the_same_agent_are_merged(self):
        policy = robots.parse("User-agent: *\nDisallow: /dyn\n\nUser-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /V\n")
        self.assertFalse(policy.allowed("/dyn/x"))
        self.assertFalse(policy.allowed("/V/x"))
        self.assertTrue(policy.allowed("/marco-normativo/x"))

    def test_unreachable_robots_disallows_and_missing_robots_allows(self):
        regulator = config_for([{"id": "c", "type": "feed", "label": "F", "url": "https://reg.example.org/feed"}]).regulators[0]
        defaults = config_for([{"id": "c", "type": "feed", "label": "F", "url": "https://reg.example.org/feed"}]).defaults
        site = FakeSite({"https://reg.example.org/feed": b"x"}, robots_txt=(503, {}, b""))
        with self.assertRaises(AccessBlocked):
            site.client(regulator, defaults).get("https://reg.example.org/feed")
        site = FakeSite({"https://reg.example.org/feed": b"x"}, robots_txt=(404, {}, b""))
        self.assertEqual(site.client(regulator, defaults).get("https://reg.example.org/feed").body, b"x")


# ---------------------------------------------------------------- polite client

class TestPoliteClient(unittest.TestCase):
    def setUp(self):
        self.config = config_for([{"id": "c", "type": "feed", "label": "F", "url": "https://reg.example.org/feed"}])
        self.regulator, self.defaults = self.config.regulators[0], self.config.defaults

    def test_crawl_delay_is_honoured_between_requests(self):
        site = FakeSite({"https://reg.example.org/a": b"a", "https://reg.example.org/b": b"b"}, robots_txt="User-agent: *\nCrawl-delay: 10\n")
        client = site.client(self.regulator, self.defaults)
        client.get("https://reg.example.org/a")
        client.get("https://reg.example.org/b")
        self.assertIn(10.0, site.sleeps)

    def test_robots_disallow_blocks_a_path(self):
        site = FakeSite({"https://reg.example.org/search/x": b"x"})
        with self.assertRaises(RobotsDisallowed):
            site.client(self.regulator, self.defaults).get("https://reg.example.org/search/x")
        self.assertNotIn("https://reg.example.org/search/x", site.calls)

    def test_request_budget_is_enforced(self):
        # robots.txt is a real request and counts: robots + two pages = 3.
        config = config_for([{"id": "c", "type": "feed", "label": "F", "url": "https://reg.example.org/feed"}], max_requests=3)
        site = FakeSite({f"https://reg.example.org/{index}": b"x" for index in range(5)})
        client = site.client(config.regulators[0], config.defaults)
        client.get("https://reg.example.org/0")
        client.get("https://reg.example.org/1")
        with self.assertRaises(BudgetExhausted):
            client.get("https://reg.example.org/2")
        self.assertNotIn("https://reg.example.org/2", site.calls)

    def test_long_retry_after_defers_and_short_one_is_waited_out(self):
        future = (datetime.now(timezone.utc) + timedelta(hours=2)).strftime("%a, %d %b %Y %H:%M:%S GMT")
        site = FakeSite({"https://reg.example.org/a": (429, {"retry-after": future}, b"")})
        with self.assertRaises(Deferred):
            site.client(self.regulator, self.defaults).get("https://reg.example.org/a")
        responses = iter([(503, {"retry-after": "5"}, b""), (200, {}, b"ok")])
        site = FakeSite({"https://reg.example.org/a": lambda: next(responses)})
        self.assertEqual(site.client(self.regulator, self.defaults).get("https://reg.example.org/a").body, b"ok")
        self.assertIn(5.0, site.sleeps)

    def test_retry_after_accepts_seconds_and_http_dates(self):
        now = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(retry_after_seconds("120", now), 120.0)
        self.assertEqual(retry_after_seconds("Wed, 21 Oct 2026 12:05:00 GMT", now), 300.0)
        self.assertIsNone(retry_after_seconds("soon", now))

    def test_redirects_may_not_leave_the_regulator_hosts_and_403_is_a_block(self):
        site = FakeSite({"https://reg.example.org/a": (302, {"location": "https://elsewhere.example.com/x"}, b"")})
        with self.assertRaises(FetchFailed):
            site.client(self.regulator, self.defaults).get("https://reg.example.org/a")
        site = FakeSite({"https://reg.example.org/a": (403, {}, b"")})
        with self.assertRaises(AccessBlocked):
            site.client(self.regulator, self.defaults).get("https://reg.example.org/a")

    def test_a_bot_check_is_read_through_the_browser_once_per_host(self):
        from regmon.browser_fetch import ChallengeNotPassed, Rendered

        challenge = (403, {"content-type": "text/html", "cf-mitigated": "challenge"},
                     b"<html><head><title>Just a moment...</title></head><body>cType: 'managed'</body></html>")
        listing = b"<html><body><a href='/forms/ffiec031'>FFIEC 031</a></body></html>"
        site = FakeSite({"https://reg.example.org/a": challenge, "https://reg.example.org/b": challenge})
        loads = []
        def browser(url, in_scope, cap):
            loads.append(url)
            self.assertTrue(in_scope("https://reg.example.org/x") and not in_scope("https://elsewhere.example.com/"))
            return Rendered(listing, url, 0, "", body=listing, headers={"content-type": "text/html"}, challenge="Cloudflare")
        client = PoliteClient(self.regulator, self.defaults, transport=site.transport, browser=browser, resolve_dns=False,
                              monotonic=site.monotonic, sleep=site.sleep)
        response = client.get("https://reg.example.org/a")
        self.assertEqual((response.status, response.body, response.content_type), (200, listing, "text/html"))
        self.assertEqual((loads, client.browser_loads), (["https://reg.example.org/a"], 1))
        # A host whose check the browser cannot pass is not retried in the sweep.
        def refuse(url, in_scope, cap):
            loads.append(url)
            raise ChallengeNotPassed("Cloudflare", b"")
        client = PoliteClient(self.regulator, self.defaults, transport=site.transport, browser=refuse, resolve_dns=False,
                              monotonic=site.monotonic, sleep=site.sleep)
        for url in ("https://reg.example.org/a", "https://reg.example.org/b"):
            with self.assertRaises(AccessBlocked):
                client.get(url)
        self.assertEqual(loads.count("https://reg.example.org/b"), 0)
        # Without a browser the block names the bot check; an honest 403 stays a plain block.
        client = site.client(self.regulator, self.defaults)
        with self.assertRaisesRegex(AccessBlocked, "bot check"):
            client.get("https://reg.example.org/a")

    def test_a_bare_refusal_gets_one_browser_attempt_per_host(self):
        from regmon.browser_fetch import Rendered

        listing = b"<html><body><a href='/forms/ffiec031'>FFIEC 031</a></body></html>"
        site = FakeSite({"https://reg.example.org/a": (403, {"content-type": "text/plain"}, b"Forbidden"),
                         "https://reg.example.org/b": (403, {"content-type": "text/plain"}, b"Forbidden")})
        answers = iter([Rendered(listing, "https://reg.example.org/a", 0, "", body=listing, headers={"content-type": "text/html"}),
                        Rendered(b"", "https://reg.example.org/b", 0, "", status=403, body=b"Forbidden", headers={})])
        loads = []
        def browser(url, in_scope, cap):
            loads.append(url)
            return next(answers)
        client = PoliteClient(self.regulator, self.defaults, transport=site.transport, browser=browser, resolve_dns=False,
                              monotonic=site.monotonic, sleep=site.sleep)
        self.assertEqual(client.get("https://reg.example.org/a").body, listing)
        with self.assertRaisesRegex(AccessBlocked, "also in a browser"):
            client.get("https://reg.example.org/b")
        with self.assertRaises(AccessBlocked):
            client.get("https://reg.example.org/b")
        self.assertEqual(len(loads), 2)  # refused in the browser once: not tried again this sweep

    def test_an_aws_waf_challenge_with_status_202_is_recognised(self):
        from regmon.scout.net import is_challenge

        self.assertEqual(is_challenge(202, {"x-amzn-waf-action": "challenge"}, b"<html></html>"), "AWS WAF")
        self.assertIsNone(is_challenge(200, {}, b"<html><title>Just a moment...</title></html>"))

    def test_private_destinations_are_refused(self):
        config = config_for([{"id": "c", "type": "feed", "label": "F", "url": "https://reg.example.org/feed"}])
        site = FakeSite({})
        client = site.client(config.regulators[0], config.defaults)
        with self.assertRaises(FetchFailed):
            client.get("http://127.0.0.1/admin")


# ---------------------------------------------------------------- parsers

class TestParsers(unittest.TestCase):
    def test_sitemap_index_urlset_alternates_and_gzip(self):
        index = b'<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>http://reg.example.org/sitemap.xml?page=1</loc></sitemap></sitemapindex>'
        document = channels.parse_sitemap(index, "https://reg.example.org/sitemap.xml")
        self.assertEqual(document.kind, "index")
        self.assertEqual(document.entries[0]["loc"], "http://reg.example.org/sitemap.xml?page=1")
        urlset = (b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>https://reg.example.org/en/a</loc>'
                  b'<xhtml:link rel="alternate" hreflang="fr" href="https://reg.example.org/fr/a"/><lastmod>2026-10-01T09:00:00-04:00</lastmod></url></urlset>')
        document = channels.parse_sitemap(gzip.compress(urlset), "https://reg.example.org/s.xml.gz")
        self.assertEqual(document.kind, "urlset")
        self.assertEqual(document.entries[0]["alternates"], {"fr": "https://reg.example.org/fr/a"})
        self.assertEqual(document.entries[0]["lastmod"], "2026-10-01T13:00:00Z")

    def test_entity_declarations_are_refused_but_plain_doctype_and_cdata_are_fine(self):
        bomb = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;">]><urlset>&b;</urlset>'
        with self.assertRaises(channels.ParseError):
            channels.parse_sitemap(bomb, "https://reg.example.org/s.xml")
        rss = b'<?xml version="1.0"?><!DOCTYPE rss PUBLIC "-//Netscape//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd"><rss version="0.91"><channel><item><title><![CDATA[A [bracketed] title]]></title><link>https://reg.example.org/a</link></item></channel></rss>'
        items = channels.parse_feed(rss, "https://reg.example.org/feed")
        self.assertEqual(items[0].title, "A [bracketed] title")

    def test_rss_rdf_and_atom_feeds(self):
        rdf = (b'<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">'
               b'<item rdf:about="https://reg.example.org/a"><title>Form update</title><link>https://reg.example.org/a</link><dc:date>2026-10-16</dc:date><dc:subject>Reporting</dc:subject>'
               b'<description>&lt;a href="/forms/FR_X"&gt;FR X instructions&lt;/a&gt; posted</description></item></rdf:RDF>')
        items = channels.parse_feed(rdf, "https://reg.example.org/feed")
        self.assertEqual(items[0].link, "https://reg.example.org/a")
        self.assertEqual(items[0].published, "2026-10-16T00:00:00Z")
        self.assertEqual(items[0].categories, ["Reporting"])
        self.assertEqual(items[0].description_links, [("https://reg.example.org/forms/FR_X", "FR X instructions")])
        atom = (b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Consultation</title><link rel="alternate" href="/cp/1"/>'
                b'<updated>2026-10-01T10:00:00Z</updated><category term="Consultations"/></entry></feed>')
        items = channels.parse_feed(atom, "https://reg.example.org/feed")
        self.assertEqual((items[0].link, items[0].categories), ("https://reg.example.org/cp/1", ["Consultations"]))

    def test_listing_keeps_item_context_and_the_descriptive_label(self):
        html = """<html><body><header><nav><a href="/about">About</a></nav></header><main>
          <div class="views-row"><article><header><a href="/docs/a.pdf">Guidelines on ICT risk</a></header>
            <p>20 October 2026</p><a href="/docs/a.pdf">Download document</a></article></div>
          <table><tr><td><a href="/c/12-2026">12/2026</a></td><td>Modifica la Circular 3/2012</td></tr></table>
          <div class="search-result"><h2><a href="/news/x">APRA consults on reporting</a></h2><p>Banking Media release Published 16 October 2026</p></div>
        </main><footer><a href="/privacy">Privacy</a></footer></body></html>"""
        links = {link.url: link for link in channels.harvest_listing(html, "https://reg.example.org/list")}
        self.assertNotIn("https://reg.example.org/about", links)
        self.assertNotIn("https://reg.example.org/privacy", links)
        self.assertEqual(links["https://reg.example.org/docs/a.pdf"].anchor_text, "Guidelines on ICT risk")
        self.assertEqual(links["https://reg.example.org/docs/a.pdf"].date_hint, "2026-10-20")
        self.assertIn("Modifica la Circular 3/2012", links["https://reg.example.org/c/12-2026"].context)
        self.assertEqual(links["https://reg.example.org/news/x"].date_hint, "2026-10-16")

    def test_a_selector_that_no_longer_matches_is_a_layout_change(self):
        with self.assertRaises(channels.ParseError):
            channels.harvest_listing("<main><a href='/a'>A</a></main>", "https://reg.example.org/list", ".views-element-container")

    def test_generic_labels_and_titles(self):
        for label in ("211 KB", "N/A", "link", "Download document", "View press release", "PDF"):
            with self.subTest(label=label):
                self.assertTrue(channels.is_generic(label))
        self.assertFalse(channels.is_generic("FR Y-9C Instructions"))
        record = {"url": "https://reg.example.org/c/12-2026", "evidence": {"anchor_text": "12/2026", "context": "12/2026 Modifica la Circular 3/2012"}}
        self.assertEqual(best_title(record), "12/2026 Modifica la Circular 3/2012")
        record = {"url": "https://reg.example.org/a?guid=1", "evidence": {"anchor_text": "211 KB", "context": "FR 4004 211 KB N/A N/A link Not Available"}}
        self.assertEqual(best_title(record), "FR 4004")
        self.assertEqual(slug_title("https://reg.example.org/en/guidance/new-liquidity-guideline"), "New liquidity guideline")


class TestUrlIdentity(unittest.TestCase):
    def test_canonical_matches_the_monitor(self):
        from regmon.discovery import canonical as monitor_canonical

        for url in ("https://WWW.Example.org/a/b/?utm_source=x&b=2&a=1#frag", "http://reg.example.org/", "https://reg.example.org/x%20y.pdf",
                    "https://reg.example.org/download?id=12345&fbclid=z"):
            with self.subTest(url=url):
                self.assertEqual(canonical(url), monitor_canonical(url))
        self.assertEqual(canonical("http://reg.example.org/a/", frozenset({"reg.example.org"})), "https://reg.example.org/a")
        self.assertEqual(len(candidate_id("https://reg.example.org/a")), 16)


# ---------------------------------------------------------------- relevance

class TestAssessment(unittest.TestCase):
    def setUp(self):
        self.config = load_config(ROOT / "config" / "scout.json")
        self.fed = self.config.regulator("fed")

    def judge(self, url, regulator=None, **evidence):
        return assess({"url": url, "evidence": evidence, "origin": "new"}, regulator or self.fed, self.config.objective)

    def test_generic_url_with_descriptive_link_text_is_relevant(self):
        result = self.judge("https://www.federalreserve.gov/download?id=12345", anchor_text="Current reporting instructions",
                            context="FR Y-9C Current reporting instructions (PDF)")
        self.assertEqual(result["outcome"], "relevant")
        self.assertEqual(result["publication_type"]["id"], "reporting")
        self.assertTrue(result["reasons"])

    def test_missing_evidence_is_uncertain_not_irrelevant(self):
        result = self.judge("https://www.federalreserve.gov/files/document.pdf")
        self.assertEqual(result["outcome"], "uncertain")
        self.assertEqual(result["format"], "PDF")

    def test_utility_pages_are_set_aside_with_reasons(self):
        result = self.judge("https://www.federalreserve.gov/careers/openings", title="Careers at the Board")
        self.assertEqual(result["outcome"], "irrelevant")
        self.assertTrue(any(reason["effect"] == "-" for reason in result["reasons"]))

    def test_a_cookie_law_guidance_document_is_not_rejected_for_its_path(self):
        result = self.judge("https://www.federalreserve.gov/legal/cookies", title="Guidance on cookies and similar technologies")
        self.assertNotEqual(result["outcome"], "irrelevant")

    def test_speeches_are_uncertain_and_research_is_out_of_objective(self):
        self.assertEqual(self.judge("https://www.federalreserve.gov/newsevents/speech/x.htm", title="Speech by Governor X on payments")["outcome"], "uncertain")
        self.assertEqual(self.judge("https://www.federalreserve.gov/econres/feds/x.htm", title="Working paper on household finance")["outcome"], "irrelevant")
        conflicting = self.judge("https://www.federalreserve.gov/econres/feds/x.htm", title="Working paper on capital requirements")
        self.assertEqual((conflicting["outcome"], conflicting["confidence"]), ("uncertain", "conflicting"))

    def test_curated_path_hints_outrank_address_words(self):
        osfi = self.config.regulator("osfi")
        result = self.judge("https://www.osfi-bsif.gc.ca/en/guidance/guidance-library/liquidity-adequacy-requirements", osfi)
        self.assertEqual(result["outcome"], "relevant")
        self.assertEqual(result["publication_type"]["id"], "guidance")


# ---------------------------------------------------------------- sweeps

FEED_URL = "https://reg.example.org/feed.xml"
LIST_URL = "https://reg.example.org/publications"


def listing(*rows):
    return ("<html><body><main><ul>" + "".join(
        f'<li>{date} <a href="{href}">{title}</a></li>' for date, href, title in rows) + "</ul></main></body></html>").encode()


class TestSweeps(ScoutTestCase):
    def feed_config(self, **regulator):
        return config_for([{"id": "ex-feed", "type": "feed", "label": "News", "url": FEED_URL}], **regulator)

    def test_first_sweep_is_a_quiet_baseline_and_later_items_are_new(self):
        config = self.feed_config()
        site = FakeSite({FEED_URL: feed(("Final rule on liquidity", "https://reg.example.org/n/1", ""))})
        latest = self.sweep(config, site)
        self.assertEqual(latest["status"], "COMPLETE")
        self.assertEqual(latest["totals"]["new"], 0)
        self.assertEqual(self.review()["candidates"][0]["origin"], "baseline")
        site.pages[FEED_URL] = feed(("Proposed guidance on climate risk", "https://reg.example.org/n/2", ""),
                                    ("Final rule on liquidity", "https://reg.example.org/n/1", ""))
        latest = self.sweep(config, site)
        self.assertEqual(latest["totals"]["new"], 1)
        new = [item for item in self.review()["candidates"] if item["origin"] == "new"]
        self.assertEqual([item["url"] for item in new], ["https://reg.example.org/n/2"])
        self.assertEqual(new[0]["assessment"]["outcome"], "relevant")
        self.assertEqual(validate(config, self.data), [])

    def test_a_newly_added_channel_has_its_own_quiet_baseline(self):
        config = self.feed_config()
        site = FakeSite({FEED_URL: feed(("Rule", "https://reg.example.org/n/1", ""))})
        self.sweep(config, site)
        both = config_for([
            {"id": "ex-feed", "type": "feed", "label": "News", "url": FEED_URL},
            {"id": "ex-list", "type": "listing", "label": "Publications", "url": LIST_URL},
        ])
        site.pages[LIST_URL] = listing(("1 Oct 2026", "/docs/old.pdf", "Old guidelines"), ("2 Oct 2026", "/n/1", "Rule"))
        latest = self.sweep(both, site)
        self.assertEqual(latest["totals"]["new"], 0, "a new channel's existing items are baseline, not new")

    def test_depth_limited_listing_discovers_replacement_pdf_links_weekly(self):
        root = "https://reg.example.org/user-guides"
        child = "https://reg.example.org/user-guides/current"
        old_pdf = "https://reg.example.org/documents/FR-2028D-user-guide.pdf"
        new_pdf = "https://reg.example.org/documents/FR-2028D-user-guide-revised.pdf"
        config = config_for([{
            "id": "ex-user-guides",
            "type": "listing",
            "label": "User guides",
            "url": root,
            "link_prefixes": ["https://reg.example.org/"],
            "crawl_depth": 2,
        }])
        site = FakeSite({
            root: b'<html><body><a href="/user-guides/current">Current user guides</a></body></html>',
            child: f'<html><body><a href="{old_pdf}">FR 2028D user guide (PDF)</a></body></html>'.encode(),
        })

        first = self.sweep(config, site)
        first_records = {record["url"]: record for record in self.registry().candidates.values()}
        self.assertEqual(first["status"], "COMPLETE")
        self.assertIn(old_pdf, first_records)
        self.assertIn(root, site.calls)
        self.assertIn(child, site.calls)
        self.assertNotIn(old_pdf, site.calls, "Scout records linked PDFs but does not fetch them as HTML")

        # A publisher can replace the document URL while keeping its landing page
        # and descriptive link text. The next weekly sweep must surface the new URL.
        site.pages[child] = f'<html><body><a href="{new_pdf}">FR 2028D user guide (PDF)</a></body></html>'.encode()
        second = self.sweep(config, site)
        second_records = {record["url"]: record for record in self.registry().candidates.values()}
        new_candidate = next(item for item in self.review()["candidates"] if item["url"] == new_pdf)

        self.assertEqual(second["status"], "COMPLETE")
        self.assertIn(old_pdf, second_records, "historical Scout records are retained")
        self.assertIn(new_pdf, second_records)
        self.assertEqual(new_candidate["origin"], "new")
        self.assertEqual(second["totals"]["new"], 1)

    def test_depth_limited_listing_does_not_visit_pages_beyond_selected_depth(self):
        root = "https://reg.example.org/user-guides"
        child = "https://reg.example.org/user-guides/current"
        grandchild = "https://reg.example.org/user-guides/current/archive"
        config = config_for([{
            "id": "ex-user-guides",
            "type": "listing",
            "label": "User guides",
            "url": root,
            "link_prefixes": ["https://reg.example.org/"],
            "crawl_depth": 1,
        }])
        site = FakeSite({
            root: b'<html><a href="/user-guides/current">Current</a></html>',
            child: f'<html><a href="{grandchild}">Archive</a></html>'.encode(),
            grandchild: b"<html><p>Archive content</p></html>",
        })

        result = self.sweep(config, site)
        urls = {record["url"] for record in self.registry().candidates.values()}

        self.assertEqual(result["status"], "COMPLETE")
        self.assertIn(child, urls)
        self.assertNotIn(grandchild, urls)
        self.assertNotIn(child, site.calls, "depth 1 reads only the root page")
        self.assertNotIn(grandchild, site.calls)

    def _tic_like_site(self):
        """A forms section, a historical sub-page, an unrelated same-host section and a cross-host PDF host."""
        root = "https://reg.example.org/data/tic/forms"
        b_forms = "https://reg.example.org/data/tic/forms/b-forms"
        unrelated = "https://reg.example.org/data/auction-allotments"
        site = FakeSite({
            root: (b'<html><body><main><h2>Reporting forms</h2>'
                   b'<a href="/data/tic/forms/b-forms">TIC B Forms and Instructions</a>'
                   b'<h2>Other data</h2><a href="/data/auction-allotments">Investor class auction allotments</a>'
                   b'</main></body></html>'),
            b_forms: (b'<html><body><main><h2>Current forms</h2>'
                      b'<a href="https://docs.example.org/forms/BC.pdf">Form BC (PDF)</a>'
                      b'<a href="https://docs.example.org/forms/BC-instructions.pdf">Instructions</a>'
                      b'<h2>Historical forms</h2>'
                      b'<a href="https://docs.example.org/forms/BC-2019.pdf">Form BC, 2019 (PDF)</a>'
                      b'<a href="https://elsewhere.example.net/forms/x.pdf">Not an allowed host</a>'
                      b'<a href="https://docs.example.org/about">An HTML page on the document host</a>'
                      b'</main></body></html>'),
            unrelated: b'<html><body><main>' + b"".join(
                f'<a href="/data/auction-allotments/{index}">Allotment {index}</a>'.encode() for index in range(30)) + b"</main></body></html>",
        })
        return root, b_forms, unrelated, site

    def test_explore_scope_and_document_hosts_are_opt_in(self):
        root, b_forms, unrelated, site = self._tic_like_site()
        channel = {"id": "ex-tic", "type": "listing", "label": "TIC forms", "url": root,
                   "link_prefixes": ["https://reg.example.org/"], "crawl_depth": 2}

        # Without the new fields the original behaviour holds: every in-scope page
        # is read and cross-host links are out of scope.
        self.sweep(config_for([channel]), site)
        urls = {record["url"] for record in self.registry().candidates.values()}
        self.assertIn(unrelated, site.calls)
        self.assertIn("https://reg.example.org/data/auction-allotments/7", urls)
        self.assertFalse(any("docs.example.org" in url for url in urls))

    def test_explore_scope_limits_what_is_read_but_not_what_is_listed(self):
        root, b_forms, unrelated, site = self._tic_like_site()
        config = config_for([{
            "id": "ex-tic", "type": "listing", "label": "TIC forms", "url": root,
            "link_prefixes": ["https://reg.example.org/"], "crawl_depth": 2,
            "explore_prefixes": ["https://reg.example.org/data/tic/forms/"],
            "document_hosts": ["docs.example.org"],
        }])
        result = self.sweep(config, site)
        records = {record["url"]: record for record in self.registry().candidates.values()}

        self.assertEqual(result["status"], "COMPLETE")
        self.assertIn(b_forms, site.calls)
        self.assertNotIn(unrelated, site.calls, "a page outside the explore scope is listed but never read")
        self.assertIn(unrelated, records, "the out-of-scope page is still a visible candidate")
        self.assertFalse(any(url.startswith(unrelated + "/") for url in records))

        current = records["https://docs.example.org/forms/BC.pdf"]
        historical = records["https://docs.example.org/forms/BC-2019.pdf"]
        self.assertIn("https://docs.example.org/forms/BC-instructions.pdf", records)
        self.assertEqual(current["evidence"]["depth"], 2)
        self.assertEqual(current["evidence"]["section"], "Current forms")
        self.assertEqual(current["evidence"]["parent_url"], b_forms)
        self.assertEqual(historical["evidence"]["section"], "Historical forms",
                         "historical documents are surfaced with the publisher's heading, never dropped")
        self.assertEqual(records[b_forms]["evidence"]["depth"], 1)
        self.assertEqual(records[b_forms]["evidence"]["section"], "Reporting forms")
        self.assertNotIn("https://elsewhere.example.net/forms/x.pdf", records, "only declared document hosts are admitted")
        self.assertNotIn("https://docs.example.org/about", records, "a document host contributes documents, not HTML pages")
        self.assertFalse(any("docs.example.org" in call for call in site.calls), "document hosts are never fetched")

        from regmon.scout.registry import EVIDENCE_FIELDS
        self.assertIn("depth", EVIDENCE_FIELDS)
        self.assertIn("section", EVIDENCE_FIELDS)

    def test_explore_scope_and_document_hosts_are_validated(self):
        base = {"id": "ex-tic", "type": "listing", "label": "TIC forms", "url": "https://reg.example.org/data/tic/forms",
                "crawl_depth": 2}
        parsed = config_for([dict(base, explore_prefixes=["https://reg.example.org/data/tic/"], document_hosts=["Docs.Example.org"])])
        channel = parsed.regulators[0].channels[0]
        self.assertEqual(channel.explore_prefixes, ("https://reg.example.org/data/tic/",))
        self.assertEqual(channel.document_hosts, ("docs.example.org",))
        self.assertEqual(config_for([base]).regulators[0].channels[0].document_hosts, ())
        for bad, pattern in (
            ({"explore_prefixes": ["https://other.example.org/x/"]}, "not one of the regulator hosts"),
            ({"document_hosts": ["https://docs.example.org/"]}, "bare hostname"),
            ({"document_hosts": ["localhost"]}, "bare hostname"),
            ({"crawl_depth": None, "document_hosts": ["docs.example.org"]}, "depth-limited"),
        ):
            with self.subTest(bad=bad), self.assertRaisesRegex(ConfigError, pattern):
                config_for([{key: value for key, value in dict(base, **bad).items() if value is not None}])

    def test_section_headings_are_recorded_per_link(self):
        html = ('<html><body><main><h2>Current</h2><ul><li><a href="/a.pdf">A</a></li></ul>'
                '<h3>Archive</h3><p><a href="/b.pdf">B</a></p></main></body></html>')
        links = {link.url: link.section for link in channels.harvest_listing(html, "https://reg.example.org/x")}
        self.assertEqual(links["https://reg.example.org/a.pdf"], "Current")
        self.assertEqual(links["https://reg.example.org/b.pdf"], "Archive")

    def test_recursive_listing_depth_is_validated(self):
        base = {
            "schema_version": 1,
            "objective": {"id": "test", "description": "test", "priority_types": ["guidance"],
                          "out_of_objective_types": ["event"]},
            "defaults": {"min_delay_seconds": 1, "max_requests_per_regulator": 40,
                         "max_seconds_per_regulator": 600},
            "regulators": [{
                "id": "ex", "name": "Example Regulator", "region": "OTHER",
                "hosts": ["reg.example.org"],
                "channels": [{"id": "manual-page", "type": "listing", "label": "Guides",
                              "url": "https://reg.example.org/user-guides", "crawl_depth": 2}],
            }],
        }
        self.assertEqual(parse_config(base).regulators[0].channels[0].crawl_depth, 2)
        for bad_depth in (0, 4, True, "2"):
            invalid = json.loads(json.dumps(base))
            invalid["regulators"][0]["channels"][0]["crawl_depth"] = bad_depth
            with self.subTest(depth=bad_depth), self.assertRaisesRegex(ConfigError, "crawl_depth"):
                parse_config(invalid)

    def test_paginated_listing_stops_when_caught_up_or_reports_partial(self):
        config = config_for([{"id": "ex-list", "type": "listing", "label": "Publications", "url": LIST_URL, "newest_first": True,
                              "pagination": {"param": "page", "max_pages": 3, "baseline_pages": 1}}])
        page = lambda index: f"{LIST_URL}?page={index}"
        site = FakeSite({page(0): listing(("2 Oct 2026", "/d/1.pdf", "Guidelines one"))})
        self.sweep(config, site)
        site.pages[page(0)] = listing(("3 Oct 2026", "/d/2.pdf", "Guidelines two"), ("2 Oct 2026", "/d/1.pdf", "Guidelines one"))
        latest = self.sweep(config, site)
        channel = latest["regulators"][0]["channels"][0]
        self.assertEqual((channel["status"], channel["pages_read"], channel["new"]), ("ok", 1, 1))
        self.assertIn("Caught up", channel["note"])
        # A pinned, already-seen item at the top does not end the read early.
        site.pages[page(0)] = listing(("2 Oct 2026", "/d/1.pdf", "Guidelines one"), ("5 Oct 2026", "/d/3.pdf", "Guidelines three"))
        site.pages[page(1)] = listing(("3 Oct 2026", "/d/2.pdf", "Guidelines two"))
        latest = self.sweep(config, site)
        channel = latest["regulators"][0]["channels"][0]
        self.assertEqual((channel["status"], channel["pages_read"]), ("ok", 2))
        # Three pages of unseen items: Scout cannot claim it caught up.
        for index in range(3):
            site.pages[page(index)] = listing((f"{4 + index} Oct 2026", f"/e/{index}.pdf", f"Report {index}"))
        latest = self.sweep(config, site)
        channel = latest["regulators"][0]["channels"][0]
        self.assertEqual(channel["status"], "partial")
        self.assertEqual(latest["status"], "PARTIAL")

    def test_feed_window_rollover_is_flagged(self):
        config = self.feed_config()
        site = FakeSite({FEED_URL: feed(*[(f"Rule {index}", f"https://reg.example.org/n/{index}", "") for index in range(3)])})
        self.sweep(config, site)
        site.pages[FEED_URL] = feed(*[(f"Rule {index}", f"https://reg.example.org/n/{index}", "") for index in range(10, 14)])
        latest = self.sweep(config, site)
        self.assertEqual(latest["regulators"][0]["channels"][0]["status"], "partial")
        self.assertIn("rolled out", latest["regulators"][0]["channels"][0]["note"])

    def test_failures_are_reported_and_partial_findings_kept(self):
        config = config_for([
            {"id": "ex-feed", "type": "feed", "label": "News", "url": FEED_URL},
            {"id": "ex-list", "type": "listing", "label": "Publications", "url": LIST_URL},
        ])
        site = FakeSite({FEED_URL: feed(("Rule", "https://reg.example.org/n/1", ""))})  # listing returns 404
        latest = self.sweep(config, site)
        self.assertEqual(latest["status"], "DEGRADED")
        self.assertIn("https://reg.example.org/n/1", {item["url"] for item in self.review()["candidates"]} | {
            record["url"] for record in self.registry().candidates.values()})
        site = FakeSite({FEED_URL: feed(("Rule", "https://reg.example.org/n/1", ""))}, robots_txt="User-agent: *\nDisallow: /\n")
        latest = sweep_mod.run(config, self.tmp / "other", sources_config=self.sources, latest_path=self.latest,
                               client_factory=lambda item: site.client(item, config.defaults), log=lambda *_: None)
        self.assertEqual(latest["status"], "BLOCKED")

    def test_a_listing_with_no_links_in_scope_is_a_layout_failure(self):
        config = config_for([{"id": "ex-list", "type": "listing", "label": "Publications", "url": LIST_URL}])
        site = FakeSite({LIST_URL: b"<html><body><main><p>Nothing here</p></main></body></html>"})
        latest = self.sweep(config, site)
        self.assertEqual(latest["regulators"][0]["channels"][0]["status"], "failed")
        self.assertIn("layout", latest["regulators"][0]["channels"][0]["error"])

    def test_monitored_pages_are_known_and_translations_are_linked(self):
        self.sources.write_text(json.dumps({"sources": [{"id": "m1", "seed_urls": ["https://reg.example.org/en/watched"], "allowed_urls": []}]}))
        sitemap = (b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
                   b'<url><loc>http://reg.example.org/en/guidance/a</loc><xhtml:link rel="alternate" hreflang="en" href="http://reg.example.org/en/guidance/a"/>'
                   b'<xhtml:link rel="alternate" hreflang="fr" href="http://reg.example.org/fr/orientation/a"/></url>'
                   b'<url><loc>http://reg.example.org/fr/orientation/a</loc><xhtml:link rel="alternate" hreflang="en" href="http://reg.example.org/en/guidance/a"/>'
                   b'<xhtml:link rel="alternate" hreflang="fr" href="http://reg.example.org/fr/orientation/a"/></url>'
                   b'<url><loc>http://reg.example.org/en/watched</loc></url></urlset>')
        config = config_for([{"id": "ex-map", "type": "sitemap", "label": "Site map", "url": "https://reg.example.org/sitemap.xml"}],
                            prefer_https=True, languages=["en", "fr"], review_languages=["en"],
                            path_hints=[{"prefix": "/en/guidance/", "publication_type": "guidance"}])
        site = FakeSite({"https://reg.example.org/sitemap.xml": (200, {"content-type": "application/xml"}, sitemap)})
        self.sweep(config, site)
        records = {record["url"]: record for record in self.registry().candidates.values()}
        self.assertEqual(records["https://reg.example.org/fr/orientation/a"]["relationship"]["type"], "translation")
        review = {item["url"]: item for item in self.review()["candidates"]}
        self.assertIn("https://reg.example.org/en/guidance/a", review)
        self.assertEqual(review["https://reg.example.org/en/guidance/a"]["translations"][0]["language"], "fr")
        self.assertNotIn("https://reg.example.org/fr/orientation/a", review)
        self.assertNotIn("https://reg.example.org/en/watched", review, "already-monitored baseline pages stay out of the queue")
        self.sweep(config, site)  # re-observing a translation must not refill its evidence
        records = {record["url"]: record for record in self.registry().candidates.values()}
        self.assertEqual(records["https://reg.example.org/fr/orientation/a"]["evidence"], {"language": "fr"})
        self.assertEqual(records["https://reg.example.org/en/guidance/a"]["evidence"]["alternates"],
                         {"fr": "http://reg.example.org/fr/orientation/a"})
        self.assertNotIn("original_url", records["https://reg.example.org/en/guidance/a"]["evidence"])

    def test_new_html_candidates_are_enriched_from_their_page(self):
        config = config_for([{"id": "ex-list", "type": "listing", "label": "Publications", "url": LIST_URL}])
        site = FakeSite({LIST_URL: listing(("1 Oct 2026", "/a", "Read more"))})
        self.sweep(config, site)
        site.pages[LIST_URL] = listing(("1 Oct 2026", "/a", "Read more"), ("2 Oct 2026", "/b", "More"))
        site.pages["https://reg.example.org/b"] = b"<html lang='en'><head><title>Consultation on climate risk</title><meta name='description' content='Proposed guideline'></head><body><h1>Consultation on climate risk management</h1></body></html>"
        self.sweep(config, site)
        record = next(record for record in self.registry().candidates.values() if record["url"].endswith("/b"))
        self.assertEqual(record["evidence"]["heading"], "Consultation on climate risk management")
        self.assertEqual(record["assessment"]["outcome"], "relevant")

    def test_registry_is_one_candidate_per_line(self):
        config = self.feed_config()
        site = FakeSite({FEED_URL: feed(("Rule one", "https://reg.example.org/n/1", ""), ("Rule two", "https://reg.example.org/n/2", ""))})
        self.sweep(config, site)
        text = (self.data / "registry" / "ex.json").read_text()
        self.assertEqual(len(json.loads(text)["candidates"]), 2)
        self.assertEqual(sum(1 for line in text.splitlines() if line.startswith('"') and '"url":' in line), 2)


# ---------------------------------------------------------------- review decisions

class TestReviewDecisions(ScoutTestCase):
    def setUp(self):
        super().setUp()
        self.config = config_for([{"id": "ex-feed", "type": "feed", "label": "News", "url": FEED_URL}])
        site = FakeSite({FEED_URL: feed(("Rule", "https://reg.example.org/n/1", ""))})
        self.sweep(self.config, site)
        site.pages[FEED_URL] = feed(("Event page", "https://reg.example.org/n/2", ""), ("Rule", "https://reg.example.org/n/1", ""))
        self.sweep(self.config, site)
        self.cid = candidate_id("https://reg.example.org/n/2")

    def event(self, body, login="owner", title="[ChangeSentinel] Scout review: not relevant"):
        return {"issue": {"number": 7, "title": title, "body": body, "user": {"login": login}},
                "repository": {"owner": {"login": "owner"}}}

    def body(self, decision="dismiss", url="https://reg.example.org/n/2", cid=None):
        return ("<!-- changesentinel:scout-review:v1 -->\n\nDecision: " + decision + "\nReason: an event page\n\nCandidates:\n- ex:" +
                (cid or self.cid) + " | " + url + "\n")

    def test_dismiss_and_restore_apply_to_one_address_with_a_log(self):
        result = apply_event(self.event(self.body()), self.data)
        self.assertEqual(result["count"], 1)
        decisions = load_decisions(self.data)
        self.assertEqual(decisions["decisions"]["ex:" + self.cid]["decision"], "dismissed")
        self.assertEqual(decisions["decisions"]["ex:" + self.cid]["decided_by"], "owner")
        apply_event(self.event(self.body("restore")), self.data)
        decisions = load_decisions(self.data)
        self.assertNotIn("ex:" + self.cid, decisions["decisions"])
        self.assertEqual([entry["decision"] for entry in decisions["log"]], ["dismissed", "restored"])

    def test_only_the_owner_and_exact_addresses_are_accepted(self):
        with self.assertRaises(ReviewError):
            apply_event(self.event(self.body(), login="someone-else"), self.data)
        with self.assertRaises(ReviewError):
            apply_event(self.event(self.body(url="https://reg.example.org/other")), self.data)
        with self.assertRaises(ReviewError):
            apply_event(self.event(self.body(cid="0" * 16)), self.data)
        with self.assertRaises(ReviewError):
            parse_request("Decision: dismiss\n- ex:" + self.cid + " | https://reg.example.org/n/2")  # no marker

    def test_dismissed_findings_leave_the_review_list_but_stay_on_record(self):
        apply_event(self.event(self.body()), self.data)
        review = sweep_mod.rebuild_review(self.config, self.data, sources_config=self.sources, latest_path=self.latest)
        item = next(item for item in review["candidates"] if item["id"] == self.cid)
        self.assertEqual(item["decision"]["decision"], "dismissed")
        self.assertEqual(validate(self.config, self.data), [])

    @unittest.skipUnless(NODE, "node is required")
    def test_the_dashboard_request_body_is_what_the_workflow_parses(self):
        script = ("const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + ");" +
                  "console.log(JSON.stringify(L.scoutReviewIssue('dismiss', [{regulator_id: 'ex', id: '" + self.cid +
                  "', url: 'https://reg.example.org/n/2'}], 'Event\\npage')));")
        request = json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True).stdout)
        self.assertTrue(request["title"].startswith("[ChangeSentinel] Scout review"))
        parsed = parse_request(request["body"])
        self.assertEqual(parsed["decision"], "dismissed")
        self.assertEqual(parsed["reason"], "Event page")
        self.assertEqual(parsed["candidates"], [{"regulator_id": "ex", "id": self.cid, "url": "https://reg.example.org/n/2"}])


# ---------------------------------------------------------------- owner-added sources and metadata

class TestSourceRequests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / "config" / "scout.json").read_text())

    def event(self, request, login="owner", title="[ChangeSentinel] Scout source: add MAS"):
        from regmon.scout.sources import MARKER
        body = MARKER + "\n\nPlease add it.\n\n```json\n" + json.dumps(request, indent=2) + "\n```\n"
        return {"issue": {"number": 9, "title": title, "body": body, "user": {"login": login}}, "repository": {"owner": {"login": "owner"}}}

    def apply(self, request):
        from regmon.scout.sources import apply_request
        return apply_request(request, self.config, resolve_dns=False)

    def test_a_new_regulator_needs_its_first_channel_and_gets_validated(self):
        from regmon.scout.sources import SourceRequestError
        request = {"version": 1, "regulator": {"id": "mas", "name": "Monetary Authority of Singapore", "short_name": "MAS", "region": "APAC",
                                               "keywords": {"relevant": ["payment services"]}},
                   "channel": {"type": "listing", "url": "https://www.mas.gov.sg/regulation/circulars", "label": "Circulars",
                               "pagination": {"param": "page", "max_pages": 4}}}
        data, summary = self.apply(request)
        self.assertTrue(summary["created"])
        profile = next(item for item in data["regulators"] if item["id"] == "mas")
        self.assertEqual(profile["hosts"], ["www.mas.gov.sg"])
        self.assertTrue(profile["channels"][0]["newest_first"])
        self.assertTrue(profile["known_gaps"], "a hand-added profile still states what it does not cover")
        parse_config(data)
        with self.assertRaises(SourceRequestError):
            self.apply(dict(request, channel=None))

    def test_editing_metadata_keeps_channels_and_rejects_bad_values(self):
        from regmon.scout.sources import SourceRequestError
        before = next(item for item in self.config["regulators"] if item["id"] == "apra")
        data, summary = self.apply({"version": 1, "regulator": {"id": "apra", "name": "APRA", "region": "APAC",
                                                                 "keywords": {"relevant": ["superannuation"], "exclude": ["roundtable"]},
                                                                 "path_hints": [{"prefix": "/consultations/", "publication_type": "consultation"}],
                                                                 "active": False}, "channel": None})
        after = next(item for item in data["regulators"] if item["id"] == "apra")
        self.assertFalse(summary["created"])
        self.assertEqual(after["channels"], before["channels"])
        self.assertEqual(after["keywords"], {"relevant": ["superannuation"], "exclude": ["roundtable"]})
        self.assertFalse(after["active"])
        for bad in ({"region": "MARS"}, {"path_hints": [{"prefix": "events/"}]}, {"keywords": {"relevant": ["x"], "exclude": ["X"]}},
                    {"path_hints": [{"prefix": "/a/", "publication_type": "bogus"}]}):
            with self.subTest(bad=bad), self.assertRaises(SourceRequestError):
                self.apply({"version": 1, "regulator": dict({"id": "apra"}, **bad), "channel": None})

    def test_channels_are_unique_public_and_on_a_declared_host(self):
        from regmon.scout.sources import SourceRequestError
        existing = {"version": 1, "regulator": {"id": "eba"}, "channel": {"type": "feed", "url": "https://www.eba.europa.eu/publications-and-media/publications", "label": "Dup"}}
        with self.assertRaises(SourceRequestError):
            self.apply(existing)
        private = {"version": 1, "regulator": {"id": "eba"}, "channel": {"type": "feed", "url": "http://127.0.0.1/feed", "label": "Local"}}
        with self.assertRaises(SourceRequestError):
            self.apply(private)
        data, summary = self.apply({"version": 1, "regulator": {"id": "eba"}, "channel": {"type": "feed", "url": "https://www.eba.europa.eu/rss.xml", "label": "News alerts"}})
        self.assertEqual(summary["channel_id"], "eba-news-alerts")

    def test_only_the_owner_can_change_sources(self):
        from regmon.scout.sources import SourceRequestError, apply_event as apply_source_event
        path = Path(tempfile.mkdtemp()) / "scout.json"
        self.addCleanup(shutil.rmtree, path.parent, True)
        path.write_text(json.dumps(self.config))
        request = {"version": 1, "regulator": {"id": "eba"}, "channel": {"type": "feed", "url": "https://www.eba.europa.eu/rss.xml", "label": "News alerts"}}
        with self.assertRaises(SourceRequestError):
            apply_source_event(self.event(request, login="someone"), path, resolve_dns=False)
        summary = apply_source_event(self.event(request), path, resolve_dns=False)
        self.assertEqual(summary["regulator_id"], "eba")
        self.assertIn("eba-news-alerts", path.read_text())

    @unittest.skipUnless(NODE, "node is required")
    def test_the_dashboard_form_builds_a_request_the_workflow_applies(self):
        from regmon.scout.sources import apply_request, parse_request
        values = {"mode": "add", "isNew": True, "name": "Monetary Authority of Singapore", "shortName": "MAS", "region": "APAC",
                  "channelType": "feed", "channelUrl": "https://www.mas.gov.sg/feed.xml", "channelLabel": "Media releases",
                  "languages": "en", "reviewLanguages": "en", "relevantKeywords": "payment services", "excludeKeywords": "",
                  "pathHints": "/regulation/notices/ = supervisory_letter, topic:supervision\n/media/ = exclude", "knownGaps": ""}
        script = ("const L = require(" + json.dumps(str(ROOT / "dashboard-lib.js")) + "); console.log(JSON.stringify(L.scoutSourceRequest(" +
                  json.dumps(values) + ")));")
        built = json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True).stdout)
        self.assertEqual(built["errors"], [])
        self.assertTrue(built["title"].startswith("[ChangeSentinel] Scout source"))
        data, summary = apply_request(parse_request(built["body"]), self.config, resolve_dns=False)
        self.assertEqual(summary["regulator_id"], "mas")
        profile = next(item for item in data["regulators"] if item["id"] == "mas")
        self.assertEqual(profile["path_hints"][1], {"prefix": "/media/", "effect": "negative"})
        bad = json.loads(subprocess.run([NODE, "-e", script.replace("topic:supervision", "topic:nonsense")], capture_output=True, text=True, check=True).stdout)
        self.assertTrue(bad["errors"])

    def test_profile_keywords_steer_the_assessment_visibly(self):
        import dataclasses
        config = load_config(ROOT / "config" / "scout.json")
        apra = dataclasses.replace(config.regulator("apra"), relevant_keywords=("superannuation",), exclude_keywords=("roundtable",))

        def judge(title):
            return assess({"url": "https://www.apra.gov.au/news-and-publications/x", "evidence": {"title": title}, "origin": "new"}, apra, config.objective)

        relevant = judge("Quarterly superannuation performance")
        self.assertEqual(relevant["outcome"], "relevant")
        self.assertTrue(any("profile keyword" in reason["text"] for reason in relevant["reasons"]))
        self.assertEqual(judge("APRA hosts an industry roundtable")["outcome"], "irrelevant")
        # An exclusion keyword never outweighs a regulatory publication type.
        self.assertEqual(judge("Roundtable on the proposed prudential standard consultation")["outcome"], "relevant")


# ---------------------------------------------------------------- configuration and committed state

class TestConfigurationAndState(unittest.TestCase):
    def test_pilot_profiles_cover_all_four_regions(self):
        config = load_config(ROOT / "config" / "scout.json")
        pilot_regions = {regulator.region for regulator in config.regulators if regulator.active and regulator.jurisdiction != "User-configured"}
        self.assertEqual(pilot_regions, {"NAM", "LATAM", "EMEA", "APAC"})
        for regulator in config.regulators:
            with self.subTest(regulator=regulator.id):
                self.assertTrue(regulator.known_gaps, "every profile states what it does not cover")

    def test_invalid_profiles_are_rejected(self):
        base = {"id": "c", "type": "feed", "label": "F", "url": "https://reg.example.org/feed"}
        with self.assertRaises(ConfigError):
            config_for([dict(base, url="https://elsewhere.example.com/feed")])
        with self.assertRaises(ConfigError):
            config_for([dict(base, type="listing", pagination={"param": "page", "max_pages": 3})])  # no newest_first
        with self.assertRaises(ConfigError):
            config_for([base, base])

    def test_committed_scout_state_is_valid(self):
        config = load_config(ROOT / "config" / "scout.json")
        self.assertEqual(validate(config, ROOT / "data" / "scout"), [])
        for name in ("latest.json", "review.json", "decisions.json", "history.json"):
            with self.subTest(name=name):
                self.assertTrue((ROOT / "data" / "scout" / name).exists())


class TestStateCommitScoping(unittest.TestCase):
    """Monitor and Scout commits replay over each other but never over their own kind."""

    def git(self, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.remote = self.tmp / "remote.git"
        self.git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.remote))
        seed = self.tmp / "seed"
        self.git(self.tmp, "clone", "-q", str(self.remote), str(seed))
        for name in ("user.name", "user.email"):
            self.git(seed, "config", name, "t")
        (seed / "data" / "scout").mkdir(parents=True)
        (seed / "data" / "report.json").write_text("{}")
        (seed / "data" / "scout" / "latest.json").write_text("{}")
        (seed / "scripts").mkdir()
        shutil.copy(ROOT / "scripts" / "commit_state.sh", seed / "scripts" / "commit_state.sh")
        self.git(seed, "add", "-A")
        self.git(seed, "commit", "-q", "-m", "seed")
        self.git(seed, "push", "-q", "origin", "main")

    def checkout(self, name):
        path = self.tmp / name
        self.git(self.tmp, "clone", "-q", str(self.remote), str(path))
        for key in ("user.name", "user.email"):
            self.git(path, "config", key, "t")
        return path, self.git(path, "rev-parse", "HEAD")

    def commit_state(self, path, base, *extra):
        return subprocess.run(["bash", "scripts/commit_state.sh", "state", base, *extra], cwd=path, capture_output=True, text=True)

    def test_scout_and_monitor_commits_do_not_block_each_other(self):
        monitor, monitor_base = self.checkout("monitor")
        scout, scout_base = self.checkout("scout")
        (scout / "data" / "scout" / "latest.json").write_text('{"sweep": 1}')
        self.assertEqual(self.commit_state(scout, scout_base, "data/scout").returncode, 0)
        (monitor / "data" / "report.json").write_text('{"run": 1}')
        result = self.commit_state(monitor, monitor_base)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        final, _ = self.checkout("final")
        self.assertEqual((final / "data" / "scout" / "latest.json").read_text(), '{"sweep": 1}')
        self.assertEqual((final / "data" / "report.json").read_text(), '{"run": 1}')

    def test_a_job_still_refuses_when_its_own_state_moved(self):
        first, first_base = self.checkout("first")
        second, second_base = self.checkout("second")
        (first / "data" / "report.json").write_text('{"run": 1}')
        self.assertEqual(self.commit_state(first, first_base).returncode, 0)
        (second / "data" / "report.json").write_text('{"run": 2}')
        self.assertNotEqual(self.commit_state(second, second_base).returncode, 0)

    def test_the_monitor_never_commits_scout_files(self):
        monitor, base = self.checkout("monitor-only")
        (monitor / "data" / "report.json").write_text('{"run": 3}')
        (monitor / "data" / "scout" / "latest.json").write_text('{"stray": true}')
        self.assertEqual(self.commit_state(monitor, base).returncode, 0)
        changed = self.git(monitor, "show", "--name-only", "--format=", "HEAD")
        self.assertEqual(changed, "data/report.json")


if __name__ == "__main__":
    unittest.main()


class TestScoutNewnessFollowUps(ScoutTestCase):
    """25 Oct audit: CS-11, CS-12, CS-14, CS-17, CS-161."""

    LIST = "https://reg.example.org/publications"

    def list_config(self, **pagination):
        return config_for([{"id": "ex-list", "type": "listing", "label": "Publications", "url": self.LIST, "newest_first": True,
                            "pagination": dict({"param": "page", "max_pages": 3, "baseline_pages": 1}, **pagination)}])

    def page(self, index):
        return f"{self.LIST}?page={index}"

    def test_an_item_dated_in_the_onboarding_week_is_announced(self):
        today = datetime.now(timezone.utc)
        fresh = f"{today.day} {today.strftime('%B %Y')}"
        site = FakeSite({self.page(0): listing((fresh, "/d/new.pdf", "Guidelines this week"), ("2 January 2025", "/d/old.pdf", "Guidelines old"))})
        self.sweep(self.list_config(), site)
        records = {record["url"]: record for record in self.registry().candidates.values()}
        self.assertEqual(records["https://reg.example.org/d/new.pdf"]["origin"], "new")
        self.assertIn("first sweep", records["https://reg.example.org/d/new.pdf"]["origin_reason"])
        self.assertEqual(records["https://reg.example.org/d/old.pdf"]["origin"], "baseline")

    def test_a_monthly_full_read_finds_an_item_only_listed_on_page_two(self):
        config = self.list_config()
        site = FakeSite({self.page(0): listing(("2 October 2026", "/d/1.pdf", "Guidelines one"), ("1 October 2026", "/d/0.pdf", "Guidelines zero"))})
        self.sweep(config, site)
        # A back-dated item appears on page 2 only; page 1 is unchanged.
        site.pages[self.page(1)] = listing(("1 September 2026", "/d/backdated.pdf", "Guidelines back-dated"))
        quick = self.sweep(config, site)
        self.assertIn("Caught up", quick["regulators"][0]["channels"][0]["note"])
        self.assertNotIn("https://reg.example.org/d/backdated.pdf", {r["url"] for r in self.registry().candidates.values()})
        # Four weeks after the baseline the read goes to the end.
        registry = self.registry()
        registry.channels["ex-list"]["baselined_at"] = (datetime.now(timezone.utc) - timedelta(days=29)).isoformat()
        registry.save(self.data)
        deep = self.sweep(config, site)
        channel = deep["regulators"][0]["channels"][0]
        self.assertTrue(channel.get("full_read"))
        self.assertIn("Monthly full read", channel["note"])
        self.assertIn("https://reg.example.org/d/backdated.pdf", {r["url"] for r in self.registry().candidates.values()})
        self.assertTrue(self.registry().channels["ex-list"].get("last_full_read"))

    def test_a_listing_that_is_not_newest_first_does_not_stop_early(self):
        config = self.list_config()
        site = FakeSite({self.page(0): listing(("1 October 2026", "/d/a.pdf", "Guidelines a"), ("2 October 2026", "/d/b.pdf", "Guidelines b"),
                                               ("3 October 2026", "/d/c.pdf", "Guidelines c"))})
        self.sweep(config, site)
        site.pages[self.page(1)] = listing(("4 October 2026", "/d/d.pdf", "Guidelines d"))
        latest = self.sweep(config, site)
        channel = latest["regulators"][0]["channels"][0]
        self.assertEqual(channel["pages_read"], 2)
        self.assertIn("https://reg.example.org/d/d.pdf", {r["url"] for r in self.registry().candidates.values()})

    def test_a_failed_page_keeps_what_earlier_pages_found(self):
        root = "https://reg.example.org/user-guides"
        config = config_for([{"id": "ex-guides", "type": "listing", "label": "Guides", "url": root,
                              "link_prefixes": ["https://reg.example.org/"], "crawl_depth": 2}])
        site = FakeSite({
            root: b'<html><body><a href="/docs/guide.pdf">Guide (PDF)</a><a href="/user-guides/more">More guides</a></body></html>',
            "https://reg.example.org/user-guides/more": (500, {}, b"server error"),
        })
        latest = self.sweep(config, site)
        channel = latest["regulators"][0]["channels"][0]
        self.assertEqual(channel["status"], "partial")
        self.assertIn("kept", channel["note"])
        self.assertIn("https://reg.example.org/docs/guide.pdf", {r["url"] for r in self.registry().candidates.values()})

    def test_a_crawl_delay_beyond_the_ceiling_is_reported(self):
        config = self.list_config()
        site = FakeSite({self.page(0): listing(("2 October 2026", "/d/1.pdf", "Guidelines one"))},
                        robots_txt="User-agent: *\nCrawl-delay: 120\n")
        latest = self.sweep(config, site)
        self.assertEqual(latest["regulators"][0]["slow_hosts"]["reg.example.org"]["crawl_delay"], 120.0)
