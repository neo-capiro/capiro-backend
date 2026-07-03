#!/usr/bin/env python3
"""Extract directive-language provisions from FY committee reports (LEG-C).

Committee reports interleave funding tables with directive language ("Items of
Special Interest", per-program paragraphs). This extracts HEADED TEXT BLOCKS
that contain a verbatim PE code — the zero-inference subset the provision
loader auto-accepts (matchBasis='pe_code'). Fuzzier title/alias linking is the
loader's job, not the extractor's.

Block detection: a heading is a short line in Title Case (or ALL CAPS) that
doesn't end in sentence punctuation and isn't a table row (no digit runs).
A block = heading + following lines until the next heading / hard page artifact.

FY27 reports print NO PE codes anywhere (verified: 0 regex hits across all
2,220 pages of H.Rept. 119-698 / S.Rept. 119-127 / H.Rept. 119-715 — their
tables key on line numbers + titles). So this extracts SENTENCE-SHAPED
directive blocks and leaves PE linking to the provision loader's review-gated
title/alias matcher (project_title 0.7 / program_alias <=0.6, all candidates).
Shape filters (length, sentence count, digit density) exclude table fragments.

  python extract_report_provisions.py <report.pdf> <COMMITTEE> <FY> <out.json>
"""
import json
import re
import sys

import pdfplumber

PE_CODE = re.compile(r"\b[01]\d{6}[A-Z]{1,2}\b")
MIN_BODY = 250
MAX_BODY = 6000

# GPO page-footer boilerplate PDF extraction interleaves into provision text when a
# provision spans a page break ("VerDate ... Sfmt 6602 E:\HR\OC\HR698.XXX HR698
# GNIRAEH htiw ... no kcirederf 25"). Strip the whole mirror-image frame, then any
# truncated leftover ending at the Sfmt token.
GPO_FRAME = re.compile(r"VerDate\b.{0,320}?\bkcirederf\s+\d+", re.S)
GPO_TAIL = re.compile(r"VerDate\b.{0,240}?\bSfmt\s+\d+", re.S)


def strip_gpo(x: str) -> str:
    x = GPO_FRAME.sub(" ", x)
    x = GPO_TAIL.sub(" ", x)
    return re.sub(r"\s{2,}", " ", x)

HEADING = re.compile(
    r"^(?![•\-\d$])"          # not a bullet / number / dollar row
    r"(?=.{4,90}$)"            # sane length
    r"(?:[A-Z][A-Za-z0-9()&,'’./\- ]+)$"
)

def is_heading(line: str) -> bool:
    s = line.strip()
    if not s or len(s) > 90 or s.endswith((".", ",", ";", ":", "-", "—")):
        return False  # trailing hyphen = a hyphen-split continuation, not a heading
    if sum(ch.isdigit() for ch in s) > 6:      # table-ish
        return False
    if not HEADING.match(s):
        return False
    words = [w for w in re.split(r"\s+", s) if w]
    if len(words) < 2:
        return False
    # Title Case or ALL CAPS majority.
    caps = sum(1 for w in words if w[:1].isupper())
    return caps / len(words) >= 0.6

def main() -> None:
    pdf_path, committee, fy, out_path = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
    provisions = []
    with pdfplumber.open(pdf_path) as pdf:
        cur = None  # {heading, lines, pageStart, pageEnd}
        for pageno, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            for raw in text.split("\n"):
                line = raw.rstrip()
                if is_heading(line):
                    if cur:
                        provisions.append(cur)
                    cur = {"heading": re.sub(r"\s+", " ", line.strip()),
                           "lines": [], "pageStart": pageno, "pageEnd": pageno}
                elif cur is not None:
                    cur["lines"].append(line)
                    cur["pageEnd"] = pageno
        if cur:
            provisions.append(cur)

    out = []
    seen = set()
    for p in provisions:
        h = p["heading"]
        # Letter-spaced artifacts ("C O N T E N T S") and dot-leader TOC lines.
        words = h.split(" ")
        if sum(1 for w in words if len(w) == 1) > len(words) / 2:
            continue
        if ".." in h:
            continue
        body = strip_gpo(re.sub(r"[ \t]+", " ", "\n".join(p["lines"]))).strip()
        if body.count("....") > 3:  # table-of-contents block
            continue
        if len(body) < MIN_BODY:
            continue
        # Sentence-shaped language only: >=2 sentences, low digit density
        # (tables are digit-dense), and a real prose start.
        sentences = body.count(". ") + body.count(".\n")
        digits = sum(ch.isdigit() for ch in body)
        if sentences < 2 or digits / max(len(body), 1) > 0.12:
            continue
        key = (p["heading"], p["pageStart"])
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "heading": p["heading"],
            "text": body[:MAX_BODY],
            "pageStart": p["pageStart"],
            "pageEnd": p["pageEnd"],
        })

    artifact = {"committee": committee, "fy": fy, "sourceDocumentId": None, "provisions": out}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(artifact, f, ensure_ascii=False, indent=1)
    print(json.dumps({"committee": committee, "fy": fy, "blocks": len(provisions),
                      "peBearing": len(out),
                      "samples": [o["heading"][:60] for o in out[:5]]}))

if __name__ == "__main__":
    main()
