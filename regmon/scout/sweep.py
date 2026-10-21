"""One Scout sweep: read every declared channel, record what is new, assess it.

Coverage is reported against the declared plan, never as "the whole site":

COMPLETE  every required channel was read as declared (feeds fully, sitemaps
          fully, paginated listings until they reached already-seen items);
PARTIAL   a budget or window limit stopped a channel before it caught up, or a
          feed's window may have rolled past items since the last sweep;
DEGRADED  at least one required channel failed, was blocked or was deferred,
          while others worked;
BLOCKED   robots.txt or the server refused every required channel;
FAILED    nothing could be read.

A partial sweep still records what it found. Scout writes only data/scout/.
"""
from __future__ import annotations

import re
import secrets
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from regmon.scout import SCHEMA_VERSION
from regmon.scout.assess import assess
from regmon.scout.channels import (
    Observation, ParseError, clean, harvest_listing, page_metadata, parse_feed, parse_sitemap,
)
from regmon.scout.net import BudgetExhausted, PoliteClient, ScoutFetchError
from regmon.scout.profiles import Channel, Regulator, ScoutConfig
from regmon.scout.registry import (
    Registry, build_review, compact_assessment, dump, dump_compact, iso, load_decisions, monitored_urls, near_monitored,
    read_json, utc_now, write_if_changed,
)
from regmon.scout.urls import canonical, candidate_id, file_format, host, is_asset

STATUS_ORDER = ("COMPLETE", "PARTIAL", "DEGRADED", "BLOCKED", "FAILED")
ENRICH_MAX_BYTES = 3_000_000


def worst(statuses) -> str:
    values = [status for status in statuses if status in STATUS_ORDER]
    return max(values, key=STATUS_ORDER.index) if values else "FAILED"


def fetch_url(url: str, regulator: Regulator) -> str:
    parsed = urlparse(url)
    if parsed.scheme == "http" and (parsed.hostname or "").lower() in regulator.https_hosts:
        return urlunparse(("https",) + tuple(parsed)[1:])
    return url


def page_url(channel: Channel, index: int) -> str:
    if not channel.pagination:
        return channel.url
    parsed = urlparse(channel.url)
    query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != channel.pagination.param]
    query.append((channel.pagination.param, str(channel.pagination.start + index * channel.pagination.step)))
    return urlunparse(parsed._replace(query=urlencode(query)))


def in_candidate_scope(url: str, regulator: Regulator, channel: Channel) -> bool:
    if host(url) not in regulator.hosts or is_asset(url):
        return False
    value = canonical(url, regulator.https_hosts)
    path = urlparse(value).path or "/"
    if path in {"", "/"}:
        return False
    if any(path.startswith(prefix) for prefix in regulator.exclude_paths):
        return False
    if channel.link_prefixes and not any(value.startswith(canonical(prefix, regulator.https_hosts)) for prefix in channel.link_prefixes):
        return False
    if any(re.search(pattern, url) for pattern in channel.exclude_link_patterns):
        return False
    if channel.type == "listing" and path == (urlparse(canonical(channel.url, regulator.https_hosts)).path or "/"):
        return False  # the listing itself, its pages and its filters
    return True


class ChannelRun:
    def __init__(self, channel: Channel):
        self.channel = channel
        self.status = "ok"
        self.note = ""
        self.error = ""
        self.pages_read = 0
        self.items = 0
        self.out_of_scope = 0
        self.observations: list[Observation] = []

    def summary(self, observed: int, new: int) -> dict:
        return {
            "id": self.channel.id, "label": self.channel.label, "type": self.channel.type, "url": self.channel.url,
            "required": self.channel.required, "status": self.status, "note": self.note, "error": self.error,
            "pages_read": self.pages_read, "items": self.items, "observed": observed, "new": new,
            "out_of_scope": self.out_of_scope,
        }


def _observation(url: str, run: ChannelRun, **fields) -> Observation:
    return Observation(url=url, original_url=url, channel_id=run.channel.id, channel_type=run.channel.type, **fields)


