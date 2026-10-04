from pathlib import Path
import json,hashlib,subprocess,datetime,re
r=Path('C:/dev/main/outputs/meri-c2-20261003');repo=Path('C:/dev/main/meri-c1-20261002');arc=repo/'docs/meri/releases/2026-10-03/c2-combined-release'
source='c0f393f863bf73bd4e65e7a94e17c073e7be021e';sha=lambda b:hashlib.sha256(b).hexdigest();read=lambda p:json.loads(p.read_bytes())
buildDirs={s:r/f'{s}-combined-c2-build-v{2 if s=="api" else 1}' for s in ['api','meriv2-orchestrator','web-vnext']}
builds={s:read(p/'build-readback.json') for s,p in buildDirs.items()}
for s,b in builds.items():
 assert b['status']=='SUCCEEDED' and b['qualification']=='IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS'
 assert b['sourceSha']==source==b['resolvedSourceSha'];assert sha((buildDirs[s]/'build.log').read_bytes())==b['buildLogSha256']
schema=read(r/'combined-c2-schema-read-v1/schema-proof.json');assert schema['status']=='VERIFIED_READ_ONLY'
assert read(r/'combined-c2-schema-read-v1/cleanup.json')['cleanupComplete']
assert read(r/'case14-native-plan-v1/cleanup.json')['cleanupComplete']
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo).decode().strip()==source
assert subprocess.check_output(['git','status','--porcelain'],cwd=repo).strip()==b''
reviewText=(r/'combined-bundled-hermes-review-v3/REVIEW.md').read_text();assert 'PASS' in reviewText
assert read(r/'combined-bundled-hermes-review-v3/execution.json')['exitCode']==0
arc.mkdir(exist_ok=False);copies=[]
def copy(src,rel):
 raw=src.read_bytes();assert not re.search(rb'(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(?:sk_live_|sk_test_)[A-Za-z0-9]{25,})',raw),src
 dest=arc/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw);copies.append({'path':rel,'sourcePath':str(src),'sha256':sha(raw),'bytes':len(raw)})
def save(name,obj):
 p=arc/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text((obj if isinstance(obj,str) else json.dumps(obj,indent=2))+'\n',encoding='utf-8',newline='\n')
for s,d in buildDirs.items():
 for n in ['build-readback.json','build.log','build-start.json','launch-intent.json','buildspec.yml']:copy(d/n,f'builds/{s}/{n}')
for n in ['build-readback.json','build.log','build-start.json','launch-intent.json','buildspec.yml']:copy(r/'api-combined-c2-build-v1'/n,'failed-api-v1/'+n)
for folder in ['api-build-probe-supervised-v2','api-build-probe-hermes-v1','combined-compatibility-hermes-v1','combined-bundled-hermes-review-v2','combined-bundled-hermes-review-v3','case14-prospective-hermes-v1']:
 for p in (r/folder).iterdir():
  if p.is_file():copy(p,folder+'/'+p.name)
for folder,filename in [('combined-c2-schema-read-v1','schema-proof.json'),('case14-native-plan-v1','native-plan-readback.json')]:
 for n in ['intent.json','definition-registered.json','task-start.json','log-transport-pages.json','result.json',filename,'readback-transport.json','cleanup.json']:
  if (r/folder/n).exists():copy(r/folder/n,folder+'/'+n)
copy(r/'combined-c2-release-preparation-v1/served-baseline.json','served-baseline.json')
for n in ['combined-c2-candidate-v1.json','combined-c2-source-pins-v1.json','case14-prospective-plan-input-v1.json','case14-prospective-local-verification-v1.json']:
 copy(r/n,n)
for n in ['start-combined-c2-backup-build-v1.mjs','collect-combined-c2-build-v1.mjs','start-api-combined-c2-backup-build-v2.mjs','collect-api-combined-c2-build-v2.mjs','inspect-combined-c2-release-v1.mjs','combined-c2-schema-inner-v1.mjs','read-combined-c2-schema-v1.mjs','case14-native-plan-inner-v1.mjs','run-case14-native-plan-v1.mjs','aws-single-attempt.mjs','run-hermes-review-bundled-v3.py']:
 copy(r/n,'operators/'+n)
