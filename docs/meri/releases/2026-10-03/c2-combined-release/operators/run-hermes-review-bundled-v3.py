from pathlib import Path
import datetime,hashlib,json,subprocess,sys,shutil
prompt_path=Path(sys.argv[1]);dst=Path(sys.argv[2]);inputs=Path(sys.argv[3]);dst.mkdir(exist_ok=False)
shutil.copytree(inputs,dst/'evidence')
prompt=prompt_path.read_text(encoding='utf-8');(dst/'prompt.txt').write_text(prompt,encoding='utf-8')
start=datetime.datetime.now(datetime.timezone.utc).isoformat();rc=None;failure=None
try:
 with (dst/'response.txt').open('x',encoding='utf-8') as out,(dst/'stderr.log').open('x',encoding='utf-8') as err:
  rc=subprocess.run(['C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/hermes.exe','-z',prompt,'-t','file','--usage-file',str(dst/'usage.json')],cwd=dst,stdout=out,stderr=err,timeout=360,text=True).returncode
except subprocess.TimeoutExpired:rc=124;failure='BOUNDED_REVIEW_TIMEOUT'
(dst/'execution.json').write_text(json.dumps({'startedAt':start,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':rc,'failure':failure,'modelOverride':None,'providerOverride':None,'files':[{'path':str(p.relative_to(dst)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}for p in dst.rglob('*')if p.is_file() and 'evidence' not in p.parts]},indent=2)+'\n',encoding='utf-8')
print(json.dumps({'exitCode':rc,'failure':failure,'directory':str(dst)}))
