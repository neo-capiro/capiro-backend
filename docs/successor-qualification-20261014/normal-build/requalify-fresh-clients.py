import subprocess,pathlib,json,hashlib,os,shutil,time,gzip
base=pathlib.Path('/dev/shm/capiro-pinned-parser-install-20261014/runnable-build');src=base/'source';gen=base/'client-generation';ev=base/'evidence';sha=lambda b:hashlib.sha256(b).hexdigest();report={'ref':'afee9c4251c4c21417916bc4a02007283b67543b','tree':'37e0e1c9c8b7986593ff677dbac15d21d3384ac8','commands':[],'inputs':[],'artifacts':[],'limits':['Only Core/Workspace normal builds repeated because stockcurrent clients change their declarations','Strategy/Intel declaration byte equality retains prior ordinarybuild acceptance','No source/options/version changes,service bootstrap,nativePostgres,DB/migration orprovider/AWS actions']}
def save():
 with gzip.GzipFile(filename=str(ev/'fresh-client-requalification.json.gz'),mode='wb',mtime=0) as f:f.write(json.dumps(report,indent=2).encode()+b'\n')
env={'PATH':os.environ['PATH'],'HOME':str(base/'home'),'TMPDIR':str(base/'tmp'),'XDG_CACHE_HOME':str(base/'cache'),'AWS_EC2_METADATA_DISABLED':'true','NODE_OPTIONS':'--max-old-space-size=8192'}
def run(name,command,cwd):
 start=time.monotonic();p=subprocess.run(command,cwd=cwd,env=env,capture_output=True,timeout=600);r={'name':name,'command':command,'cwd':str(cwd),'exit_code':p.returncode,'seconds':round(time.monotonic()-start,3),'stdout':p.stdout.decode(errors='replace'),'stderr':p.stderr.decode(errors='replace'),'stdout_sha256':sha(p.stdout),'stderr_sha256':sha(p.stderr),'environment':'sanitized build withno inheritedcredentials; serial'};report['commands'].append(r);save();print(json.dumps(r),flush=True);return p
for owner in ['api','workspace','api-strategy','intel-api']:
 old=src/'apps'/owner/'generated/prisma-client';new=gen/'node_modules/.prisma/client' if owner=='api' else gen/'apps'/owner/'generated/prisma-client';old_dts=sha((old/'index.d.ts').read_bytes());new_dts=sha((new/'index.d.ts').read_bytes());row={'owner':owner,'historical_index_dts_sha256':old_dts,'fresh_index_dts_sha256':new_dts,'declarations_identical':old_dts==new_dts,'fresh_path':str(new)};report['inputs'].append(row);print(json.dumps({'input':row}),flush=True)
 if owner in ['api-strategy','intel-api']:assert old_dts==new_dts,owner
client=src/'apps/api/node_modules/@prisma/client';assert client.is_symlink();client.unlink();os.symlink(gen/'node_modules/@prisma/client',client)
old=src/'apps/workspace/generated/prisma-client';shutil.move(str(old),str(ev/'workspace-historical-client-input'));shutil.copytree(gen/'apps/workspace/generated/prisma-client',old)
report['core_fresh_client_package']=str(gen/'node_modules/@prisma/client');save()
for owner in ['api','workspace']:
 app=src/'apps'/owner;dist=app/'dist';shutil.move(str(dist),str(ev/('apps-'+owner+'-accepted-historical-client-dist')))
 p=run('apps-'+owner+'-normal-build-fresh-client',['node',str(app/'node_modules/@nestjs/cli/bin/nest.js'),'build'],app)
 files=[(str(f.relative_to(dist)),f.stat().st_size,sha(f.read_bytes())) for f in sorted(dist.rglob('*')) if f.is_file()];artifact={'owner':owner,'files':len(files),'bytes':sum(x[1] for x in files),'manifest_sha256':sha(json.dumps(files,separators=(',',':')).encode()),'main_exists':(dist/'main.js').exists()};report['artifacts'].append(artifact);save();print(json.dumps({'artifact':artifact}),flush=True)
 if p.returncode==0:run('apps-'+owner+'-main-syntax-fresh-client',['node','--check','dist/main.js'],app)
 if p.returncode!=0:break
if all(r['exit_code']==0 for r in report['commands']):run('workspace-docker-pruned-import-fresh-client',['node','-e',"const assert=require('node:assert/strict'); const sanitize=require('sanitize-html'); assert.equal(sanitize('<strong>safe</strong><script>unsafe</script>'), '<strong>safe</strong>'); require('./dist/versions/versions.service.js');"],src/'apps/workspace')
report['complete']=True;save();print(json.dumps({'complete':True,'all_pass':all(r['exit_code']==0 for r in report['commands']),'report_path':str(ev/'fresh-client-requalification.json.gz'),'report_bytes':(ev/'fresh-client-requalification.json.gz').stat().st_size,'report_sha256':sha((ev/'fresh-client-requalification.json.gz').read_bytes())}),flush=True)
