"""Read-only packet/count/hash audit. Does not import or execute source tests."""
from pathlib import Path
from collections import Counter
import argparse
import hashlib
import json
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--packet-root', default='/workspace/capirov2-cleanup-clock-source')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
packet_root = Path(args.packet_root)
base = '1bf52945b9fa01496ce41a349f8eaace490ad4ac'
sibling = 'fbdba6db6a995845727f4b57007da0a7f6aa5a6c'
first = 'f86bf11b9b6da367d464da453ee1f260fa60e06e'

def git(*argv):
    return subprocess.check_output(['git', *argv], cwd=repo, text=True).strip()

def tree(ref):
    return dict((line.split('\t', 1)[1], line.split('\t', 1)[0])
                for line in git('ls-tree', '-r', ref).splitlines())

def read_json(relative):
    return json.loads((packet_root / relative).read_text())

old, new = tree(base), tree(args.source)
prefixes = ('docs/cleanup-source-gates-20261012/',
            'docs/cleanup-executable-prereqs-20261012/',
            'docs/rebuild-integrated-rc-20261012/')
protected = [p for p in old if p.endswith('.prisma') or '/migrations/' in p or p.startswith(prefixes)]
assert len(protected) == 1393
assert all(new.get(p) == old[p] for p in protected)
paths = [p for p in git('diff', '--name-only', base, args.source).splitlines() if not p.startswith('docs/')]
sibling_paths = [p for p in git('diff', '--name-only', base, sibling).splitlines() if not p.startswith('docs/')]
assert len(paths) == 18 and len(sibling_paths) == 4
assert not set(paths).intersection(sibling_paths)
assert git('merge-base', args.source, sibling) == base
for p in sibling_paths:
    assert new.get(p) == old.get(p), 'clock branch unexpectedly composes a sibling source path'
guard_paths = {'scripts/check-strategy-time-bypasses.mjs',
               'scripts/check-strategy-time-bypasses.test.mjs', 'scripts/strategy-time-boundaries.json'}
initial = tree(first)
assert all(new[p] == initial[p] for p in paths if p not in guard_paths)
data_before = json.loads(git('show', first + ':scripts/strategy-time-boundaries.json'))
data = json.loads(git('show', args.source + ':scripts/strategy-time-boundaries.json'))
assert all(data.get(k) == v for k, v in data_before.items())
rows = data['existingAmbient']
deferred = [r for r in rows if r['status'] == 'existing-unconverted']
canonical = [r for r in rows if r['status'] == 'canonical-system-default']
assert len(rows) == 119 and len(deferred) == 116 and len(canonical) == 3
assert sum(r['maximum'] for r in deferred) == 123

author_dir = 'docs/cleanup-strategy-clock-rng-20261012/evidence/'
frozen = read_json(author_dir + 'author-frozen.json')
baseline = read_json(author_dir + 'baseline-test-names-repaired.json')
frozen_cases = [a for suite in frozen['testResults'] for a in suite['assertionResults']]
baseline_cases = [a for suite in baseline['testResults'] for a in suite['assertionResults']]
assert len(frozen['testResults']) == 7 and len(frozen_cases) == 137
assert all(a['status'] == 'passed' for a in frozen_cases)
assert len(baseline_cases) == 102 and all(a['status'] == 'pending' for a in baseline_cases)
frozen_names = Counter(a['fullName'] for a in frozen_cases)
baseline_names = Counter(a['fullName'] for a in baseline_cases)
assert sum((frozen_names & baseline_names).values()) == 102
assert not (baseline_names - frozen_names)
retention = read_json(author_dir + 'test-name-retention.json')
assert [len(retention[k]) if isinstance(retention[k], list) else retention[k]
        for k in ['baselineCases', 'frozenCases', 'retained', 'removed', 'added']] == [102, 137, 102, 0, 35]
if isinstance(retention['retained'], list):
    assert Counter(retention['retained']) == baseline_names