def run_feed(client: PoliteClient, regulator: Regulator, run: ChannelRun) -> None:
    response = client.get(fetch_url(run.channel.url, regulator))
    run.pages_read = 1
    items = parse_feed(response.body, response.url)
    run.items = len(items)
    if not items:
        raise ParseError("The feed returned no items")
    for item in items:
        if item.link:
            run.observations.append(_observation(
                item.link, run, title=item.title, description=item.description, categories=item.categories,
                published=item.published, parent_url=run.channel.url))
        for url, text in item.description_links:
            run.observations.append(_observation(
                url, run, anchor_text=text, context=clean(item.title, 300), published=item.published,
                parent_url=item.link or run.channel.url))


def run_sitemap(client: PoliteClient, regulator: Regulator, run: ChannelRun, config: ScoutConfig) -> None:
    queue, seen, children = [run.channel.url], set(), 0
    entries = 0
    while queue:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        response = client.get(fetch_url(url, regulator))
        run.pages_read += 1
        document = parse_sitemap(response.body, response.url)
        if document.kind == "index":
            for entry in document.entries:
                if host(entry["loc"]) not in regulator.hosts:
                    run.out_of_scope += 1
                    continue
                children += 1
                if children > config.defaults.max_child_sitemaps:
                    run.status, run.note = "partial", f"Sitemap index lists more than {config.defaults.max_child_sitemaps} child sitemaps; the rest were not read"
                    break
                queue.append(entry["loc"])
            continue
        for entry in document.entries:
            entries += 1
            if entries > config.defaults.max_sitemap_urls:
                run.status, run.note = "partial", f"Stopped after {config.defaults.max_sitemap_urls} sitemap entries"
                return
            alternates = entry.get("alternates") or {}
            own = canonical(entry["loc"], regulator.https_hosts)
            language = next((code for code, href in alternates.items() if canonical(href, regulator.https_hosts) == own), "")
            run.observations.append(_observation(
                entry["loc"], run, lastmod=entry.get("lastmod", "")[:10], alternates=alternates, language=language))
        run.items += len(document.entries)
    if run.items == 0:
        raise ParseError("The sitemap listed no URLs")


def run_listing(client: PoliteClient, regulator: Regulator, run: ChannelRun, *, baseline: bool, known: set[str]) -> None:
    channel = run.channel
    pagination = channel.pagination
    pages = (pagination.baseline_pages if baseline else pagination.max_pages) if pagination else 1
    caught_up = reached_end = False
    for index in range(pages):
        url = page_url(channel, index)
        try:
            response = client.get(fetch_url(url, regulator))
        except BudgetExhausted:
            raise
        except ScoutFetchError as exc:
            if index == 0:
                raise
            if exc.status in {404, 410}:
                reached_end = True
            else:
                run.status = "partial"
                run.note = f"Page {index + 1} could not be read ({clean(str(exc), 160)}); older pages were not checked this sweep"
                return
            break
        run.pages_read += 1
        html = response.body.decode("utf-8", errors="replace")
        links = harvest_listing(html, response.url, channel.content_selector)
        in_scope = []
        for link in links:
            if in_candidate_scope(link.url, regulator, channel):
                in_scope.append(link)
            else:
                run.out_of_scope += 1
        if not in_scope:
            if index == 0:
                raise ParseError("The listing page had no links in scope; its layout may have changed")
            reached_end = True
            break
        run.items += len(in_scope)
        for link in in_scope:
            run.observations.append(_observation(
                link.url, run, anchor_text=link.anchor_text, title_attr=link.title_attr, context=link.context,
                date_hint=link.date_hint, parent_url=response.url))
        if pagination and channel.newest_first and not baseline:
            # Newest first: once the tail of a page is made of items seen before,
            # everything older was seen too. Checking the tail (not just "any
            # known item") keeps a pinned old item at the top from ending the read.
            seen = [canonical(link.url, regulator.https_hosts) in known for link in in_scope]
            tail = 1 if len(seen) < 6 else 2
            if all(seen[-tail:]):
                caught_up = True
                break
    if pagination and baseline:
        run.note = f"Baseline: read the first {run.pages_read} page(s)"
    elif pagination and caught_up:
        run.note = f"Caught up with items seen before on page {run.pages_read}"
    elif pagination and reached_end:
        run.note = f"Reached the end of the listing after {run.pages_read} page(s)"
    elif pagination:
        run.status = "partial"
        run.note = f"Read {run.pages_read} page(s) without reaching items seen before; older pages were not checked this sweep"


