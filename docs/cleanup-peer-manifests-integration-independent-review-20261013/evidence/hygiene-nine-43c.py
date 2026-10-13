from pathlib import Path
import subprocess,tempfile,hashlib,json,os,shutil
ROOT=Path(__file__).resolve().parents[3];HERE=Path(__file__).parent
SOURCE='43c14e3b5bde8eb76371394a50abbd718556382e';PUBLISHED='9db4e1cd5589a05e08fb88caa38a4ac44937def5';NODE='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
owner='scripts/lib/reviewed-source-hygiene.mjs'
raw=subprocess.check_output(['git','show',SOURCE+':'+owner],cwd=ROOT)
archives=[
 'docs/cleanup-newsletter-canonical-builder-20261013/evidence/five-path-code-diff.patch',
 'docs/cleanup-newsletter-canonical-builder-independent-review-20261013/evidence/original-scopes.stdout',
 'docs/newsletter-builder-reviewed-publication-20261013/physical-evidence-whitespace.txt',
 'docs/newsletter-builder-reviewed-publication-20261013/root-wired-backend-source-guards.tap',
]
env={'PATH':'/usr/bin:/bin','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_AUTHOR_NAME':'Inert source review','GIT_AUTHOR_EMAIL':'review@example.invalid','GIT_COMMITTER_NAME':'Inert source review','GIT_COMMITTER_EMAIL':'review@example.invalid'}
temp=Path(tempfile.mkdtemp(prefix='peer-hygiene-git-review-'))
def git(*args,ok=True):
 r=subprocess.run(['git','-c','core.hooksPath=/dev/null',*args],cwd=temp,env=env,capture_output=True)
 if ok:assert r.returncode==0,(args,r.stderr.decode())
 return r
rows=[]
try:
 git('init','-q')
 f=temp/owner;f.parent.mkdir(parents=True);f.write_bytes(raw)
 for p in archives:
  d=temp/p;d.parent.mkdir(parents=True,exist_ok=True);d.write_bytes(subprocess.check_output(['git','show',PUBLISHED+':'+p],cwd=ROOT))
 (temp/'source.mjs').write_text('export const safe = 1;\n')
 (temp/'docs/ordinary.md').write_text('Ordinary source documentation.\n')
 git('add','--all');git('commit','-qm','Inert synthetic baseline')
 base=git('rev-parse','HEAD').stdout.decode().strip()
 def reset():git('reset','--hard','-q',base);git('clean','-fdq')
 def check(name,expect_refusal,detail):
  r=subprocess.run([NODE,'--no-addons',owner,'--run','--base',base],cwd=temp,env={'PATH':'/usr/bin:/bin'},capture_output=True)
  try:payload=json.loads(r.stdout)
  except:payload=None
  observed=r.returncode!=0
  rows.append({'name':name,'expectedRefusal':expect_refusal,'observedRefusal':observed,'pass':observed==expect_refusal,'exit':r.returncode,'stdout':r.stdout.decode(),'stderr':r.stderr.decode(),'detail':detail})
 check('unchanged positive',False,{})
 (temp/'source.mjs').write_text('export const safe = 1;  \n');check('ordinary worktree source whitespace',True,{})
 reset();(temp/'docs/ordinary.md').write_text('Ordinary source documentation.  \n');check('ordinary documentation whitespace',True,{})
 reset();(temp/'source.mjs').write_text('export const safe = 1;  \n');git('add','source.mjs');(temp/'source.mjs').write_text('export const safe = 1;\n')
 check('staged source bad whitespace cancelled in worktree',True,{'cachedDiff':git('diff','--cached','--check',base,ok=False).stdout.decode(),'aggregateDiff':git('diff',base).stdout.decode()})
 reset();p=archives[0];d=temp/p;before=d.read_bytes();d.write_bytes(before+b'changed');git('add','--',p);d.write_bytes(before)
 check('staged raw bytes changed but cancelled in worktree',True,{'cachedDiffBytes':len(git('diff','--cached','HEAD','--',p).stdout),'aggregateArchiveDiffBytes':len(git('diff','HEAD','--',p).stdout)})
 reset();(temp/'.gitattributes').write_text('*.mjs -whitespace\n');(temp/'source.mjs').write_text('export const safe = 1;  \n')
 check('attribute disables source whitespace',True,{'gitCheckStdout':git('diff','--check',base,ok=False).stdout.decode()})
 reset();git('config','--local','core.whitespace','-trailing-space,-blank-at-eof,-space-before-tab');(temp/'source.mjs').write_text('export const safe = 1;  \n')
 check('fixture-local configuration disables whitespace',True,{})
 git('config','--local','--unset','core.whitespace')
 reset();os.chmod(temp/archives[0],0o755);git('add','--',archives[0]);git('commit','-qm','Synthetic archive executable-mode change')
 check('committed archive mode changed with exact bytes',True,{'currentMode':git('ls-tree','HEAD','--',archives[0]).stdout.decode()})
 reset();path=':(exclude)source.mjs';(temp/path).write_text('bad literal path whitespace  \n');git('add','--',path)
 check('literal pathspec-looking tracked source still checked',True,{})
 result={'source':SOURCE,'sourceSha256':hashlib.sha256(raw).hexdigest(),'fixtureOnly':True,'syntheticBase':base,'rows':rows,'passed':sum(r['pass'] for r in rows),'failed':sum(not r['pass'] for r in rows),'actualAppProviderNetworkNativePerformed':False,'productionSourceEdited':False,'fixtureDestroyed':True}
 (HERE/'hygiene-nine-43c.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({'passed':result['passed'],'failed':result['failed'],'failedNames':[r['name'] for r in rows if not r['pass']]}))
finally:shutil.rmtree(temp)
