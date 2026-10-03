"""Preparation only: root runs after capture termination with explicit outcome/README.

No AWS, auth, database, provider, fixture, journal, subprocess, or Git operations.
All source bytes are pinned in archive-case01-native-checkpoint-inputs.json.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import re

ROOT = Path('C:/dev/main/outputs/meri-c2-20261003')
DEST = Path('C:/dev/main/meri-c1-20261002/docs/meri/releases/2026-10-03/c2-native-case01-checkpoint')
RUN = 'bd35c0f4-1604-4371-b7e9-a1338369e53f'
INPUTS = ROOT / 'archive-case01-native-checkpoint-inputs.json'
INPUTS_SHA256 = 'bceebcdf5ee97aa53e468a08a99afc8baea681d4938562bf1f11331b3e03fcfc'
ATTRIBUTES = b'* -text whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab,cr-at-eol\n'
CREDENTIALS = re.compile(
    rb'\bsk_(?:live|test)_[A-Za-z0-9]{16,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|'
    rb'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|'
    rb'\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}|'
    rb'(?i:Bearer)[ \t]+[A-Za-z0-9._~-]{32,}|'
    rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|'
    rb'(?i:(?:postgres(?:ql)?|mysql)://)[^\s/:]+:[^\s/@]+@'
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def relative(name):
    path = Path(name)
    require(not path.is_absolute() and '..' not in path.parts and '\\' not in name,
            'Unsafe relative path')
    require(path.as_posix() == name and name not in ('', '.'), 'Noncanonical relative path')
    return path


def scan(name, data):
    # Report the filename only, never print a matching credential.
    require(not CREDENTIALS.search(data), 'Possible credential in ' + name)


def load_local_input(value):
    path = Path(value).resolve()
    require(path.is_relative_to(ROOT.resolve()), 'Final inputs must remain in output root')
    require('.private.' not in path.name and 'scope' not in path.name.lower(), 'Private input refused')
    return path.read_bytes()


def parse(data):
    return json.loads(data)


def verify_setup(blobs):
    prefix = 'case01-native-setup-'
    prior = parse(blobs[prefix + 'plan-v1/result.json'])
    reconciliation = parse(blobs[prefix + 'plan-v1-reconciliation.json'])
    require(prior['taskArn'] is None and not prior['events'], 'Old registration failure changed')
    require(reconciliation['status'] == 'RECONCILED_PRE_RUN_TASK_FAILURE'
            and reconciliation['priorResultSha256'] == sha(blobs[prefix + 'plan-v1/result.json'])
            and reconciliation['definitionStatus'] == 'INACTIVE'
            and all(not item['value']['taskArns'] for item in reconciliation['taskLists']),
            'Original failure reconciliation missing')
    for name, count, expected_exit in [('plan-v2', 2, 1), ('diagnostic-result-v1', 2, 1),
                                       ('plan-v3', 2, 0), ('execute-v3', 6, 0)]:
        base = prefix + name + '/'
        raw = blobs[base + 'inner-receipt.jsonl']
        events = [parse(line) for line in raw.splitlines() if line]
        transport = parse(blobs[base + 'inner-receipt-transport.json'])
        result = parse(blobs[base + 'result.json'])
        cleanup = parse(blobs[base + 'cleanup.json'])
        require(len(raw) == transport['byteLength'] and sha(raw) == transport['sha256'],
                'Inner transport mismatch: ' + name)
        require(len(events) == count and result['events'] == events
                and parse(blobs[base + 'inner-receipt-events.json'])['events'] == events,
                'Inner event mismatch: ' + name)
        require([row['sequence'] for row in events] == list(range(1, count + 1)),
                'Inner sequence mismatch: ' + name)
        require(result['exitCode'] == expected_exit and transport['innerExitCode'] == expected_exit,
                'Exit changed: ' + name)
        require(cleanup['taskStopped'] is True and cleanup['taskDefinitionInactive'] is True,
                'Cleanup unproved: ' + name)
        terminal = parse(blobs[base + 'terminal-task.json'])
        require(not terminal['failures'] and len(terminal['tasks']) == 1, 'Task cardinality')
        task = terminal['tasks'][0]
        require(task['taskArn'] == result['taskArn'] and task['lastStatus'] == 'STOPPED'
                and task['taskDefinitionArn'] == result['taskDefinition'], 'Terminal task mismatch')
        require(len(task['containers']) == 1 and task['containers'][0]['exitCode'] == expected_exit,
                'Terminal exit mismatch')
        if name == 'diagnostic-result-v1':
            diagnostic = events[-1]['diagnostic']
            require(diagnostic['substage'] == 'HYDRATE_PREVIOUS'
                    and diagnostic['errorCode'] == 'P2028' and diagnostic['timeoutMentioned'] is True,
                    'P2028 diagnosis changed')
        if name == 'execute-v3':
            require([(e['stage'], e['phase']) for e in events] == [
                ('VALIDATING', 'START'), ('BIND_DISPATCHING', 'INTENT'), ('BOUND', 'VERIFIED'),
                ('BUDGET_INSTALL_DISPATCHING', 'INTENT'), ('BUDGET_INSTALLED', 'VERIFIED'),
                ('COMPLETE', 'RESULT')], 'Six-event setup contract changed')
            require(events[-1]['status'] == 'BOUND_AND_BUDGET_READ_BACK'
                    and events[-1]['providerCalls'] == 0 and events[-1]['journalOpened'] is False,
                    'Setup completion changed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture-finished', action='store_true', required=True)
    parser.add_argument('--outcome', required=True, help='Root-written final sanitized JSON in output root')
    parser.add_argument('--readme', required=True, help='Root-written final README in output root')
    args = parser.parse_args()
    require(args.capture_finished, 'Capture must finish first')
    require(not DEST.exists(), 'Destination exists; never overwrite or retry a partial archive')
    inputs_data = INPUTS.read_bytes()
    require(sha(inputs_data) == INPUTS_SHA256, 'Archive selection changed')
    inputs = parse(inputs_data)
    blobs = {}
    for item in inputs['copy']:
        source = ROOT / relative(item['source'])
        name = relative(item['path']).as_posix()
        require(name not in blobs and '.private.' not in name
                and not any(word in source.name for word in ('definition-input', 'definition-readback.private',
                    'definition-register-response', 'deregister-response', 'deregister-readback')),
                'Duplicate/private selection')
        data = source.read_bytes()
        require(len(data) == item['bytes'] and sha(data) == item['sha256'], 'Changed evidence: ' + name)
        scan(name, data)
        blobs[name] = data
    verify_setup(blobs)
    outcome_data = load_local_input(args.outcome)
    outcome = parse(outcome_data)
    require(outcome.get('version') == 1 and outcome.get('captureRunId') == RUN
            and outcome.get('captureFinished') is True, 'Final outcome/run required')
    require(outcome.get('operatorStatus') in ('COMPLETED', 'FAILED', 'BLOCKED', 'UNCERTAIN'),
            'Explicit terminal operator disposition required')
    require(outcome.get('reservationStatus') in ('SETTLED', 'UNRESOLVED', 'NOT_RESERVED'),
            'Explicit reservation disposition required')
    require(outcome.get('acceptanceDisposition') in ('PASS', 'FAIL', 'BLOCKED', 'NOT_GRADED'),
            'Separate acceptance disposition required')
    require(outcome.get('sessionRevocation') in ('VERIFIED', 'FAILED', 'UNKNOWN', 'NOT_CREATED'),
            'Session cleanup disposition required')
    require(type(outcome.get('chargedMicros')) is int and outcome['chargedMicros'] >= 0
            or outcome.get('chargedMicros', False) is None, 'Cost must be explicit integer or null')
    for key in ('finishedAt', 'summary'):
        require(isinstance(outcome.get(key), str) and outcome[key].strip(), 'Missing ' + key)
    require(isinstance(outcome.get('limitations'), list) and outcome['limitations']
            and all(isinstance(value, str) and value.strip() for value in outcome['limitations']),
            'Explicit limitations required')
    require(isinstance(outcome.get('evidence'), list) and outcome['evidence'], 'Outcome evidence references required')
    for item in outcome['evidence']:
        relative(item['path'])
        require(re.fullmatch('[0-9a-f]{64}', item['sha256']) is not None
                and type(item['bytes']) is int and item['bytes'] >= 0, 'Invalid outcome evidence reference')
    # Outcome evidence stays in its separately reviewed capture archive; no arbitrary files are imported.
    readme = load_local_input(args.readme)
    require(readme.startswith(b'# ') and len(readme) > 100, 'Final human-reviewed README required')
    require(RUN.encode() in readme, 'README must identify the exact run')
    blobs.update({'README.md': readme, 'outcome.json': outcome_data,
                  'archive-inputs.json': inputs_data, '.gitattributes': ATTRIBUTES,
                  'archive-helper.py': Path(__file__).read_bytes()})
    for name, data in blobs.items():
        scan(name, data)
    manifest = {'version': 1, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'captureRunId': RUN, 'operatorStatus': outcome['operatorStatus'],
                'acceptanceDisposition': outcome['acceptanceDisposition'],
                'files': [{'path': name, 'bytes': len(data), 'sha256': sha(data)}
                          for name, data in sorted(blobs.items())],
                'excludedLocalProof': inputs['excludedLocalProof'],
                'limits': ['Archive copies existing evidence only; it grants no execution authority.',
                           'Credential regex is a bounded scan, not a complete privacy proof.',
                           'Private definitions and auth scope are excluded; excluded raw proofs are hash references.',
                           'Setup success is not benchmark acceptance; outcome and human grading remain separate.']}
    blobs['artifacts.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    # All source, outcome and scan checks precede the first archive write.
    DEST.mkdir(parents=True, exist_ok=False)
    for name, data in blobs.items():
        target = DEST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        require(target.read_bytes() == data, 'Archive byte readback mismatch: ' + name)
    print(json.dumps({'archive': str(DEST), 'files': len(blobs),
                      'manifestSha256': sha(blobs['artifacts.json']), 'gitOperations': 0}))


if __name__ == '__main__':
    main()
