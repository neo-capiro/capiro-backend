from pathlib import Path
import hashlib,json,subprocess,datetime
repo=Path('C:/dev/main/meri-c1-20261002');root=Path('C:/dev/main/outputs/meri-c2-20261003');out=root/'case14-local-qualification-v1';out.mkdir()
node='C:/Program Files/nodejs/node.exe';py='C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe'
source=['evals/meri/live-v1/case14-approval-capture.mjs','evals/meri/live-v1/case14-approval-write-guard.mjs','evals/meri/live-v1/case17-readonly-guard.mjs','evals/meri/live-v1/capture-spend-aggregate.mjs','evals/meri/live-v1/lib/windows-capture-spend.py']
tests=['evals/meri/live-v1/tests/'+n for n in ['case14-approval-write-guard.test.mjs','case14-capture.test.mjs','case14-delayed-query.test.mjs','case17-readonly-guard.test.mjs','capture-spend-fresh.test.mjs']]
journal=Path('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl');before=journal.read_bytes()
proof={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceFiles':[{'path':n,'sha256':hashlib.sha256((repo/n).read_bytes()).hexdigest()} for n in source+tests+['evals/meri/live-v1/tests/capture-spend-fresh.unit.py']],'runs':[]}
for name,cmd in [('node-tests',[node,'--test',*tests]),('native-tests',[py,'-I','evals/meri/live-v1/tests/capture-spend-fresh.unit.py'])]:
 p=subprocess.run(cmd,cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120);(out/(name+'.log')).write_bytes(p.stdout);proof['runs'].append({'name':name,'exitCode':p.returncode,'logSha256':hashlib.sha256(p.stdout).hexdigest()})
proof.update(status='PASS' if all(r['exitCode']==0 for r in proof['runs']) else 'FAIL',journalUnchanged=before==journal.read_bytes(),journalSha256=hashlib.sha256(before).hexdigest(),cloudActions=0,approvalSubmissions=0,recallSubmissions=0,liveAdmission='NOT_QUALIFIED_APPROVAL_PROVIDER_BOUNDARY_UNRESOLVED')
(out/'checkpoint.json').write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof))
if proof['status']!='PASS' or not proof['journalUnchanged']:raise SystemExit(1)
