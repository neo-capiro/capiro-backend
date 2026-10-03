from pathlib import Path
import datetime, hashlib, json, os, subprocess

repo = Path('C:/dev/main/meri-c1-20261002')
out = Path('C:/dev/main/outputs/meri-c2-20261003/capture-receipt-clock-v1')
sources = [
    'apps/api/src/meri/meri-server-readonly-capture.ts',
    'apps/api/src/meri/meri-capture-clock-packets.spec.ts',
    'evals/meri/live-v1/tests/capture-clock-receipt-jsonb.postgres.test.mjs',
]
def sha(data): return hashlib.sha256(data).hexdigest()
def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
def save_json(name, value):
    write(out / name, (json.dumps(value, indent=2) + '\n').encode())
def evidence(name):
    data = (out / name).read_bytes()
    return {'path': name, 'bytes': len(data), 'sha256': sha(data)}
source_rows = []
for name in sources:
    data = (repo / name).read_bytes()
    write(out / 'source' / name, data)
    source_rows.append({'path': name, 'bytes': len(data), 'sha256': sha(data), 'mirror': 'source/' + name})
patch = subprocess.check_output(['git', 'diff', '--binary', '--', *sources], cwd=repo)
write(out / 'tracked-candidate.patch', patch)
check = subprocess.run(['git', 'diff', '--check'], cwd=repo, capture_output=True)
assert check.returncode == 0
write(out / 'diff-check.log', check.stdout + check.stderr)
log = (out / 'focused-jest.log').read_text(encoding='utf-8-sig')
assert 'Test Suites: 2 passed, 2 total' in log and 'Tests:       71 passed, 71 total' in log
source_hashes = {row['path']: row['sha256'] for row in source_rows}
save_json('focused-jest.receipt.json', {
    'command': 'pnpm --filter @capiro/api exec jest --runInBand src/meri/meri-capture-clock-packets.spec.ts src/meri/meri-server-readonly-capture.spec.ts src/meri/meri-capture-policy-readback.spec.ts',
    'exitCode': 0, 'passed': 71, 'failed': 0, 'suites': 2,
    'selectionNote': 'Third name has no matching spec; the two reported suites are the actual suites. Existing receipt/policy checks live in meri-server-readonly-capture.spec.ts.',
    'sourceHashes': source_hashes, 'log': evidence('focused-jest.log'),
})
save_json('local-api-build.receipt.json', {
    'command': 'pnpm --filter @capiro/api build', 'exitCode': 0,
    'sourceHashes': source_hashes, 'log': evidence('local-api-build.log'),
    'remoteBuild': False, 'deployment': False,
})
red = json.loads((out / 'capture-receipt-clock-red-v2.receipt.json').read_text())
green = json.loads((out / 'capture-receipt-clock-green-final.receipt.json').read_text())
test_path = sources[2]
assert red['sourceHashes'][test_path] == green['sourceHashes'][test_path] == source_hashes[test_path]
assert green['sourceHashes'][sources[0]] == source_hashes[sources[0]]
assert red['testExit'] == 1 and green['testExit'] == 0
assert red['clusterStoppedAfter'] and green['clusterStoppedAfter'] and green['listenersAfter'] == 0
old_source = subprocess.check_output(['git', 'show', '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642:' + sources[0]], cwd=repo)
head_source = subprocess.check_output(['git', 'show', 'f9d1939782dc95d648e2e1b4528752e0f716db64:' + sources[0]], cwd=repo)
assert old_source == head_source
for name in ['capture-receipt-clock-red-v2.log', 'capture-receipt-clock-green-final.log']:
    value = (out / name).read_text(encoding='utf-8-sig')
    assert 'tests 4' in value and 'skipped 0' in value
evidence_names = sorted(path.name for path in out.iterdir() if path.is_file() and (path.suffix in ['.json', '.log', '.ps1', '.py', '.patch'] or path.name.endswith(('.stdout', '.stderr'))))
save_json('checkpoint.json', {
    'schemaVersion': 1,
    'kind': 'C2 pending semantic-clock receipt serialization repair',
    'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'baseCommit': 'f9d1939782dc95d648e2e1b4528752e0f716db64',
    'servedApiSource': '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642',
    'servedAndBaseProductionFileEqualAfterGitNormalization': True,
    'sources': source_rows,
    'scope': 'One production finalizer; one existing unit spec; one actual generated Prisma/PostgreSQL regression. No persistence, signature, equality, current-authority or clock-join guards weakened.',
    'diagnosis': {
        'confirmedDefect': 'A null API packet join produced an own semanticClock.api value of undefined. canonicalJson signed that key, JSON text persistence omitted it, and exact readback equality failed. Merely loosening equality would still leave an invalid signature after JSON roundtrip.',
        'repair': 'Remove any orchestrator-supplied API proof from a copied clock object; add only the API owner proof when supplied. With no proof, omit api before signing and retain PENDING and original BLOCKED reasons.',
        'liveLimit': 'The exact stream error and served production code match the local reproducer. The reason the live strict clock join returned no proof is not established by this storage regression; no live receipt or provider outcome is reconstructed.',
    },
    'qualification': {
        'actualPrismaPostgresRed': {'receipt': 'capture-receipt-clock-red-v2.receipt.json', 'passed': 2, 'failed': 2, 'failure': 'meri_capture_receipt_readback_mismatch for both pending-join cases'},
        'actualPrismaPostgresGreen': {'receipt': 'capture-receipt-clock-green-final.receipt.json', 'passed': 4, 'failed': 0, 'skipped': 0},
        'sameRedGreenTestBytes': True,
        'focusedJest': {'receipt': 'focused-jest.receipt.json', 'passed': 71, 'failed': 0, 'suites': 2},
        'apiBuild': {'receipt': 'local-api-build.receipt.json', 'exitCode': 0},
        'diffCheckExitCode': 0,
        'coverage': ['pending and joined clock receipts in generic/client scopes', 'exact float 0.27222999999999997 survives', 'signed JSON roundtrip and exact policy/receipt equality', 'unrelated metadata preserved', 'BLOCKED and PENDING remain explicit', 'tampered signature/readback denied', 'current membership revocation denied', 'every existing invalid packet join remains serializable and blocked', 'predeclared orchestrator API proof cannot survive absent API-owner proof'],
        'preservedEarlierEvidence': 'red-v1 retained: two target failures plus two test-fixture omissions of the required user row; fixed test fixture before final same-byte red/green. green-v1 retained before production-only formatting; final formatted source tested again.',
    },
    'limits': ['Local synthetic receipt observations, not original corpus qualification or production RLS', 'No new remote image, deployment, capture, auth session, provider call, AWS call, live journal or claim mutation', 'Does not repair or replay the failed live turn or settle its retained aggregate reservation', 'Original acceptance and human rubric review unchanged'],
    'ownedPostgres': {'address': '127.0.0.1', 'port': 55433, 'dataPreserved': True, 'allTestSchemasRolledBack': True, 'stopped': True, 'listenersAfter': 0},
    'evidence': [evidence(name) for name in evidence_names],
})
print(json.dumps({'checkpoint': str(out / 'checkpoint.json'), 'sha256': sha((out / 'checkpoint.json').read_bytes()), 'sources': source_hashes}))
