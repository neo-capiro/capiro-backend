"""Only disposable NTFS copy. No caller-selected root and no live journal read."""
import json,pathlib,runpy,tempfile,sys
BASE=pathlib.Path(__file__).resolve().parent
request=json.loads(sys.stdin.buffer.read(1048577))
assert set(request)=={'proof','checkpoint'}
proof=request['proof'];prior=request['checkpoint']
M=runpy.run_path(str(BASE/'native/windows-capture-spend.py'));execute=M['execute'];G=execute.__globals__
wire=(BASE/'journal25-reconstructed-from-retained.jsonl').read_bytes()
assert M['digest'](wire)=='139b6d7199038ca752c553289bf1ebe9c45f14e65956710f82a48301b132e673'
assert prior['state']['files']['fresh-spend.jsonl']['sha256']==M['digest'](wire)
assert M['digest'](M['data'](proof))==G['CASE14_TERMINAL_PROOF_SHA256']
parent=BASE/'dry-runs';parent.mkdir(exist_ok=True)
root=pathlib.Path(tempfile.mkdtemp(prefix='isolated-',dir=parent));assert root.resolve().is_relative_to(parent.resolve())
assert str(root.resolve()).casefold()!=str(pathlib.Path(G['FRESH_ROOT']).resolve()).casefold()
G['FRESH_ROOT']=str(root)
(root/'run-authorization.json').write_bytes((BASE/'authorization-exact-retained.json').read_bytes())
(root/'fresh-spend.jsonl').write_bytes(b''.join(wire.splitlines(keepends=True)[:20]))
state=execute({'op':'fresh_adopt','root':str(root)})['state']
(root/'fresh-spend.jsonl').write_bytes(wire)
state['files']['fresh-spend.jsonl'].update(sha256=M['digest'](wire),bytes=len(wire))
event={'kind':'reconcile_terminal',**{k:proof[k]for k in('caseId','captureRunId','reservationId')},'proof':proof}
done=execute({'op':'fresh_reconcile_terminal','root':str(root),'state':state,'event':event})
after=(root/'fresh-spend.jsonl').read_bytes();assert after.startswith(wire) and len(after.splitlines())==26
rejected=0
for checkpoint in(state,done['state']):
 try:execute({'op':'fresh_reconcile_terminal','root':str(root),'state':checkpoint,'event':event})
 except (ValueError,OSError):rejected+=1
assert rejected==2
assert done['snapshot']['knownSettledCostMicros']==15200909 and done['snapshot']['conservativeApprovalCostMicros']==1000000 and done['snapshot']['remainingReservationMicros']==13799091
print(json.dumps({'ok':True,'status':'DISPOSABLE_NATIVE_APPEND_PASS','root':str(root),'snapshot':done['snapshot'],'exactPrefixPreserved':True,'staleAndReplayRejected':True,'liveJournalRead':False,'liveJournalMutated':False}))
