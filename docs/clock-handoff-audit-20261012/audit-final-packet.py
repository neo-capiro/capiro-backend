"""Read-only final Git/manifest/receipt audit; does not run source tests."""
from functools import cache
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import sys

audit_dir = Path(__file__).resolve().parent
repo = audit_dir.parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--packet-root', default='/workspace/capirov2-cleanup-clock-source')
packet = Path(parser.parse_args().packet_root)
source = 'b3e02fb8f056ab3481b5153bf1a1b2fe3a7d4a7d'
source_tree = '62bbe8e9c2fae921ae1a59a7ca9e582c7dfb8dc0'
packet_head = 'c958b794357bedcbd8d0b71e0ecbd45e2de7b64b'
packet_tree = '8260646ccde2c5a12ec5ee161e52047d3c5ba67f'
guard = 'c00c86917af2da637c2183fd078f4390fe0ac361'
guard_tree = 'c7ccd8cb80528c3cedaeead92e5c3babcfbdf158'
review = '0e756bf87b860f981951cfc97dd6e77a7d882e13'
review_tree = '9eeb2e87b2e5f313e7331d04b8904ff0634d42b7'
author = 'd94eb7e33767a2c79fc6e4e7d87847e82164cecd'
clock = 'docs/cleanup-clock-injection-20261012/'
master_path = clock + 'SHA256SUMS'
master_hash = 'f2121b82b18084260b2afb6de5abaec00d82ce13c03f333934efc2aad54711ff'
old_master_hash = '49dd6e2d41b7785b96a9f17fd9f13dad6d553d38e7226ff749f44d5bb7a5d148'


def git(*args, raw=False):
    b = subprocess.check_output(['git', *args], cwd=repo)
    return b if raw else b.decode().strip()


def data(path):
    return json.loads((packet / path).read_text())


def sha(b):
    return hashlib.sha256(b).hexdigest()


@cache
def tree(ref):
    return {line.split('\t', 1)[1]: line.split('\t', 1)[0]
            for line in git('ls-tree', '-r', ref).splitlines()}


def checked_path(p):
    path = Path(p)
    assert not path.is_absolute() and '..' not in path.parts
    assert str(path) == p and not (packet / p).is_symlink()
    return packet / p


def index(bytes_value):
    lines = bytes_value.decode().splitlines()
    result = {}
    for line in lines:
        m = re.fullmatch(r'([a-f0-9]{64})  (.+)', line)
        assert m, 'malformed checksum row'
        h, p = m.groups()
        checked_path(p)
        assert p not in result, 'duplicate checksum path'
        result[p] = h
    return result


assert git('rev-parse', source + '^{tree}') == source_tree
assert git('rev-parse', packet_head + '^{tree}') == packet_tree
assert git('rev-parse', guard + '^{tree}') == guard_tree
assert git('rev-parse', review + '^{tree}') == review_tree
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=packet, text=True).strip() == packet_head
structural = json.loads(subprocess.check_output([
    sys.executable, str(audit_dir / 'audit-packet.py'), '--source', source,
    '--packet-root', str(packet)], cwd=repo, text=True))
# The old helper intentionally reads historical da72/aa1 receipts. They are not
# final source acceptance, and its draft filename probes are not final manifest checks.
historical = {k: structural.pop(k) for k in ['recordedGuardReceipt', 'recordedScanReceipt',
    'recordedReceiptGuardBlobsMatchAuditSource']}
for key in ['missingDraftPublicationFiles', 'docSnapshotHashes', 'limits']:
    structural.pop(key)
assert not any(historical['recordedReceiptGuardBlobsMatchAuditSource'].values())
new = tree(source)
paths = structural['sourcePaths']
assert all(tree(guard)[p] == new[p] == tree(packet_head)[p] for p in paths)
assert not [p for p in git('diff', '--name-only', source, packet_head).splitlines()
            if not p.startswith('docs/')]
