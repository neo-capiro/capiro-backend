"""Native NTFS setup spend tests on disposable copies; live26 bytes stay unchanged."""
import copy
import hashlib
import pathlib
import runpy
import tempfile
import time
import unittest
import uuid

HELPER = pathlib.Path(__file__).resolve().parents[1] / 'lib/windows-capture-spend.py'
MODULE = runpy.run_path(str(HELPER))
EXECUTE = MODULE['execute']
GLOBAL = EXECUTE.__globals__
LIVE = pathlib.Path(GLOBAL['FRESH_ROOT'])
ORIGINAL = {name: (LIVE / name).read_bytes() for name in ('run-authorization.json', 'fresh-spend.jsonl')}
assert hashlib.sha256(ORIGINAL['fresh-spend.jsonl']).hexdigest() == MODULE['FRESH_CASE12_PREFIX26']
PARENT = pathlib.Path('C:/dev/main/outputs/meri-c2-20261003/case12-setup-spend-local-v1')
PARENT.mkdir(parents=True, exist_ok=True)


def reserve(amount=100_000):
    return {'kind': 'case12_setup_reserve', 'caseId': '12', 'setupRunId': str(uuid.uuid4()),
            'reservationId': str(uuid.uuid4()), 'fixtureInstanceId': str(uuid.uuid4()),
            'ceilingMicros': amount, 'setupPlanSha256': 'a'*64,
            'providerDeadlineAtMs': int(time.time()*1000)+900_000, 'captureAuthority': False}


def settle(held, amount=10_000):
    now = int(time.time()*1000)
    proof = {k: held[k] for k in ('caseId', 'setupRunId', 'reservationId', 'fixtureInstanceId', 'setupPlanSha256', 'providerDeadlineAtMs')}
    proof.update({'kind': 'meri-case12-setup-cost-terminal', 'ledgerSha256': 'b'*64,
                  'authenticatedReadbackSha256': 'c'*64, 'projectionTerminalSha256': 'd'*64,
                  'helperCleanupSha256': 'e'*64, 'censusSha256': 'f'*64,
                  'chargedCostMicros': amount, 'providerAttempts': 1020, 'pendingProviderAttempts': 0,
                  'completedRows': 510, 'completedAtMs': now, 'observedAtMs': now,
                  'captureAuthority': False, 'liveAcceptance': 'NOT_RUN', 'allCostKnown': True,
                  'allOwnedOutboxTerminal': True, 'bothVectorBranchesVerified': True})
    return {'kind': 'case12_setup_settle', **{k: held[k] for k in ('caseId', 'setupRunId', 'reservationId')}, 'proof': proof}


