import hashlib
import json
import shlex
import subprocess
from pathlib import Path

BASE = '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70'
SOURCE = '2496e57b4193cdd4d004232711a77ef707ae6b98'
TREE = 'ed4f162b3b59dbc27b3757170073e88be0181f35'
OUT = Path('docs/cleanup-phase1-caller-independent-review-20261012/evidence')
def git(*args): return subprocess.check_output(['git', *args])
def entries(ref):
    result = {}
    for row in git('ls-tree', '-rz', ref).split(b'\0'):
        if row:
            metadata, name = row.split(b'\t', 1)
            result[name.decode()] = metadata.decode()
    return result
assert git('rev-parse', SOURCE + '^{tree}').decode().strip() == TREE
old, new = entries(BASE), entries(SOURCE)
changed = sorted(p for p in old.keys() | new.keys() if old.get(p) != new.get(p))
assert changed == ['package.json']
assert len(old) == len(new)
protected = [p for p in old if p != 'package.json']
assert all(old[p] == new[p] for p in protected)
before = git('show', BASE + ':package.json')
after = git('show', SOURCE + ':package.json')
operand = b'scripts/verify-engagement-phase1-runtime.ts'
assert before.count(operand) == after.count(operand) == 1
assert after == before.replace(operand + b' &&', operand + b' --run &&')
before_json, after_json = json.loads(before), json.loads(after)
name = 'verify:engagement-phase-1'
old_command, new_command = before_json['scripts'][name], after_json['scripts'][name]
before_json['scripts'][name] = new_command
assert before_json == after_json
old_segments, new_segments = old_command.split(' && '), new_command.split(' && ')
assert len(old_segments) == len(new_segments) == 7
assert old_segments[1:] == new_segments[1:]
old_argv, new_argv = shlex.split(old_segments[0]), shlex.split(new_segments[0])
assert new_argv == old_argv + ['--run']
assert new_argv.count('--run') == 1
assert all(shlex.split(x)[:2] == ['node', '--check'] for x in new_segments[1:])
callers = [
    'apps/api/scripts/verify-engagement-phase1-runtime.ts',
    'scripts/run-engagement-phase1-local.mjs',
    'scripts/verify-engagement-phase2-code.sh',
]
def metadata(path):
    return {'path': path, 'baseEntry': old[path], 'candidateEntry': new[path],
            'baseSha256': hashlib.sha256(git('show', BASE + ':' + path)).hexdigest(),
            'candidateSha256': hashlib.sha256(git('show', SOURCE + ':' + path)).hexdigest()}
records = [metadata(p) for p in ['package.json', *callers]]
for record in records[1:]:
    assert record['baseEntry'] == record['candidateEntry']
    assert record['baseSha256'] == record['candidateSha256']
result = {'acceptedSource': SOURCE, 'acceptedTree': TREE, 'base': BASE,
          'onlyChangedPath': changed, 'oldNewPackageAndThreeCanonicalCallerEntries': records,
          'unchangedBaselinePathsOutsidePackage': len(protected),
          'unchangedApplicationPaths': sum(p.startswith('apps/') for p in protected),
          'unchangedSchemaMigrationPaths': sum(p.endswith('.prisma') or '/migrations/' in p for p in protected),
          'unchangedPriorDocumentationAndReceiptPaths': sum(p.startswith('docs/') for p in protected),
          'allOtherPackageValuesUnchanged': True, 'oneRequiredRunArgumentAddedOnce': True,
          'oldHelperArgv': old_argv, 'newHelperArgv': new_argv,
          'sixFollowingSyntaxCheckCommandsPreserved': new_segments[1:],
          'allAndOperatorsAndRemainingCommandBytesPreserved': True,
          'nativeOrRealCloseoutExecuted': False}
(OUT / 'source-preservation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