base_tree = tree(structural['base'])
protected_sets = {
    'schemaOrMigrationPaths': [p for p in base_tree if p.endswith('.prisma') or '/migrations/' in p],
    'priorCleanupPackets': [p for p in base_tree if p.startswith((
        'docs/cleanup-source-gates-20261012/', 'docs/cleanup-executable-prereqs-20261012/'))],
    'integratedRcPacket': [p for p in base_tree if p.startswith('docs/rebuild-integrated-rc-20261012/')]
}
assert {k: len(v) for k, v in protected_sets.items()} == structural['protectedSets']
assert all(tree(packet_head).get(p) == base_tree[p] for values in protected_sets.values() for p in values)

source_manifest = data(clock + 'SOURCE-MANIFEST.json')
release = data(clock + 'RELEASE-MANIFEST.json')
assert source_manifest['source'] == release['source'] == source
assert source_manifest['tree'] == release['tree'] == source_tree
assert source_manifest['base'] == release['base'] == structural['base']
assert source_manifest['sourceScope'] == release['sourcePaths'] == 18
assert [r['path'] for r in source_manifest['paths']] == paths
for row in source_manifest['paths']:
    p = row['path']
    b = git('show', source + ':' + p, raw=True)
    assert new[p].split()[-1] == row['gitBlob']
    assert len(b) == row['bytes'] and sha(b) == row['sha256']
    assert checked_path(p).read_bytes() == b
assert release['guardSource'] == guard and release['guardSourceTree'] == guard_tree
assert release['guardAuthorEvidence'] == author and release['finalIndependentReview'] == review
assert release['checks'] == {
    'strategyTestsPassed': 137, 'strategyOriginalNamesRetained': 102, 'strategySuites': 7,
    'strictStrategyCompilerPassed': True, 'canonicalSharedBuildPassed': True,
    'permanentGuardControlsPassed': 84, 'sourceFilesScanned': 169,
    'independentWholeMapRefusals': 25, 'independentProviderRoleImportRefusals': 21,
    'independentProviderPositives': 2, 'strictImporterTypeDiagnostics': 0,
    'inertRuntimeControlsCarriedByExactEquality': 17,
    'realNestSourceConstructorControlsCarriedByExactEquality': 4}
assert release['originalAllowanceRowsUnchanged'] == 119 and release['deferredExistingSamples'] == 123
assert release['canonicalLazySystemSamples'] == 3 and release['protectedSchemasMigrationsPriorPacketPathsUnchanged'] == 1393
assert release['publicLawSibling']['head'] == structural['sibling']
assert release['publicLawSibling']['sourcePaths'] == 4
assert release['publicLawSibling']['sourceOverlap'] == []
assert release['publicLawSibling']['composedIntoThisBranch'] is False
for k in ['backendHttpDtoContractDelta', 'schemaMigrationDelta', 'nativeAcceptance',
          'fullCleanup1Acceptance', 'widerCleanup4Acceptance']:
    assert release[k] is False
assert release['migrationPolicyConflictsRetained'] == 2
assert release['standaloneLegacyPublicLawRefusalRetained'] is True
assert release['frontendSourceFrozen'] == '4a161488'

fresh = {}
for role, name in [('guard', 'root-canonical-provenance-controls'),
                   ('scan', 'root-canonical-provenance-scan')]:
    receipt = data(clock + 'evidence/' + name + '.command.json')
    stdout = (packet / clock / 'evidence' / (name + '.stdout.log')).read_text()
    stderr = (packet / clock / 'evidence' / (name + '.stderr.log')).read_bytes()
    assert receipt['source'] == source and receipt['tree'] == source_tree and receipt['exit'] == 0
    assert receipt['nativeAcceptance'] is False and stderr == b''
    if role == 'guard':
        for field, count in [('tests', 84), ('pass', 84), ('fail', 0), ('skipped', 0), ('cancelled', 0)]:
            assert re.search(r'\b' + field + ' ' + str(count) + r'\b', stdout)
    else:
        assert stdout == 'Strategy time ratchet passed (169 production files; explicit retry and ambient-read inventory).\n'
    fresh[role] = receipt

