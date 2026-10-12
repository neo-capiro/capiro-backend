#!/usr/bin/env python3
"""Read-only committed publication/master continuity proof; no app code execution."""
import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PUBLICATION = 'bcad60272fa300383f117f3a08a554e9e070e85b'
PUBLICATION_TREE = 'ffba314bf5fceda49e8178c4813bd69b3d97cd60'
SOURCE = 'cb2af6234ba826e5ee8baa6722acaa16ca7ed40d'
ACCEPTANCE = '6b7e2e89f43258e08c63ed6164f0d54a840563a7'
WORKSPACE_PRIOR_ACCEPTED = '74d04937d4453813d15ec957a76337c73b712899'
REVIEW_DIR = 'docs/cleanup-four-runtime-composition-independent-review-20261012'
ROOT_DIR = 'docs/cleanup-meri-runtime-controls-20261012'
MASTER = ROOT_DIR + '/SHA256SUMS.json'
checks = []

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def blob(ref, path):
    return git('show', f'{ref}:{path}')

def document(ref, path):
    return json.loads(blob(ref, path))

def check(name, valid, detail=None):
    checks.append({'name': name, 'passed': bool(valid), 'detail': detail})

def tree(ref):
    return {row.split(b'\t', 1)[1].decode(): row.split(b'\t', 1)[0].decode()
            for row in git('ls-tree', '-rz', ref).split(b'\0') if row}

source_tree = tree(SOURCE)
publication_tree = tree(PUBLICATION)
check('exact published tree', git('rev-parse', f'{PUBLICATION}^{{tree}}').decode().strip() == PUBLICATION_TREE)
for name, ref in [('accepted source', SOURCE), ('independent6b acceptance', ACCEPTANCE)]:
    check(f'actual published ancestry: {name}',
          subprocess.run(['git', 'merge-base', '--is-ancestor', ref, PUBLICATION], cwd=ROOT).returncode == 0, ref)
source_delta = sorted(p for p in set(source_tree) | set(publication_tree)
                      if not p.startswith('docs/') and source_tree.get(p) != publication_tree.get(p))
check('all non-document publication source exact to accepted cb2', not source_delta, source_delta)
union = document(ACCEPTANCE, REVIEW_DIR + '/evidence/root-draft-final/SOURCE-MANIFEST.json')['fourRuntimeScopeUnion']
union_rows = []
for row in union:
    raw = blob(PUBLICATION, row['file'])
    valid = publication_tree[row['file']] == source_tree[row['file']] == row['git'] and hashlib.sha256(raw).hexdigest() == row['sha256']
    union_rows.append({'path': row['file'], 'git': publication_tree[row['file']], 'sha256': row['sha256'], 'passed': valid})
check('all27 accepted source union blobs/modes/SHA256 exact', len(union_rows) == 27 and all(r['passed'] for r in union_rows), union_rows)

master = document(PUBLICATION, MASTER)
master_rows = []
for path, expected in master.items():
    raw = blob(PUBLICATION, path)
    actual = hashlib.sha256(raw).hexdigest()
    master_rows.append({'path': path, 'sha256': actual, 'expected': expected, 'passed': actual == expected})
check('all157 committed master hashes verify', len(master_rows) == 157 and all(r['passed'] for r in master_rows))
coverage = dict(Counter(p.split('/')[1] for p in master))
expected_coverage = {
    'cleanup-meri-runtime-controls-20261012': 18,
    'cleanup-meri-local-dispatch-conversion-20261012': 40,
    'cleanup-meri-local-dispatch-independent-review-20261012': 32,
    'cleanup-four-runtime-composition-independent-review-20261012': 32,
    'cleanup-newsletter-two-contract-preservation-plan-20261012': 35,
}
check('master exact five-packet18/40/32/32/35 coverage', coverage == expected_coverage, coverage)
packet_paths = {p for p in publication_tree if p.startswith('docs/') and p.split('/')[1] in expected_coverage and p != MASTER}
check('master covers every committed file of its five packet directories except itself', set(master) == packet_paths,
      {'indexed': len(master), 'packetFilesExcludingMaster': len(packet_paths)})
