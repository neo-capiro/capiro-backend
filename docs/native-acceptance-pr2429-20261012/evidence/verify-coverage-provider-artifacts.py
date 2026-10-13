import base64
import hashlib
import json
from pathlib import Path
import tarfile

repo = Path(__file__).resolve().parents[3]
receipt = json.loads((repo / 'docs/cleanup-current-install-gate-coverage-audit-20261012/evidence/locked-coverage-provider-continuation.json').read_text())
cache = Path(receipt['privateRoot'])
assert receipt['lockSha256'] == hashlib.sha256((repo / 'pnpm-lock.yaml').read_bytes()).hexdigest()
verified = []
for record in receipt['records']:
    archive = cache / (record['name'].replace('/', '+') + '-' + record['version'] + '.tgz')
    data = archive.read_bytes()
    sri = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
    assert sri == record['expectedIntegrity'] == record['actualIntegrity']
    assert hashlib.sha256(data).hexdigest() == record['tarballSha256']
    assert len(data) == record['tarballBytes']
    assert record['url'] == record['finalUrl'] and record['url'].startswith('https://registry.npmjs.org/')
    assert record['status'] == 200 and not record['lifecycleExecuted']
    package = Path(record['privatePackageDir'])
    with tarfile.open(archive, 'r:gz') as tar:
        members = {m.name.removeprefix('package/'): m for m in tar.getmembers() if m.isfile()}
        assert set(members) == {e['path'] for e in record['entries']}
        for entry in record['entries']:
            physical = (package / entry['path']).read_bytes()
            original = tar.extractfile(members[entry['path']]).read()
            assert physical == original
            assert len(physical) == entry['bytes']
            assert hashlib.sha256(physical).hexdigest() == entry['sha256']
    verified.append({'name': record['name'], 'version': record['version'], 'sri': sri, 'entries': len(members)})
provider = next(r for r in receipt['records'] if r['name'] == '@vitest/coverage-v8')
fixture = Path('/tmp/capiro-vitest-v8-toolchain-277-20261012')
for entry in provider['entries']:
    assert (fixture / 'node_modules/@vitest/coverage-v8' / entry['path']).read_bytes() == (Path(provider['privatePackageDir']) / entry['path']).read_bytes()
summary = json.loads((fixture / 'coverage/coverage-summary.json').read_text())
assert len(summary) == 2
subject = summary[str(fixture / 'subject.ts')]
for field, count in [('lines',5),('statements',5),('branches',4),('functions',1)]:
    assert subject[field]['total'] == subject[field]['covered'] == count
    assert subject[field]['pct'] == 100
print(json.dumps({'reviewer':'root independent artifact/read-only coverage proof', 'verifiedTarballs':verified, 'byteExactInstalledProviderFiles':len(provider['entries']), 'actualCoverageMetrics':subject, 'networkExecuted':False, 'processExecuted':False, 'databaseExecuted':False}, indent=2))