acceptance_path = release['finalIndependentReceipt']
acceptance_bytes = (packet / acceptance_path).read_bytes()
acceptance = json.loads(acceptance_bytes)
assert git('show', review + ':' + acceptance_path, raw=True) == acceptance_bytes
assert acceptance['acceptedSource'] == guard and acceptance['acceptedTree'] == guard_tree
assert acceptance['integrationExactPacketBlobs'] == source and acceptance['integrationTree'] == source_tree
assert acceptance['remainingConcreteBoundedSourceBlockers'] == []
assert acceptance['nativeAcceptance'] is False and acceptance['moduleGraphContainmentClaim'] is False
supplement_path = 'docs/strategy-time-guard-repair-20261012/INDEPENDENT-ACCEPTANCE.json'
supplement = data(supplement_path)
assert supplement['independentAcceptance'] == acceptance
assert supplement['independentEvidenceCommit'] == review and supplement['independentEvidenceTree'] == review_tree
assert supplement['independentReceiptSha256'] == sha(acceptance_bytes)
for ref, prefix in [(review, 'docs/clock-rng-final-independent-review-20261012/'),
                    (author, 'docs/strategy-time-guard-repair-20261012/')]:
    for p in git('diff-tree', '--no-commit-id', '--name-only', '-r', ref).splitlines():
        assert p.startswith(prefix)
        assert git('show', ref + ':' + p, raw=True) == (packet / p).read_bytes()
corpus = data('docs/clock-rng-final-independent-review-20261012/evidence/original-corpus-c00.json')
assert corpus['source'] == guard and corpus['sourceFiles'] == 169 and corpus['baseline'] == []
assert len(corpus['results']) == 25 and all(r['rejected'] and r['failures'] for r in corpus['results'])
roles = data('docs/clock-rng-final-independent-review-20261012/evidence/provider-role-review-c00.json')
negative_rows = roles['roleMutationResults']
assert len(negative_rows) == 21 and all(r['rejected'] for r in negative_rows)

master_bytes = (packet / master_path).read_bytes()
assert sha(master_bytes) == master_hash
master = index(master_bytes)
assert len(master) == 276 and master_path not in master
for p, h in master.items():
    assert sha(checked_path(p).read_bytes()) == h, p
    assert git('show', packet_head + ':' + p, raw=True) == checked_path(p).read_bytes(), p
packet_dirs = ['cleanup-clock-injection-20261012', 'cleanup-strategy-clock-rng-20261012',
    'clock-rng-final-independent-review-20261012', 'clock-rng-independent-review-20261012',
    'clock-rng-repaired-independent-review-20261012', 'strategy-time-guard-repair-20261012']
expected = {str(p.relative_to(packet)) for d in packet_dirs for p in (packet / 'docs' / d).rglob('*')
            if p.is_file() and p != packet / master_path}
expected.add('docs/plans/cleanup4-progress.md')
assert expected == set(master), {'missing': sorted(expected-set(master)), 'extra': sorted(set(master)-expected)}
old_path = clock + 'evidence/SHA256SUMS-before-author-acceptance'
old_bytes = (packet / old_path).read_bytes()
assert sha(old_bytes) == old_master_hash
old_index = index(old_bytes)
assert len(old_index) == 274 and not set(old_index)-set(master)
assert set(master)-set(old_index) == {old_path, supplement_path}
assert {p for p in old_index if master[p] != old_index[p]} == {
    clock + 'RELEASE-MANIFEST.json', 'docs/strategy-time-guard-repair-20261012/CONTRACT.md'}
