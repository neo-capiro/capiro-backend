from pathlib import Path
import subprocess,json,os,time,sys,hashlib
root=Path(__file__).resolve().parents[2]
packet=Path(__file__).resolve().parent
node='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
kind=sys.argv[1]
env={'PATH':'/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin','TZ':'UTC'}
selection=json.loads((packet/'JEST-SELECTION.json').read_text())
extra=None
if kind=='type':
 command=[node,'--max-old-space-size=6144','/workspace/capirov2/node_modules/typescript/bin/tsc','-p',str(root/'apps/api/tsconfig.json'),'--noEmit','--rootDir','.', '--tsBuildInfoFile','/tmp/finding-review-api-type-20261013.tsbuildinfo']; cwd=root/'apps/api'
elif kind=='build':
 extra=root/'apps/api/.finding-review-receiving-build.tsconfig.json'
 config={'extends':'./tsconfig.build.json','compilerOptions':{'outDir':'/tmp/finding-review-api-build-20261013','tsBuildInfoFile':'/tmp/finding-review-api-build-20261013.tsbuildinfo'}}
 extra.write_text(json.dumps(config,indent=2)+'\n');(packet/'build-config.json').write_text(extra.read_text())
 command=[node,'--max-old-space-size=4096','/workspace/capirov2/apps/api/node_modules/@nestjs/cli/bin/nest.js','build','--path',extra.name];cwd=root/'apps/api'
elif kind=='jest':
 env.update({'NODE_ENV':'test','LEARNING_TENANTS':'11111111-1111-4111-8111-111111111111'})
 command=[node,'--require',str(packet/'deny-source-effects.cjs'),'/workspace/capirov2/apps/api/node_modules/jest/bin/jest.js','--config',str(packet/'inert-jest.config.cjs'),'--runInBand','--no-cache','--runTestsByPath',*selection['testPaths'],'--json','--outputFile',str(packet/'evidence/jest-results.json')];cwd=root/'apps/api'
elif kind=='node':
 command=[node,'--test',str(root/'scripts/ci/newsletter-accepted-source-profile.spec.mjs')];cwd=root
else:raise SystemExit('unknown check')
start=time.monotonic(); logfile=packet/('evidence/'+kind+'.log')
try:
 with logfile.open('wb') as f: result=subprocess.run(command,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT)
finally:
 if extra is not None:extra.unlink(missing_ok=True)
receipt={'schemaVersion':1,'check':kind,'command':command,'cwd':str(cwd),'sourceHead':selection['sourceHead'],'sourceTree':selection['sourceTree'],'elapsedSeconds':round(time.monotonic()-start,3),'exitCode':result.returncode,'scope':'receiving source/pure/mocked only; no install, generation, native DB, provider, AppModule or deployment','log':str(logfile.relative_to(root)),'logBytes':logfile.stat().st_size,'logSha256':hashlib.sha256(logfile.read_bytes()).hexdigest()}
(packet/('evidence/'+kind+'-receipt.json')).write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt));sys.exit(result.returncode)
