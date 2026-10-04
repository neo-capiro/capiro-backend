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
MAX_V2_CASE = 15_000_000
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
HASH = re.compile(r'[a-f0-9]{64}')
TERMINAL_CASE01_RUN = 'c6ffa5ad-dd9f-4912-bc31-a03231a9b903'
TERMINAL_CASE01_RESERVATION = 'd63fd741-aac6-4d3d-9c4d-1276b96bd1a3'
TERMINAL_CASE01_INVENTORY = '113c55d76637edfd807e5e3efced931e2b2dd73052dabba4d2e0607aff6e57b8'
TERMINAL_CASE01_PROOF = 'd8555b206bf7d47630838885f8fe4fce0e8fb5f25fda851e3b8e07e54b17314f'
FRESH_ROOT = r'C:\dev\main\outputs\meri-fresh-20261003'
FRESH_PREFIX = 'abe458973e6998db20586c781ac5a3cbd4ca2fa565425e62722f0eb9c985210b'
FRESH_CASE14_PREFIX = '8f20134f71dde90e32fc0c3c2aba2da2d5b93dd13fffea31b83105d1621bc3e5'
FRESH_AUTHORIZATION = 'e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe'


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


def ceiling(value, maximum=MAX_CASE):
    require(type(value) is int and 0 < value <= maximum)
    return value


def reduce_journal(owner, entries):
    require(owner.get('kind') == 'meri-original-capture-spend-owner' and owner.get('version') == 1)
    require(owner.get('maxCostMicros') == MAX_TOTAL and owner.get('perCaseMaxCostMicros') == MAX_CASE)
    require(owner.get('concurrency') == 1 and UUID.fullmatch(owner.get('sliceId', '')))
    boundary = owner.get('boundary', {})
    require(set(boundary) == {'kind', 'firstCaseId', 'firstCaptureRunId', 'inventorySha256'})
    require(boundary['kind'] == 'original_file01_capture_slice' and boundary['firstCaseId'] == '01')
    require(UUID.fullmatch(boundary['firstCaptureRunId']) and HASH.fullmatch(boundary['inventorySha256']))
    runs, active, reserved, known, closed_unknown, unknown_count = {}, None, 0, 0, 0, 0
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
            require(version == 1 and active is None)
            require(runs.get('01:' + TERMINAL_CASE01_RUN, {}).get('kind') == 'close_terminal_uncertain')
            require(boundary['inventorySha256'] == TERMINAL_CASE01_INVENTORY)
            require(event.get('protocolVersion') == 2 and event.get('maxCostMicros') == MAX_TOTAL)
            require(event.get('perCaseMaxCostMicros') == MAX_V2_CASE and event.get('concurrency') == 1)
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
            # The unchanged owner/prior/v1 records keep their original3USD cap.
            # Governed46 still has its separately reviewed3USD product contract.
            cost = ceiling(event.get('ceilingMicros'), MAX_V2_CASE if version == 2 and event['caseId'] != '46' else MAX_CASE)
            require(UUID.fullmatch(event.get('reservationId', '')))
            runs[key] = dict(event)
            if version == 2:
                require(type(event.get('reservedAtMs')) is int and event['reservedAtMs'] < deadline)
                runs[key]['protocolVersion'] = 2
            active = key
            reserved += cost
        elif event.get('kind') == 'close_terminal_uncertain':
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
            unknown_count += 1
            active = None
        elif event.get('kind') == 'reconcile_terminal':
            require(active == key)
            row = runs[key]
            require(event.get('reservationId') == row['reservationId'])
            proof = event.get('proof', {})
            require(set(proof) == {'readbackSha256', 'ledgerSha256', 'envelopeSha256',
                                  'conversationId', 'completedAtMs', 'observedAtMs',
                                  'providerDeadlineAtMs', 'pendingProviderAttempts',
                                  'providerAttempts', 'answerGrade'})
            for field in ('readbackSha256', 'ledgerSha256', 'envelopeSha256'):
                require(HASH.fullmatch(proof.get(field, '')))
            require(UUID.fullmatch(proof.get('conversationId', '')))
            for field in ('completedAtMs', 'observedAtMs', 'providerDeadlineAtMs'):
                require(type(proof.get(field)) is int and proof[field] > 0)
            require(proof['completedAtMs'] <= proof['observedAtMs'])
            require(type(proof['pendingProviderAttempts']) is int and proof['pendingProviderAttempts'] == 0)
            require(type(proof['providerAttempts']) is int and proof['providerAttempts'] > 0)
            require(proof['answerGrade'] == 'NOT_EVALUATED')
            actual = event.get('chargedCostMicros')
            if event.get('disposition') == 'SETTLED':
                require(type(actual) is int and 0 <= actual <= row['ceilingMicros'])
                known += actual
                if row.get('protocolVersion') == 2:
                    released += row['ceilingMicros'] - actual
            else:
                require(event.get('disposition') == 'COST_UNKNOWN' and actual is None)
                require(proof['providerDeadlineAtMs'] <= proof['observedAtMs'])
                closed_unknown += row['ceilingMicros']
                unknown_count += 1
            runs[key] = {**row, **event, 'conservativeCostMicros': row['ceilingMicros'] if actual is None else actual}
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
        result['terminalUnknownCostCount'] = unknown_count
    if version == 2:
        result.update({'protocolVersion': 2, 'releasedUnusedCeilingMicros': released,
                       'committedCostMicros': reserved-released, 'deadlineAtMs': deadline,
                       'perCaseMaxCostMicros': MAX_V2_CASE,
                       'unusedCeilingRelease': 'new_v2_runs_only_after_server_settlement'})
    return result


