"""FFIEC CDR Call Report taxonomies, fetched through the CDR's own JSON API.

The CDR's "Taxonomies" page (cdr.ffiec.gov/public/DownloadTaxonomy.aspx) has no
file links: its script (DownloadTaxonomy.js) asks the site's router for the
list of taxonomy dates, then for the files of one date, and receives each
form's ZIP as base64 inside the JSON answer. This module makes the same two
requests, so a monitor of one form (FFIEC 031, 041 or 051) always reads the
latest taxonomy, and next quarter's taxonomy arrives as an ordinary change of
that monitor, compared edit by edit with the last one.

    POST https://cdr.ffiec.gov/Public/router/Search   (application/json)
    {"RequestorID": "TaxonomyEndDateList", "Criteria": {"DataSeriesID": 1}}
        -> [{"taxonomyid": ..., "formatteddate": "09/30/2026"}, ...]
    {"RequestorID": "PDDManagement",
     "Criteria": {"Subject": "PDDActions", "Action": "GetCallTaxonomyFiles", "TaxonomyId": "<taxonomyid>"}}
        -> [{"Message": "success", "FileName031": "...", "Content031Base64": "...", ...}]

Subject, Action and TaxonomyId belong inside Criteria, as DownloadTaxonomy.js
sends them (the id as the drop-down's string value). Sent beside Criteria
instead, the router answers ``[]`` with HTTP 200 (seen live on 31 Oct 2026).

A monitor opts in with ``"fetch_api": {"kind": "ffiec_cdr_call_taxonomy", "form": "031"}``
and a seed such as ``https://cdr.ffiec.gov/public/DownloadTaxonomy.aspx?form=031``
(an identity; it is never fetched as a page).

The CDR builds the ZIP for each request, so its bytes (member timestamps) may
differ while its files do not. The fingerprint (``raw_hash``) is therefore
taken over the members' names and contents, not the archive bytes, so an
unchanged taxonomy is not saved again on every scan.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import time
import zipfile
from datetime import datetime
from urllib.parse import urlsplit

import requests

from .fetch import FetchResult

KIND = "ffiec_cdr_call_taxonomy"
FORMS = ("031", "041", "051")
HOST = "cdr.ffiec.gov"
PAGE = "https://cdr.ffiec.gov/public/DownloadTaxonomy.aspx"
ROUTER = "https://cdr.ffiec.gov/Public/router/Search"
DATE_LIST = {"RequestorID": "TaxonomyEndDateList", "Criteria": {"DataSeriesID": 1}}
MAX_RESPONSE_BYTES = 96 * 1024 * 1024
CACHE_SECONDS = 600
_DATE_FORMATS = ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%Y %I:%M:%S %p", "%Y-%m-%dT%H:%M:%S")
# One scan reads all three forms; the CDR answers with all three at once.
_CACHE: dict = {}


class CDRError(RuntimeError):
    """The CDR answered, but not with a taxonomy."""


def validate(spec: object, where: str = "fetch_api") -> dict:
    if not isinstance(spec, dict):
        raise ValueError(f"{where} must be an object")
    if spec.get("kind") != KIND:
        raise ValueError(f"{where}.kind must be {KIND!r}")
    if set(spec) - {"kind", "form"}:
        raise ValueError(f"{where} has unknown keys: {', '.join(sorted(set(spec) - {'kind', 'form'}))}")
    if spec.get("form") not in FORMS:
        raise ValueError(f"{where}.form must be one of {', '.join(FORMS)}")
    return spec


def _answer(response: requests.Response):
    """The JSON the router sends: a list, a {"d": ...} wrapper, or a JSON string of either."""
    if response.status_code != 200:
        raise CDRError(f"CDR router answered HTTP {response.status_code}")
    if len(response.content) > MAX_RESPONSE_BYTES:
        raise CDRError(f"CDR answer exceeds {MAX_RESPONSE_BYTES} bytes")
    try:
        data = response.json()
    except ValueError:
        raise CDRError("CDR router did not answer with JSON (a bot check or an error page?)") from None
    for _ in range(3):
        if isinstance(data, dict) and "d" in data:
            data = data["d"]
        elif isinstance(data, str):
            try:
                data = json.loads(data)
            except ValueError:
                raise CDRError("CDR router answered with text that is not JSON") from None
        else:
            break
    return data


def _date(value: str) -> datetime | None:
    text = str(value or "").strip()
    for pattern in _DATE_FORMATS:
        try:
            return datetime.strptime(text, pattern)
        except ValueError:
            continue
    return None


def latest(dates: object) -> dict:
    """The newest taxonomy in the date list (by its date; the first one when no date reads)."""
    entries = [entry for entry in dates or [] if isinstance(entry, dict) and entry.get("taxonomyid") not in (None, "")] \
        if isinstance(dates, list) else []
    if not entries:
        raise CDRError("CDR listed no Call Report taxonomies")
    dated = [(_date(entry.get("formatteddate")), index, entry) for index, entry in enumerate(entries)]
    known = [item for item in dated if item[0] is not None]
    return max(known, key=lambda item: (item[0], -item[1]))[2] if known else entries[0]


def _session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (compatible; ChangeSentinel regulatory monitor)",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": PAGE,
    })
    return session


def _post(session: requests.Session, payload: dict, timeout: float):
    response = session.post(ROUTER, data=json.dumps(payload), timeout=timeout, allow_redirects=False,
                            headers={"Content-Type": "application/json;charset=utf-8"})
    return _answer(response)


def files_request(taxonomy_id) -> dict:
    """The router request for one taxonomy's files, shaped as the CDR page sends it."""
    return {"RequestorID": "PDDManagement",
            "Criteria": {"Subject": "PDDActions", "Action": "GetCallTaxonomyFiles", "TaxonomyId": str(taxonomy_id)}}


