#!/usr/bin/env python3
"""Join TOC BLINs (line# -> namespaced peCode) to the user's P-1 md line data
(line# -> title + fyData). Emits loader-ready pdoc artifacts + a coverage report."""
import json, os, re, glob, sys, difflib

TOC_DIR = "b2/toc"
MD_DIR  = r"C:/Users/neoma/Downloads/financial final"
OUT_DIR = "b2/artifacts"; os.makedirs(OUT_DIR, exist_ok=True)

# user md file -> (service flag for loader, appropriation code)
FILE_MAP = {
 "pdoc_navy_aircraft_fy2027_corrected.md":            ("NAVY","1506N"),
 "pdoc_navy_weapons_fy2027_corrected.md":             ("NAVY","1507N"),
 "pdoc_navy_ammo_marine_corps_fy2027_corrected.md":   ("NAVY","1508N"),
 "pdoc_navy_shipbuilding_fy2027_corrected.md":        ("NAVY","1611N"),
 "pdoc_navy_op_fy2027_corrected.md":                  ("NAVY","1810N"),
 "pdoc_marine_corps_procurement_fy2027_corrected.md": ("USMC","1109N"),
 "pdoc_airforce_aircraft_fy2027_corrected.md":        ("AF","3010F"),
 "pdoc_airforce_op_fy2027_corrected.md":              ("AF","3080F"),
 "pdoc_airforce_missile_fy2027_corrected.md":         ("AF","3020F"),
 "pdoc_airforce_ammo_fy2027_corrected.md":            ("AF","3011F"),
 "pdoc_spaceforce_procurement_fy2027_corrected.md":   ("SF","3022F"),
 "pdoc_defensewide_procurement_fy2027_corrected.md":  ("DW","0300D"),
 # SOCOM/MDA/NGREA are SUBSET views of the Defense-Wide file (per INDEX note) -> skip to avoid double-count
 "pdoc_defense_production_act_program_account_fy2027_corrected.md": ("DW","0360D"),
}

def dollars(s):
    s=(s or "").strip().strip("()")
    s=s.replace("$","").replace(",","").strip()
    if s in ("","-","—"): return None
    try: return float(s) if "." in s else int(s)
    except: return None

def parse_md(path):
    """-> list of {lineNo, title, ba, fyData:[{fy,quantity,requestDollarsThousands,unitCostDollars}]}"""
    lines=open(path,encoding="utf-8").read().splitlines()
    out=[]; cur=None
    for ln in lines:
        h=re.match(r'^##\s+(\S+)\s+—\s+(.*)$', ln)
        if h:
            if cur: out.append(cur)
            no=h.group(1)
            cur={"lineNo": int(no) if no.isdigit() else None, "title":h.group(2).strip(),"ba":None,"fyData":[]}
            continue
        if cur is None: continue
        b=re.match(r'\s*-\s*Budget Activity:\s*(.*)', ln)
        if b: cur["ba"]=b.group(1).strip() or None; continue
        if ln.startswith("|"):
            c=[x.strip() for x in ln.strip().strip("|").split("|")]
            if len(c)<4 or c[0] in ("FY","") or set(c[0])<=set("-"): continue
            if not c[0].isdigit(): continue
            cur["fyData"].append({"fy":int(c[0]),
                "quantity": int(c[1]) if c[1].lstrip('-').isdigit() else (dollars(c[1]) if c[1] else None),
                "requestDollarsThousands": dollars(c[2]), "unitCostDollars": dollars(c[3])})
    if cur: out.append(cur)
    return out

def norm(t): return re.sub(r'[^a-z0-9]','',(t or '').lower())

# load + merge TOCs by appropriation code (union of lines)
toc={}
for f in glob.glob(os.path.join(TOC_DIR,"*.json")):
    d=json.load(open(f,encoding="utf-8"))
    for code,v in d.items():
        t=toc.setdefault(code,{"name":v["name"],"lines":{}})
        for lno,info in v["lines"].items():
            t["lines"].setdefault(int(lno),info)

print("=== TOC master coverage ===")
for code,v in sorted(toc.items()): print(f"  {code} {v['name'][:40]:40} lines={len(v['lines'])}")

print("\n=== MATCH REPORT (user P-1 line -> namespaced peCode) ===")
grand_m=grand_t=0
artifacts={}  # (service,fy) -> pes[]
for fname,(svc,code) in FILE_MAP.items():
    p=os.path.join(MD_DIR,fname)
    if not os.path.exists(p): print(f"  [MISSING md] {fname}"); continue
    rows=parse_md(p)
    tlines=toc.get(code,{}).get("lines",{})
    m=0; miss=[]; titlemismatch=0; pes=[]
    for r in rows:
        ln=r["lineNo"]; info=tlines.get(ln)
        if info:
            m+=1
            # title sanity
            if norm(r["title"])[:12] not in norm(info["title"]) and norm(info["title"])[:12] not in norm(r["title"]):
                titlemismatch+=1
            pes.append({"peCode":info["peCode"],"title":r["title"],"budgetActivity":r["ba"] or info["ba"],
                        "lineNumber":info["peCode"],"programOfRecord":None,"fyData":r["fyData"]})
        else:
            miss.append(ln)
    grand_m+=m; grand_t+=len(rows)
    artifacts.setdefault((svc,2027),[]).extend(pes)
    flag = "OK" if m==len(rows) else "PARTIAL"
    print(f"  [{flag}] {fname[:46]:46} {m}/{len(rows)} matched (code {code}, tocLines={len(tlines)}) titleMism={titlemismatch}" + (f" MISSING_lines={miss[:8]}" if miss else ""))

print(f"\nTOTAL matched {grand_m}/{grand_t}")
# write artifacts
for (svc,fy),pes in artifacts.items():
    # NO dedupe: base + Advance-Procurement share a BLIN (same peCode) but are
    # distinct P-1 lines — pass both, exactly as the Army batch-1 artifacts did.
    art={"service":svc,"fy":fy,"sourceUrl":f"FY2027 P-40 justification books (TOC-keyed)","pes":pes}
    json.dump(art,open(os.path.join(OUT_DIR,f"pdoc_{svc.lower()}_fy2027_corrected.json"),"w",encoding="utf-8"),ensure_ascii=False,indent=1)
    ncodes=len(set(p["peCode"] for p in pes))
    print(f"  wrote pdoc_{svc.lower()}_fy2027_corrected.json  pes={len(pes)} (distinct BLINs={ncodes})")
