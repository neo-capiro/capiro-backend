import pathlib
import subprocess
import json
import hashlib

packet=pathlib.Path(__file__).resolve().parent
root=packet.parents[2]
node='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','TZ':'UTC','CI':'1'}
rows=[]
def run(name,argv,cwd):
    r=subprocess.run(argv,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    (packet/(name+'.stdout.log')).write_bytes(r.stdout)
    (packet/(name+'.stderr.log')).write_bytes(r.stderr)
    row={'name':name,'source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'argv':argv,'cwd':str(cwd),'environment':env,'exitCode':r.returncode,'stdoutSha256':hashlib.sha256(r.stdout).hexdigest(),'stderrSha256':hashlib.sha256(r.stderr).hexdigest()}
    rows.append(row);(packet/'COMMANDS.json').write_text(json.dumps(rows,indent=2)+'\n')
    assert r.returncode==0,(name,r.returncode,r.stderr.decode())
run('all46-web-refused',[node,'--require',str(packet/'no-web-read.cjs'),'/workspace/capirov2/apps/api/node_modules/jest/bin/jest.js','--config',str(packet/'bounded.jest.cjs'),'--runInBand','--no-cache','--json','--outputFile',str(packet/'all46-results.json')],root/'apps/api')
run('skeleton-default-web-refused',[node,'--require',str(packet/'no-web-read.cjs'),'scripts/ci/outreach-skeleton-owned-input.spec.mjs'],root)
print(json.dumps({'ordinaryMockedCommands':len(rows),'allExitZero':True,'frontendModulesExecuted':False,'realDatabaseProviderCommands':False}))
