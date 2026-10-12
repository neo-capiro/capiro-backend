"""Approved official tarball retrieval, no installer/lifecycle/native downloader."""
import base64
import hashlib
import json
import pathlib
import tarfile
import io
import urllib.request
import urllib.error

EVIDENCE = pathlib.Path(__file__).resolve().parent
PRIVATE = pathlib.Path('/tmp/capiro-coverage-provider-cache-277-20261012')
CAP = 5 * 1024 * 1024
PRIVATE.mkdir(exist_ok=False)
graph = json.loads((EVIDENCE / 'coverage-provider-cache-graph.json').read_text())
assert len(graph['missing']) == 5
records = []
used = 0
for node in graph['missing']:
    name, version, integrity = node['name'], node['version'], node['integrity']
    leaf = name.rsplit('/', 1)[-1]
    url = f'https://registry.npmjs.org/{name}/-/{leaf}-{version}.tgz'
    record = dict(name=name, version=version, url=url, expectedIntegrity=integrity)
    records.append(record)
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'capiro-locked-dependency-audit/1'})
        with urllib.request.urlopen(request, timeout=30) as response:
            record.update(status=response.status, finalUrl=response.url,
                          contentLength=response.headers.get('Content-Length'))
            assert response.url == url, 'Unapproved redirect'
            data = response.read(min(CAP-used, 1024*1024)+1)
            assert len(data) <= 1024*1024 and len(data) + used <= CAP, 'Storage cap exceeded'
        algo, expected = integrity.split('-', 1)
        assert algo == 'sha512'
        actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
        assert actual == expected, 'Locked SHA512 mismatch; extraction refused'
        record.update(tarballBytes=len(data), tarballSha256=hashlib.sha256(data).hexdigest(),
                      actualIntegrity='sha512-'+actual, integrityVerifiedBeforeExtraction=True)
        destination = PRIVATE / 'packages' / (name.replace('/', '+')+'@'+version)
        destination.mkdir(parents=True, exist_ok=False)
        archive_path = PRIVATE / (name.replace('/', '+')+'-'+version+'.tgz')
        archive_path.write_bytes(data)
        used += len(data)
        entries = []
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            members = archive.getmembers()
            seen = set()
            uncompressed = sum(member.size for member in members if member.isfile())
            assert used + uncompressed <= CAP, 'Uncompressed private storage cap exceeded'
            for member in members:
                p = pathlib.PurePosixPath(member.name)
                assert not p.is_absolute() and '..' not in p.parts and p.parts[0] == 'package'
                assert member.name not in seen
                seen.add(member.name)
                if member.isdir():
                    continue
                assert member.isfile(), 'Links/devices/exotic tar entry refused'
                assert p.suffix.lower() not in ['.node', '.so', '.dll', '.dylib', '.exe'], 'Native package refused'
                stream = archive.extractfile(member)
                assert stream is not None
                contents = stream.read()
                output = destination.joinpath(*p.parts[1:])
                output.parent.mkdir(parents=True, exist_ok=True)
                assert not output.exists()
                output.write_bytes(contents)
                entries.append(dict(path=str(p.relative_to('package')), bytes=len(contents),
                                    tarMode=oct(member.mode), sha256=hashlib.sha256(contents).hexdigest()))
                used += len(contents)
        pkg = json.loads((destination / 'package.json').read_text())
        assert pkg['name'] == name and pkg['version'] == version
        lifecycle = {key: value for key, value in pkg.get('scripts', {}).items()
                     if key in ['preinstall', 'install', 'postinstall', 'prepare']}
        assert not lifecycle, 'Unexpected lifecycle hook; package not activated'
        record.update(privatePackageDir=str(destination), packageJsonSha256=hashlib.sha256((destination/'package.json').read_bytes()).hexdigest(),
                      entries=entries, lifecycleScripts=lifecycle, lifecycleExecuted=False,
                      nativeFilesFound=False, statusOutcome='retrieved-and-verified')
    except Exception as error:
        record.update(statusOutcome='failed', errorType=type(error).__name__, error=str(error))
        if isinstance(error, urllib.error.HTTPError):
            record['status'] = error.code
            record['responseBody'] = error.read(8192).decode('utf8', errors='replace')
        result = dict(sourceHead=graph['sourceHead'], privateRoot=str(PRIVATE), privateBytesUsed=used,
                      capBytes=CAP, records=records, noInstallerOrLifecycle=True, noSourceLockGlobalChanges=True)
        (EVIDENCE/'locked-coverage-provider-retrieval.json').write_text(json.dumps(result, indent=2)+'\n')
        raise
result = dict(sourceHead=graph['sourceHead'], privateRoot=str(PRIVATE), privateBytesUsed=used,
              capBytes=CAP, records=records, noInstallerOrLifecycle=True, noSourceLockGlobalChanges=True)
(EVIDENCE/'locked-coverage-provider-retrieval.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(dict(packages=len(records), privateBytesUsed=used, capBytes=CAP,
                     integrityVerified=True, lifecycleExecuted=False, sourceLockChanges=0), indent=2))
