import json,os,subprocess,sys,time
from pathlib import Path
name,cwd,*argv=sys.argv[1:]
e=Path('/workspace/capirov2-cleanup-source-gates/docs/cleanup-source-gates-20261012/evidence')
env=dict(os.environ)
for key in list(env):
    if any(token in key.upper() for token in ['DATABASE_URL','DB_URL','POSTGRES','PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','AWS_ACCESS_KEY','AWS_SECRET_ACCESS','AWS_SESSION_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY']): env.pop(key,None)
env['TURBO_TELEMETRY_DISABLED']='1'
started=time.time()
try:
    result=subprocess.run(argv,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=1800)
    output=result.stdout;code=result.returncode;timed=False
except subprocess.TimeoutExpired as error:
    output=error.stdout or b'';code=None;timed=True
(e/(name+'.log')).write_bytes(output)
actual_source=subprocess.check_output(['git','rev-parse','HEAD'],cwd=cwd).decode().strip()
receipt={'name':name,'cwd':cwd,'argv':argv,'exitCode':code,'timedOut':timed,'seconds':round(time.time()-started,3),'measuredSource':actual_source,'targetIntegratedSource':'243248e726243c44bd4b9d24fd1ed220da18c56a','nativeAcceptance':False,'outputFile':name+'.log'}
(e/(name+'.command.json')).write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt));print(output.decode(errors='replace')[-1400:])
