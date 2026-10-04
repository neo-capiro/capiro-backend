from pathlib import Path
import hashlib,json,subprocess
r=Path('C:/dev/main/meri-c1-20261002')
out=Path(__file__).resolve().parent
src=out/'case12-eligibility-supervised-v2/scratch'
paths=['apps/api/src/retrieval/adapters/governed-memory-eligibility.helpers.ts',
 'apps/api/src/retrieval/adapters/governed-memory-eligibility.helpers.spec.ts',
 'apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts',
 'apps/api/src/retrieval/adapters/case12-memory-eligibility.read.ts',
 'evals/meri/live-v1/fixture-provisioning/case12-memory-eligibility-owner.mjs']
rows=[]
for rel in paths:
 p=r/rel
 data=(src/rel).read_bytes()
 prior=p.read_bytes() if p.exists() else None
 if prior is not None:
  expected=subprocess.check_output(['git','show','HEAD:'+rel],cwd=r)
  assert prior.replace(b'\r\n',b'\n')==expected.replace(b'\r\n',b'\n'),rel
 p.parent.mkdir(parents=True,exist_ok=True)
 p.write_bytes(data)
 rows.append({'path':rel,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),
   'priorSha256':hashlib.sha256(prior).hexdigest() if prior else None})
v={'kind':'lead-case12-reviewed-candidate-integration','base':'015514e894945a75c9a10ba2a55b2986c5cb3cd6',
 'independentFinalReview':'PENDING','sourceFiles':rows}
with (out/'case12-source-integration-v2.json').open('x',encoding='utf-8') as f:json.dump(v,f,indent=2);f.write('\n')
print(json.dumps({'integratedFiles':len(rows),'finalReview':'PENDING'}))
