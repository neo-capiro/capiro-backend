#!/usr/bin/env python3
"""Build the complete Defense-Wide procurement artifact from the pseries coverage
file (line# -> LI code) joined to the user's P-1 DW dollar file (line# -> fyData)."""
import re, json, os

PSERIES = r"C:/Users/neoma/Downloads/pseries_defensewide_procurement_fy2027.md"
P1MD    = r"C:/Users/neoma/Downloads/financial final/pdoc_defensewide_procurement_fy2027_corrected.md"
OUT     = "b2/artifacts/pdoc_dw_fy2027_corrected.json"
APPROP  = "0300D"

def dollars(s):
    s=(s or "").strip().strip("()").replace("$","").replace(",","").strip()
    if s in ("","-","—"): return None
    try: return float(s) if "." in s else int(s)
    except: return None

# 1) pseries summary table: | P-1 Line | title | LI code | FY2027 total | exhibits | pages | found |
lic={}
for ln in open(PSERIES,encoding="utf-8"):
    if not ln.strip().startswith("|"): continue
    c=[x.strip() for x in ln.strip().strip("|").split("|")]
    if len(c)<3: continue
    if not c[0].isdigit(): continue      # skip header / non-row
    lineno=int(c[0]); code=c[2]
    if code and re.match(r'^[0-9A-Za-z]', code):
        lic[lineno]=code

# 2) user P-1 md: line# -> fyData + title
def parse_md(path):
    out={}; cur=None
    for ln in open(path,encoding="utf-8"):
        h=re.match(r'^##\s+(\S+)\s+—\s+(.*)$', ln)
        if h:
            no=h.group(1); cur=int(no) if no.isdigit() else None
            if cur is not None: out[cur]={"title":h.group(2).strip(),"ba":None,"fyData":[]}
            continue
        if cur is None: continue
        b=re.match(r'\s*-\s*Budget Activity:\s*(.*)', ln)
        if b and cur in out: out[cur]["ba"]=b.group(1).strip() or None; continue
        if ln.startswith("|") and cur in out:
            c=[x.strip() for x in ln.strip().strip("|").split("|")]
            if len(c)<4 or c[0] in ("FY","") or set(c[0])<=set("-") or not c[0].isdigit(): continue
            out[cur]["fyData"].append({"fy":int(c[0]),
                "quantity": int(c[1]) if c[1].lstrip('-').isdigit() else (dollars(c[1]) if c[1] else None),
                "requestDollarsThousands": dollars(c[2]), "unitCostDollars": dollars(c[3])})
    return out
p1=parse_md(P1MD)

RX=re.compile(r'^[0-9]{4}[A-Z]{1,2}[0-9A-Z]{2,14}$')
pes=[]; short=[]; nocode=[]; matched=0
for lineno in sorted(p1):
    code=lic.get(lineno)
    if not code: nocode.append(lineno); continue
    pe=f"{APPROP}{code}".upper()
    matched+=1
    if not RX.match(pe): short.append((lineno,pe))
    pes.append({"peCode":pe,"title":p1[lineno]["title"],"budgetActivity":p1[lineno]["ba"],
                "lineNumber":pe,"programOfRecord":None,"fyData":p1[lineno]["fyData"]})

print(f"pseries LI codes: {len(lic)}   user P-1 lines: {len(p1)}")
print(f"matched (built pes): {matched}   no LI code: {len(nocode)} {nocode[:10]}")
print(f"peCodes failing regex {{2,14}}: {len(short)} {short[:8]}")
print(f"distinct peCodes: {len(set(p['peCode'] for p in pes))}")
art={"service":"DW","fy":2027,"sourceUrl":"FY2027 Defense-Wide P-series (pseries file, TOC/LI-keyed)","pes":pes}
json.dump(art,open(OUT,"w",encoding="utf-8"),ensure_ascii=False,indent=1)
print("wrote",OUT)
for p in pes[:6]:
    print(f"  {p['peCode']:16} {p['title'][:34]:34} fy27={[y for y in p['fyData'] if y['fy']==2027]}")
