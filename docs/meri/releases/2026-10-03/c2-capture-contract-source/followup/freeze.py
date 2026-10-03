from pathlib import Path
import datetime, hashlib, json, os, re, subprocess

repo=Path('C:/dev/main/meri-c1-20261002')
out=Path('C:/dev/main/outputs/meri-c2-20261003/capture-contract-followup-v1')
prior=out.parent/'capture-receipt-clock-v1'
sha=lambda b:hashlib.sha256(b).hexdigest()
def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb') as handle:
        handle.write(data);handle.flush();os.fsync(handle.fileno())
def info(path):
    data=path.read_bytes()
    return {'path':str(path).replace('\\','/'),'sha256':sha(data),'bytes':len(data)}

files=[
 'apps/api/src/meri/meri-tools.service.ts',
 'apps/api/src/meri/meri-memory-proposal-read.ts',
 'apps/api/src/meri/meri-capture-policy-readback.ts',
 'apps/meriv2-orchestrator/src/meri/controlled-read-observations.ts',
 'packages/meriv2-core/src/context/capture-evidence-receipt.ts',
 'apps/api/src/meri/meri-tools.registration.spec.ts',
 'apps/api/src/meri/meri-memory-proposal-read.spec.ts',
 'apps/api/src/meri/meri-capture-budget-readback.spec.ts',
 'apps/meriv2-orchestrator/src/meri/controlled-read-observations.spec.ts',
 'packages/meriv2-core/src/context/capture-evidence-receipt.spec.ts',
]
sources=[]
for index,name in enumerate(files):
    data=(repo/name).read_bytes()
    write(out/'source'/name,data)
    sources.append({'path':name,'kind':'production' if index<5 else 'test',
                    'sha256':sha(data),'bytes':len(data),'mirror':'source/'+name})
final_labels=['core-green-v3','core-build-v2','api-green-v2','orchestrator-green-v3',
              'provider-regressions','api-build','orchestrator-build']
for label in final_labels:
    rec=json.loads((out/(label+'.receipt.json')).read_text())
    assert rec['exitCode']==0 and rec['sourceUnchanged']
    assert rec['logSha256']==sha((out/(label+'.log')).read_bytes())
    assert all(rec['sourceHashes'][row['path']]==row['sha256'] for row in sources),label
same_test=[]
for label,names in [
    ('api-red-v2',files[5:7]),
    ('readback-red',[files[7]]),
    ('orchestrator-red-v2',[files[8]])]:
    rec=json.loads((out/(label+'.receipt.json')).read_text())
    assert rec['exitCode']==1 and rec['sourceUnchanged']
    for name in names:
        assert rec['sourceHashes'][name]==sha((repo/name).read_bytes())
        same_test.append({'redReceipt':label+'.receipt.json','test':name,'exactFinalTestBytes':True})
old=(out/'core-red-v2-source'/files[-1]).read_text()
current=(repo/files[-1]).read_text()
for original,repaired in [
    ("authority: 'own_pending_proposals'", "authority: 'own_pending_proposals' as const"),
    ('clientId: r.clientId,','clientId: r.clientId!,'),
    ("semanticTime: 'not_used'", "semanticTime: 'not_used' as const"),
    ("compiler: 'not_run'", "compiler: 'not_run' as const"),
    ('claimsAreApprovedFacts: false,','claimsAreApprovedFacts: false as const,'),
    ("coverage: 'complete'", "coverage: 'complete' as const")]:
    current=current.replace(repaired,original)
