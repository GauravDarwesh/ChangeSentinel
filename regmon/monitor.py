import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

SEED = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/guidelines-product-oversight-and-governance-arrangements-retail-banking-products?phase=consolidated"
BASE = "https://www.eba.europa.eu/activities/single-rulebook/regulatory-activities/consumer-protection/"
LIMIT = 50
AI_MAX = 3


def canonical(url):
    url = url.split("#", 1)[0].strip()
    p = urlparse(url)
    path = p.path or "/"
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    return p.scheme.lower() + "://" + p.netloc.lower() + path + (("?" + p.query) if p.query else "")


def is_file(url):
    path = urlparse(url).path.lower()
    return path.endswith((".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".csv"))


def make_id(url):
    return hashlib.sha256(canonical(url).encode("utf-8")).hexdigest()


def discover():
    cmd = ["stealth-crawler", "crawl", SEED, "--base", BASE, "--urls-only"]
    result = subprocess.run(cmd, text=True, capture_output=True)
    (DATA / "stealth-output.txt").write_text(
        result.stdout + "\n" + result.stderr,
        encoding="utf-8",
    )

    urls = []
    seen = set()
    for line in result.stdout.splitlines():
        value = line.strip()
        if not value.startswith("http"):
            continue
        value = canonical(value)
        if value.startswith(BASE) and value not in seen:
            seen.add(value)
            urls.append(value)
        if len(urls) >= LIMIT:
            break

    if not urls:
        raise RuntimeError("No EBA URLs were discovered by Stealth Crawler.")
    return urls


def load_previous():
    path = DATA / "latest.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def fetch(url):
    response = requests.get(
        url,
        timeout=30,
        headers={"User-Agent": "regulatory-monitoring-poc/1.0"},
    )
    return response.status_code, response.headers.get("content-type", ""), response.text


def ai_analyse(url, html):
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        return {"status": "skipped", "reason": "OPENROUTER_API_KEY is not configured"}

    page_text = re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", html))[:10000]

    payload = {
        "model": "openrouter/free",
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a regulatory monitoring assistant. "
                    "Return JSON only with keys relevant, topic, summary, reason. "
                    "Use only evidence in the supplied page text. Do not invent facts."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Regulator: European Banking Authority\n"
                    "URL: " + url + "\n\n"
                    "Page text:\n" + page_text
                ),
            },
        ],
    }

    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/GauravDarwesh/WEB-MONITORING-CRAWLER",
            "X-Title": "EBA Regulatory Monitoring POC",
        },
        json=payload,
        timeout=60,
    )
    response.raise_for_status()

    content = response.json()["choices"][0]["message"]["content"]
    try:
        return {"status": "ok", "analysis": json.loads(content)}
    except json.JSONDecodeError:
        return {"status": "ok", "analysis_raw": content}


def main():
    previous = load_previous()
    urls = discover()

    current = {}
    new_items = []
    changed_items = []
    unchanged_items = []

    for url in urls:
        item = {
            "url_id": make_id(url),
            "canonical_url": url,
            "terminal_file": is_file(url),
        }

        if not item["terminal_file"]:
            try:
                code, content_type, body = fetch(url)
                item.update(
                    {
                        "http_status": code,
                        "content_type": content_type,
                        "content_hash": hashlib.sha256(
                            body.encode("utf-8", errors="ignore")
                        ).hexdigest(),
                    }
                )
            except Exception as exc:
                item["fetch_error"] = str(exc)

        current[item["url_id"]] = item
        old = previous.get(item["url_id"])

        if old is None:
            new_items.append(item)
        elif old.get("content_hash") != item.get("content_hash"):
            changed_items.append({"before": old, "after": item})
        else:
            unchanged_items.append(item)

    removed_items = [
        old for uid, old in previous.items()
        if uid not in current
    ]

    ai_results = []
    candidates = new_items + [change["after"] for change in changed_items]

    for item in candidates[:AI_MAX]:
        if item.get("terminal_file"):
            continue

        try:
            _, _, body = fetch(item["canonical_url"])
            event = "NEW_URL" if item in new_items else "CHANGED_URL"
            ai_results.append(
                {
                    "event": event,
                    "url": item["canonical_url"],
                    "ai": ai_analyse(item["canonical_url"], body),
                }
            )
        except Exception as exc:
            ai_results.append(
                {
                    "event": "AI_ERROR",
                    "url": item["canonical_url"],
                    "ai": {"status": "error", "reason": str(exc)},
                }
            )

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "seed": SEED,
        "base": BASE,
        "crawler": "stealth-crawler",
        "counts": {
            "discovered": len(current),
            "new": len(new_items),
            "changed": len(changed_items),
            "removed": len(removed_items),
            "unchanged": len(unchanged_items),
        },
        "new_urls": new_items,
        "changed_urls": changed_items,
        "removed_urls": removed_items,
        "ai_results": ai_results,
    }

    (DATA / "latest.json").write_text(
        json.dumps(current, indent=2),
        encoding="utf-8",
    )
    (DATA / "report.json").write_text(
        json.dumps(report, indent=2),
        encoding="utf-8",
    )

    markdown = [
        "# EBA Regulatory Monitoring Report",
        "",
        "Seed: " + SEED,
        "",
        "## Event counts",
        "",
        "Discovered: " + str(len(current)),
        "New: " + str(len(new_items)),
        "Changed: " + str(len(changed_items)),
        "Removed: " + str(len(removed_items)),
        "Unchanged: " + str(len(unchanged_items)),
        "",
        "## AI results",
        "",
    ]

    if ai_results:
        for result in ai_results:
            markdown.extend(
                [
                    "### " + result["event"],
                    "",
                    result["url"],
                    "",
                    json.dumps(result["ai"], indent=2),
                    "",
                ]
            )
    else:
        markdown.append("No new or changed HTML pages were sent to AI.")

    (DATA / "report.md").write_text(
        "\n".join(markdown),
        encoding="utf-8",
    )

    print(json.dumps(report["counts"], indent=2))


if __name__ == "__main__":
    main()
