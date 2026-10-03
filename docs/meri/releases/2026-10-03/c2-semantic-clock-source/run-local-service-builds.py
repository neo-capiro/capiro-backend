import datetime, hashlib, json, os, subprocess
from pathlib import Path
repo=Path('C:/dev/main/meri-c1-20261002')
out=Path('C:/dev/main/outputs/meri-c2-20261003/semantic-clock-v1')
checkpoint=json.loads((out/'stage-c2-checkpoint.json').read_bytes())
sha=lambda b:hashlib.sha256(b).hexdigest()
for row in checkpoint['files']:
    assert sha((repo/row['path']).read_bytes())==row['sha256'], row['path']
env=os.environ.copy()
env['NODE_OPTIONS']='--max-old-space-size=8192'
for service in ['api','meriv2-orchestrator']:
    log=out/('stage-c2-local-'+service+'-build.log')
    command=['C:/Users/neoma/AppData/Local/hermes/node/pnpm.cmd','--filter','@capiro/'+service,'build']
    start=datetime.datetime.now(datetime.timezone.utc).isoformat()
    with log.open('xb') as stream:
        result=subprocess.run(command,cwd=repo,env=env,stdout=stream,stderr=subprocess.STDOUT)
    record={'command':command,'exitCode':result.returncode,'startedAt':start,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCheckpointSha256':sha((out/'stage-c2-checkpoint.json').read_bytes()),'logSha256':sha(log.read_bytes()),'limitations':'Local service compilation; not immutable native image or served acceptance'}
    (out/('stage-c2-local-'+service+'-build.receipt.json')).write_text(json.dumps(record,indent=2)+'\n',encoding='utf-8',newline='\n')
    print(json.dumps({'service':service,'exitCode':result.returncode,'logSha256':record['logSha256']}),flush=True)
    if result.returncode: break
for row in checkpoint['files']:
    assert sha((repo/row['path']).read_bytes())==row['sha256'], row['path']
raise SystemExit(result.returncode)
