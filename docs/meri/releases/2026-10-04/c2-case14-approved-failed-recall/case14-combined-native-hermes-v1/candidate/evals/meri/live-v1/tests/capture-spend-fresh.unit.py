"""Native Windows tests over disposable copies; no live journal mutation or cloud calls."""
import copy
import json
import os
import pathlib
import runpy
import tempfile
import unittest
import uuid

HELPER = pathlib.Path(__file__).resolve().parents[1] / 'lib/windows-capture-spend.py'
MODULE = runpy.run_path(str(HELPER))
EXECUTE = MODULE['execute']
GLOBAL = MODULE['execute'].__globals__
LIVE = pathlib.Path(GLOBAL['FRESH_ROOT'])
PARENT = pathlib.Path('C:/dev/main/outputs/meri-c2-20261003/fresh-journal-adapter-v1/local-tests')
PARENT.mkdir(parents=True, exist_ok=True)
LIVE_ORIGINAL = {name: (LIVE / name).read_bytes() for name in ('run-authorization.json', 'fresh-spend.jsonl')}
ORIGINAL = {**LIVE_ORIGINAL, 'fresh-spend.jsonl': b''.join(LIVE_ORIGINAL['fresh-spend.jsonl'].splitlines(keepends=True)[:20])}
assert MODULE['digest'](ORIGINAL['fresh-spend.jsonl']) == MODULE['FRESH_PREFIX']


def reserve(case='01', amount=15_000_000, **extra):
    event = {'kind': 'reserve', 'caseId': case, 'captureRunId': str(uuid.uuid4()),
             'reservationId': str(uuid.uuid4()), 'ceilingMicros': amount}
    if case == '14':
        event.update(approvalCeilingMicros=1_000_000, recallCeilingMicros=14_000_000,
                     approvalBoundSha256='c'*64)
    event.update(extra)
    return event


def settle(event, amount=100):
    fields = {k: event[k] for k in ('caseId', 'captureRunId', 'reservationId')}
    result = {**fields, 'kind': 'settle', 'chargedCostMicros': amount,
              'ledgerSha256': 'a'*64, 'envelopeSha256': 'b'*64}
    if event['caseId'] == '14':
        result.update(conservativeApprovalCostMicros=1_000_000,
                      approvalBoundSha256=event['approvalBoundSha256'],
                      approvalOutcomeSha256='d'*64, projectionTerminalSha256='e'*64)
    return result