def _classify(run: ChannelRun, exc: Exception) -> None:
    kind = getattr(exc, "kind", "")
    message = clean(str(exc), 300)
    if isinstance(exc, BudgetExhausted):
        run.status, run.note = "partial", f"Stopped early: {message}"
    elif kind in {"robots", "blocked"}:
        run.status, run.error = "blocked", message
    elif kind == "deferred":
        run.status, run.error = "deferred", message
    elif isinstance(exc, (ScoutFetchError, ParseError)):
        run.status, run.error = "failed", message
    else:
        run.status, run.error = "failed", f"{type(exc).__name__}: {message}"


def regulator_status(runs: list[ChannelRun]) -> tuple[str, str]:
    required = [run for run in runs if run.channel.required] or runs
    working = [run for run in required if run.status in {"ok", "partial"}]
    broken = [run for run in required if run.status in {"failed", "blocked", "deferred"}]
    if not working:
        if all(run.status == "blocked" for run in required):
            return "BLOCKED", "Every required channel was refused by robots.txt or the server"
        return "FAILED", "No required channel could be read"
    if broken:
        return "DEGRADED", f"{len(broken)} of {len(required)} required channels could not be read"
    if any(run.status == "partial" for run in runs):
        return "PARTIAL", "At least one channel stopped before it caught up"
    return "COMPLETE", "Every declared channel was read as planned"


def _link_translations(registry: Registry, regulator: Regulator, cids: list[str]) -> int:
    linked = 0
    for cid in cids:
        record = registry.candidates.get(cid)
        if not record or record.get("relationship"):
            continue
        evidence = record.get("evidence") or {}
        language = str(evidence.get("language") or "")
        if not language:
            path = urlparse(record["url"]).path
            language = next((code for code, prefix in regulator.language_paths.items() if path.startswith(prefix)), "")
        if not language or language in regulator.review_languages:
            continue
        alternates = dict(evidence.get("alternates") or {})
        for code, href in alternates.items():
            if code in regulator.review_languages:
                parent = candidate_id(canonical(href, regulator.https_hosts))
                if parent in registry.candidates and parent != cid:
                    record["relationship"] = {"type": "translation", "of": parent, "language": language}
                    # The parent keeps the evidence; a translation needs only its language.
                    record["evidence"] = {"language": language}
                    linked += 1
                    break
    return linked


def _enrich(client: PoliteClient, registry: Registry, regulator: Regulator, cids: list[str], limit: int, now: str) -> int:
    done = 0
    for cid in cids:
        if done >= limit:
            break
        record = registry.candidates[cid]
        evidence = record.setdefault("evidence", {})
        if evidence.get("enriched") or evidence.get("title") or evidence.get("heading"):
            continue
        if file_format(record["url"], evidence.get("anchor_text", "")) != "Web page":
            continue
        url = fetch_url(record["url"], regulator)
        if not client.can_afford(host(url)):
            break
        try:
            if not client.allowed_by_robots(url):
                evidence["robots_disallowed"] = True
                continue
            response = client.get(url, max_bytes=ENRICH_MAX_BYTES)
        except BudgetExhausted:
            break
        except ScoutFetchError as exc:
            evidence["enrich_error"] = clean(f"{exc.kind}: {exc}", 200)
            continue
        done += 1
        evidence["enriched"] = now
        if "html" not in response.content_type and not response.body.lstrip()[:15].lower().startswith((b"<!doctype", b"<html")):
            continue
        metadata = page_metadata(response.body.decode("utf-8", errors="replace"))
        for key, value in metadata.items():
            if value and not evidence.get(key):
                evidence[key] = value
    return done


