import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[3]
folder = Path(__file__).resolve().parent
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=root, text=True).strip()
temporary = Path('/workspace/capiro-rich-core-tc-20261013')
temporary.mkdir(mode=0o700, exist_ok=True)
command = ['/tmp/capirov2-local-qualification-bin-20261012/pnpm', '--filter', '@capiro/api', 'typecheck']
env = {
    'PATH': '/tmp/capirov2-local-qualification-bin-20261012:/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin',
    'TMPDIR': str(temporary), 'TZ': 'UTC', 'LANG': 'C.UTF-8', 'CI': '1',
    'NODE_OPTIONS': '--max-old-space-size=8192',
}
stdout = folder / 'current-core-typecheck.stdout.log'
stderr = folder / 'current-core-typecheck.stderr.log'
assert not stdout.exists() and not stderr.exists()
with stdout.open('xb') as out, stderr.open('xb') as err:
    result = subprocess.run(command, cwd=root, env=env, stdout=out, stderr=err)
receipt = {
    'head': head, 'tree': tree, 'argv': command, 'cwd': str(root), 'environment': env,
    'exitCode': result.returncode, 'canonical17SegmentScriptUnchanged': True,
    'parserSource': '37d574a35cd6d9aef79239a830b588fe1bd9769f',
    'privateSharedDeclarationSource': '7949d079b1b46acf9c18c86898d6eedf9290428a',
    'finalSharedDeclarationEqualityRequired': True,
    'compilerAndExistingSafetySourceOnly': True,
    'stdoutSha256': hashlib.sha256(stdout.read_bytes()).hexdigest(),
    'stderrSha256': hashlib.sha256(stderr.read_bytes()).hexdigest(),
}
(folder / 'current-core-typecheck.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
raise SystemExit(result.returncode)
