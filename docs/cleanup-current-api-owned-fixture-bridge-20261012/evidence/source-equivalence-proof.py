#!/usr/bin/env python3
"""Opaque Git source equality + exact input/literal/case proof. No API import/execution."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
BASE='5470c6df029c9553dd49e531229c3c91b26275ef'
SOURCE='133c868ea596cccb05525d1249ddf32c97fe1a54'
TREE='22b5cb735fda84bda5be9e7b2d10029d59fbca6a'
PUBLISHED_SEAM='8ac4c42cc49876ec19808369c0683956e0f2f474'
READER='apps/api/scripts/engagement-phase3-read-materialization.spec.ts'
FIXTURE='apps/api/scripts/__fixtures__/engagement-current-ui-surface-manifest.v1.json'
CONTROL='apps/api/scripts/engagement-phase3-owned-fixture.spec.mjs'
WEB='apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json'
checks=[]

def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def blob(ref,path):return git('show',f'{ref}:{path}')
def sha(value):return hashlib.sha256(value).hexdigest()
def tree(ref):return {row.split(b'\t',1)[1].decode():row.split(b'\t',1)[0].decode() for row in git('ls-tree','-rz',ref).split(b'\0') if row}
def check(name,valid,detail=None):checks.append({'name':name,'passed':bool(valid),'detail':detail})

base,current,admitted=tree(BASE),tree(SOURCE),tree(PUBLISHED_SEAM)
check('exact frozen source head/tree',git('rev-parse',SOURCE+'^{tree}').decode().strip()==TREE)
check('actual destination base ancestor',subprocess.run(['git','merge-base','--is-ancestor',BASE,SOURCE],cwd=ROOT).returncode==0)
delta=sorted(p for p in set(base)|set(current) if base.get(p)!=current.get(p))
check('only exact three authorized source/test/fixture paths differ',delta==sorted([READER,FIXTURE,CONTROL]),delta)
check('every baseline path outside three-path slice retains blob and mode',
      all(current.get(p)==base[p] for p in base if p not in delta),{'count':sum(p not in delta for p in base)})
check('original Web fixture and frontend tree remain unchanged',
      all(current.get(p)==base[p] for p in base if p.startswith('apps/web/')))
old=b"'../../web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json'"
new=b"'__fixtures__/engagement-current-ui-surface-manifest.v1.json'"
before=blob(BASE,READER);after=blob(SOURCE,READER)
check('actual current547 reader is the declared complete original',sha(before)=='e2a7d26bbc33bbd8140aba1194dca04990619ce28be159a1ac434e729fb7bcff',{'bytes':len(before),'sha256':sha(before)})
check('one literal only, all original reader bytes restored by inverse',
      before.count(old)==1 and after.count(new)==1 and old not in after and after.replace(new,old,1)==before)
cases=lambda raw:re.findall(rb"\btest\('([^']+)'",raw)
before_cases=cases(before);after_cases=cases(after)
check('all six ordered current case identities and bodies preserved',len(before_cases)==6 and after_cases==before_cases and after.replace(new,old,1)==before,[c.decode() for c in before_cases])
fixture=blob(SOURCE,FIXTURE);original=blob(BASE,WEB)
check('API-owned fixture exactly current547 data and mode',fixture==original and current[FIXTURE]==base[WEB])
check('fixture declared183851bytes/SHA256/Gitblob exact',
      len(fixture)==183851 and sha(fixture)=='39423247a62ae040d8dbc6c977597df2b0a58b338e74b70795d1c115c61b58ac' and
      current[FIXTURE]=='100644 blob 2f8a2cb0f733016078b2f9f54418f77962f1d069')
check('all three adopted paths match the independently published8ac seam blobs/modes',all(current[p]==admitted[p] for p in delta))
control=blob(SOURCE,CONTROL).decode()
imports=re.findall(r"^import .* from '([^']+)';",control,re.M)
check('owned control imports only six Node builtin modules and no application graph',
      len(imports)==6 and all(m.startswith('node:') for m in imports) and 'import(' not in control and 'require(' not in control,imports)
check('published four permanent controls include byte/path/body/name refusals',
      len(re.findall(r"\btest\('",control))==4 and all(x in control for x in [
          'assertOwnedFixture(altered)','__fixtures__/missing.json','toBeGreaterThanOrEqual(1)','removed mail-thread ownership case']))
output={'source':SOURCE,'tree':TREE,'base':BASE,'publishedSeam':PUBLISHED_SEAM,'checks':checks,'passed':all(c['passed'] for c in checks),
        'sourceBindings':[{'path':p,'git':current[p],'sha256':sha(blob(SOURCE,p)),'bytes':len(blob(SOURCE,p))} for p in delta],
        'qualification':'Six API/Jest cases are preserved by complete inverse byte proof, not executed. Only four standalone Node source/input controls were executed separately. No application/native/provider/SQL/CLI graph.'}
print(json.dumps(output,indent=2));raise SystemExit(0 if output['passed'] else 1)
