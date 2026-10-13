from pathlib import Path
import hashlib,json,re,subprocess

ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).parent
SOURCE='e33fe1af359defbe52a9a63089f05bf7a757344f'
LEFT='457e84e7d50f401985355cf22eedc480fd72ad8b'
RIGHT='9db4e1cd5589a05e08fb88caa38a4ac44937def5'
BASE='b7aa1d6e6b341f833fa08b2add8f40d5fbee8480'
GUARDS='07e92408d9c396de2003259d125f828cc99c7e2c'
HYGIENE='43c14e3b5bde8eb76371394a50abbd718556382e'
PROFILE='358d953a42129a19ba82fdd8373c86c9a455f49a'
OLD_PROFILE='f18f918a8103e8e3cb36e47c65d2f6651cb1fd7b'
AUTHOR='3e0775382f01b46e5a52f1a16ef8a9031facdd27'

def git(*args): return subprocess.check_output(['git',*args],cwd=ROOT)
def read(ref,p): return git('show',ref+':'+p)
def sha(b): return hashlib.sha256(b).hexdigest()
def tree(ref):
    result={}
    for row in git('ls-tree','-rz',ref).split(b'\0'):
        if row:
            meta,p=row.split(b'\t',1);result[p.decode()]=meta.decode()
    return result
def names(b): return re.findall(rb"test\('([^']+)'",b)
def inverse(data,operations):
    for old,new in operations:
        assert data.count(old)==1,old
        data=data.replace(old,new)
    return data

for ref in [LEFT,RIGHT,GUARDS,HYGIENE,PROFILE]:
    assert subprocess.call(['git','merge-base','--is-ancestor',ref,SOURCE],cwd=ROOT)==0,ref
current=tree(SOURCE);base=tree(BASE);review=tree('HEAD')
assert {p:v for p,v in current.items() if not p.startswith('docs/')}=={p:v for p,v in review.items() if not p.startswith('docs/')}
delta=sorted(p for p in base.keys()|current.keys() if not p.startswith('docs/') and base.get(p)!=current.get(p))
assert len(delta)==29
bindings=[]
for p in delta:
    bindings.append({'path':p,'entry':current[p],'sha256':sha(read(SOURCE,p))})
for p in ['package.json','apps/api/package.json','apps/api/scripts/verify-pe-phase-9.ts','apps/api/tsconfig.pe-scripts.json','apps/api/scripts/lib/pe-production-scripts.ts',
          *['apps/api/scripts/lib/'+x for x in ['pe-phase-9-rehearsal-catalog.ts','pe-phase-9-backend-scope.ts','pe-phase-9-rehearsal.ts','pe-phase-9-runner.ts','pe-phase-9-evidence.ts','pe-phase-9-runner.test-support.ts']]]:
    assert current[p]==tree(LEFT)[p],p
for p in ['pnpm-lock.yaml','pnpm-workspace.yaml','.github/workflows/ci-pr.yml','apps/web/Dockerfile','apps/onboard-api/Dockerfile']:
    assert current[p]==base[p],p

for p in ['scripts/lib/reviewed-pe-manifest-contract.mjs','scripts/ci/reviewed-pe-manifest-contract.spec.mjs','scripts/ci/context-plane-validation-scope.spec.mjs','scripts/ci/rebuild-verification-scopes.spec.mjs']:
    assert read(SOURCE,p)==read(GUARDS,p),p
for p in ['scripts/lib/reviewed-source-hygiene.mjs','scripts/ci/reviewed-source-hygiene.spec.mjs']:
    assert read(SOURCE,p)==read(HYGIENE,p),p
for p in ['scripts/lib/frontend-standalone-artifact-contract.mjs','scripts/lib/newsletter-artifact-packaging-plan.mjs','scripts/lib/newsletter-accepted-source-profile.json','scripts/ci/newsletter-artifact-packaging-plan.spec.mjs','scripts/ci/newsletter-accepted-source-profile.spec.mjs']:
    assert read(SOURCE,p)==read(PROFILE,p),p
    assert (ROOT/p).read_bytes()==read(SOURCE,p),p
for p in ['scripts/lib/newsletter-artifact-packaging-plan.mjs','scripts/lib/newsletter-accepted-source-profile.json','scripts/ci/newsletter-artifact-packaging-plan.spec.mjs','scripts/ci/frontend-standalone-artifact.contract.spec.mjs']:
    assert read(SOURCE,p)==read(OLD_PROFILE,p),p
assert names(read(OLD_PROFILE,'scripts/ci/newsletter-accepted-source-profile.spec.mjs'))==[n for n in names(read(SOURCE,'scripts/ci/newsletter-accepted-source-profile.spec.mjs')) if not n.startswith(b'architecture elements')]
assert len(names(read(SOURCE,'scripts/ci/newsletter-accepted-source-profile.spec.mjs')))==19
profile=json.loads(read(SOURCE,'scripts/lib/newsletter-accepted-source-profile.json'))
assert profile['activeCommit'] is None and profile['acceptedSources']==[]

