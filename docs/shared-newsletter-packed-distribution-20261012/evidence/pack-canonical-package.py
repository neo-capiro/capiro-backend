"""Offline, lifecycle-free pack of an already built canonical package snapshot."""
import base64
import hashlib
import json
import pathlib
import subprocess
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
STAGE = pathlib.Path('/tmp/capiro-shared-newsletter-dist-fe50-20261012')
PACKAGE = STAGE / 'packages/shared'
NPM = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/lib/node_modules/npm/bin/npm-cli.js'
entries = []
packs = []
for number in (1, 2):
    destination = STAGE / f'pack-{number}'
    destination.mkdir(exist_ok=False)
    command = ['node', NPM, 'pack', '--ignore-scripts', '--offline', '--cache',
               str(STAGE / 'npm-cache'), '--pack-destination', str(destination), '--json']
    result = subprocess.run(command, cwd=PACKAGE, capture_output=True)
    (ROOT / f'evidence/npm-pack-{number}.stdout.json').write_bytes(result.stdout)
    (ROOT / f'evidence/npm-pack-{number}.stderr.log').write_bytes(result.stderr)
    if result.returncode:
        raise RuntimeError(f'pack {number} failed: {result.returncode}')
    metadata = json.loads(result.stdout)
    assert len(metadata) == 1
    item = metadata[0]
    path = destination / item['filename']
    data = path.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
    assert item['integrity'] == integrity
    assert item['name'] == '@capiro/shared' and item['version'] == '0.0.0'
    packs.append(dict(command=command, cwd=str(PACKAGE), exitCode=result.returncode,
                      filename=path.name, bytes=len(data), sha256=sha256,
                      sha512=hashlib.sha512(data).hexdigest(), integrity=integrity,
                      npmResult=item))
    if number == 1:
        with tarfile.open(path, 'r:gz') as archive:
            names = set()
            for member in archive.getmembers():
                assert member.isfile(), (member.name, member.type)
                assert member.name.startswith('package/')
                relative = pathlib.PurePosixPath(member.name)
                assert '..' not in relative.parts and not relative.is_absolute()
                assert member.name not in names
                names.add(member.name)
                assert not any(x in relative.parts for x in ('node_modules', 'npm-cache', 'build-state'))
                assert not member.name.endswith('.tsbuildinfo')
                stream = archive.extractfile(member)
                assert stream is not None
                contents = stream.read()
                canonical = PACKAGE / str(relative.relative_to('package'))
                assert contents == canonical.read_bytes(), member.name
                entries.append(dict(path=member.name, mode=oct(member.mode), bytes=len(contents),
                                    sha256=hashlib.sha256(contents).hexdigest()))
        (ROOT / 'artifact' / path.name).write_bytes(data)
assert packs[0]['sha256'] == packs[1]['sha256'], 'repeat packing must be byte exact'
manifest = dict(sourceHead='fe50dc1c2de1660a036e338cf81acdcf0f2fb26a',
                sourceTree='00ca67ae1f2cacc1ae0b51fff25cb33d58954f67',
                npmVersion=subprocess.check_output(['node', NPM, '--version'], text=True).strip(),
                nodeVersion=subprocess.check_output(['node', '--version'], text=True).strip(),
                typescriptVersion=subprocess.check_output(['node', '/workspace/capirov2/node_modules/typescript/bin/tsc', '--version'], text=True).strip(),
                packs=packs, packedEntries=sorted(entries, key=lambda x:x['path']),
                lifecycleScriptsRun=False, registryPublication=False, networkRequired=False,
                repeatPackingByteExact=True)
(ROOT / 'PACKED-MANIFEST.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(dict(filename=packs[0]['filename'], bytes=packs[0]['bytes'],
                     sha256=packs[0]['sha256'], integrity=packs[0]['integrity'],
                     entries=len(entries), repeatPackingByteExact=True), indent=2))
