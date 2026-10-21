"""Deterministic, explainable relevance assessment for Scout candidates.

The result has three outcomes:

* relevant   - positive evidence that the page is the kind of publication the
               monitoring objective covers;
* uncertain  - not enough evidence, or evidence that conflicts;
* irrelevant - explicit evidence of exclusion (a site utility page, or a
               publication type the objective leaves out) and no regulatory
               signal pointing the other way.

Missing evidence never becomes "irrelevant". Every outcome carries the
signals behind it, and the confidence is a band, not an invented probability.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from regmon.scout import RULES_VERSION
from regmon.scout.profiles import Objective, Regulator
from regmon.scout.urls import file_format, slug_text
from urllib.parse import urlparse

I = re.IGNORECASE


@dataclass(frozen=True)
class Kind:
    id: str
    label: str
    default_class: str  # priority | neutral | secondary | out
    patterns: tuple[re.Pattern, ...]


def _p(*patterns: str) -> tuple[re.Pattern, ...]:
    return tuple(re.compile(pattern, I) for pattern in patterns)


PUBLICATION_TYPES: tuple[Kind, ...] = (
    Kind("enforcement", "Enforcement action", "priority", _p(
        r"\benforcement (action|order|decision)s?\b", r"\bcease[- ]and[- ]desist\b", r"\bcivil money penalt", r"\bwritten agreement\b",
        r"\bprohibition order\b", r"\b(fines?|fined|penalt(y|ies)) (imposed|on|against)\b", r"\bterminat(es|ion of) enforcement\b",
        r"\btakes? (enforcement )?action (against|to address)\b", r"\bfinal notice\b",
        r"\bsanci[oó]n(es)? administrativa", r"\bprocessos? administrativos? sancionador")),
    Kind("rule", "Rule or regulation", "priority", _p(
        r"\b(interim )?final rules?\b", r"\b(?-i:Regulation [A-Z]{1,2})\b", r"\b(delegated|implementing|commission) regulation\b",
        r"\bdirective\b", r"\brulemaking\b", r"\bamend(s|ed|ments?|ing) (to )?(the |its )?(rules?|regulations?)\b", r"\brègle(ment)?s?\b",
        r"\bresoluci[oó]n\b", r"\bresolu[cç][aã]o\b", r"\binstru[cç][aã]o normativa\b", r"\bnorma de car[aá]cter general\b", r"\bdecreto\b")),
    Kind("consultation", "Consultation or proposal", "priority", _p(
        r"\bconsultations?\b", r"\bconsults? on\b", r"\b(?-i:CP\d{1,2}/\d{2})\b", r"\b(?-i:DP\d{1,2}/\d{2})\b", r"\bproposed (rule|guidance|guideline|changes?|amendments?|revisions?)\b",
        r"\bproposals?\b", r"\bproposes?\b", r"\brequests? (for )?comments?\b", r"\bcomment period\b", r"\bseeks? (feedback|comments?|views)\b",
        r"\bdiscussion paper\b", r"\bcall for (evidence|input|advice)\b", r"\bnotice of proposed\b", r"\bconsulta p[uú]blica\b",
        r"\bdocument de consultation\b", r"\bsollicite\b")),
    Kind("technical_standard", "Technical standard", "priority", _p(
        r"\b(regulatory|implementing) technical standards?\b", r"\b(?-i:RTS|ITS)\b", r"\btechnical standards?\b")),
    Kind("guidance", "Guidance or guideline", "priority", _p(
        r"\bguidelines?\b", r"\bguidance\b", r"\bsupervisory (statement|expectations?)\b", r"\bpolicy statement\b",
        r"\bprudential (standard|practice guide)s?\b", r"\b(?-i:(CPS|CPG|APS|APG|SPS|SPG|GPS|GPG|LPS|LPG|HPS|HPG) ?\d{3})",
        r"\b(?-i:(SS|PS)\d{1,2}/\d{2})\b", r"\bline(s)? directrice(s)?\b", r"\bpréavis\b", r"\bgu[ií]as?\b", r"\borienta[cç][oõ]es\b")),
    Kind("reporting", "Reporting form or instructions", "priority", _p(
        r"\breporting (form|instruction|requirement|template|framework|return)s?\b", r"\b(regulatory|financial|filing) returns?\b",
        r"\bfiling instructions?\b", r"\binstructions? for (preparation|completing|filing)\b", r"\b(?-i:FR [A-Z0-9][A-Z0-9-]{0,7})\b",
        r"\b(?-i:FFIEC) ?\d{3}\b", r"\bcall reports?\b", r"\btaxonom(y|ies)\b", r"\bxbrl\b", r"\b(?-i:DPM)\b", r"\bdata point model\b",
        r"\btable layouts?\b", r"\bvalidation rules?\b", r"\breporting\b", r"\brelevés?\b", r"\bformulaires?\b",
        r"\b(?-i:(RPG|RPS|ARF|ARS|GRF|GRS|LRF|LRS|SRF|SRS|HRF|HRS) ?\d{3})", r"\b(data|statistics|statistical) collections?\b",
        r"\breporting (practice guide|standard)s?\b", r"\bsupporting statement\b")),
    Kind("supervisory_letter", "Supervisory letter or notice", "priority", _p(
        r"\b(?-i:(SR|CA) \d{2}-\d{1,2})\b", r"\bsupervis(ory|ion) and regulation letters?\b", r"\bsupervisory letters?\b",
        r"\bdear (ceo|chief executive)\b", r"\bcirculars?\b", r"\bcircular\b", r"\binterpretive letters?\b", r"\bstaff (statement|letter)s?\b",
        r"\bfederal register notices?\b", r"\b(supervisory|regulatory|public) notices?\b", r"\bnotices? (of|to) (industry|institutions|banks|insurers|members)\b",
        r"\bcomunicado\b", r"\bcarta circular\b", r"\bcarta-circular\b")),
    Kind("qa", "Q&A", "priority", _p(r"\bq ?& ?a\b", r"\bfaqs?\b", r"\bfrequently asked questions\b", r"\bquestions and answers\b")),
    Kind("decision_opinion", "Decision or opinion", "priority", _p(
        r"\bopinions? (of|on|to)\b", r"\b(final |formal |supervisory |board |commission )?decisions? (of|on|regarding|concerning|to)\b",
        r"\bdeterminations? (of|on)\b", r"\border approving\b", r"\bapproval of\b")),
    Kind("report", "Report or review", "neutral", _p(
        r"\breports?\b", r"\bpeer review\b", r"\brisk (dashboard|assessment)\b", r"\bwork programme\b", r"\bfeedback statement\b",
        r"\bstress test results\b", r"\bassessments?\b", r"\binforme\b", r"\brelat[oó]rio\b")),
    Kind("press_release", "Press release or news", "neutral", _p(
        r"\bpress releases?\b", r"\bannounces?\b", r"\bnews\b", r"\bstatements?\b", r"\bupdates?\b", r"\bnouvelles\b", r"\bnot[ií]cias?\b")),
    Kind("speech", "Speech or testimony", "secondary", _p(
        r"\bspeech(es)?\b", r"\bremarks\b", r"\btestimony\b", r"\bkeynote\b", r"\ballocution\b", r"\bdiscours\b", r"\bpanel discussion\b",
        r"\binterview\b", r"\bfireside chat\b", r"\bdiscurso\b")),
    Kind("minutes", "Minutes or meeting record", "secondary", _p(
        r"\bminutes\b", r"\bmeetings?\b", r"\bboard of supervisors\b", r"\bwritten procedures?\b", r"\bvoting results\b", r"\bagenda\b",
        r"\bmanagement board\b", r"\bactas?\b")),
    Kind("research", "Research or working paper", "out", _p(
        r"\bworking papers?\b", r"\bdiscussion series\b", r"\b(?-i:FEDS) notes?\b", r"\bresearch\b", r"\bstaff papers?\b",
        r"\beconomic (letter|commentary|bulletin)\b", r"\bbank insights?\b")),
    Kind("statistics", "Statistical release", "out", _p(
        r"\bstatistical releases?\b", r"\bstatistics\b", r"\bdata download\b", r"\b(?-i:[HGZE]\.\d{1,2}(\.\d)?)\b", r"\bexchange rates\b",
        r"\bselected interest rates\b", r"\bsurvey of\b", r"\bestad[ií]sticas?\b")),
    Kind("event", "Event", "out", _p(
        r"\bconferences?\b", r"\bworkshops?\b", r"\bwebinars?\b", r"\bcall for papers\b", r"\bseminars?\b",
        r"\bsymposi(um|a)\b", r"\bcolloque\b", r"\bevento\b")),
    Kind("media", "Media asset", "out", _p(r"\bphotos?\b", r"\bgallery\b", r"\bvideos?\b", r"\bpodcasts?\b", r"\blogos?\b", r"\bwallpaper\b")),
    Kind("job", "Job vacancy", "out", _p(
        r"\bvacanc(y|ies)\b", r"\bcareers?\b", r"\bjob (opening|offer|posting)s?\b", r"\brecruitment\b", r"\binternships?\b",
        r"\btraineeships?\b", r"\bemplois?\b")),
)

TOPICS: tuple[Kind, ...] = (
    Kind("capital", "Capital", "", _p(r"\bcapital (requirement|adequacy|rule|ratio|buffer|planning)s?\b", r"\bbasel\b", r"\b(?-i:CET1|RWA|CRR|CRD|BCAR|LICAT)\b",
                                       r"\bleverage ratio\b", r"\brisk[- ]weight", r"\bown funds\b", r"\bstability buffer\b", r"\bfonds propres\b", r"\bcapital\b")),
    Kind("liquidity", "Liquidity", "", _p(r"\bliquidity\b", r"\b(?-i:LCR|NSFR)\b", r"\bliquidité\b", r"\bliquidez\b")),
    Kind("reporting", "Regulatory reporting", "", _p(r"\breporting\b", r"\bxbrl\b", r"\btaxonom", r"\bcall report", r"\b(?-i:FR [A-Z0-9])", r"\bdéclaration réglementaire\b")),
    Kind("stress_testing", "Stress testing", "", _p(r"\bstress[- ]test", r"\b(?-i:CCAR|DFAST)\b", r"\bsupervisory scenarios?\b")),
    Kind("resolution", "Recovery and resolution", "", _p(r"\bresolution plan", r"\bliving wills?\b", r"\brecovery plan", r"\b(?-i:MREL|TLAC)\b", r"\bbail-?in\b",
                                                          r"\bdeposit guarantee", r"\bdeposit insurance\b")),
    Kind("financial_crime", "Financial crime and AML", "", _p(r"\banti-money laundering\b", r"\b(?-i:AML|CFT|AML/CFT)\b", r"\bterrorist financing\b",
                                                                 r"\bfinancial crime\b", r"\bsanctions?\b", r"\bfraud\b", r"\blavado de (dinero|activos)\b", r"\brecyclage\b")),
    Kind("payments_crypto", "Payments and digital assets", "", _p(r"\bpayments?\b", r"\bstablecoins?\b", r"\bcrypto", r"\bdigital assets?\b", r"\b(?-i:MiCA|MICA|PSD2|PSD3)\b",
                                                                   r"\be-money\b", r"\bgenius act\b", r"\bpagos?\b", r"\bpagamentos?\b")),
    Kind("consumer", "Consumer protection", "", _p(r"\bconsumer\b", r"\bmortgages?\b", r"\bfair lending\b", r"\bcommunity reinvestment\b", r"\bcomplaints?\b",
                                                   r"\bconsommat", r"\bconsumidor")),
    Kind("operational_resilience", "Operational resilience and ICT", "", _p(r"\boperational resilience\b", r"\bcyber", r"\b(?-i:ICT|DORA)\b", r"\bthird[- ]party risk\b",
                                                                            r"\boutsourcing\b", r"\btechnology risk\b", r"\bincident reporting\b")),
    Kind("governance", "Governance and conduct", "", _p(r"\bgovernance\b", r"\bremuneration\b", r"\bcompensation\b", r"\bfit and proper\b", r"\binternal control",
                                                        r"\bconduct\b", r"\bgouvernance\b")),
    Kind("climate_esg", "Climate and ESG", "", _p(r"\bclimate\b", r"\b(?-i:ESG)\b", r"\bsustainab", r"\benvironmental\b", r"\btransition plans?\b", r"\bgreenwashing\b", r"\bclimat")),
    Kind("credit_market_risk", "Credit, market and accounting risk", "", _p(r"\bcredit risk\b", r"\bmarket risk\b", r"\b(?-i:FRTB|IRRBB|CECL)\b", r"\bcounterparty\b",
                                                                           r"\binterest rate risk\b", r"\blarge exposures?\b", r"\bloan loss", r"\b(?-i:IFRS) ?\d+\b",
                                                                           r"\baccounting\b", r"\bprovisioning\b")),
    Kind("insurance_pensions", "Insurance and pensions", "", _p(r"\binsur(ance|er)s?\b", r"\bsolvency\b", r"\bpensions?\b", r"\breinsur", r"\bassurances?\b")),
    Kind("markets", "Securities and market infrastructure", "", _p(r"\bsecurities\b", r"\bmarket infrastructure", r"\b(?-i:CSDs?|CCPs?)\b", r"\bclearing\b",
                                                                   r"\bsettlement\b", r"\bderivatives?\b", r"\bswaps?\b")),
    Kind("supervision", "Supervision and prudential policy", "", _p(r"\bsupervis(ion|ory)\b", r"\bprudential\b", r"\bexamination\b", r"\bbanking (organization|regulation)s?\b",
                                                                    r"\bbank holding compan", r"\bregulatory policy\b", r"\bsurveillance prudentielle\b", r"\bsupervisi[oó]n\b")),
)

# Noun phrases for reasons ("points to guidance or a guideline"); kept in step
# with SCOUT_NOUNS in dashboard-lib.js.
NOUNS = {
    "rule": "a rule or regulation", "consultation": "a consultation or proposal", "technical_standard": "a technical standard",
    "guidance": "guidance or a guideline", "reporting": "a reporting form or instructions", "supervisory_letter": "a supervisory letter or notice",
    "qa": "a Q&A", "enforcement": "an enforcement action", "decision_opinion": "a decision or opinion", "report": "a report",
    "press_release": "a press release", "speech": "a speech or testimony", "minutes": "a meeting record", "research": "research",
    "statistics": "a statistical release", "event": "an event page", "media": "a media page", "job": "a job posting",
}

UTILITY_PATH = re.compile(
    r"/(careers?|jobs?|vacanc(y|ies)|recruitment|emplois?|carrieres?|work-with-us|join-us|contact(-us)?|nous-joindre|contactez-nous|"
    r"privacy(-policy|-notice|-statement)?|cookies?(-policy|-notice|-settings)?|terms(-of-use|-and-conditions)?|legal-notice|disclaimer|"
    r"accessibility|accessibilite|search|recherche|buscar|login|log-in|logout|sign-?in|sign-?up|register|user|account|subscribe|"
    r"subscriptions?|newsletters?|email-alerts?|rss|feeds?|sitemap|site-map|social-media|follow-us)(/|$|\.|\?)", I)
UTILITY_TITLE = re.compile(
    r"^(careers?|vacancies|jobs|contact( us)?|privacy (policy|notice|statement)|cookie (policy|notice|settings)|terms (of use|and conditions)|"
    r"legal notice|disclaimer|accessibility( statement)?|search( results)?|sign in|log ?in|subscribe|newsletter|site ?map|page not found|"
    r"rss( feeds?)?|follow us)\b", I)

SOURCE_STRENGTH = {
    "title": "strong", "page heading": "strong", "link text": "strong", "feed category": "strong", "keywords": "strong",
    "description": "medium", "listing text": "medium", "page path": "medium", "address": "weak",
}
CLASS_ORDER = {"priority": 0, "neutral": 1, "secondary": 2, "out": 3}


def _lower(label: str) -> str:
    return label[:1].lower() + label[1:]


def _date(value):
    from datetime import datetime, timezone
    text = str(value or "").strip()
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00") if "T" in text else text + "T00:00:00+00:00")
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _sources(candidate: dict) -> list[tuple[str, str]]:
    evidence = candidate.get("evidence") or {}
    anchor = str(evidence.get("anchor_text") or "")
    from regmon.scout.channels import is_generic
    sources = [
        ("title", evidence.get("title")),
        ("page heading", evidence.get("heading")),
        ("title", evidence.get("page_title")),
        ("link text", "" if is_generic(anchor) else anchor),
        ("link text", evidence.get("title_attr")),
        ("feed category", " · ".join(evidence.get("categories") or [])),
        ("keywords", evidence.get("keywords")),
        ("description", evidence.get("description")),
        ("description", evidence.get("meta_description")),
        ("listing text", evidence.get("context")),
        ("address", slug_text(candidate.get("url") or "")),
    ]
    return [(label, str(text)) for label, text in sources if text and str(text).strip()]


_KEYWORD_CACHE: dict[str, re.Pattern] = {}


def _keyword(terms, sources, strengths):
    """First (source, term) where a configured keyword appears as a whole word or phrase."""
    for source, text in sources:
        if SOURCE_STRENGTH.get(source, "weak") not in strengths:
            continue
        for term in terms:
            pattern = _KEYWORD_CACHE.get(term)
            if pattern is None:
                pattern = _KEYWORD_CACHE[term] = re.compile(r"(?<!\w)" + re.escape(term) + r"(?!\w)", re.IGNORECASE)
            if pattern.search(text):
                return source, term
    return None


def _find(kinds, sources):
    """First matching source and term for each kind: {kind_id: (kind, source, term)}."""
    found = {}
    for kind in kinds:
        for source, text in sources:
            match = None
            for pattern in kind.patterns:
                match = pattern.search(text)
                if match:
                    break
            if match:
                found[kind.id] = (kind, source, match.group(0).strip())
                break
    return found


def _class_of(kind_id: str, default_class: str, objective: Objective) -> str:
    if objective.priority_types and kind_id in objective.priority_types:
        return "priority"
    if objective.out_of_objective_types and kind_id in objective.out_of_objective_types:
        return "out"
    if objective.priority_types and default_class == "priority":
        return "neutral"
    return default_class


def assess(candidate: dict, regulator: Regulator, objective: Objective) -> dict:
    url = str(candidate.get("url") or "")
    evidence = candidate.get("evidence") or {}
    path = urlparse(url).path or "/"
    sources = _sources(candidate)
    strong_sources = [(label, text) for label, text in sources if SOURCE_STRENGTH.get(label) in {"strong", "medium"}]
    reasons: list[dict] = []

    types = _find(PUBLICATION_TYPES, sources)
    topics = _find(TOPICS, sources)
    for hint in regulator.path_hints:
        if hint.effect != "positive" or not path.startswith(hint.prefix):
            continue
        # A curated path hint outranks words guessed from the address slug.
        if hint.publication_type:
            kind = next((item for item in PUBLICATION_TYPES if item.id == hint.publication_type), None)
            if kind and (kind.id not in types or SOURCE_STRENGTH.get(types[kind.id][1]) == "weak"):
                types[kind.id] = (kind, "page path", hint.prefix)
        if hint.topic:
            kind = next((item for item in TOPICS if item.id == hint.topic), None)
            if kind and (kind.id not in topics or SOURCE_STRENGTH.get(topics[kind.id][1]) == "weak"):
                topics[kind.id] = (kind, "page path", hint.prefix)

    def strength(source: str) -> str:
        return SOURCE_STRENGTH.get(source, "weak")

    if file_format(url, " ".join([str(evidence.get("anchor_text") or ""), str(evidence.get("context") or "")])) != "Web page":
        # A spreadsheet or PDF is a document, whatever "update" or "news" its file name contains.
        types.pop("press_release", None)
    priority = {key: value for key, value in types.items() if _class_of(key, value[0].default_class, objective) == "priority"}
    out = {key: value for key, value in types.items() if _class_of(key, value[0].default_class, objective) == "out"}
    secondary = {key: value for key, value in types.items() if _class_of(key, value[0].default_class, objective) == "secondary"}
    neutral = {key: value for key, value in types.items() if _class_of(key, value[0].default_class, objective) == "neutral"}
    strong_priority = {key: value for key, value in priority.items() if strength(value[1]) != "weak"}
    strong_topics = {key: value for key, value in topics.items() if strength(value[1]) != "weak"}
    strong_out = {key: value for key, value in out.items() if strength(value[1]) != "weak"}

    # Owner-configured profile keywords: a relevant keyword counts like a topic,
    # an exclusion keyword like an out-of-objective type. Both are visible reasons.
    keyword_hit = _keyword(regulator.relevant_keywords, sources, {"strong", "medium"})
    exclusion_hit = _keyword(regulator.exclude_keywords, sources, {"strong"})
    utility_path = UTILITY_PATH.search(path)
    title_text = next((text for label, text in sources if label in {"title", "page heading", "link text"}), "")
    utility_title = UTILITY_TITLE.search(title_text.strip()) if title_text else None
    negative_hint = next((hint for hint in regulator.path_hints if hint.effect == "negative" and path.startswith(hint.prefix)), None)

    for key, (kind, source, term) in sorted(priority.items(), key=lambda item: strength(item[1][1]) == "weak"):
        reasons.append({"effect": "+", "source": source, "text": f"{source.capitalize()} points to {NOUNS[kind.id]} (“{term}”)"})
    for key, (kind, source, term) in list(topics.items())[:3]:
        reasons.append({"effect": "+", "source": source, "text": f"{source.capitalize()} mentions {_lower(kind.label)} (“{term}”)"})
    if evidence.get("near_monitored"):
        reasons.append({"effect": "+", "source": "address", "text": "Sits in a section ChangeSentinel already monitors"})
    if keyword_hit:
        reasons.append({"effect": "+", "source": keyword_hit[0], "text": f"{keyword_hit[0].capitalize()} matches the profile keyword “{keyword_hit[1]}”"})
    if exclusion_hit:
        reasons.append({"effect": "-", "source": exclusion_hit[0], "text": f"{exclusion_hit[0].capitalize()} matches the profile's exclusion keyword “{exclusion_hit[1]}”"})
    for key, (kind, source, term) in out.items():
        reasons.append({"effect": "-", "source": source, "text": f"{source.capitalize()} suggests {NOUNS[kind.id]} (“{term}”), outside the monitoring objective"})
    for key, (kind, source, term) in secondary.items():
        reasons.append({"effect": "~", "source": source, "text": f"{source.capitalize()} suggests {NOUNS[kind.id]} (“{term}”); these sometimes signal policy changes"})
    if utility_path:
        reasons.append({"effect": "-", "source": "address", "text": f"Address looks like a site utility page (“{utility_path.group(1)}”)"})
    if utility_title:
        reasons.append({"effect": "-", "source": "title", "text": f"Title looks like a site utility page (“{utility_title.group(0)}”)"})
    if negative_hint:
        reasons.append({"effect": "-", "source": "page path", "text": f"Under {negative_hint.prefix}, which this regulator's profile marks as outside the objective"})

    positive_strong = bool(strong_priority) or bool(strong_topics) or bool(evidence.get("near_monitored")) or bool(keyword_hit)
    has_any_positive = bool(priority) or bool(topics) or bool(evidence.get("near_monitored")) or bool(keyword_hit)

    if (utility_path or utility_title) and not positive_strong:
        outcome = "irrelevant"
        confidence = "strong" if utility_path and utility_title else "supported"
    elif negative_hint and not positive_strong:
        outcome, confidence = "irrelevant", "supported"
    elif (strong_out or exclusion_hit) and not strong_priority and not keyword_hit:
        if strong_topics or evidence.get("near_monitored"):
            outcome, confidence = "uncertain", "conflicting"
        else:
            outcome = "irrelevant"
            confidence = "strong" if len(strong_out) > 1 or any(source in {"feed category", "page path"} for _, source, _ in out.values()) else "supported"
    elif strong_priority:
        conflicting = bool(strong_out) or bool(exclusion_hit) or utility_path or utility_title
        outcome = "relevant"
        if conflicting:
            confidence = "conflicting"
        elif len(strong_priority) + len(strong_topics) >= 2 or evidence.get("near_monitored"):
            confidence = "strong"
        else:
            confidence = "supported"
    elif secondary and strength(next(iter(secondary.values()))[1]) != "weak":
        outcome, confidence = "uncertain", "supported"
    elif strong_topics or keyword_hit:
        outcome = "relevant"
        from_title = any(strength(source) == "strong" for _, source, _ in strong_topics.values())
        from_title = from_title or bool(keyword_hit and SOURCE_STRENGTH.get(keyword_hit[0]) == "strong")
        confidence = "supported" if from_title or len(strong_topics) >= 2 else "weak"
    elif has_any_positive:
        outcome, confidence = "uncertain", "weak"
    else:
        outcome, confidence = "uncertain", "weak"
        if not strong_sources:
            reasons.append({"effect": "~", "source": "address", "text": "Only the address is known so far; there is not enough evidence to judge it"})
        else:
            reasons.append({"effect": "~", "source": "title", "text": "No regulatory publication type or topic was recognised in the available text"})

    dated = _date(evidence.get("published") or evidence.get("page_published") or evidence.get("lastmod"))
    seen = _date(candidate.get("first_seen"))
    if candidate.get("origin") == "new" and dated and seen and (seen - dated).days >= 365:
        reasons.append({"effect": "~", "source": "dates", "text": f"Dated {dated.date().isoformat()}; this may be an older page that has only now appeared in a channel"})

    # The kind of page shown is the one named by the most direct evidence: a
    # title beats a curated path hint, which beats a summary or the address.
    rank = {"strong": 3, "medium": 2, "weak": 1}
    order = {kind.id: index for index, kind in enumerate(PUBLICATION_TYPES)}
    path_bonus = lambda source: 0.5 if source == "page path" else 0
    chosen_type = None
    for group in (strong_priority, priority, neutral, secondary, out):
        if group:
            kind = sorted(group.values(), key=lambda value: (-(rank[strength(value[1])] + path_bonus(value[1])), order[value[0].id]))[0][0]
            chosen_type = {"id": kind.id, "label": kind.label}
            break
    hint_text = " ".join([str(evidence.get("anchor_text") or ""), str(evidence.get("context") or "")])
    outcome_rank = {"relevant": 3, "uncertain": 2, "irrelevant": 1}[outcome]
    band = {"strong": 4, "supported": 3, "conflicting": 2, "weak": 1}[confidence]
    return {
        "outcome": outcome,
        "confidence": confidence,
        "publication_type": chosen_type,
        "topics": [kind.label for kind, _, _ in topics.values()][:4],
        "format": file_format(url, hint_text),
        "reasons": reasons[:8],
        "rank": outcome_rank * 10 + band + (2 if strong_priority else 0),
        "rules_version": RULES_VERSION,
    }
