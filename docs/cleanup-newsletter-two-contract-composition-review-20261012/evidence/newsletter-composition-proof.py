#!/usr/bin/env python3
"""Inert Git metadata/blob/checksum and handoff composition audit, no app imports."""
import hashlib
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HEAD = '52b58cbe363895cfc85220cbe53e8c50a40bd659'
TREE = '1fd341896130d85be7996dc21753862d782e1a3b'
FROZEN = 'a247f7a02a9b94d95e9ee5a516b396202aea994b'
FROZEN_TREE = 'b87c85a0fc0ae57f876b86a8018a953adbddb71c'
BASE = 'bcad60272fa300383f117f3a08a554e9e070e85b'
AUTHOR = '509e560e1d3b528ff84b63915f235a8a124febcc'
AUTH_REVIEW = '6713a190fdb5b9a8495d9cd1ada80d80ab6fe1f1'
SCHEMA_REVIEW = '82f3f6067cb468c6afb4ec710cd9cc08a592aacf'
CONTINUITY = '675a6341920fea2f87cf5c556d2e682401bc8e73'
C = '1e99f0921b207318c6d2abf03927b5c4daa5768b'
W = '193703e34f2bedbb69d87d6a8ee303f65ab8dbda'
PACKET = 'docs/cleanup-newsletter-two-contract-reviewed-source-20261012'
PRIOR_PACKET = 'docs/cleanup-four-runtime-composition-independent-review-20261012'
checks = []

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def blob(ref, path):
    return git('show', f'{ref}:{path}')

def doc(ref, path):
    return json.loads(blob(ref, path))

def tree(ref):
    return {row.split(b'\t', 1)[1].decode(): row.split(b'\t', 1)[0].decode()
            for row in git('ls-tree', '-rz', ref).split(b'\0') if row}

def check(name, valid, detail=None):
    checks.append({'name': name, 'passed': bool(valid), 'detail': detail})

current, frozen, baseline = tree(HEAD), tree(FROZEN), tree(BASE)
check('exact final root head/tree', git('rev-parse', f'{HEAD}^{{tree}}').decode().strip() == TREE)
check('exact independently accepted source tree', git('rev-parse', f'{FROZEN}^{{tree}}').decode().strip() == FROZEN_TREE)
refs = {'frozenSource': FROZEN, 'finalAuthor': AUTHOR, 'authorizationReview': AUTH_REVIEW,
        'schemaDependencyReview': SCHEMA_REVIEW, 'publishedPR2422': BASE,
        'publicationContinuity': CONTINUITY,
        'composition6b': '6b7e2e89f43258e08c63ed6164f0d54a840563a7',
        'publishedTango': '09c5fdfb6bbea268195d3fbe15c9070c9efd3fbc',
        'publishedStrategy': '83ac1bddeefca2e75f913abbd04e3cb5e0b98f9d',
        'publishedWorkspace': '674a856d7fee69cd133cf358f9262ed42300388f'}
ancestry = {k:{'head':v, 'ancestor': subprocess.run(['git', 'merge-base', '--is-ancestor', v, HEAD], cwd=ROOT).returncode == 0}
            for k,v in refs.items()}
check('all accepted/source/review/publication heads are actual ancestors', all(r['ancestor'] for r in ancestry.values()), ancestry)
drift = [p for p in set(current) | set(frozen) if not p.startswith('docs/') and current.get(p) != frozen.get(p)]
check('zero non-document drift from frozen a247', not drift, sorted(drift))
manifest = doc(HEAD, PACKET + '/SOURCE-MANIFEST.json')
rows = manifest['sourceFiles']
overlay = sorted(p for p in set(current) | set(baseline) if not p.startswith('docs/') and current.get(p) != baseline.get(p))
check('exact76-path source overlay and no other source changes', len(rows) == 76 and sorted(r['file'] for r in rows) == overlay, overlay)
row_results = []
for row in rows:
    raw = blob(HEAD, row['file'])
    valid = current[row['file']] == frozen[row['file']] == row['git'] and hashlib.sha256(raw).hexdigest() == row['sha256']
    row_results.append({'path':row['file'], 'git':current[row['file']], 'sha256':row['sha256'], 'passed':valid})
check('all76 source blob/mode/SHA bindings exact', all(r['passed'] for r in row_results))
added = [p for p in overlay if p not in baseline]
modified = [p for p in overlay if p in baseline]
check('58 original files plus18 declared existing-owner integrations', len(added) == 58 and len(modified) == 18)
c_tree, w_tree = tree(C), tree(W)
check('all58 restored file blobs/modes exactly match original C and W',
      all(current[p] == c_tree.get(p) == w_tree.get(p) for p in added), added)
