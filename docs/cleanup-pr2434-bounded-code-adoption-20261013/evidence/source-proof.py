from pathlib import Path
import hashlib, json, subprocess
BASE='ed62dd1e67be152b6b760815f79bc475925659e7'
SOURCE='b051e32392cfd18b1bfd4a159c500ae8c3ac0680'
ROOT=Path(__file__).resolve().parents[3]
PACKET=Path(__file__).resolve().parent

def git(*args): return subprocess.check_output(['git',*args],cwd=ROOT)
def tree(ref):
 out={}
 for row in git('ls-tree','-r','-z',ref).split(b'\0'):
  if not row:continue
  meta,path=row.split(b'\t',1);mode,kind,oid=meta.decode().split();out[path.decode()]={'mode':mode,'kind':kind,'blob':oid}
 return out
before,after=tree(BASE),tree(SOURCE)
changed=sorted(p for p in before.keys()|after.keys() if before.get(p)!=after.get(p))
assert len(changed)==131
portraits=[p for p in changed if p.startswith('apps/api/data/florida-legislative-directory/portraits/')]
assert len(portraits)==118
code=[p for p in changed if p not in portraits]
assert code==sorted([
 'apps/api/Dockerfile','apps/api/scripts/ingest-florida-legislative-directories.ts',
 'apps/defense-api/Dockerfile','apps/defense-api/pnpm-workspace.build.yaml',
 'apps/web/src/vnext/pages/client-crm/VNextClientPicker.tsx',
 'apps/web/src/vnext/pages/client-crm/client-crm-entry.test.tsx',
 'scripts/ci/defense-backend-workspace.contract.spec.mjs',
 'scripts/ci/engagement-resilience-recovery.contract.spec.mjs',
 'scripts/ci/florida-owned-portrait-release.spec.mjs',
 'scripts/engagement-phase3-resilience-contract.mjs','scripts/engagement-phase3-resilience.mjs',
 'scripts/run-engagement-phase3-resilience.mjs','scripts/verify-engagement-phase3-local-evidence.mjs'])
unchanged=[p for p in before if p not in changed]
assert all(before[p]==after[p] for p in unchanged)
working_changes=git('diff','--name-only',SOURCE,'--').decode().splitlines()
assert all(p.startswith('docs/cleanup-pr2434-bounded-code-adoption-20261013/') for p in working_changes), working_changes
rows=[]
for p in changed:
 if p in after:
  data=(ROOT/p).read_bytes();oid=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest();assert oid==after[p]['blob']
  rows.append({'path':p,'before':before.get(p),'after':after[p],'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
 else:
  assert not (ROOT/p).exists();rows.append({'path':p,'before':before[p],'after':None})
for p in portraits:
 web=p.replace('apps/api/data/florida-legislative-directory/portraits/','apps/web/public/florida-directory/portraits/')
 assert before[web]==after[web]==after[p]
# No protected reporting source body is read: full-tree equality uses only Git entry metadata.
protected={
 'priorDocs':[p for p in unchanged if p.startswith('docs/')],
 'schemasMigrations':[p for p in unchanged if p.endswith('schema.prisma') or '/migrations/' in p],
 'workflows':[p for p in unchanged if p.startswith('.github/workflows/')],
 'windows':[p for p in unchanged if p.endswith(('.ps1','.cmd','.bat'))],
 'shared':[p for p in unchanged if p.startswith('packages/shared/')],
 'phase26':[p for p in unchanged if p in ['scripts/check-context-plane-new-bypasses.mjs','scripts/validate-knowledge-plane-phase26.mjs'] or p.startswith('scripts/lib/') and ('context-plane' in p or 'knowledge-' in p)],
}
held=[
 '.github/workflows/backend-cleanup-ci-contracts.yml','.github/workflows/backend-cleanup-preservation.yml',
 'scripts/ci/backend-retirement-source-jobs.contract.spec.py','scripts/ci/engagement-local-owned-inputs.spec.mjs',
 'scripts/ci/engagement-resilience-native-ports.mjs','scripts/ci/engagement-resilience-scope.spec.mjs',
 'scripts/engagement-phase3-backend-inputs.mjs','scripts/engagement-phase3-backend-inputs.spec.mjs',
 'scripts/engagement-phase3-main-route-accounting.mjs','scripts/engagement-phase3-main-route-accounting.spec.mjs',
 'scripts/engagement-phase3-resilience-policy.mjs']
assert all(before.get(p)==after.get(p) for p in held)
assert before['package.json']==after['package.json']
result={'base':BASE,'baseTree':git('rev-parse',BASE+'^{tree}').decode().strip(),'source':SOURCE,'sourceTree':git('rev-parse',SOURCE+'^{tree}').decode().strip(),'changed':rows,'unchangedBaselineEntries':len(unchanged),'protectedCounts':{k:len(v) for k,v in protected.items()},'protectedMetadataSha256':{k:hashlib.sha256(json.dumps({p:before[p] for p in paths},sort_keys=True,separators=(',',':')).encode()).hexdigest() for k,paths in protected.items()},'packageByteExact':True,'all118WebOriginalsRetained':True,'currentWorkingSourceExact':True,'heldSourceMetadata':{p:before.get(p) for p in held},'protectedReportingBodyRead':False,'proofMethod':'unchanged paths compare Git path/mode/blob only; only131 authorized changed paths read physically; no report contents'}
(PACKET/'SOURCE-PROOF.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'changed':len(rows),'codeConfigTests':len(code),'exactPortraitCopies':len(portraits),'unchangedBaselineEntries':len(unchanged),'protectedCounts':result['protectedCounts'],'workingSourceExact':True}))
