import concurrent.futures, hashlib, json, os, pathlib, subprocess, sys, time

repo=pathlib.Path(r'C:\dev\cap-meri-migration-history-guard')
source='eedcc3d3a34aaf1b3b68e8a5093644b20d98a908'
root=pathlib.Path(__file__).parent/'composed-ui-integration-verification'
root.mkdir(exist_ok=False)
node=r'C:\Program Files\nodejs\node.exe'
pnpm=r'C:\Program Files\nodejs\pnpm.cmd'
def git(*args): return subprocess.check_output(['git',*args],cwd=repo,text=True).strip()
assert git('rev-parse','HEAD')==source and not git('status','--porcelain')
env=os.environ.copy()
env.update(MERI_APPROVED_MEMORY_PG_CONFIG=r'C:\dev\cap-meri-foundation-evidence\private\local-postgres.json',NODE_OPTIONS='--max-old-space-size=12288')
offline={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','APPDATA','LOCALAPPDATA','USERPROFILE','HOME'}}
offline.update(PROMPTFOO_DISABLE_TELEMETRY='1',PROMPTFOO_DISABLE_REMOTE_GENERATION='1',PYTHONIOENCODING='utf-8',NPM_CONFIG_OFFLINE='true',TMPDIR=str(root))
checks=[]
def run(job):
    name,args,environment=job; start=time.time(); log=root/(name+'.log')
    with log.open('x',encoding='utf8') as out:
        result=subprocess.run(args,cwd=repo,env=environment,stdout=out,stderr=subprocess.STDOUT)
    value={'name':name,'sourceSha':source,'command':args,'exitCode':result.returncode,'seconds':round(time.time()-start,2),'logSha256':hashlib.sha256(log.read_bytes()).hexdigest()}
    print(json.dumps(value),flush=True)
    return value
def p(name,*args):return (name,[pnpm,*args],env)
checks.append(run(p('shared-build','--filter','@capiro/shared','build')))
if checks[-1]['exitCode']==0:checks.append(run(p('core-build','--filter','@capiro/meriv2-core','build')))
if all(c['exitCode']==0 for c in checks):
    nodefiles=['controlled-read-definitions','controlled-read-owner','controlled-read-authority','grade-case01-capture','controlled-read.postgres','case01-execution-setup.postgres','capture-provider-budget-install.postgres','capture-provider-budget.postgres','case01-operator-input','case01-memory-packaging','case17-memory-ui','memory-pending-fixture-plan','memory-pending-execution.postgres','own-pending-proposals.postgres']
    jobs=[('node-integration',[node,'--test',*['evals/meri/live-v1/tests/'+f+'.test.mjs' for f in nodefiles]],env),
      p('api-types','--filter','@capiro/api','exec','tsc','--noEmit','--rootDir','.'),
      p('orchestrator-types','--filter','@capiro/meriv2-orchestrator','typecheck'),
      p('api-regression','--filter','@capiro/api','exec','jest','--runInBand','--forceExit',*['src/meri/'+f+'.spec.ts' for f in ['meri-capture-api-provider-scope','meri-capture-provider-budget','meri-server-readonly-capture','meri-source.service','meri-source-outcome-contract','meri-tools.defense-budget','meri-case01-capture-authority','meri-docgen.helpers','meri-document-artifact','meri-text-artifact.helpers','meri-artifact-integrity']], 'src/memory/governed-memory-candidate.service.spec.ts'),
      p('orchestrator-regression','--filter','@capiro/meriv2-orchestrator','exec','jest','--runInBand','--forceExit','src/meri/controlled-read-observations.spec.ts','src/meri/api-tool-executor.repo.spec.ts','src/meri/meriv3/meriv3-capture-evidence.spec.ts','src/meri/meriv3/meriv3-run-budget.spec.ts','src/meri/meriv3/meriv3-semantic-compatibility-tools.spec.ts'),
      p('web-source','--filter','@capiro/web','exec','vitest','run','--poolOptions.threads.singleThread','src/vnext/meri/meri-source-api.test.ts','src/vnext/meri/MeriMemoryTab.targets.test.tsx','src/vnext/meri/MeriArtifactCanvas.test.tsx','src/components/chat/meri-artifact-download.test.ts'),
      p('web-types','--filter','@capiro/web','typecheck'),
      ('promptfoo',[node,'node_modules/promptfoo/dist/src/entrypoint.js','eval','-c','evals/meri/promptfooconfig.yaml','--no-cache','--no-share','--no-write','--no-table','--no-progress-bar','-o',str(root/'meri-offline.json')],offline)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: checks.extend(pool.map(run,jobs))
    if next(c for c in checks if c['name']=='promptfoo')['exitCode']==0:
        checks.append(run(('custom-verifier',[sys.executable,'evals/meri/verify_report.py',str(root/'meri-offline.json'),str(root/'meri-offline.summary.json')],offline)))
result={'sourceSha':source,'policySha':'39590a3bfc57ce03b0411ff7912a7c8d99deb70c','machineMapRevision':'2026-09-30T00:21:48Z','checks':checks,'sourceUnchanged':git('rev-parse','HEAD')==source,'worktreeStatus':git('status','--porcelain'),'liveAcceptance':'NOT_RUN'}
result['exitCode']=0 if len(checks)==11 and all(c['exitCode']==0 for c in checks) and result['sourceUnchanged'] and not result['worktreeStatus'] else 1
(root/'qualification.json').write_text(json.dumps(result,indent=2),encoding='utf8')
sys.exit(result['exitCode'])