outside = [p for p in baseline if p not in overlay]
old_docs = [p for p in baseline if p.startswith('docs/')]
check('21862 baseline paths outside overlay exact, including documents',
      len(outside) == 21862 and all(current.get(p) == baseline[p] for p in outside), {'count':len(outside)})
check('10183 baseline documentation paths exact', len(old_docs) == 10183 and all(current.get(p) == baseline[p] for p in old_docs), {'count':len(old_docs)})
schemas = [p for p in baseline if re.search(r'(?:schema\.prisma$|/migrations/)', p)]
schema_changes = sorted(p for p in schemas if current.get(p) != baseline[p])
check('601 of603 baseline schema/migration paths unchanged; only two schema owners change',
      len(schemas) == 603 and len(schemas) - len(schema_changes) == 601 and
      schema_changes == ['apps/api/prisma/schema.prisma', 'apps/workspace/prisma/schema.prisma'], schema_changes)
sql_additions = [p for p in added if '/migrations/' in p and p.endswith('/migration.sql')]
check('14 exact original historical SQL sources added without execution',
      len(sql_additions) == 14 and all(current[p] == c_tree[p] == w_tree[p] for p in sql_additions), sql_additions)
check('frontend and protected reporting source outside declared overlay unchanged by metadata only',
      all(not p.startswith('apps/web/') and not p.endswith('/engagement.service.ts') for p in overlay))

manifest_rows = []
def verify_rows(name, index_path, entries, expected_count, frozen_ref=None):
    checked = []
    for entry in entries:
        path = entry['path']
        raw = blob(HEAD, path)
        binding = HEAD
        if entry.get('binding') and entry['binding'] != 'current composition':
            binding = '74d04937d4453813d15ec957a76337c73b712899'
            raw = blob(binding, path)
        actual = hashlib.sha256(raw).hexdigest()
        valid = actual == entry['sha256'] and ('bytes' not in entry or entry['bytes'] == len(raw))
        if 'sourceBlob' in entry:
            valid = valid and current[path].split()[-1] == entry['sourceBlob']
        if frozen_ref:
            valid = valid and current[path] == tree_cache[frozen_ref][path]
        checked.append({'path':path, 'binding':binding, 'sha256':actual, 'passed':valid})
    check(name, len(checked) == expected_count and all(r['passed'] for r in checked))
    manifest_rows.append({'path':index_path, 'count':len(checked), 'entries':checked})

tree_cache = {AUTHOR:tree(AUTHOR), AUTH_REVIEW:tree(AUTH_REVIEW), SCHEMA_REVIEW:tree(SCHEMA_REVIEW)}
master = doc(HEAD, PACKET + '/SHA256SUMS.json')
verify_rows('263 final root master hashes verify', PACKET + '/SHA256SUMS.json',
            [{'path':p,'sha256':h} for p,h in master.items()], 263)
coverage = dict(Counter(p.split('/')[1] for p in master))
expected_coverage = {
    'cleanup-four-runtime-composition-independent-review-20261012':38,
    'cleanup-newsletter-two-contract-independent-review-20261012':47,
    'cleanup-newsletter-two-contract-preservation-plan-20261012':35,
    'cleanup-newsletter-two-contract-reviewed-source-20261012':11,
    'cleanup-newsletter-two-contract-schema-dependency-review-20261012':76,
    'cleanup-newsletter-two-contract-source-preservation-20261012':56,
}
check('root master exact six-packet coverage excludes itself only',
      coverage == expected_coverage and set(master) == {p for p in current if p.startswith('docs/') and p.split('/')[1] in expected_coverage and p != PACKET + '/SHA256SUMS.json'}, coverage)
prior_master_path = 'docs/cleanup-meri-runtime-controls-20261012/SHA256SUMS.json'
prior_master = doc(HEAD, prior_master_path)
check('PR2422 master file unchanged from published base', current[prior_master_path] == baseline[prior_master_path])
verify_rows('all157 inherited PR2422 master hashes verify', prior_master_path,
            [{'path':p,'sha256':h} for p,h in prior_master.items()], 157)
prior = doc(HEAD, PRIOR_PACKET + '/evidence/composition-proof.final.json')
for m in prior['manifests']:
    check('inherited manifest file exact: ' + m['path'], current[m['path']] == baseline[m['path']])
    verify_rows('inherited index verifies: ' + m['path'], m['path'], m['entries'], m['count'])
check('16 inherited indices retain713 entries and126/96/103 masters',
      len(prior['manifests']) == 16 and sum(m['count'] for m in prior['manifests']) == 713 and
      [m['count'] for m in prior['manifests'] if m['path'].endswith('/SHA256SUMS.json')] == [126,96,103])
author_path = 'docs/cleanup-newsletter-two-contract-source-preservation-20261012/SHA256-INDEX.json'
author_index = doc(HEAD, author_path)
check('author131 index binds same independently accepted source',
      author_index['sourceHead'] == FROZEN and author_index['sourceTree'] == FROZEN_TREE)
