#!/usr/bin/env python3
"""Exact-digest ECR scan gate for the dedicated Clio sandbox image.

The ECR repository tag is MUTABLE, so the tag is never the thing that is
scanned or reported: it is resolved to a digest once by the caller, and this
gate then

  1. proves the expected source tag still resolves to that exact digest,
  2. scans *by digest* and requires the response to echo that exact digest,
  3. requires the scan to reach COMPLETE with 0 CRITICAL and 0 HIGH findings.

An incomplete scan, a moved tag, a digest mismatch or any unexpected AWS shape
is a gate failure (non-zero). Nothing here resends a build or mutates ECR.

usage: clio-image-scan-gate.py <expected_sha> <image_digest>
env:
  CLIO_AWS_BIN        aws command, may include arguments (default: aws)
  CLIO_SCAN_ATTEMPTS  bounded poll attempts (default 30)
  CLIO_SCAN_INTERVAL  seconds between attempts (default 10)
exit: 0 scan clean for the exact digest; 2 gate failure; 1 usage/tooling error

test: clio-image-scan-gate.py --self-test
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time

REPOSITORY = 'capiro/dev/clio-sandbox'
REGION = 'us-east-1'
SHA = re.compile(r'^[0-9a-f]{40}$')
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')


class GateFailure(Exception):
    pass


def aws_command():
    # Read per call so the command is not frozen at import time.
    return shlex.split(os.environ.get('CLIO_AWS_BIN', 'aws'), posix=os.name != 'nt')


def call(*args):
    completed = subprocess.run(
        aws_command() + list(args) + ['--region', REGION, '--output', 'json'],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise GateFailure(str(completed.stderr or 'aws call failed').strip()[:400])
    return json.loads(completed.stdout or '{}')


def verify_tag_binding(sha, digest):
    """The mutable tag must still resolve to the captured candidate digest."""
    described = call('ecr', 'describe-images', '--repository-name', REPOSITORY,
                     '--image-ids', 'imageTag=' + sha)
    details = described.get('imageDetails') or []
    if len(details) != 1:
        raise GateFailure('TAG_MOVED: expected exactly one image for tag %s, found %d' % (sha, len(details)))
    tagged = details[0].get('imageDigest')
    if tagged != digest:
        raise GateFailure('TAG_MOVED: tag %s resolves to %s, candidate digest is %s' % (sha, tagged, digest))
    if sha not in (details[0].get('imageTags') or []):
        raise GateFailure('TAG_MOVED: digest %s no longer carries tag %s' % (digest, sha))
    return tagged


def scan_once(digest):
    """Scan the exact digest (never the tag) and verify the echoed identity."""
    scanned = call('ecr', 'describe-image-scan-findings', '--repository-name', REPOSITORY,
                   '--image-id', 'imageDigest=' + digest)
    echo = (scanned.get('imageId') or {}).get('imageDigest')
    if echo != digest:
        raise GateFailure('DIGEST_MISMATCH: scan response is for %s, candidate digest is %s' % (echo, digest))
    status = (scanned.get('imageScanStatus') or {}).get('status')
    counts = (scanned.get('imageScanFindings') or {}).get('findingSeverityCounts') or {}
    return status, counts


def gate(sha, digest, attempts=None, interval=None):
    """Resolve, scan and decide. Returns (ok, message)."""
    if attempts is None:
        attempts = int(os.environ.get('CLIO_SCAN_ATTEMPTS', '30'))
    if interval is None:
        interval = float(os.environ.get('CLIO_SCAN_INTERVAL', '10'))
    if not SHA.match(sha or ''):
        raise GateFailure('expected SHA must be 40 lowercase hex characters')
    if not DIGEST.match(digest or ''):
        raise GateFailure('candidate digest must be sha256: + 64 lowercase hex characters')
    verify_tag_binding(sha, digest)
    counts = {}
    status = 'UNKNOWN'
    for attempt in range(1, attempts + 1):
        status, counts = scan_once(digest)
        if status == 'COMPLETE':
            critical = int(counts.get('CRITICAL', 0))
            high = int(counts.get('HIGH', 0))
            if critical or high:
                return False, 'scan for %s has %d CRITICAL and %d HIGH finding(s)' % (digest, critical, high)
            return True, 'IMAGE_SCAN_PASS digest=%s severity=%s' % (digest, json.dumps(counts, sort_keys=True))
        if attempt < attempts:
            time.sleep(interval)
    return False, 'scan for %s did not reach COMPLETE (last status %s)' % (digest, status)


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[0])
        print('usage: clio-image-scan-gate.py <expected_sha> <image_digest>', file=sys.stderr)
        return 1
    try:
        ok, message = gate(argv[1], argv[2])
    except GateFailure as failure:
        print('FAIL: %s' % failure, file=sys.stderr)
        return 2
    print(message)
    return 0 if ok else 2


STUB = r'''
import json, os, sys
args = sys.argv[1:]
fixture = json.load(open(os.path.join(os.environ['CLIO_STUB_DIR'], 'scenario.json')))
calls = os.path.join(os.environ['CLIO_STUB_DIR'], 'calls.log')
open(calls, 'a', encoding='utf-8').write(' '.join(args) + '\n')
if 'describe-image-scan-findings' in args:
    sequence = fixture['scan_sequence']
    step = sequence[fixture['scan_called']] if fixture['scan_called'] < len(sequence) else sequence[-1]
    fixture['scan_called'] += 1
    json.dump(fixture, open(os.path.join(os.environ['CLIO_STUB_DIR'], 'scenario.json'), 'w'))
    print(json.dumps({
        'imageId': {'imageDigest': step.get('digest', fixture['digest'])},
        'imageScanStatus': {'status': step['status']},
        'imageScanFindings': {'findingSeverityCounts': step.get('counts', {})},
    }))
    sys.exit(0)
if 'describe-images' in args and any(a.startswith('imageTag=') for a in args):
    tag_digest = fixture.get('tag_digest', fixture['digest'])
    count = fixture.get('tag_count', 1)
    print(json.dumps({'imageDetails': [{'imageDigest': tag_digest, 'imageTags': [fixture['sha']]} for _ in range(count)]}))
    sys.exit(0)
print(json.dumps({}))
'''


def self_test():
    import tempfile
    import unittest

    class ScanGateTests(unittest.TestCase):
        sha = 'a' * 40
        digest = 'sha256:' + 'b' * 64

        def run_gate(self, **scenario):
            directory = tempfile.mkdtemp(prefix='clio-scan-')
            base = {'sha': self.sha, 'digest': self.digest, 'scan_called': 0,
                    'scan_sequence': [{'status': 'COMPLETE', 'counts': {}}]}
            base.update(scenario)
            with open(os.path.join(directory, 'scenario.json'), 'w', encoding='utf-8') as handle:
                json.dump(base, handle)
            stub = os.path.join(directory, 'aws_stub.py')
            with open(stub, 'w', encoding='utf-8') as handle:
                handle.write(STUB)
            old = {key: os.environ.get(key) for key in ('CLIO_AWS_BIN', 'CLIO_STUB_DIR', 'CLIO_SCAN_ATTEMPTS', 'CLIO_SCAN_INTERVAL')}
            os.environ['CLIO_AWS_BIN'] = '%s %s' % (sys.executable, stub)
            os.environ['CLIO_STUB_DIR'] = directory
            os.environ['CLIO_SCAN_ATTEMPTS'] = str(scenario.get('attempts', 2))
            os.environ['CLIO_SCAN_INTERVAL'] = '0'
            try:
                exit_code = main(['gate', self.sha, self.digest])
            finally:
                for key, value in old.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
            with open(os.path.join(directory, 'calls.log'), encoding='utf-8') as handle:
                self.calls = handle.read().splitlines()
            return exit_code

        def test_clean_scan_passes_and_scans_the_digest(self):
            self.assertEqual(self.run_gate(), 0)
            scan_calls = [line for line in self.calls if 'describe-image-scan-findings' in line]
            self.assertEqual(len(scan_calls), 1)
            self.assertIn('imageDigest=' + self.digest, scan_calls[0])
            self.assertNotIn('imageTag=', scan_calls[0])

        def test_high_finding_fails(self):
            self.assertEqual(self.run_gate(scan_sequence=[{'status': 'COMPLETE', 'counts': {'HIGH': 1}}]), 2)

        def test_critical_finding_fails(self):
            self.assertEqual(self.run_gate(scan_sequence=[{'status': 'COMPLETE', 'counts': {'CRITICAL': 1}}]), 2)

        def test_incomplete_scan_is_not_a_pass(self):
            self.assertEqual(self.run_gate(scan_sequence=[{'status': 'IN_PROGRESS', 'counts': {}}], attempts=2), 2)

        def test_moved_tag_fails(self):
            self.assertEqual(self.run_gate(tag_digest='sha256:' + 'c' * 64), 2)

        def test_ambiguous_tag_fails(self):
            self.assertEqual(self.run_gate(tag_count=2), 2)

        def test_scan_digest_mismatch_fails(self):
            self.assertEqual(self.run_gate(scan_sequence=[{'status': 'COMPLETE', 'digest': 'sha256:' + 'd' * 64, 'counts': {}}]), 2)

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ScanGateTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        sys.exit(self_test())
    sys.exit(main(sys.argv))
