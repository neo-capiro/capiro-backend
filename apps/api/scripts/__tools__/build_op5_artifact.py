#!/usr/bin/env python3
"""Join OP-5 narrative records to the loaded O-1 lines -> loader artifact.

Join tiers (deterministic only):
  1. SERVICE volumes: (account-family via book map) + sagBli == record.sag  — exact.
  2. DW agency books: agency name <-> line title (normalized exact/prefix)   — exact.
Unmatched lines/records are REPORTED, never guessed.

Emits om_op5_fy2027.json: {fy, source, pes: [{peCode, description, op5Detail}]}
(description = the OP-5 narrative; op5Detail carries sag/book/pages for provenance).
"""
import json, glob, os, re, collections

OM = json.load(open('b2/om/om_fy2027.json', encoding='utf-8'))
# book -> accounts it covers
BOOK_ACCOUNTS = {
    'OMA_Vol1': ['2020A'], 'OMA_Vol2': ['2020A'], 'OMNG': ['2065A'], 'OMAR': ['2080A'],
    'OMN_Vol1': ['1804N'], 'OMMC': ['1106N'], 'OMNR': ['1806N'], 'OMMCR': ['1107N'],
    'OMAF_Vol1': ['3400F'], 'OMAF_Vol2': ['3400F'], 'OMANG': ['3410F'], 'OMAFR': ['3740F'],
    # 3840F (AF depot?) handled if a book covers it
}

def norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())

lines = OM['pes']
by_acct_sag = {}
by_acct_title = {}
for p in lines:
    by_acct_sag[(p['raw']['account'], (p['raw'].get('sagBli') or '').upper())] = p
    by_acct_title[(p['raw']['account'], norm(p['title']))] = p

dw_lines = [p for p in lines if p['service'] == 'DW']

# Curated DW book-stem -> O-1 line title (deterministic; covers DoW-era renames
# like DAU->'Warfighting Acquisition University' and the *_Cyber_* variants).
DW_BOOK_TITLE = {
    'DISA_OP-5': 'Defense Information Systems Agency',
    'DISA_Cyber_OP-5': 'Defense Information Systems Agency - CYBER',
    'DCAA_OP-5': 'Defense Contract Audit Agency',
    'DCAA_Cyber_OP-5': 'Defense Contract Audit Agency - CYBER',
    'DCMA_OP-5': 'Defense Contract Management Agency',
    'DCMA_Cyber_OP-5': 'Defense Contract Management Agency - CYBER',
    'DCSA_OP-5': 'Defense Counterintelligence and Security Agency',
    'DCSA_Cyber_OP-5': 'Defense Counterintelligence and Security Agency - CYBER',
    'DHRA_OP-5': 'Defense Human Resources Activity',
    'DHRA_Cyber_OP-5': 'Defense Human Resources Activity - CYBER',
    'DTRA_OP-5': 'Defense Threat Reduction Agency',
    'DTRA_Cyber_OP-5': 'Defense Threat Reduction Agency - CYBER',
    'DLA_OP-5': 'Defense Logistics Agency',
    'DLSA_OP-5': 'Defense Legal Services Agency',
    'DSCA_OP-5': 'Defense Security Cooperation Agency',
    'DTSA_OP-5': 'Defense Technology Security Administration',
    'DPAA_OP-5': 'Defense POW/MIA Office',
    'DAU_OP-5': 'Defense Acquisition University',
    'CMP_OP-5': 'Civil Military Programs',
    'TJS_OP-5': 'Joint Chiefs of Staff',
    'CYBERCOM_OP-5': 'USCYBERCOM Headquarters',
    'OSW_OP-5': 'Office of the Secretary of Defense',
    'OSW_Cyber_OP-5': 'Office of the Secretary of Defense - CYBER',
    'OSD_MISO_OP-5': 'Office of the Secretary of Defense - PSYOP',
    'DoWDE_OP-5': 'Department of Defense Education Activity',
    'DWIA_OP-5': 'Defense Media Activity',
    'OLDCC_OP-5': 'Office of the Local Defense Community Cooperation',
    'CAAF_OP-5': 'Us Court of Appeals for the Armed Forces, Defense',
    'WHS_OP-5': 'Washington Headquarters Services',
    'MDA_OP-5': 'Missile Defense Agency',
    'PSYOP_OP-5': 'Office of the Secretary of Defense - PSYOP',
    'SISC_OP-5': 'Support for International Sporting Competitions',
    'DHP_7A': 'In-House Care', 'DHP_7B': 'Private Sector Care',
    'DHP_7C': 'Consolidated Health Support', 'DHP_7D': 'Information Management',
    'DHP_7E': 'Management Activities', 'DHP_7F': 'Education and Training',
    'DHP_7G': 'Base Operations/Communications',
}
DHP_ACCOUNT = '0130D'

