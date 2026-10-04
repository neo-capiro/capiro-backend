from pathlib import Path
import hashlib,json,datetime
root=Path(__file__).resolve().parent
repo=Path('C:/dev/main/meri-c1-20261002')
out=root/'case12-root-qualification-v1'
comparison=json.loads((root/'case12-eligibility-final-source-repo-comparison-v1/comparison.json').read_bytes())
pins=[]
for row in comparison['results']:
 data=(repo/row['path']).read_bytes()
 assert hashlib.sha256(data).hexdigest()==row['repoSha256'],row['path']
 pins.append({'path':row['path'],'bytes':len(data),'sha256':row['repoSha256']})
def log(name):
 data=(out/name).read_bytes()
 return {'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
assert '73 passed, 73 total' in (out/'api-focused-v2.log').read_text(encoding='utf-8')
assert 'pass 36' in (out/'inventory-owner.log').read_text(encoding='utf-8')
assert (out/'api-typecheck-v2.log').stat().st_size==0
assert 'heap' in (out/'api-typecheck.log').read_text(encoding='utf-8').lower()
assert 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG' in (out/'api-focused.log').read_text(encoding='utf-8')
value={'kind':'lead-integrated-case12-source-qualification','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'status':'PASS_SOURCE_TESTS_TYPECHECK','sourceBase':'015514e894945a75c9a10ba2a55b2986c5cb3cd6','sourceFiles':pins,
 'tests':[
  {'name':'API helper, existing adapter and PGlite database regressions','exitCode':0,'suites':3,'passed':73,'failed':0,'skipped':0,
   'command':'node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand --forceExit --runTestsByPath src/retrieval/adapters/governed-memory-eligibility.helpers.spec.ts src/retrieval/adapters/institutional-knowledge-retrieval.adapter.spec.ts src/retrieval/adapters/institutional-knowledge-retrieval.adapter.pglite.spec.ts','cwd':'apps/api','log':log('api-focused-v2.log')},
  {'name':'Case12 inventory owner and native definitions','exitCode':0,'passed':36,'failed':0,'skipped':0,
   'command':'node --test evals/meri/live-v1/tests/case12-memory-inventory-owner.test.mjs evals/meri/live-v1/tests/approved-memory-runtime.test.mjs','cwd':'.','log':log('inventory-owner.log')},
  {'name':'Full API TypeScript check including specs','exitCode':0,'diagnostics':0,
   'command':'node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit --incremental false --rootDir .','cwd':'apps/api','log':log('api-typecheck-v2.log')}
 ],
 'retainedFailedAttempts':[
  {'name':'Initial Jest command omitted Node VM module flag required by PGlite','exitCode':1,'log':log('api-focused.log')},
  {'name':'Initial full API typecheck exhausted default local Node heap','exitCode':134,'log':log('api-typecheck.log')}
 ],
 'nodeVersion':'v24.19.0','providerCalls':0,'cloudCalls':0,'captureAuthority':False,'fixtureReady':False,'liveAcceptance':'NOT_RUN',
 'limits':['Mocked owner tests and PGlite tests do not prove original live Case12 readiness.','Separate actual PostgreSQL qualification and final independent review are recorded in their own receipts.','No application image was built or deployed for these new Case12 source changes.']}
with (out/'qualification.json').open('x',encoding='utf-8') as f:json.dump(value,f,indent=2);f.write('\n')
print(json.dumps({'status':value['status'],'sourceFiles':len(pins),'sha256':hashlib.sha256((out/'qualification.json').read_bytes()).hexdigest()}))
