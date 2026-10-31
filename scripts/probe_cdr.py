"""Temporary probe: the CDR page's own taxonomy script (branch probe/cdr-taxonomy)."""
import re
import requests

s = requests.Session()
s.headers.update({"User-Agent": "Mozilla/5.0 (compatible; ChangeSentinel regulatory monitor)"})
s.get("https://cdr.ffiec.gov/public/DownloadTaxonomy.aspx", timeout=30)
for path in ["/public/DownloadTaxonomy.js?v=727285", "/public/JsObjects/CommonFunctionality.js?v=727285",
             "/public/PddSite.Master.js?v=727285", "/public/includes/utilities.js?v=727285"]:
    js = s.get("https://cdr.ffiec.gov" + path, timeout=30).text
    print(f"=== {path} ({len(js)} chars)")
    if "DownloadTaxonomy" in path:
        print(js[:20000])
    else:
        for m in re.finditer(r"router|ajax\(|RequestorID|contentType|JSON\.stringify|Taxonomy", js):
            start = max(0, m.start() - 300)
            print("...", js[start:m.start() + 500].replace("\n", " "), "...")
            print()
