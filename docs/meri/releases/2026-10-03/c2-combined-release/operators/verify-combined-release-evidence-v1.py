from pathlib import Path
import json,hashlib,subprocess,re,datetime
r=Path('C:/dev/main/outputs/meri-c2-20261003');repo=Path('C:/dev/main/meri-c1-20261002');arc=repo/'docs/meri/releases/2026-10-03/c2-combined-release';sha=lambda b:hashlib.sha256(b).hexdigest();read=lambda p:json.loads(p.read_bytes())
prov=read(arc/'provenance.json')
for row in prov['copiedFiles']:
 b=(arc/row['path']).read_bytes();assert sha(b)==row['sha256'] and len(b)==row['bytes'];assert Path(row['sourcePath']).read_bytes()==b
pins=read(arc/'combined-c2-source-pins-v1.json')
for row in pins:
 raw=subprocess.check_output(['git','show','c0f393f863bf73bd4e65e7a94e17c073e7be021e:'+row['path']],cwd=repo)
 assert sha(raw)==row['sha256'],row['path']
q=read(arc/'release-qualification.json');assert q['humanApproval'] is None and q['deployableManifest'] is False
for service,c in q['candidates'].items():
 b=read(arc/f'builds/{service}/build-readback.json');log=(arc/f'builds/{service}/build.log').read_bytes()
 assert b['image']==c['image'] and b['sourceSha']==c['sourceSha']==b['resolvedSourceSha']
 assert sha(log)==b['buildLogSha256'];assert sha((arc/f'builds/{service}/buildspec.yml').read_bytes())==b['buildspecSha256']
 assert b['status']=='SUCCEEDED' and b['qualification']=='IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS'
 for marker in b['passedMarkers']:assert marker.encode() in log.splitlines(),marker
 assert b['serviceMutations']==b['databaseMutations']==b['providerCalls']==0
for n in ['api-build-probe-hermes-v1','combined-compatibility-hermes-v1','combined-bundled-hermes-review-v2','combined-bundled-hermes-review-v3','case14-prospective-hermes-v1']:
 u=read(arc/n/'usage.json');assert u['model']=='openai/gpt-6-luna' and u['provider']=='openrouter' and u['completed'] and not u['failed']
 ex=read(arc/n/'execution.json');assert ex['exitCode']==0 and ex['modelOverride'] is None and ex['providerOverride'] is None
schema=read(arc/'combined-c2-schema-read-v1/schema-proof.json');assert schema['readOnlyTransaction'] and not schema['migrationExecution'] and schema['ledgerRows']==609
plan=read(arc/'case14-native-plan-v1/native-plan-readback.json');assert plan['plan']['sourceIds']==['MEM-PROPOSAL-14'] and plan['businessWrites']==0 and not plan['acceptanceAuthority']
for folder in ['combined-c2-schema-read-v1','case14-native-plan-v1']:assert read(arc/folder/'cleanup.json')['cleanupComplete']
budget=q['budgetCheckpoint'];assert sha(Path('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl').read_bytes())==budget['journalSha256']
proof={'result':'PASS','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceSha':q['sourceSha'],'copiedFilesVerified':len(prov['copiedFiles']),'sourcePinsVerifiedAgainstGitObjects':len(pins),'actualBuildsVerified':3,'qualificationBytesSha256':sha((arc/'release-qualification.json').read_bytes()),'schemaAndPlanCleanupComplete':True,'journal24Unchanged':True,'humanReleaseApproval':False,'correctionsToHermesWording':['The paged disabled nextCursor:null branch was already present in the served source; it is preserved, not newly added by this delta.','Fresh schema proof was collected during this continuation from the current served API image; no new schema/migration is proposed.','Final API immutable qualification is now present; the prior bounded Hermes review correctly left it pending at review time.'],'limits':['Source/offline image probes use synthetic collaborators; no new benchmark capture or human grading.','No live service promotion or original acceptance inferred.']}
(r/'combined-c2-lead-byte-verification-v1.json').write_text(json.dumps(proof,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps(proof))
