"""Actual NTFS tests over disposable copies. No live journal mutation or cloud calls."""
import copy
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import unittest
import uuid

HELPER = pathlib.Path(__file__).resolve().parents[1] / 'lib/windows-capture-spend.py'
MODULE = runpy.run_path(str(HELPER))
EXECUTE = MODULE['execute']
GLOBAL = EXECUTE.__globals__
LIVE = pathlib.Path(GLOBAL['FRESH_ROOT'])
PARENT = pathlib.Path('C:/dev/main/outputs/meri-c2-20261003/fresh-journal-adapter-v1/local-tests')
PARENT.mkdir(parents=True, exist_ok=True)
LIVE_ORIGINAL = {name: (LIVE / name).read_bytes() for name in ('run-authorization.json', 'fresh-spend.jsonl')}
ORIGINAL = {**LIVE_ORIGINAL, 'fresh-spend.jsonl': b''.join(LIVE_ORIGINAL['fresh-spend.jsonl'].splitlines(keepends=True)[:20])}
assert MODULE['digest'](ORIGINAL['fresh-spend.jsonl']) == MODULE['FRESH_PREFIX']


def reserve(case='01', amount=15_000_000):
    return {'kind': 'reserve', 'caseId': case, 'captureRunId': str(uuid.uuid4()),
            'reservationId': str(uuid.uuid4()), 'ceilingMicros': amount}


def settle(event, amount=100):
    return {**{k: event[k] for k in ('caseId', 'captureRunId', 'reservationId')},
            'kind': 'settle', 'chargedCostMicros': amount,
            'ledgerSha256': 'a'*64, 'envelopeSha256': 'b'*64}


