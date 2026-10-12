from pathlib import Path
import hashlib
import json
import subprocess

base = 'd70bb9724cf06dfee4863037d295942a9624b7ac'
author = 'a96af2e1161def587d4ed9b6b79be7e5ff042c5b'
overlay = 'dced1ff282fffea55376f9cc8eef3e849a0ec782'
review_dir = 'docs/cleanup-migration-canonical-interface-review-20261012/'

def git(*args):
    return subprocess.check_output(['git', *args])

owned = git('diff', '--name-only', base, author).decode().splitlines()
assert len(owned) == 6, owned
changed = git('diff', '--name-only', base, 'HEAD').decode().splitlines()
nonreview = [p for p in changed if not p.startswith(review_dir)]
assert sorted(nonreview) == sorted(owned + ['apps/api/scripts/lint-pe-scripts.ts'])
checks = {}
for filename in owned + ['apps/api/scripts/lint-pe-scripts.ts']:
    parent = overlay if filename == 'apps/api/scripts/lint-pe-scripts.ts' else author
    blob = git('show', parent + ':' + filename)
    assert Path(filename).read_bytes() == blob, filename
    checks[filename] = {
        'owner': parent,
        'gitBlob': git('rev-parse', parent + ':' + filename).decode().strip(),
        'sha256': hashlib.sha256(blob).hexdigest(),
    }
anchors = [
    'apps/api/scripts/entrypoint.sh',
    'apps/api/scripts/entrypoint-legacy.sh',
    'apps/api/scripts/entrypoint-dispatcher.inc',
    'apps/api/scripts/lib/pe-compose-database-url.js',
    'apps/api/scripts/verify-pe-migration-guards.ts',
]
for filename in anchors:
    assert Path(filename).read_bytes() == git('show', base + ':' + filename), filename
schema_migration_changes = [p for p in changed if '/prisma/' in p or '/migrations/' in p]
assert not schema_migration_changes, schema_migration_changes
receipt = {
    'base': base, 'author': author,
    'authorTree': '88a1aea62dbaaf4a8aa82086caa7c9aea511d8d7',
    'rootOverlay': overlay,
    'reviewSourceComposition': git('rev-parse', 'HEAD').decode().strip(),
    'allowedOwnedPaths': checks, 'preservedAnchors': anchors,
    'schemaOrMigrationChanges': schema_migration_changes,
    'entrypointTrioBytesUnchanged': True, 'otherSourceDelta': False,
    'reviewerSourceEdits': False, 'nativeOperations': False,
}
Path(review_dir + 'evidence/source-preservation.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'ownedPathsExact': len(checks), 'entrypointsUnchanged': True,
                 'schemaMigrationChanges': 0, 'otherSourceDelta': False}))
