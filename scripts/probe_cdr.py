"""Temporary probe: the fixed client against the live CDR, end to end."""
import sys
sys.path.insert(0, ".")
from regmon import cdr_taxonomy
from regmon.engine import extract_content

print("== python -m regmon.cdr_taxonomy")
cdr_taxonomy.main()
for form in cdr_taxonomy.FORMS:
    result = cdr_taxonomy.fetch({"kind": cdr_taxonomy.KIND, "form": form},
                                f"https://cdr.ffiec.gov/public/DownloadTaxonomy.aspx?form={form}")
    text, kind, error = extract_content(f"https://cdr.ffiec.gov/public/DownloadTaxonomy.aspx?form={form}", result.content_type, result.body)
    print(f"FFIEC {form}: HTTP {result.status_code} {result.content_type} {len(result.body):,} bytes, hash {result.raw_hash[:12]}; "
          f"extracted {kind}, {len(text or ''):,} chars, error={error!r}")
    print("   first lines:", " | ".join((text or "").splitlines()[:3])[:300])
