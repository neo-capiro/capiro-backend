import subprocess,pathlib,json,hashlib,os,shutil,time,gzip,yaml
base=pathlib.Path('/dev/shm/capiro-pinned-parser-install-20261014/runnable-build');src=base/'source';evidence=base/'evidence';sha=lambda b:hashlib.sha256(b).hexdigest()
report=json.loads(gzip.decompress((evidence/'normal-build.json.gz').read_bytes()));env={'PATH':os.environ['PATH'],'HOME':str(base/'home'),'TMPDIR':str(base/'tmp'),'XDG_CACHE_HOME':str(base/'cache'),'AWS_EC2_METADATA_DISABLED':'true','NODE_OPTIONS':'--max-old-space-size=8192'}
def save():
 with gzip.GzipFile(filename=str(evidence/'normal-build.json.gz'),mode='wb',mtime=0) as f:f.write(json.dumps(report,indent=2).encode()+b'\n')
def run(name,command,cwd,installer=False):
 start=time.monotonic();p=subprocess.run(command,cwd=cwd,env=None if installer else env,capture_output=True,timeout=600)
 row={'name':name,'command':command,'cwd':str(cwd),'exit_code':p.returncode,'seconds':round(time.monotonic()-start,3),'stdout':p.stdout.decode(errors='replace'),'stderr':p.stderr.decode(errors='replace'),'stdout_sha256':sha(p.stdout),'stderr_sha256':sha(p.stderr),'environment':'unchanged inherited normal install' if installer else 'sanitized build,no inherited credentials'};report['commands'].append(row);save();print(json.dumps(row),flush=True);return p
lock=yaml.safe_load((src/'pnpm-lock.yaml').read_text());decl=lock['importers']['apps/workspace'];sharp=decl['dependencies']['sharp'];node=decl['devDependencies']['@types/node'];keys=set()
def collect(name,version):
 key=name+'@'+version
 if key in keys:return
 assert key in lock['snapshots'],key
 keys.add(key)
 for section in ['dependencies','optionalDependencies']:
  for n,v in lock['snapshots'][key].get(section,{}).items():collect(n,v)
collect('sharp',sharp['version']);collect('@types/node',node['version']);package_keys=sorted({k.split('(')[0] for k in keys})
project={'lockfileVersion':lock['lockfileVersion'],'settings':lock['settings'],'importers':{'.':{'dependencies':{'sharp':sharp},'devDependencies':{'@types/node':node}}},'packages':{k:lock['packages'][k] for k in package_keys},'snapshots':{k:lock['snapshots'][k] for k in sorted(keys)}}
projectdir=base/'sharp-install';projectdir.mkdir(exist_ok=True);manifest=json.dumps({'name':'capiro-pinned-sharp-qualification','version':'0.0.0','private':True,'dependencies':{'sharp':sharp['specifier']},'devDependencies':{'@types/node':node['specifier']}}).encode()+b'\n';lockbytes=yaml.safe_dump(project,sort_keys=False).encode();(projectdir/'package.json').write_bytes(manifest);(projectdir/'pnpm-lock.yaml').write_bytes(lockbytes)
report['sharp_projection']={'manifest_sha256':sha(manifest),'lock_sha256':sha(lockbytes),'package_keys':package_keys,'snapshot_keys':sorted(keys),'original_sharp':sharp,'original_node':node};save();print(json.dumps({'sharp_projection':report['sharp_projection']}),flush=True)
p=run('pinned-sharp-install',['pnpm','install','--frozen-lockfile','--ignore-scripts','--ignore-workspace','--registry=https://registry.npmjs.org','--store-dir='+str(base/'store'),'--reporter=append-only','--network-concurrency=1','--fetch-retries=0','--fetch-timeout=30000'],projectdir,True)
if p.returncode:raise SystemExit(p.returncode)
assert (projectdir/'pnpm-lock.yaml').read_bytes()==lockbytes
local={json.loads((src/p/'package.json').read_text())['name']:src/p for p in ['packages/shared','packages/auth','packages/meriv2-core','packages/defense-contracts','packages/defense-domain','packages/strategy-verifier']};linked=[]
for owner in ['apps/api','apps/workspace','apps/api-strategy','apps/intel-api']:
 pkg=json.loads((src/owner/'package.json').read_text())
 for name,spec in pkg.get('dependencies',{}).items():
  if spec.startswith('workspace:'):
   assert name in local,name
   p=src/owner/'node_modules'/name;p.parent.mkdir(parents=True,exist_ok=True)
   if not p.exists():
    if p.is_symlink():p.unlink()
    os.symlink(local[name],p);linked.append({'owner':owner,'dependency':name,'target':str(local[name])})
p=src/'apps/workspace/node_modules/sharp'
assert not p.exists() and not p.is_symlink();os.symlink(projectdir/'node_modules/sharp',p)
report['isolated_input_corrections']={'manifest_declared_workspace_links':linked,'sharp_target':str(projectdir/'node_modules/sharp'),'source_changes':False};save()
for owner in ['apps/workspace','apps/api-strategy']:
 old=src/owner/'dist'
 if old.exists():shutil.move(str(old),str(evidence/(owner.replace('/','-')+'-rejected01-dist')))
 p=run(owner.replace('/','-')+'-normal-build-corrected-inputs',['node',str(src/owner/'node_modules/@nestjs/cli/bin/nest.js'),'build'],src/owner)
 dist=src/owner/'dist';files=[(str(x.relative_to(dist)),x.stat().st_size,sha(x.read_bytes())) for x in sorted(dist.rglob('*')) if x.is_file()];artifact={'owner':owner,'attempt':'corrected-inputs','files':len(files),'bytes':sum(r[1] for r in files),'manifest_sha256':sha(json.dumps(files,separators=(',',':')).encode()),'main_exists':(dist/'main.js').exists()};report['artifacts'].append(artifact);save();print(json.dumps({'artifact':artifact}),flush=True)
 if p.returncode==0:run(owner.replace('/','-')+'-main-syntax-corrected',['node','--check','dist/main.js'],src/owner)
run('workspace-docker-pruned-import-corrected',['node','-e',"const assert=require('node:assert/strict'); const sanitize=require('sanitize-html'); assert.equal(sanitize('<strong>safe</strong><script>unsafe</script>'), '<strong>safe</strong>'); require('./dist/versions/versions.service.js');"],src/'apps/workspace')
print(json.dumps({'completed_corrected_inputs':True,'ref':report['ref'],'tree':report['tree'],'evidence_path':str(evidence/'normal-build.json.gz'),'evidence_bytes':(evidence/'normal-build.json.gz').stat().st_size,'evidence_sha256':sha((evidence/'normal-build.json.gz').read_bytes())}),flush=True)
