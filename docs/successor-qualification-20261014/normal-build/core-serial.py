import subprocess,pathlib,json,hashlib,os,shutil,time,gzip
base=pathlib.Path('/dev/shm/capiro-pinned-parser-install-20261014/runnable-build');src=base/'source';evidence=base/'evidence';report=json.loads(gzip.decompress((evidence/'normal-build.json.gz').read_bytes()));sha=lambda b:hashlib.sha256(b).hexdigest()
def counters():
 paths=['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.peak','/sys/fs/cgroup/memory.events'];return {p:pathlib.Path(p).read_text().strip() if pathlib.Path(p).exists() else 'absent' for p in paths}
def save():
 with gzip.GzipFile(filename=str(evidence/'normal-build.json.gz'),mode='wb',mtime=0) as f:f.write(json.dumps(report,indent=2).encode()+b'\n')
env={'PATH':os.environ['PATH'],'HOME':str(base/'home'),'TMPDIR':str(base/'tmp'),'XDG_CACHE_HOME':str(base/'cache'),'AWS_EC2_METADATA_DISABLED':'true','NODE_OPTIONS':'--max-old-space-size=8192'}
report['core_serial_memory_before']=counters();save();print(json.dumps({'core_serial_memory_before':report['core_serial_memory_before']}),flush=True)
owner='apps/api';dist=src/owner/'dist'
if dist.exists():shutil.move(str(dist),str(evidence/'apps-api-rejected01-dist'))
command=['node',str(src/owner/'node_modules/@nestjs/cli/bin/nest.js'),'build'];start=time.monotonic();p=subprocess.run(command,cwd=src/owner,env=env,capture_output=True,timeout=600)
row={'name':'apps-api-normal-build-serial','command':command,'cwd':str(src/owner),'exit_code':p.returncode,'seconds':round(time.monotonic()-start,3),'stdout':p.stdout.decode(errors='replace'),'stderr':p.stderr.decode(errors='replace'),'stdout_sha256':sha(p.stdout),'stderr_sha256':sha(p.stderr),'environment':'sanitized build,no inherited credentials; no other root-heavy compiler active'};report['commands'].append(row);report['core_serial_memory_after']=counters();save();print(json.dumps(row),flush=True);print(json.dumps({'core_serial_memory_after':report['core_serial_memory_after']}),flush=True)
files=[(str(f.relative_to(dist)),f.stat().st_size,sha(f.read_bytes())) for f in sorted(dist.rglob('*')) if f.is_file()];artifact={'owner':owner,'attempt':'serial','files':len(files),'bytes':sum(x[1] for x in files),'manifest_sha256':sha(json.dumps(files,separators=(',',':')).encode()),'main_exists':(dist/'main.js').exists()};report['artifacts'].append(artifact);save();print(json.dumps({'artifact':artifact}),flush=True)
if p.returncode==0 and (dist/'main.js').exists():
 command=['node','--check','dist/main.js'];start=time.monotonic();check=subprocess.run(command,cwd=src/owner,env=env,capture_output=True)
 row={'name':'apps-api-main-syntax-serial','command':command,'cwd':str(src/owner),'exit_code':check.returncode,'seconds':round(time.monotonic()-start,3),'stdout':check.stdout.decode(errors='replace'),'stderr':check.stderr.decode(errors='replace'),'stdout_sha256':sha(check.stdout),'stderr_sha256':sha(check.stderr),'environment':'sanitized syntax-only,no inherited credentials'};report['commands'].append(row);save();print(json.dumps(row),flush=True)
print(json.dumps({'complete_serial_retry':True,'ref':report['ref'],'tree':report['tree'],'evidence_bytes':(evidence/'normal-build.json.gz').stat().st_size,'evidence_sha256':sha((evidence/'normal-build.json.gz').read_bytes()),'evidence_path':str(evidence/'normal-build.json.gz')}),flush=True)
