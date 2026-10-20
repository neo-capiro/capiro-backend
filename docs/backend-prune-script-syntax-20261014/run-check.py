# Finite source-only commands. No application/native/provider qualification implied.
import base64, hashlib, json, os, subprocess, sys, time
from pathlib import Path

root = Path(__file__).resolve().parents[2]
packet = Path(__file__).resolve().parent
evidence = packet / 'evidence'
evidence.mkdir(parents=True, exist_ok=True)
label, relative_cwd, *argv = sys.argv[1:]
assert label.replace('-', '').isalnum() and argv
env = {'PATH': os.environ['PATH'], 'NODE_ENV': 'test', 'CI': 'true',
       'AWS_EC2_METADATA_DISABLED': 'true',
       'NODE_OPTIONS': '--require=' + str(root / 'docs/backend-cleanup-receiving-20261014/source-only-fence.cjs'),
       'TMPDIR': str(root / '.qualification-cache/prune-script-tmp')}
Path(env['TMPDIR']).mkdir(parents=True, exist_ok=True)
started = time.monotonic()
source_status_before = subprocess.check_output(['git', 'status', '--porcelain=v1', '--', 'apps', 'packages', 'scripts', 'infra'], cwd=root).decode()
result = subprocess.run(argv, cwd=root / relative_cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
source_status_after = subprocess.check_output(['git', 'status', '--porcelain=v1', '--', 'apps', 'packages', 'scripts', 'infra'], cwd=root).decode()
assert source_status_before == source_status_after, 'Source status changed during check'
raw = {'encoding': 'base64', 'bytes': len(result.stdout), 'sha256': hashlib.sha256(result.stdout).hexdigest(),
       'data': base64.b64encode(result.stdout).decode()}
(evidence / (label + '-output.raw.json')).write_text(json.dumps(raw, indent=2) + '\n')
receipt = {'label': label, 'cwd': relative_cwd, 'argv': argv,
           'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
           'tree': subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=root).decode().strip(),
           'exitCode': result.returncode, 'seconds': round(time.monotonic() - started, 3), 'environment': env,
           'outputSha256': raw['sha256'], 'scope': 'source/mocked checks; fence is not an OS sandbox'}
receipt['sourceStatusBefore'] = source_status_before
receipt['sourceStatusAfter'] = source_status_after
receipt['exactCommittedSource'] = source_status_before == ''
(evidence / (label + '-receipt.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
print(result.stdout.decode(errors='replace')[-6000:])
sys.exit(result.returncode)
