import subprocess,pathlib,json,hashlib,os,shutil,time,gzip
ref='afee9c4251c4c21417916bc4a02007283b67543b';base=pathlib.Path('/dev/shm/capiro-pinned-parser-install-20261014/runnable-build');src=base/'source';cache=pathlib.Path('/workspace/capirov2');parser=base/'parser';evidence=base/'evidence';evidence.mkdir(exist_ok=True)
owners=['packages/shared','packages/auth','packages/meriv2-core','packages/defense-contracts','packages/defense-domain','packages/strategy-verifier','apps/api','apps/workspace','apps/api-strategy','apps/intel-api']
env={'PATH':os.environ['PATH'],'HOME':str(base/'home'),'TMPDIR':str(base/'tmp'),'XDG_CACHE_HOME':str(base/'cache'),'AWS_EC2_METADATA_DISABLED':'true','NODE_OPTIONS':'--max-old-space-size=8192'}
rows=[];artifacts=[];sha=lambda b:hashlib.sha256(b).hexdigest();report={'ref':ref,'tree':'37e0e1c9c8b7986593ff677dbac15d21d3384ac8','commands':rows,'artifacts':artifacts,'limits':['No service init/listen,DB queries/migrations,customer/provider/paid calls,credential copying,AWS operations ornetwork/security changes','Current-client generation/native/image/HTTP/production serving not accepted by cached-client compilation']}
def save():
 raw=json.dumps(report,indent=2).encode()+b'\n'
 with gzip.GzipFile(filename=str(evidence/'normal-build.json.gz'),mode='wb',mtime=0) as f:f.write(raw)
def run(name,command,cwd,timeout=600,installer=False):
 start=time.monotonic();p=subprocess.run(command,cwd=cwd,env=None if installer else env,capture_output=True,timeout=timeout)
 r={'name':name,'command':command,'cwd':str(cwd),'exit_code':p.returncode,'seconds':round(time.monotonic()-start,3),'stdout':p.stdout.decode(errors='replace'),'stderr':p.stderr.decode(errors='replace'),'stdout_sha256':sha(p.stdout),'stderr_sha256':sha(p.stderr),'environment':'ordinary inherited install environment unchanged' if installer else 'sanitized build environment,no inherited credentials'};rows.append(r);save();print(json.dumps(r),flush=True);return p
files=[(str(p.relative_to(src)),p.stat().st_size,sha(p.read_bytes())) for p in sorted(src.rglob('*')) if p.is_file()]
assert len(files)==7378 and sha(json.dumps(files,separators=(',',':')).encode())=='39573dbce761c6d56db515015934b07f04b2fb93f76f9c1b2040b49516364c1a'
report['source']={'files':len(files),'bytes':sum(x[1] for x in files),'manifest_sha256':sha(json.dumps(files,separators=(',',':')).encode()),'archive_sha256':'a5bb430e25b0711a9011497eace54713094b375fdc4450e470da380ef213e2e7','AGENTS':[]};del files
lock_bytes=(parser/'pnpm-lock.yaml').read_bytes();assert sha(lock_bytes)=='33dd57a7b1eda756f4d4c7a5a30bb8c82de0d7611e080ba2a5b81c10d178b5b8';assert sha((parser/'package.json').read_bytes())=='07b52640ed51cb8af9c2efcc49c32bcf53e3848297cad9a2d2c296d27f4ec3c5'
p=run('pinned-parser-install-normal-environment',['pnpm','install','--frozen-lockfile','--ignore-scripts','--ignore-workspace','--registry=https://registry.npmjs.org','--store-dir='+str(base/'store'),'--reporter=append-only','--network-concurrency=1','--fetch-retries=0','--fetch-timeout=30000'],parser,120,True)
if p.returncode:raise SystemExit(p.returncode)
assert (parser/'pnpm-lock.yaml').read_bytes()==lock_bytes
local={json.loads((src/x/'package.json').read_text())['name']:src/x for x in owners};bindings=[]
def bind(cached,target):
 target.mkdir(parents=True,exist_ok=True)
 if not cached.is_dir():return
 for p in sorted(cached.iterdir()):
  if p.name in ['.bin','.pnpm']:continue
  if p.name.startswith('@') and p.is_dir():
   scope=target/p.name;scope.mkdir(exist_ok=True)
   for q in sorted(p.iterdir()):
    name=p.name+'/'+q.name
    if p.name=='@capiro' and name not in local:continue
    if q.exists():dest=local.get(name,pathlib.Path(os.path.realpath(q)));os.symlink(dest,scope/q.name);bindings.append((str(target.relative_to(src)),name,str(dest),'published-local' if name in local else 'cached-npm'))
  elif p.exists():os.symlink(os.path.realpath(p),target/p.name);bindings.append((str(target.relative_to(src)),p.name,os.path.realpath(p),'cached-npm'))
 if (cached/'.pnpm').is_dir():os.symlink(cached/'.pnpm',target/'.pnpm')