verify_rows('all131 final author packet/source entries verify', author_path,
            author_index['packet'] + author_index['source'], 131, AUTHOR)
schema_path = 'docs/cleanup-newsletter-two-contract-schema-dependency-review-20261012/SHA256.json'
schema_index = doc(HEAD, schema_path)
verify_rows('all75 independent schema/dependency evidence hashes verify', schema_path,
            [{'path':p,'sha256':h} for p,h in schema_index.items()], 75, SCHEMA_REVIEW)
auth_path = 'docs/cleanup-newsletter-two-contract-independent-review-20261012/SHA256.json'
auth_index = doc(HEAD, auth_path)
verify_rows('all46 independent authorization/replay evidence hashes verify', auth_path,
            auth_index['entries'], 46, AUTH_REVIEW)

schema_receipt = doc(HEAD, 'docs/cleanup-newsletter-two-contract-schema-dependency-review-20261012/RECEIPT.json')
auth_receipt = doc(HEAD, 'docs/cleanup-newsletter-two-contract-independent-review-20261012/ACCEPTANCE.json')
check('both independent receipts accept exact same a247 source/tree',
      schema_receipt['sourceHead'] == auth_receipt['source'] == FROZEN and
      schema_receipt['sourceTree'] == auth_receipt['tree'] == FROZEN_TREE)
handoff = blob(HEAD, PACKET + '/HANDOFF.md').decode()
handoff_checks = {
    'distinct rich stage and saved version contracts without bridge':
        'legacy stage UUID never satisfies `versionId`' in handoff and
        'no discriminator, redirect, alias, association table, automatic migration or UUID conversion' in handoff,
    'Q existing-session staging does not send/generate/new session':
        'Staging does not send, generate content or create a replacement session' in handoff,
    'exact parser8 and six Workspace diagnostics explicitly unqualified':
        '`htmlparser2@8.0.2`' in handoff and 'leaving six diagnostics' in handoff and
        'full Workspace/parser/native acceptance open' in handoff and
        manifest['workspaceRemainingDiagnostics'] == 6 and manifest['workspaceSourceTypecheckExitCode'] == 2 and
        schema_receipt['workspaceTyping']['fullTypingAccepted'] is False and
        auth_receipt['workspaceParserAndFullTypingAccepted'] is False,
    'frozenfrontend4a no43 runtime/179 asset port or deployed serving claim':
        '4a1614886fd98bb42d529f1ef59b3d01d7ff9173' in handoff and
        'Forty-three original runtime paths and 179 static asset blobs' in handoff and
        'No frontend port' in handoff and 'not a claim about deployed asset serving' in handoff,
    'protected unpublished reporting ownership remains excluded':
        'task01a12dc9-21a3-7062-908e-b6fabc37c027' in handoff and
        'No reporting body, branch or source was changed or claimed lost' in handoff,
    'GET/provider/worker paths not described as universally read-only':
        'These paths are not universally read-only' in handoff and 'without actual GETs, worker/provider constructors' in handoff,
    'source/native/full gates and synthetic concurrency limits explicit':
        'not native MVCC' in handoff and 'All eleven native/full gaps' in handoff and
        'no operational acceptance follows from these metadata checks' in handoff,
}
for name, valid in handoff_checks.items():
    check('handoff: ' + name, valid)
check('manifest mirrors precise source/schema/docs overlay counts',
      manifest['restoredOriginalFiles'] == 58 and manifest['additiveExistingSourceFiles'] == 18 and
      manifest['baselinePathsOutsideOverlayExactIncludingDocuments'] == 21862 and
      manifest['baselineDocumentsExact'] == 10183 and manifest['unchangedBaselineSchemaMigrationPaths'] == 601 and
      manifest['additiveSchemaOwners'] == 2 and manifest['exactHistoricalMigrationSourcesAdded'] == 14)
check('manifest retains source-only limits', manifest['databaseOrMigrationExecution'] is False and manifest['frontendFilesChanged'] is False)
output = {
    'source':HEAD,'tree':TREE,'frozenSource':FROZEN,'publishedBase':BASE,
    'checks':checks,'sourceRows':row_results,'manifests':manifest_rows,
    'passed':all(c['passed'] for c in checks),
    'scope':'Metadata/composition only; no semantic or additive-schema-body re-review. Accepted additive classification delegates to independent schema/dependency receipt.',
    'applicationBodiesInspected':False,'sqlBodiesInspected':False,'unpublishedReportingBranchesInspected':False,
    'applicationOrNativeProviderDatabaseGeneratorCloseoutExecution':False,
}
print(json.dumps(output,indent=2))
raise SystemExit(0 if output['passed'] else 1)
