import pathlib,subprocess,json,hashlib,gzip,yaml,time,os
base=pathlib.Path('/dev/shm/capiro-pinned-parser-install-20261014/container-qualification-dd02');src=base/'source';old=pathlib.Path('/dev/shm/capiro-pinned-parser-install-20261014/runnable-build/source');tools=base/'tools';tools.mkdir(exist_ok=True);sha=lambda b:hashlib.sha256(b).hexdigest();report={'source_ref':'dd02f3ba0b4ab77e3725e83e4b9af27aecdc8eca','source_tree':'03d6508d021825621f921aa37a5da6d235bb63e0','commands':[],'scope':'Exact pnpm9.12 dependency-link probe; lifecycle scripts ignored only here,not image/native/generation acceptance. No DB/migration/provider orDocker writes.'}
def save():
 with gzip.GzipFile(filename=str(base/'pnpm9-production.json.gz'),mode='wb',mtime=0) as f:f.write(json.dumps(report,indent=2).encode()+b'\n')
def run(name,command,cwd):
 start=time.monotonic();p=subprocess.run(command,cwd=cwd,capture_output=True,text=True,timeout=120);r={'name':name,'command':command,'cwd':str(cwd),'exit_code':p.returncode,'seconds':round(time.monotonic()-start,3),'stdout':p.stdout,'stderr':p.stderr,'stdout_sha256':sha(p.stdout.encode()),'stderr_sha256':sha(p.stderr.encode())};report['commands'].append(r);save();print(json.dumps(r),flush=True);return p
p=run('normal-registry-pnpm9-install',['npm','install','--prefix',str(tools),'--cache',str(base/'npm-cache'),'--ignore-scripts','--registry=https://registry.npmjs.org','pnpm@9.12.0'],base)
if p.returncode:raise SystemExit(p.returncode)
cli=tools/'node_modules/pnpm/bin/pnpm.cjs';p=run('pnpm-version',['node',str(cli),'--version'],base);assert p.returncode==0 and p.stdout.strip()=='9.12.0'
lock=yaml.safe_load((old/'pnpm-lock.yaml').read_text());decl=lock['importers']['apps/api'];client=decl['dependencies']['@prisma/client'];prisma=decl['devDependencies']['prisma'];keys=set()
def collect(n,v):
 k=n+'@'+v
 if k in keys:return
 assert k in lock['snapshots'],k
 keys.add(k)
 for group in ['dependencies','optionalDependencies']:
  for child,version in lock['snapshots'][k].get(group,{}).items():collect(child,version)
collect('@prisma/client',client['version']);collect('prisma',prisma['version']);pkgkeys=sorted({k.split('(')[0] for k in keys});project={'lockfileVersion':lock['lockfileVersion'],'settings':lock['settings'],'importers':{'.':{'dependencies':{'@prisma/client':client},'devDependencies':{'prisma':prisma}}},'packages':{k:lock['packages'][k] for k in pkgkeys},'snapshots':{k:lock['snapshots'][k] for k in sorted(keys)}};probe=base/'production-link-probe';probe.mkdir(exist_ok=True);manifest={'name':'capiro-prisma-prod-link-probe','version':'0.0.0','private':True,'dependencies':{'@prisma/client':client['specifier']},'devDependencies':{'prisma':prisma['specifier']}};raw=json.dumps(manifest).encode()+b'\n';lockraw=yaml.safe_dump(project,sort_keys=False).encode();(probe/'package.json').write_bytes(raw);(probe/'pnpm-lock.yaml').write_bytes(lockraw);report['projection']={'package_sha256':sha(raw),'lock_sha256':sha(lockraw),'snapshot_keys':sorted(keys),'packages':pkgkeys,'declared_client':client,'declared_prisma':prisma};save()
for name,args in [('development-install',[]),('production-install',['--prod'])]:
 p=run(name,['node',str(cli),'install','--frozen-lockfile','--ignore-scripts','--registry=https://registry.npmjs.org','--store-dir='+str(base/'pnpm9-store'),'--reporter=append-only','--network-concurrency=1','--fetch-retries=0','--fetch-timeout=30000',*args],probe)
 paths=['node_modules/prisma/build/index.js','node_modules/@prisma/client/package.json'];state={'name':name,'direct_files':{q:(probe/q).is_file() for q in paths},'prisma_link':(probe/'node_modules/prisma').is_symlink(),'client_link':(probe/'node_modules/@prisma/client').is_symlink()};report.setdefault('link_states',[]).append(state);save();print(json.dumps(state),flush=True)
 assert (probe/'pnpm-lock.yaml').read_bytes()==lockraw
 if p.returncode:raise SystemExit(p.returncode)
report['complete']=True;save();print(json.dumps({'complete':True,'receipt':str(base/'pnpm9-production.json.gz'),'bytes':(base/'pnpm9-production.json.gz').stat().st_size,'sha256':sha((base/'pnpm9-production.json.gz').read_bytes())}),flush=True)