assert current==old,'Core assertion drift beyond declared TypeScript literal narrowing'
unchanged={
 'apps/api/src/meri/meri-server-readonly-capture.ts':'689ddc776123be123c6181ebf7459ce747ae4eb99ad841a8966d8db87210ac93',
 'apps/api/src/meri/meri-capture-clock-packets.spec.ts':'655f564716160bed9f20bfa32450f46a9adb9989009a321782e11d235140e828',
 'evals/meri/live-v1/tests/capture-clock-receipt-jsonb.postgres.test.mjs':'0534d2c82efaca14a7d9f66cd2399192b3a400ccf4f1693300473a825d64d5e2',
}
assert all(sha((repo/p).read_bytes())==v for p,v in unchanged.items())
pgprefix='capture-receipt-clock-combined-followup-v1'
pg=json.loads((prior/(pgprefix+'.receipt.json')).read_text(encoding='utf-8-sig'))
assert pg['testExit']==0 and pg['sourceUnchanged'] and pg['builtCoreUnchanged']
assert pg['clusterStoppedAfter'] and pg['listenersBefore']==pg['listenersAfter']==0 and pg['stopExit']==0
assert pg['testLogSha256']==sha((prior/(pgprefix+'.log')).read_bytes())
patch=subprocess.check_output(['git','diff','--binary','--',*files],cwd=repo)
write(out/'candidate.patch',patch)
evidence=[]
for path in sorted(out.iterdir()):
    if path.is_file() and (path.suffix=='.log' or path.name.endswith('.receipt.json')):
        evidence.append(info(path))
for path in sorted(prior.glob(pgprefix+'*')):
    if path.is_file(): evidence.append(info(path))
evidence.append(info(prior/'checkpoint.json'))
cases=['01-empty','01-complete','01-partial','14-complete','tenant','actor','client','missing-client',
       'compiler','approved','disabled','http-failure']
