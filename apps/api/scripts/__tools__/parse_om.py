#!/usr/bin/env python3
"""Parse the FY2027 O-1 (Operation & Maintenance) 'All Accounts' markdown into a
loader-ready artifact. Each O-1 line -> program_element (appropriationType=OM),
keyed pe_code = <account><line> (e.g. 0100D010, 2020A010) — namespaced like
procurement, passes PROCUREMENT_CODE_REGEX. Amounts are $K (loader -> millions)."""
import re, json, os

SRC = r"C:/Users/neoma/Downloads/om_o1_all_accounts_fy2027_corrected.md"
OUT = "b2/om/om_fy2027.json"; os.makedirs("b2/om", exist_ok=True)

def dollars(s):
    s=(s or "").strip().strip("()").replace("$","").replace(",","").strip()
    if s in ("","-","—"): return None
    try: return float(s) if "." in s else int(s)
    except: return None

def service_of(acct):
    c=acct.strip().upper()
    if c.endswith("A"): return "ARMY"
    if c.endswith("N"): return "NAVY"
    if c.endswith("F"): return "AF"     # 34/38xxF Air Force incl Space Force accounts
    if c.endswith("D"): return "DW"
    return None

rows=[]; indetail=False; bad=[]
RX=re.compile(r'^[0-9]{4}[A-Z]{1,2}[0-9A-Z]{2,14}$')
for ln in open(SRC, encoding="utf-8"):
    if ln.startswith("## Line detail"): indetail=True; continue
    if indetail and ln.startswith("## "): break
    if not (indetail and ln.strip().startswith("|")): continue
    c=[x.strip() for x in ln.strip().strip("|").split("|")]
    if len(c)<13 or c[0] in ("Account","") or set(c[0])<=set("-"): continue
    account,ba,bsa,line,sag,title=c[0],c[1],c[2],c[3],c[4],c[5]
    if not re.match(r'^[0-9]{3,4}[A-Z]', account) or not line: continue
    fy25,fy26disc,fy26pl,fy26tot,fy27disc,fy27mand,fy27tot=[dollars(x) for x in c[6:13]]
    pe=f"{account}{line}".upper()
    # (account, line) is unique in the O-1 EXCEPT the '999' classified sentinel,
    # which repeats once per budget activity (e.g. 3400F BA01 + BA04). Disambiguate
    # colliding keys with a B<ba> suffix so distinct lines never share a pe_code.
    if any(r["peCode"]==pe for r in rows):
        pe=f"{account}{line}B{(ba or '00').zfill(2)}".upper()
        # also retro-suffix the FIRST collider so neither claims the bare key
        for r in rows:
            if r["peCode"]==f"{account}{line}".upper():
                m=re.search(r'(\d+)', r.get("budgetActivity") or "")
                first_ba=(m.group(1) if m else "00").zfill(2)
                r["peCode"]=f"{account}{line}B{first_ba}".upper()
                r["raw"]["disambiguated"]=True
    if not RX.match(pe): bad.append(pe); continue
    fyData=[]
    if fy25 is not None: fyData.append({"fy":2025,"enacted":fy25})
    if fy26tot is not None: fyData.append({"fy":2026,"enacted":fy26tot})
    if fy27tot is not None: fyData.append({"fy":2027,"request":fy27tot})
    rows.append({"peCode":pe,"title":title or pe,"appropriationType":"OM","service":service_of(account),
                 "budgetActivity":f"BA {ba}" if ba else None,
                 "raw":{"account":account,"accountLine":line,"sagBli":sag,"bsa":bsa},
                 "fyData":fyData})

art={"exhibit":"O-1","fy":2027,"unit":"thousands","source":"o1_fy2027","pes":rows}
json.dump(art,open(OUT,"w",encoding="utf-8"),ensure_ascii=False,indent=1)
codes=[r["peCode"] for r in rows]
print(f"O&M lines parsed: {len(rows)}  regex-invalid: {len(bad)} {bad[:5]}")
print(f"distinct peCodes: {len(set(codes))}  (dupes: {len(codes)-len(set(codes))})")
import collections
bysvc=collections.Counter(r["service"] for r in rows)
print("by service:", dict(bysvc))
for r in rows[:4]: print(f"  {r['peCode']:10} {r['title'][:38]:38} fy27req={[y for y in r['fyData'] if y['fy']==2027]}")
print("wrote",OUT)
