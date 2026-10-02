"""Capture actual exit for the fixed remaining T2 browser script; no retries."""
import json, pathlib, subprocess, sys, time
root = pathlib.Path(__file__).parent
command = ['node', str(root / 'synthetic-meri-ui-v5-smoke.cjs'), '--readiness', str(root / 'synthetic-meri-ui-v5-ready.json'), '--continue-t2-once']
started = time.time()
with (root / 'synthetic-meri-ui-v5-command.log').open('x', encoding='utf-8') as output:
    child = subprocess.Popen(command, cwd=r'C:\dev\cap-meri-fixture-hardening', stdout=output, stderr=subprocess.STDOUT)
    (root / 'synthetic-meri-ui-v5-command-process.json').write_text(json.dumps({'command': command, 'pid': child.pid, 'startedAtEpoch': started}, indent=2), encoding='utf-8')
    code = child.wait()
receipt = {'command': command, 'exitCode': code, 'startedAtEpoch': started, 'completedAtEpoch': time.time()}
(root / 'synthetic-meri-ui-v5-command-exit.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
print(json.dumps({'exitCode': code, 'resultPath': str(root / 'synthetic-meri-ui-v5-smoke-result.json')}))
sys.exit(code)
