from pathlib import Path
import subprocess,json,hashlib,re
ROOT=Path(__file__).resolve().parents[3];HERE=Path(__file__).parent
SOURCE='ce14fb20b60426fe465ae8ad3eb33f2d23cd7bbc'
BASE='60cf2e51129f8358e6afe5fc600ffcdb6de01759'
DONOR='e25b2c9ad93ae8d63ffb5332c41d7af1623d4400'
NATIVE_REVIEW='962d30b692502d6ea56b064b35352665a6204732'
AUTHOR='815fe7851257c6d546038a13da89104a164620f7'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def read(ref,p):return git('show',ref+':'+p)
def sha(b):return hashlib.sha256(b).hexdigest()
def tree(ref):
    out={}
    for row in git('ls-tree','-rz',ref).split(b'\0'):
        if row:
            meta,p=row.split(b'\t',1);out[p.decode()]=meta.decode()
    return out
before=tree(BASE);after=tree(SOURCE);donor=tree(DONOR);current=tree('HEAD')
for ref in [BASE,DONOR,NATIVE_REVIEW]:assert subprocess.call(['git','merge-base','--is-ancestor',ref,SOURCE],cwd=ROOT)==0,ref
assert {p:v for p,v in after.items() if not p.startswith('docs/')}=={p:v for p,v in current.items() if not p.startswith('docs/')}
delta=sorted(p for p in before.keys()|after.keys() if not p.startswith('docs/') and before.get(p)!=after.get(p));assert len(delta)==11
guard=['.github/workflows/backend-cleanup-preservation.yml','scripts/ci/backend-retirement-source-jobs.contract.spec.py',
       'scripts/ci/reviewed-pe-manifest-contract.spec.mjs','scripts/lib/reviewed-pe-manifest-contract.mjs']
native=['apps/api/package.json','apps/api/scripts/lib/pe-phase-9-migration-discovery.mjs',
        'apps/api/scripts/lib/pe-phase-9-migration-discovery.spec.mjs','apps/api/scripts/lib/pe-phase-9-owned-postgres.sh',
        'apps/api/scripts/lib/pe-phase-9-owned-postgres.spec.mjs','apps/api/scripts/lib/pe-production-scripts.ts',
        'apps/api/scripts/pe-phase-9-migration-replay.sh']
assert delta==sorted(guard+native)
for p in native+['docs/runbooks/program-elements-trust-gates.md']:assert after[p]==donor[p],p
for p in before.keys()|after.keys():
    if not p.startswith('docs/') and p not in delta:assert before.get(p)==after.get(p),p
root=read(SOURCE,'package.json');assert root==read(BASE,'package.json')
api=read(SOURCE,'apps/api/package.json');assert sha(api)=='cf3d355d8d8595f52cae8bb6e1ae0142be545f316e74c68f4907bc012515aa9a'
declaration=b'    "test:pe-phase-9-migration-discovery": "node --test scripts/lib/pe-phase-9-migration-discovery.spec.mjs scripts/lib/pe-phase-9-owned-postgres.spec.mjs",\n'
prefix=b'pnpm run test:pe-phase-9-migration-discovery && '
restored=api
for token in [declaration,prefix]:assert restored.count(token)==1;restored=restored.replace(token,b'')
assert restored==read(BASE,'apps/api/package.json')
old=json.loads(restored);new=json.loads(api)
for k,v in old.items():
    if k!='scripts':assert new[k]==v,k
for k,v in old['scripts'].items():assert new['scripts'][k]==(prefix.decode()+v if k=='test:pe-trust' else v),k
assert set(new['scripts'])-set(old['scripts'])=={'test:pe-phase-9-migration-discovery'}
# The existing implementation body stays exact. Only one API after-hash, two
# exact literal operands, one exported source pin and its comment are added.
helper='scripts/lib/reviewed-pe-manifest-contract.mjs';b=read(SOURCE,helper)
for x,y in [(b'// Exact PR2444/PR2446 declaration inverse',b'// Exact PR2444 declaration inverse'),
            (b"export const REVIEWED_PE_API_MANIFEST_SOURCE = 'e25b2c9ad93ae8d63ffb5332c41d7af1623d4400';\n",b''),
            (b'cf3d355d8d8595f52cae8bb6e1ae0142be545f316e74c68f4907bc012515aa9a',b'58821f6b9f73558fe481816f5ea761a87024c22caf6623e7630e6035aa322cfa'),
            (b'      \'    "test:pe-phase-9-migration-discovery": "node --test scripts/lib/pe-phase-9-migration-discovery.spec.mjs scripts/lib/pe-phase-9-owned-postgres.spec.mjs",\\n\',\n',b''),
            (b"      'pnpm run test:pe-phase-9-migration-discovery && ',\n",b'')]:
    assert b.count(x)==1,x;b=b.replace(x,y)
