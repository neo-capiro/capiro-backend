import copy
import hashlib
import json
import subprocess
from pathlib import Path

BASE = '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70'
SOURCE = 'fc7ef349e49a943b7020ab78ee9d2b8bdb02f9ed'
TREE = 'ef854c0670db309d396ca2f4e8131b35581c6d81'
FIRST_MERGE = 'cfc3b8517d1dea6138080e5ee31bcc2db96da70e'
HEADS = {
    '2413': 'cc489e7e33a4f451e12a94612fb01968d8e7a568',
    '2414': '5f49b1ae05782bbaedcabda51ae293e5c4b5c373',
    '2415': 'fa8bd32059c62f9b0dd5a5b10e935c2452a07f11',
}
OUT = Path('docs/cleanup-reviewed-controls-composition-independent-review-20261012/evidence')
def git(*args): return subprocess.check_output(['git', *args])
def read(ref, path): return git('show', ref + ':' + path)
def mapping(ref):
    result = {}
    for row in git('ls-tree', '-rz', ref).split(b'\0'):
        if row:
            metadata, path = row.split(b'\t', 1)
            result[path.decode()] = metadata.decode()
    return result
def changed(before, after):
    return sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
def parents(ref): return git('show', '-s', '--format=%P', ref).decode().split()
assert git('rev-parse', SOURCE + '^{tree}').decode().strip() == TREE
assert parents(SOURCE) == [FIRST_MERGE, HEADS['2415']]
assert parents(FIRST_MERGE) == [HEADS['2413'], HEADS['2414']]
for head in HEADS.values():
    assert subprocess.run(['git', 'merge-base', '--is-ancestor', head, SOURCE]).returncode == 0
for left, right in [('2413', '2414'), ('2413', '2415'), ('2414', '2415')]:
    assert git('merge-base', HEADS[left], HEADS[right]).decode().strip() == BASE
base, final = mapping(BASE), mapping(SOURCE)
published = {pr: mapping(head) for pr, head in HEADS.items()}
deltas = {pr: changed(base, files) for pr, files in published.items()}
source_deltas = {pr: [p for p in delta if not p.startswith('docs/')] for pr, delta in deltas.items()}
expected_registry = ['.github/workflows/ci-pr.yml', 'package.json', 'scripts/check-registry-ownership.mjs', 'scripts/check-registry-ownership.test.mjs', 'scripts/registry-ownership.json']
expected_mirrors = ['apps/defense-api/runtime-source/operators/phase6-stage-cycle.ts', 'apps/defense-api/runtime-source/operators/plan-defense-budget-promotion-v1.ts', 'apps/defense-api/runtime-source/operators/status-defense-budget-promotion-v1.ts']
assert source_deltas == {'2413': expected_registry, '2414': ['package.json'], '2415': expected_mirrors}
union = sorted(set().union(*map(set, source_deltas.values())))
assert len(union) == 8
assert [p for p in changed(base, final) if not p.startswith('docs/')] == union
assert set(source_deltas['2413']) & set(source_deltas['2414']) == {'package.json'}
assert not set(expected_mirrors) & (set(expected_registry) | {'package.json'})

packages = {ref: json.loads(read(ref, 'package.json')) for ref in [BASE, SOURCE, *HEADS.values()]}
alias = 'gate:cleanup4:registry-ownership'
phase = 'verify:engagement-phase-1'
registry_package = copy.deepcopy(packages[HEADS['2413']])
alias_value = registry_package['scripts'].pop(alias)
assert registry_package == packages[BASE]
assert alias_value == 'node scripts/check-registry-ownership.mjs && node --test scripts/check-registry-ownership.test.mjs'
phase_package = copy.deepcopy(packages[HEADS['2414']])
phase_value = phase_package['scripts'][phase]
old_phase = packages[BASE]['scripts'][phase]
assert phase_value == old_phase.replace('scripts/verify-engagement-phase1-runtime.ts &&', 'scripts/verify-engagement-phase1-runtime.ts --run &&')
assert phase_value.split(' && ')[0].split().count('--run') == 1
assert phase_value.split(' && ')[1:] == old_phase.split(' && ')[1:]
phase_package['scripts'][phase] = old_phase
assert phase_package == packages[BASE]
assert packages[HEADS['2415']] == packages[BASE]
expected = copy.deepcopy(packages[BASE])
expected['scripts'][alias] = alias_value
expected['scripts'][phase] = phase_value
assert packages[SOURCE] == expected
expected_bytes = read(HEADS['2413'], 'package.json').replace(old_phase.encode(), phase_value.encode())
assert read(SOURCE, 'package.json') == expected_bytes
assert final['package.json'].split()[0] == base['package.json'].split()[0] == '100644'

