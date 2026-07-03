#!/usr/bin/env python3
"""Merge per-book P-40 detail extractions into ONE artifact, cross-checked against
the loaded prod universe (corrected_json artifacts). Emits:
  b2/detail/pdoc_detail_fy2027.json   — deterministic enrichment artifact (loader input)
  b2/detail/mdap_additions.json       — evidence-backed MDAP code -> peCode pairs
  b2/detail/enrich_llm_input.json     — items w/ descriptionText for the LLM layer
Report: per-book counts, prod-match rate, misses by book (never silently dropped)."""
import json, glob, os, re, collections

CJ=r"C:/Users/neoma/OneDrive/Documents/Claude/Projects/capirov2/git/capirov2/.claude/worktrees/hardcore-rosalind-98d6ee/apps/api/scripts/__data__/corrected_json"
EXCLUDE={"ProcAmmo_check.json","wtcv_detail.json","wtcv_enrich_input.json"}
BOOK_SERVICE={  # book stem -> service
 "Aircraft_Procurement_Army":"ARMY","Missile_Procurement_Army":"ARMY","Procurement_of_Ammunition":"ARMY",
 "Procurement_of_Weapons_and_Tracked_Combat_Vehicles":"ARMY","OP_Army_BA1":"ARMY","OP_Army_BA2":"ARMY","OP_Army_BA34":"ARMY",
 "APN_BA1-4_Book":"NAVY","APN_BA5_Book":"NAVY","APN_BA6-7_Book":"NAVY","WPN_Book":"NAVY","SCN_Book":"NAVY",
 "OPN_BA1_Book":"NAVY","OPN_BA2_Book":"NAVY","OPN_BA3_Book":"NAVY","OPN_BA4_Book":"NAVY","OPN_BA5-8_Book":"NAVY",
 "PANMC_Book":"NAVY","PMC_Book":"USMC",
 "AF_Aircraft_VolI":"AF","AF_Aircraft_VolII":"AF","AF_Missile":"AF","AF_Other":"AF","AF_Ammo":"AF",
 "SF_Space":"SF",
 "DW_CBDP":"DW","DW_DISA":"DW","DW_DLA":"DW","DW_DPAP":"DW","DW_DTRA":"DW","DW_SOCOM":"DW",
}

# prod universe: peCode -> title from the loaded artifacts
uni={}
for f in glob.glob(os.path.join(CJ,"pdoc_*_fy2027_corrected.json")):
    d=json.load(open(f,encoding="utf-8"))
    for p in d["pes"]: uni[p["peCode"].upper()]=p["title"]

BOOK_APPROP={  # each book covers ONE appropriation; rescue un-namespaced codes
 "APN_BA1-4_Book":"1506N","APN_BA5_Book":"1506N","APN_BA6-7_Book":"1506N",
 "WPN_Book":"1507N","PANMC_Book":"1508N","SCN_Book":"1611N",
 "OPN_BA1_Book":"1810N","OPN_BA2_Book":"1810N","OPN_BA3_Book":"1810N","OPN_BA4_Book":"1810N","OPN_BA5-8_Book":"1810N",
 "PMC_Book":"1109N",
 "AF_Aircraft_VolI":"3010F","AF_Aircraft_VolII":"3010F","AF_Missile":"3020F","AF_Other":"3080F",
 "SF_Space":"3022F",
 "DW_CBDP":"0300D","DW_DISA":"0300D","DW_DLA":"0300D","DW_DPAP":"0300D","DW_DTRA":"0300D","DW_SOCOM":"0300D",
}
merged={}; per_book={}; misses=collections.defaultdict(list)
for f in sorted(glob.glob("b2/detail_v2/*.json")):
    base=os.path.basename(f)
    if base in EXCLUDE or base.startswith(("pdoc_detail","mdap_additions","enrich_llm")): continue
    stem=base[:-5]
    svc=BOOK_SERVICE.get(stem)
    if svc is None: print(f"SKIP unknown book {base}"); continue
    d=json.load(open(f,encoding="utf-8"))
    items=d if isinstance(d,list) else d.get("pes",[])
    hit=0
    for it in items:
        pe=it["peCode"].upper()
        # rescue: exhibit header variants sometimes omit the appropriation prefix;
        # the book itself is single-appropriation, so re-namespace and re-check.
        if pe not in uni and stem in BOOK_APPROP and not pe.startswith(BOOK_APPROP[stem]):
            cand=BOOK_APPROP[stem]+pe
            if cand in uni:
                pe=cand; it["peCode"]=cand
        it["service"]=svc; it["sourceBook"]=stem
        if pe in uni: hit+=1
        else: misses[stem].append(pe)
        if pe not in merged or len(it.get("descriptionText") or "")>len(merged[pe].get("descriptionText") or ""):
            merged[pe]=it
    per_book[stem]=(len(items),hit)

known=[it for pe,it in sorted(merged.items()) if pe in uni]
unknown=[pe for pe in merged if pe not in uni]

# deterministic loader artifact (only prod-known lines; loader never creates PEs anyway)
# EnrichPe.pDocDetail is a TOP-LEVEL field per the loader (load-pdoc-enrichment.ts) —
# it merges this straight into program_element.raw.pDocDetail itself; nesting it
# under a "raw" key here silently no-ops (confirmed live 2026-07-03: pDocDetail
# loaded as null for all 802 lines until this was fixed).
det={"fy":2027,"source":"p40_detail_fy2027","pes":[
  {"peCode":it["peCode"],"title":it["title"],"service":it["service"],
   "description":(it.get("descriptionText") or None),
   "pDocDetail":{k:it.get(k) for k in
     ("appropriation","lineItem","budgetActivity","idCode","relatedPEs","mdapCode",
      "procurementQty","netProcurementM","unitCostK","unitCostM","sourceBook")}}
  for it in known]}
json.dump(det,open("b2/detail_v2/pdoc_detail_fy2027.json","w",encoding="utf-8"),ensure_ascii=False,indent=1)

# MDAP additions: deterministic evidence (code stated on the exhibit; '000'/None = no program)
mdap=[{"acqProgramCode":it["mdapCode"],"peCode":it["peCode"],"title":it["title"],"book":it["sourceBook"]}
      for it in known if it.get("mdapCode") and it["mdapCode"] not in ("000","N/A","NONE")]
json.dump(mdap,open("b2/detail_v2/mdap_additions.json","w",encoding="utf-8"),ensure_ascii=False,indent=1)

# LLM layer input: known lines w/ meaningful narrative
llm=[{"peCode":it["peCode"],"title":it["title"],"service":it["service"],
      "descriptionText":it["descriptionText"]}
     for it in known if len(it.get("descriptionText") or "")>200]
json.dump(llm,open("b2/detail_v2/enrich_llm_input.json","w",encoding="utf-8"),ensure_ascii=False,indent=1)

print(f"merged {len(merged)} distinct lines | prod-known {len(known)} | unknown {len(unknown)}")
print(f"MDAP evidence pairs: {len(mdap)} | LLM-layer items: {len(llm)}")
print("\nper-book (extracted / prod-matched):")
for b,(n,h) in sorted(per_book.items()): print(f"  {b:44} {n:4} / {h:4}")
if unknown[:12]: print("\nunknown sample:", unknown[:12])
