import hashlib, json, pathlib, subprocess, sys

root = pathlib.Path(__file__).resolve().parents[2]
packet = pathlib.Path(__file__).resolve().parent
index_file = packet / 'SHA256-INDEX.json'
sha = lambda data: hashlib.sha256(data).hexdigest()
receipt = json.loads((packet / 'SOURCE-RECEIPT.json').read_text())
for row in receipt['sourceRows']:
    data = subprocess.check_output(['git', 'show', receipt['sourceHead'] + ':' + row['path']], cwd=root)
    assert sha(data) == row['sha256'], row['path']
tree = subprocess.check_output(['git', 'rev-parse', receipt['sourceHead'] + '^{tree}'], cwd=root).decode().strip()
assert tree == receipt['sourceTree']
report = json.loads((packet / 'evidence/attempt-8.stdout.raw').read_text().split('QUALIFICATION_REPORT\n')[-1])
assert report['sourceHead'] == receipt['sourceHead'] and report['result'] == 'pass'
assert len(report['checks']) == 28 and all(row['passed'] for row in report['checks'])
assert not report['denied'] and not report['asyncErrors'] and not report['remainingTimers']
unit = json.loads((packet / 'evidence/unit-attempt-2.results.json').read_text())
assert unit['success'] and unit['numPassedTests'] == 7
types = json.loads((packet / 'evidence/types-attempt-2.stdout.raw').read_text())
assert types['result'] == 'pass' and not types['diagnostics']
assert any(row['path'].endswith('/packages/shared/src/index.ts') and row['blob'] for row in types['sources'])
assert not any('/packages/shared/dist/index.d.ts' in row['path'] for row in types['sources'])
rows = []
for file in sorted(packet.rglob('*')):
    if file.is_file() and file != index_file:
        data = file.read_bytes()
        rows.append({'path': file.relative_to(packet).as_posix(), 'bytes': len(data), 'sha256': sha(data)})
if '--write' in sys.argv:
    index_file.write_text(json.dumps({'sourceHead': receipt['sourceHead'], 'payloads': rows}, indent=2) + '\n')
else:
    assert json.loads(index_file.read_text())['payloads'] == rows
print(json.dumps({'result': 'pass', 'payloads': len(rows), 'sourceFiles': len(receipt['sourceRows']),
                  'coreChecks': 28, 'unitCases': 7, 'strictTypeDiagnostics': 0}))
