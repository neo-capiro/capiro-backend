#!/usr/bin/env python3
"""Fast BLIN<->title scan of a P-40 book: text-only pass over 'LI <BLIN> - <title>'
page footers and the 'Exhibit P-40 ... P-1 Line Item Number / Title' headers.
Captures every P-40 exhibit (extract_pdoc's table-parser misses ~half). Prints a
distinct BLIN->title map + count. No table/dollar parsing -> ~2-3x faster."""
import sys, re, pdfplumber

BLIN = r'[0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5}'
FOOTER = re.compile(r'\bLI\s+(' + BLIN + r')\s*[-–]\s*(.+?)\s*$', re.M)
# Header line: "... BSA <BLIN> / <Title>" or "P-1 Line Item Number ... <BLIN> / <Title>"
HDR = re.compile(r'(?:BSA|Line Item Number.*?)\s*(' + BLIN + r')\s*/\s*(.+?)\s*$', re.M)

def scan(path):
    found = {}   # blin -> title (first non-empty)
    with pdfplumber.open(path) as pdf:
        npages = len(pdf.pages)
        for pg in pdf.pages:
            t = pg.extract_text() or ""
            for m in FOOTER.finditer(t):
                b, title = m.group(1).strip().upper(), m.group(2).strip()
                if b not in found or (not found[b] and title):
                    found[b] = title
            for m in HDR.finditer(t):
                b, title = m.group(1).strip().upper(), m.group(2).strip()
                found.setdefault(b, title)
    return found, npages

if __name__ == "__main__":
    path = sys.argv[1]
    found, npages = scan(path)
    print(f"{path}\n  pages={npages}  distinct BLINs={len(found)}")
    for b, t in sorted(found.items()):
        print(f"  {b}  {t[:60]}")