class FreshJournal(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='native-', dir=PARENT))
        for name, value in ORIGINAL.items():
            (self.root / name).write_bytes(value)
        GLOBAL['FRESH_ROOT'] = str(self.root)
        self.first = self.call('adopt')

    def tearDown(self):
        GLOBAL['FRESH_ROOT'] = str(LIVE)
        for name, value in LIVE_ORIGINAL.items():
            self.assertEqual((LIVE / name).read_bytes(), value, 'live evidence changed')

    def call(self, op, prior=None, event=None, **extra):
        return EXECUTE({'op': 'fresh_'+op, 'root': str(self.root),
                        **({'state': prior['state']} if prior else {}),
                        **({'event': event} if event else {}), **extra})

    def test_adoption_preserves_all_historical_costs_and_zero_approval_field(self):
        snap = self.first['snapshot']
        self.assertEqual(snap['eventCount'], 20)
        self.assertEqual(snap['knownSettledCostMicros'], 9_841_281)
        self.assertEqual(snap['conservativeApprovalCostMicros'], 0)
        self.assertEqual(snap['remainingReservationMicros'], 20_158_719)
        self.assertEqual(snap['committedCostMicros'], 9_841_281)
        self.assertTrue(all(row['conservativeApprovalCostMicros'] == 0
                            for row in snap['runs'].values()))
        self.assertEqual(set(os.listdir(self.root)), set(ORIGINAL))
        for name, value in ORIGINAL.items():
            self.assertEqual((self.root / name).read_bytes(), value)

    def test_legacy_01_20_settlement_accounting_unchanged(self):
        event = reserve('01', 15_000_000)
        active = self.call('reserve', self.first, event)
        self.assertEqual(active['snapshot']['remainingReservationMicros'], 5_158_719)
        done = self.call('settle', active, settle(event, 1_500_000))
        self.assertEqual(done['snapshot']['knownSettledCostMicros'], 11_341_281)
        self.assertEqual(done['snapshot']['conservativeApprovalCostMicros'], 0)
        self.assertEqual(done['snapshot']['committedCostMicros'], 11_341_281)
        self.assertEqual(done['snapshot']['remainingReservationMicros'], 18_658_719)
        self.assertEqual(done['snapshot']['runs']['01:'+event['captureRunId']]['conservativeApprovalCostMicros'], 0)
        next_event = reserve('20', 1_500_000)
        next_active = self.call('reserve', done, next_event)
        next_done = self.call('settle', next_active, settle(next_event, 250_000))
        self.assertEqual(next_done['snapshot']['knownSettledCostMicros'], 11_591_281)
        self.assertEqual(next_done['snapshot']['conservativeApprovalCostMicros'], 0)
        self.assertEqual(next_done['snapshot']['runs']['20:'+next_event['captureRunId']]['chargedCostMicros'], 250_000)
        self.assertEqual(next_done['snapshot']['runs']['20:'+next_event['captureRunId']]['conservativeApprovalCostMicros'], 0)
        self.assertEqual(next_done['snapshot']['committedCostMicros'], 11_591_281)
        self.assertEqual(next_done['snapshot']['remainingReservationMicros'], 18_408_719)

    def test_checkpoint_from_before_append_is_stale(self):
        self.call('reserve', self.first, reserve())
        with self.assertRaises(ValueError):
            self.call('read', self.first)
        with self.assertRaises(ValueError):
            self.call('reserve', self.first, reserve('20'))

    def test_non14_rejections_active_hold_stale_checkpoint_and_append_prefix(self):
        for change in [{'caseId': '46'}, {'caseId': '02'}, {'ceilingMicros': 15_000_001},
                       {'ceilingMicros': 0}, {'ceilingMicros': True}, {'captureRunId': 'wrong'},
                       {'reservationId': 'wrong'}, {'settled': True}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.call('reserve', self.first, {**reserve(), **change})
        event = reserve()
        active = self.call('reserve', self.first, event)
        self.assertEqual(active['snapshot']['remainingReservationMicros'], 5_158_719)
        before = (self.root / 'fresh-spend.jsonl').read_bytes()
        for op, prior, other in [('read', self.first, None), ('reserve', self.first, reserve()),
                                 ('reserve', active, reserve('20'))]:
            with self.subTest(op=op), self.assertRaises(ValueError):
                self.call(op, prior, other)
        self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), before)


