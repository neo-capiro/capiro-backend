import hashlib
import json
import subprocess
from pathlib import Path

SOURCE = '4104f49f6ebfdbf00ad1706079ba340bd9b566c8'
TREE = '257856362ba9075b25bee52debf3efa35f3dfb77'
REVIEWED = '721bfd4825bfccd819be50172ed712023891f978'
OUT = Path('docs/cleanup-next-registry-control-wiring-review-20261012')

def git(*args):
    return subprocess.check_output(['git', *args])

assert git('rev-parse', SOURCE + '^{tree}').decode().strip() == TREE
changed = git('diff', '--name-only', REVIEWED, SOURCE).decode().splitlines()
assert changed == ['scripts/check-registry-ownership.mjs', 'scripts/check-registry-ownership.test.mjs']
paths = [
    'scripts/registry-ownership.json',
    'package.json',
    '.github/workflows/ci-pr.yml',
    'apps/api-strategy/src/context/frontmatter.ts',
    'apps/api-strategy/src/context/context-import.service.ts',
    'apps/api-strategy/src/context/context-documents.service.ts',
    'apps/api-strategy/src/context/steward.service.ts',
]
blobs = []
for path in paths:
    previous = git('show', REVIEWED + ':' + path)
    current = git('show', SOURCE + ':' + path)
    assert previous == current
    blobs.append({'path': path, 'blob': git('rev-parse', SOURCE + ':' + path).decode().strip(),
                  'sha256': hashlib.sha256(current).hexdigest(), 'exactReviewedBytes': True})

old_checksums = json.loads((OUT / 'SHA256.json').read_text())
for path, digest in old_checksums.items():
    assert hashlib.sha256((OUT / path).read_bytes()).hexdigest() == digest
previous = json.loads((OUT / 'ACCEPTANCE-721.json').read_text())
result = {
    'acceptedScopedSource': SOURCE,
    'acceptedTree': TREE,
    'carriedScopedReviewSource': REVIEWED,
    'onlyChangesSinceScopedReview': changed,
    'threeDataPackageCiBlobsAndFourActualOwnerConsumerFiles': blobs,
    'unchangedWholePriorBaselineProtectionCarriedByExactTwoPathDiff': previous['protectedBaseline'],
    'runtimeRoles': 4,
    'runtimeConsumerServices': 3,
    'directNamedExportConstDeclarations': 2,
    'originalChecksumEntriesVerifiedUnchanged': len(old_checksums),
    'genericGuardGrammarAcceptance': False,
    'applicationSourceExecuted': False,
    'ciOrPackageManagerExecuted': False,
    'nativeAcceptance': False,
}
(OUT / 'evidence' / 'carry-4104.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
