# Executes only explicit source checks with a finite credential-free environment.
import base64,hashlib,json,os,subprocess,sys,time
from pathlib import Path
root=Path(__file__).resolve().parents[2]
e=root/'docs/backend-cleanup-receiving-20261014/evidence'
label=sys.argv[1]; cwd=root/sys.argv[2]; argv=sys.argv[3:]
assert label.replace('-','').isalnum() and argv
fence=str(root/'docs/backend-cleanup-receiving-20261014/source-only-fence.cjs')
env={'PATH':os.environ['PATH'],'NODE_ENV':'test','CI':'true','AWS_EC2_METADATA_DISABLED':'true','NODE_OPTIONS':'--require='+fence,'TMPDIR':str(root/'.qualification-cache/tmp')}
Path(env['TMPDIR']).mkdir(parents=True,exist_ok=True)
started=time.monotonic()
r=subprocess.run(argv,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
duration=round(time.monotonic()-started,3)
raw={'format':'lossless-source-check-observation/v1','encoding':'base64','bytes':len(r.stdout),'sha256':hashlib.sha256(r.stdout).hexdigest(),'data':base64.b64encode(r.stdout).decode()}
(e/(label+'-output.raw.json')).write_text(json.dumps(raw,indent=2)+'\n')
receipt={'label':label,'cwd':str(cwd.relative_to(root)),'argv':argv,'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip(),'source_tree':subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=root).decode().strip(),'environment':env,'exit_code':r.returncode,'duration_seconds':duration,'output_sha256':raw['sha256'],'source_only':True,'live_db_provider_or_customer_operation':False}
(e/(label+'-receipt.json')).write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:receipt[k] for k in ['label','exit_code','duration_seconds','output_sha256']}))
if r.returncode: print(r.stdout.decode(errors='replace')[-4500:])
sys.exit(r.returncode)
