import base64
import hashlib
import json
import pathlib
import subprocess

repo = pathlib.Path('/tmp/capirov2-cleanup-meri-local-dispatch-independent-review')
packet = pathlib.Path(__file__).resolve().parent
producer = '23e3d3a68cf57062482e3cc4ca9b53e9cb249796'
prefix = 'docs/shared-newsletter-packed-distribution-20261012/'
source = 'fe50dc1c2de1660a036e338cf81acdcf0f2fb26a'
def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo)
def read(path):
    return git('show', producer + ':' + prefix + path)
def digest(data):
    return hashlib.sha256(data).hexdigest()
index = json.loads(read('SHA256-INDEX.json'))
for row in index['files']:
    data = git('show', producer + ':' + row['path'])
    assert len(data) == row['bytes'] and digest(data) == row['sha256'], row['path']
inventory = json.loads((packet / 'packed-inventory.json').read_text())
manifest = json.loads(read('PACKED-MANIFEST.json'))
assert inventory['entries'] == manifest['packedEntries']
blob = read('artifact/capiro-shared-0.0.0.tgz')
sri = 'sha512-' + base64.b64encode(hashlib.sha512(blob).digest()).decode()
assert all(row['integrity'] == sri and row['sha256'] == digest(blob) for row in manifest['packs'])
binding = json.loads(read('evidence/canonical-source-binding.json'))
package = pathlib.Path(inventory['consumerRoot']) / 'node_modules/@capiro/shared'
for row in binding['canonicalFiles']:
    data = git('show', source + ':' + row['path'])
    assert digest(data) == row['sha256'] and len(data) == row['bytes']
    assert git('rev-parse', source + ':' + row['path']).decode().strip() == row['gitBlob']
    if row['path'].startswith('packages/shared/'):
        assert package.joinpath(row['path'].removeprefix('packages/shared/')).read_bytes() == data
assert len(binding['canonicalFiles']) == 39
map_rows = []
for path in sorted((package / 'dist').rglob('*.map')):
    value = json.loads(path.read_bytes())
    assert not value.get('sourceRoot', '').startswith('/')
    for name in value['sources']:
        assert not pathlib.Path(name).is_absolute()
        resolved = (path.parent / value.get('sourceRoot', '') / name).resolve()
        assert resolved.is_relative_to(package / 'src') and resolved.is_file(), str(resolved)
    map_rows.append(str(path.relative_to(package)))
assert len(map_rows) == 72
for name in ['newsletter','newsletter-render','newsletter-fonts','newsletter-fonts.catalog','newsletter-social-share']:
    path = 'packages/shared/src/' + name + '.ts'
    assert git('show', source + ':' + path) == git('show', '1e99f0921b207318c6d2abf03927b5c4daa5768b:' + path)
    assert git('show', source + ':' + path) == git('show', '193703e34f2bedbb69d87d6a8ee303f65ab8dbda:' + path)
non_doc = git('diff', '--name-only', source, producer, '--', ':!docs').decode().splitlines()
assert non_doc == []
assert git('diff', '--name-only', source, 'd587441261fd356ee5144a8fc29cb2f771d062b8', '--', 'packages/shared', 'tsconfig.base.json').decode() == ''
golden = json.loads(read('evidence/original-C-renderer-golden.json'))
packed = json.loads(read('evidence/packed-renderer-results.json'))
browser = json.loads(read('evidence/browser-renderer-results.json'))
assert golden == packed == browser
qualification = json.loads(read('CONSUMER-QUALIFICATION.json'))
assert qualification['characterizationCases'] == 116 and all(row['pass'] for row in qualification['checks'])
result = {'artifactPacket': producer, 'artifactTree': git('rev-parse', producer + '^{tree}').decode().strip(), 'source': source, 'sourceTree': git('rev-parse', source + '^{tree}').decode().strip(), 'producerIndexBindingsVerified': len(index['files']), 'packedEntriesVerified': len(inventory['entries']), 'allDeclarationsVerified': inventory['declarations'], 'canonicalSourceConfigBindings': 39, 'sourceMapsPackageLocal': len(map_rows), 'originalCOriginalWFiveModulesByteExact': True, 'producerGoldenPackedBrowserCaseCount': 116, 'producerGoldenPackedBrowserResultsEqual': True, 'sharedPublishedD587SourceContinuity': True, 'nonDocDelta': [], 'artifactIntegrity': sri, 'packingHttpClaimHeldPendingCorrection': True}
(packet / 'frozen-packet-audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
