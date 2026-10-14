from pathlib import Path
import textwrap, subprocess, json, hashlib, os, tempfile

source = Path(os.environ.get('CAPIRO_RETIRED_SEED_SOURCE', '/dev/shm/capiro-runtime-candidate-20261014/worktree'))
owned = Path(os.environ.get('CAPIRO_RETIRED_SEED_FIXTURE_ROOT', '/dev/shm/capiro-pinned-parser-install-20261014/retained-audit-fixtures'))
owned.mkdir(parents=True, exist_ok=True)
fixture = Path(tempfile.mkdtemp(prefix='inert-core-dispatch-corrected-', dir=owned))
bin_dir = fixture / 'bin'
bin_dir.mkdir()
tsx = fixture / 'node_modules/.bin/tsx'
tsx.parent.mkdir(parents=True)
mock = '''#!/usr/bin/env python3
import os, sys, json, pathlib
with pathlib.Path(os.environ['MOCK_TRACE']).open('a') as f:
    f.write(json.dumps({'tool': pathlib.Path(sys.argv[0]).name, 'args': sys.argv[1:]}) + '\\n')
args = sys.argv[1:]
if pathlib.Path(sys.argv[0]).name == 'tsx':
    sys.exit(int(os.environ.get('MOCK_TASK_EXIT', '0')))
if args == [os.environ['PE_COMPOSE_DATABASE_URL_JS']]:
    print('postgresql://fixture:fixture@127.0.0.1:1/fixture')
    sys.exit(0)
if args == ['-e', 'process.stdout.write(encodeURIComponent(process.argv[1]))', 'fixture']:
    print('fixture')
    sys.exit(0)
if args == ['./node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema=./prisma/schema.prisma']:
    sys.exit(int(os.environ['MOCK_MIGRATE_EXIT']))
if args == ['dist/main.js']:
    sys.exit(int(os.environ.get('MOCK_SERVE_EXIT', '0')))
sys.exit(98)
'''
for p in [bin_dir / 'node', tsx]:
    p.write_text(mock)
    p.chmod(0o755)
helper = fixture / 'compose-fixture.js'
helper.write_text('// Inert marker: mock node never executes this file.\n')
paths = [
    'apps/api/scripts/entrypoint.sh',
    'apps/api/scripts/entrypoint-legacy.sh',
    'apps/api/scripts/entrypoint-dispatcher.inc',
    'apps/api/scripts/lib/pe-migration-guards.ts',
]
inputs = [
    {'path': p, 'bytes': len((source / p).read_bytes()), 'sha256': hashlib.sha256((source / p).read_bytes()).hexdigest()}
    for p in paths
]
expected = [
    'a16c4ebffbb10da7a18a6a38f2f67bd35f39a875fdf4411b7015c395bb26e98d',
    '4f9213850b938f71f1a7955683792c6ded862c4453efe9234ddf40f892ce7d0a',
    '1651d7fac414eff859be16039fbce6117782a4611d19894f9e32097dda86e420',
    '6adf558fa9419f267f1ce61ec78c6183dac118ca30944e921e803b2177be247d',
]
assert [x['sha256'] for x in inputs] == expected
receipt = {
    'qualification': '10 inert shell dispatch cases plus 3 POSIX syntax checks; strict owned Node/tsx mocks; no Prisma/application/provider/SQL/database execution',
    'source_base': 'dd02f3ba0b4ab77e3725e83e4b9af27aecdc8eca',
    'source_scope': 'exact authorized four-file retired-seed cleanup; not a committed/serving release claim',
    'cwd': str(fixture),
    'inputs': inputs,
    'cases': [],
    'syntax': [],
}
output = owned / 'retired-seed-inert-dispatch.receipt.json'
def retain():
    output.write_text(json.dumps(receipt, indent=2) + '\n')
def invoke(label, path, args, expected_exit, expected_calls, migrate_exit=0):
    trace = fixture / (label + '.calls.jsonl')
    env = {k: v for k, v in os.environ.items() if k in ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']}
    env.update(
        PATH=str(bin_dir) + ':' + env.get('PATH', ''),
        TMPDIR=str(fixture),
        DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/fixture',
        DB_HOST='127.0.0.1', DB_PORT='1', DB_USER='fixture', DB_PASSWORD='fixture', DB_NAME='fixture',
        PE_COMPOSE_DATABASE_URL_JS=str(helper), MOCK_TRACE=str(trace), MOCK_MIGRATE_EXIT=str(migrate_exit),
    )
    command = ['/bin/sh', str(source / path), *args]
    result = subprocess.run(command, cwd=fixture, env=env, capture_output=True, text=True, timeout=15)
    calls = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
    case = {'label': label, 'command': command, 'exit': result.returncode, 'calls': calls, 'stdout': result.stdout, 'stderr': result.stderr}
    receipt['cases'].append(case)
    retain()
    assert result.returncode == expected_exit, (label, result.returncode, result.stderr)
    assert calls == expected_calls, (label, calls, expected_calls)
helper_call = {'tool': 'node', 'args': [str(helper)]}
deploy = {'tool': 'node', 'args': ['./node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema=./prisma/schema.prisma']}
serve = {'tool': 'node', 'args': ['dist/main.js']}
encode = {'tool': 'node', 'args': ['-e', 'process.stdout.write(encodeURIComponent(process.argv[1]))', 'fixture']}
for code in [0, 47, 63]:
    invoke('migrate-exit-' + str(code), paths[0], ['migrate'], code, [helper_call, deploy], code)
invoke('dispatcher-serve', paths[2], ['serve'], 0, [encode, serve])
invoke('dispatcher-default', paths[2], [], 0, [encode, serve])
invoke('retired-seed-refused', paths[2], ['seed-workflows'], 1, [encode])
invoke('legacy-migrate-refused', paths[1], ['migrate'], 64, [])
invoke('dispatcher-migrate-refused', paths[2], ['migrate'], 64, [encode])
invoke('preserved-clio-task-dispatch', paths[2], ['run-clio-scheduled-tasks'], 0, [encode, {'tool': 'tsx', 'args': ['scripts/run-clio-scheduled-tasks.ts']}])
invoke('operator-recovery-missing-name', paths[0], ['migrate-resolve-applied'], 1, [])
for path in paths[:3]:
    result = subprocess.run(['/bin/sh', '-n', str(source / path)], capture_output=True, text=True)
    receipt['syntax'].append({'path': path, 'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
    retain()
    assert result.returncode == 0
receipt['exit'] = 0
retain()
print(json.dumps({'cases': len(receipt['cases']), 'syntax_checks': len(receipt['syntax']), 'exit': 0, 'inputs': inputs, 'receipt': str(output)}, indent=2))
