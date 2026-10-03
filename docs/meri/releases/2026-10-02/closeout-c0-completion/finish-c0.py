import datetime,hashlib,json,pathlib,re,shutil,subprocess
repo=pathlib.Path('C:/dev/main/meri-closeout-c0-20261002')
root=pathlib.Path('C:/dev/main/outputs/meri-c0-completion-20261002')
dest=repo/'docs/meri/releases/2026-10-02/closeout-c0-completion'
docs=repo/'docs/meri/implementation'
read=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
sha=lambda b:hashlib.sha256(b).hexdigest()
git=lambda *a:subprocess.check_output(['git',*a],cwd=repo)
save=lambda n,v:(root/n).write_text(json.dumps(v,indent=2,ensure_ascii=False)+'\n',encoding='utf-8',newline='\n')
schema=read(root/'schema-assessment.json');assert schema['taskCleanupVerified'] and schema['checksumDifferencesExactlyMatchHistoricalDiagnostic']
source=read(root/'source-and-machine.json');assert source['commitsSinceAudit']=='0'
services={k:read(root/(k+'-current.json')) for k in ['api','meriv2-orchestrator','web-vnext']}
for s in services.values():assert s['currentEcrAvailable'] and s['previousArtifact']['availability']=='VERIFIED' and s['previousArtifact']['status']=='ACTIVE'
checks=[]
for path,service,description in [
 ('apps/meriv2-orchestrator/src/meri/chat/chat-prompt.ts','meriv2-orchestrator','Provider grounding uses new Date(); no capture semantic clock supplied.'),
 ('apps/api/src/meri/meri-context-plane.service.ts','api','Production planning/context requests omit the optional test now field.'),
 ('packages/meriv2-core/src/context/contract.ts','api','ContextRequest.now is a deterministic test seam, not an admitted served override.')]:
 ref=services[service]['sourceSha'];deployed=git('show',ref+':'+path);current=git('show','723735ed1f5c562ab10e6077c67261285ea102fd:'+path)
 assert deployed==current,path
 checks.append({'path':path,'servedSource':ref,'sourceMatchesMain':True,'sha256':sha(deployed),'finding':description})
blockers={'status':'EXPLICIT_FIXTURE_BLOCKERS_RETAINED','c0ExitPermitsExplicitFixtureBlockers':True,'items':[
 {'id':'C0-FIXTURE-CLOCK','status':'BLOCKED','requirement':'Freeze benchmark semantics at 2026-09-26T16:00:00.000Z (September26 noon America/New_York), independently of real auth/lease/deadline clocks.','evidence':checks,'collector':'evals/meri/live-v1/memory-read-protocol.mjs sends only the prompt body; static fixture/manifest clock checks do not prove runtime injection.','scopeImpact':'Original frozen-clock acceptance remains unproved. Fresh cases are collected observations, not full original acceptance.','nextAction':'Extend the existing server-owned fixture qualification and signed capture policy with a semantic instant/timezone; propagate to API planning, ContextRequest.now, orchestrator date grounding and applicable tool date defaults; persist actual clock evidence. Reject forged/mismatched bindings. Keep auth, expiry, leases, deadlines and audit timestamps on real time.','qualification':['Frozen September26 semantic date while actual auth timestamps remain October.','Real expired policy still rejected.','Nonfixture behavior unchanged.','Tampered binding rejected.','Collector rejects unsupported clock proof.','Actual served/persisted readback after qualification.'],'owner':'Lead, before claiming complete original fixture acceptance'},
 {'id':'C0-OLD-JOURNAL','status':'BLOCKED_FOR_OLDER_RUN_RESUMPTION','path':'C:/dev/cap-meri-foundation-evidence/oct02-original-aggregate-operator-v6/shared-spend-v2-checkpoint.json','pathPresent':pathlib.Path('C:/dev/cap-meri-foundation-evidence/oct02-original-aggregate-operator-v6/shared-spend-v2-checkpoint.json').exists(),'historicalCheckpointSha256':'7f9e69b4dffb07344337e9cb4c62d8b6b495c54ae956bcc399cffd3b3cd88cb5','unknownBillingPreserved':True,'historicalEvent5NotCurrentBalance':True,'freshRunSeparateUserAuthority':'User explicitly said start your own; five new reservations settled for9841281 micros. This does not replace or recover the old native journal.','nextAction':'Recover the exact journal/current head and reconcile its owned saved run before any older-run resumption; respect original deadline. Do not initialize/reset/refund legacy reservations.','owner':'Lead when resuming the older run'}]}
