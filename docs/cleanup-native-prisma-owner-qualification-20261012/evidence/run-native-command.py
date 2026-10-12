from pathlib import Path
import json
import subprocess
from datetime import datetime, timezone

packet = Path(__file__).resolve().parent.parent
repo = packet.parent.parent
node = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
task_path = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin'
label = '01-native-prisma-attempt-0'
stdout_file = packet / 'evidence' / (label + '.stdout.log')
stderr_file = packet / 'evidence' / (label + '.stderr.log')
receipt_file = packet / 'evidence' / (label + '.json')
for existing in [stdout_file, stderr_file, receipt_file]:
    if existing.exists():
        raise RuntimeError('Never overwrite native evidence')
command = [
    '/usr/bin/env', '-i', 'PATH=' + task_path, 'LANG=C.UTF-8', 'TZ=UTC', node,
    'docs/cleanup-native-prisma-owner-qualification-20261012/native-prisma-owner-harness.cjs',
    '--run', '--verified-target',
    '/tmp/capirov2-cleanup-meri-reviewed-runtime-conversion/docs/native-acceptance-pr2429-20261012/evidence/verified-isolated-target.json',
    '--output', 'docs/cleanup-native-prisma-owner-qualification-20261012/evidence/native-prisma-attempt-0.json',
]
started = datetime.now(timezone.utc).isoformat()
result = subprocess.run(command, cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
stdout_file.write_bytes(result.stdout)
stderr_file.write_bytes(result.stderr)
receipt_file.write_text(json.dumps({
    'sourceHead': 'ee9499c5771038f6abf5972ab13d3c20ca65b0cf',
    'sourceTree': 'f0530159db532171beba479da52615c759822086',
    'startedAt': started, 'finishedAt': datetime.now(timezone.utc).isoformat(),
    'command': command, 'cwd': str(repo), 'exitCode': result.returncode,
    'launcherEnvKeys': ['PATH', 'LANG', 'TZ'],
    'childAddedControlledEnv': ['PRISMA_QUERY_ENGINE_LIBRARY'],
    'stdout': str(stdout_file.relative_to(packet)),
    'stderr': str(stderr_file.relative_to(packet)), 'databaseExecuted': True,
}, indent=2) + '\n')
print(result.stdout.decode(), end='')
print(result.stderr.decode(), end='')
raise SystemExit(result.returncode)
