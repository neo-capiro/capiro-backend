import hashlib
import json
import os
from pathlib import Path
import subprocess

REPO = Path('/workspace/capirov2')
CURRENT = 'bbb38185058fdc64c204da723943aee055b3dad3'
BASELINE = '457e84e7d50f401985355cf22eedc480fd72ad8b'

def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=REPO)

def entries(head):
    result = {}
    for row in git('ls-tree', '-r', '-z', head).split(b'\0'):
        if row:
            metadata, name = row.split(b'\t')
            mode, kind, blob = metadata.decode().split()
            result[name.decode()] = {'mode': mode, 'type': kind, 'blob': blob}
    return result

def identity(file):
    data = Path(file).read_bytes()
    return {'file': str(file), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

current, baseline = entries(CURRENT), entries(BASELINE)
manifests = sorted(p for p in current if p == 'package.json' or (p.endswith('/package.json') and p.count('/') == 2 and p.split('/')[0] in ['apps', 'packages', 'infra']))
configuration = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'tsconfig.base.json', 'turbo.json', 'apps/api/tsconfig.json', 'apps/api/tsconfig.build.json', 'apps/api/nest-cli.json', 'apps/api/jest.config.cjs', 'apps/api/jest.setup.ts', 'packages/shared/tsconfig.json', 'packages/auth/tsconfig.json', 'packages/meriv2-core/tsconfig.json', 'packages/defense-contracts/tsconfig.json', 'packages/defense-domain/tsconfig.json', 'apps/workspace/tsconfig.json']
operand_rows = [{'path': p, 'baseline': baseline.get(p), 'current': current.get(p), 'exact': baseline.get(p) == current.get(p)} for p in manifests + configuration]
api_old = json.loads(git('show', BASELINE + ':apps/api/package.json'))
api_new = json.loads(git('show', CURRENT + ':apps/api/package.json'))
api_delta = {k: {'baseline': api_old.get(k), 'current': api_new.get(k)} for k in set(api_old) | set(api_new) if api_old.get(k) != api_new.get(k)}

client_roots = [
    '/tmp/capirov2-local-native-prerequisite-20261012/core-client',
    '/tmp/capirov2-local-native-prerequisite-20261012/workspace-client',
    '/workspace/capirov2/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma/client',
    '/workspace/capirov2-integrated-rc/apps/api/node_modules/.prisma/client',
    '/tmp/capirov2-cleanup-meri-local-dispatch-conversion/apps/workspace/generated/prisma-client',
    '/workspace/capirov2/apps/workspace/generated/prisma-client',
]
schemas = {p: git('show', CURRENT + ':' + p) for p in ['apps/api/prisma/schema.prisma', 'apps/workspace/prisma/schema.prisma']}
client_rows = []
for root in client_roots:
    row = {'path': root, 'exists': os.path.isdir(root), 'resolved': os.path.realpath(root), 'files': []}
    if row['exists']:
        for relative in ['package.json', 'index.js', 'index.d.ts', 'runtime/library.js', 'schema.prisma', 'libquery_engine-debian-openssl-3.0.x.so.node', 'libquery_engine-linux-arm64-openssl-3.0.x.so.node']:
            file = Path(root) / relative
            if file.is_file():
                item = identity(file)
                item['relativePath'] = relative
                row['files'].append(item)
        row['schemaMatches'] = {p: (Path(root) / 'schema.prisma').read_bytes() == data for p, data in schemas.items()}
    client_rows.append(row)

package_rows = []
for name in ['shared', 'auth', 'meriv2-core', 'defense-contracts', 'defense-domain']:
    root = Path('/workspace/capiro-rich-core-overlay-20261013/@capiro') / name
    paths = [p for p in current if p.startswith('packages/' + name + '/src/')]
    mismatches = []
    for p in paths:
        local = root / p.removeprefix('packages/' + name + '/')
        if not local.is_file():
            mismatches.append(p)
            continue
        data = local.read_bytes()
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if blob != current[p]['blob']:
            mismatches.append(p)
    metadata = json.loads((root / 'package.json').read_bytes())
    canonical = json.loads(git('show', CURRENT + ':packages/' + name + '/package.json'))
    package_rows.append({'name': name, 'root': str(root), 'resolved': os.path.realpath(root), 'sourcePaths': len(paths), 'mismatches': mismatches, 'packageFieldDelta': {k: {'cache': metadata.get(k), 'current': canonical.get(k)} for k in set(metadata) | set(canonical) if metadata.get(k) != canonical.get(k)}, 'main': metadata.get('main'), 'types': metadata.get('types'), 'mainExists': (root / metadata['main']).is_file(), 'typesExist': (root / metadata['types']).is_file()})

shared_root = Path('/tmp/capirov2-cleanup-meri-local-dispatch-conversion/packages/shared')
shared_mismatches = []
for p in [p for p in current if p.startswith('packages/shared/src/')]:
    local = shared_root / p.removeprefix('packages/shared/')
    if not local.is_file():
        shared_mismatches.append(p)
        continue
    data = local.read_bytes()
    if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != current[p]['blob']:
        shared_mismatches.append(p)

missing_base = Path('/workspace/backend-cleanup-recovery-20261012/pe9-real-qualification-457e84e7')
reported = {
    'INSTALL-BUILD-ONLY-RECEIPT.json': 'e998efc8e4778532a13a323ef765ec73289ec999add6020c569d3347a779074b',
    'selected-source.tar': '1ecc2cb85f9b53bcc3b95fdd8fd3065241ee399162ae069ee6ecf63923217774',
    'PROJECTION-BEFORE.json': '82f93cdb138e957c37861a89654732c31f9a5eaa3dbd209614fc7cef41ae2a15',
    'INSTALL-RESULT.json': 'd5bcb64fbb145609e0c8b734d0a129d8430cde7da7d84c57ef035c8b054c79f2',
    'FINAL-API-CHECKS.json': '505f066246e69e38ef178695c1a4e841a5aeab6aa55a804525ac80f71bb9d570',
}
print(json.dumps({
    'schemaVersion': 1, 'current': CURRENT, 'currentTree': git('rev-parse', CURRENT + '^{tree}').decode().strip(),
    'qualifiedInstallReportedBaseline': BASELINE, 'baselineTree': git('rev-parse', BASELINE + '^{tree}').decode().strip(),
    'manifestCount': len(manifests), 'operands': operand_rows, 'apiManifestFieldDelta': api_delta,
    'schemas': [{'path': p, 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()} for p, b in schemas.items()],
    'generatedClients': client_rows, 'overlayPackages': package_rows,
    'currentSharedAlternative': {'root': str(shared_root), 'sourcePaths': 37, 'mismatches': shared_mismatches, 'distPresent': (shared_root / 'dist/index.js').is_file() and (shared_root / 'dist/index.d.ts').is_file()},
    'reportedPeerReceipts': [{'path': str(missing_base / p), 'expectedSha256': digest, 'exists': (missing_base / p).exists(), 'bytesOrHashVerified': False} for p, digest in reported.items()],
    'libraryModulesImported': False, 'clientConstructed': False, 'engineExecuted': False, 'databaseConnected': False,
}, indent=2))
