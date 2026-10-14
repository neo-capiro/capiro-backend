import subprocess,pathlib,json,hashlib,os,shutil,time,gzip,re,signal
base=pathlib.Path('/dev/shm/capiro-pinned-parser-install-20261014/runnable-build');source=base/'source';gen=base/'client-generation';gen.mkdir(exist_ok=True);nm=gen/'node_modules';nm.mkdir(exist_ok=True);cache=pathlib.Path('/workspace/capirov2');sha=lambda b:hashlib.sha256(b).hexdigest();report={'ref':'afee9c4251c4c21417916bc4a02007283b67543b','tree':'37e0e1c9c8b7986593ff677dbac15d21d3384ac8','commands':[],'inputs':[],'schemas':[],'outputs':[],'limits':['Stock built-in client generation only,unchanged schemas/generator/binary targets','No database URL orprovider credentials inherited,no DB/migration/SQL/introspection,service init orprovider/AWS calls','All tool/client/output/cache paths within owned generation subtree; no borrowed-cache writes orengine/checksum/proxy bypass','Source generation is not native/Postgres/RLS/HTTP acceptance']}
for p in ['home','tmp','cache']:(gen/p).mkdir(exist_ok=True)
def save():
 with gzip.GzipFile(filename=str(gen/'generation.json.gz'),mode='wb',mtime=0) as f:f.write(json.dumps(report,indent=2).encode()+b'\n')
original={}
for name in ['prisma','@prisma/client','@prisma/engines','@prisma/fetch-engine','@prisma/get-platform','@prisma/debug','@prisma/engines-version']:
 direct=cache/'apps/api/node_modules'/name
 if direct.is_dir():p=pathlib.Path(os.path.realpath(direct))
 else:
  matches=list((cache/'node_modules/.pnpm').glob(name.replace('/','+')+'@*/node_modules/'+name));assert len(matches)==1,(name,matches);p=matches[0]
 original[name]=p;pkg=json.loads((p/'package.json').read_text());target=nm/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(p,target,symlinks=False)
 files=[(str(q.relative_to(target)),q.stat().st_size,sha(q.read_bytes())) for q in sorted(target.rglob('*')) if q.is_file()];report['inputs'].append({'name':name,'version':pkg['version'],'cached_path':str(p),'owned_path':str(target),'file_count':len(files),'bytes':sum(x[1] for x in files),'manifest_sha256':sha(json.dumps(files,separators=(',',':')).encode()),'dependencies':pkg.get('dependencies',{})})
for row in report['inputs']:
 assert all(n in original for n in row['dependencies']),row
for p in nm.rglob('*'):assert not p.is_symlink(),str(p)
(gen/'package.json').write_bytes((source/'package.json').read_bytes())
env={'PATH':os.environ['PATH'],'HOME':str(gen/'home'),'TMPDIR':str(gen/'tmp'),'XDG_CACHE_HOME':str(gen/'cache'),'XDG_DATA_HOME':str(gen/'cache'),'CHECKPOINT_DISABLE':'1','PRISMA_HIDE_UPDATE_MESSAGE':'1','NODE_OPTIONS':'--max-old-space-size=8192'}
for k in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','npm_config_cafile','NPM_CONFIG_CAFILE']:
 if k in os.environ:env[k]=os.environ[k]
for owner in ['api','workspace','api-strategy','intel-api']:
 app=gen/'apps'/owner;prisma=app/'prisma';prisma.mkdir(parents=True,exist_ok=True);text=(source/'apps'/owner/'prisma/schema.prisma').read_text();blocks=re.findall(r'generator\s+\w+\s*\{[^}]*\}',text,re.S);assert len(blocks)==1 and all(re.search(r'provider\s*=\s*"prisma-client-js"',b) for b in blocks),blocks
 (prisma/'schema.prisma').write_text(text);(app/'package.json').write_bytes((source/'apps'/owner/'package.json').read_bytes());(app/'node_modules/@prisma').mkdir(parents=True,exist_ok=True)
 os.symlink(nm/'prisma',app/'node_modules/prisma');os.symlink(nm/'@prisma/client',app/'node_modules/@prisma/client')
 report['schemas'].append({'owner':owner,'path':str(prisma/'schema.prisma'),'sha256':sha(text.encode()),'generators':blocks});save()
command=['node',str(nm/'prisma/build/index.js'),'generate','--schema','prisma/schema.prisma']
for owner in ['api','workspace','api-strategy','intel-api']:
 app=gen/'apps'/owner;start=time.monotonic();p=subprocess.Popen(command,cwd=app,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True);timed_out=False
 try:out,err=p.communicate(timeout=120)
 except subprocess.TimeoutExpired:
  timed_out=True;os.killpg(p.pid,signal.SIGTERM)
  try:out,err=p.communicate(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);out,err=p.communicate()
 row={'owner':owner,'command':command,'cwd':str(app),'exit_code':p.returncode,'timed_out':timed_out,'seconds':round(time.monotonic()-start,3),'stdout':out.decode(errors='replace'),'stderr':err.decode(errors='replace'),'stdout_sha256':sha(out),'stderr_sha256':sha(err),'environment':'Sanitized generation environment; existing proxy/trust reused unchanged; no DB/provider credentials; checkpoint/update notices suppressed'};report['commands'].append(row);save();print(json.dumps(row),flush=True)
 if p.returncode!=0 or timed_out:report['stopped_on_failure']=owner;save();break
 target=nm/'.prisma/client' if owner=='api' else app/'generated/prisma-client'
 assert target.exists(),str(target)
 files=[(str(q.relative_to(target)),q.stat().st_size,sha(q.read_bytes())) for q in sorted(target.rglob('*')) if q.is_file()];schema=(target/'schema.prisma').read_bytes();modelnames=re.findall(rb'^model\s+(\w+)\s*\{',schema,re.M);output={'owner':owner,'path':str(target),'file_count':len(files),'bytes':sum(x[1] for x in files),'manifest_sha256':sha(json.dumps(files,separators=(',',':')).encode()),'generated_schema_sha256':sha(schema),'input_schema_sha256':sha((app/'prisma/schema.prisma').read_bytes()),'model_count':len(modelnames),'has_UserPortfolioLayout':b'UserPortfolioLayout' in modelnames,'engine_files':[{ 'name':q.name,'bytes':q.stat().st_size,'sha256':sha(q.read_bytes())} for q in target.iterdir() if q.name.endswith('.node')]};report['outputs'].append(output);save();print(json.dumps({'output':output}),flush=True)
report['complete']=True;save();print(json.dumps({'complete':True,'all_four_generated':len(report['outputs'])==4,'report_path':str(gen/'generation.json.gz'),'report_bytes':(gen/'generation.json.gz').stat().st_size,'report_sha256':sha((gen/'generation.json.gz').read_bytes())}),flush=True)
