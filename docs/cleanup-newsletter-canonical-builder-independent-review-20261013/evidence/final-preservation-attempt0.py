from pathlib import Path
import hashlib,json,subprocess,re
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).parent
BASE='523ef9167f05a33efdbdfbbfc08d5fc2e2679012'
BUILDER='c26ae029e3c6319a265f735f687758b22093c401'
CORE='7ee13b8d26888a33377a29cf00637ca64b20bded'
ROOT_SOURCE='62bb7e6a9bf74961d0da6e9c5aa3f83225f4531c'
EDGE='bdcb6b4e02b6394fd24dbb709e17648d77caa88c'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def read(ref,p):return git('show',ref+':'+p)
def sha(b):return hashlib.sha256(b).hexdigest()
builder_paths=['scripts/build-newsletter-release.sh','scripts/lib/newsletter-artifact-packaging-plan.mjs','scripts/ci/newsletter-artifact-packaging-plan.spec.mjs','scripts/lib/frontend-standalone-artifact-contract.mjs','scripts/ci/frontend-artifact-docker.contract.spec.mjs']
root_paths=['.github/workflows/backend-cleanup-preservation.yml','scripts/ci/backend-retirement-source-jobs.contract.spec.py','scripts/ci/rebuild-verification-scopes.spec.mjs']
edge_paths=['scripts/lib/newsletter-declared-edge-contract.mjs','scripts/ci/newsletter-declared-edge.contract.spec.mjs']
rows=[]
for ref,paths in [(BUILDER,builder_paths),(ROOT_SOURCE,root_paths),(EDGE,edge_paths)]:
 for p in paths:
  b=read(ref,p);assert (ROOT/p).read_bytes()==b and read('HEAD',p)==b
  entry=git('ls-tree',ref,'--',p).decode().strip();assert git('ls-tree','HEAD','--',p).decode().strip()==entry
  rows.append({'path':p,'source':ref,'bytes':len(b),'sha256':sha(b),'gitEntry':entry})
owner='scripts/lib/frontend-standalone-artifact-contract.mjs'
b=read(BUILDER,owner)
for chunk in [b'/** Canonical relative path grammar only; no I/O or normalization. */\nexport function inspectFrontendStandalonePath(value) {\n  return safePath(value);\n}\n\n',b'/** Canonical declaration grammar only; no I/O or byte/runtime admission. */\nexport function inspectFrontendStandaloneManifest({ manifestBytes, pins }) {\n  return manifestContract(manifestBytes, pins).manifest;\n}\n\n']:
 assert b.count(chunk)==1;b=b.replace(chunk,b'')
assert b==read(BASE,owner)
shell='scripts/build-newsletter-release.sh';helper='scripts/lib/newsletter-artifact-packaging-plan.mjs'
assert read(BUILDER,shell).replace(b"usage='Usage: ",b"usage='")==read(CORE,shell)
h=read(BUILDER,helper)
assert h.startswith(b'/** @cleanup-smoke noArgsExit=2 helpExit=0 */\n')
h=h.removeprefix(b'/** @cleanup-smoke noArgsExit=2 helpExit=0 */\n')
h=h.replace(b"NEWSLETTER_BUILD_USAGE = 'Usage: ",b"NEWSLETTER_BUILD_USAGE = '")
h=h.replace(b'usage: NEWSLETTER_BUILD_USAGE, ',b'')
assert h==read(CORE,helper)
for p in builder_paths[2:]:assert read(BUILDER,p)==read(CORE,p)
scope='scripts/ci/rebuild-verification-scopes.spec.mjs';s=read(ROOT_SOURCE,scope)
start=s.index(b'// PR2435 added these four independently reviewed operators')
end=s.index(b'const webStart',start);s=s[:start]+s[end:]
chunk=b"  for (const [key, command] of Object.entries(phase26Aliases)) {\n    assert.equal(Object.hasOwn(originalPackage.scripts, key), false);\n    assert.equal(inverse.scripts[key], command, key);\n    delete inverse.scripts[key];\n  }\n"
assert s.count(chunk)==1;s=s.replace(chunk,b'')
start=s.index(b"test('only the four reviewed Phase26 aliases extend")
end=s.index(b"test('Phase1 scoped operands",start);s=s[:start]+s[end:]
assert s==read(BASE,scope)
published=json.loads(read('ed62dd1e67be152b6b760815f79bc475925659e7','package.json'))['scripts']
original_inverse=json.loads((HERE/'ROOT-SOURCE-INVERSE.json').read_bytes())
current=json.loads((ROOT/'package.json').read_bytes())['scripts']
for key,value in original_inverse['publishedFourCommandsExact'].items():assert published[key]==current[key]==value
workflow=root_paths[0];w=read(ROOT_SOURCE,workflow)
step=b'        {\n          "name": "Preserve current-source edge declarations and header refusal",\n          "run": "node --test scripts/ci/newsletter-declared-edge.contract.spec.mjs"\n        },\n'
assert w.count(step)==1;assert w.replace(step,b'')==read('56d565f8c698c526a05f822083ea616d09e81bb5',workflow)
py=root_paths[1];p=read(ROOT_SOURCE,py)
chunk=b'    ("Preserve current-source edge declarations and header refusal",\n     "node --test scripts/ci/newsletter-declared-edge.contract.spec.mjs"),\n'
assert p.count(chunk)==1;assert p.replace(chunk,b'')==read('56d565f8c698c526a05f822083ea616d09e81bb5',py)
docker=builder_paths[-1];d=read(BUILDER,docker).replace(BASE.encode(),b'0a76666dc57aa852586c35167426a540939c9918')
start=d.index(b'  // The current canonical builder only assembles')
end=d.index(b"  assert.match(read('apps/web/Dockerfile'),",start)
d=d[:start]+b"  // The receiving branch has no active legacy release operator. Do not restore it as a dependency.\n  assert.equal(existsSync(path.join(ROOT, 'scripts/build-newsletter-release.sh')), false);\n"+d[end:]
assert d==read(BASE,docker)
def tree(ref):
 result={}
 for line in git('ls-tree','-r',ref).splitlines():
  meta,p=line.split(b'\t',1);result[p.decode()]=meta.decode()
 return result
