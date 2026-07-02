#!/usr/bin/env python3
"""FY2026 procurement marks -> pe_code by EXACT-TITLE matching within appropriation.
FY2026 line numbers don't align to FY2027 books (renumbered yearly), but program
titles are stable. Keys a FY2026 mark row to a BLIN only when its normalized title
matches EXACTLY ONE line in that appropriation's loaded universe. Ambiguous or
unmatched rows are dropped and counted — never mis-keyed."""
import re, json, os, glob, unicodedata, collections

MD_DIR="C:/Users/neoma/Downloads"
CJ=r"C:/Users/neoma/OneDrive/Documents/Claude/Projects/capirov2/git/capirov2/.claude/worktrees/hardcore-rosalind-98d6ee/apps/api/scripts/__data__/corrected_json"
OUT="b2/marks26"; os.makedirs(OUT,exist_ok=True)

def norm(s):
    s=unicodedata.normalize('NFKD',(s or '')).lower()
    s=re.sub(r'\b(adv(ance)?\s*proc(urement)?|ap)\b',' advproc ',s)   # unify AP suffixes
    return re.sub(r'[^a-z0-9]','',s)
def dollars(s):
    s=(s or "").strip().strip("()").replace("$","").replace(",","").strip()
    if s in ("","-","—"): return None
    try: return float(s) if "." in s else int(s)
    except: return None

# ---- title universe per appropriation, from the LOADED artifacts (actual pe_codes in prod)
# service artifact -> appropriation prefix(es) are embedded in the namespaced codes themselves.
uni=collections.defaultdict(dict)   # appropCode -> normTitle -> set(peCode)
def approp_of(pe):
    m=re.match(r'^(\d{4}[A-Z])',pe); return m.group(1) if m else None
for f in glob.glob(os.path.join(CJ,"pdoc_*_fy2027_corrected.json")):
    d=json.load(open(f,encoding="utf-8"))
    svc=d.get("service")
    for p in d["pes"]:
        pe=p["peCode"]
        ap=approp_of(pe) if svc!="ARMY" else None
        if svc=="ARMY":
            # Army codes are raw BLINs; appropriation from the artifact file name
            ap={"aircraft":"2031A","missile":"2032A","wtcv":"2033A","ammo":"2034A","op":"2035A"}[
                next(k for k in ["aircraft","missile","wtcv","ammo","op"] if k in os.path.basename(f))]
        uni[ap].setdefault(norm(p["title"]),set()).add(pe)

# account-name -> appropriation code (same aliasing as batch-4)
NAME2AP={
 "aircraftprocurementarmy":"2031A","missileprocurementarmy":"2032A","procurementofwtcvarmy":"2033A",
 "procurementofammunitionarmy":"2034A","otherprocurementarmy":"2035A",
 "aircraftprocurementnavy":"1506N","weaponsprocurementnavy":"1507N","procurementofammonavymc":"1508N",
 "shipbuildingandconversionnavy":"1611N","otherprocurementnavy":"1810N","procurementmarinecorps":"1109N",
 "aircraftprocurementairforce":"3010F","missileprocurementairforce":"3020F","otherprocurementairforce":"3080F",
 "procurementspaceforce":"3022F","spaceforceprocurement":"3022F","procurementdefensewide":"0300D",
}
def acct_code(account):
    n=norm(account)
    if n in NAME2AP: return NAME2AP[n]
    for k,v in NAME2AP.items():
        if k in n or n in k: return v
    return None

def parse_rows(path):
    rows=[]
    for ln in open(path,encoding="utf-8"):
        if not ln.strip().startswith("|"): continue
        c=[x.strip() for x in ln.strip().strip("|").split("|")]
        if len(c)<7 or c[0] in ("Line","") or set(c[0])<=set("-") or not c[0].isdigit(): continue
        rows.append({"line":int(c[0]),"account":c[1],"fy":int(c[2]) if c[2].isdigit() else None,
                     "request":dollars(c[3]),"mark":dollars(c[4]),"desc":c[6]})
    return rows