def taxonomy_files(timeout: float = 30, session: requests.Session | None = None) -> tuple[dict, dict]:
    """(date entry, files answer) for the newest Call Report taxonomy; cached for a few minutes."""
    cached = _CACHE.get("files")
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1], cached[2]
    session = session or _session()
    # The page first: the router may expect the session cookie the page sets.
    page = session.get(PAGE, timeout=timeout, allow_redirects=False)
    if page.status_code != 200:
        raise CDRError(f"CDR taxonomy page answered HTTP {page.status_code}")
    entry = latest(_post(session, DATE_LIST, timeout))
    answer = _post(session, files_request(entry["taxonomyid"]), timeout)
    files = answer[0] if isinstance(answer, list) and answer else answer
    if not isinstance(files, dict):
        raise CDRError(f"CDR returned no taxonomy files for {entry.get('formatteddate') or 'the newest date'} "
                       f"(taxonomy {entry['taxonomyid']})")
    if str(files.get("Message") or "").strip().lower() != "success":
        raise CDRError(f"CDR: {files.get('Message') or 'no taxonomy files'}")
    _CACHE["files"] = (time.monotonic(), entry, files)
    return entry, files


def content_hash(body: bytes) -> str:
    """SHA-256 over the ZIP's member names and contents, independent of archive timestamps."""
    digest = hashlib.sha256()
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        for info in sorted(archive.infolist(), key=lambda entry: entry.filename):
            if info.is_dir():
                continue
            digest.update(info.filename.encode("utf-8") + b"\0")
            digest.update(hashlib.sha256(archive.read(info)).digest())
    return digest.hexdigest()


def fetch(spec: dict, url: str, timeout: float = 30) -> FetchResult:
    """One form's newest Call Report taxonomy ZIP, as the engine's FetchResult."""
    validate(spec)
    if (urlsplit(url).hostname or "").lower() != HOST:
        raise CDRError(f"A CDR taxonomy monitor must use a {HOST} address")
    form = spec["form"]
    entry, files = taxonomy_files(timeout)
    encoded = files.get(f"Content{form}Base64")
    if not encoded:
        raise CDRError(f"CDR taxonomy {entry.get('formatteddate')} has no FFIEC {form} file")
    try:
        body = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise CDRError(f"CDR taxonomy file for FFIEC {form} is not valid base64") from None
    if not body.startswith(b"PK"):
        raise CDRError(f"CDR taxonomy file for FFIEC {form} is not a ZIP")
    return FetchResult(200, "application/zip", len(body), None, None, content_hash(body), body, False)


def main() -> int:
    """python -m regmon.cdr_taxonomy: list the newest taxonomy and its files (a live check)."""
    entry, files = taxonomy_files()
    print(f"Newest Call Report taxonomy: {entry.get('formatteddate')} (taxonomyid {entry.get('taxonomyid')})")
    for form in FORMS:
        encoded = files.get(f"Content{form}Base64") or ""
        print(f"  FFIEC {form}: {files.get(f'FileName{form}') or '-'} · {len(encoded) * 3 // 4:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