def reduce_fresh(wire):
    # The original five paid attempts stay byte-for-byte and remain budget-only.
    lines = wire.splitlines(keepends=True)
    require(len(lines) >= 24 and all(line.endswith(b'\n') for line in lines))
    require(digest(b''.join(lines[:20])) == FRESH_PREFIX)
    require(digest(b''.join(lines[:24])) == FRESH_CASE14_PREFIX)
    events = [json.loads(line) for line in lines]
    runs, reservation_ids, capture_ids, active, charged = {}, set(), set(), None, 0
    for index in range(0, 20, 4):
        group = events[index:index + 4]
        require([row['event'] for row in group] == ['reserved', 'submission_intent', 'capture_observed', 'settled'])
        first, usage = group[0], group[-1]['usage']
        key = run_key(first, V2_CASES)
        require(key not in runs and first['reservationId'] not in reservation_ids and first['captureRunId'] not in capture_ids)
        require(all(row['caseId'] == first['caseId'] and row['captureRunId'] == first['captureRunId'] and
                    row['reservationId'] == first['reservationId'] for row in group))
        require(all(usage[k] == first[k] for k in ('caseId', 'captureRunId', 'reservationId', 'conversationId')))
        require(usage['captureAuthority'] is False and type(usage['chargedCostMicros']) is int and
                0 <= usage['chargedCostMicros'] <= first['ceilingMicros'] <= MAX_V2_CASE)
        charged += usage['chargedCostMicros']
        reservation_ids.add(first['reservationId'])
        capture_ids.add(first['captureRunId'])
        runs[key] = {**first, 'chargedCostMicros': usage['chargedCostMicros'], 'historical': True}
    require(charged == 9_841_281)
    for sequence, row in enumerate(events[20:], 21):
        common = {'nativeCaptureVersion', 'sequence', 'atMs', 'event', 'caseId', 'captureRunId', 'reservationId'}
        require(row.get('nativeCaptureVersion') == 1 and row.get('sequence') == sequence)
        require(type(row.get('atMs')) is int and row['atMs'] > 0)
        key = run_key(row, {'01', '20', '14'})
        require(UUID.fullmatch(row.get('reservationId', '')))
        if row.get('event') == 'reserved':
            require(set(row) == common | {'ceilingMicros'})
            require(active is None and key not in runs and row['reservationId'] not in reservation_ids and row['captureRunId'] not in capture_ids)
            if row['caseId'] == '14':
                require(sequence > 24 and digest(b''.join(lines[:24])) == FRESH_CASE14_PREFIX)
                require(not any(existing.startswith('14:') for existing in runs))
            cost = ceiling(row['ceilingMicros'], MAX_V2_CASE)
            require(charged + cost <= MAX_TOTAL)
            runs[key], active = dict(row), key
            reservation_ids.add(row['reservationId'])
            capture_ids.add(row['captureRunId'])
        elif row.get('event') == 'terminal_cost_reconciled':
            require(set(row) == common | {'proof'})
            proof = row['proof']
            if sequence == 22:
                require(digest(b''.join(lines[:21])) == '7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60')
                require(digest(data(proof)) == '59b7055d48bb074d13f57eb16c93334b258800107c039667aa445c3bf5e26648')
            else:
                require(sequence == 24 and row['caseId'] == '20')
                require(row['captureRunId'] == 'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b')
                require(row['reservationId'] == '7ea73cdc-526e-4b31-8c28-b0636ea8d2ae')
                require(digest(b''.join(lines[:23])) == 'd6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b')
                require(digest(data(proof)) == '305283f0048a7f7ae82dc322f8353a2499cc444cc2e60537736375d0e5eed3a0')
            require(all(row[k] == proof[k] for k in ('caseId', 'captureRunId', 'reservationId')))
            require(active == key and runs[key]['reservationId'] == row['reservationId'])
            require(runs[key]['ceilingMicros'] == 15_000_000 and row['atMs'] >= proof['observedAtMs'])
            require(proof['captureAuthority'] is False and proof['answerGrade'] == 'NOT_EVALUATED')
            charged += proof['chargedCostMicros']
            runs[key] = {**runs[key], 'chargedCostMicros': proof['chargedCostMicros'],
                         'terminalCostReconciled': True, 'captureAuthority': False,
                         'captureStatus': 'CAPTURE_UNCERTAIN', 'answerGrade': 'NOT_EVALUATED',
                         'reconciliationProofSha256': digest(data(proof))}
            active = None
        else:
            require(row.get('event') == 'settled' and set(row) == common | {'usage'})
            require(active == key and runs[key]['reservationId'] == row['reservationId'])
            usage = row['usage']
            require(set(usage) == {'chargedCostMicros', 'ledgerSha256', 'envelopeSha256', 'captureAuthority'})
            cost = usage['chargedCostMicros']
            require(usage['captureAuthority'] is True and type(cost) is int and 0 <= cost <= runs[key]['ceilingMicros'])
            require(HASH.fullmatch(usage['ledgerSha256']) and HASH.fullmatch(usage['envelopeSha256']))
            charged += cost
            runs[key] = {**runs[key], 'chargedCostMicros': cost}
            active = None
    committed = charged + (runs[active]['ceilingMicros'] if active else 0)
    return {'protocolVersion': 3, 'eventCount': len(events), 'runs': runs, 'activeRun': active,
            'knownSettledCostMicros': charged, 'committedCostMicros': committed,
            'remainingReservationMicros': MAX_TOTAL - committed, 'perCaseMaxCostMicros': MAX_V2_CASE,
            'historicalPrefixSha256': FRESH_PREFIX, 'olderCosts': 'UNRESOLVED_SEPARATE_NOT_REPLACED'}