assert not blockers['items'][1]['pathPresent']
save('fixture-blockers.json',blockers)
completion={'kind':'meri_closeout_c0_completion','completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'userFacingDate':'2026-10-02 America/New_York','c0Exit':'PASS_WITH_EXPLICIT_FIXTURE_BLOCKERS','basis':'Closeout plan C0 exit permits explicit fixture blockers; Done requires current version, first affected flow, existing test mechanism and next release.','checklist':[
 {'step':1,'status':'PASS','evidence':'source-and-machine.json'},
 {'step':2,'status':'PASS','evidence':'../closeout-c0/source-reconciliation.json'},
 {'step':3,'status':'PASS_BASELINE_WITH_HISTORICAL_DRIFT_RETAINED','evidence':'schema-assessment.json'},
 {'step':4,'status':'PASS','evidence':'../../../implementation/01-requirements.md'},
 {'step':5,'status':'ACCEPTED_LIMITATION_OLDER_JOURNAL','evidence':'fixture-blockers.json'},
 {'step':6,'status':'LIVE_FLOW_VERIFIED_SEMANTIC_CLOCK_BLOCKED','evidence':'../fresh-live-benchmark/README.md'},
 {'step':7,'status':'PASS_QUEUED','evidence':'C1-FIRST-REPAIR.md'}],
 'sourceSha':source['fetchedMainSha'],'policySha':source['policySha'],'machineMapSha256':source['machineMap']['sha256'],'currentVersions':{k:{'sourceSha':v['sourceSha'],'taskDefinitionArn':v['taskDefinitionArn'],'image':v['image'],'configHash':v['configHash']} for k,v in services.items()},'liveCasesCollected':5,'originalCasesFullyAccepted':0,'caseAssertionFailure':['02'],'coverageDefectCase':'03','additionalProviderCallsThisClosure':0,'additionalDatabaseMutations':0,'newTemporarySchemaTasks':1,'taskCleanupVerified':True,'productionCodeChanges':0,'serviceDeployments':0,'humanAcceptanceReview':'NOT_REVIEWED','nextGate':'C1','nextRelease':'Narrow Office Delta classification repair; expected orchestrator-only, current orch105 rollback baseline; confirm actual final diff/qualification.'}
save('completion.json',completion)
save('independent-review.json',{'reviewer':'Independent Codex agent benchmark_review','humanReview':False,'status':'C0_EXIT_ALLOWED_WITH_EXPLICIT_BLOCKERS','clockSourceAudit':'No served semantic clock override found. Source files match API515/orch105. Never mark frozen runtime clock or original acceptance PASS.','schemaOperatorReview':'No DB write/provider calls; verified TLS/read-only transaction/bounded timeout/exact synthetic claim reads. Corrected plural conversation/message table names before execution.','acceptanceDistinction':'C1/C2 repairs and C4 full75, mode/JEV variants, repeats, effects and human review are later gates.'})
for name in ['README.md','C1-FIRST-REPAIR.md']:
 p=root/name;text=p.read_text(encoding='utf-8')
 for a,b in [('all451','all 451'),('the61','the 61'),('same451','same 451'),('with5-second','with 5-second'),('total$','total $'),('**0 original','**0 original'),('October2','October 2'),('beforeC1','before C1')]:text=text.replace(a,b)
 p.write_text(text,encoding='utf-8',newline='\n')
assert not dest.exists(),'Preserve an existing archive'
dest.mkdir(parents=True)
for p in root.rglob('*'):
 if not p.is_file():continue
 b=p.read_bytes();s=b.decode('utf-8-sig')
 assert not re.search(r'\b(?:sk_live_|sk_test_)[A-Za-z0-9]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+',s),str(p)
 target=dest/p.relative_to(root);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,target)