nested_indexes = []
for d in packet_dirs:
    for p in (packet / 'docs' / d).glob('SHA256.json'):
        rows = json.loads(p.read_text())
        for name, h in rows.items():
            assert sha((p.parent / name).read_bytes()) == h, str(p) + ':' + name
        nested_indexes.append({'path': str(p.relative_to(packet)), 'entries': len(rows), 'allHashesExact': True})

handoff = (packet / clock / 'HANDOFF.md').read_text()
progress = (packet / 'docs/plans/cleanup4-progress.md').read_text()
for token in [source, source_tree, '102 original full names retained', '137/137',
              '169 production files', '84 permanent', '119 allowance rows', '123 existing',
              '1,393', 'same-base sibling', 'not all Wave1', 'unknown-function/interprocedural',
              'native DB/RLS/concurrency', 'remain unrun/open', '4a161488', 'EngagementService reporting']:
    assert token in handoff, token
for token in ['not Wave 1 acceptance', 'gate:cleanup1', 'Two policy refusals remain',
              'complete Cleanup/Wave gates', 'No routes, HTTP DTOs, persistence schema or migration delta']:
    assert token in progress, token
for relative in re.findall(r'`(\.\./[^`]+\.(?:json|md))`', progress):
    assert (packet / 'docs/plans' / relative).is_file()
shared_receipt = data(clock + 'evidence/shared-build-receipt.json')
assert shared_receipt['exitCode'] == 0 and shared_receipt['nativeAcceptance'] is False
assert shared_receipt['newTimeSourceSha256'] == sha(git('show', source + ':packages/shared/src/time.ts', raw=True))

print(json.dumps({
    'result': 'PASS: exact bounded documentation and receipt audit; no packet discrepancies found',
    'source': source, 'sourceTree': source_tree, 'packetHead': packet_head, 'packetTree': packet_tree,
    'guardSource': guard, 'guardTree': guard_tree, 'independentReview': review, 'independentReviewTree': review_tree,
    'authorFinalEvidence': author, 'masterEntries': 276, 'masterSha256': master_hash,
    'masterCompleteSixPacketDirectoriesAndProgress': True, 'sourceManifest18RowsVerifiedGitBlobBytesSha256': True,
    'sourceAndCurrentPacketAll18PathsExactAcceptedGuard': True,
    'masterGitBlobsAndWorkingBytesExact': True, 'nestedChecksumIndexes': nested_indexes,
    'old274MasterPreservedSha256': old_master_hash, 'old274EntriesRemoved': 0,
    'old274ChangedCurrentHashes': [clock + 'RELEASE-MANIFEST.json', 'docs/strategy-time-guard-repair-20261012/CONTRACT.md'],
    'old274ChangesAreDocumentedAcceptanceSupplementOnly': True,
    'freshRootSourceReceipts': fresh, 'historicalInterimReceipts': historical,
    'independentReceiptExactOriginalGitBytes': True, 'independentWholeMapNegativeRows': 25,
    'independentRoleImportNegativeRows': 21, 'authorSupplementReceiptHashAndEmbeddedAcceptanceExact': True,
    'structuralCountsAndRetainedEvidence': structural,
    'manualDocumentationReview': 'HANDOFF/progress correctly bind source and source-only receipts, explicit finite grammar, preserved failures, noncomposed sibling and deferred/native/wider gates.',
    'remainingPacketBlockers': [], 'sourceTestsRerun': False, 'runtimeSourceReviewPerformedByThisAudit': False,
    'nativeAcceptance': False, 'fullCleanup1Acceptance': False, 'widerCleanup4Acceptance': False,
    'unresolvedSourceAcceptanceBoundaries': ['two migration-policy conflicts',
        'standalone old public-law refusal until sibling composition', '123 deferred ambient samples',
        'configured clean Node22/pnpm9.12 toolchain', 'native DB/RLS/MVCC/concurrency/full CLI smoke',
        'authentic coverage and pinned visuals', 'full Cleanup1 and wider Cleanup4 gates']
}, indent=2))
