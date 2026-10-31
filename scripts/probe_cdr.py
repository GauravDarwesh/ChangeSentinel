"""Temporary probe: what the CDR taxonomy router really answers (branch probe/cdr-taxonomy)."""
import json, re, sys
import requests

PAGE = "https://cdr.ffiec.gov/public/DownloadTaxonomy.aspx"
ROUTER = "https://cdr.ffiec.gov/Public/router/Search"

def show(label, response):
    text = response.text
    text = re.sub(r'("Content\d{3}Base64"\s*:\s*")([A-Za-z0-9+/=]{80})[A-Za-z0-9+/=]*', r'\1\2…', text)
    print(f"--- {label}: HTTP {response.status_code} {response.headers.get('content-type')} len={len(response.content)}")
    print(text[:3000])

s = requests.Session()
s.headers.update({"User-Agent": "Mozilla/5.0 (compatible; ChangeSentinel regulatory monitor)",
                  "Accept": "application/json, text/javascript, */*; q=0.01",
                  "X-Requested-With": "XMLHttpRequest", "Referer": PAGE})
page = s.get(PAGE, timeout=30)
print("page", page.status_code, "cookies", list(s.cookies.keys()))
scripts = re.findall(r'<script[^>]+src="([^"]+)"', page.text)
print("scripts", scripts)
for src in scripts:
    if "axonomy" in src or "router" in src.lower() or "pdd" in src.lower():
        url = requests.compat.urljoin(PAGE, src)
        js = s.get(url, timeout=30).text
        print(f"=== {url} ({len(js)} chars)")
        print(js[:12000])
# inline scripts mentioning the router
for block in re.findall(r"<script[^>]*>(.*?)</script>", page.text, re.S):
    if "Taxonomy" in block or "router" in block:
        print("=== inline script"); print(block[:4000])

def post(payload, label):
    r = s.post(ROUTER, data=json.dumps(payload), timeout=60, allow_redirects=False,
               headers={"Content-Type": "application/json;charset=utf-8"})
    show(label, r)
    return r

dates = post({"RequestorID": "TaxonomyEndDateList", "Criteria": {"DataSeriesID": 1}}, "date list")
try:
    data = dates.json()
    while isinstance(data, dict) and "d" in data: data = data["d"]
    if isinstance(data, str): data = json.loads(data)
except Exception as exc:
    print("date list not JSON:", exc); sys.exit(0)
print("first entries:", json.dumps(data[:3]) if isinstance(data, list) else type(data))
entries = [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []
for entry in entries[:2]:
    tid = entry.get("taxonomyid")
    for variant, payload in [
        ("as coded", {"RequestorID": "PDDManagement", "Subject": "PDDActions", "Action": "GetCallTaxonomyFiles", "TaxonomyId": tid}),
        ("TaxonomyId as string", {"RequestorID": "PDDManagement", "Subject": "PDDActions", "Action": "GetCallTaxonomyFiles", "TaxonomyId": str(tid)}),
        ("in Criteria", {"RequestorID": "PDDManagement", "Subject": "PDDActions", "Action": "GetCallTaxonomyFiles", "Criteria": {"TaxonomyId": tid}}),
    ]:
        post(payload, f"files {entry.get('formatteddate')} [{variant}]")