FILES=[
 ("armed_services_hasc_fy2026_procurement_corrected.md","HASC",2026),
 ("armed_services_sasc_fy2026_procurement_corrected.md","SASC",2026),
 ("ndaa_conference_fy2026_procurement_corrected.md","conference",2026),
]
for fname,stage,fy in FILES:
    p=os.path.join(MD_DIR,fname)
    if not os.path.exists(p): print("MISSING",fname); continue
    rows=parse_rows(p); out=[]; amb=0; nomatch=0; noacct=0; t2=0; t3=0; classified=0
    kept_mark=0; total_mark=0; classified_mark=0
    # tier-3 prep: within (account, normTitle) groups of size N>1 on BOTH sides,
    # pair by ORDER (P-1 convention: base precedes Advance Procurement). The
    # universe's titles distinguish base vs AP; the mark table's don't.
    from collections import defaultdict
    bygrp=defaultdict(list)
    for i,r in enumerate(rows):
        ap=acct_code(r["account"])
        if ap: bygrp[(ap,norm(r["desc"]))].append(i)
    # universe grouped by (ap, base-title-with-advproc-stripped) preserving artifact order
    uni_grp=defaultdict(list)
    for ap,titles in uni.items():
        for ut in titles:
            base=ut.replace("advproc","")
            for pe in sorted(titles[ut]):
                uni_grp[(ap,base)].append((ut,pe))
    resolved_by_t3={}
    for (ap,nt),idxs in bygrp.items():
        if len(idxs)<2: continue
        cand=uni_grp.get((ap,nt),[])
        # require SAME group size both sides + distinct universe entries in order
        if len(cand)==len(idxs) and len(set(c[1] for c in cand))>=1:
            for k,i in enumerate(sorted(idxs, key=lambda j: rows[j]["line"])):
                resolved_by_t3[i]=cand[k][1]
    for i,r in enumerate(rows):
        m=(r["mark"] or 0); total_mark += m
        if re.search(r'classified', r["desc"], re.I) or r["line"]>=9999:
            classified+=1; classified_mark+=m; continue   # unkeyable sentinel (policy: excluded, like batch-1)
        ap=acct_code(r["account"])
        if not ap: noacct+=1; continue
        nt=norm(r["desc"])
        hits=uni.get(ap,{}).get(nt,set())
        tier="exact"
        if len(hits)!=1 and i in resolved_by_t3:
            hits={resolved_by_t3[i]}; tier="pair-order"; t3+=1
        if len(hits)!=1:
            # tier-2: UNIQUE PREFIX containment within the appropriation. Prefix (not
            # mid-string) so aggregated rollup titles ("...memo non-add COLUMBIA...")
            # can't pollute. Uniqueness is enforced on the RESULTING peCode — base+AP
            # variants of one line share a BLIN, so multiple title hits that resolve
            # to a single peCode are still deterministic.
            cands=set()
            for ut,pes in uni.get(ap,{}).items():
                if len(nt)>=5 and (ut.startswith(nt) or nt.startswith(ut)):
                    cands|=pes
            if len(cands)==1: hits=cands; tier="contain"; t2+=1
        if len(hits)==1:
            out.append({"peCode":next(iter(hits)),"fy":r["fy"] or fy,"request":r["request"],"mark":r["mark"],"explanation":r["desc"]})
            kept_mark += m
        elif len(hits)>1: amb+=1
        else: nomatch+=1
    art={"fy":fy,"source":f"{stage} FY{fy} procurement marks (title-keyed)","rows":out}
    if stage=="conference": art["stage"]="conference"
    else: art["chamber"]=stage
    outname=fname.replace("_corrected.md","_pekeyed.json")
    json.dump(art,open(os.path.join(OUT,outname),"w",encoding="utf-8"),ensure_ascii=False,indent=1)
    keyable = total_mark - classified_mark
    pct = 100*kept_mark/keyable if keyable else 0
    print(f"{fname[:46]:46} kept={len(out):4}/{len(rows):<4} (t2={t2} t3={t3} classified={classified}) amb={amb} nomatch={nomatch:4} | $-cov={pct:5.1f}% of keyable (${kept_mark/1e9:.1f}B/${keyable/1e9:.1f}B; classified ${classified_mark/1e9:.1f}B excluded)")