def execute_fresh(request):
    op, root = request['op'], request['root']
    require(root == FRESH_ROOT and op in {'fresh_adopt', 'fresh_read', 'fresh_reserve', 'fresh_settle', 'fresh_reconcile_terminal'})
    adopt = op == 'fresh_adopt'
    old = request.get('state')
    require(adopt or (type(old) is dict and old.get('freshVersion') == 1 and old.get('root') == root))
    state = {'root': root, 'freshVersion': 1, 'directories': {}, 'files': {}}
    drive, parts = protocol['components'](root, root=True)
    with contextlib.ExitStack() as stack:
        retain = stack.enter_context
        def bind(key, handle):
            identity = native['inspect'](handle)['identity']
            require(adopt or old['directories'].get(key) == identity)
            state['directories'][key] = identity
        parent = retain(native['open_volume'](drive)); key = drive
        bind(key, parent)
        for part in parts:
            parent = retain(native['open_child'](parent, part, True)); key += '/' + part
            bind(key, parent)
        contents, handles = {}, {}
        for name in ('run-authorization.json', 'fresh-spend.jsonl'):
            handle = retain(native['open_child'](parent, name, False,
                            write=name == 'fresh-spend.jsonl' and op in {'fresh_reserve', 'fresh_settle', 'fresh_reconcile_terminal'}))
            value = native['read_bytes'](handle)
            descriptor = {'identity': native['inspect'](handle)['identity'], 'sha256': digest(value), 'bytes': len(value)}
            require(adopt or old['files'].get(name) == descriptor)
            state['files'][name], contents[name], handles[name] = descriptor, value, handle
        require(adopt or (set(old['files']) == set(state['files']) and set(old['directories']) == set(state['directories'])))
        require(digest(contents['run-authorization.json']) == FRESH_AUTHORIZATION)
        wire = contents['fresh-spend.jsonl']
        snapshot = reduce_fresh(wire)
        if adopt:
            require(snapshot['eventCount'] == 24 and snapshot['activeRun'] is None)
        if op in {'fresh_adopt', 'fresh_read'}:
            return {'state': state, 'snapshot': snapshot}
        event = request['event']
        kind = op.removeprefix('fresh_')
        fields = {'kind', 'caseId', 'captureRunId', 'reservationId'}
        fields |= ({'ceilingMicros'} if kind == 'reserve' else {'proof'} if kind == 'reconcile_terminal'
                   else {'chargedCostMicros', 'ledgerSha256', 'envelopeSha256'})
        require(set(event) == fields and event['kind'] == kind)
        if kind == 'reserve' and event.get('caseId') == '14':
            require(snapshot['eventCount'] >= 24 and snapshot['activeRun'] is None)
            require(digest(b''.join(wire.splitlines(keepends=True)[:24])) == FRESH_CASE14_PREFIX)
        row = {k: event[k] for k in ('caseId', 'captureRunId', 'reservationId')}
        row.update({'nativeCaptureVersion': 1, 'sequence': snapshot['eventCount'] + 1,
                    'atMs': int(time.time()*1000), 'event': 'reserved' if kind == 'reserve' else 'settled'})
        if kind == 'reserve':
            row['ceilingMicros'] = event['ceilingMicros']
        elif kind == 'reconcile_terminal':
            require(snapshot['eventCount'] in {21, 23})
            row['event'] = 'terminal_cost_reconciled'
            row['proof'] = event['proof']
        else:
            row['usage'] = {k: event[k] for k in ('chargedCostMicros', 'ledgerSha256', 'envelopeSha256')}
            row['usage']['captureAuthority'] = True
        addition = data(row) + b'\n'
        next_snapshot = reduce_fresh(wire + addition)
        require(len(wire) + len(addition) <= native['MAX_BYTES'])
        handle = handles['fresh-spend.jsonl']
        native['checked'](native['Seek'](handle.value, len(wire), None, 0))
        offset = 0
        while offset < len(addition):
            piece, count = addition[offset:], native['ULONG']()
            buffer = native['c'].create_string_buffer(piece)
            native['checked'](native['Write'](handle.value, buffer, len(piece), native['c'].byref(count), None))
            require(count.value > 0)
            offset += count.value
        native['checked'](native['Flush'](handle.value))
        require(native['read_bytes'](handle) == wire + addition)
        state['files']['fresh-spend.jsonl'].update({'sha256': digest(wire + addition), 'bytes': len(wire + addition)})
        return {'state': state, 'snapshot': next_snapshot, 'event': row}


def execute(request):
    op = request.get('op')
    if isinstance(op, str) and op.startswith('fresh_'):
        return execute_fresh(request)
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
    require(op in {'read', 'reserve', 'settle', 'close_terminal_uncertain', 'revise_protocol', 'reconcile_terminal'})
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
                   {'disposition', 'chargedCostMicros', 'proof'} if op == 'reconcile_terminal' else
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
