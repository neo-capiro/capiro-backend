#!/usr/bin/env python3
"""Convert the congressional MARK files (keyed by account+line#) into pe_code-keyed
loader artifacts. Procurement marks -> (account->appropriation, line#) via TOCs.
RDT&E HAC-D marks -> (service, R-1 line#) via jbook_r1 line#->PE map."""
import re, json, os, glob, unicodedata

MD_DIR="C:/Users/neoma/Downloads"
TOC_DIR="b2/toc"
R1="C:/Users/neoma/OneDrive/Documents/Claude/Projects/capirov2/git/capirov2/.claude/worktrees/hardcore-rosalind-98d6ee/apps/api/scripts/__data__/jbook_r1_fy2027.json"
OUT="b2/marks"; os.makedirs(OUT,exist_ok=True)

def norm(s): return re.sub(r'[^a-z0-9]','',unicodedata.normalize('NFKD',(s or '')).lower())
def dollars(s):
    s=(s or "").strip().strip("()").replace("$","").replace(",","").strip()
    if s in ("","-","—",""): return None
    try: return float(s) if "." in s else int(s)
    except: return None

# --- TOC master: appropCode -> {lineNo->(peCode,title)}; and normName -> appropCode
toc={}; name2code={}
for f in glob.glob(os.path.join(TOC_DIR,"*.json")):
    for code,v in json.load(open(f,encoding="utf-8")).items():
        t=toc.setdefault(code,{}); name2code[norm(v["name"])]=code
        # Army procurement (2031A-2035A) was loaded in batch-1 with RAW BLINs (already
        # globally unique, NOT namespaced). Everything else is <appropriation><lineItem>.
        is_army = bool(re.match(r'^203[0-9]A$', code))
        for lno,info in v["lines"].items():
            pe = info["raw"] if is_army else info["peCode"]
            t.setdefault(int(lno),(pe,info.get("title","")))

def title_ok(a,b):
    na,nb=norm(a),norm(b)
    if not na or not nb: return False
    return na[:10]==nb[:10] or na in nb or nb in na or na[:14]==nb[:14]
# account-name aliases (mark-file account text -> normalized TOC name)
ALIAS={
 "procurementofwtcvarmy":"procurementofwtcvarmy","procurementofammunitionarmy":"procurementofammunitionarmy",
 "procurementofammonavymc":"procurementofammonavymc","procurementmarinecorps":"procurementmarinecorps",
 "procurementspaceforce":"procurementspaceforce","spaceforceprocurement":"procurementspaceforce",
 "procurementdefensewide":"procurementdefensewide","aircraftprocurementairforce":"aircraftprocurementairforce",
 "missileprocurementairforce":"missileprocurementairforce","otherprocurementairforce":"otherprocurementairforce",
 "procurementofammunitionairforce":"procurementofammunitionairforce",
}
def acct_code(account):
    n=norm(account)
    if n in name2code: return name2code[n]
    n2=ALIAS.get(n,n)
    if n2 in name2code: return name2code[n2]
    # loose contains match
    for k,c in name2code.items():
        if k and (k in n or n in k): return c
    return None

# --- R-1 map: (serviceLetter, lineNo) -> PE ; serviceLetter from PE suffix
r1=json.load(open(R1,encoding="utf-8"))["rows"]
def svc_of(pe):
    m=re.match(r'^[0-9]{7}([A-Z0-9]+)$', pe or "")
    suf=m.group(1) if m else ""
    if suf.endswith("A") and not suf.endswith("SF"): return "ARMY"
    if suf=="N": return "NAVY"
    if suf=="F": return "AF"
    if suf=="SF": return "SF"
    return "DW"
r1map={}
for row in r1:
    pe=row.get("peCode"); ln=row.get("lineNumber")
    if pe and ln and str(ln).isdigit():
        r1map.setdefault((svc_of(pe),int(ln)), (pe,row.get("title","")))
def rdte_svc(account):
    n=norm(account)
    if "army" in n: return "ARMY"
    if "navy" in n: return "NAVY"
    if "airforce" in n: return "AF"
    if "spaceforce" in n: return "SF"
    return "DW"

def parse_rows(path):
    rows=[]
    for ln in open(path,encoding="utf-8"):
        if not ln.strip().startswith("|"): continue
        c=[x.strip() for x in ln.strip().strip("|").split("|")]
        if len(c)<7 or c[0] in ("Line","") or set(c[0])<=set("-"): continue
        if not c[0].isdigit(): continue
        rows.append({"line":int(c[0]),"account":c[1],"fy":int(c[2]) if c[2].isdigit() else None,
                     "request":dollars(c[3]),"mark":dollars(c[4]),"desc":c[6]})
    return rows

FILES=[  # (file, kind, stage, fy)
 ("armed_services_hasc_fy2026_procurement_corrected.md","proc","HASC",2026),
 ("armed_services_sasc_fy2026_procurement_corrected.md","proc","SASC",2026),
 ("ndaa_conference_fy2026_procurement_corrected.md","proc","conference",2026),
 ("armed_services_hasc_fy2027_procurement_corrected.md","proc","HASC",2027),
 ("armed_services_sasc_fy2027_procurement_corrected.md","proc","SASC",2027),
 ("appropriations_hacd_fy2027_procurement_corrected.md","proc","HAC-D",2027),
 ("appropriations_hacd_fy2027_rdte_corrected.md","rdte","HAC-D",2027),
]
print(f"{'file':52} {'matched/total':>14} {'unmapped-acct':>13}")
for fname,kind,stage,fy in FILES:
    p=os.path.join(MD_DIR,fname)
    if not os.path.exists(p): print(f"  MISSING {fname}"); continue
    rows=parse_rows(p); out=[]; miss=0; titledrop=0; badacct=set()
    for r in rows:
        hit=None
        if kind=="proc":
            code=acct_code(r["account"])
            if not code: badacct.add(r["account"]); continue
            hit=toc.get(code,{}).get(r["line"])
        else:
            hit=r1map.get((rdte_svc(r["account"]), r["line"]))
        if not hit: miss+=1; continue
        pe,ptitle=hit
        if not title_ok(r["desc"], ptitle): titledrop+=1; continue   # line# renumbered across years -> skip, don't mis-key
        out.append({"peCode":pe,"fy":r["fy"] or fy,"request":r["request"],"mark":r["mark"],"explanation":r["desc"]})
    art={"fy":fy,"source":f"{stage} FY{fy} {'procurement' if kind=='proc' else 'RDTE'} marks (line#->pe title-verified)","rows":out}
    if stage=="conference": art["stage"]="conference"
    else: art["chamber"]=stage
    outname=fname.replace("_corrected.md","_pekeyed.json")
    json.dump(art,open(os.path.join(OUT,outname),"w",encoding="utf-8"),ensure_ascii=False,indent=1)
    print(f"  {fname[:50]:50} kept={len(out):>4}/{len(rows):<4} titleDrop={titledrop:>3} noline={miss:>3} unmappedAcct={len(badacct)} {sorted(badacct)[:2]}")
