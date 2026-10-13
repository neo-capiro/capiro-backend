#!/usr/bin/env python3
"""Source-bound, cached-compiler, offline/lifecycle-free Shared distribution."""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

args = argparse.ArgumentParser()
args.add_argument('--source', required=True)
args.add_argument('--tree', required=True)
args.add_argument('--repository', required=True)
args.add_argument('--packet', required=True)
args.add_argument('--stage', required=True)
opts = args.parse_args()
repo, packet, stage = map(Path, [opts.repository, opts.packet, opts.stage])
node = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
npm = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/lib/node_modules/npm/bin/npm-cli.js'
tsc = '/workspace/capirov2/node_modules/typescript/bin/tsc'
env = {'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
assert stage.is_absolute() and stage.parent == Path('/workspace')
assert stage.name.startswith('capiro-shared-newsletter-receiving-dist-')
assert not stage.exists(), 'Pristine source/build/consumer/cache stage required'
evidence = packet / 'evidence'
evidence.mkdir(parents=True, exist_ok=True)
(packet / 'artifact').mkdir(exist_ok=True)

def git(*argv):
    return subprocess.check_output(['git', *argv], cwd=repo)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

assert git('rev-parse', opts.source + '^{tree}').decode().strip() == opts.tree
old_artifact = repo / 'docs/shared-newsletter-packed-distribution-20261012/artifact/capiro-shared-0.0.0.tgz'
assert digest(old_artifact.read_bytes()) == '697d826647e88e7f8559da386be7de1ae6408dc61c73877b86c2e17275fd63ab'
stage.mkdir()
rows = []
for item in git('ls-tree', '-rz', opts.source, '--', 'packages/shared', 'tsconfig.base.json').split(b'\0'):
    if not item:
        continue
    meta, name = item.split(b'\t', 1)
    mode, kind, oid = meta.decode().split()
    name = name.decode()
    assert kind == 'blob' and mode in ['100644', '100755']
    assert 'corpus' not in name and 'fixtures' not in name, 'Test corpus must remain outside packaged Shared'
    raw = git('show', opts.source + ':' + name)
    target = stage / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    os.chmod(target, 0o755 if mode == '100755' else 0o644)
    rows.append(dict(path=name, mode=mode, gitBlob=oid, bytes=len(raw), sha256=digest(raw)))
(stage / 'node_modules').symlink_to('/workspace/capirov2/node_modules', target_is_directory=True)
(stage / 'build-state').mkdir()
package = stage / 'packages/shared'
pkg = json.loads((package / 'package.json').read_bytes())
assert pkg['name'] == '@capiro/shared' and pkg['version'] == '0.0.0' and pkg['private'] is True
assert (package / 'package.json').read_bytes() == git('show', 'c07d00e27fdda64dfbd13c36d0ac433c81d9f7f4:packages/shared/package.json')
assert not set(pkg.get('scripts', {})) & {'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'install', 'preinstall', 'postinstall'}
addition = "\n/** Pure receiving parsers and canonical read envelopes; no action is performed by parsing. */\nexport * from './newsletter-receiving.js';\n"
news = (package / 'src/newsletter.ts').read_bytes()
assert news.endswith(addition.encode())
inverse = news[:-len(addition.encode())]
original = git('show', '1e99f0921b207318c6d2abf03927b5c4daa5768b:packages/shared/src/newsletter.ts')
assert inverse == original
assert original == git('show', '193703e34f2bedbb69d87d6a8ee303f65ab8dbda:packages/shared/src/newsletter.ts')
source_receipt = dict(source=opts.source, tree=opts.tree, stage=str(stage), canonicalFiles=rows,
                      packageMetadataUnchanged=True, publicSubpathsUnchanged=True,
                      newsletterAdditiveExportInverseSha256=digest(inverse),
                      oldTarballSha256=digest(old_artifact.read_bytes()), compilerOutputInitiallyAbsent=True)
(evidence / 'canonical-source-binding.json').write_text(json.dumps(source_receipt, indent=2) + '\n')

def run(name, command, cwd):
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True)
    (evidence / (name + '.stdout.log')).write_bytes(result.stdout)
    (evidence / (name + '.stderr.log')).write_bytes(result.stderr)
    receipt = dict(command=command, cwd=str(cwd), env=env, exitCode=result.returncode)
    (evidence / (name + '.command.json')).write_text(json.dumps(receipt, indent=2) + '\n')
    if result.returncode:
        raise RuntimeError(f'{name} failed, raw receipts retained: {result.returncode}')
    return result

build = run('01-pristine-shared-build', [node, tsc, '-p', str(package / 'tsconfig.json'),
            '--tsBuildInfoFile', str(stage / 'build-state/shared.tsbuildinfo')], stage)
assert (package / 'dist/newsletter-receiving.js').is_file()
configuration = stage / 'empty-pack-configuration'
configuration.mkdir()
for name in ['user.npmrc', 'global.npmrc']:
    (configuration / name).write_bytes(b'')
flags = ['--ignore-scripts', '--offline', '--no-update-notifier', '--userconfig',
         str(configuration / 'user.npmrc'), '--globalconfig', str(configuration / 'global.npmrc'),
         '--cache', str(stage / 'npm-cache')]
config = run('02-effective-npm-configuration', [node, npm, 'config', 'get', 'offline', 'ignore-scripts',
             'update-notifier', *flags], package)
assert 'offline=true' in config.stdout.decode() and 'ignore-scripts=true' in config.stdout.decode()
assert 'update-notifier=false' in config.stdout.decode()
packs, entries = [], []
for number in [1, 2]:
    destination = stage / ('pack-' + str(number))
    destination.mkdir()
    output = run('03-npm-pack-' + str(number), [node, npm, 'pack', *flags,
                 '--pack-destination', str(destination), '--json'], package)
    metadata = json.loads(output.stdout)
    assert len(metadata) == 1
    item = metadata[0]
    artifact = destination / item['filename']
    raw = artifact.read_bytes()
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode()
    assert item['integrity'] == integrity and item['name'] == '@capiro/shared' and item['version'] == '0.0.0'
    packs.append(dict(filename=artifact.name, bytes=len(raw), sha256=digest(raw), integrity=integrity,
                      sha512=hashlib.sha512(raw).hexdigest(), npmResult=item))
    if number == 1:
        with tarfile.open(artifact, 'r:gz') as archive:
            names = set()
            for member in archive.getmembers():
                relative = PurePosixPath(member.name)
                assert member.isfile() and relative.parts[0] == 'package'
                assert '..' not in relative.parts and not relative.is_absolute()
                assert member.name not in names
                names.add(member.name)
                assert not any(x in relative.parts for x in ['node_modules', 'npm-cache', 'build-state'])
                assert not member.name.endswith('.tsbuildinfo') and 'corpus' not in member.name
                contents = archive.extractfile(member).read()
                assert contents == (package / str(relative.relative_to('package'))).read_bytes()
                entries.append(dict(path=member.name, mode=oct(member.mode), bytes=len(contents), sha256=digest(contents)))
        (packet / 'artifact' / artifact.name).write_bytes(raw)
assert packs[0]['sha256'] == packs[1]['sha256']
logs = []
for file in sorted((stage / 'npm-cache/_logs').glob('*.log')):
    raw = file.read_bytes()
    assert b'http fetch' not in raw
    name = 'npm-' + file.name
    (evidence / name).write_bytes(raw)
    logs.append(dict(path='evidence/' + name, sha256=digest(raw), httpFetchLines=0))
manifest = dict(sourceHead=opts.source, sourceTree=opts.tree, stage=str(stage), packs=packs,
                packedEntries=sorted(entries, key=lambda x: x['path']), debugLogs=logs,
                repeatPackingByteExact=True, oldTarballPreserved=True, lifecycleScriptsRun=False,
                offline=True, updateNotifierDisabled=True, noGeneralNetworkTraceClaim=True,
                registryPublication=False, sourcePackageMetadataUnchanged=True)
(packet / 'PACKED-MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(dict(source=opts.source, filename=packs[0]['filename'], bytes=packs[0]['bytes'],
                     sha256=packs[0]['sha256'], integrity=packs[0]['integrity'], entries=len(entries),
                     deterministicPacks=2, cachedSharedBuildExit=build.returncode), indent=2))
