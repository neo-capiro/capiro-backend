from pathlib import Path
import json,hashlib,runpy,datetime,os
root=Path(__file__).resolve().parent;out=root/'budget-amendment-root-v1'
sha=lambda b:hashlib.sha256(b).hexdigest();read=lambda p:json.loads(p.read_bytes())
qualification=read(out/'qualification.json');assert qualification['exitCode']==0
helper=out/'evidence/windows-capture-spend-bound.py';assert sha(helper.read_bytes())==qualification['helperSha256']=='51c010b299b010368ab0f32a081ed8ff1d0b6982fb436f1d8443644d7181d881'
approval=root/'benchmark-budget-user-approval-500-v1.json';assert sha(approval.read_bytes())==qualification['approvalSha256']
journal=Path('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl');auth=journal.with_name('run-authorization.json')
before=journal.read_bytes();auth_before=auth.read_bytes();assert sha(before)=='91f3a7288d35972aab78310ed2feea2f089482ba48a95dd58bdf975d76c6be56'
old=read(root/'case12-failure-reconcile-supervised-v1/native-ack.json');assert old['ok'] and old['snapshot']['eventCount']==30 and old['snapshot']['activeRun'] is None
mod=runpy.run_path(str(helper));request={'op':'fresh_read','root':old['state']['root'],'state':old['state']}
verified=mod['execute'](request);assert verified['state']==old['state'] and verified['snapshot']==old['snapshot']
with (out/'apply-intent.json').open('x',encoding='utf-8') as f:
 json.dump({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'helperSha256':sha(helper.read_bytes()),'approvalSha256':sha(approval.read_bytes()),'journalBeforeSha256':sha(before),'operation':'fresh_amend_budget','noProviderAuthority':True},f,indent=2);f.flush();os.fsync(f.fileno())
try:
 result=mod['execute']({**request,'op':'fresh_amend_budget'})
 with (out/'native-ack.json').open('x',encoding='utf-8') as f:json.dump({'ok':True,**result},f,indent=2);f.flush();os.fsync(f.fileno())
 after=journal.read_bytes();assert after[:len(before)]==before and auth.read_bytes()==auth_before
 assert result['snapshot']['eventCount']==31 and result['snapshot']['maxCostMicros']==500000000 and result['snapshot']['committedCostMicros']==16202947 and result['snapshot']['remainingReservationMicros']==483797053 and result['snapshot']['activeRun'] is None
 final=mod['execute']({'op':'fresh_read','root':result['state']['root'],'state':result['state']});assert final['state']==result['state'] and final['snapshot']==result['snapshot']
 summary={'status':'NATIVE_APPEND_AND_READBACK_PASS','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'eventCount':31,'maxCostMicros':500000000,'perCaseMaxCostMicros':15000000,'committedCostMicros':16202947,'remainingReservationMicros':483797053,'journalBeforeSha256':sha(before),'journalAfterSha256':sha(after),'originalHistoryBytesPreserved':len(before),'authorizationUnchanged':True,'nativeJournalIdentityPreserved':old['state']['files']['fresh-spend.jsonl']['identity']==result['state']['files']['fresh-spend.jsonl']['identity'],'providerCalls':0,'paidConcurrency':1,'laterConcurrencyAuthorization':'../benchmark-concurrency-tenant-authorization-v1.json'}
 (out/'result.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8');print(json.dumps(summary))
except Exception:
 (out/'reconciliation-required.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'DO_NOT_REPLAY_INSPECT_JOURNAL_AND_NATIVE_ACK'}));raise
