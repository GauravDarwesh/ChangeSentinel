"""Structured AI analysis of regulatory changes."""
from __future__ import annotations
import json
import os
import time
from dataclasses import dataclass
import requests

AI_REQUIRED_KEYS = {"relevant","topic","change_type","summary","impact","effective_date","affected_scope","actions","reason"}

@dataclass(frozen=True)
class AIConfig:
    timeout_seconds: int = 60
    attempts: int = 2
    max_chars: int = 14000
    model: str = "openrouter/free"

def validate_analysis(value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError("AI output must be a JSON object")
    if set(value) != AI_REQUIRED_KEYS:
        raise ValueError("AI output must contain exactly the required nine keys")
    if not isinstance(value["relevant"], bool):
        raise ValueError("relevant must be boolean")
    for field in AI_REQUIRED_KEYS - {"relevant"}:
        if not isinstance(value[field], str) or not value[field].strip():
            raise ValueError(f"{field} must be a non-empty string")
    return value

def parse_json(content: str) -> dict:
    cleaned = content.strip()
    fence = chr(96) * 3
    if cleaned.startswith(fence) and cleaned.endswith(fence):
        cleaned = "\n".join(cleaned.splitlines()[1:-1]).strip()
    return validate_analysis(json.loads(cleaned))

def analyze(regulator: str, url: str, event_type: str, diff: str, current_text: str, config: AIConfig) -> dict:
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        return {"status":"skipped","reason":"OPENROUTER_API_KEY is not configured"}
    evidence = diff if event_type == "CHANGED_URL" and diff.strip() else current_text
    evidence = evidence[:config.max_chars]
    payload = {
        "model": config.model,
        "temperature": 0,
        "messages": [
            {"role":"system","content":"You are a regulatory change analyst. Return JSON only with exactly these keys: relevant, topic, change_type, summary, impact, effective_date, affected_scope, actions, reason. relevant is boolean. Every other field is a non-empty string. Use only the supplied evidence. Never invent dates, obligations, entities, or facts. Unknown values must be Not stated. change_type should be a concise category such as amendment, new_publication, consultation, deadline, requirement, withdrawal, clarification, or other."},
            {"role":"user","content":f"Regulator: {regulator}\nEvent: {event_type}\nURL: {url}\n\nEvidence:\n{evidence}"}
        ]
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type":"application/json",
        "HTTP-Referer":"https://github.com/GauravDarwesh/WEB-MONITORING-CRAWLER",
        "X-Title":"Regulatory Monitoring Engine"
    }
    last_error = None
    for attempt in range(1, config.attempts + 1):
        try:
            response = requests.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload, timeout=config.timeout_seconds)
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            try:
                return {"status":"ok","analysis":parse_json(content)}
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                return {"status":"invalid","reason":str(exc),"analysis_raw":content}
        except Exception as exc:
            last_error = exc
            if attempt < config.attempts:
                time.sleep(attempt)
    return {"status":"error","reason":str(last_error)}
