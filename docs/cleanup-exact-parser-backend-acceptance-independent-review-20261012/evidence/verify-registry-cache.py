from pathlib import Path, PurePosixPath
import base64, hashlib, json, tarfile, subprocess

source = '61e9b467295235829e7d8097368ce41b0434818a'
packet = Path('docs/cleanup-exact-parser-backend-acceptance-independent-review-20261012')
root = Path('/tmp/capirov2-cleanup-meri-reviewed-runtime-conversion')
cache = Path('/tmp/capirov2-workspace-parser-acceptance-cache-20261012')
parser = cache/'htmlparser2-8.0.2/package'
root_packet = root/'docs/cleanup-workspace-parser-local-acceptance-20261012'
receipt = json.loads((root_packet/'REGISTRY-INTEGRITY.json').read_text())
host = json.loads((root_packet/'DEPENDENCY-HOST.json').read_text())
locked = json.loads((packet/'evidence/locked-baseline.json').read_text())
metadata_bytes = (cache/'htmlparser2-8.0.2.metadata.json').read_bytes()
metadata = json.loads(metadata_bytes)
tarball = (cache/'htmlparser2-8.0.2.tgz').read_bytes()
sha = lambda b: hashlib.sha256(b).hexdigest()
actual_integrity = 'sha512-' + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
assert metadata['name'] == 'htmlparser2' and metadata['version'] == '8.0.2'
assert receipt['package'] == metadata['name'] and receipt['version'] == metadata['version']
assert actual_integrity == metadata['dist']['integrity'] == receipt['actualIntegrity'] == receipt['registryIntegrity'] == receipt['lockedIntegrity'] == locked['package']['resolution']['integrity']
assert hashlib.sha1(tarball).hexdigest() == metadata['dist']['shasum'] == receipt['registrySha1']
assert len(tarball) == 38519 == receipt['tarballBytes']
assert sha(tarball) == '7913fb842d292726d2b1b1fdd0ca8fb86be41c63efe06a15064c728353274966' == receipt['tarballSha256']
assert sha(metadata_bytes) == receipt['metadataSha256']
assert locked['files'][0]['sha256'] == receipt['lockSha256']
assert receipt['metadataHttpStatus'] == 200 and receipt['tarballHttpStatus'] == 200
assert receipt['metadataFinalUrl'] == receipt['metadataUrl'] == 'https://registry.npmjs.org/htmlparser2/8.0.2'
assert receipt['tarballFinalUrl'] == receipt['tarballUrl'] == metadata['dist']['tarball'] == 'https://registry.npmjs.org/htmlparser2/-/htmlparser2-8.0.2.tgz'
files = []
with tarfile.open(cache/'htmlparser2-8.0.2.tgz', mode='r:gz') as archive:
    names = set()
    for member in archive.getmembers():
        name = PurePosixPath(member.name)
        assert not name.is_absolute() and '..' not in name.parts and name.parts[0] == 'package'
        assert member.name not in names
        names.add(member.name)
        assert member.isfile(), (member.name, member.type)
        data = archive.extractfile(member).read()
        path = parser.joinpath(*name.parts[1:])
        assert path.is_file() and not path.is_symlink()
        assert path.read_bytes() == data, member.name
        files.append({'archivePath':member.name, 'bytes':len(data), 'sha256':sha(data)})
assert len(files) == metadata['dist']['fileCount'] == receipt['extractedFiles'] == 36
assert sum(x['bytes'] for x in files) == metadata['dist']['unpackedSize'] == 265049
assert {str(p.relative_to(parser)) for p in parser.rglob('*') if p.is_file() and 'node_modules' not in p.relative_to(parser).parts} == {x['archivePath'][len('package/'):] for x in files}
package = json.loads((parser/'package.json').read_text())
assert package['name'] == 'htmlparser2' and package['version'] == '8.0.2'
assert package['main'] == 'lib/index.js' and package['types'] == 'lib/index.d.ts'
assert package['dependencies'] == receipt['dependencies']
dependency_bindings = []
for dependency in host['exactLockedDirectDependencies']:
    name = dependency['package']
    target = (parser/'node_modules'/name).resolve(strict=True)
    assert target == Path(dependency['target']).resolve(strict=True)
    data = (target/'package.json').read_bytes()
    manifest = json.loads(data)
    assert manifest['name'] == name and manifest['version'] == dependency['lockedVersion'] == locked['snapshot']['dependencies'][name]
    assert sha(data) == dependency['packageJsonSha256']
    dependency_bindings.append({'name':name, 'version':manifest['version'], 'path':str(target), 'packageJsonSha256':sha(data)})
def entries(cwd):
    output = subprocess.check_output(['git', 'ls-tree', '-r', '-z', source], cwd=cwd)
    return {name.decode():entry.decode() for row in output.split(b'\0') if row for entry,name in [row.split(b'\t',1)]}
baseline_entries = entries('.')
assert entries(root) == baseline_entries
for cwd in [Path('.'), root]:
    diffs = subprocess.check_output(['git', 'diff', '--name-only', source, '--', '.', ':(exclude)docs'], cwd=cwd, text=True)
    assert not diffs, (str(cwd), diffs)
result = {
    'source':source, 'sourceTree':'6b49311aae5c26e31101c31a07ae2fc7865af3df',
    'registryReceiptSha256':sha((root_packet/'REGISTRY-INTEGRITY.json').read_bytes()),
    'dependencyReceiptSha256':sha((root_packet/'DEPENDENCY-HOST.json').read_bytes()),
    'metadataSha256':sha(metadata_bytes), 'tarballSha256':sha(tarball),
    'lockRegistryActualSHA512Exact':actual_integrity, 'tarballBytes':len(tarball),
    'archiveFiles':files, 'extractedExactFileCount':36, 'totalExtractedBytes':265049,
    'directDependencyBindings':dependency_bindings,
    'sourceTrackedDiffOutsideDocs':[], 'existingTrackedBaselineEntries':len(baseline_entries),
    'registryHttpEvidence':'independently validated frozen root request URLs/status receipt plus archived metadata; reviewer did not repeat network retrieval',
    'signatureVerificationClaim':False, 'npmLifecycleInstallHooksExecuted':False,
    'parserRuntimeExecutionByThisProgram':False, 'nativeDatabaseSqlProviderCalls':0,
}
(packet/'evidence/registry-cache-proof.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'parser':'8.0.2','lockedRegistryActualIntegrityExact':True,'archiveFilesExact':36,'directDependenciesExact':4,'sourceChanged':False}))
