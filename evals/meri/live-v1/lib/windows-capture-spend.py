"""Bounded aggregate spend journal on native NTFS handles; no cloud or providers."""
import base64
import contextlib
import hashlib
import json
import pathlib
import re
import runpy
import sys

protocol = runpy.run_path(str(pathlib.Path(__file__).with_name('windows-artifact-protocol.py')))
native = protocol['native']
CASES = {'01', '14', '20', '26', '27', '46', '72'}
MAX_TOTAL, MAX_CASE = 30_000_000, 3_000_000
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
HASH = re.compile(r'[a-f0-9]{64}')


def require(condition):
    if not condition:
        raise ValueError('CAPTURE_SPEND_REJECTED')


def data(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf-8')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def run_key(value):
    require(value.get('caseId') in CASES and UUID.fullmatch(value.get('captureRunId', '')))
    return value['caseId'] + ':' + value['captureRunId']


def ceiling(value):
    require(type(value) is int and 0 < value <= MAX_CASE)
    return value


def reduce_journal(owner, entries):
    require(owner.get('kind') == 'meri-original-capture-spend-owner' and owner.get('version') == 1)
    require(owner.get('maxCostMicros') == MAX_TOTAL and owner.get('perCaseMaxCostMicros') == MAX_CASE)
    require(owner.get('concurrency') == 1 and UUID.fullmatch(owner.get('sliceId', '')))
    boundary = owner.get('boundary', {})
    require(set(boundary) == {'kind', 'firstCaseId', 'firstCaptureRunId', 'inventorySha256'})
    require(boundary['kind'] == 'original_file01_capture_slice' and boundary['firstCaseId'] == '01')
    require(UUID.fullmatch(boundary['firstCaptureRunId']) and HASH.fullmatch(boundary['inventorySha256']))
    runs, active, reserved, known = {}, None, 0, 0
    prior = owner.get('priorRuns')
    require(type(prior) is list and len(prior) <= 30)
    for row in prior:
        key = run_key(row)
        require(key not in runs and row.get('status') == 'conservative_prior_reservation')
        require(HASH.fullmatch(row.get('terminalReceiptSha256', '')))
        if not runs:
            require(row['caseId'] == boundary['firstCaseId'] and row['captureRunId'] == boundary['firstCaptureRunId'])
        cost = ceiling(row.get('ceilingMicros'))
        reserved += cost
        runs[key] = dict(row)
    for sequence, event in enumerate(entries, 1):
        require(event.get('sequence') == sequence)
        key = run_key(event)
        if event.get('kind') == 'reserve':
            require(active is None and key not in runs)
            if not runs:
                require(event['caseId'] == boundary['firstCaseId'] and event['captureRunId'] == boundary['firstCaptureRunId'])
            cost = ceiling(event.get('ceilingMicros'))
            require(UUID.fullmatch(event.get('reservationId', '')))
            runs[key] = dict(event)
            active = key
            reserved += cost
        else:
            require(event.get('kind') == 'settle' and active == key)
            row = runs[key]
            require(event.get('reservationId') == row['reservationId'])
            actual = event.get('chargedCostMicros')
            require(type(actual) is int and 0 <= actual <= row['ceilingMicros'])
            require(HASH.fullmatch(event.get('ledgerSha256', '')) and HASH.fullmatch(event.get('envelopeSha256', '')))
            known += actual
            runs[key] = {**row, **event}
            active = None
        require(reserved <= MAX_TOTAL)
    require(reserved <= MAX_TOTAL)
    return {'reservedCeilingsMicros': reserved, 'knownSettledCostMicros': known,
            'remainingReservationMicros': MAX_TOTAL - reserved, 'activeRun': active,
            'runs': runs, 'eventCount': len(entries), 'refundsAllowed': False,
            'priorActualCostUnknownCount': len(prior), 'billedTotalStatus': 'UNKNOWN'}


def execute(request):
    op = request.get('op')
    if op == 'init':
        inventory = request['inventory']
        require(set(inventory) == {'sliceId', 'priorRuns', 'boundary'})
        owner = {'kind': 'meri-original-capture-spend-owner', 'version': 1,
                 'maxCostMicros': MAX_TOTAL, 'perCaseMaxCostMicros': MAX_CASE,
                 'concurrency': 1, **inventory}
        snapshot = reduce_journal(owner, [])
        result = protocol['execute']({'op': 'init', 'root': request['root'],
            'owner': base64.b64encode(data(owner)).decode(),
            'marker': base64.b64encode(b'meri-capture-spend-owned-v1\n').decode()})
        result = protocol['execute']({'op': 'write', 'root': request['root'],
            'state': result['state'], 'ref': '.spend-lock', 'bytes': ''})
        return {'state': result['state'], 'snapshot': snapshot}
    require(op in {'read', 'reserve', 'settle'})
    state = json.loads(json.dumps(request['state']))
    require(state.get('root') == request['root'])
    drive, parts = protocol['components'](request['root'], root=True)
    with contextlib.ExitStack() as stack:
        retain = stack.enter_context
        parent = retain(native['open_volume'](drive)); key = drive
        require(native['inspect'](parent)['identity'] == state['directories'][key])
        for part in parts:
            parent = retain(native['open_child'](parent, part, True)); key += '/' + part
            require(native['inspect'](parent)['identity'] == state['directories'][key])
        # Existing read/write handle with read-only sharing denies a second writer.
        # The OS closes this lock on process exit; an unrecorded event still fences
        # every stale checkpoint and cannot silently free its reservation.
        lock = retain(native['open_child'](parent, '.spend-lock', False, write=True))
        require(native['inspect'](lock)['identity'] == state['files']['.spend-lock']['identity'])
        require(native['read_bytes'](lock) == b'')
        names = native['list_names'](parent)
        require(len(names) == len(state['files']) and set(names) == set(state['files']))
        contents = {}
        for name in names:
            native['validate_name'](name)
            if name == '.spend-lock':
                continue
            handle = retain(native['open_child'](parent, name, False))
            value = native['read_bytes'](handle); expected = state['files'][name]
            require(native['inspect'](handle)['identity'] == expected['identity'])
            require(digest(value) == expected['sha256'] and len(value) == expected['bytes'])
            contents[name] = value
        require(digest(contents['bundle-owner.json']) == state['ownerSha256'])
        require(contents['.capture-owned'] == b'meri-capture-spend-owned-v1\n')
        owner = json.loads(contents.pop('bundle-owner.json')); contents.pop('.capture-owned')
        require(all(re.fullmatch(r'spend-[0-9]{6}\.json', name) for name in contents))
        entries = [json.loads(contents[name]) for name in sorted(contents)]
        snapshot = reduce_journal(owner, entries)
        if op == 'read':
            return {'state': state, 'snapshot': snapshot}
        event = dict(request['event'])
        fields = {'kind', 'caseId', 'captureRunId', 'reservationId', 'sequence'}
        fields |= {'ceilingMicros'} if op == 'reserve' else {'chargedCostMicros', 'ledgerSha256', 'envelopeSha256'}
        require(set(event) == fields - {'sequence'} and event['kind'] == op)
        event['sequence'] = len(entries) + 1
        next_snapshot = reduce_journal(owner, [*entries, event])
        name = f"spend-{event['sequence']:06d}.json"
        handle = retain(native['open_child'](parent, name, False, create=True, write=True))
        value = data(event)
        native['write_bytes'](handle, value)
        require(native['read_bytes'](handle) == value)
        state['files'][name] = {'ref': name, 'identity': native['inspect'](handle)['identity'],
                               'sha256': digest(value), 'bytes': len(value)}
        return {'state': state, 'snapshot': next_snapshot, 'event': event}


if __name__ == '__main__':
    try:
        wire = sys.stdin.buffer.read(1_048_577)
        require(len(wire) <= 1_048_576)
        result = execute(json.loads(wire))
        sys.stdout.write(json.dumps({'ok': True, **result}))
    except Exception:
        sys.stdout.write(json.dumps({'ok': False, 'code': 'CAPTURE_SPEND_JOURNAL_REJECTED'}))
        sys.exit(1)