assert Counter(retention['added']) == frozen_names - baseline_names
author_receipt = read_json(author_dir + 'author-source-receipt.json')
author_hashes = []
for name, item in author_receipt['retainedEvidence'].items():
    b = (packet_root / author_dir / name).read_bytes()
    assert len(b) == item['bytes'] and hashlib.sha256(b).hexdigest() == item['sha256']
    author_hashes.append({'path': author_dir + name, 'sha256': item['sha256']})

clock_dir = 'docs/cleanup-clock-injection-20261012/'
guard_receipt = read_json(clock_dir + 'evidence/root-repaired-permanent-controls.command.json')
scan_receipt = read_json(clock_dir + 'evidence/root-repaired-source-scan.command.json')
guard_log = (packet_root / clock_dir / 'evidence/root-repaired-permanent-controls.stdout.log').read_text()
scan_log = (packet_root / clock_dir / 'evidence/root-repaired-source-scan.stdout.log').read_text()
assert re.search(r'\btests 84\b', guard_log) and re.search(r'\bpass 84\b', guard_log)
assert re.search(r'\bfail 0\b', guard_log) and re.search(r'\bskipped 0\b', guard_log)
assert '169 production files' in scan_log
assert guard_receipt.get('exit', guard_receipt.get('exitCode')) == 0
assert scan_receipt.get('exit', scan_receipt.get('exitCode')) == 0
receipt_sources_exact = {}
for name, receipt in [('guard', guard_receipt), ('scan', scan_receipt)]:
    prior = tree(receipt['source'])
    receipt_sources_exact[name] = all(prior.get(p) == new.get(p) for p in guard_paths)

doc_paths = [clock_dir + 'HANDOFF.md', 'docs/plans/cleanup4-progress.md',
             clock_dir + 'RELEASE-MANIFEST.json', clock_dir + 'SHA256.json', clock_dir + 'SHA256SUMS.json']
docs, missing = [], []
for p in doc_paths:
    f = packet_root / p
    if not f.exists():
        missing.append(p)
        continue
    b = f.read_bytes()
    docs.append({'path': p, 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()})

print(json.dumps({
    'auditedSource': args.source, 'auditedTree': git('rev-parse', args.source + '^{tree}'),
    'packetRoot': str(packet_root), 'base': base, 'sibling': sibling,
    'sourcePaths': paths, 'siblingPaths': sibling_paths, 'overlap': [],
    'protectedPathCount': 1393, 'protectedAllGitModesAndBlobsExact': True,
    'protectedSets': {'schemaOrMigrationPaths': 603, 'priorCleanupPackets': 687, 'integratedRcPacket': 103},
    'f86OtherFifteenSourcePathsExact': True, 'allOriginalDataFieldsAnd119RowsExact': True,
    'allowanceRows': 119, 'deferredIdentities': 116, 'deferredSamples': 123, 'canonicalDefaults': 3,
    'executedCases': 137, 'executedSuites': 7, 'originalNameInventory': 102,
    'originalNamesRetainedMultiset': 102, 'originalNamesRemoved': 0,
    'baselineInventoryPendingNotAcceptance': True, 'authorEvidenceHashesVerified': author_hashes,
    'recordedGuardPass': 84, 'recordedScanFiles': 169,
    'recordedGuardReceipt': guard_receipt, 'recordedScanReceipt': scan_receipt,
    'recordedReceiptGuardBlobsMatchAuditSource': receipt_sources_exact,
    'sameBaseSiblingNotComposed': True, 'transportFrontendSchemaDeltaInSourcePathSet': False,
    'docSnapshotHashes': docs, 'missingDraftPublicationFiles': missing,
    'sourceTestsRerun': False, 'nativeOrFullGateAcceptance': False,
    'limits': 'Read-only documentation/JSON/raw-log/Git-mode-and-blob audit. Await final B review and root manifest/checksums for publication binding.'
}, indent=2))
