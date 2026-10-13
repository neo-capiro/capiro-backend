import hashlib
import json
import os
from pathlib import Path
import subprocess

packet = Path(__file__).resolve().parent
root = Path('/tmp/capiro-native-pg-pr2429-20261012')
data = root / 'data'
socket = Path('/tmp/capiro-native-pg-socket-pr2429-20261012')
binary = root / 'usr/lib/postgresql/16/bin'
assert not data.exists(), 'Refuse reuse of an existing database directory'
if socket.exists():
    assert socket.stat().st_uid == os.getuid() and not list(socket.iterdir()), 'Refuse nonempty or foreign socket directory'
assert os.getuid() != 0
assert subprocess.check_output(['id', '-un']).decode().strip() == 'agent'
socket.mkdir(mode=0o700, exist_ok=True)
env = {'PATH': str(binary) + ':/usr/bin:/bin', 'LD_LIBRARY_PATH': str(root / 'lib'), 'LANG': 'C.UTF-8'}
commands = [
    [str(binary / 'initdb'), '--pgdata', str(data), '--username', 'agent', '--auth-local', 'peer', '--auth-host', 'reject', '--no-locale', '--encoding', 'UTF8', '--wal-segsize', '1'],
    [str(binary / 'pg_ctl'), '-D', str(data), '-l', str(root / 'server.log'), '-o', f"-k {socket} -c listen_addresses='' -c unix_socket_permissions=0700 -c shared_buffers=16MB -c max_connections=10 -c min_wal_size=2MB -c max_wal_size=16MB -c logging_collector=off", '-w', 'start'],
]
receipts = []
for index, command in enumerate(commands):
    result = subprocess.run(command, env=env, capture_output=True, timeout=30)
    (packet / f'postgres-setup-{index}.stdout').write_bytes(result.stdout)
    (packet / f'postgres-setup-{index}.stderr').write_bytes(result.stderr)
    receipts.append({'argv': command, 'exitCode': result.returncode})
    (packet / 'postgres-setup-commands.json').write_text(json.dumps(receipts, indent=2) + '\n')
    assert result.returncode == 0, result.stderr.decode()
manifest = {
    'binarySourceImage': 'sha256:f1447071e6c8449dcf4056aa0994c81d3566ce5ee232de36b04dc25696a116dd',
    'imageRepoDigest': 'pgvector/pgvector@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a',
    'existingPersistentContainerDatabaseAccessed': False,
    'dataDirectory': str(data), 'socketDirectory': str(socket), 'port': 5432,
    'user': 'agent', 'authentication': 'existing OS identity via Unix peer; host rejected; no password created',
    'newLoginCredentials': False, 'listenAddresses': '',
    'files': [{'path': str(p.relative_to(root)), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for folder in [root / 'usr', root / 'lib'] for p in folder.rglob('*') if p.is_file()],
}
(packet / 'ISOLATED-POSTGRES-MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'created': str(data), 'socket': str(socket), 'newPasswords': False, 'TCP': False}))
