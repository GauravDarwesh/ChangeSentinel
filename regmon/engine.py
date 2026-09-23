"""Scalable monitoring orchestration."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from regmon.ai import AIConfig, analyze
from regmon.change import build_event_id, classify_change, make_diff, make_id, write_evidence
from regmon.config import DEFAULT_CONFIG_PATH, SourceConfig, load_config
from regmon.content import extract_content
from regmon.discovery import canonical, discover
from regmon.fetch import fetch
from regmon.relevance import triage

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SNAPSHOTS = DATA / "snapshots"
HISTORY = DATA / "history"
REPORTS = DATA / "reports"
CONFIG_PAYLOAD = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
DEFAULTS = CONFIG_PAYLOAD.get("defaults", {})

def load_previous(source_id: str) -> dict[str, dict]:
    path = DATA / "latest.json"
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") == 2 and isinstance(payload.get("sources"), dict):
        return payload["sources"].get(source_id, {})
    return payload if all(isinstance(v, dict) for v in payload.values()) else {}

def resolve_previous(url: str, previous: dict[str, dict]) -> tuple[str, dict | None]:
    """Resolve prior state by URL id, then by canonicalized URL for legacy/query-order compatibility."""
    uid = make_id(url)
    direct = previous.get(uid)
    if direct is not None:
        return uid, direct
    target = canonical(url)
    for previous_uid, record in previous.items():
        prior_url = record.get("canonical_url")
        if prior_url and canonical(prior_url) == target:
            return previous_uid, record
    return uid, None

def read_snapshot(record: dict | None) -> str | None:
    if not record or not record.get("snapshot_location"):
        return None
    try:
        return (ROOT / record["snapshot_location"]).read_text(encoding="utf-8")
    except FileNotFoundError:
        return None

def write_snapshot(uid: str, text: str) -> str:
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOTS / f"{uid}.txt"
    path.write_text(text, encoding="utf-8")
    return str(path.relative_to(ROOT))

def base_item(url: str, old: dict | None, now: str, source: SourceConfig) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "url_id": make_id(url),
        "source_id": source.id,
        "regulator": source.regulator,
        "canonical_url": url,
        "first_seen": old.get("first_seen", now) if old else now,
        "last_seen": now,
        "last_checked": now,
        "active": True,
        "terminal_file": False,
        "http_status": None,
        "content_type": None,
        "content_length": None,
        "etag": None,
        "last_modified": None,
        "raw_hash": None,
        "normalized_hash": None,
        "extraction_type": None,
        "extraction_error": None,
        "fetch_error": None,
        "snapshot_location": old.get("snapshot_location") if old else None,
        "evidence_location": old.get("evidence_location") if old else None,
        "relevance": old.get("relevance") if old else None,
    }

def make_current_item(url: str, old: dict | None, source: SourceConfig, now: str):
    item = base_item(url, old, now, source)
    try:
        result = fetch(
            url,
            timeout=int(DEFAULTS.get("fetch_timeout_seconds", 30)),
            attempts=int(DEFAULTS.get("fetch_attempts", 3)),
            backoff_seconds=float(DEFAULTS.get("fetch_backoff_seconds", 2)),
        )
        item.update({
            "http_status": result.status_code,
            "content_type": result.content_type,
            "content_length": result.content_length,
            "etag": result.etag,
            "last_modified": result.last_modified,
            "raw_hash": result.raw_hash,
        })
        text, extraction_type, extraction_error = extract_content(url, result.content_type, result.body)
        item["extraction_type"] = extraction_type
        if extraction_error:
            item["extraction_error"] = extraction_error
            return item, None
        normalized = text or ""
        item["normalized_hash"] = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        item["relevance"] = triage(url, normalized, result.content_type)
        return item, normalized
    except Exception as exc:
        item["fetch_error"] = f"{type(exc).__name__}: {exc}"
        item["fetch_traceback"] = traceback.format_exc()
        if old:
            for key in (
                "http_status","content_type","content_length","etag","last_modified",
                "raw_hash","normalized_hash","first_seen","snapshot_location",
                "evidence_location","relevance","extraction_type"
            ):
                if key in old:
                    item[key] = old[key]
        return item, None

def process_source(source: SourceConfig, run_id: str, dry_run: bool = False) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    previous = load_previous(source.id)
    initial_baseline = source.baseline_on_first_run and not previous
    urls = discover(source, DATA)
    current, texts, old_texts = {}, {}, {uid: read_snapshot(old) for uid, old in previous.items()}
    events, new_items, changed_items, migration_items, unchanged_items = [], [], [], [], []
    resolved = {url: resolve_previous(url, previous) for url in urls}

    workers = min(16, max(1, len(urls)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(make_current_item, url, resolved[url][1], source, now):
            (url, resolved[url][0], resolved[url][1], old_texts.get(resolved[url][0]))
            for url in urls
        }
        for future in as_completed(futures):
            url, uid, old, old_text = futures[future]
            item, text = future.result()
            item["url_id"] = uid
            current[uid] = item
            if text is not None:
                texts[uid] = text

            if item.get("fetch_error"):
                event_id = build_event_id("FETCH_ERROR", uid, (old or {}).get("normalized_hash") or (old or {}).get("raw_hash"), error=item["fetch_error"])
                evidence = write_evidence(ROOT, "FETCH_ERROR", event_id, url, now, old, item, old_text, None, item["fetch_error"])
                item["evidence_location"] = evidence
                events.append({"event_id":event_id,"event_type":"FETCH_ERROR","url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"evidence":{"error":item["fetch_error"]}})
                continue

            if item.get("extraction_error"):
                event_id = build_event_id("EXTRACTION_ERROR", uid, (old or {}).get("normalized_hash") or (old or {}).get("raw_hash"), error=item["extraction_error"])
                evidence = write_evidence(ROOT, "EXTRACTION_ERROR", event_id, url, now, old, item, old_text, None, item["extraction_error"])
                item["evidence_location"] = evidence
                events.append({"event_id":event_id,"event_type":"EXTRACTION_ERROR","url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"evidence":{"error":item["extraction_error"]}})
                continue

            event_type, migrated = classify_change(old, item)
            if event_type == "NEW_URL":
                new_items.append(item)
            elif event_type == "CHANGED_URL":
                changed_items.append({"before":old,"after":item})
            elif event_type == "BASELINE_MIGRATION":
                migration_items.append({"before":old,"after":item})
            else:
                unchanged_items.append(item)

            if text is not None:
                item["snapshot_location"] = write_snapshot(uid, text) if not dry_run else item.get("snapshot_location")
                current[uid] = item

            if event_type != "UNCHANGED_URL" or migrated:
                suppress_baseline_event = initial_baseline and event_type == "NEW_URL"
                if not suppress_baseline_event:
                    before_hash = (old or {}).get("normalized_hash") or (old or {}).get("raw_hash") or (old or {}).get("content_hash")
                    event_id = build_event_id(event_type, uid, before_hash, item.get("normalized_hash"))
                    evidence = None
                    if event_type in {"NEW_URL","CHANGED_URL"}:
                        evidence = write_evidence(ROOT, event_type, event_id, url, now, old, item, old_text, text) if not dry_run else None
                        item["evidence_location"] = evidence
                        current[uid] = item
                    events.append({"event_id":event_id,"event_type":event_type,"url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"evidence":{"previous":old,"current":item}})

    removed_items = []
    for uid, old in previous.items():
        if uid not in current:
            removed_items.append(old)
            url = old.get("canonical_url","")
            event_id = build_event_id("REMOVED_URL", uid, old.get("normalized_hash") or old.get("raw_hash") or old.get("content_hash"))
            evidence = write_evidence(ROOT, "REMOVED_URL", event_id, url, now, old, None, read_snapshot(old), None)
            events.append({"event_id":event_id,"event_type":"REMOVED_URL","url":url,"url_id":uid,"source_id":source.id,"timestamp":now,"evidence_location":evidence,"evidence":{"previous":old,"current":None}})

    candidates = [] if initial_baseline else [x for x in new_items + [c["after"] for c in changed_items] if x.get("relevance",{}).get("candidate",True)]
    ai_cfg = AIConfig(
        timeout_seconds=int(DEFAULTS.get("ai_timeout_seconds",60)),
        attempts=int(DEFAULTS.get("ai_attempts",2)),
        max_chars=int(DEFAULTS.get("max_ai_chars",14000)),
    )
    max_candidates = int(DEFAULTS.get("max_ai_candidates",100))
    ai_results = []

    deferred = candidates[max_candidates:]
    candidates = candidates[:max_candidates]
    for item in deferred:
        event = "NEW_URL" if any(x["url_id"] == item["url_id"] for x in new_items) else "CHANGED_URL"
        event_id = build_event_id("AI_DEFERRED", item["url_id"], item.get("normalized_hash"))
        ai_results.append({"event":"AI_DEFERRED","event_id":event_id,"url":item["canonical_url"],"source_id":source.id,"evidence_location":item.get("evidence_location"),"ai":{"status":"deferred","reason":f"Exceeded per-run AI limit of {max_candidates}"}})

    def analyze_item(item: dict) -> dict:
        event = "NEW_URL" if any(x["url_id"] == item["url_id"] for x in new_items) else "CHANGED_URL"
        event_id = build_event_id(event, item["url_id"], (previous.get(item["url_id"]) or {}).get("normalized_hash"), item.get("normalized_hash"))
        diff = make_diff(old_texts.get(item["url_id"]), texts.get(item["url_id"]), int(DEFAULTS.get("max_diff_lines",200))) if event == "CHANGED_URL" else ""
        return {"event":event,"event_id":event_id,"url":item["canonical_url"],"source_id":source.id,"evidence_location":item.get("evidence_location"),"ai":analyze(source.regulator,item["canonical_url"],event,diff,texts.get(item["url_id"],""),ai_cfg)}

    if not dry_run and candidates:
        with ThreadPoolExecutor(max_workers=int(DEFAULTS.get("ai_concurrency",4))) as pool:
            future_map = {pool.submit(analyze_item,item): item for item in candidates}
            for future in as_completed(future_map):
                item = future_map[future]
                try:
                    ai_results.append(future.result())
                except Exception as exc:
                    event = "CHANGED_URL" if any(x["url_id"] == item["url_id"] for x in changed_items) else "NEW_URL"
                    event_id = build_event_id(event,item["url_id"],(previous.get(item["url_id"]) or {}).get("normalized_hash"),item.get("normalized_hash"))
                    ai_results.append({"event":"AI_ERROR","event_id":event_id,"url":item["canonical_url"],"source_id":source.id,"evidence_location":item.get("evidence_location"),"ai":{"status":"error","reason":str(exc)}})

    counts = {
        "discovered":len(current),
        "new":len(new_items),
        "changed":len(changed_items),
        "removed":len(removed_items),
        "unchanged":len(unchanged_items),
        "baseline_migration":len(migration_items),
        "fetch_error":sum(1 for x in current.values() if x.get("fetch_error")),
        "extraction_error":sum(1 for x in current.values() if x.get("extraction_error")),
        "relevance_candidates":len([x for x in new_items + [c["after"] for c in changed_items] if x.get("relevance",{}).get("candidate",True)]),
        "ai_ok":sum(1 for x in ai_results if x.get("ai",{}).get("status")=="ok"),
        "ai_invalid":sum(1 for x in ai_results if x.get("ai",{}).get("status")=="invalid"),
        "ai_error":sum(1 for x in ai_results if x.get("ai",{}).get("status")=="error"),
        "ai_deferred":sum(1 for x in ai_results if x.get("ai",{}).get("status")=="deferred"),
    }
    return {
        "report":{
            "schema_version":2,"run_id":run_id,"generated_at":now,
            "source":{"id":source.id,"name":source.name,"regulator":source.regulator,"seeds":list(source.seed_urls),"allowed_prefixes":list(source.allowed_prefixes),"initial_baseline":initial_baseline},
            "change_detector":{"raw_hash":"SHA-256 retrieved bytes","normalized_hash":"SHA-256 extracted normalized content","classification_hash":"normalized_hash"},
            "relevance_gate":{"mode":"high_recall","ai_final_semantic_decision":True},
            "ai_contract":{"required_keys":["relevant","topic","change_type","summary","impact","effective_date","affected_scope","actions","reason"],"strict":True},
            "counts":counts,"events":events,"new_urls":[] if initial_baseline else new_items,"changed_urls":changed_items,"removed_urls":removed_items,"baseline_migrations":migration_items,"ai_results":sorted(ai_results,key=lambda x:x.get("event_id",""))
        },
        "inventory":current
    }

def save_outputs(source_results: list[dict], run_id: str, dry_run: bool=False) -> dict:
    if dry_run:
        return {"dry_run":True}
    for path in (DATA,SNAPSHOTS,HISTORY,REPORTS):
        path.mkdir(parents=True,exist_ok=True)
    latest_path = DATA / "latest.json"
    payload = json.loads(latest_path.read_text(encoding="utf-8")) if latest_path.exists() else {"schema_version":2,"sources":{}}
    if payload.get("schema_version") != 2 or not isinstance(payload.get("sources"),dict):
        payload = {"schema_version":2,"sources":{}}
    history_path = HISTORY / "index.json"
    history = json.loads(history_path.read_text(encoding="utf-8")) if history_path.exists() else []
    for result in source_results:
        report = result["report"]
        sid = report["source"]["id"]
        payload["sources"][sid] = result["inventory"]
        (REPORTS / f"{sid}.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
        history.append({"run_id":report["run_id"],"generated_at":report["generated_at"],"source_id":sid,"regulator":report["source"]["regulator"],"counts":report["counts"]})
    history.sort(key=lambda x:x.get("generated_at",""),reverse=True)
    history = history[:int(DEFAULTS.get("history_runs",90))*max(1,len(source_results))]
    history_path.write_text(json.dumps(history,indent=2),encoding="utf-8")
    latest_path.write_text(json.dumps(payload,indent=2),encoding="utf-8")

    count_keys = set().union(*(r["report"]["counts"].keys() for r in source_results))
    aggregate_counts = {k:sum(int(r["report"]["counts"].get(k,0)) for r in source_results) for k in sorted(count_keys)}
    aggregate = {
        "schema_version":2,"run_id":run_id,
        "generated_at":max(r["report"]["generated_at"] for r in source_results),
        "sources":[r["report"]["source"] for r in source_results],
        "counts":aggregate_counts,
        "change_detector":{"classification_hash":"normalized_hash"},
        "relevance_gate":{"mode":"high_recall","ai_final_semantic_decision":True},
        "ai_contract":source_results[0]["report"]["ai_contract"],
        "new_urls":[x for r in source_results for x in r["report"]["new_urls"]],
        "changed_urls":[x for r in source_results for x in r["report"]["changed_urls"]],
        "removed_urls":[x for r in source_results for x in r["report"]["removed_urls"]],
        "baseline_migrations":[x for r in source_results for x in r["report"]["baseline_migrations"]],
        "events":[x for r in source_results for x in r["report"]["events"]],
        "ai_results":[x for r in source_results for x in r["report"]["ai_results"]],
    }
    (DATA / "report.json").write_text(json.dumps(aggregate,indent=2),encoding="utf-8")
    (HISTORY / f"{run_id}.json").write_text(json.dumps(aggregate,indent=2),encoding="utf-8")
    md = ["# Regulatory Monitoring Report","",f"Run: {run_id}",f"Generated: {aggregate['generated_at']}","","## Aggregate counts","","| Metric | Value |","| --- | ---: |"]
    md += [f"| {k} | {v} |" for k,v in aggregate_counts.items()]
    md += ["","## Sources",""]
    for r in source_results:
        c=r["report"]["counts"]; s=r["report"]["source"]
        md += [f"### {s['name']}","",f"- Regulator: {s['regulator']}",f"- Discovered: {c['discovered']}",f"- Changed: {c['changed']}",f"- New: {c['new']}",f"- Removed: {c['removed']}",f"- Fetch errors: {c['fetch_error']}", ""]
    (DATA / "report.md").write_text("\n".join(md),encoding="utf-8")
    return {"dry_run":False,"sources":[r["report"]["source"]["id"] for r in source_results],"run_id":run_id}

def run(source_id: str="all", dry_run: bool=False) -> dict:
    _, sources = load_config()
    selected = [source for source in sources.values() if source.active] if source_id in {"all","*"} else [sources[source_id]]
    if not selected:
        raise ValueError("No active monitoring sources are configured")
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    results = [process_source(source,run_id,dry_run=dry_run) for source in selected]
    return {"run_id":run_id,"results":results,"outcome":save_outputs(results,run_id,dry_run=dry_run)}

def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--source",default=os.getenv("REGMON_SOURCE","all"))
    parser.add_argument("--dry-run",action="store_true")
    args=parser.parse_args()
    result=run(args.source,args.dry_run)
    print(json.dumps({"run_id":result["run_id"],"sources":args.source,"outcome":result["outcome"]},indent=2))

if __name__ == "__main__":
    main()