# General artifact verifier body is preserved; only the explicit shipping CLI
# switches to the admission wrapper, and the source-profile owner is additive.
p='scripts/lib/frontend-standalone-artifact-contract.mjs'
raw=read(SOURCE,p)
raw=inverse(raw,[(b"import { types as utilTypes } from 'node:util';\n",b''),(b"import acceptedSourceProfile from './newsletter-accepted-source-profile.json' with { type: 'json' };\n",b'')])
start=raw.index(b'function policyData(');end=raw.index(b'/** All regular buffers',start)
raw=raw[:start]+raw[end:]
raw=inverse(raw,[(b'const receipt = await readAcceptedFrontendStandaloneArtifact({ ...options, ports: {',b'const receipt = await readFrontendStandaloneArtifact({ ...options, ports: {')])
assert raw==read(RIGHT,p)

docker='apps/web/Dockerfile.frontend-artifact';raw=read(SOURCE,docker)
raw=inverse(raw,[(b"# Runtime profile follows the reviewed source policy's pinned Node24.21 Alpine profile.",b'# Runtime profile mirrors frontend source 7c87678730538958ace9762f824dc3e588bf445b.'),
                (b'COPY scripts/lib/newsletter-accepted-source-profile.json scripts/lib/newsletter-accepted-source-profile.json\n',b'')])
assert raw==read(RIGHT,docker)

workflow='.github/workflows/backend-cleanup-preservation.yml'
before=json.loads(read(RIGHT,workflow));after=json.loads(read(SOURCE,workflow))
assert {k:v for k,v in before.items() if k!='jobs'}=={k:v for k,v in after.items() if k!='jobs'}
job=after['jobs']['artifact-source-contracts'];old=before['jobs']['artifact-source-contracts']
assert {k:v for k,v in job.items() if k!='steps'}=={k:v for k,v in old.items() if k!='steps'}
extra={'Check exact reviewed manifest changes and raw archive classification','Check source and normal documentation whitespace with immutable raw observations classified'}
steps=[dict(x) for x in job['steps'] if x.get('name') not in extra]
for x in steps:
    if x.get('name')=='Exercise standalone assembly and Docker consumer refusals':
        assert x['run'].endswith(' scripts/ci/newsletter-accepted-source-profile.spec.mjs')
        x['run']=x['run'].removesuffix(' scripts/ci/newsletter-accepted-source-profile.spec.mjs')
assert steps==old['steps']
assert len(job['steps'])==len(old['steps'])+2

index='docs/cleanup-newsletter-accepted-source-admission-20261013/ARCHITECTURE-REPAIR-INDEX.json'
author_index=json.loads(read(AUTHOR,index));rows=author_index.get('files',author_index.get('entries'))
assert rows is not None
for row in rows:
    data=read(AUTHOR,row['path'])
    assert len(data)==row['bytes'] and sha(data)==row['sha256'],row['path']
initial=json.loads((HERE.parent/'SHA256-INITIAL-INDEX.json').read_text())
hold=json.loads((HERE.parent/'SHA256-HOLD-INDEX.json').read_text())
for row in [*initial['entries'],*hold['entries']]:
    data=(HERE.parent/row['path']).read_bytes()
    assert len(data)==row['bytes'] and sha(data)==row['sha256'],row['path']
outside=[p for p in base if p not in delta and not p.startswith('docs/')]
assert all(base[p]==current.get(p) for p in outside)
result={'source':SOURCE,'sourceTree':'8cd2dc87a0ea2348ce172bb483f4494a6b3e0cdb','peerAncestors':[LEFT,RIGHT],
        'nonDocDelta29':bindings,'outsideNonDocEntriesExact':len(outside),'allReviewNonDocEntriesExactSource':True,
        'peManifestsEntrypointsAndSixPureOwnersExactPeer':True,'generalArtifactVerifierWholeFileInverseExact':True,
        'dockerWholePriorFileInverseExact':True,'allPriorWorkflowStepObjectsExactAfterTwoAddedStepsAndProfileOperandInverse':True,
        'all18ProfileCaseIdentitiesRetained':True,'profile19OnlyOneNewCase':True,'profilePendingNoAcceptedSources':True,
        'packaging32AndGeneral50SourceExactPreviouslyQualified':True,'authorRepairHashesVerified':len(rows),
        'initial32AndHold58HashesVerified':True,'protectedBodyOrDeniedReportRead':False,
        'actualInstallReceiptBytesExamined':False,'nativeOrActualFrontendArtifactAdmission':False}
(HERE/'FINAL-PRESERVATION.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['nonDocDelta29']}))
