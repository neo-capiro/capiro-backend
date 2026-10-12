import json
import subprocess
from pathlib import Path

SOURCE = '4104f49f6ebfdbf00ad1706079ba340bd9b566c8'
TREE = '257856362ba9075b25bee52debf3efa35f3dfb77'
OUT = Path('docs/cleanup-next-registry-control-wiring-review-20261012/evidence')
help_text = b'Usage: node scripts/check-registry-ownership.mjs\nInspect bounded canonical registry owners and reviewed source carriers.\n'
cases = [
    ('current-noargs', [], 0, None, b''),
    ('help', ['--help'], 0, help_text, b''),
    ('short-help', ['-h'], 0, help_text, b''),
    ('unknown', ['--unknown'], 1, b'', b'Unsupported registry ownership arguments\n'),
    ('help-unknown', ['--help', '--unknown'], 1, b'', b'Unsupported registry ownership arguments\n'),
]
results = []
for name, args, expected_exit, expected_stdout, expected_stderr in cases:
    command = ['node', 'scripts/check-registry-ownership.mjs', *args]
    process = subprocess.run(command, capture_output=True, timeout=30)
    (OUT / (name + '-4104.stdout.log')).write_bytes(process.stdout)
    (OUT / (name + '-4104.stderr.log')).write_bytes(process.stderr)
    expected = process.returncode == expected_exit and process.stderr == expected_stderr
    if expected_stdout is None:
        expected = expected and json.loads(process.stdout) == {'errors': [], 'profiles': 1, 'files': 168}
    else:
        expected = expected and process.stdout == expected_stdout
    record = {'source': SOURCE, 'tree': TREE, 'argv': command, 'exitCode': process.returncode,
              'expectedExitCode': expected_exit, 'expected': expected,
              'applicationSourceExecuted': False, 'nativeAcceptance': False}
    (OUT / (name + '-4104.command.json')).write_text(json.dumps(record, indent=2) + '\n')
    results.append(record)
    assert expected, name
print(json.dumps({'source': SOURCE, 'tree': TREE, 'cliCases': results}, indent=2))