class FreshJournal(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='native-', dir=PARENT))
        for name, value in ORIGINAL.items():
            (self.root / name).write_bytes(value)
        # Test-only in-memory rebinding; production has no root/config override.
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

    def test_adoption_is_read_only_and_keeps_all_costs(self):
        self.assertEqual(self.first['snapshot']['eventCount'], 20)
        self.assertEqual(self.first['snapshot']['knownSettledCostMicros'], 9_841_281)
        self.assertEqual(self.first['snapshot']['remainingReservationMicros'], 20_158_719)
        self.assertEqual(set(os.listdir(self.root)), set(ORIGINAL))
        for name, value in ORIGINAL.items():
            self.assertEqual((self.root / name).read_bytes(), value)

    def test_sequential_cases_settle_only_new_ceiling_and_keep_prefix(self):
        first = reserve()
        one = self.call('reserve', self.first, first)
        self.assertEqual(one['snapshot']['remainingReservationMicros'], 5_158_719)
        done = self.call('settle', one, settle(first, 1_500_000))
        two = self.call('reserve', done, reserve('20'))
        self.assertEqual(two['snapshot']['remainingReservationMicros'], 3_658_719)
        wire = (self.root / 'fresh-spend.jsonl').read_bytes()
        self.assertTrue(wire.startswith(ORIGINAL['fresh-spend.jsonl']))
        self.assertEqual(len(wire.splitlines()), 23)
        self.assertEqual((self.root / 'run-authorization.json').read_bytes(), ORIGINAL['run-authorization.json'])

    def test_active_full_ceiling_and_stale_checkpoint_block_other_owner(self):
        active = self.call('reserve', self.first, reserve())
        self.assertIsNotNone(active['snapshot']['activeRun'])
        for op, prior, event in [('read', self.first, None), ('reserve', self.first, reserve()),
                                 ('reserve', active, reserve('20')), ('adopt', None, None)]:
            with self.subTest(op=op), self.assertRaises(ValueError):
                self.call(op, prior, event)

    def test_bad_case_amount_ids_and_extra_event_fields_never_append(self):
        for change in [{'caseId': '14'}, {'caseId': '46'}, {'caseId': '02'},
                       {'ceilingMicros': 15_000_001}, {'ceilingMicros': 0},
                       {'ceilingMicros': True}, {'captureRunId': 'wrong'},
                       {'reservationId': 'wrong'}, {'settled': True}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.call('reserve', self.first, {**reserve(), **change})
        self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), ORIGINAL['fresh-spend.jsonl'])

    def test_total_and_replay_rejections(self):
        event = reserve()
        state = self.call('reserve', self.first, event)
        state = self.call('settle', state, settle(event, 15_000_000))
        self.assertEqual(state['snapshot']['remainingReservationMicros'], 5_158_719)
        for value in [event, reserve('20', 5_158_720),
                      {**reserve('20'), 'captureRunId': event['captureRunId']},
                      {**reserve(), 'reservationId': event['reservationId']}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.call('reserve', state, value)
        with self.assertRaises(ValueError):
            self.call('settle', state, settle(event))
        final = self.call('reserve', state, reserve('20', 5_158_719))
        self.assertEqual(final['snapshot']['remainingReservationMicros'], 0)

    def test_bad_settlement_never_releases_ceiling(self):
        event = reserve()
        state = self.call('reserve', self.first, event)
        before = (self.root / 'fresh-spend.jsonl').read_bytes()
        for change in [{'chargedCostMicros': -1}, {'chargedCostMicros': 15_000_001},
                       {'chargedCostMicros': True}, {'ledgerSha256': 'bad'},
                       {'envelopeSha256': 'bad'}, {'caseId': '20'},
                       {'reservationId': str(uuid.uuid4())}, {'captureRunId': str(uuid.uuid4())}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.call('settle', state, {**settle(event), **change})
        self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), before)

    def test_future_sequence_duplicate_or_uncertain_events_fail_even_with_latest_bytes(self):
        event = reserve()
        state = self.call('reserve', self.first, event)
        wire = (self.root / 'fresh-spend.jsonl').read_bytes()
        row = json.loads(wire.splitlines()[-1])
        variants = [{**row, 'sequence': 22}, {**row, 'event': 'uncertain'},
                    {**row, 'sequence': 21, 'caseId': '14'},
                    {**row, 'reservationId': json.loads(ORIGINAL['fresh-spend.jsonl'].splitlines()[0])['reservationId']}]
        for value in variants:
            forged = ORIGINAL['fresh-spend.jsonl'] + MODULE['data'](value) + b'\n'
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE['reduce_fresh'](forged)
        with self.assertRaises(ValueError):
            MODULE['reduce_fresh'](wire + MODULE['data']({**row, 'sequence': 22}) + b'\n')
        self.assertEqual(self.call('read', state)['snapshot']['activeRun'], '01:'+event['captureRunId'])

    def test_partial_append_failure_retains_prefix_and_blocks_reopening(self):
        native = GLOBAL['native']
        actual_write = native['Write']
        calls = 0
        def partial(handle, buffer, size, count, overlapped):
            nonlocal calls
            calls += 1
            if calls > 1:
                raise OSError('UNIT interrupted append')
            return actual_write(handle, buffer, size // 2, count, overlapped)
        native['Write'] = partial
        try:
            with self.assertRaises(OSError):
                self.call('reserve', self.first, reserve())
        finally:
            native['Write'] = actual_write
        wire = (self.root / 'fresh-spend.jsonl').read_bytes()
        self.assertTrue(wire.startswith(ORIGINAL['fresh-spend.jsonl']))
        self.assertGreater(len(wire), len(ORIGINAL['fresh-spend.jsonl']))
        for op, prior in [('read', self.first), ('adopt', None)]:
            with self.subTest(op=op), self.assertRaises(ValueError):
                self.call(op, prior)

    def test_refuses_missing_tampered_partial_duplicate_unknown_out_of_order(self):
        wire = ORIGINAL['fresh-spend.jsonl']
        cases = [wire[:-1], wire.replace(b'1490802', b'1490803', 1), wire + b'{',
                 wire + wire.splitlines(keepends=True)[0], wire + b'{"event":"uncertain"}\n',
                 b''.join(reversed(wire.splitlines(keepends=True)))]
        for value in cases:
            (self.root / 'fresh-spend.jsonl').write_bytes(value)
            with self.subTest(value=value[:10]), self.assertRaises((ValueError, KeyError)):
                self.call('adopt')
        (self.root / 'fresh-spend.jsonl').unlink()
        with self.assertRaises(OSError):
            self.call('adopt')

    def test_authorization_tamper_replacement_and_hardlink_rejected(self):
        (self.root / 'run-authorization.json').write_bytes(ORIGINAL['run-authorization.json'] + b' ')
        with self.assertRaises(ValueError):
            self.call('adopt')
        (self.root / 'run-authorization.json').write_bytes(ORIGINAL['run-authorization.json'])
        journal = self.root / 'fresh-spend.jsonl'
        journal.rename(self.root / 'prior.jsonl')
        journal.write_bytes(ORIGINAL['fresh-spend.jsonl'])
        with self.assertRaises(ValueError):
            self.call('read', self.first)
        os.link(journal, self.root / 'hardlink.jsonl')
        with self.assertRaises(ValueError):
            self.call('adopt')

    def test_fixed_root_and_foreign_checkpoint_rejected(self):
        with self.assertRaises(ValueError):
            EXECUTE({'op': 'fresh_adopt', 'root': str(LIVE)})
        altered = copy.deepcopy(self.first)
        altered['state']['directories']['C:'] = 'wrong'
        with self.assertRaises(ValueError):
            self.call('read', altered)

    def test_second_process_writer_is_excluded_by_native_journal_handle(self):
        program = '''import runpy,sys,contextlib
m=runpy.run_path(sys.argv[1]);n=m['native'];drive,parts=m['protocol']['components'](sys.argv[2],root=True)
with contextlib.ExitStack() as s:
 p=s.enter_context(n['open_volume'](drive))
 for part in parts:p=s.enter_context(n['open_child'](p,part,True))
 h=s.enter_context(n['open_child'](p,'fresh-spend.jsonl',False,write=True))
 print('LOCKED',flush=True);sys.stdin.readline()
'''
        child = subprocess.Popen([sys.executable, '-I', '-c', program, str(HELPER), str(self.root)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'LOCKED')
            with self.assertRaises(OSError):
                self.call('reserve', self.first, reserve())
        finally:
            child.communicate('\n', timeout=10)
        self.assertEqual(child.returncode, 0)
        self.assertEqual(self.call('read', self.first)['snapshot']['eventCount'], 20)


class ProspectiveCase14(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='case14-native-', dir=PARENT))
        for name, value in ORIGINAL.items():
            (self.root / name).write_bytes(value)
        GLOBAL['FRESH_ROOT'] = str(self.root)
        self.prior = self.call('adopt')
        self.wire = b''.join(LIVE_ORIGINAL['fresh-spend.jsonl'].splitlines(keepends=True)[:24])
        self.assertEqual(MODULE['digest'](self.wire), GLOBAL['FRESH_CASE14_PREFIX'])
        # Test-only exact historical append, retaining the native file identity.
        (self.root / 'fresh-spend.jsonl').write_bytes(self.wire)
        self.prior['state']['files']['fresh-spend.jsonl'].update(
            sha256=MODULE['digest'](self.wire), bytes=len(self.wire))
        self.prior = self.call('read', self.prior)

    def tearDown(self):
        GLOBAL['FRESH_ROOT'] = str(LIVE)
        for name, value in LIVE_ORIGINAL.items():
            self.assertEqual((LIVE / name).read_bytes(), value, 'live evidence changed')

    call = FreshJournal.call

    def test_one_new_case14_retains_exact_failed_costs_and_caps(self):
        self.assertEqual(self.prior['snapshot']['knownSettledCostMicros'], 13_631_058)
        event = reserve('14')
        active = self.call('reserve', self.prior, event)
        self.assertEqual(active['snapshot']['remainingReservationMicros'], 1_368_942)
        self.assertTrue((self.root / 'fresh-spend.jsonl').read_bytes().startswith(self.wire))
        for other in [reserve('14'), reserve('01'), reserve('20')]:
            with self.assertRaises(ValueError):
                self.call('reserve', active, other)
        with self.assertRaises(ValueError):
            self.call('reserve', self.prior, reserve('14'))
        done = self.call('settle', active, settle(event, 500_000))
        self.assertEqual(done['snapshot']['knownSettledCostMicros'], 14_131_058)
        self.assertEqual(done['snapshot']['remainingReservationMicros'], 15_868_942)
        with self.assertRaises(ValueError):
            self.call('reserve', done, reserve('14'))

    def test_bad_case14_caps_replays_and_settlement_leave_bytes_unchanged(self):
        for event in [reserve('14', 15_000_001), reserve('14', 0), reserve('14', True),
                      {**reserve('14'), 'captureRunId': json.loads(self.wire.splitlines()[0])['captureRunId']}]:
            with self.assertRaises(ValueError):
                self.call('reserve', self.prior, event)
        self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), self.wire)
        event = reserve('14');active = self.call('reserve', self.prior, event)
        before = (self.root / 'fresh-spend.jsonl').read_bytes()
        for change in [{'chargedCostMicros': 15_000_001}, {'ledgerSha256': 'forged'},
                       {'caseId': '20'}, {'reservationId': str(uuid.uuid4())}, {'captureAuthority': True}]:
            with self.assertRaises(ValueError):
                self.call('settle', active, {**settle(event), **change})
        self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), before)

    def test_case14_cannot_use_earlier_or_edited_prefix(self):
        event = reserve('14')
        for count in [20, 21, 22, 23]:
            row = {k: event[k] for k in ['caseId', 'captureRunId', 'reservationId', 'ceilingMicros']}
            row.update(nativeCaptureVersion=1, sequence=count+1, atMs=1, event='reserved')
            with self.assertRaises(ValueError):
                MODULE['reduce_fresh'](b''.join(self.wire.splitlines(keepends=True)[:count])+MODULE['data'](row)+b'\n')
        rows = self.wire.splitlines(keepends=True)
        last = json.loads(rows[-1]);last['atMs'] += 1
        changed = b''.join(rows[:-1])+MODULE['data'](last)+b'\n'
        # The old reducer's semantics still accept this field; the new exact
        # Case14 boundary must reject the mutation even if state hashes match.
        MODULE['reduce_fresh'](changed)
        row.update(sequence=25)
        with self.assertRaises(ValueError):
            MODULE['reduce_fresh'](changed+MODULE['data'](row)+b'\n')


if __name__ == '__main__':
    unittest.main(verbosity=2)
