"""Bounded aggregate spend journal on native NTFS handles; no cloud or providers."""
import base64
import contextlib
import hashlib
import json
import pathlib
import re
import runpy
import sys
import time

protocol = runpy.run_path(str(pathlib.Path(__file__).with_name('windows-artifact-protocol.py')))
native = protocol['native']
CASES = {'01', '14', '20', '26', '27', '46', '72'}
V2_CASES = CASES | {'02', '03', '04', '05'}
MAX_TOTAL, MAX_CASE = 30_000_000, 3_000_000
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
HASH = re.compile(r'[a-f0-9]{64}')
TERMINAL_CASE01_RUN = 'c6ffa5ad-dd9f-4912-bc31-a03231a9b903'
TERMINAL_CASE01_RESERVATION = 'd63fd741-aac6-4d3d-9c4d-1276b96bd1a3'
TERMINAL_CASE01_INVENTORY = '113c55d76637edfd807e5e3efced931e2b2dd73052dabba4d2e0607aff6e57b8'
TERMINAL_CASE01_PROOF = 'd8555b206bf7d47630838885f8fe4fce0e8fb5f25fda851e3b8e07e54b17314f'


def require(condition):
    if not condition:
        raise ValueError('CAPTURE_SPEND_REJECTED')


def data(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf-8')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def run_key(value, cases=CASES):
    require(value.get('caseId') in cases and UUID.fullmatch(value.get('captureRunId', '')))
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
    runs, active, reserved, known, closed_unknown = {}, None, 0, 0, 0
    version, released, deadline = 1, 0, None
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
        if event.get('kind') == 'revise_protocol':
            require(version == 1 and active is None and closed_unknown == MAX_CASE)
            require(boundary['inventorySha256'] == TERMINAL_CASE01_INVENTORY)
            require(event.get('protocolVersion') == 2 and event.get('maxCostMicros') == MAX_TOTAL)
            require(event.get('perCaseMaxCostMicros') == MAX_CASE and event.get('concurrency') == 1)
            require(event.get('settlementAuthority') == 'server_settled_provider_ledger')
            require(event.get('uncertainDisposition') == 'full_ceiling_no_refund')
            require(HASH.fullmatch(event.get('reviewSha256', '')))
            require(type(event.get('activatedAtMs')) is int and type(event.get('deadlineAtMs')) is int)
            require(0 < event['activatedAtMs'] < event['deadlineAtMs'] <= event['activatedAtMs'] + 24*60*60*1000)
            version, deadline = 2, event['deadlineAtMs']
            continue
        key = run_key(event, V2_CASES if version == 2 else CASES)
        if event.get('kind') == 'reserve':
            require(active is None and key not in runs)
            if not runs:
                require(event['caseId'] == boundary['firstCaseId'] and event['captureRunId'] == boundary['firstCaptureRunId'])
            cost = ceiling(event.get('ceilingMicros'))
            require(UUID.fullmatch(event.get('reservationId', '')))
            runs[key] = dict(event)
            if version == 2:
                require(type(event.get('reservedAtMs')) is int and event['reservedAtMs'] < deadline)
                runs[key]['protocolVersion'] = 2
            active = key
            reserved += cost
        elif event.get('kind') == 'close_terminal_uncertain':
            # A one-off disposition for the original rejected request. It keeps
            # the entire ceiling consumed and never asserts a billed-zero result.
            require(active == key and event['caseId'] == '01')
            require(event['captureRunId'] == TERMINAL_CASE01_RUN)
            require(boundary['inventorySha256'] == TERMINAL_CASE01_INVENTORY)
            require(event.get('reservationId') == TERMINAL_CASE01_RESERVATION)
            row = runs[key]
            require(row['reservationId'] == event['reservationId'] and row['ceilingMicros'] == MAX_CASE)
            require(event.get('disposition') == 'TERMINAL_SETUP_REJECTION_COST_UNKNOWN')
            require(event.get('actualCostMicros', 'missing') is None)
            proof = event.get('proof', {})
            require(digest(data(proof)) == TERMINAL_CASE01_PROOF)
            require(set(proof) == {'failedExecutionSha256', 'terminalLogSha256', 'authenticatedReadbackSha256',
                                  'reconciliationSha256', 'requestIdSha256', 'ledgerSha256',
                                  'finalizedAtMs', 'readbackAtMs', 'providerDeadlineAtMs',
                                  'turnId', 'providerAttempts', 'pendingProviderAttempts', 'messageCount',
                                  'requestOutcome', 'failureReason'})
            for field in ('failedExecutionSha256', 'terminalLogSha256', 'authenticatedReadbackSha256',
                          'reconciliationSha256', 'requestIdSha256', 'ledgerSha256'):
                require(HASH.fullmatch(proof.get(field, '')))
            for field in ('finalizedAtMs', 'readbackAtMs', 'providerDeadlineAtMs'):
                require(type(proof.get(field)) is int and proof[field] > 0)
            require(proof['readbackAtMs'] >= proof['finalizedAtMs'])
            require(proof['turnId'] is None and proof['providerAttempts'] == [] and
                    type(proof['pendingProviderAttempts']) is int and proof['pendingProviderAttempts'] == 0 and
                    type(proof['messageCount']) is int and proof['messageCount'] == 0)
            require(proof['requestOutcome'] == 'error' and
                    proof['failureReason'] == 'meri_capture_provider_budget_unqualified_retrieval_plan')
            runs[key] = {**row, **event, 'conservativeCostMicros': row['ceilingMicros']}
            closed_unknown += row['ceilingMicros']
            active = None
        else:
            require(event.get('kind') == 'settle' and active == key)
            row = runs[key]
            require(event.get('reservationId') == row['reservationId'])
            actual = event.get('chargedCostMicros')
            require(type(actual) is int and 0 <= actual <= row['ceilingMicros'])
            require(HASH.fullmatch(event.get('ledgerSha256', '')) and HASH.fullmatch(event.get('envelopeSha256', '')))
            known += actual
            if row.get('protocolVersion') == 2:
                released += row['ceilingMicros'] - actual
            runs[key] = {**row, **event}
            active = None
        require(reserved - released <= MAX_TOTAL)
    require(reserved - released <= MAX_TOTAL)
    result = {'reservedCeilingsMicros': reserved, 'knownSettledCostMicros': known,
            'remainingReservationMicros': MAX_TOTAL - reserved + released, 'activeRun': active,
            'runs': runs, 'eventCount': len(entries), 'refundsAllowed': False,
            'priorActualCostUnknownCount': len(prior), 'billedTotalStatus': 'UNKNOWN'}
    if closed_unknown:
        result['terminalUnknownConservativeCostMicros'] = closed_unknown
        result['terminalUnknownCostCount'] = 1
    if version == 2:
        result.update({'protocolVersion': 2, 'releasedUnusedCeilingMicros': released,
                       'committedCostMicros': reserved-released, 'deadlineAtMs': deadline,
                       'unusedCeilingRelease': 'new_v2_runs_only_after_server_settlement'})
    return result


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
    require(op in {'read', 'reserve', 'settle', 'close_terminal_uncertain', 'revise_protocol'})
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
        if op == 'reserve' and snapshot.get('protocolVersion') == 2:
            require(int(time.time()*1000) < snapshot['deadlineAtMs'])
            require('reservedAtMs' not in event)
            event['reservedAtMs'] = int(time.time()*1000)
        fields = {'kind', 'caseId', 'captureRunId', 'reservationId', 'sequence'}
        fields |= ({'ceilingMicros'} if op == 'reserve' else
                   {'disposition', 'actualCostMicros', 'proof'} if op == 'close_terminal_uncertain' else
                   {'chargedCostMicros', 'ledgerSha256', 'envelopeSha256'})
        if op == 'reserve' and snapshot.get('protocolVersion') == 2:
            fields.add('reservedAtMs')
        if op == 'revise_protocol':
            fields = {'kind', 'sequence', 'protocolVersion', 'maxCostMicros', 'perCaseMaxCostMicros',
                      'concurrency', 'settlementAuthority', 'uncertainDisposition', 'reviewSha256',
                      'activatedAtMs', 'deadlineAtMs'}
            require(abs(int(time.time()*1000) - event.get('activatedAtMs', 0)) < 60_000)
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
