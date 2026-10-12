from pathlib import Path
import json, os, subprocess
p = Path(__file__).resolve().parent
root = p.parents[2]
rows = []
for mutation in ('tenant-unbound', 'actor-instead-client', 'share-instead-update', 'wrong-table', 'no-absence-guard', 'grant-read-before-lock'):
    output = p / ('05-mutant-' + mutation + '.json')
    command = ['node', '--require', str(p / 'lock-source-mutation-preload.cjs'), '/workspace/capirov2/apps/api/node_modules/jest/bin/jest.js', '--config', str(p / 'focused.jest.cjs'), '--runInBand', '--json', '--outputFile', str(output)]
    environment = {'PATH': os.environ['PATH'], 'NODE_OPTIONS': '--max-old-space-size=4096', 'CI': 'true', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'TMPDIR': '/tmp', 'LOCK_MUTATION': mutation}
    with (p / ('05-mutant-' + mutation + '.stdout')).open('wb') as out, (p / ('05-mutant-' + mutation + '.stderr')).open('wb') as err:
        result = subprocess.run(command, cwd=root, env=environment, stdout=out, stderr=err)
    data = json.loads(output.read_text()) if output.exists() else {}
    row = {'mutation': mutation, 'command': command, 'exit': result.returncode, 'total': data.get('numTotalTests'), 'failed': data.get('numFailedTests'), 'passed': data.get('numPassedTests'), 'refused': result.returncode != 0 and data.get('numFailedTests', 0) > 0, 'sourceFileEdited': False}
    rows.append(row)
    print(json.dumps(row), flush=True)
(p / '05-mutation-results.json').write_text(json.dumps(rows, indent=2) + '\n')
if not all(row['refused'] and row['total'] == 16 for row in rows):
    raise SystemExit('A bounded lock-source mutation escaped the actual fragment suite')