records = []
for path in union:
    owners = [pr for pr, paths in source_deltas.items() if path in paths]
    if path != 'package.json':
        assert len(owners) == 1
        assert final[path] == published[owners[0]][path]
    records.append({'path': path, 'publishedOwners': owners, 'baseEntry': base.get(path),
                    'composedEntry': final[path], 'sha256': hashlib.sha256(read(SOURCE, path)).hexdigest(),
                    'composition': 'two independently reviewed script entries; exact remaining package bytes' if path == 'package.json' else 'exact published mode/blob'})
protected = [p for p in base if p not in union]
assert all(base[p] == final.get(p) for p in protected)
schema = [p for p in base if p.endswith('.prisma') or '/migrations/' in p]
old_docs = [p for p in base if p.startswith('docs/')]
app_protected = [p for p in protected if p.startswith('apps/')]
assert all(base[p] == final.get(p) for p in schema + old_docs)
new_docs = {pr: [p for p in delta if p.startswith('docs/')] for pr, delta in deltas.items()}
all_docs = set().union(*map(set, new_docs.values()))
assert len(all_docs) == sum(map(len, new_docs.values()))
assert sorted(p for p in changed(base, final) if p.startswith('docs/')) == sorted(all_docs)
for pr, paths in new_docs.items():
    assert all(p not in base and published[pr][p] == final[p] for p in paths)
masters = {
    '2413': ('docs/cleanup-registry-ownership-control-20261012/SHA256SUMS.json', 249),
    '2414': ('docs/cleanup-phase1-caller-repair-20261012/SHA256SUMS.json', 27),
    '2415': ('docs/cleanup-operator-mirror-repair-20261012/SHA256SUMS.json', 31),
}
hash_receipts = []
for pr, (manifest, count) in masters.items():
    assert read(SOURCE, manifest) == read(HEADS[pr], manifest)
    hashes = json.loads(read(SOURCE, manifest))
    assert len(hashes) == count
    for path, digest in hashes.items():
        assert hashlib.sha256(read(SOURCE, path)).hexdigest() == digest
    hash_receipts.append({'pr': pr, 'manifest': manifest, 'manifestEntry': final[manifest], 'verifiedHashes': count, 'allExactPublishedHashes': True})
clock = 'scripts/strategy-time-boundaries.json'
assert base[clock] == final[clock]
guard_pin = '4104f49f6ebfdbf00ad1706079ba340bd9b566c8'
for path in expected_registry:
    if path != 'package.json': assert read(SOURCE, path) == read(guard_pin, path)
phase_carry_paths = ['apps/api/scripts/verify-engagement-phase1-runtime.ts', 'scripts/run-engagement-phase1-local.mjs', 'scripts/verify-engagement-phase1-local.mjs', 'scripts/lib/engagement-local-cli.mjs', 'scripts/verify-engagement-phase2-code.sh']
for path in phase_carry_paths: assert read(SOURCE, path) == read(HEADS['2414'], path)
phase_receipt = json.loads(read(SOURCE, 'docs/cleanup-phase1-caller-independent-review-20261012/ACCEPTANCE.json'))
assert phase_receipt['inertPreflightControlsPassing'] == 16
assert not phase_receipt['fullFourTestSuiteAccepted']
result = {
    'acceptedSource': SOURCE, 'acceptedTree': TREE, 'commonBase': BASE,
    'actualPublishedHeads': [{'pr': pr, 'head': head, 'tree': git('rev-parse', head + '^{tree}').decode().strip(), 'actualAncestor': True, 'newPublishedDocsPreserved': len(new_docs[pr])} for pr, head in HEADS.items()],
    'actualCompositionParents': parents(SOURCE), 'firstMerge': FIRST_MERGE, 'firstMergeParents': parents(FIRST_MERGE),
    'exactEightPathSourceUnion': records, 'onlySourceOverlap': 'package.json',
    'overlapOnlyTwoSeparateCommandEntries': {alias: alias_value, phase: phase_value},
    'allOtherPackageValuesAndRemainingPackageBytesExact': True,
    'baselinePathsOutsideEightPathUnionExact': len(protected),
    'applicationPathsOutsideThreeAcceptedMirrorsExact': len(app_protected),
    'allSchemaMigrationPathsExact': len(schema), 'allPriorDocumentationPathsExact': len(old_docs),
    'publishedNewDocumentationPathsExact': len(all_docs), 'masterHashReceipts': hash_receipts,
    'rootGuardAndCiAccepted4104BlobsExact': True,
    'phase1SixteenControlsCarriedByExactHelperNormalizerCallerAndCommandValue': True,
    'clock123DeferredDataBlobExactAndNoAdoption': True,
    'declaredProductionCandidateReconciled': False, 'sourceCNewsletterAdopted': False,
    'fullPhase1OrMemoryOrHistoricalManifestOrNativeAcceptance': False,
    'mainMergeDeploymentOrReportingBranchAccess': False,
}
(OUT / 'composition-preservation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
