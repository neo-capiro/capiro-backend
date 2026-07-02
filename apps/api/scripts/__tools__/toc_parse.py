#!/usr/bin/env python3
"""Parse a P-1/P-40 book's 'Master Line Item Table of Contents (by Appropriation
then Line Number)' -> per appropriation {line_no -> (rawLineItem, title, ba)}.
Handles all service formats (Navy 4-digit '0145', AF '000999'/'10TRGT', DW
'0201MC12'). Emits a namespaced pe_code = <appropriationCode><rawLineItem>, which
is globally unique (Treasury/USAspending convention). Fast: TOC-section only."""
import sys, re, json, pdfplumber

# "Appropriation 1506N: Aircraft Procurement, Navy"
APPROP = re.compile(r'Appropriation\s+([0-9]{3,4}[A-Z]{0,2}):\s*(.+)')
# TOC row: <line#> <BA(2d)> <BSA(2d)> <LineItemNumber(token)> <Title>....<pageref>
# LineItemNumber is a single whitespace-delimited token, 3-14 chars, alnum.
ROW = re.compile(r'^\s*(\d{1,4})\s+(\d{1,2})\s+(\d{1,2})\s+([0-9A-Za-z][0-9A-Za-z\-]{2,13})\s+(\S.*?)\s*\.{2,}', re.M)

def parse(path, page_cap=120):
    aps = {}          # apCode -> {"name":..., "lines": {lineNo: {...}}}
    order = []
    with pdfplumber.open(path) as pdf:
        cur_code = cur_name = None
        seen = False; gap = 0
        for i, pg in enumerate(pdf.pages):
            if i >= page_cap and seen:
                break
            t = pg.extract_text() or ""
            is_toc = ("Line Item Number" in t and "Line Item Title" in t)
            for m in APPROP.finditer(t):
                cur_code, cur_name = m.group(1).strip().upper(), m.group(2).strip()
                aps.setdefault(cur_code, {"name": cur_name, "lines": {}})
            if not is_toc:
                if seen:
                    gap += 1
                    if gap >= 4:
                        break
                continue
            seen = True; gap = 0
            for m in ROW.finditer(t):
                line_no, ba, bsa, raw, title = m.groups()
                raw = raw.strip().upper()
                title = re.sub(r'\s+', ' ', title).strip()
                ln = int(line_no)
                if cur_code is None:
                    continue
                d = aps.setdefault(cur_code, {"name": cur_name, "lines": {}})
                if ln not in d["lines"]:
                    d["lines"][ln] = {"raw": raw, "title": title, "ba": f"BA {int(ba):02d}",
                                       "peCode": f"{cur_code}{raw}"}
                    order.append((cur_code, ln))
    return aps

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_json = None
    if "--json" in sys.argv:
        out_json = sys.argv[sys.argv.index("--json") + 1]
    for path in args:
        aps = parse(path)
        total = sum(len(v["lines"]) for v in aps.values())
        print(f"{path}  appropriations={len(aps)}  total TOC lines={total}")
        for code, v in aps.items():
            print(f"  [{len(v['lines'])}] {code}: {v['name'][:50]}")
        if out_json:
            import os
            os.makedirs(out_json, exist_ok=True)
            base = os.path.splitext(os.path.basename(path))[0]
            json.dump(aps, open(os.path.join(out_json, base + ".json"), "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