bind(cache/'node_modules',src/'node_modules')
for owner in owners:bind(cache/owner/'node_modules',src/owner/'node_modules')
for name in ['htmlparser2','sanitize-html']:
 target=src/'apps/workspace/node_modules'/name
 if target.is_symlink():target.unlink()
 dest=parser/'node_modules'/name if name=='htmlparser2' else cache/'node_modules/.pnpm/sanitize-html@2.17.7/node_modules/sanitize-html';assert dest.exists(),str(dest);os.symlink(dest,target)
target=src/'apps/workspace/node_modules/@types/sanitize-html'
if not target.exists():os.symlink(cache/'node_modules/.pnpm/@types+sanitize-html@2.16.1/node_modules/@types/sanitize-html',target)
generated=[]
for owner,cached in [('apps/api','/tmp/capirov2-local-native-prerequisite-20261012/core-client'),('apps/workspace','/tmp/capirov2-local-native-prerequisite-20261012/workspace-client'),('apps/api-strategy','/workspace/capirov2/apps/api-strategy/generated/prisma-client'),('apps/intel-api','/workspace/capirov2/apps/intel-api/generated/prisma-client')]:
 target=src/owner/'generated/prisma-client';shutil.copytree(cached,target);generated.append({'owner':owner,'cached_path':cached,'cached_schema_sha256':sha((target/'schema.prisma').read_bytes()),'selected_schema_sha256':sha((src/owner/'prisma/schema.prisma').read_bytes())})
 if owner=='apps/api':client=src/owner/'node_modules/@prisma/client';client.unlink();os.symlink(target,client)
report['generated_inputs']=generated;report['dependency_bindings']={'count':len(bindings),'manifest_sha256':sha(json.dumps(bindings,separators=(',',':')).encode()),'workspace_local_count':sum(r[3]=='published-local' for r in bindings),'typescript':json.loads((cache/'node_modules/typescript/package.json').read_text())['version'],'nest_cli':json.loads((cache/'apps/api/node_modules/@nestjs/cli/package.json').read_text())['version'],'node':subprocess.check_output(['node','--version'],text=True).strip(),'pnpm':subprocess.check_output(['pnpm','--version'],text=True).strip(),'repo_pnpm':json.loads((src/'package.json').read_text())['packageManager']};save();print(json.dumps({'generated_inputs':generated,'dependency_bindings':report['dependency_bindings']}),flush=True)
for owner in owners:
 tool='typescript/bin/tsc' if owner.startswith('packages/') else '@nestjs/cli/bin/nest.js';executable=src/owner/'node_modules'/tool
 if not executable.exists():executable=src/'node_modules'/tool
 run(owner.replace('/','-')+'-normal-build',['node',str(executable)]+(['-p','tsconfig.json'] if owner.startswith('packages/') else ['build']),src/owner)
 dist=src/owner/'dist';files=[(str(p.relative_to(dist)),p.stat().st_size,sha(p.read_bytes())) for p in sorted(dist.rglob('*')) if p.is_file()];artifact={'owner':owner,'files':len(files),'bytes':sum(r[1] for r in files),'manifest_sha256':sha(json.dumps(files,separators=(',',':')).encode()),'main_exists':(dist/'main.js').exists() if owner.startswith('apps/') else (dist/'index.js').exists()};artifacts.append(artifact);save();print(json.dumps({'artifact':artifact}),flush=True)
for owner in owners:
 if owner.startswith('apps/') and (src/owner/'dist/main.js').exists():run(owner.replace('/','-')+'-main-syntax',['node','--check','dist/main.js'],src/owner)
run('workspace-docker-pruned-import',['node','-e',"const assert=require('node:assert/strict'); const sanitize=require('sanitize-html'); assert.equal(sanitize('<strong>safe</strong><script>unsafe</script>'), '<strong>safe</strong>'); require('./dist/versions/versions.service.js');"],src/'apps/workspace')
report['complete']=True;save();print(json.dumps({'complete':True,'ref':ref,'tree':report['tree'],'artifacts':artifacts,'results':[{'name':r['name'],'exit_code':r['exit_code'],'seconds':r['seconds']} for r in rows],'evidence_path':str(evidence/'normal-build.json.gz'),'evidence_bytes':(evidence/'normal-build.json.gz').stat().st_size,'evidence_sha256':sha((evidence/'normal-build.json.gz').read_bytes())}),flush=True)
