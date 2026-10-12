"""Download a public official npm tarball, verify the lock SRI, safely extract it."""
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import urllib.request

ROOT = Path.cwd()
PACKET = Path(__file__).resolve().parents[1]
CACHE = Path('/tmp/capirov2-workspace-parser-acceptance-cache-20261012')
PACKAGE = 'htmlparser2'
VERSION = '8.0.2'
metadata_url = f'https://registry.npmjs.org/{PACKAGE}/{VERSION}'
lock = (ROOT / 'pnpm-lock.yaml').read_bytes()
match = re.search(rb'^  htmlparser2@8\.0\.2:\n    resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}', lock, re.M)
assert match, 'exact locked parser integrity absent'
expected = match.group(1).decode()

def get(url):
    assert url.startswith('https://registry.npmjs.org/'), url
    with urllib.request.urlopen(url, timeout=45) as response:
        assert response.geturl().startswith('https://registry.npmjs.org/'), response.geturl()
        return response.read(), response.status, response.geturl()

CACHE.mkdir(parents=True, exist_ok=True)
metadata_bytes, metadata_status, final_metadata_url = get(metadata_url)
metadata = json.loads(metadata_bytes)
assert metadata['name'] == PACKAGE and metadata['version'] == VERSION
assert metadata['dist']['integrity'] == expected
tarball_url = metadata['dist']['tarball']
assert tarball_url == 'https://registry.npmjs.org/htmlparser2/-/htmlparser2-8.0.2.tgz'
tarball, status, final_tarball_url = get(tarball_url)
actual = 'sha512-' + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
assert actual == expected, 'tarball integrity mismatch'
assert hashlib.sha1(tarball).hexdigest() == metadata['dist']['shasum']
(CACHE / 'htmlparser2-8.0.2.metadata.json').write_bytes(metadata_bytes)
(CACHE / 'htmlparser2-8.0.2.tgz').write_bytes(tarball)
destination = CACHE / 'htmlparser2-8.0.2'
destination.mkdir(exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(tarball), mode='r:gz') as archive:
    members = archive.getmembers()
    for member in members:
        parts = PurePosixPath(member.name).parts
        assert parts and parts[0] == 'package' and '..' not in parts
        assert not member.name.startswith('/') and (member.isfile() or member.isdir())
    archive.extractall(destination, members=members, filter='data')
extracted = json.loads((destination / 'package/package.json').read_text())
assert extracted['name'] == PACKAGE and extracted['version'] == VERSION
receipt = {
    'package': PACKAGE, 'version': VERSION, 'metadataUrl': metadata_url,
    'metadataHttpStatus': metadata_status, 'metadataFinalUrl': final_metadata_url,
    'tarballUrl': tarball_url, 'tarballHttpStatus': status, 'tarballFinalUrl': final_tarball_url,
    'lockedIntegrity': expected, 'registryIntegrity': metadata['dist']['integrity'],
    'actualIntegrity': actual, 'registrySha1': metadata['dist']['shasum'],
    'tarballBytes': len(tarball), 'tarballSha256': hashlib.sha256(tarball).hexdigest(),
    'metadataSha256': hashlib.sha256(metadata_bytes).hexdigest(),
    'lockSha256': hashlib.sha256(lock).hexdigest(), 'extractedFiles': len(members),
    'extractedPackage': str(destination / 'package'),
    'dependencies': extracted['dependencies'],
    'lifecycleScriptsExecuted': False, 'packageManagerInstall': False,
    'productionSourceOrLockChanged': False,
    'networkPath': 'Public official registry HTTPS through existing environment network; no proxy, checksum, credential or permission changes',
}
(PACKET / 'REGISTRY-INTEGRITY.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))
