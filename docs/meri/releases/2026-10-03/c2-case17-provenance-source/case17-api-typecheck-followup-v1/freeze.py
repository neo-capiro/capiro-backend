from pathlib import Path
import hashlib,json,subprocess,datetime
repo=Path('C:/dev/main/meri-c1-20261002');out=Path(__file__).parent
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
prepared=json.loads((out/'preparation.json').read_text())
for f in prepared['files']:
    assert sha(repo/f['path'])==f['sha256']==sha(f['source'])
old=out.parent/'case17-provenance-native-v1/checkpoint.json'
assert sha(old)=='c7bd52428514ac1e826b1a7b8b2e16e1f4681e4a5afc65e56a301f848f4b0032'
oldData=json.loads(old.read_text())
for f in oldData['files']:assert sha(f['path'])==f['sha256']==sha(f['mirror'])
result=subprocess.run(['git','diff','--check','--',*[f['path'] for f in prepared['files']]],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
assert result.returncode==0;(out/'diff-check.log').write_bytes(result.stdout)
checks=[{'command':'pnpm -C apps/api exec jest src/meri/meri-capture-clock-packets.spec.ts src/meri/meri-memory-proposal-read.spec.ts --runInBand --forceExit','cwd':str(repo),'exitCode':0,'tests':{'pass':65,'fail':0,'suites':2},'log':str(out/'api-jest-final.log'),'sha256':sha(out/'api-jest-final.log')},{'command':'node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit --rootDir . --incremental false','cwd':str(repo/'apps/api'),'exitCode':0,'log':str(out/'api-typecheck-final.log'),'sha256':sha(out/'api-typecheck-final.log')}]
assert (out/'api-typecheck-final.log').stat().st_size==0
checkpoint={'status':'PASS','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':prepared['files'],'sourcePatchSha256':sha(out/'candidate.patch'),'checks':checks,'runtimeEquivalent':{'proof':str(out/'runtime-equivalence.json'),'sha256':sha(out/'runtime-equivalence.json'),'emittedJavaScriptByteIdentical':True},'priorCase17Checkpoint':{'path':str(old),'sha256':sha(old),'allFiveLiveAndMirrorHashesUnchanged':True},'priorErrorsRetainedAt':str(out.parent/'case17-provenance-native-v1/api-typecheck-final.log'),'productionChanges':False,'limits':['Two test files only; existing test cases, assertions and runtime bytes unchanged.','No deployment, cloud, provider, auth, fixture, journal or original rubric acceptance.','Focused Jest and full API typecheck use actual installed native tools; known ts-jest hybrid-module warnings retained.'],'evidence':[]}
for p in sorted(out.iterdir()):
    if p.is_file() and p.name!='checkpoint.json':checkpoint['evidence'].append({'path':str(p),'sha256':sha(p),'bytes':p.stat().st_size})
(out/'checkpoint.json').write_bytes((json.dumps(checkpoint,indent=2)+'\n').encode())
print(json.dumps({'checkpointSha256':sha(out/'checkpoint.json'),'files':prepared['files']}))