def sweep_regulator(regulator: Regulator, config: ScoutConfig, data_dir: Path, *, monitored: dict, sweep_id: str,
                    now: str, client: PoliteClient, log=print) -> dict:
    started = time.monotonic()
    registry = Registry.load(data_dir, regulator.id)
    known_before = {record["url"] for record in registry.candidates.values()} | set(monitored)
    runs: list[ChannelRun] = []
    for channel in regulator.channels:
        run = ChannelRun(channel)
        baseline = not registry.channel_baselined(channel.id)
        try:
            if channel.type == "feed":
                run_feed(client, regulator, run)
            elif channel.type == "sitemap":
                run_sitemap(client, regulator, run, config)
            else:
                run_listing(client, regulator, run, baseline=baseline, known=known_before)
        except Exception as exc:  # each channel fails on its own; the sweep continues
            _classify(run, exc)
        log(f"  {channel.id}: {run.status} pages={run.pages_read} items={run.items} {run.note or run.error}".rstrip())
        runs.append(run)

    # Feed window check: when every item is unseen, older items may have rolled
    # out of the feed since the last sweep.
    for run in runs:
        if run.channel.type != "feed" or run.status != "ok" or not registry.channel_baselined(run.channel.id):
            continue
        urls = {canonical(item.url, regulator.https_hosts) for item in run.observations
                if in_candidate_scope(item.url, regulator, run.channel)}
        if len(urls) >= 3 and not urls & known_before:
            run.status = "partial"
            run.note = f"All {len(urls)} items are new since the last sweep; older items may have rolled out of the feed"

    # Record observations. A URL is "new" when any channel that saw it had
    # already completed a baseline before this sweep; otherwise it is part of
    # the channel's first inventory ("baseline") and not announced as new.
    baselined = {channel.id: registry.channel_baselined(channel.id) for channel in regulator.channels}
    observers: dict[str, set[str]] = {}
    in_scope: list[tuple[ChannelRun, Observation]] = []
    for run in runs:
        for observation in run.observations:
            if not in_candidate_scope(observation.url, regulator, run.channel):
                run.out_of_scope += 1
                continue
            key = canonical(observation.url, regulator.https_hosts)
            observers.setdefault(key, set()).add(run.channel.id)
            in_scope.append((run, observation))
    created: list[str] = []
    per_channel: dict[str, set[str]] = {run.channel.id: set() for run in runs}
    per_channel_new: dict[str, set[str]] = {run.channel.id: set() for run in runs}
    for run, observation in in_scope:
        key = canonical(observation.url, regulator.https_hosts)
        new_if_unknown = any(baselined.get(channel_id) for channel_id in observers.get(key, ()))
        cid, was_created = registry.observe(observation, sweep_id=sweep_id, now=now, new_if_unknown=new_if_unknown,
                                            https_hosts=regulator.https_hosts)
        per_channel[run.channel.id].add(cid)
        if was_created:
            created.append(cid)
        if registry.candidates[cid].get("first_sweep") == sweep_id and registry.candidates[cid].get("origin") == "new":
            per_channel_new[run.channel.id].add(cid)

    for cid in created:
        nearby = near_monitored(registry.candidates[cid]["url"], monitored)
        if nearby:
            registry.candidates[cid]["evidence"]["near_monitored"] = nearby
    translations = _link_translations(registry, regulator, created)
    new_ids = [cid for cid in created if registry.candidates[cid].get("origin") == "new"]
    enriched = _enrich(client, registry, regulator, new_ids, config.defaults.max_enrich_per_regulator, now)

    outcomes_by_id = {}
    for cid, record in registry.candidates.items():
        result = assess(record, regulator, config.objective)
        outcomes_by_id[cid] = result["outcome"]
        compact = compact_assessment(result)
        if record.get("assessment") != compact:
            record["assessment"] = compact

    for run in runs:
        state = registry.channels.setdefault(run.channel.id, {})
        if run.status == "ok" and not state.get("baselined_at"):
            state["baselined_at"] = now
        if run.status in {"ok", "partial"}:
            state["last_success"] = now
    registry.save(data_dir)

    status, reason = regulator_status(runs)
    outcomes = {"relevant": 0, "uncertain": 0, "irrelevant": 0}
    for cid in new_ids:
        if not registry.candidates[cid].get("relationship"):
            outcomes[outcomes_by_id[cid]] += 1
    robots = {name: {"status": policy.status, "crawl_delay": policy.crawl_delay} for name, policy in client.robots.items()}
    return {
        "id": regulator.id, "name": regulator.name, "short_name": regulator.short_name, "region": regulator.region,
        "jurisdiction": regulator.jurisdiction, "sweep_id": sweep_id, "finished_at": iso(utc_now()),
        "status": status, "status_reason": reason,
        "requests": client.requests, "request_budget": client.max_requests,
        "seconds": round(time.monotonic() - started, 1), "time_budget_seconds": client.max_seconds,
        "robots": robots,
        "counts": {
            "observed": sum(len(ids) for ids in per_channel.values()),
            "new": len(new_ids), "new_relevant": outcomes["relevant"], "new_uncertain": outcomes["uncertain"],
            "new_irrelevant": outcomes["irrelevant"], "baseline_added": len(created) - len(new_ids),
            "translations_linked": translations, "enriched": enriched, "registry_size": len(registry.candidates),
        },
        "channels": [run.summary(len(per_channel[run.channel.id]), len(per_channel_new[run.channel.id])) for run in runs],
        "known_gaps": list(regulator.known_gaps),
    }


