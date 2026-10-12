import json,os,shlex,subprocess,sys,time
from pathlib import Path
root=Path('/workspace/capirov2-cleanup-source-gates')
e=root/'docs/cleanup-source-gates-20261012/evidence'
family=sys.argv[1]
typescript=root/'node_modules/typescript/bin/tsc'
plans=[]
for prefix in ['apps','packages','infra']:
 for p in sorted((root/prefix).glob('*/package.json')):
  data=json.loads(p.read_text());command=data.get('scripts',{}).get('typecheck')
  if not command: continue
  rel=str(p.parent.relative_to(root))
  if family=='core' and rel!='apps/api': continue
  if family=='other' and rel=='apps/api': continue
  plans.append((rel,data['name'],command))
receipts=[]
for rel,name,command in plans:
 entry={'package':name,'path':rel,'declaredCommand':command,'source':'243248e726243c44bd4b9d24fd1ed220da18c56a','checks':[]}
 if rel=='apps/defense-api':
  entry['classification']='native/environment-dependent';entry['blocked']='Canonical command first invokes Prisma generation; native engine gate is unavailable and must not be bypassed.';receipts.append(entry);continue
 for index,part in enumerate(command.split('&&')):
  tokens=shlex.split(part.strip())
  if tokens[0]=='tsc': argv=['node',str(typescript),*tokens[1:]]
  elif tokens==['tsx','scripts/verify-pe-phase-a-safety.ts']: argv=['node',str(root/'apps/api/node_modules/tsx/dist/cli.mjs'),*tokens[1:]]
  else: raise RuntimeError('Unaudited executable '+part)
  env=dict(os.environ)
  for key in list(env):
   if any(t in key.upper() for t in ['DATABASE_URL','DB_URL','POSTGRES','AWS_ACCESS','AWS_SECRET','AWS_SESSION','OPENAI_API_KEY','ANTHROPIC_API_KEY']):env.pop(key,None)
  env['NODE_OPTIONS']='--max-old-space-size=8192'
  start=time.time();r=subprocess.run(argv,cwd=root/rel,env=env,capture_output=True,timeout=600)
  filename='types-'+rel.replace('/','-')+'-'+str(index)+'.log';(e/filename).write_bytes(r.stdout+r.stderr)
  result={'argv':argv,'exitCode':r.returncode,'log':filename,'seconds':round(time.time()-start,3)};entry['checks'].append(result)
  print(json.dumps({'package':name,**result}),flush=True)
  if r.returncode: entry['firstFailure']=index;break
 receipts.append(entry)
 (e/('workspace-typechecks-'+family+'.json')).write_text(json.dumps({'source':'243248e726243c44bd4b9d24fd1ed220da18c56a','receipts':receipts},indent=2)+'\n')
