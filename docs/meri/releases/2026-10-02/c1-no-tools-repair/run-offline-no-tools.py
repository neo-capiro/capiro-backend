import json, os, pathlib, subprocess, sys
repo = pathlib.Path('C:/dev/main/meri-c1-20261002')
root = pathlib.Path('C:/dev/main/outputs/meri-c1-20261002')
sha = 'cfd0adf0c54776f81f4b4e57c1a43190766e195e'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip() == sha
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=repo, text=True).strip()
env = {k:v for k,v in os.environ.items() if not any(s in k.upper() for s in ('API_KEY','TOKEN','SECRET','DATABASE_URL','DIRECT_URL','NODE_OPTIONS'))}
env.update(PROMPTFOO_DISABLE_TELEMETRY='1', PROMPTFOO_DISABLE_REMOTE_GENERATION='1', PROMPTFOO_PYTHON=sys.executable, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
report = root/'meri-offline-no-tools.json'
summary = root/'meri-offline-no-tools.summary.json'
assert not report.exists() and not summary.exists()
args = ['C:/Program Files/nodejs/node.exe',str(repo/'node_modules/promptfoo/dist/src/main.js'),'eval','-c','evals/meri/promptfooconfig.yaml','--no-cache','--no-share','--no-write','--no-table','--no-progress-bar','-o',str(report)]
with (root/'offline-eval-no-tools.log').open('x',encoding='utf-8') as log:
    run = subprocess.run(args,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT)
    print('evalExit',run.returncode)
    if run.returncode: sys.exit(run.returncode)
    checked = subprocess.run([sys.executable,'evals/meri/verify_report.py',str(report),str(summary)],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT)
    print('verifierExit',checked.returncode)
    sys.exit(checked.returncode)
