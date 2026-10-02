"""Prepared launcher. Root alone authorizes execution after canary completion."""
import json, os, pathlib, subprocess, sys, time
root = pathlib.Path(__file__).parent
gate = json.loads((root / 'synthetic-meri-ui-v8-ready.json').read_text(encoding='utf-8-sig'))
if gate.get('ready') is not True or not time.time() < gate.get('expiresAtEpoch', 0):
    raise SystemExit('ROOT_READINESS_REQUIRED')
cwd = r'C:\dev\cap-meri-fixture-hardening'
env = os.environ.copy()
env.update(HERMES_HOME=r'C:\ProgramData\Hermes', AWS_PROFILE='default', AWS_REGION='us-east-1', AWS_DEFAULT_REGION='us-east-1', PYTHONIOENCODING='utf-8', GIT_TERMINAL_PROMPT='0', NPM_CONFIG_OFFLINE='true')
env.pop('OPENROUTER_API_KEY', None)
args = [r'C:\ProgramData\Hermes\bin\hermes.exe', 'chat', '--provider', 'bedrock', '-m', 'qwen.qwen3-coder-next', '--toolsets', 'terminal,file', '--no-restore-cwd', '--in', cwd, '--max-turns', '14', '--run-budget', '600', '--format', 'stream-json', '--query-file', str(root / 'synthetic-meri-ui-v8-hermes-prompt.md')]
started = time.time()
with (root / 'synthetic-meri-ui-v8-hermes.jsonl').open('x', encoding='utf-8') as out, (root / 'synthetic-meri-ui-v8-hermes.err').open('x', encoding='utf-8') as err:
    child = subprocess.Popen(args, cwd=cwd, env=env, stdout=out, stderr=err)
    receipt = {'pid': child.pid, 'startedAtEpoch': started, 'provider': 'bedrock', 'requestedModel': 'qwen.qwen3-coder-next', 'worktree': cwd, 'maxTurns': 14, 'runBudgetSeconds': 600, 'scope': 'one fixed browser smoke execution; max two synthetic turns'}
    (root / 'synthetic-meri-ui-v8-hermes-process.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt), flush=True)
    code = child.wait()
(root / 'synthetic-meri-ui-v8-hermes-exit.json').write_text(json.dumps({'exitCode': code, 'startedAtEpoch': started, 'completedAtEpoch': time.time()}, indent=2), encoding='utf-8')
events = []
for line in (root / 'synthetic-meri-ui-v8-hermes.jsonl').read_text(encoding='utf-8', errors='replace').splitlines():
    try: event = json.loads(line)
    except ValueError: continue
    if event.get('type') in ('system', 'result'): events.append(event)
init = next((event for event in events if event.get('type') == 'system' and event.get('subtype') == 'init'), {})
result = next((event for event in reversed(events) if event.get('type') == 'result'), {})
(root / 'synthetic-meri-ui-v8-hermes-usage.json').write_text(json.dumps({'provider': 'bedrock', 'requestedModel': 'qwen.qwen3-coder-next', 'initializedModel': init.get('model'), 'sessionId': init.get('session_id'), 'reportedTokens': result.get('tokens'), 'billedCostUsd': None}, indent=2), encoding='utf-8')
print(json.dumps({'exitCode': code}), flush=True)
sys.exit(code)