prior_proof = document(ACCEPTANCE, REVIEW_DIR + '/evidence/composition-proof.final.json')
old_indices = []
entry_count = 0
for manifest in prior_proof['manifests']:
    path = manifest['path']
    manifest_exact = publication_tree[path] == source_tree[path]
    checked = []
    for entry in manifest['entries']:
        p = entry['path']
        current_raw = blob(PUBLICATION, p)
        current_exact = publication_tree[p] == source_tree[p]
        binding = entry['binding']
        if binding == 'current composition':
            raw = current_raw
            frozen_ref = PUBLICATION
        else:
            # The only historical evolving root snapshot is the accepted Workspace
            # data/CI. Its exact hash is retained, while published union is separately proved.
            raw = blob(WORKSPACE_PRIOR_ACCEPTED, p)
            frozen_ref = WORKSPACE_PRIOR_ACCEPTED
        valid = current_exact and hashlib.sha256(raw).hexdigest() == entry['sha256']
        checked.append({'path': p, 'binding': frozen_ref, 'currentBlobExactCb2': current_exact, 'passed': valid})
    entry_count += len(checked)
    old_indices.append({'path': path, 'manifestBlobExact': manifest_exact, 'count': len(checked), 'entries': checked})
check('all16 inherited manifests and713 entries retain accepted bindings',
      len(old_indices) == 16 and entry_count == 713 and
      all(m['manifestBlobExact'] and all(r['passed'] for r in m['entries']) for m in old_indices))
masters = {m['path']: m['count'] for m in old_indices if m['path'].endswith('/SHA256SUMS.json')}
check('previous126/96/103 masters exact', masters == {
    'docs/cleanup-four-runtime-controls-20261012/SHA256SUMS.json': 126,
    'docs/cleanup-strategy-runtime-controls-20261012/SHA256SUMS.json': 96,
    'docs/cleanup-workspace-runtime-controls-20261012/SHA256SUMS.json': 103,
}, masters)

snapshot = REVIEW_DIR + '/evidence/root-draft-final'
handoff_before = blob(ACCEPTANCE, snapshot + '/HANDOFF.md').decode()
handoff_after = blob(PUBLICATION, ROOT_DIR + '/HANDOFF.md').decode()
paragraphs = [p for p in handoff_after.split('\n\n') if p.startswith('Composition-only independent acceptance is ')]
paragraph = paragraphs[0] if len(paragraphs) == 1 else ''
check('handoff adds only precise6b composition-review paragraph',
      len(paragraphs) == 1 and handoff_after.replace(paragraph + '\n\n', '', 1) == handoff_before and
      ACCEPTANCE in paragraph and SOURCE in paragraph and '713 entries in 16 inherited indices' in paragraph and
      'full composed typecheck is explicitly root-reported' in paragraph, paragraph)
manifest_before = document(ACCEPTANCE, snapshot + '/SOURCE-MANIFEST.json')
manifest_after = document(PUBLICATION, ROOT_DIR + '/SOURCE-MANIFEST.json')
expected_review_keys = {
    'independentCompositionReview': ACCEPTANCE,
    'independentCompositionAcceptedSource': SOURCE,
    'independentCompositionSourceChecks': 59,
    'independentDraftHandoffChecks': 44,
    'inheritedIndicesVerified': 16,
    'inheritedChecksumEntriesVerified': 713,
}
added = {k:v for k,v in manifest_after.items() if k not in manifest_before}
check('source manifest retains all accepted fields and adds only six exact review keys',
      added == expected_review_keys and all(manifest_after.get(k) == v for k,v in manifest_before.items()), added)
check('root receipt unchanged from accepted draft snapshot',
      blob(PUBLICATION, ROOT_DIR + '/ROOT-RECEIPT.json') == blob(ACCEPTANCE, snapshot + '/ROOT-RECEIPT.json'))
review_paths = [p for p in tree(ACCEPTANCE) if p.startswith(REVIEW_DIR + '/')]
check('all32 original6b composition review files/modes unchanged',
      len(review_paths) == 32 and all(publication_tree[p] == tree(ACCEPTANCE)[p] for p in review_paths))

out = {
    'publishedHead': PUBLICATION, 'publishedTree': PUBLICATION_TREE,
    'publishedDraft': 'https://github.com/neo-capiro/capirov2/pull/2422',
    'acceptedSource': SOURCE, 'preservedIndependentAcceptance': ACCEPTANCE,
    'checks': checks, 'passed': all(c['passed'] for c in checks),
    'masterIndex': MASTER, 'masterRows': master_rows,
    'inheritedManifestRows': old_indices,
    'scope': 'Committed Git publication/source/evidence continuity only; no app rechecks or application semantic review',
    'qualification': 'Published head is the exact parent-supplied PR pin. No remote API refresh, main update, native/provider/DB/migration/closeout execution, published branch mutation or new acceptance claim.',
}
print(json.dumps(out, indent=2))
raise SystemExit(0 if out['passed'] else 1)
