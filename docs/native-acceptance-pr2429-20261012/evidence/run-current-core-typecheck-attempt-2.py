import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[3]
folder = Path(__file__).resolve().parent
head = subprocess.check_output(['git','rev-parse','HEAD'], cwd=root, text=True).strip()
tree = subprocess.check_output(['git','rev-parse','HEAD^{tree}'], cwd=root, text=True).strip()
short_tmp = Path('/tmp/capiro-wall-core-tc-20261012')
short_tmp.mkdir(exist_ok=True)
command = ['/tmp/capirov2-local-qualification-bin-20261012/pnpm','--filter','@capiro/api','typecheck']
env = {'PATH':'/tmp/capirov2-local-qualification-bin-20261012:/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin','TMPDIR':str(short_tmp),'TZ':'UTC','LANG':'C.UTF-8','CI':'1','NODE_OPTIONS':'--max-old-space-size=8192'}
stdout = folder / 'current-core-typecheck-attempt-2.stdout'
stderr = folder / 'current-core-typecheck-attempt-2.stderr'
assert not stdout.exists() and not stderr.exists()
with stdout.open('xb') as out, stderr.open('xb') as err:
    result = subprocess.run(command,cwd=root,env=env,stdout=out,stderr=err)
receipt = {'head':head,'tree':tree,'argv':command,'cwd':str(root),'environment':env,'exitCode':result.returncode,'canonicalScriptUnchanged':True,'sourceClientWriter':'926b269ad6e3b5ed789b5d18f55306df310d046c','compilerAndSafetySourceOnly':True,'stdoutSha256':hashlib.sha256(stdout.read_bytes()).hexdigest(),'stderrSha256':hashlib.sha256(stderr.read_bytes()).hexdigest()}
(folder/'current-core-typecheck-attempt-2.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
raise SystemExit(result.returncode)
