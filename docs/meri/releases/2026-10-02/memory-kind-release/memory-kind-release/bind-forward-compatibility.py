"""Local-only binding of actual Git, build and rehearsal receipts; no network."""
import datetime, hashlib, json, pathlib, subprocess

ROOT=pathlib.Path(__file__).resolve().parent
REPAIR=ROOT.parent/'oct02-memory-kind-repair'
REPO=pathlib.Path(r'C:\dev\cap-meri-outcomes-validation')
SOURCE='42988dae5fb7bc2fff3af582ca15a0836a4477c5'
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def evidence(p):return {'path':str(p),'sha256':sha(p.read_bytes())}
def git(*args):return subprocess.check_output(['git','-C',str(REPO),*args])

assert git('rev-parse','HEAD').decode().strip()==SOURCE
assert git('rev-parse','origin/main').decode().strip()==SOURCE
assert not git('status','--porcelain=v1','--untracked-files=all').strip()
prior=REPAIR/'forward-compatibility-assessment.json';bridge=read(prior)
assert sha(prior.read_bytes())=='a53137bdea7c03545c57b866f6ee5983ef7a3758381f0c0d339f157261faf335'
assert bridge['rehearsedCombinedSource']==SOURCE and bridge['schemaChange'] is True
qpath=ROOT/'combined-source-qualification.json';q=read(qpath)
assert q['status']=='PASS' and q['sourceSha']==SOURCE and q['schemaChange'] is True
for path,h in q['sourceBlobs'].items():assert sha(git('show',SOURCE+':'+path))==h,path
for check in q['checks']:
    assert check['exitCode']==0 and check['sourceSha']==SOURCE and check['sourceUnchanged'] is True
    assert sha((ROOT/(check['name']+'.exit.json')).read_bytes())==check['receiptSha256']
    assert sha((ROOT/(check['name']+'.log')).read_bytes())==check['logSha256']
for joined in q['joinedQualifications']:
    assert sha(pathlib.Path(joined['path']).read_bytes())==joined['sha256']
for rehearsal in bridge['rehearsals']:
    for key in ['receipt','log']:
        e=rehearsal[key];assert sha(pathlib.Path(e['path']).read_bytes())==e['sha256']

request=read(ROOT/'reviewed-build-input.json');assert request['sourceSha']==SOURCE
images={}
for name in ['api','meriv2-orchestrator']:
    path=ROOT/(name+'-build-readback.json');r=read(path)
    assert r['verdict']=='PASS' and r['buildStatus']=='SUCCEEDED' and r['phase']=='COMPLETED'
    assert r['sourceSha']==r['resolvedSourceSha']==SOURCE
    assert r['actualBuildspecSha256']==request['services'][name]['buildspecSha256']==sha((ROOT/(name+'.buildspec.yml')).read_bytes())
    lines=[m['line'] for m in r['executedMarkers']]
    assert all(lines.count(m)==1 for m in request['services'][name]['executedMarkers'])
    assert lines.count('LOCAL_REPODIGEST_ECR_MATCH_PASS')==1
    assert r['externalWrites']==0 and r['liveAcceptance']=='NOT_RUN'
    images[name]={'sourceSha':SOURCE,'imageDigest':r['imageDigest'],'image':r['image'],'buildId':r['buildId'],'buildspecSha256':r['actualBuildspecSha256'],'readback':evidence(path),'executedMarkers':r['executedMarkers']}
counts_path=ROOT/'meriv2-orchestrator-test-counts.json';counts=read(counts_path)
assert counts['verdict']=='PASS' and counts['sourceSha']==SOURCE
assert counts['imageDigest']==images['meriv2-orchestrator']['imageDigest']
assert counts['buildReadbackSha256']==images['meriv2-orchestrator']['readback']['sha256']
assert [c['line'] for c in counts['actualLogCounters']]==['Test Suites: 129 passed, 129 total','Tests:       2 skipped, 1443 passed, 1445 total']
operator_path=REPAIR/'forward450-independent-peer-review.json';op=read(operator_path)
assert op['status']=='PASS' and all(r['exitCode']==0 for r in op['results'])
for p,h in op['sourceSha256'].items():assert sha((REPAIR/p).read_bytes())==h
for r in op['results']:assert sha((REPAIR/r['logFile']).read_bytes())==r['logSha256']

value={
    'kind':'candidate-bound-forward450-retirement-rolling-compatibility',
    'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'reviewer':'/root/file01_release_audit', 'sourceSha':SOURCE,
    'status':'QUALIFIED_CANDIDATE_MIGRATION_PENDING', 'schemaChange':True,
    'retirementCompatibility':'PASS_BOUNDED_SOURCE_REVIEW',
    'fresh450Qualification':'PASS_ACTUAL_OWNED_DATABASE',
    'forward449To450Qualification':'PASS_ACTUAL_OWNED_DATABASE',
    'rollingCompatibility':'PASS_BOUNDED_SOURCE_CONSTRAINT_AND_NATIVE_IMAGE_CHECKS',
    'preliminaryBridge':evidence(prior),
    'sourceQualification':evidence(qpath),
    'allSourceBlobReceiptLogAndJoinedQualificationHashesVerified':True,
    'historical449Prefix':bridge['prefixChecks'],
    'workspaceMigrationsUnchanged':bridge['workspaceMigrationTrees'],
    'migrationSha256':bridge['migrationSha256'],
    'rehearsals':bridge['rehearsals'],
    'retiredRuntimeScans':bridge['retiredRuntimeScans'],
    'historical65StepQualification':bridge['historical65StepQualification'],
    'images':images, 'nativeOrchestratorTestCounts':evidence(counts_path),
    'nativeOrchestratorCounts':{'suitesPassed':129,'testsPassed':1443,'testsSkipped':2,'testsTotal':1445},
    'migrationOperatorPeerReview':evidence(operator_path),
    'rollingAssessment':bridge['rollingCompatibility'],
    'releaseConditions':[
        'Run the reviewed forward450 oneoff only after current exact449 ledger/catalog/four-claim and servedAPI505 baseline checks. No retired restore path, resolve/reset, direct shared-ledger DML or workflow seed dispatch.',
        'Actual normal Prisma deploy must exit0; independently retain exact450 source checksums, no failed history, exact validated two CHECKs and unchanged prior449 history/four claims before marking shared migration complete.',
        'Promote only these digest-bound merged candidates using the existing guarded release operator; verify service source/digest/health and effective feature/cohort configuration.',
        'Keep current Web78ad and ResearchPortfolio Meri tools dark; preserve existing routes/provider/model settings and all nativeV3/tenant gates.',
        'Retain forward schema for application rollback; do not reintroduce six-only constraint after immutable-version writes.',
        'This joins actual local fresh450 and449upgrade rehearsal plus source/native-image qualification. It does not redo or widen the historical65-step retirement rehearsal or claim an original-live data fingerprint comparison.'
    ],
    'sharedMigration':'NOT_RUN_BY_THIS_REVIEWER',
    'servicePromotion':'NOT_RUN_BY_THIS_REVIEWER',
    'liveAcceptance':'NOT_RUN',
    'externalEffects':{'databaseQueries':0,'databaseWrites':0,'cloudWrites':0,'providerCalls':0},
}
p=ROOT/'candidate-retirement-rolling-compatibility.json'
with p.open('x',encoding='utf-8') as f:json.dump(value,f,indent=2);f.write('\n')
print(json.dumps({'path':str(p),'sha256':sha(p.read_bytes()),'status':value['status'],'sourceSha':SOURCE,'exitCode':0}))