assert b==read(BASE,helper)
workflow='.github/workflows/backend-cleanup-preservation.yml'
w=json.loads(read(SOURCE,workflow));prior=json.loads(read(BASE,workflow))
steps=w['jobs']['artifact-source-contracts']['steps'];name='Exercise owned migration discovery and inert Docker fixture controls'
added=[s for s in steps if s.get('name')==name];assert len(added)==1
assert added[0]['run']=='node --test apps/api/scripts/lib/pe-phase-9-migration-discovery.spec.mjs apps/api/scripts/lib/pe-phase-9-owned-postgres.spec.mjs'
w['jobs']['artifact-source-contracts']['steps']=[s for s in steps if s.get('name')!=name];assert w==prior
py='scripts/ci/backend-retirement-source-jobs.contract.spec.py';b=read(SOURCE,py)
added_py=b'    ("Exercise owned migration discovery and inert Docker fixture controls",\n     "node --test apps/api/scripts/lib/pe-phase-9-migration-discovery.spec.mjs apps/api/scripts/lib/pe-phase-9-owned-postgres.spec.mjs"),\n'
assert b.count(added_py)==1 and b.replace(added_py,b'')==read(BASE,py)
def case_names(text):return re.findall(r'^\s*[✔✖]\s(.+)\s\([\d.]+ms\)$',text,re.M)
old_names=case_names((ROOT/'docs/cleanup-peer-manifests-integration-independent-review-20261013/evidence/manifest.stdout').read_text())
new_names=case_names((HERE/'manifest-permanent.stdout').read_text());assert len(new_names)==5
assert len(old_names)==5 and new_names==old_names
index=json.loads(read(NATIVE_REVIEW,'docs/pe2446-composition-independent-review-20261013/SHA256-INDEX.json'))
counts={}
for key,ref in [('sourceBindings',DONOR),('files',NATIVE_REVIEW)]:
    rows=index[key];counts[key]=len(rows)
    for row in rows:
        b=read(ref,row['path']);assert len(b)==row['bytes'] and sha(b)==row['sha256'],row['path']
        if 'gitBlob' in row:assert git('rev-parse',ref+':'+row['path']).decode().strip()==row['gitBlob']
schema=[p for p in before if p.endswith(('.sql','.prisma')) and not p.startswith('docs/')]
assert all(before[p]==after.get(p) for p in schema)
assert after['scripts/lib/newsletter-accepted-source-profile.json']==before['scripts/lib/newsletter-accepted-source-profile.json']
root_observation=json.loads(read(AUTHOR,'docs/native-replay-reviewed-composition-20261013/OWNER-REPORTED-QUALIFICATION.json'))
assert not root_observation['rawFilesReceivedOrHashVerified'] and not root_observation['receivingHeadWholeBackendOrNativeAcceptance']
assert root_observation['qualifiedHead']==DONOR
result={'source':SOURCE,'tree':'e216f3c2f1c588d8f8360216454d3f5b56b0f875','base':BASE,'nativeDonor':DONOR,
        'actualAncestors':[BASE,DONOR,NATIVE_REVIEW],'nativeEightPathsIncludingRunbookExactPublishedDonor':True,
        'receivingFourPaths':guard,'nonDocDelta11':delta,'outsideNonDocExact':len([p for p in before if not p.startswith('docs/') and p not in delta]),
        'apiFullPriorByteInverseWithOnlyNativeDeclarationAndPrefix':True,'helperWholePriorBodyInverseExact':True,
        'rootManifestAndAllOtherMetadataDependenciesDefaultFullCommandsUnchanged':True,
        'workflowEntirePriorDocumentInverseExactOneStepOnly':True,'pythonEntirePriorDocumentInverseExactOneTupleOnly':True,
        'fiveOriginalManifestCaseIdentities':new_names,'nativeSourceReviewHashBindingsVerified':counts,
        'schemaAndSqlMetadataEntriesUnchanged':len(schema),'c8PolicyAndMeriAuthoritySourceUnchangedFromBase':True,
        'ownerReportedQualificationScopedToE25Only':True,'rawNativeReceiptVerified':False,'currentHeadNativeOrWholeOperatorAccepted':False,
        'protectedReportingBodyRead':False,'actualNativeOrDockerOrOperatorInstallExecutionByReviewer':False}
(HERE/'COMPOSITION-PROOF.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['fiveOriginalManifestCaseIdentities','nonDocDelta11','receivingFourPaths']}))
