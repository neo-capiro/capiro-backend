import datetime, hashlib, json, os, subprocess
from pathlib import Path
repo=Path('C:/dev/main/meri-c1-20261002')
out=Path('C:/dev/main/outputs/meri-c2-20261003/semantic-clock-v1')
env=os.environ.copy(); env['NODE_OPTIONS']='--max-old-space-size=8192'
for name in ['defense-contracts','defense-domain']:
    command=['C:/Users/neoma/AppData/Local/hermes/node/pnpm.cmd','--filter','@capiro/'+name,'build']
    log=out/('existing-'+name+'-build.log')
    started=datetime.datetime.now(datetime.timezone.utc).isoformat()
    with log.open('xb') as stream: result=subprocess.run(command,cwd=repo,env=env,stdout=stream,stderr=subprocess.STDOUT)
    receipt={'command':command,'startedAt':started,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':result.returncode,'logSha256':hashlib.sha256(log.read_bytes()).hexdigest(),'scope':'Existing missing local dependency output; no dependency/source installation or edit'}
    (out/('existing-'+name+'-build.receipt.json')).write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(json.dumps(receipt),flush=True)
    if result.returncode: raise SystemExit(result.returncode)