def run(config: ScoutConfig, data_dir: Path, *, sources_config: Path, latest_path: Path, regulator: str = "all",
        trigger: str = "manual", client_factory=None, log=print) -> dict:
    data_dir = Path(data_dir)
    selected = config.selected(regulator)
    if not selected:
        raise ValueError(f"No active Scout regulators match {regulator!r}")
    started_at = utc_now()
    sweep_id = started_at.strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3)
    now = iso(started_at)
    factory = client_factory or (lambda item: PoliteClient(item, config.defaults))
    results = {}
    for item in selected:
        log(f"Scout: {item.short_name} ({item.region})")
        monitored = monitored_urls(sources_config, latest_path, item.https_hosts)
        results[item.id] = sweep_regulator(item, config, data_dir, monitored=monitored, sweep_id=sweep_id, now=now,
                                           client=factory(item), log=log)

    previous = read_json(data_dir / "latest.json", {})
    previous_regulators = {entry.get("id"): entry for entry in previous.get("regulators") or [] if isinstance(entry, dict)}
    regulators = []
    for item in config.regulators:
        if not item.active:
            continue
        entry = results.get(item.id) or previous_regulators.get(item.id)
        if entry is None:
            entry = {"id": item.id, "name": item.name, "short_name": item.short_name, "region": item.region,
                     "jurisdiction": item.jurisdiction, "status": "NOT_RUN", "status_reason": "Scout has not swept this regulator yet",
                     "channels": [], "counts": {}, "known_gaps": list(item.known_gaps)}
        regulators.append(entry)
    finished_at = iso(utc_now())
    statuses = [entry["status"] for entry in results.values()]
    latest = {
        "schema_version": SCHEMA_VERSION,
        "sweep_id": sweep_id,
        "started_at": now,
        "finished_at": finished_at,
        "trigger": trigger,
        "scope": "all" if regulator in {"", "all", "*"} else regulator,
        "status": worst(statuses),
        "objective": {"id": config.objective.id, "description": config.objective.description},
        "regulators": regulators,
        "totals": {
            key: sum(int((entry.get("counts") or {}).get(key) or 0) for entry in results.values())
            for key in ("observed", "new", "new_relevant", "new_uncertain", "new_irrelevant", "baseline_added", "requests")
        },
    }
    latest["totals"]["requests"] = sum(int(entry.get("requests") or 0) for entry in results.values())

    decisions = load_decisions(data_dir)
    monitored_all = monitored_urls(sources_config, latest_path, frozenset().union(*(item.https_hosts for item in config.regulators)))
    review = build_review(config, data_dir, monitored=monitored_all, decisions=decisions, generated_at=finished_at, sweep_id=sweep_id)
    write_if_changed(data_dir / "review.json", dump_compact(review))

    history = read_json(data_dir / "history.json", [])
    history.insert(0, {
        "sweep_id": sweep_id, "started_at": now, "finished_at": finished_at, "trigger": trigger, "status": latest["status"],
        "regulators": [{"id": entry["id"], "status": entry["status"], "new": entry["counts"]["new"],
                        "observed": entry["counts"]["observed"], "requests": entry["requests"]} for entry in results.values()],
    })
    write_if_changed(data_dir / "history.json", dump(history[: config.defaults.history_sweeps]))
    # latest.json is written last: it marks a sweep whose files are all in place.
    write_if_changed(data_dir / "latest.json", dump(latest))
    return latest


def rebuild_review(config: ScoutConfig, data_dir: Path, *, sources_config: Path, latest_path: Path) -> dict:
    data_dir = Path(data_dir)
    latest = read_json(data_dir / "latest.json", {})
    decisions = load_decisions(data_dir)
    monitored_all = monitored_urls(sources_config, latest_path, frozenset().union(*(item.https_hosts for item in config.regulators)))
    review = build_review(config, data_dir, monitored=monitored_all, decisions=decisions,
                          generated_at=iso(utc_now()), sweep_id=str(latest.get("sweep_id") or ""))
    write_if_changed(data_dir / "review.json", dump_compact(review))
    return review