checkpoint={
 'kind':'bounded_original_capture_contract_repair',
 'status':'FROZEN_LOCAL_QUALIFICATION_PENDING_INDEPENDENT_REVIEW',
 'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'baseSourceSha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
 'sources':sources,'sourceCount':10,'productionCount':5,'testCount':5,
 'newRepositoryFile':files[7],
 'trackedPatch':info(out/'candidate.patch'),
 'priorSerializationCandidateUnchanged':unchanged,
 'priorSerializationCheckpointSha256':sha((prior/'checkpoint.json').read_bytes()),
 'changes':[
  'Original01/14 budget dispatch admits the already registered own-pending-proposal read; no write/provider/tool catalog authority is added.',
  'The internal policy binds tenant, actor, selected client, current real expiry, original fixture/semantic binding and existing ledger marker before/after the owner read; current membership/conversation/wall authority is reread before returning.',
  'The actual raw HTTP response collector records scoped pending-only, unapproved proof without a compiler packet or semantic-time consumer. Ordinary and synthetic helper paths retain prior behavior.',
  'Only complete or healthy-empty proposal proof can satisfy the clock invocation census; partial/disabled/failed/refused/orphan/foreign/packet/citation claims remain blocked. Empty raw coverage may match generic logical complete, only in that direction.',
  'Readonly receipt validation matches the existing 15M qualified admission maximum and owner readback requires exact actual ledger ceiling equality. Separate case46 authority and all live budgets are unchanged.',
 ],
 'qualification':{
  'core':{'pass':50,'fail':0,'suites':1,'receipt':'core-green-v3.receipt.json'},
  'api':{'pass':149,'fail':0,'suites':5,'receipt':'api-green-v2.receipt.json'},
  'orchestrator':{'pass':43,'fail':0,'suites':2,'receipt':'orchestrator-green-v3.receipt.json','actualLoopbackHttp':True},
  'providerAndOwnerRegressions':{'pass':39,'fail':0,'suites':3,'receipt':'provider-regressions.receipt.json'},
  'actualPrismaPostgres':{'pass':4,'fail':0,'skipped':0,'receipt':str(prior/(pgprefix+'.receipt.json')).replace('\\','/'),
      'scope':'actual generated Prisma plus current source and final built core; rollback-only random schemas on owned127.0.0.1:55433; cluster stopped'},
  'builds':[{'package':p,'receipt':r+'.receipt.json','exitCode':0} for p,r in [('core','core-build-v2'),('api','api-build'),('meriv2-orchestrator','orchestrator-build')]],
 },
 'failFirstEvidence':{
  'coreRedV2':{'failed':3,'passed':47,'receipt':'core-red-v2.receipt.json','sameRuntimeAssertions':True,'exactFinalTestBytes':False,
    'difference':'Final test uses literal as-const annotations and non-null client type narrowing after the new production interface caused a compile-only failure; no runtime assertions changed, verified by normalized exact equality.'},
  'apiRedV2':{'failed':13,'passed':62,'receipt':'api-red-v2.receipt.json'},
  'httpRedV2':{'failed':9,'passed':30,'receipt':'orchestrator-red-v2.receipt.json'},
  'ceilingReadbackRed':{'failed':2,'passed':1,'receipt':'readback-red.receipt.json'},
  'exactFinalTestBytes':same_test,
  'retainedIntermediateFailures':[
    'core-green: compile-only new literal interface/test inference mismatch, no tests executed.',
    'orchestrator-green: compile-only nullable existing classifier return needed explicit rejection, no tests executed.',
    'orchestrator-green-v2: actual loopback healthy-empty proof versus existing generic logical complete mismatch; one failed/42 passed. Final same-byte test passes with the bounded one-way compatibility rule.',
    'Original red-v1 and red-v2 logs and source mirrors are retained; red-v2 tightens partial-blocked expectations and adds post-read current-authority tests.'
  ],
  'historicalReceiptClarification':'Early core-red/api-red/orchestrator-red/readback-red receipt field networkOrProviderCalls:0 describes no external network/providers. The orchestrator suite intentionally makes loopback HTTP requests. Later receipts state externalNetworkOrProviderCalls:0 and loopbackHttp explicitly.'
 },
 'buildGuidance':{
  'orchestratorRequiredPassingTestNames':['controlled read actual HTTP observations observes the actual own-proposal response as a bounded no-clock-consumer read: '+case for case in cases],
  'expectedOrchestratorNativeCountsIfNoOtherTestChanges':{'passed':1564,'pending':2,'suites':130,'basis':'prior1552/2/130 plus12 new it.each entries in existing suite; remote result must confirm'},
  'apiPackagedProbe':[
    'Use existing actual API finalizer with a signed incomplete clock receipt and clockPackets:null; assert BLOCKED/PENDING, absent own api key, JSON roundtrip equality and retained HMAC verification.',
    'Exercise compiled core receipt shape with admitted maxCostMicros15M and charged2292602; reject max15000001 and charge beyond actual limit. This is shape validation, not a fresh qualification/admission.',
    'Call packaged readOwnPendingMemoryProposals using a local owner stub; exact01/14 scope succeeds pending/unapproved, missing or other selected client and foreign actor/tenant refuse before stub. Ordinary helper without capture policy still succeeds. No DB/provider transport.',
  ],
 },
 'limits':[
  'No cloud/auth/provider/model/capture/journal/fixture action, deployment, commit or approval was performed by this implementation.',
  'Actual HTTP tests use loopback transport. Proposal helper and dispatch tests isolate the existing canonical owner/authority ports; they do not qualify live fixtures or production RLS.',
  'PostgreSQL tests prove storage/serialization using actual generated Prisma and current source/final core dependency, not production authority or acceptance.',
  'Before/after current authority is point-in-time revalidation, not an atomic cross-process revocation lock.',
  'No schema, model, service config, dependency, signed-policy format, source fixture reset or new budget is introduced. Old/new service combinations remain fail-closed for unproved proposal clock joins; native images and rollout remain separately required.',
  'The original failed live run remains UNCERTAIN and is not replayed or retroactively accepted by these local tests.',
 ],
 'evidence':evidence,
}
write(out/'checkpoint.json',(json.dumps(checkpoint,indent=2)+'\n').encode())
print(json.dumps({'checkpoint':info(out/'checkpoint.json'),'sourceCount':len(sources),'evidenceCount':len(evidence)}))
