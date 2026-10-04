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
CASE14_CEILING, CASE14_APPROVAL, CASE14_RECALL = 15_000_000, 1_000_000, 14_000_000
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
HASH = re.compile(r'[a-f0-9]{64}')
TERMINAL_CASE01_RUN = 'c6ffa5ad-dd9f-4912-bc31-a03231a9b903'
TERMINAL_CASE01_RESERVATION = 'd63fd741-aac6-4d3d-9c4d-1276b96bd1a3'
TERMINAL_CASE01_INVENTORY = '113c55d76637edfd807e5e3efced931e2b2dd73052dabba4d2e0607aff6e57b8'
TERMINAL_CASE01_PROOF = 'd8555b206bf7d47630838885f8fe4fce0e8fb5f25fda851e3b8e07e54b17314f'
FRESH_ROOT = r'C:\dev\main\outputs\meri-fresh-20261003'
FRESH_PREFIX = 'abe458973e6998db20586c781ac5a3cbd4ca2fa565425e62722f0eb9c985210b'
FRESH_CASE14_PREFIX = '8f20134f71dde90e32fc0c3c2aba2da2d5b93dd13fffea31b83105d1621bc3e5'
FRESH_CASE12_PREFIX26 = '816b04a47be56432846d1ee602370c3bea985eb497a7de9e899aee4d53f8b39e'
CASE12_FAILED_CAPTURE_RUN = '4a32f9ce-3caa-49f2-95ef-2a512c854468'
CASE12_FAILED_CAPTURE_RESERVATION = 'b4522136-07bc-4243-aac8-8cbd3101083a'
CASE12_FAILED_CAPTURE_CONVERSATION = '40dd8401-dcfe-46bd-b010-c30e7098297c'
CASE12_FAILED_CAPTURE_JOURNAL29 = 'b3326761fd5d7b93f8c85d7c59515b4c40f9bb430f68adce4dccfcb4e0da0904'
CASE12_FAILED_CAPTURE_QUALIFICATION = 'd267a5985fc3caeb94416393a684877bfa81a33b3db27d99a48d76afa6ece905'
# Deliberately dormant. Root may bind only after independent fresh read-only joins.
CASE12_FAILED_CAPTURE_PROOF_SHA256 = '4702740c2f91a0ba4bd16bf845ce5d5db871d5972ef4ea8efcd5c0ba2d24475e'
# Root must bind the SHA-256 of the exact approved human amendment file.
# Caller-supplied JSON is never authority; None keeps amendment disabled by default.
BUDGET_AMENDMENT_AUTHORITY_SHA256 = 'be0b1ca012495ba58486af4c92bd14345b0600c046cff913bf6da2852bbb8a62'
FRESH_JOURNAL30_SHA256 = '91f3a7288d35972aab78310ed2feea2f089482ba48a95dd58bdf975d76c6be56'
FRESH_JOURNAL30_IDENTITY = '5081a475:80000:11d75c5:1dd52d7:92f07d2a'
# DRAFT: set only after independently reviewed authentic postdeadline proof.
CASE14_TERMINAL_PROOF_SHA256 = '1bd0de197e10510a119e9da6e1e41b3a27c40421ebc421d1014926750577c893'
CASE14_TERMINAL_PREFIX25 = '139b6d7199038ca752c553289bf1ebe9c45f14e65956710f82a48301b132e673'
FRESH_AUTHORIZATION = 'e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe'


def require(condition):
    if not condition:
        raise ValueError('CAPTURE_SPEND_REJECTED')


