from pathlib import Path
import subprocess,json,hashlib,re
ROOT=Path(__file__).resolve().parents[3];HERE=Path(__file__).parent
SOURCE='07e92408d9c396de2003259d125f828cc99c7e2c';PARENT='4864eb57ca4a7ef519c43ef47b270cad310ed737';LEFT='457e84e7d50f401985355cf22eedc480fd72ad8b';RIGHT='9db4e1cd5589a05e08fb88caa38a4ac44937def5';BASE='b7aa1d6e6b341f833fa08b2add8f40d5fbee8480'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def read(ref,p):return git('show',ref+':'+p)
def sha(b):return hashlib.sha256(b).hexdigest()
def tree(ref):
 result={}
 for line in git('ls-tree','-r',ref).splitlines():
  meta,p=line.split(b'\t',1);result[p.decode()]=meta.decode()
 return result
for ref in [LEFT,RIGHT]:assert subprocess.call(['git','merge-base','--is-ancestor',ref,SOURCE],cwd=ROOT)==0
root=tree(SOURCE);combined=tree(PARENT);a=tree(LEFT);b=tree(RIGHT);base=tree(BASE)
for p in base.keys()|a.keys()|b.keys():
 old=base.get(p);lp=a.get(p);rp=b.get(p)
 assert not (lp!=old and rp!=old and lp!=rp),p
 expected=lp if lp!=old else rp
 assert combined.get(p)==expected,p
paths=git('diff','--name-only',PARENT,SOURCE).decode().splitlines();assert len(paths)==6
guard_paths=['scripts/ci/frontend-artifact-docker.contract.spec.mjs','scripts/ci/rebuild-verification-scopes.spec.mjs','scripts/ci/context-plane-validation-scope.spec.mjs','scripts/ci/backend-retirement-source-jobs.contract.spec.py']
changes={
 guard_paths[0]:[(b"import { restoreReviewedPeManifest } from '../lib/reviewed-pe-manifest-contract.mjs';\n",b''),(b"assert.equal(file === 'package.json' ? restoreReviewedPeManifest(read(file), 'root') : read(file), before, file);",b'assert.equal(read(file), before, file);')],
 guard_paths[1]:[(b"import { restoreReviewedPeManifest } from '../lib/reviewed-pe-manifest-contract.mjs';\n",b''),(b"JSON.parse(restoreReviewedPeManifest(current('package.json'), 'root'))",b"JSON.parse(current('package.json'))")],
 guard_paths[2]:[(b"import { restoreReviewedPeManifest } from '../lib/reviewed-pe-manifest-contract.mjs';\n",b''),(b"JSON.parse(restoreReviewedPeManifest(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), 'root'))",b"JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))")],
}
inverse=[]
for p,mappings in changes.items():
 raw=read(SOURCE,p);result=raw
 for before,after in mappings:assert result.count(before)==1;result=result.replace(before,after)
 assert result==read(RIGHT,p);inverse.append({'path':p,'wholePriorFileInverseExact':True,'priorSha256':sha(result)})
py=guard_paths[3];data=read(SOURCE,py);data=data.replace(b'"package.json", "apps/api/package.json",',b'"package.json",')
start=data.index(b'            current = (ROOT / file).read_bytes()');end=data.index(b'\n',data.index(b'            with self.subTest(file=file): self.assertEqual(current, before)',start))
data=data[:start]+b'            with self.subTest(file=file): self.assertEqual((ROOT / file).read_bytes(), before)'+data[end:]
assert data==read(RIGHT,py);inverse.append({'path':py,'wholePriorFileInverseExact':True,'priorSha256':sha(data),'APIManifestAddedToExistingDefaultsProof':True})
for p in paths:assert (ROOT/p).read_bytes()==read(SOURCE,p)
bindings=[]
for p in ['package.json','apps/api/package.json']:
 current=read(SOURCE,p);assert current==read(LEFT,p)
 bindings.append({'path':p,'peerSource':LEFT,'currentSha256':sha(current),'beforeSource':BASE,'beforeSha256':sha(read(BASE,p)),'metadataEntry':root[p]})
owners=['pe-phase-9-rehearsal-catalog.ts','pe-phase-9-backend-scope.ts','pe-phase-9-rehearsal.ts','pe-phase-9-runner.ts','pe-phase-9-evidence.ts','pe-phase-9-runner.test-support.ts']
for p in ['apps/api/scripts/verify-pe-phase-9.ts','apps/api/tsconfig.pe-scripts.json','apps/api/scripts/lib/pe-production-scripts.ts']+['apps/api/scripts/lib/'+x for x in owners]:assert read(SOURCE,p)==read(LEFT,p)
source_paths=sorted(p for p in base.keys()|root.keys() if not p.startswith('docs/') and base.get(p)!=root.get(p));assert len(source_paths)==24
for p in combined.keys()|root.keys():
 if p not in paths:assert combined.get(p)==root.get(p),p
result={'source':SOURCE,'sourceTree':'272095401f57eb7dccb88bafbbe332fc31f93f2d','exactPeerAncestors':[LEFT,RIGHT],'merge':PARENT,'mergeSourceUnionExact':True,'guardSixPaths':paths,'fourWholeFileInverses':inverse,'rootAndAPIManifestBindings':bindings,'allCurrentEntrypointAndSixPureOwnersExactPR2444':True,'nonDoc24PathsBeyondCommonB7':source_paths,'outsideSixIntegratedGuardPathsExact':len(combined)-4,'protectedReportingBodyRead':False,'deniedReportRead':False,'realEntrypointOrProviderOrNativeExecution':False}
(HERE/'GUARD-PRESERVATION.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'peerUnionExact':True,'peerAncestors':2,'guardPaths':6,'wholePriorFileInverses':4,'currentCLIClosureExact':True,'nonDoc24':True}))
