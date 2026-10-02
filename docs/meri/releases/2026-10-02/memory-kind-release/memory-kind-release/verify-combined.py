import hashlib,json,os,pathlib,subprocess,sys,time
root=pathlib.Path(__file__).parent
repo=pathlib.Path(r'C:\dev\cap-meri-fixture-hardening')
source='42988dae5fb7bc2fff3af582ca15a0836a4477c5'
node=r'C:\Program Files\nodejs\node.exe'
pnpm=r'C:\Program Files\nodejs\pnpm.cmd'
def git(*args): return subprocess.check_output(['git',*args],cwd=repo,text=True).strip()
assert git('rev-parse','HEAD')==source and not git('status','--porcelain')
env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','APPDATA','LOCALAPPDATA','USERPROFILE','HOME'}}
env.update(PROMPTFOO_DISABLE_TELEMETRY='1',PROMPTFOO_DISABLE_REMOTE_GENERATION='1',PYTHONIOENCODING='utf-8',NPM_CONFIG_OFFLINE='true',NODE_OPTIONS='--max-old-space-size=8192',TMPDIR=str(root),MERI_APPROVED_MEMORY_PG_CONFIG=r'C:\dev\cap-meri-foundation-evidence\private\local-postgres.json',MERI_WINDOWS_ARTIFACT_TEST_ROOT=str(root/'native-storage-tests'),MERI_WINDOWS_ARTIFACT_PYTHON=sys.executable)
tests=repo/'evals/meri/live-v1/tests'
jobs={
 'builds':[
  ('shared-build',[pnpm,'--filter','@capiro/shared','run','build']),
  ('core-build',[pnpm,'--filter','@capiro/meriv2-core','run','build'])],
 'core':[
  ('core-evidence-tests',[node,'packages/meriv2-core/node_modules/jest/bin/jest.js','--config','packages/meriv2-core/jest.config.cjs','--runInBand','--runTestsByPath','packages/meriv2-core/src/assurance/evidence-plan.spec.ts','packages/meriv2-core/src/assurance/assurance.spec.ts'])],
 'native':[
  ('native-capture-tests',[node,'--experimental-test-module-mocks','--test','--test-concurrency=1',*[str(tests/p) for p in ['case46-receipt-joins.test.mjs','case46-native-composition.test.mjs','case46-artifact-evidence.test.mjs','case46-artifact-ui.test.mjs','capture-spend-aggregate.test.mjs','controlled-read-operator.test.mjs','controlled-read-authority.test.mjs','controlled-read-owner.test.mjs','case01-operator-input.test.mjs','grade-case01-capture.test.mjs']],r'C:\dev\cap-meri-foundation-evidence\oct02-case46-operator\case46-operator-gates.test.mjs'])],
 'pg':[
  ('owned-postgres-tests',[node,'--test','--test-concurrency=1',*[str(tests/p) for p in ['case01-execution-setup.postgres.test.mjs','case01-recovery-real-transactions.test.mjs','case01-memory-packaging.test.mjs']],str(repo/'apps/api/scripts/verify-memory-version-kind-migration.test.mjs')])],
 'offline':[
  ('promptfoo',[node,'node_modules/promptfoo/dist/src/entrypoint.js','eval','-c','evals/meri/promptfooconfig.yaml','--no-cache','--no-share','--no-write','--no-table','--no-progress-bar','-o',str(root/'meri-offline.json')]),
  ('verifier',[sys.executable,'evals/meri/verify_report.py',str(root/'meri-offline.json'),str(root/'meri-offline.summary.json')])]
}
kind=sys.argv[1]
for name,args in jobs[kind]:
 assert git('rev-parse','HEAD')==source
 start=time.time()
 with (root/(name+'.log')).open('x',encoding='utf-8') as log:
  p=subprocess.Popen(args,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT)
  try: code=p.wait(timeout=300)
  except subprocess.TimeoutExpired: p.kill();p.wait();code=124
 receipt={'name':name,'sourceSha':source,'command':args,'cwd':str(repo),'exitCode':code,'elapsedSeconds':round(time.time()-start,2),'logSha256':hashlib.sha256((root/(name+'.log')).read_bytes()).hexdigest(),'sourceUnchanged':git('rev-parse','HEAD')==source}
 (root/(name+'.exit.json')).write_text(json.dumps(receipt,indent=2))
 print(json.dumps(receipt),flush=True)
 if code:sys.exit(code)