a,b=tree(BASE),tree('HEAD');changed=sorted(p for p in a.keys()|b.keys() if not p.startswith('docs/') and a.get(p)!=b.get(p))
assert changed==sorted(builder_paths+root_paths+edge_paths)
same_baseline=sum(a[p]==b.get(p) for p in a if not p.startswith('docs/') and p not in changed)
for name in ['credential-path-probe.mjs','injected-fs-probe.mjs','bounded-read-probe.mjs']:
 p='docs/cleanup-newsletter-canonical-builder-independent-review-20261013/evidence/'+name
 assert (ROOT/p).read_bytes()==read('fccc2c94918c2de22c5f8a1ca7eb72260a98c5da',p)
old_index=json.loads((HERE.parent/'SHA256-INITIAL-INDEX.json').read_bytes())
for row in old_index['entries']:
 path=HERE.parent/row['path'];data=path.read_bytes();assert sha(data)==row['sha256']
for name,expected in [('credential-path-probe-final.stdout',(8,0)),('injected-fs-probe-final.stdout',(2,0))]:
 r=json.loads((HERE/name).read_bytes());assert (r['pass'],r['red'])==expected
fd=json.loads((HERE/'bounded-read-probe-final.stdout').read_bytes());assert fd['pass'] and fd['readFileCalls']==0 and len(fd['boundedReads'])>0
for name in ['noargs','run-missing','unknown']:
 r=json.loads((HERE/('cli-'+name+'.stderr')).read_bytes());assert r['status']=='FAIL' and r['assemblyCompleted'] is False and r['shippingAuthorized'] is False and r['usage'].startswith('Usage:')
assert (HERE/'cli-help.stdout').read_text().startswith('Usage:')
receipt={'builderSource':BUILDER,'builderTree':git('rev-parse',BUILDER+'^{tree}').decode().strip(),'qualifiedCoreSource':CORE,'rootSource':ROOT_SOURCE,'edgeSource':EDGE,'checkedComposedHead':git('rev-parse','HEAD').decode().strip(),'sourceRows':rows,'nonDocSourcePaths':changed,'allOtherBaselineNonDocEntriesExact':same_baseline,'canonicalOwnerPrivateEntireBodyInverseExact':True,'tinyCLIChildInverseCoreExact':True,'defaultDockerSpecDeclaredAdaptationInverseExact':True,'rootScopeGuardThreeAdditiveHunksInverseEntireBaselineExact':True,'rootEdgeStepOnlyExactSixLineAddition':True,'fourPhase26AliasesMatchPublishedEd62':True,'originalFcccThreeProgramsByteExact':True,'initialIndexHashesUnchanged':len(old_index['entries']),'finalImmutablePrograms':{'credential':8,'customIO':2,'fdNoWholeRead':True},'CLIControls':4,'sourceInputsExecuted':False,'protectedReportingBodyRead':False,'deniedReportRead':False}
(HERE/'FINAL-PRESERVATION.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'sourcePaths':len(changed),'outsideNonDocExact':same_baseline,'initialHashesPreserved':len(old_index['entries']),'inverses':True,'immutableCorpusReplayed':True,'CLI4':True}))
