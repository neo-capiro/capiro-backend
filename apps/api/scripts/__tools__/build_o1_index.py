#!/usr/bin/env python3
"""Reconstruct the O-1 line index (account, line, SAG, title -> pe_code) directly
from the authoritative comptroller O-1 PDF, emitting the exact shape
build_op5_artifact.py consumes at b2/om/om_fy2027.json.

Avoids the hand-corrected .md dependency: the O-1A detail rows are clean and
unambiguous — "<account> <line> <sag> <title> <U|C> <amounts...>". pe_code =
<account><line> matches the prod O-1 keyspace exactly, so the OP-5 descriptions
this indexes will attach to the already-loaded O&M program elements.

Usage: build_o1_index.py <o1.pdf> <out.json>
"""
import json, re, sys
import pdfplumber

# "3400F 010 011A Primary Combat Forces U 1,182,002 ..." — account, line(3d),
# sag(3-4 alnum), title (lazy) up to the standalone classification marker U/C
# that precedes the dollar columns.
ROW_RE = re.compile(
    r"^(\d{3,4}[A-Z]{1,2})\s+(\d{3})\s+([0-9A-Z]{3,4})\s+(.+?)\s+([UC])\s+[\d,()-]+"
)


def service_of(account: str) -> str:
    c = account.upper()
    if c.endswith("A"):
        return "ARMY"
    if c.endswith("N"):
        return "NAVY"
    if c.endswith("F"):
        return "AF"  # 34/38xxF Air Force + Space Force family
    return "DW"


def main() -> None:
    pdf_path, out_path = sys.argv[1], sys.argv[2]
    rows = {}
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            for ln in text.splitlines():
                m = ROW_RE.match(ln.strip())
                if not m:
                    continue
                account, line, sag, title, _cls = m.groups()
                if line == "999":  # classified sentinel — no OP-5 narrative
                    continue
                pe = f"{account}{line}".upper()
                # First occurrence wins; the O-1 lists each line once in Details.
                rows.setdefault(
                    pe,
                    {
                        "peCode": pe,
                        "title": title.strip(),
                        "service": service_of(account),
                        "appropriationType": "OM",
                        "raw": {
                            "account": account,
                            "accountLine": line,
                            "sagBli": sag,
                        },
                    },
                )
    art = {"fy": 2027, "source": "comptroller O-1 FY2027", "pes": list(rows.values())}
    json.dump(art, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    by_acct = {}
    for p in rows.values():
        by_acct[p["raw"]["account"]] = by_acct.get(p["raw"]["account"], 0) + 1
    print(f"O-1 index: {len(rows)} lines", file=sys.stderr)
    for acct in sorted(k for k in by_acct if k in ("3400F", "3410F", "3740F", "3840F")):
        print(f"  {acct}: {by_acct[acct]}", file=sys.stderr)


if __name__ == "__main__":
    main()
