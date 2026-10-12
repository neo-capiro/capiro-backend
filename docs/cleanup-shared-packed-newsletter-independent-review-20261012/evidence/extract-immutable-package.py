import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tarfile

repo, pin, artifact_path, consumer_path, receipt_path = sys.argv[1:]
blob = subprocess.check_output(['git', '-C', repo, 'show', pin + ':' + artifact_path])
expected = '697d826647e88e7f8559da386be7de1ae6408dc61c73877b86c2e17275fd63ab'
assert hashlib.sha256(blob).hexdigest() == expected
consumer = pathlib.Path(consumer_path)
package = consumer / 'node_modules' / '@capiro' / 'shared'
assert not package.exists(), 'Use a new empty isolated consumer'
rows = []
seen = set()
with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as archive:
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        assert path.parts and path.parts[0] == 'package'
        assert not path.is_absolute() and '..' not in path.parts
        assert str(path) == member.name.rstrip('/'), 'Noncanonical tar path'
        assert member.name not in seen, 'Duplicate tar entry'
        seen.add(member.name)
        if member.isdir():
            continue
        assert member.isfile(), 'Symlink, hardlink or other special tar member'
        assert len(path.parts) > 1
        data = archive.extractfile(member).read()
        target = package.joinpath(*path.parts[1:])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        rows.append({'path': member.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'mode': oct(member.mode)})
assert len(rows) == 182, len(rows)
baseline_package = subprocess.check_output(['git', '-C', repo, 'show', 'fe50dc1c2de1660a036e338cf81acdcf0f2fb26a:packages/shared/package.json'])
assert (package / 'package.json').read_bytes() == baseline_package, 'Canonical metadata bytes differ'
metadata = json.loads(baseline_package)
assert metadata['name'] == '@capiro/shared' and metadata['version'] == '0.0.0'
assert not metadata.get('dependencies')
for export in ['newsletter', 'newsletter-render']:
    for value in metadata['exports']['./' + export].values():
        assert package.joinpath(value).is_file()
(consumer / 'package.json').write_text(json.dumps({'name': 'independent-packed-newsletter-consumer', 'private': True, 'type': 'module'}) + '\n')
receipt = {'source': 'fe50dc1c2de1660a036e338cf81acdcf0f2fb26a', 'artifactCommit': pin, 'artifactPath': artifact_path, 'artifactSha256': expected, 'artifactBytes': len(blob), 'canonicalMetadataBytesEqual': True, 'regularEntries': len(rows), 'declarations': sum(row['path'].endswith('.d.ts') for row in rows), 'entries': sorted(rows, key=lambda row: row['path']), 'consumerRoot': str(consumer), 'privateSourceImports': False}
pathlib.Path(receipt_path).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({key: value for key, value in receipt.items() if key not in ['entries']}))