matched = {}   # peCode -> {narrative, sag, book, pageStart, pageEnd}
unmatched_records = []
for f in sorted(glob.glob('b10/out/*.json')) + sorted(glob.glob('b10/out_svc/*.json')):
    try:
        d = json.load(open(f, encoding='utf-8'))
    except Exception:
        continue
    book = d['book'].replace('dw_', '')
    stem = os.path.basename(f)[:-5]
    accounts = BOOK_ACCOUNTS.get(stem)
    for r in d['records']:
        hit = None
        if accounts and r.get('sag'):
            for acc in accounts:
                hit = by_acct_sag.get((acc, r['sag'].upper()))
                if hit:
                    break
        if hit is None and accounts and r.get('sagTitle'):
            for acc in accounts:
                hit = by_acct_title.get((acc, norm(r['sagTitle'])))
                if hit:
                    break
        if hit is None and not accounts and r.get('sag'):
            # DW books with SAG-coded exhibits (SOCOM, TJS) join 0100D by sagBli
            hit = by_acct_sag.get(('0100D', r['sag'].upper()))
        if hit is None and not accounts:
            # Tier A: curated book-stem -> title map (searches ALL O&M lines so
            # DHP sections land on 0130D and SISC on 0146D, not just 0100D)
            want = DW_BOOK_TITLE.get(stem)
            if want:
                cands = [p for p in lines if norm(p['title']) == norm(want)]
                if len(cands) == 1:
                    hit = cands[0]
        if hit is None and not accounts:
            # Tier B: agency name <-> line title (exact/prefix, unique)
            ag = norm(d.get('agency'))
            cands = [p for p in dw_lines if ag and (norm(p['title']) == ag or norm(p['title']).startswith(ag) or ag.startswith(norm(p['title'])))]
            if len(cands) == 1:
                hit = cands[0]
            elif len({c['peCode'] for c in cands}) == 1 and cands:
                hit = cands[0]
        if hit is None:
            unmatched_records.append({'book': stem, 'sag': r.get('sag'), 'agency': d.get('agency')})
            continue
        pe = hit['peCode']
        if pe in matched and len(matched[pe]['narrative']) >= len(r['narrative']):
            continue
        matched[pe] = {'narrative': r['narrative'], 'sag': r.get('sag'),
                       'book': stem, 'pageStart': r['pageStart'], 'pageEnd': r['pageEnd']}

art = {'fy': 2027, 'source': 'om_op5_fy2027', 'pes': [
    {'peCode': pe, 'description': m['narrative'],
     'op5Detail': {'sag': m['sag'], 'book': m['book'],
                   'pageStart': m['pageStart'], 'pageEnd': m['pageEnd']}}
    for pe, m in sorted(matched.items())]}
json.dump(art, open('b10/om_op5_fy2027.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

per_acct = collections.Counter()
for p in lines:
    per_acct[p['raw']['account']] += 0
for pe in matched:
    acct = pe[:5]
    per_acct[acct] += 1
print(f"matched {len(matched)}/{len(lines)} O&M lines | unmatched records: {len(unmatched_records)}")
print('coverage by account:')
tot_by_acct = collections.Counter(p['raw']['account'] for p in lines)
for a in sorted(tot_by_acct):
    print(f'  {a}: {per_acct.get(a,0)}/{tot_by_acct[a]}')
if unmatched_records[:6]:
    print('unmatched sample:', unmatched_records[:6])
