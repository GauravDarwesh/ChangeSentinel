"""Publish validated regulatory monitoring events to ntfy."""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATE_PATH = DATA / "notifications.json"
DEFAULT_TOPIC = ""
DEFAULT_SERVER = "https://ntfy.sh"

def load_state(path: Path=STATE_PATH) -> dict:
    if not path.exists():
        return {"sent_events":{}, "updated_at":None}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value,dict) and isinstance(value.get("sent_events",{}),dict):
            return value
    except (json.JSONDecodeError,OSError):
        pass
    return {"sent_events":{}, "updated_at":None}

def save_state(state: dict, path: Path=STATE_PATH) -> None:
    DATA.mkdir(parents=True,exist_ok=True)
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(state,indent=2),encoding="utf-8")

def build_notifications(report: dict) -> list[dict]:
    output=[]
    seen=set()
    for result in report.get("ai_results",[]):
        ai=result.get("ai",{})
        analysis=ai.get("analysis",{}) if isinstance(ai,dict) else {}
        if ai.get("status")=="ok" and analysis.get("relevant") is True:
            item={"event_id":result["event_id"],"kind":result.get("event","CHANGED_URL"),"url":result.get("url"),"topic":analysis["topic"],"summary":analysis["summary"],"reason":analysis["reason"],"impact":analysis["impact"],"priority":4,"tags":["warning","bank","regulatory"]}
            output.append(item); seen.add(item["event_id"])
    for event in report.get("events",[]):
        eid=event.get("event_id")
        kind=event.get("event_type")
        if eid in seen:
            continue
        if kind=="REMOVED_URL":
            output.append({"event_id":eid,"kind":kind,"url":event.get("url"),"topic":"Monitored URL removed","summary":"A previously monitored regulator URL is no longer discoverable.","reason":"The URL was absent from the current successful crawl.","impact":"Review whether the regulator moved, retired, or reorganized the material.","priority":4,"tags":["warning","link","regulatory"]})
        elif kind in {"FETCH_ERROR","EXTRACTION_ERROR"}:
            error=(event.get("evidence") or {}).get("error","Unknown operational error")
            output.append({"event_id":eid,"kind":kind,"url":event.get("url"),"topic":"Monitoring operational alert","summary":"The current run could not fully process a monitored regulator resource.","reason":error,"impact":"The previous known-good baseline was preserved.","priority":3,"tags":["warning","monitoring"]})
    return output

def publish(notification: dict, topic: str, server: str, dashboard_url: str="") -> None:
    message=(f"Event: {notification['kind']}\n"
             f"Topic: {notification['topic']}\n"
             f"URL: {notification.get('url') or '(not available)'}\n\n"
             f"{notification['summary']}\n\n"
             f"Impact: {notification.get('impact','')}\n\n"
             f"Why: {notification['reason']}\n\n"
             f"Event ID: {notification['event_id']}")
    payload={"topic":topic,"title":f"Regulatory Monitor — {notification['kind']}","message":message,"priority":notification["priority"],"tags":notification["tags"]}
    if dashboard_url:
        payload["click"]=dashboard_url
    response=requests.post(server.rstrip("/")+"/",json=payload,headers={"Content-Type":"application/json"},timeout=20)
    response.raise_for_status()

def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--test",action="store_true")
    args=parser.parse_args()
    topic=os.getenv("NTFY_TOPIC",DEFAULT_TOPIC).strip()
    server=os.getenv("NTFY_SERVER",DEFAULT_SERVER).strip()
    require_delivery=os.getenv("REQUIRE_NTFY","0").strip() == "1"
    if not topic:
        print(json.dumps({"enabled":False,"reason":"NTFY_TOPIC is not configured"},indent=2))
        if require_delivery:
            raise RuntimeError("NTFY_TOPIC is required for this notification test")
        return
    dashboard_url=os.getenv("DASHBOARD_URL","").strip()
    if args.test:
        notification={"event_id":f"test-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}","kind":"TEST","url":dashboard_url,"topic":"Controlled notification test","summary":"This is a controlled end-to-end ntfy delivery test. No monitoring baseline is changed.","reason":"Manual GitHub Actions test requested.","impact":"None","priority":3,"tags":["white_check_mark","test"]}
        publish(notification,topic,server,dashboard_url)
        print(json.dumps({"test":True,"sent":True,"event_id":notification["event_id"]},indent=2))
        return
    report_path=DATA/"report.json"
    if not report_path.exists():
        raise FileNotFoundError("data/report.json does not exist")
    report=json.loads(report_path.read_text(encoding="utf-8"))
    state=load_state()
    candidates=build_notifications(report)
    sent=skipped=failed=0
    for notification in candidates:
        eid=notification["event_id"]
        if eid in state["sent_events"]:
            skipped+=1
            continue
        try:
            publish(notification,topic,server,dashboard_url)
            state["sent_events"][eid]={"kind":notification["kind"],"sent_at":datetime.now(timezone.utc).isoformat()}
            sent+=1
        except Exception as exc:
            failed+=1
            print(f"notification failed for {eid}: {exc}")
    save_state(state)
    print(json.dumps({"candidate_notifications":len(candidates),"sent":sent,"skipped":skipped,"failed":failed},indent=2))
    if failed and require_delivery:
        raise RuntimeError(f"{failed} notification(s) failed")

if __name__=="__main__":
    main()
