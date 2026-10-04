"""Native NTFS tests over disposable copies. No live journal mutation or cloud calls."""
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

HERE = pathlib.Path(__file__).resolve().parents[1]
EVIDENCE = pathlib.Path(__file__).resolve().parents[5] / 'evidence'
HELPER = HERE / 'lib' / 'windows-capture-spend.py'
MODULE = runpy.run_path(str(HELPER))
EXECUTE = MODULE['execute']
GLOBAL = EXECUTE.__globals__
LIVE = pathlib.Path(GLOBAL['FRESH_ROOT'])
PARENT = pathlib.Path('C:/dev/main/outputs/meri-c2-20261003/fresh-journal-adapter-v1/local-tests')
PARENT.mkdir(parents=True, exist_ok=True)
ORIGINAL = {name: (EVIDENCE / name).read_bytes() for name in ('run-authorization.json', 'fresh-spend.jsonl')}
PREFIX_SHA = '8f20134f71dde90e32fc0c3c2aba2da2d5b93dd13fffea31b83105d1621bc3e5'


def reserve(case='14', amount=15_000_000):
    return {'kind': 'reserve', 'caseId': case, 'captureRunId': str(uuid.uuid4()),
            'reservationId': str(uuid.uuid4()), 'ceilingMicros': amount}


def settle(event, amount=100):
    return {**{k: event[k] for k in ('caseId', 'captureRunId', 'reservationId')},
            'kind': 'settle', 'chargedCostMicros': amount,
            'ledgerSha256': 'a'*64, 'envelopeSha256': 'b'*64}


class FreshJournal(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='case14-native-', dir=PARENT))
        for name, value in ORIGINAL.items():
            (self.root / name).write_bytes(value)
        GLOBAL['FRESH_ROOT'] = str(self.root)
        self.first = self.call('adopt')

    def tearDown(self):
        GLOBAL['FRESH_ROOT'] = str(LIVE)

    def call(self, op, prior=None, event=None, **extra):
        return EXECUTE({'op': 'fresh_'+op, 'root': str(self.root),
                        **({'state': prior['state']} if prior else {}),
                        **({'event': event} if event else {}), **extra})

    def test_exact_24_event_adoption_is_read_only_and_prefix_pinned(self):
        self.assertEqual(self.first['snapshot']['eventCount'], 24)
        self.assertIsNone(self.first['snapshot']['activeRun'])
        self.assertEqual(len((self.root / 'fresh-spend.jsonl').read_bytes().splitlines()), 24)
        self.assertEqual(set(os.listdir(self.root)), set(ORIGINAL))
        self.assertEqual(__import__('hashlib').sha256(ORIGINAL['fresh-spend.jsonl']).hexdigest(), PREFIX_SHA)

    def test_case14_reserves_after24_with_exact_prefix_and_preserves_history(self):
        event = reserve()
        result = self.call('reserve', self.first, event)
        wire = (self.root / 'fresh-spend.jsonl').read_bytes()
        self.assertTrue(wire.startswith(ORIGINAL['fresh-spend.jsonl']))
        self.assertEqual(len(wire.splitlines()), 25)
        self.assertEqual(result['snapshot']['activeRun'], '14:'+event['captureRunId'])
        self.assertEqual(result['snapshot']['runs']['14:'+event['captureRunId']]['ceilingMicros'], 15_000_000)

    def test_case14_settlement_requires_exact_active_reservation_and_cap(self):
        event = reserve()
        active = self.call('reserve', self.first, event)
        before = (self.root / 'fresh-spend.jsonl').read_bytes()
        for bad in [settle(event, -1), settle(event, 15_000_001),
                    {**settle(event), 'caseId': '01'},
                    {**settle(event), 'reservationId': str(uuid.uuid4())},
                    {**settle(event), 'captureRunId': str(uuid.uuid4())}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.call('settle', active, bad)
        self.assertEqual((self.root / 'fresh-spend.jsonl').read_bytes(), before)

    def test_before24_edited_prefix_and_retroactive_case14_are_rejected(self):
        wire = ORIGINAL['fresh-spend.jsonl']
        with self.assertRaises(ValueError):
            MODULE['reduce_fresh'](b''.join(wire.splitlines(keepends=True)[:20]))
        edited = bytearray(wire); edited[100] ^= 1
        with self.assertRaises(ValueError):
            MODULE['reduce_fresh'](bytes(edited))
        # Insert a syntactically valid Case14 reservation before the exact original24 rows.
        early = reserve()
        row = {'nativeCaptureVersion': 1, 'sequence': 21, 'atMs': 1791082000000,
               'event': 'reserved', **{k: early[k] for k in ('caseId', 'captureRunId', 'reservationId')},
               'ceilingMicros': early['ceilingMicros']}
        with self.assertRaises(ValueError):
            MODULE['reduce_fresh'](wire + MODULE['data'](row) + b'\n')

    def test_unsupported_cases_caps_replay_and_stale_checkpoint_reject(self):
        for case in ('02', '46', '72', '26', '27'):
            with self.subTest(case=case), self.assertRaises(ValueError):
                self.call('reserve', self.first, reserve(case))
        for change in [{'ceilingMicros': 15_000_001}, {'ceilingMicros': 0},
                       {'ceilingMicros': True}, {'captureRunId': 'wrong'},
                       {'reservationId': 'wrong'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.call('reserve', self.first, {**reserve(), **change})
        event = reserve(); active = self.call('reserve', self.first, event)
        with self.assertRaises(ValueError):
            self.call('reserve', self.first, reserve())
        with self.assertRaises(ValueError):
            self.call('reserve', active, reserve('20'))
        with self.assertRaises(ValueError):
            self.call('reserve', active, {**reserve(), 'captureRunId': event['captureRunId']})
        with self.assertRaises(ValueError):
            self.call('reserve', active, {**reserve(), 'reservationId': event['reservationId']})

    def test_single_process_lock_blocks_concurrent_writer(self):
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
        self.assertEqual(self.call('read', self.first)['snapshot']['eventCount'], 24)

    def test_replacement_and_tampering_fence_checkpoint_identity_content_and_entries(self):
        journal = self.root / 'fresh-spend.jsonl'
        journal.write_bytes(ORIGINAL['fresh-spend.jsonl'] + b' ')
        with self.assertRaises(ValueError):
            self.call('read', self.first)
        journal.write_bytes(ORIGINAL['fresh-spend.jsonl'])
        journal.rename(self.root / 'old.jsonl'); journal.write_bytes(ORIGINAL['fresh-spend.jsonl'])
        with self.assertRaises(ValueError):
            self.call('read', self.first)
        with self.assertRaises(ValueError):
            self.call('adopt')


if __name__ == '__main__':
    unittest.main(verbosity=2)
