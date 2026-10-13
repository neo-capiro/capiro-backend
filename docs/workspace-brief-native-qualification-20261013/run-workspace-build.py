from pathlib import Path
import subprocess
import json
import time
import hashlib
import sys

packet = Path(__file__).resolve().parent
root = packet.parents[1]
node = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
kind = sys.argv[1]
if kind == 'type':
    command = [node, '--max-old-space-size=4096', '/workspace/capirov2/node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit', '--rootDir', '.', '--tsBuildInfoFile', '/tmp/workspace-brief-native-type-20261013.tsbuildinfo']
elif kind == 'build':
    assert not (root / 'apps/workspace/dist').exists(), 'Fresh owned output required'
    command = [node, '--max-old-space-size=4096', '/workspace/capirov2/apps/api/node_modules/@nestjs/cli/bin/nest.js', 'build']
else:
    raise RuntimeError('type or build required')
log = packet / ('evidence/' + kind + '.log')
assert not log.exists(), 'Do not overwrite observations'
start = time.monotonic()
with log.open('xb') as stream:
    result = subprocess.run(command, cwd=root / 'apps/workspace', env={'PATH': '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin', 'TZ': 'UTC'}, stdout=stream, stderr=subprocess.STDOUT)
receipt = {'sourceHead': '76f50b2667d06a121b2dd772abc9d64adb556c36', 'sourceTree': 'd6e615533e4c36970779962b1391af90e5576314', 'check': kind, 'command': command, 'exitCode': result.returncode, 'elapsedSeconds': round(time.monotonic() - start, 3), 'logBytes': log.stat().st_size, 'logSha256': hashlib.sha256(log.read_bytes()).hexdigest(), 'client': '/tmp/workspace-brief-native-client-20261013', 'usesExactNewSchemaClient': True, 'nativeDatabaseAccessRequestedByThisCheck': False}
(packet / ('evidence/' + kind + '-receipt.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
sys.exit(result.returncode)
