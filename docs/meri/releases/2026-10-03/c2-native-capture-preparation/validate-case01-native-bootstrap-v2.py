from pathlib import Path
import datetime
import hashlib
import json
import runpy
import subprocess

ROOT = Path('C:/dev/main/outputs/meri-c2-20261003')
REPO = Path('C:/dev/main/meri-c1-20261002')
OUT = ROOT / 'case01-native-bootstrap-v2'
NODE = 'C:/Program Files/nodejs/node.exe'
sha = lambda data: hashlib.sha256(data).hexdigest()


def save(name, data):
    with (OUT / name).open('xb') as stream:
        stream.write(data)


prepared = runpy.run_path(str(ROOT / 'prepare-case01-native-bootstrap-v2.py'))['render']()
for name, data in prepared.items():
    assert (OUT / name).read_bytes() == data, name
save('offline-reproduction.log', b'PASS: all six prepared files match exact offline rendering; operator not imported.\n')

syntax = []
for name in ['run-case01-native.mjs', 'case01-prepared-guards.mjs', 'case01-prepared-guards.test.mjs']:
    result = subprocess.run([NODE, '--check', str(OUT / name)], capture_output=True)
    syntax.append(name.encode() + b': exit=' + str(result.returncode).encode() + b'\n' + result.stdout + result.stderr)
    assert result.returncode == 0, name
save('syntax-check.log', b''.join(syntax))
tests = subprocess.run([NODE, '--test', str(OUT / 'case01-prepared-guards.test.mjs')], capture_output=True)
save('pure-guard-tests.log', tests.stdout + tests.stderr)
assert tests.returncode == 0
assert b'# tests 13' in tests.stdout and b'# pass 13' in tests.stdout and b'# fail 0' in tests.stdout

prior = ROOT / 'case01-native-bootstrap-v1' / 'preparation-checkpoint.json'
assert sha(prior.read_bytes()) == '0df88d1c257aa15f82a79165f7d13cc752271efaf692d27f91d6a45a65417453'
old_checkpoint = json.loads(prior.read_bytes())
for item in old_checkpoint['reusedSourceHashes']:
    assert sha((REPO / item['path']).read_bytes()) == item['sha256'], item['path']
for item in old_checkpoint['outputs']:
    assert sha((prior.parent / item['path']).read_bytes()) == item['sha256'], item['path']
review = prior.parent / 'read-only-review-v1.json'
assert sha(review.read_bytes()) == 'fd85b1274f50fd02ea1805986af9214291c1ac8c027792fe353ba29309eee6d5'

files = sorted(p for p in OUT.iterdir() if p.is_file())
checkpoint = {
    'version': 2,
    'status': 'PREPARED_NOT_EXECUTED',
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
    'priorCheckpoint': {'path': '../case01-native-bootstrap-v1/preparation-checkpoint.json', 'sha256': sha(prior.read_bytes())},
    'priorReview': {'path': '../case01-native-bootstrap-v1/read-only-review-v1.json', 'sha256': sha(review.read_bytes()), 'result': 'CHANGES_REQUIRED'},
    'changes': [
        'Exact immutable API and orchestrator expectation is checked before receipt access or journal adoption; actual live build/native checks still required.',
        'Execution intent is fsynced immediately before entering native execute. Missing returned outcome after intent yields null/UNKNOWN, never inferred zero.',
    ],
    'fixedDeployment': json.loads(prepared['scope-input.template.json'])['deployment'],
    'fixedCaptureRunId': old_checkpoint['fixedCaptureRunId'],
    'setupCheckpoint': old_checkpoint['setupCheckpoint'],
    'journal': old_checkpoint['journal'],
    'journalRequiredBytesSha256': old_checkpoint['journalRequiredBytesSha256'],
    'requiredPriorEvents': old_checkpoint['requiredPriorEvents'],
    'requiredPriorCostMicros': old_checkpoint['requiredPriorCostMicros'],
    'requiredAvailableMicros': old_checkpoint['requiredAvailableMicros'],
    'maxCostMicros': old_checkpoint['maxCostMicros'],
    'maxTokens': old_checkpoint['maxTokens'],
    'maxAttempts': old_checkpoint['maxAttempts'],
    'aggregateLimitMicros': old_checkpoint['aggregateLimitMicros'],
    'concurrency': 1,
    'fixedOutput': old_checkpoint['fixedOutput'],
    'outputs': [{'path': p.name, 'bytes': p.stat().st_size, 'sha256': sha(p.read_bytes())} for p in files],
    'preparationScripts': [{'path': '../' + p.name, 'sha256': sha(p.read_bytes())} for p in [ROOT / 'prepare-case01-native-bootstrap-v2.py', Path(__file__)]],
    'reusedSourceHashes': old_checkpoint['reusedSourceHashes'],
    'validation': {'syntax': 'PASS', 'offlineReproduction': 'PASS', 'pureGuardTests': {'passed': 13, 'failed': 0}, 'nativeOperatorImported': False},
    'actualActions': {'pureGuardModuleImports': 1, 'operatorImports': 0, 'operatorExecutions': 0, 'cloudCalls': 0, 'authCalls': 0, 'databaseCalls': 0, 'journalOwnerCalls': 0, 'journalWrites': 0, 'providerCalls': 0, 'fixtureMutations': 0, 'repositoryEdits': 0},
    'remaining': ['Independent v2 review', 'Actual approved release, successful setup and final scope', 'Actual native capture and separate human adjudication'],
    'captureAuthority': False,
    'liveAcceptance': 'NOT_RUN',
}
data = (json.dumps(checkpoint, indent=2) + '\n').encode()
save('preparation-checkpoint.json', data)
print(json.dumps({'status': checkpoint['status'], 'scriptSha256': sha(prepared['run-case01-native.mjs']), 'checkpointSha256': sha(data), 'testsPassed': 13, 'testsFailed': 0, 'operatorImported': False}))