class Case12SetupJournal(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='native-', dir=PARENT))
        self.assertTrue(self.root.resolve().is_relative_to(PARENT.resolve()))
        # Test-only native checkpoint construction over an isolated copy. The
        # production entry has no root override or26-event adoption operation.
        prefix = b''.join(ORIGINAL['fresh-spend.jsonl'].splitlines(keepends=True)[:20])
        (self.root / 'run-authorization.json').write_bytes(ORIGINAL['run-authorization.json'])
        (self.root / 'fresh-spend.jsonl').write_bytes(prefix)
        GLOBAL['FRESH_ROOT'] = str(self.root)
        self.first = self.call('adopt')
        (self.root / 'fresh-spend.jsonl').write_bytes(ORIGINAL['fresh-spend.jsonl'])
        self.first['state']['files']['fresh-spend.jsonl'].update({
            'bytes': len(ORIGINAL['fresh-spend.jsonl']), 'sha256': hashlib.sha256(ORIGINAL['fresh-spend.jsonl']).hexdigest()})
        self.first = self.call('read', self.first)

    def tearDown(self):
        GLOBAL['FRESH_ROOT'] = str(LIVE)
        for name, value in ORIGINAL.items():
            self.assertEqual((LIVE / name).read_bytes(), value, 'live journal changed')

    def call(self, op, prior=None, event=None):
        return EXECUTE({'op': 'fresh_'+op, 'root': str(self.root),
                        **({'state': prior['state']} if prior else {}),
                        **({'event': event} if event else {})})

    def test_existing26_costs_are_identical_and_only_setup_hold_is_added(self):
        snap = self.first['snapshot']
        self.assertEqual(snap['eventCount'], 26)
        self.assertEqual(snap['knownSettledCostMicros'], 15_200_909)
        self.assertEqual(snap['conservativeApprovalCostMicros'], 1_000_000)
        self.assertEqual(snap['remainingReservationMicros'], 13_799_091)
        held = reserve()
        active = self.call('case12_setup_reserve', self.first, held)
        self.assertEqual(active['snapshot']['remainingReservationMicros'], 13_699_091)
        self.assertEqual(active['snapshot']['case12CommittedCostMicros'], 100_000)
        self.assertEqual(active['snapshot']['case12RemainingCostMicros'], 14_900_000)
        self.assertFalse(active['event']['captureAuthority'])
        self.assertTrue((self.root / 'fresh-spend.jsonl').read_bytes().startswith(ORIGINAL['fresh-spend.jsonl']))

    def test_terminal_known_cost_only_settlement_preserves_case_cumulative_spend(self):
        held = reserve()
        active = self.call('case12_setup_reserve', self.first, held)
        done = self.call('case12_setup_settle', active, settle(held))
        self.assertEqual(done['snapshot']['remainingReservationMicros'], 13_789_091)
        self.assertEqual(done['snapshot']['case12CommittedCostMicros'], 10_000)
        self.assertEqual(done['snapshot']['case12RemainingCostMicros'], 14_990_000)
        self.assertIsNone(done['snapshot']['activeRun'])
        self.assertFalse(done['event']['proof']['captureAuthority'])
        self.assertEqual(done['event']['proof']['liveAcceptance'], 'NOT_RUN')
        with self.assertRaises(ValueError):
            self.call('case12_setup_reserve', done, reserve())
        with self.assertRaises(ValueError):
            self.call('case12_setup_settle', done, settle(held))

    def test_concurrency_stale_checkpoint_adoption_and_generic_case12_are_denied(self):
        held = reserve()
        active = self.call('case12_setup_reserve', self.first, held)
        for op, prior, event in [('case12_setup_reserve', active, reserve()), ('read', self.first, None),
                                 ('case12_setup_reserve', self.first, reserve()), ('adopt', None, None),
                                 ('reserve', active, {'kind': 'reserve', 'caseId': '12', 'captureRunId': str(uuid.uuid4()),
                                                      'reservationId': str(uuid.uuid4()), 'ceilingMicros': 1})]:
            with self.subTest(op=op), self.assertRaises(ValueError):
                self.call(op, prior, event)

    def test_bad_reservation_does_not_append(self):
        for changes in [{'ceilingMicros': 13_799_092}, {'ceilingMicros': 15_000_000}, {'ceilingMicros': 0},
                        {'ceilingMicros': True}, {'ceilingMicros': 0.5}, {'caseId': '14'}, {'setupPlanSha256': 'bad'},
                        {'setupRunId': 'bad'}, {'reservationId': 'bad'}, {'fixtureInstanceId': 'bad'},
                        {'captureAuthority': True}, {'providerDeadlineAtMs': 1}, {'providerDeadlineAtMs': int(time.time()*1000)+90_000_000},
                        {'envelopeSha256': 'a'*64}]:
            with self.subTest(changes=changes), self.assertRaises((ValueError, KeyError)):
                self.call('case12_setup_reserve', self.first, {**reserve(), **changes})
            self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), ORIGINAL['fresh-spend.jsonl'])

    def test_incomplete_unknown_or_rebound_terminal_proof_cannot_release_hold(self):
        held = reserve()
        active = self.call('case12_setup_reserve', self.first, held)
        original = (self.root / 'fresh-spend.jsonl').read_bytes()
        for changes in [{'chargedCostMicros': 0}, {'chargedCostMicros': -1}, {'chargedCostMicros': 100_001},
                        {'chargedCostMicros': True}, {'pendingProviderAttempts': 1}, {'providerAttempts': 1019},
                        {'completedRows': 509}, {'captureAuthority': True}, {'allCostKnown': False},
                        {'allOwnedOutboxTerminal': False}, {'bothVectorBranchesVerified': False}, {'liveAcceptance': 'PASS'},
                        {'setupPlanSha256': 'b'*64}, {'fixtureInstanceId': str(uuid.uuid4())},
                        {'helperCleanupSha256': 'bad'}, {'completedAtMs': 1}, {'observedAtMs': int(time.time()*1000)+60000}]:
            event = settle(held); event['proof'].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.call('case12_setup_settle', active, event)
            self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), original)

    def test_modified_historical_prefix_is_rejected(self):
        held = reserve()
        active = self.call('case12_setup_reserve', self.first, held)
        wire = (self.root / 'fresh-spend.jsonl').read_bytes()
        for value in [wire[:-1], wire.replace(b'1569851', b'1569852', 1), wire + b'{']:
            with self.assertRaises((ValueError, KeyError)):
                MODULE['reduce_fresh'](value)
        self.assertEqual(self.call('read', active)['snapshot']['case12CommittedCostMicros'], held['ceilingMicros'])

    def test_partial_append_never_reopens_or_refunds(self):
        native = GLOBAL['native']; actual_write = native['Write']; calls = 0
        def partial(handle, buffer, size, count, overlapped):
            nonlocal calls
            calls += 1
            if calls > 1: raise OSError('test interrupted append')
            return actual_write(handle, buffer, size // 2, count, overlapped)
        native['Write'] = partial
        try:
            with self.assertRaises(OSError): self.call('case12_setup_reserve', self.first, reserve())
        finally: native['Write'] = actual_write
        self.assertTrue((self.root / 'fresh-spend.jsonl').read_bytes().startswith(ORIGINAL['fresh-spend.jsonl']))
        with self.assertRaises(ValueError): self.call('read', self.first)
        with self.assertRaises(ValueError): self.call('adopt')


if __name__ == '__main__':
    unittest.main(verbosity=2)
