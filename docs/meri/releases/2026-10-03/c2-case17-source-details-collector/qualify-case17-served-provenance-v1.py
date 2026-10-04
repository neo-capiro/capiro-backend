from pathlib import Path
import subprocess,os,json,hashlib,datetime
repo=Path('C:/dev/main/meri-c1-20261002');root=Path('C:/dev/main/outputs/meri-c2-20261003/case17-served-provenance-qualification-v1');root.mkdir(exist_ok=False)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
files=['evals/meri/live-v1/case17-memory-ui.mjs','evals/meri/live-v1/case17-saved-checks.mjs','evals/meri/live-v1/tests/case17-memory-ui.test.mjs','evals/meri/live-v1/tests/case17-saved-checks.test.mjs']
pins=[{'path':f,'sha256':sha(repo/f)} for f in files]
tests=sorted(str(p.relative_to(repo)).replace('\\','/') for p in (repo/'evals/meri/live-v1/tests').glob('case17-*.test.mjs'))
env=dict(os.environ,MERI_WINDOWS_ARTIFACT_TEST_ROOT=str(root/'native-test-storage'),MERI_WINDOWS_ARTIFACT_PYTHON='C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe')
cmd=['C:/Program Files/nodejs/node.exe','--test','--test-concurrency=1',*tests]
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (root/'tests.log').open('wb') as log:
 result=subprocess.run(cmd,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=300)
assert all(sha(repo/f['path'])==f['sha256'] for f in pins)
q={'status':'PASS' if result.returncode==0 else 'FAIL','startedAt':started,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':result.returncode,'command':cmd,'sourceFiles':pins,'testLogSha256':sha(root/'tests.log'),'nativeWindowsBrowserAndStorage':True,'cloudOperations':0,'providerCalls':0,'fullOriginalCase17Acceptance':False,'humanRubric':'NOT_RUN'}
(root/'checkpoint.json').write_text(json.dumps(q,indent=2)+'\n',encoding='utf-8')
print(json.dumps(q));raise SystemExit(result.returncode)
