from pathlib import Path
import subprocess,tempfile,json,shutil
HERE=Path(__file__).parent;temp=Path(tempfile.mkdtemp(prefix='peer-git-whitespace-mechanism-'))
env={'PATH':'/usr/bin:/bin','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_AUTHOR_NAME':'Inert review','GIT_AUTHOR_EMAIL':'review@example.invalid','GIT_COMMITTER_NAME':'Inert review','GIT_COMMITTER_EMAIL':'review@example.invalid'}
def run(args):return subprocess.run(['git','-c','core.hooksPath=/dev/null',*args],cwd=temp,env=env,capture_output=True)
rows=[]
try:
 assert run(['init','-q']).returncode==0
 (temp/'source.mjs').write_text('export const value = 1;\n')
 assert run(['add','source.mjs']).returncode==0;assert run(['commit','-qm','Synthetic clean baseline']).returncode==0
 base=run(['rev-parse','HEAD']).stdout.decode().strip()
 (temp/'source.mjs').write_text('export const value = 1;  \n')
 (temp/'.gitattributes').write_text('*.mjs -whitespace\n')
 args=['-c','core.whitespace=blank-at-eol,blank-at-eof,space-before-tab','diff','--check',base,'--','source.mjs']
 for name,prefix,expected in [('core pin alone, worktree attrs',[],0),('core pin plus attr-source baseline',['--attr-source='+base],2)]:
  r=run([*prefix,*args]);assert r.returncode==expected;rows.append({'name':name,'exit':r.returncode,'stdout':r.stdout.decode(),'stderr':r.stderr.decode()})
 (temp/'.git/info/attributes').write_text('*.mjs -whitespace\n')
 r=run(['--attr-source='+base,*args]);assert r.returncode==0
 rows.append({'name':'info attributes override core and attr-source pins','exit':r.returncode,'stdout':r.stdout.decode(),'stderr':r.stderr.decode()})
 result={'gitVersion':run(['--version']).stdout.decode().strip(),'fixtureBase':base,'sourceFixtureOnly':True,'rows':rows,'conclusion':'Core whitespace and attr-source pins cannot alone guarantee errors when repository info/attributes overrides them; deterministic literal added-line audit recommended with retained Git observations.','productionConfigChanged':False,'networkAppNativePerformed':False}
 (HERE/'git-whitespace-mechanism.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'controls':len(rows),'infoAttributesBypassProved':True}))
finally:shutil.rmtree(temp)