for n in ['input-manifest.json','exact-production-delta.patch']:copy(r/'combined-review-inputs-v3'/n,'review-inputs/'+n)
for n in ['STATUS.md','01-requirements.md','01-handover.md']:copy(repo/'docs/meri/implementation'/n,'prior-current-docs/'+n)
budget={'journalSha256':'8f20134f71dde90e32fc0c3c2aba2da2d5b93dd13fffea31b83105d1621bc3e5','events':24,'knownCostMicros':13631058,'remainingMicros':16368942,'activeRun':None,'admittedCases':['01','20'],'newCaptureAuthority':False}
assert sha(Path('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl').read_bytes())==budget['journalSha256']
q={'version':1,'status':'AUTOMATED_QUALIFICATION_PASSED_HUMAN_RELEASE_REVIEW_PENDING','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceSha':source,'sourcePr':'https://github.com/neo-capiro/capirov2/pull/1937','candidates':{s:{'sourceSha':source,'image':b['image']} for s,b in builds.items()},'tests':{'nativeOrchestrator':builds['meriv2-orchestrator']['tests'],'web':{'passed':175,'testFiles':11},'case20Source':{'core':78,'api':38,'orchestrator':191},'case17Source':{'api':25,'web':37,'typingFollowup':65},'overlap':'Focused counts overlap native suites; none is a live benchmark pass.'},'builds':{s:{'buildId':b['buildId'],'buildspecSha256':b['buildspecSha256'],'buildLogSha256':b['buildLogSha256'],'markers':b['passedMarkers'],'architecture':b['architecture']} for s,b in builds.items()},'currentSchema':schema,'servedBaselineSha256':sha((r/'combined-c2-release-preparation-v1/served-baseline.json').read_bytes()),'sourceReviews':{'case17':'../c2-case17-provenance-source/README.md','case20':'../c2-case20-receipt-repair/README.md','combinedHermes':'combined-bundled-hermes-review-v3/REVIEW.md','leadReview':'release-independent-review.json'},'retirementCompatibility':{'schemaChange':False,'retiredTablesAbsent':True,'migrationDependencyContainerFilesUnchanged':True,'productionImportsUnchanged':True,'rollingOrder':'API then orchestrator then web; capture qualification waits for the exact served pair. Optional recordedSource is ignored by old web and absent-safe in new web. Missing joins remain blocked.','rollback':'Current API521/orchestrator117/Web388 exact digests. Retain schema, nightly136, disabled broad worker and completed maintenance.'},'scope':{'change':'Three service images and release identity only','schemaChange':False,'modelConfigurationChange':False,'providerConfigurationChange':False,'featureFlagChange':False,'nightlyChange':False,'capacityChange':False,'newProviderCalls':0,'newCaptureAuthority':False,'captureBindingWrite':False,'budgetInstallation':False,'journalMutation':False},'failureHistory':{'actions':'User explicitly requested existing CodeBuild backup because Actions is broken; no additional Actions dispatch attempted.','apiFirstBuild':'Failed added offline harness lacked canonical tenant scope/cohort. No image published. Corrected harness retains assertions and adds dark/offcohort checks; original failure retained.','localProbe':'First local probe failed against stale compiled dist. Fresh current source Nest build and identical probe passed; failed evidence retained.','reviewPreparation':'First Hermes compatibility lane lacked exact build/source files; first bundled run had incomplete inputs. Both limitations retained, complete v3 bundle supersedes them.'},'schemaChange':False,'humanApproval':None,'deployableManifest':False,'acceptance':{'original75':0,'cd':0,'cw':0,'failedCase01':'CAPTURE_UNCERTAIN; consumed; no replay','failedCase20':'CAPTURE_UNCERTAIN / NOT_EVALUATED; consumed; accounting only closed','case14':'Native plan captured; no pending candidate created, no approval/capture/recall acceptance'},'budgetCheckpoint':budget}
save('release-qualification.json',q)
save('.gitattributes','* -text whitespace=cr-at-eol\n*.log -diff')
save('provenance.json',{'copiedFiles':copies,'privateDefinitionsAndNetworkInputsExcluded':True,'credentialPatternScan':'PASS'})
save('README.md',f'''# C2 combined candidate qualification

API, orchestrator and Web vNext immutable ARM images from merged source `{source}` passed the authorized CodeBuild backup path. [PR1937](https://github.com/neo-capiro/capirov2/pull/1937) contains the reviewed Case17 provenance, Case20 receipt repairs and completed cost reconciliation. [Exact image qualification](release-qualification.json) records digests and scope. Human release review and service promotion remain pending; C2 is not accepted.

The orchestrator passed1568 tests across130 suites, with two existing live tests skipped. Web passed175 tests across11 files, typecheck/build and the recorded-source package probe. API passed all retained packaged import/memory/clock/receipt/provider/migration checks and the corrected recorded-source privacy probe. Source qualification is preserved in the [Case17 archive](../c2-case17-provenance-source/README.md) and [Case20 archive](../c2-case20-receipt-repair/README.md); counts overlap and are not benchmark passes.

API buildv1 failed because its added offline probe omitted canonical tenant scope/cohort. Hermes drafted a fix; the lead corrected its paged response expectation against current source and independently checked the result. A local stale-dist failure, fresh successful build/probe, original failed CodeBuild and actual successful APIv2 are retained. No production code or flags were changed to satisfy the probe. [Final bounded Hermes review](combined-bundled-hermes-review-v3/REVIEW.md) and [lead independent review](release-independent-review.json) distinguish source/build evidence from human acceptance. Earlier incomplete reviews remain historical.

The [fresh baseline](served-baseline.json) verifies API521/orchestrator117/Web388 tasks and ALB targets. The [current schema proof](combined-c2-schema-read-v1/schema-proof.json) verifies ledger609, prior608 hashes, two ready indexes and retired-table absence under a read-only transaction. Its helper is stopped/inactive. Candidate migrations, dependencies and container definitions are unchanged relative to each relevant served baseline. No retired runtime imports are added.

Deploy API first, verify it, then orchestrator, then Web; verify each before proceeding. Preserve configuration/models/providers/flags/capacity/network/secrets/schema, guarded nightly136, the disabled broad worker and completed memory maintenance. Rollback uses the exact healthy current images recorded in the baseline; no down migration. This artifact does not authorize replay, new paid capture, budget installation or fixture binding.

Case14's separate [native plan](case14-native-plan-v1/native-plan-readback.json) resolves exactly one MEM-PROPOSAL-14 from Pat/T1/Aster with a fresh instance and current owner guards. It makes no fixture/business/provider write; its helper is stopped/inactive. Execution, approval and next-turn recall remain separate. Re-plan if tenant settings/version change; never change instance to evade an existing operation.

Case20 accounting is closed once at event24; original failed receipt/consumed claim remains. Known cost is $13.631058 with $16.368942 remaining, no active hold, unchanged aggregate/per-case/concurrency and01/20 admission. Remaining capacity is not Case14 capture authority. Original acceptance remains0/75, CD0/7, CW0/8; C2 memory/artifact/approval/CD variants, repeats and human grading remain open.
''')
print(json.dumps({'status':'ARCHIVE_READY_FOR_LEAD_REVIEW','path':str(arc),'files':len(copies),'candidates':q['candidates']}))