class ProspectiveCase14(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='case14-native-', dir=PARENT))
        for name, value in ORIGINAL.items():
            (self.root / name).write_bytes(value)
        GLOBAL['FRESH_ROOT'] = str(self.root)
        self.prior = self.call('adopt')
        self.wire = b''.join(LIVE_ORIGINAL['fresh-spend.jsonl'].splitlines(keepends=True)[:24])
        self.assertEqual(MODULE['digest'](self.wire), GLOBAL['FRESH_CASE14_PREFIX'])
        # Test-only exact historical prefix copy; replacement preserves NTFS file identity.
        (self.root / 'fresh-spend.jsonl').write_bytes(self.wire)
        self.prior['state']['files']['fresh-spend.jsonl'].update(
            sha256=MODULE['digest'](self.wire), bytes=len(self.wire))
        self.prior = self.call('read', self.prior)

    def tearDown(self):
        GLOBAL['FRESH_ROOT'] = str(LIVE)
        for name, value in LIVE_ORIGINAL.items():
            self.assertEqual((LIVE / name).read_bytes(), value, 'live evidence changed')

    call = FreshJournal.call

    def test_case14_fixed_partition_and_known_vs_conservative_accounting(self):
        event = reserve('14')
        active = self.call('reserve', self.prior, event)
        reserved = active['snapshot']
        self.assertEqual(reserved['eventCount'], 25)
        self.assertEqual(reserved['knownSettledCostMicros'], 13_631_058)
        self.assertEqual(reserved['conservativeApprovalCostMicros'], 0)
        self.assertEqual(reserved['committedCostMicros'], 28_631_058)
        self.assertEqual(reserved['remainingReservationMicros'], 1_368_942)
        row = json.loads((self.root / 'fresh-spend.jsonl').read_bytes().splitlines()[-1])
        self.assertEqual({k: row[k] for k in ('ceilingMicros', 'approvalCeilingMicros', 'recallCeilingMicros')},
                         {'ceilingMicros': 15_000_000, 'approvalCeilingMicros': 1_000_000,
                          'recallCeilingMicros': 14_000_000})
        self.assertEqual(row['approvalBoundSha256'], event['approvalBoundSha256'])
        actual_recall = 500_000
        done = self.call('settle', active, settle(event, actual_recall))
        snap = done['snapshot']
        self.assertEqual(snap['knownSettledCostMicros'], 13_631_058 + actual_recall)
        self.assertEqual(snap['conservativeApprovalCostMicros'], 1_000_000)
        self.assertEqual(snap['committedCostMicros'], 13_631_058 + actual_recall + 1_000_000)
        self.assertEqual(snap['remainingReservationMicros'], 30_000_000 - snap['committedCostMicros'])
        run = snap['runs']['14:'+event['captureRunId']]
        self.assertEqual(run['chargedCostMicros'], actual_recall)
        self.assertEqual(run['conservativeApprovalCostMicros'], 1_000_000)
        self.assertEqual(run['approvalOutcomeSha256'], 'd'*64)
        self.assertEqual(run['projectionTerminalSha256'], 'e'*64)
        self.assertTrue(snap['runs']['01:'+json.loads(self.wire.splitlines()[0])['captureRunId']]['historical'])
        with self.assertRaises(ValueError):
            self.call('reserve', done, reserve('14'))

    def test_case14_bad_partition_bound_and_malformed_settlement_reject_without_append(self):
        for changes in [{'ceilingMicros': 14_999_999}, {'ceilingMicros': True},
                        {'approvalCeilingMicros': 999_999}, {'recallCeilingMicros': 13_999_999},
                        {'approvalBoundSha256': 'C'*64}, {'approvalBoundSha256': 'bad'},
                        {'approvalBoundSha256': None}, {'unexpected': 1}]:
            event = reserve('14')
            event.update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.call('reserve', self.prior, event)
        self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), self.wire)
        event = reserve('14')
        active = self.call('reserve', self.prior, event)
        before = (self.root / 'fresh-spend.jsonl').read_bytes()
        good = settle(event, 100)
        changesets = [
            {'chargedCostMicros': 14_000_001}, {'chargedCostMicros': True},
            {'ledgerSha256': ''}, {'envelopeSha256': 'x'},
            {'conservativeApprovalCostMicros': 999_999}, {'conservativeApprovalCostMicros': True},
            {'approvalBoundSha256': 'f'*64}, {'approvalOutcomeSha256': 'bad'},
            {'projectionTerminalSha256': None}, {'captureAuthority': False}, {'extra': 1},
        ]
        for change in changesets:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.call('settle', active, {**good, **change})
        self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), before)
        read = self.call('read', active)
        self.assertEqual(read['snapshot']['activeRun'], '14:'+event['captureRunId'])
        self.assertEqual(read['snapshot']['committedCostMicros'], 28_631_058)

    def test_settlement_missing_any_proof_fails_and_never_releases_hold(self):
        event = reserve('14')
        active = self.call('reserve', self.prior, event)
        before = (self.root / 'fresh-spend.jsonl').read_bytes()
        good = settle(event, 14_000_000)
        for field in ('ledgerSha256', 'envelopeSha256', 'approvalBoundSha256',
                      'approvalOutcomeSha256', 'projectionTerminalSha256',
                      'conservativeApprovalCostMicros'):
            broken = dict(good)
            del broken[field]
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.call('settle', active, broken)
        self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), before)
        snap = self.call('read', active)['snapshot']
        self.assertEqual(snap['activeRun'], '14:'+event['captureRunId'])
        self.assertEqual(snap['committedCostMicros'], 28_631_058)
        self.assertEqual(snap['conservativeApprovalCostMicros'], 0)

    def test_premature_mutated_prefix_duplicate_and_second_case14_rejected(self):
        event = reserve('14')
        for count in (20, 21, 22, 23):
            row = {k: event[k] for k in ('caseId', 'captureRunId', 'reservationId', 'ceilingMicros',
                                         'approvalCeilingMicros', 'recallCeilingMicros', 'approvalBoundSha256')}
            row.update(nativeCaptureVersion=1, sequence=count+1, atMs=1, event='reserved')
            with self.subTest(count=count), self.assertRaises(ValueError):
                MODULE['reduce_fresh'](b''.join(self.wire.splitlines(keepends=True)[:count]) + MODULE['data'](row) + b'\n')
        rows = self.wire.splitlines(keepends=True)
        altered = json.loads(rows[23]); altered['atMs'] += 1
        changed = b''.join(rows[:23]) + MODULE['data'](altered) + b'\n'
        with self.assertRaises(ValueError):
            MODULE['reduce_fresh'](changed + MODULE['data']({**json.loads(MODULE['data'](row)), 'sequence': 25}) + b'\n')
        active = self.call('reserve', self.prior, event)
        done = self.call('settle', active, settle(event, 0))
        with self.assertRaises(ValueError):
            self.call('reserve', done, reserve('14'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
