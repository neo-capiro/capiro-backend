#!/usr/bin/env python3
"""OP-5 O&M narrative extractor.

Two book shapes, one extractor:
  - DW agency books (e.g. DISA_OP-5.pdf): ONE agency-level narrative after
    "I. Description of Operations Financed" -> a single record, sag=None,
    agency taken from the title page.
  - Service volumes (OMA Vol 1/2, OMN, OMAF, ...): one OP-5 exhibit PER
    SubActivity Group. Each section header carries the SAG code that matches
    O-1's sagBli exactly (Army '111', Navy '1A1A', AF '011A').

Emits JSON: {book, sourceUrl, records: [{sag, sagTitle, agency, narrative,
pageStart, pageEnd}]}. Narrative = text after the Description anchor up to the
next roman-numeral section ("II." / "III.") or the next SAG header.

Usage: extract_op5.py <pdf> <bookId> [--source-url U] > out.json
"""
import sys, re, json
import pdfplumber

DESC = re.compile(r"I\.\s*Description of Operations Financed\s*:?", re.I)
# Format 3 (TJS/SOCOM/OIG-style single-agency multi-exhibit books): no "I."
# header at all -- each exhibit is "<Title> ($X thousand) – <narrative>" inline.
INLINE_EXHIBIT = re.compile(
    r"^([A-Z][A-Za-z0-9()/,&.'\- ]{4,90}?)\s*\(\$[\d,]+(?:\.\d+)? thousand\)\s*[–—-]\s*",
    re.M,
)
NEXT_SECTION = re.compile(r"\b(II|III|IV)\.\s+[A-Z]")
# SAG headers as printed near the top of each service OP-5 exhibit, several spellings:
SAG_PATTERNS = [
    re.compile(r"Subactivity Group\s*[:#]?\s*([0-9A-Z]{3,4})\b", re.I),
    re.compile(r"\bSAG[:\s]+([0-9A-Z]{3,4})\b"),
    # "Detail by Subactivity Group ... 111 Maneuver Units" table-of-exhibit style
    re.compile(r"^\s*([0-9]{3}|[0-9][A-Z][0-9A-Z]{2})\s*[-–—:]\s*(.{4,60})$", re.M),
]

TITLE_PATTERNS = [
    re.compile(r"Detail by Subactivity Group:?\s*(.+)$", re.M),
    re.compile(r"Subactivity Group:?\s+([A-Z].{4,70})$", re.M),
]

def page_sag(text):
    for rx in SAG_PATTERNS:
        m = rx.search(text)
        if m:
            return m.group(1).upper()
    return None

def page_sag_title(text):
    for rx in TITLE_PATTERNS:
        m = rx.search(text)
        if m:
            t = m.group(1).strip()
            if 3 < len(t) < 80 and not t[0].isdigit():
                return t
    return None

def main():
    path = sys.argv[1]
    book = sys.argv[2]
    src = None
    if "--source-url" in sys.argv:
        src = sys.argv[sys.argv.index("--source-url") + 1]
    records = []
    with pdfplumber.open(path) as pdf:
        agency = None
        # agency from first two pages' first non-empty lines
        for pg in pdf.pages[:2]:
            for ln in (pg.extract_text() or "").splitlines():
                ln = ln.strip()
                if len(ln) > 8 and not re.match(r"(?i)fiscal|april|february|march|unclassified|operation and maint", ln):
                    agency = ln
                    break
            if agency:
                break
        cur = None  # {sag, sagTitle, narrative, pageStart}
        last_sag_seen = None
        for i, pg in enumerate(pdf.pages):
            t = pg.extract_text() or ""
            sag_here = page_sag(t)
            title_here = page_sag_title(t)
            if sag_here or title_here:
                last_sag_seen = (sag_here, title_here, i)
            m = DESC.search(t)
            if m:
                # close previous record
                if cur:
                    records.append(cur)
                sag = None; sag_title = None
                if last_sag_seen and i - last_sag_seen[2] <= 4:
                    sag, sag_title = last_sag_seen[0], last_sag_seen[1]
                body = t[m.end():]
                nx = NEXT_SECTION.search(body)
                if nx:
                    body = body[: nx.start()]
                cur = {"sag": sag, "sagTitle": sag_title, "agency": agency,
                       "narrative": body.strip(), "pageStart": i + 1, "pageEnd": i + 1}
                continue
            if cur:
                nx = NEXT_SECTION.search(t)
                if nx:
                    cur["narrative"] += "\n" + t[: nx.start()].strip()
                    cur["pageEnd"] = i + 1
                    records.append(cur)
                    cur = None
                elif len(cur["narrative"]) < 12000:
                    cur["narrative"] += "\n" + t.strip()
                    cur["pageEnd"] = i + 1
        if cur:
            records.append(cur)
        # Format-3 fallback: only if the DESC anchor found NOTHING in this book.
        if not records:
            full = "\n".join((pdf.pages[i].extract_text() or "") for i in range(len(pdf.pages)))
            matches = list(INLINE_EXHIBIT.finditer(full))
            for idx, mm in enumerate(matches):
                start = mm.end()
                end = matches[idx + 1].start() if idx + 1 < len(matches) else min(start + 6000, len(full))
                title = re.sub(r"\s+", " ", mm.group(1)).strip()
                records.append({"sag": None, "sagTitle": title, "agency": agency,
                                "narrative": full[start:end].strip(),
                                "pageStart": None, "pageEnd": None})
    for r in records:
        r["narrative"] = re.sub(r"[ \t]+", " ", r["narrative"]).strip()[:8000]
    print(json.dumps({"book": book, "sourceUrl": src, "agency": agency,
                      "records": records}, ensure_ascii=False))

if __name__ == "__main__":
    main()