manifest={'generatedAt':completion['completedAt'],'artifacts':{p.relative_to(dest).as_posix():{'sha256':sha(p.read_bytes()),'bytes':p.stat().st_size} for p in sorted(dest.rglob('*')) if p.is_file()}}
(dest/'index.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n')
link='../releases/2026-10-02/closeout-c0-completion/README.md'
p=docs/'STATUS.md';text=p.read_text(encoding='utf-8')
start=text.index('**C0 baseline');end=text.index('\n\n**Five live',start)
text=text[:start]+f'**C0 exit complete with explicit fixture blockers; C1 queued. File01 remains 01_BLOCKED.** All seven C0 checklist items now have evidence or an explicit disposition. Current/previous artifacts, live schema, local operations map and a runnable ordinary flow are verified. Frozen semantic-clock injection remains BLOCKED; the older journal is unavailable and its unknown costs are preserved. These are permitted C0 fixture dispositions, not original acceptance passes. [C0 completion and exact checklist]({link}).'+text[end:]
marker='**Fresh run accounting:**'
pos=text.index(marker);text=text[:pos]+f'**Schema and rollback baseline:** all 451 packaged API migration names are applied, none unfinished. The 61 checksum differences exactly match the prior diagnostic; no ledger was rewritten. Current memory constraints match the qualified repair, and the current API/main/API rollback migration bytes match. Previous immutable artifacts are available; no rollback rehearsal was run. The read-only schema task is stopped and deregistered. [Assessment]({link.replace("README.md","schema-assessment.json")}).\n\n'+text[pos:]
p.write_text(text,encoding='utf-8',newline='\n')
p=docs/'01-handover.md';text=p.read_text(encoding='utf-8');start=text.index('C0 baseline');end=text.index('\n\nResume',start)
text=text[:start]+f'C0 is closed under the plan’s exit criteria, with frozen semantic-clock injection and older-journal recovery explicitly unresolved. [All seven C0 dispositions, schema/rollback evidence and next C1 repair]({link}) are current. Five independent live memory cases are preserved; **01_READY_FOR_02 is not established.**'+text[end:]
text=text.replace('No migration, new model, framework or infrastructure expansion was performed.','No migration, new model, framework or persistent infrastructure expansion was performed.')
p.write_text(text,encoding='utf-8',newline='\n')
p=docs/'01-requirements.md';text=p.read_text(encoding='utf-8');pos=text.index('\n\nThe merged SHA column')
text=text[:pos]+f'\n\n**C0 exit closed:** [all seven checklist dispositions]({link}); current schema readback and immutable rollback inventory verified, historical checksum differences retained. Frozen semantic-clock and older-journal gaps remain explicit fixture blockers; neither is represented as accepted benchmark evidence.'+text[pos:]
lines=text.splitlines()
for i,line in enumerate(lines):
 if line.startswith('| ANNEX-10.3:') or line.startswith('| ANNEX-13:'):
  cols=line.split('|');assert len(cols)==10
  cols[6]=' C0 baseline PASS; release acceptance incomplete '
  cols[7]=cols[7].rstrip()+f'; [C0 complete]({link}) '
  cols[8]=' C1/C5: qualify the exact next candidate against verified schema/config/rollback; preserve historical drift and ledger. '
  lines[i]='|'.join(cols)
p.write_text('\n'.join(lines)+'\n',encoding='utf-8',newline='\n')
p=docs/'01-source-acquisition.md';text=p.read_text(encoding='utf-8');pos=text.index('## Current consolidation checkpoint')
text=text[:pos]+f'C0 closure addendum: the seven-item baseline gate is closed with explicit fixture blockers; current schema/rollback and verified local policy paths are recorded in the [completion report]({link}). Donor provenance and conditional activation decisions remain unchanged.\n\n'+text[pos:];p.write_text(text,encoding='utf-8',newline='\n')
p=docs/'01-source-inventory.json';inventory=read(p);inventory['integrationCheckpoints'].append({'date':completion['completedAt'],'kind':'c0_exit_completion','sourceSha':source['fetchedMainSha'],'evidence':'docs/meri/releases/2026-10-02/closeout-c0-completion/README.md','c0Exit':completion['c0Exit'],'packagedMigrationsVerified':451,'historicalChecksumDifferencesRetained':61,'semanticClock':'BLOCKED','olderJournal':'UNAVAILABLE_PRESERVED','sourceProvenanceChanged':False,'newProviderCalls':0,'schemaMutations':0});p.write_text(json.dumps(inventory,indent=2,ensure_ascii=False)+'\n',encoding='utf-8',newline='\n')
print(json.dumps({'c0Exit':completion['c0Exit'],'archive':str(dest),'artifacts':len(manifest['artifacts']),'next':'C1 Office Delta classification repair'}))
