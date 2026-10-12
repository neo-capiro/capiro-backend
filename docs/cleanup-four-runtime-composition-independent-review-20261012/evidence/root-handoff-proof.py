#!/usr/bin/env python3
"""Snapshot and qualify root-authored draft handoff; no application code execution."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ROOT_WORKTREE = Path('/tmp/capirov2-cleanup-meri-reviewed-runtime-conversion')
SOURCE = 'cb2af6234ba826e5ee8baa6722acaa16ca7ed40d'
TREE = '3f8a39aba38b4eb29fba9f0e1b32b04d519d7218'
PACKET = ROOT_WORKTREE / 'docs/cleanup-meri-runtime-controls-20261012'
EVIDENCE = Path(__file__).resolve().parent
SNAPSHOT = EVIDENCE / 'root-draft-final'
SNAPSHOT.mkdir(exist_ok=True)
checks = []

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def check(name, valid, details=None):
    checks.append({'name': name, 'passed': bool(valid), 'details': details})

snapshots = []
for path in [
    'HANDOFF.md', 'ROOT-RECEIPT.json', 'SOURCE-MANIFEST.json',
    'evidence/final-composed-root-controls.tap',
    'evidence/final-reviewed-registry-profile.json',
    'evidence/final-reviewed-duplicate-profile.json',
    'evidence/final-composed-strategy-time-guard.json',
    'evidence/final-composed-core-cached-typecheck.log',
]:
    raw = (PACKET / path).read_bytes()
    destination = SNAPSHOT / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(raw)
    snapshots.append({'rootDraftPath': str(PACKET / path), 'snapshotPath': str(destination.relative_to(ROOT)),
                      'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})

manifest = json.loads((SNAPSHOT / 'SOURCE-MANIFEST.json').read_bytes())
receipt = json.loads((SNAPSHOT / 'ROOT-RECEIPT.json').read_bytes())
handoff = (SNAPSHOT / 'HANDOFF.md').read_text()
check('root draft source and tree match accepted composition', receipt['source'] == SOURCE and receipt['tree'] == TREE)
check('root manifest binds exact seven Meri and 27 union paths', len(manifest['files']) == 7 and len(manifest['fourRuntimeScopeUnion']) == 27)
for group in ['files', 'fourRuntimeScopeUnion']:
    for row in manifest[group]:
        raw = git('show', f"{SOURCE}:{row['file']}")
        mode_blob = git('ls-tree', SOURCE, '--', row['file']).decode().split('\t')[0]
        check(f"root manifest exact source SHA/mode/blob: {group}/{row['file']}",
              hashlib.sha256(raw).hexdigest() == row['sha256'] and mode_blob == row['git'])
registry = json.loads((SNAPSHOT / 'evidence/final-reviewed-registry-profile.json').read_bytes())
inventory = json.loads((SNAPSHOT / 'evidence/final-reviewed-duplicate-profile.json').read_bytes())
check('root fresh registry evidence is five profiles/2199 source/zero errors', registry == {'errors': [], 'profiles': 5, 'files': 2199})
check('root fresh helper evidence is seven helpers/five profiles/2199 source/zero errors',
      inventory == {'errors': [], 'helpers': 7, 'profiles': 5, 'files': 2199})
tap = (SNAPSHOT / 'evidence/final-composed-root-controls.tap').read_text()
check('root fresh unit raw receipt reports 149 passed and zero failed',
      'ℹ tests 149\n' in tap and 'ℹ pass 149\n' in tap and 'ℹ fail 0\n' in tap)
time_log = (SNAPSHOT / 'evidence/final-composed-strategy-time-guard.json').read_text()
check('root fresh Strategy time guard receipt reports 170 source files', 'passed (170 production files;' in time_log)
check('handoff qualifies unchanged initial Git path count as including documents',
      '21,367 initial Git paths outside that delta' in handoff and 'including the 603 schema/migration paths and 9,697 initial document paths' in handoff,
      {'clarification': '603 uses original schema.prisma or /migrations/ selector; 612 non-doc .sql/.prisma suffix paths independently unchanged'})
check('handoff preserves read-only newsletter plan and frontend ownership boundaries',
      'includes the read-only plan, not the backend restoration' in handoff and
      'source non-equivalence, not proof of deployed asset availability' in handoff)
check('handoff retains narrow source-only and native wider gates',
      'All eleven native/full gaps' in handoff and 'Neither pnpm nor hosted CI was executed' in handoff and
      'does not claim arbitrary flow analysis' in handoff)
core = next(c for c in receipt['checks'] if c['name'] == 'full-composed-core-strict-cached-types')
check('root compiler claim remains explicitly cache-qualified and reported by root',
      core['exitCode'] == 0 and core['unifiedExecSession'] == 56061 and
      'no native PostgreSQL/RLS or engine acceptance' in core['qualification'])
output = {
    'source': SOURCE, 'tree': TREE, 'rootDraftUncommittedAtRead': True,
    'snapshots': snapshots, 'checks': checks, 'passed': all(c['passed'] for c in checks),
    'qualifications': [
        'Draft document snapshot only; final root master checksum/publication verification may be appended separately.',
        'Root fresh commands were not rerun. Full Core compiler exit zero is root-reported in its saved session receipt; its raw log is empty.',
        'Independent proof binds committed source, modes and inherited evidence, not native/runtime/security acceptance.',
        'No application body or unpublished reporting branch was inspected. No Tango semantic self-review was performed.',
    ],
}
print(json.dumps(output, indent=2))
raise SystemExit(0 if output['passed'] else 1)