def data(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf-8')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def valid_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


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
    # Historical 20 events remain adopted byte-for-byte; only the prospective tail is changed.
    lines = wire.splitlines(keepends=True)
    require(len(lines) >= 20 and all(line.endswith(b'\n') for line in lines))
    require(digest(b''.join(lines[:20])) == FRESH_PREFIX)
    if len(lines) >= 30:
        require(digest(b''.join(lines[:30])) == FRESH_JOURNAL30_SHA256)
    else:
        require(len(lines) == 20)
    events = [json.loads(line) for line in lines]
    require(len(events) <= 10000)
    runs, reservation_ids, capture_ids, active, charged = {}, set(), set(), None, 0
    conservative_approval = 0
    effective_max, amendment_sha256 = MAX_TOTAL, None
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
        if row.get('event') == 'budget_amended':
            require(sequence == 31 and effective_max == MAX_TOTAL and amendment_sha256 is None)
            require(valid_hash(BUDGET_AMENDMENT_AUTHORITY_SHA256))
            require(set(row) == {'nativeCaptureVersion', 'sequence', 'atMs', 'event', 'oldMaxCostMicros',
                'maxCostMicros', 'perCaseMaxCostMicros', 'concurrency', 'approvalSha256',
                'journalBeforeSha256', 'originalJournal30Sha256', 'journalFileIdentity'})
            require(type(row['nativeCaptureVersion']) is int and row['nativeCaptureVersion'] == 1)
            require(type(row['sequence']) is int and row['sequence'] == 31)
            require(type(row['atMs']) is int and row['atMs'] > 0)
            require(all(type(row[k]) is int for k in ('oldMaxCostMicros', 'maxCostMicros', 'perCaseMaxCostMicros', 'concurrency')))
            require(row['oldMaxCostMicros'] == MAX_TOTAL and row['maxCostMicros'] == 500_000_000)
            require(row['perCaseMaxCostMicros'] == MAX_V2_CASE and row['concurrency'] == 1)
            require(row['approvalSha256'] == BUDGET_AMENDMENT_AUTHORITY_SHA256)
            require(row['journalBeforeSha256'] == FRESH_JOURNAL30_SHA256 and
                    row['originalJournal30Sha256'] == FRESH_JOURNAL30_SHA256 and
                    row['journalFileIdentity'] == FRESH_JOURNAL30_IDENTITY)
            require(active is None and charged + conservative_approval <= MAX_TOTAL)
            effective_max, amendment_sha256 = row['maxCostMicros'], row['approvalSha256']
            continue
        if row.get('caseId') == '12':
            # Case12 failure-cost closeout is a one-shot, exact run29 disposition.
            # Its proof stays disabled until the opaque root binds a proof hash
            # after fresh read-only conversation/stream/qualification joins.
            require(sequence >= 27 and digest(b''.join(lines[:26])) == FRESH_CASE12_PREFIX26)
            if row.get('event') == 'case12_capture_failure_cost_reconciled':
                require(sequence == 30 and len(lines) >= 30)
                require(digest(b''.join(lines[:29])) == CASE12_FAILED_CAPTURE_JOURNAL29)
                require(valid_hash(CASE12_FAILED_CAPTURE_PROOF_SHA256))
                common_failure = {'nativeCaptureVersion', 'sequence', 'atMs', 'event', 'caseId', 'captureRunId', 'reservationId'}
                require(set(row) == common_failure | {'proof'})
                require(row['caseId'] == '12' and row['captureRunId'] == CASE12_FAILED_CAPTURE_RUN)
                require(row['reservationId'] == CASE12_FAILED_CAPTURE_RESERVATION)
                require(type(row['nativeCaptureVersion']) is int and row['nativeCaptureVersion'] == 1)
                require(type(row['sequence']) is int and row['sequence'] == 30)
                require(type(row['atMs']) is int and row['atMs'] > 0)
                key = '12:' + CASE12_FAILED_CAPTURE_RUN
                held = runs.get(key)
                require(active == key and type(held) is dict)
                require(held.get('event') == 'case12_capture_reserved' and held.get('sequence') == 29)
                require(held.get('reservationId') == CASE12_FAILED_CAPTURE_RESERVATION)
                require(held.get('ceilingMicros') == 13_797_053)
                require(held.get('setupRunId') == '4aa30f1a-c852-43db-840e-62538d475373')
                require(held.get('setupReservationId') == 'a11468ee-4005-4daa-a238-843647a3a8e0')
                require(held.get('setupTerminalProofSha256') == '50dab4fae1a4563a5bc56a7ece9ab80bb9e3da29f6403a7e645e6b99d230a212')
                require(type(held.get('atMs')) is int and held['atMs'] <= row['atMs'])
                proof = row['proof']
                proof_fields = {'kind', 'caseId', 'captureRunId', 'reservationId', 'conversationId',
                    'journalBeforeSha256', 'qualificationSha256', 'authenticatedReadbackSha256',
                    'streamResponseSha256', 'qualificationSourceSha256', 'streamRunId',
                    'streamHttpStatus', 'streamErrorCode', 'failureReason', 'streamAccepted',
                    'messageCount', 'turnId', 'ledgerActivation', 'ledgerAttempts',
                    'chargedAttempts', 'chargedTokens', 'chargedCostMicros', 'modelDispatch',
                    'sourceAcceptance', 'captureAuthority', 'liveAcceptance', 'observedAtMs'}
                require(type(proof) is dict and set(proof) == proof_fields)
                require(digest(data(proof)) == CASE12_FAILED_CAPTURE_PROOF_SHA256)
                require(proof['kind'] == 'meri-case12-failed-capture-cost-terminal')
                require(proof['caseId'] == '12' and proof['captureRunId'] == CASE12_FAILED_CAPTURE_RUN)
                require(proof['reservationId'] == CASE12_FAILED_CAPTURE_RESERVATION)
                require(proof['conversationId'] == CASE12_FAILED_CAPTURE_CONVERSATION)
                require(proof['journalBeforeSha256'] == CASE12_FAILED_CAPTURE_JOURNAL29)
                require(proof['qualificationSha256'] == CASE12_FAILED_CAPTURE_QUALIFICATION)
                for field in ('authenticatedReadbackSha256', 'streamResponseSha256', 'qualificationSourceSha256'):
                    require(valid_hash(proof[field]))
                require(proof['streamRunId'] == '7c525f0c-2ee9-4409-9df7-8cf8389ac23f')
                require(proof['streamHttpStatus'] == 201)
                require(proof['streamErrorCode'] == 'MERI_STREAM_SETUP_ERROR')
                require(proof['failureReason'] == 'meri_capture_provider_budget_unqualified_retrieval_plan')
                require(proof['streamAccepted'] is False and proof['sourceAcceptance'] is False)
                require(type(proof['messageCount']) is int and proof['messageCount'] == 0 and proof['turnId'] is None)
                require(proof['ledgerActivation'] == 'enforced' and proof['ledgerAttempts'] == [])
                for field in ('chargedAttempts', 'chargedTokens', 'chargedCostMicros'):
                    require(type(proof[field]) is int and proof[field] == 0)
                require(proof['modelDispatch'] is False and proof['captureAuthority'] is False)
                require(proof['liveAcceptance'] == 'NOT_RUN')
                require(type(proof['observedAtMs']) is int and proof['observedAtMs'] > 0 and proof['observedAtMs'] <= row['atMs'])
                # Zero is a known terminal cost, not an unset/null amount.
                require(type(proof['chargedCostMicros']) is int and proof['chargedCostMicros'] == 0)
                runs[key] = {**held, 'chargedCostMicros': 0, 'failureCostReconciled': True,
                    'captureAuthority': False, 'captureStatus': 'FAILED_BEFORE_ACCEPTANCE',
                    'answerGrade': 'NOT_EVALUATED', 'failureProofSha256': digest(data(proof))}
                active = None
                continue
            if row.get('event') in {'case12_capture_reserved', 'case12_capture_settled'}:
                # Dedicated capture accounting, after the separately known-settled
                # setup. A private current capture outcome is still required by JS.
                require(type(row['nativeCaptureVersion']) is int and type(row['sequence']) is int)
                require(all(type(row.get(k)) is str and UUID.fullmatch(row[k]) for k in ('captureRunId', 'reservationId')))
                key = '12:' + row['captureRunId']
                if row['event'] == 'case12_capture_reserved':
                    require(set(row) == common | {'ceilingMicros', 'setupRunId', 'setupReservationId', 'setupTerminalProofSha256'})
                    require(active is None and key not in runs and row['captureRunId'] != row['reservationId'] and row['captureRunId'] != row['setupRunId'])
                    require(row['captureRunId'] not in capture_ids | reservation_ids and row['reservationId'] not in capture_ids | reservation_ids)
                    require(not any(r.get('event') == 'case12_capture_reserved' for r in runs.values()))
                    require(all(type(row.get(k)) is str and UUID.fullmatch(row[k]) for k in ('setupRunId', 'setupReservationId')))
                    require(type(row['setupTerminalProofSha256']) is str and valid_hash(row['setupTerminalProofSha256']))
                    setup = runs.get('12:' + row['setupRunId'])
                    require(type(setup) is dict and setup.get('event') == 'case12_setup_reserved' and setup.get('setupCostSettled') is True)
                    require(type(setup.get('chargedCostMicros')) is int and setup['chargedCostMicros'] > 0)
                    require(setup['reservationId'] == row['setupReservationId'] and setup['terminalProofSha256'] == row['setupTerminalProofSha256'])
                    settlements = [r for r in events[:sequence-1] if r.get('event') == 'case12_setup_settled' and r.get('setupRunId') == row['setupRunId']]
                    require(len(settlements) == 1 and settlements[0]['atMs'] <= row['atMs'])
                    cost = ceiling(row['ceilingMicros'], MAX_V2_CASE)
                    prior_case_cost = sum(r.get('chargedCostMicros', r['ceilingMicros']) for r in runs.values() if r['caseId'] == '12')
                    require(prior_case_cost + cost <= MAX_V2_CASE and charged + conservative_approval + cost <= effective_max)
                    runs[key], active = dict(row), key
                    capture_ids.add(row['captureRunId']); reservation_ids.add(row['reservationId'])
                else:
                    require(set(row) == common | {'usage'} and active == key)
                    held, usage = runs[key], row['usage']
                    require(held.get('event') == 'case12_capture_reserved' and held['reservationId'] == row['reservationId'] and held['atMs'] <= row['atMs'])
                    require(type(usage) is dict and set(usage) == {'chargedCostMicros', 'ledgerSha256', 'envelopeSha256', 'captureAuthority'})
                    cost = usage['chargedCostMicros']
                    require(type(cost) is int and 0 <= cost <= held['ceilingMicros'] and usage['captureAuthority'] is True)
                    require(all(type(usage[k]) is str and valid_hash(usage[k]) for k in ('ledgerSha256', 'envelopeSha256')))
                    charged += cost
                    runs[key] = {**held, 'chargedCostMicros': cost}
                    active = None
                require(charged + conservative_approval + (runs[active]['ceilingMicros'] if active else 0) <= effective_max)
                continue
            common = {'nativeCaptureVersion', 'sequence', 'atMs', 'event', 'caseId', 'setupRunId', 'reservationId'}
            require(UUID.fullmatch(row.get('setupRunId', '')) and UUID.fullmatch(row.get('reservationId', '')))
            key = '12:' + row['setupRunId']
            if row.get('event') == 'case12_setup_reserved':
                require(set(row) == common | {'ceilingMicros', 'setupPlanSha256', 'fixtureInstanceId', 'providerDeadlineAtMs', 'captureAuthority'})
                require(active is None and key not in runs and not any(r['caseId'] == '12' for r in runs.values()))
                require(row['setupRunId'] not in capture_ids and row['reservationId'] not in reservation_ids)
                require(valid_hash(row['setupPlanSha256']) and UUID.fullmatch(row['fixtureInstanceId']))
                require(type(row['providerDeadlineAtMs']) is int and row['atMs'] < row['providerDeadlineAtMs'] <= row['atMs'] + 86_400_000)
                require(row['captureAuthority'] is False)
                cost = ceiling(row['ceilingMicros'], MAX_V2_CASE)
                require(charged + conservative_approval + cost <= effective_max)
                runs[key], active = dict(row), key
                capture_ids.add(row['setupRunId']); reservation_ids.add(row['reservationId'])
            else:
                require(row.get('event') == 'case12_setup_settled' and active == key)
                require(set(row) == common | {'proof'})
                held, proof = runs[key], row['proof']
                require(held['reservationId'] == row['reservationId'])
                require(set(proof) == {'kind', 'caseId', 'setupRunId', 'reservationId', 'fixtureInstanceId', 'setupPlanSha256',
                    'ledgerSha256', 'authenticatedReadbackSha256', 'projectionTerminalSha256', 'helperCleanupSha256', 'censusSha256',
                    'chargedCostMicros', 'providerAttempts', 'pendingProviderAttempts', 'completedRows', 'completedAtMs', 'observedAtMs',
                    'providerDeadlineAtMs', 'captureAuthority', 'liveAcceptance', 'allCostKnown', 'allOwnedOutboxTerminal', 'bothVectorBranchesVerified'})
                require(proof['kind'] == 'meri-case12-setup-cost-terminal' and proof['caseId'] == '12')
                require(all(proof[k] == held[k] for k in ('setupRunId', 'reservationId', 'fixtureInstanceId', 'setupPlanSha256', 'providerDeadlineAtMs')))
                for field in ('ledgerSha256', 'authenticatedReadbackSha256', 'projectionTerminalSha256', 'helperCleanupSha256', 'censusSha256'):
                    require(valid_hash(proof[field]))
                require(type(proof['chargedCostMicros']) is int and 0 < proof['chargedCostMicros'] <= held['ceilingMicros'])
                require(type(proof['providerAttempts']) is int and proof['providerAttempts'] == 1020)
                require(type(proof['pendingProviderAttempts']) is int and proof['pendingProviderAttempts'] == 0)
                require(type(proof['completedRows']) is int and proof['completedRows'] == 510)
                require(type(proof['completedAtMs']) is int and type(proof['observedAtMs']) is int)
                require(held['atMs'] <= proof['completedAtMs'] <= proof['observedAtMs'] <= row['atMs'])
                require(proof['captureAuthority'] is False and proof['liveAcceptance'] == 'NOT_RUN')
                require(proof['allCostKnown'] is True and proof['allOwnedOutboxTerminal'] is True and proof['bothVectorBranchesVerified'] is True)
                charged += proof['chargedCostMicros']
                runs[key] = {**held, 'chargedCostMicros': proof['chargedCostMicros'], 'setupCostSettled': True,
                             'terminalProofSha256': digest(data(proof)), 'captureAuthority': False}
                active = None
            require(charged + conservative_approval + (runs[active]['ceilingMicros'] if active else 0) <= effective_max)
            continue
        key = run_key(row, {'01', '14', '20', '46'})
        if row['caseId'] == '14':
            require(sequence >= 25 and digest(b''.join(lines[:24])) == FRESH_CASE14_PREFIX)
        if row['caseId'] == '46':
            require(digest(b''.join(lines[:26])) == FRESH_CASE12_PREFIX26 and sequence >= 27)
        require(UUID.fullmatch(row.get('reservationId', '')))
        if row.get('event') == 'reserved':
            case14 = row['caseId'] == '14'
            case46 = row['caseId'] == '46'
            fixed = {'ceilingMicros', 'approvalCeilingMicros', 'recallCeilingMicros', 'approvalBoundSha256'} if case14 else {'ceilingMicros'}
            require(set(row) == common | fixed)
            require(active is None and key not in runs and row['reservationId'] not in reservation_ids and row['captureRunId'] not in capture_ids)
            if case14:
                require(sequence == 25 and not any(run['caseId'] == '14' and not run.get('historical') for run in runs.values()))
                require(all(type(row[k]) is int for k in ('ceilingMicros', 'approvalCeilingMicros', 'recallCeilingMicros')))
                require(row['ceilingMicros'] == CASE14_CEILING and
                        row['approvalCeilingMicros'] == CASE14_APPROVAL and
                        row['recallCeilingMicros'] == CASE14_RECALL and
                        valid_hash(row.get('approvalBoundSha256')))
            if case46:
                require(not any(run['caseId'] == '46' for run in runs.values()))
            cost = ceiling(row['ceilingMicros'], MAX_CASE if case46 else MAX_V2_CASE)
            require(charged + conservative_approval + cost <= effective_max)
            runs[key], active = dict(row), key
            reservation_ids.add(row['reservationId'])
            capture_ids.add(row['captureRunId'])
        elif row.get('event') == 'terminal_cost_reconciled':
            require(set(row) == common | {'proof'})
            proof = row['proof']
            if sequence == 22:
                require(digest(b''.join(lines[:21])) == '7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60')
                require(digest(data(proof)) == '59b7055d48bb074d13f57eb16c93334b258800107c039667aa445c3bf5e26648')
            elif sequence == 26:
                require(row['caseId'] == '14')
                require(row['captureRunId'] == '5f4312a2-6aa9-4ec8-820d-5717a88402df')
                require(row['reservationId'] == '9b299041-d425-45fa-9a41-439745f4a912')
                require(digest(b''.join(lines[:25])) == CASE14_TERMINAL_PREFIX25)
                require(valid_hash(CASE14_TERMINAL_PROOF_SHA256))
                require(digest(data(proof)) == CASE14_TERMINAL_PROOF_SHA256)
                require(proof['journalBeforeSha256'] == CASE14_TERMINAL_PREFIX25)
                require(proof['chargedCostMicros'] == 1_569_851)
                require(proof['conservativeApprovalCostMicros'] == CASE14_APPROVAL)
                require(proof['approvalBilledActualMicros'] is None)
                require(proof['combinedCommittedCostMicros'] == 2_569_851)
                require(proof['approvalBoundSha256'] == runs[key]['approvalBoundSha256'])
                require(proof['providerAttempts'] == 3 and proof['pendingProviderAttempts'] == 0)
                require(proof['observedAtMs'] > proof['providerDeadlineAtMs'])
                require(proof['failure'] == 'CASE01_SOURCE_TOOL_JOIN_MISMATCH')
                require(proof['captureStatus'] == 'CAPTURE_UNCERTAIN')
            else:
                require(sequence == 24 and row['caseId'] == '20')
                require(row['captureRunId'] == 'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b')
                require(row['reservationId'] == '7ea73cdc-526e-4b31-8c28-b0636ea8d2ae')
                require(digest(b''.join(lines[:23])) == 'd6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b')
                require(digest(data(proof)) == '305283f0048a7f7ae82dc322f8353a2499cc444cc2e60537736375d0e5eed3a0')
            require(all(row[k] == proof[k] for k in ('caseId', 'captureRunId', 'reservationId')))
            require(active == key and runs[key]['reservationId'] == row['reservationId'])
            require(runs[key]['ceilingMicros'] == MAX_V2_CASE and row['atMs'] >= proof['observedAtMs'])
            require(proof['captureAuthority'] is False and proof['answerGrade'] == 'NOT_EVALUATED')
            require(type(proof['chargedCostMicros']) is int and proof['chargedCostMicros'] >= 0)
            charged += proof['chargedCostMicros']
            runs[key] = {**runs[key], 'chargedCostMicros': proof['chargedCostMicros'],
                         'terminalCostReconciled': True, 'captureAuthority': False,
                         'captureStatus': 'CAPTURE_UNCERTAIN', 'answerGrade': 'NOT_EVALUATED',
                         'reconciliationProofSha256': digest(data(proof))}
            if sequence == 26:
                conservative_approval += CASE14_APPROVAL
                runs[key].update({'conservativeApprovalCostMicros': CASE14_APPROVAL,
                                  'approvalBilledActualMicros': None,
                                  'approvalOutcomeSha256': proof['approvalOutcomeSha256'],
                                  'projectionTerminalSha256': proof['projectionTerminalSha256']})
            active = None
        else:
            case46 = row['caseId'] == '46'
            require(row.get('event') == ('case46_governed_settled' if case46 else 'settled'))
            require(active == key and runs[key]['reservationId'] == row['reservationId'])
            usage = row.get('usage', {})
            is14 = row['caseId'] == '14'
            common_usage = {'chargedCostMicros', 'ledgerSha256', 'envelopeSha256', 'captureAuthority'}
            extra_usage = {'conservativeApprovalCostMicros', 'approvalBoundSha256', 'approvalOutcomeSha256', 'projectionTerminalSha256'}
            require(set(row) == common | {'usage'})
            case46_usage = {'governedCapture'}
            require(set(usage) == common_usage | (extra_usage if is14 else case46_usage if case46 else set()))
            cost = usage['chargedCostMicros']
            max_recall = runs[key]['recallCeilingMicros'] if is14 else runs[key]['ceilingMicros']
            require(usage['captureAuthority'] is True and type(cost) is int and 0 <= cost <= max_recall)
            require(valid_hash(usage['ledgerSha256']) and valid_hash(usage['envelopeSha256']))
            if case46:
                require(usage['governedCapture'] == 'meri-case46-authenticated-capture')
                charged += cost
                runs[key] = {**runs[key], 'chargedCostMicros': cost, 'governedCapture': usage['governedCapture']}
            elif is14:
                require(type(usage['conservativeApprovalCostMicros']) is int and usage['conservativeApprovalCostMicros'] == CASE14_APPROVAL)
                require(usage['approvalBoundSha256'] == runs[key]['approvalBoundSha256'])
                require(valid_hash(usage['approvalOutcomeSha256']) and valid_hash(usage['projectionTerminalSha256']))
                charged += cost
                conservative_approval += CASE14_APPROVAL
                runs[key] = {**runs[key], 'chargedCostMicros': cost,
                             'conservativeApprovalCostMicros': CASE14_APPROVAL,
                             'approvalOutcomeSha256': usage['approvalOutcomeSha256'],
                             'projectionTerminalSha256': usage['projectionTerminalSha256']}
            else:
                charged += cost
                runs[key] = {**runs[key], 'chargedCostMicros': cost}
            active = None
    committed = charged + conservative_approval + (runs[active]['ceilingMicros'] if active else 0)
    require(committed <= effective_max)
    result = {'protocolVersion': 3, 'eventCount': len(events), 'runs': runs, 'activeRun': active,
            'knownSettledCostMicros': charged, 'conservativeApprovalCostMicros': conservative_approval,
            'committedCostMicros': committed, 'remainingReservationMicros': effective_max - committed,
            'perCaseMaxCostMicros': MAX_V2_CASE, 'historicalPrefixSha256': FRESH_PREFIX,
            'olderCosts': 'UNRESOLVED_SEPARATE_NOT_REPLACED'}
    if amendment_sha256 is not None:
        result.update({'maxCostMicros': effective_max, 'approvalSha256': amendment_sha256})
    case12 = [r for r in runs.values() if r['caseId'] == '12']
    if case12:
        used = sum(r.get('chargedCostMicros', r['ceilingMicros']) for r in case12)
        require(used <= MAX_V2_CASE)
        result.update({'case12CommittedCostMicros': used, 'case12RemainingCostMicros': MAX_V2_CASE-used})
    return result


def execute_fresh(request):
    op, root = request['op'], request['root']
    require(root == FRESH_ROOT and op in {'fresh_adopt', 'fresh_read', 'fresh_reserve', 'fresh_settle', 'fresh_reconcile_terminal', 'fresh_case12_setup_reserve', 'fresh_case12_setup_settle', 'fresh_case12_capture_reserve', 'fresh_case12_capture_settle', 'fresh_case12_capture_failure_reconcile', 'fresh_amend_budget'})
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
                            write=name == 'fresh-spend.jsonl' and op in {'fresh_reserve', 'fresh_settle', 'fresh_reconcile_terminal', 'fresh_case12_setup_reserve', 'fresh_case12_setup_settle', 'fresh_case12_capture_reserve', 'fresh_case12_capture_settle', 'fresh_case12_capture_failure_reconcile', 'fresh_amend_budget'}))
            value = native['read_bytes'](handle)
            descriptor = {'identity': native['inspect'](handle)['identity'], 'sha256': digest(value), 'bytes': len(value)}
            require(adopt or old['files'].get(name) == descriptor)
            state['files'][name], contents[name], handles[name] = descriptor, value, handle
        if op == 'fresh_amend_budget':
            require(not adopt and state['files']['fresh-spend.jsonl']['identity'] == FRESH_JOURNAL30_IDENTITY)
            require(state['files']['fresh-spend.jsonl']['bytes'] == 21204)
        require(adopt or (set(old['files']) == set(state['files']) and set(old['directories']) == set(state['directories'])))
        require(digest(contents['run-authorization.json']) == FRESH_AUTHORIZATION)
        wire = contents['fresh-spend.jsonl']
        snapshot = reduce_fresh(wire)
        if adopt:
            require(snapshot['eventCount'] == 20 and snapshot['activeRun'] is None)
        if op in {'fresh_adopt', 'fresh_read'}:
            return {'state': state, 'snapshot': snapshot}
        if op == 'fresh_amend_budget':
            require(valid_hash(BUDGET_AMENDMENT_AUTHORITY_SHA256))
            require(snapshot['eventCount'] == 30 and snapshot['activeRun'] is None)
            require(digest(wire) == FRESH_JOURNAL30_SHA256)
            row = {'nativeCaptureVersion': 1, 'sequence': 31,
                   'atMs': int(time.time()*1000), 'event': 'budget_amended',
                   'oldMaxCostMicros': MAX_TOTAL, 'maxCostMicros': 500_000_000,
                   'perCaseMaxCostMicros': MAX_V2_CASE, 'concurrency': 1,
                   'approvalSha256': BUDGET_AMENDMENT_AUTHORITY_SHA256,
                   'journalBeforeSha256': FRESH_JOURNAL30_SHA256,
                   'originalJournal30Sha256': FRESH_JOURNAL30_SHA256,
                   'journalFileIdentity': FRESH_JOURNAL30_IDENTITY}
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
        event = request['event']
        kind = op.removeprefix('fresh_')
        setup = kind in {'case12_setup_reserve', 'case12_setup_settle'}
        fields = {'kind', 'caseId', 'setupRunId' if setup else 'captureRunId', 'reservationId'}
        if kind == 'case12_capture_reserve':
            fields |= {'ceilingMicros', 'setupRunId', 'setupReservationId', 'setupTerminalProofSha256'}
        elif kind == 'case12_capture_settle':
            fields |= {'chargedCostMicros', 'ledgerSha256', 'envelopeSha256'}
        elif kind == 'case12_capture_failure_reconcile':
            fields |= {'proof'}
        elif kind == 'case12_setup_reserve':
            fields |= {'ceilingMicros', 'setupPlanSha256', 'fixtureInstanceId', 'providerDeadlineAtMs', 'captureAuthority'}
        elif kind == 'case12_setup_settle':
            fields |= {'proof'}
        elif kind == 'reserve':
            fields |= {'ceilingMicros'}
            if event.get('caseId') == '14':
                fields |= {'approvalCeilingMicros', 'recallCeilingMicros', 'approvalBoundSha256'}
        elif kind == 'settle' and event.get('caseId') == '46':
            fields |= {'chargedCostMicros', 'ledgerSha256', 'envelopeSha256', 'governedCapture'}
        elif kind == 'reconcile_terminal':
            fields |= {'proof'}
        else:
            fields |= {'chargedCostMicros', 'ledgerSha256', 'envelopeSha256'}
            if event.get('caseId') == '14':
                fields |= {'conservativeApprovalCostMicros', 'approvalBoundSha256', 'approvalOutcomeSha256', 'projectionTerminalSha256'}
        require(set(event) == fields and event['kind'] == kind)
        row = {k: event[k] for k in ('caseId', 'setupRunId' if setup else 'captureRunId', 'reservationId')}
        row.update({'nativeCaptureVersion': 1, 'sequence': snapshot['eventCount'] + 1,
                    'atMs': int(time.time()*1000), 'event': 'reserved' if kind == 'reserve' else 'case46_governed_settled' if kind == 'settle' and event['caseId'] == '46' else 'settled'})
        if kind == 'case12_capture_reserve':
            require(event['caseId'] == '12')
            row['event'] = 'case12_capture_reserved'
            row.update({k: event[k] for k in ('ceilingMicros', 'setupRunId', 'setupReservationId', 'setupTerminalProofSha256')})
        elif kind == 'case12_capture_settle':
            require(event['caseId'] == '12')
            row['event'] = 'case12_capture_settled'
            row['usage'] = {k: event[k] for k in ('chargedCostMicros', 'ledgerSha256', 'envelopeSha256')}
            row['usage']['captureAuthority'] = True
        elif kind == 'case12_capture_failure_reconcile':
            require(event['caseId'] == '12')
            row['event'] = 'case12_capture_failure_cost_reconciled'
            row['proof'] = event['proof']
        elif kind == 'case12_setup_reserve':
            row['event'] = 'case12_setup_reserved'
            row.update({k: event[k] for k in ('ceilingMicros', 'setupPlanSha256', 'fixtureInstanceId', 'providerDeadlineAtMs', 'captureAuthority')})
        elif kind == 'case12_setup_settle':
            row['event'] = 'case12_setup_settled'
            row['proof'] = event['proof']
        elif kind == 'reserve':
            row['ceilingMicros'] = event['ceilingMicros']
            if event['caseId'] == '14':
                row.update({k: event[k] for k in ('approvalCeilingMicros', 'recallCeilingMicros', 'approvalBoundSha256')})
        elif kind == 'reconcile_terminal':
            require(snapshot['eventCount'] in {21, 23, 25})
            row['event'] = 'terminal_cost_reconciled'
            row['proof'] = event['proof']
        else:
            row['usage'] = {k: event[k] for k in ('chargedCostMicros', 'ledgerSha256', 'envelopeSha256')}
            if event['caseId'] == '14':
                row['usage'].update({k: event[k] for k in ('conservativeApprovalCostMicros', 'approvalBoundSha256', 'approvalOutcomeSha256', 'projectionTerminalSha256')})
            if event['caseId'] == '46':
                row['usage']['governedCapture'] = event['governedCapture']
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
