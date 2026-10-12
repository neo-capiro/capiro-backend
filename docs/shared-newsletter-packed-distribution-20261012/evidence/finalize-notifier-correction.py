import hashlib
import json
import pathlib
import subprocess

p = pathlib.Path(__file__).resolve().parents[1]
old = '23e3d3a68cf57062482e3cc4ca9b53e9cb249796'
original = json.loads((p / 'evidence/PACKED-MANIFEST-INITIAL.json').read_text())
final = json.loads((p / 'PACKED-MANIFEST.json').read_text())
assert original['packedEntries'] == final['packedEntries']
assert original['packs'][0]['sha256'] == final['packs'][0]['sha256']
effective = dict(line.split('=', 1) for line in
                 (p / 'evidence/notifier-disabled-effective-config.log').read_text().splitlines())
assert effective == {'offline': 'true', 'ignore-scripts': 'true', 'update-notifier': 'false'}
notifier = pathlib.Path('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/lib/node_modules/npm/lib/cli/update-notifier.js')
receipt = {
    'preservedInitialPacketHead': old,
    'initialArtifactSha256': original['packs'][0]['sha256'],
    'finalArtifactSha256': final['packs'][0]['sha256'],
    'all182EntryBytesAndModesUnchanged': True,
    'initialPack1ReadOnlyRegistryMetadataGET': 'https://registry.npmjs.org/npm',
    'initialGETLog': 'evidence/npm-original-2026-10-12T22_09_46_397Z-debug-0.log',
    'initialNoHTTPClaimWithdrawn': True,
    'finalPacks': final['packs'],
    'finalDebugLogs': final['debugLogs'],
    'effectiveConfigCommand': ['node', '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/lib/node_modules/npm/bin/npm-cli.js',
        'config', 'get', 'offline', 'ignore-scripts', 'update-notifier', '--offline', '--ignore-scripts', '--no-update-notifier',
        '--userconfig', '/tmp/capiro-shared-newsletter-dist-fe50-20261012/empty-pack-configuration/user.npmrc',
        '--globalconfig', '/tmp/capiro-shared-newsletter-dist-fe50-20261012/empty-pack-configuration/global.npmrc',
        '--cache', '/tmp/capiro-shared-newsletter-dist-fe50-20261012/npm-cache-no-notifier'],
    'effectiveConfigExitCode': 0,
    'effectiveConfig': {'offline': True, 'ignoreScripts': True, 'updateNotifier': False},
    'notifierSource': {'path': str(notifier), 'sha256': hashlib.sha256(notifier.read_bytes()).hexdigest(),
        'disabledGuard': 'Returns resolved null when update-notifier config is false.'},
    'noGeneralNetworkTraceClaim': True,
    'noProductOrArtifactBytesChanged': True,
    'qualificationResultsUnchanged': '16 grouped checks and 116 characterization cases; exact immutable tarball retained.',
}
(p / 'NOTIFIER-CORRECTION.json').write_text(json.dumps(receipt, indent=2) + '\n')
entries = []
for f in sorted(p.rglob('*')):
    if f.is_file() and f.name != 'SHA256-INDEX.json':
        data = f.read_bytes()
        relative = f.relative_to(p.parent.parent).as_posix()
        entries.append({'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
(p / 'SHA256-INDEX.json').write_text(json.dumps({
    'sourceHead': final['sourceHead'], 'sourceTree': final['sourceTree'], 'files': entries,
    'indexExcludesItself': True, 'initialIndexRetained': 'evidence/SHA256-INDEX-INITIAL.json',
}, indent=2) + '\n')
print(json.dumps({'entries': len(entries), 'artifactUnchanged': True,
                  'config': effective, 'finalPackDebugHTTPFetchLines': 0}))
