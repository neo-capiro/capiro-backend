from pathlib import Path
import subprocess,json,hashlib,os,time,concurrent.futures
wt=Path(__file__).resolve().parent.parent.parent
packet=Path(__file__).resolve().parent
ev=packet/'evidence'
source='e50aed3c5b5cce58317b37de442482fa970842cb'
source_tree='711da5c3871ffdc52e4e3ea002531eed909b3c7f'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=wt).decode().strip()==source
assert not Path('/workspace/intelligence-final-api-type-20261013.tsbuildinfo').exists()
node='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
scope=json.loads((packet/'test-scope.json').read_text())
env={'PATH':os.environ['PATH'],'NODE_ENV':'test','TZ':'UTC','TMPDIR':'/tmp','JEST_WORKER_ID':'1'}
commands={
'jest':([node,'--max-old-space-size=6144','/workspace/capirov2/apps/api/node_modules/jest/bin/jest.js','--config',str(packet/'inert-jest.config.cjs'),'--runInBand','--runTestsByPath',*scope['tests'],'--no-cache','--json','--outputFile',str(ev/'jest-results.json')],wt/'apps/api'),
'type':([node,'--max-old-space-size=6144','/workspace/capirov2/node_modules/typescript/bin/tsc','-p',str(wt/'apps/api/tsconfig.json'),'--noEmit','--rootDir','.','--tsBuildInfoFile','/workspace/intelligence-final-api-type-20261013.tsbuildinfo'],wt/'apps/api')}
def run(name):
 cmd,cwd=commands[name];log=ev/(name+'.log');start=time.monotonic()
 with log.open('wb') as out:result=subprocess.run(cmd,cwd=cwd,env=env,stdout=out,stderr=subprocess.STDOUT)
 raw=log.read_bytes();receipt={'sourceHead':source,'sourceTree':source_tree,'command':cmd,'cwd':str(cwd),'exitCode':result.returncode,'elapsedSeconds':round(time.monotonic()-start,3),'logBytes':len(raw),'logSha256':hashlib.sha256(raw).hexdigest(),'scope':'source-only, pure/mocked; no native DB/provider/app startup/install; cache disabled for Jest','inheritedCredentialEnvironment':False}
 (ev/(name+'-receipt.json')).write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps({k:receipt[k] for k in ['sourceHead','exitCode','elapsedSeconds','logBytes']}),flush=True)
 return result.returncode
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 results=list(pool.map(run,['jest','type']))
assert all(x==0 for x in results),results
