#!/usr/bin/env python3
"""Inert Git tree/blob and committed evidence verification. No app module execution."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HEAD = 'cb2af6234ba826e5ee8baa6722acaa16ca7ed40d'
TREE = '3f8a39aba38b4eb29fba9f0e1b32b04d519d7218'
BASE = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa'
GENERIC = '8f48604aa1cefdb3e420026633ce8e1f2ca95953'
refs = {
    'publishedTango': '09c5fdfb6bbea268195d3fbe15c9070c9efd3fbc',
    'publishedStrategy': '83ac1bddeefca2e75f913abbd04e3cb5e0b98f9d',
    'publishedWorkspace': '674a856d7fee69cd133cf358f9262ed42300388f',
    'TangoApplication': '6d243a1393b8736544e1d216cf2bd141595dd315',
    'TangoAcceptedIntegration': '34bd52b6f49393f49732cf1f918002ba0893574d',
    'TangoReview': '0bf68187d937a234db3ea8568aa9815aade5c5de',
    'StrategyApplication': '8834c1d76659b343fb37c60733fa1dd618a06db9',
    'StrategyAcceptedIntegration': 'ffb6660b517f554aa8702eb23b16c2b0389399e8',
    'StrategyReview': 'c51e57613fe7c3545acfc227e44aa0a1d2e95a78',
    'WorkspaceApplication': '77e936d2a695203819b7d46277bf63ab6a659539',
    'WorkspaceAcceptedIntegration': '74d04937d4453813d15ec957a76337c73b712899',
    'WorkspaceApplicationReview': '55414fc4f44c0d2e05897a3e9a8d6d32e4889109',
    'WorkspaceRootReview': '9ac33779feb7668bec885b8d359dbd90d2b15764',
    'WorkspaceWhitespaceReceipt': '50a6ec7105462ccdbe1c867b1b291a1318022440',
    'MeriApplication': 'eef2ee4b92aa6a16ae10225c3414794d5fb52a93',
    'MeriAcceptedIntegration': '7ea444c74a5637577aa0eb3cb99cb420b5f8223e',
    'MeriAuthorPacket': 'd3e0efacf59fb64361c612c01da5ae8a6f19e426',
    'MeriReview': 'c77c601f74750a165582ae157d1e1dc9ecea1d14',
    'GenericControls': GENERIC,
    'GenericIndependentReview': '4763e4c8c357c732a739e9a84f4d95abf2ccfab2',
    'NewsletterPlan': '6d89253b4db7c2a1d792a9ff5605c61a84c6300a',
}
app_paths = {
    'Tango': [f'apps/api/src/external/tango/{x}' for x in [
        'tango-dibbs.client.ts', 'tango-sbir.client.ts', 'tango-subaward.client.ts',
        'tango-rest-page.ts', 'tango-rest-page.spec.ts']],
    'Strategy': [f'apps/api-strategy/src/{x}' for x in [
        'context/frontmatter.spec.ts', 'context/frontmatter.ts',
        'context/template-registry.spec.ts', 'context/template-registry.ts',
        'reports/report-context.spec.ts', 'reports/report-context.ts']],
    'Workspace': [f'apps/workspace/{x}' for x in [
        'src/cascade/cascade.config.ts', 'src/cascade/workspace-product.registry.ts',
        'test/fixtures/product-registry-before.json',
        'test/product-registry-characterization.spec.ts']],
    'Meri': [f'apps/api/src/meri/{x}' for x in [
        'meri-local-dispatch.equivalence.spec.ts', 'meri-local-dispatch.ts',
        'meri-tools.service.ts']],
}
root_paths = [
    '.github/workflows/ci-pr.yml', 'package.json',
    'scripts/check-duplicate-helpers.mjs', 'scripts/check-duplicate-helpers.test.mjs',
    'scripts/check-registry-ownership.mjs', 'scripts/check-registry-ownership.test.mjs',
    'scripts/cleanup-runtime-equivalence.jest.cjs',
    'scripts/duplicate-helper-names.txt', 'scripts/registry-ownership.json',
]
evolving = {root_paths[0], root_paths[1], root_paths[-2], root_paths[-1]}
results = {'source': HEAD, 'tree': TREE, 'base': BASE, 'checks': [], 'errors': []}

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def blob(ref, path):
    return git('show', f'{ref}:{path}')

def document(ref, path):
    return json.loads(blob(ref, path))

def check(name, valid, detail=None):
    results['checks'].append({'name': name, 'passed': bool(valid), 'detail': detail})
    if not valid:
        results['errors'].append(name)

def tree(ref):
    rows = {}
    for row in git('ls-tree', '-rz', ref).split(b'\0'):
        if not row:
            continue
        meta, path = row.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        rows[path.decode()] = {'mode': mode, 'kind': kind, 'blob': oid}
    return rows

current = tree(HEAD)
base = tree(BASE)
check('exact source tree', git('rev-parse', f'{HEAD}^{{tree}}').decode().strip() == TREE)
ancestry = {}
for name, ref in refs.items():
    ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', ref, HEAD], cwd=ROOT).returncode == 0
    ancestry[name] = {'head': ref, 'ancestor': ancestor}
check('all published, accepted, review and plan refs are actual ancestors',
      all(row['ancestor'] for row in ancestry.values()), ancestry)

all_apps = sum(app_paths.values(), [])
all_changed = sorted(p for p in set(base) | set(current) if base.get(p) != current.get(p))
source_delta = [p for p in all_changed if not p.startswith('docs/')]
check('exact 27-path non-doc union', source_delta == sorted(all_apps + root_paths),
      {'applicationCount': len(all_apps), 'rootCount': len(root_paths), 'paths': source_delta})
app_blobs = {}
for name, paths in app_paths.items():
    application = tree(refs[f'{name}Application'])
    accepted = tree(refs[f'{name}AcceptedIntegration'])
    rows = [{ 'path': p, 'current': current[p], 'application': application.get(p), 'accepted': accepted.get(p) } for p in paths]
    app_blobs[name] = rows
    check(f'{name} complete accepted app blob/mode identity',
          all(r['current'] == r['application'] == r['accepted'] for r in rows), rows)
generic_tree = tree(GENERIC)
check('five generic guard/test/runner blobs unchanged from accepted 8f',
      all(current[p] == generic_tree[p] for p in root_paths if p not in evolving),
      {p: current[p] for p in root_paths if p not in evolving})
prior = tree(refs['publishedWorkspace'])
last_delta = sorted(p for p in set(prior) | set(current)
                    if prior.get(p) != current.get(p) and not p.startswith('docs/'))
check('exact seven-path final Meri delta', last_delta == sorted(app_paths['Meri'] + list(evolving)), last_delta)

schemas = [p for p in base if re.search(r'(?:schema\.prisma$|/migrations/)', p)]
broad_sql_prisma = [p for p in base if not p.startswith('docs/') and p.endswith(('.sql', '.prisma'))]
old_docs = [p for p in base if p.startswith('docs/')]
check('603 prior schema/migration blobs and modes unchanged', len(schemas) == 603 and all(base[p] == current.get(p) for p in schemas), {'count': len(schemas)})
check('broader 612 non-doc SQL/Prisma suffix paths also unchanged', len(broad_sql_prisma) == 612 and all(base[p] == current.get(p) for p in broad_sql_prisma), {'count': len(broad_sql_prisma)})
check('9697 baseline docs blobs and modes unchanged', len(old_docs) == 9697 and all(base[p] == current.get(p) for p in old_docs), {'count': len(old_docs)})
check('all other prior Git paths unchanged without reading application bodies',
      all(base[p] == current.get(p) for p in base if p not in source_delta),
      {'baselinePaths': len(base), 'allowedChangedPriorPaths': sum(p in base for p in source_delta)})
check('21367 unchanged initial Git paths include baseline documents',
      sum(base[p] == current.get(p) for p in base) == 21367,
      {'unchangedTotal': sum(base[p] == current.get(p) for p in base), 'includesDocumentCount': len(old_docs)})

plan = refs['NewsletterPlan']
plan_base = git('rev-parse', '18d4e32e8d273e40ceb7738a9e9bd1cd0c5cb45a^').decode().strip()
pt = tree(plan)
pbt = tree(plan_base)
plan_delta = [p for p in set(pt) | set(pbt) if pt.get(p) != pbt.get(p)]
check('35-path read-only newsletter plan retained exactly, zero source delta',
      len(plan_delta) == 35 and all(p.startswith('docs/') and current.get(p) == pt.get(p) for p in plan_delta),
      {'base': plan_base, 'plan': plan, 'count': len(plan_delta), 'sourceDelta': sum(not p.startswith('docs/') for p in plan_delta)})

data_path = 'scripts/registry-ownership.json'
config = document(HEAD, data_path)
profiles = config['profiles']
sources = {
    'strategy-context-template-metadata': refs['StrategyAcceptedIntegration'],
    'tango-rest-page-leaves': GENERIC,
    'workspace-product-descriptors': refs['WorkspaceAcceptedIntegration'],
    'workspace-existing-product-facade': refs['WorkspaceAcceptedIntegration'],
    'meri-local-core-dispatch': refs['MeriAcceptedIntegration'],
}
check('five exact profiles in accepted union order', [p['id'] for p in profiles] == list(sources), [p['id'] for p in profiles])
profile_rows = []
for profile in profiles:
    accepted = next(p for p in document(sources[profile['id']], data_path)['profiles'] if p['id'] == profile['id'])
    check(f"exact accepted profile values, aliases, carrier digests and call references: {profile['id']}", profile == accepted)
    profile_rows.append({'id': profile['id'], 'source': sources[profile['id']], 'symbols': len(profile['symbols']),
                         'edges': len(profile['edges']), 'carriers': len(profile['carriers']), 'aliases': len(profile.get('aliases', []))})
check('registry config envelope unchanged',
      {k:v for k,v in config.items() if k != 'profiles'} == {k:v for k,v in document(GENERIC, data_path).items() if k != 'profiles'})
results['profiles'] = profile_rows
runtime = re.compile(r'\.(?:ts|tsx|mts|cts)$')
excluded = re.compile(r'(?:\.(?:spec|test)\.[cm]?tsx?$|\.d\.[cm]?ts$)')
roots = set(r for p in profiles for r in p['roots'])
runtime_paths = [p for p in current if runtime.search(p) and not excluded.search(p) and any(p.startswith(r + '/') for r in roots)]
check('five-profile source discovery union has 2199 tracked runtime files', len(runtime_paths) == 2199, {'count': len(runtime_paths), 'roots': sorted(roots)})
strategy_runtime = [p for p in runtime_paths if p.startswith('apps/api-strategy/src/')]
time_data = 'scripts/strategy-time-boundaries.json'
time_config = document(HEAD, time_data)
time_source_paths = set(strategy_runtime) | set(time_config['extraSourceFiles'])
check('Strategy time discovery source count is 170 without repeating its guard',
      len(time_source_paths) == 170,
      {'count': len(time_source_paths), 'strategyRootRuntime': len(strategy_runtime), 'extraCanonicalSource': time_config['extraSourceFiles']})
check('Strategy time allowance data and guard implementation unchanged from original composition',
      all(base[p] == current[p] for p in [time_data, 'scripts/check-strategy-time-bypasses.mjs', 'scripts/check-strategy-time-bypasses.test.mjs']))
inventory_path = 'scripts/duplicate-helper-names.txt'
inventory = blob(HEAD, inventory_path).decode()
rows = [x for x in inventory.splitlines() if x and not x.startswith('#')]
expected_rows = [f"{p['id']}\t{s['name']}" for p in profiles for s in p['symbols'] if s['kind'] == 'function']
check('seven owned helper inventory rows exactly cover profile functions', len(rows) == 7 and len(set(rows)) == 7 and set(rows) == set(expected_rows), rows)
check('Meri inventory addition preserves all six prior rows byte-exact',
      inventory == blob(refs['publishedWorkspace'], inventory_path).decode() + 'meri-local-core-dispatch\texecuteMeriLocalDispatch\n')

package_path = 'package.json'
pkg = document(HEAD, package_path)
bpkg = document(BASE, package_path)
ps = pkg['scripts']
bs = bpkg['scripts']
additions = {
    'gate:cleanup4:duplicate-helpers': GENERIC,
    'gate:cleanup4:tango-page-leaves': GENERIC,
    'gate:cleanup4:strategy-template-metadata': refs['StrategyAcceptedIntegration'],
    'gate:cleanup4:workspace-product-metadata': refs['WorkspaceAcceptedIntegration'],
    'gate:cleanup4:meri-local-dispatch': refs['MeriAcceptedIntegration'],
}
check('package changes only five accepted aliases, original scripts and dependencies unchanged',
      set(ps) - set(bs) == set(additions) and all(ps.get(k) == v for k,v in bs.items()) and
      {k:v for k,v in pkg.items() if k != 'scripts'} == {k:v for k,v in bpkg.items() if k != 'scripts'})
for key, ref in additions.items():
    check(f'exact accepted alias: {key}', ps[key] == document(ref, package_path)['scripts'][key], ps[key])
phase1 = ps['verify:engagement-phase-1']
check('Phase1 original --run and six syntax-check operands preserved without execution',
      phase1 == bs['verify:engagement-phase-1'] and phase1.count('--run') == 1 and phase1.count('node --check ') == 6,
      {'equalBaseline': phase1 == bs['verify:engagement-phase-1'], 'runOperands': phase1.count('--run'), 'syntaxCheckOperands': phase1.count('node --check ')})
workflow_path = '.github/workflows/ci-pr.yml'
wf = blob(HEAD, workflow_path).decode()
stage_steps = [
    (refs['publishedTango'], 'Test reviewed Strategy template metadata', 'gate:cleanup4:strategy-template-metadata'),
    (refs['publishedStrategy'], 'Test reviewed Workspace product metadata', 'gate:cleanup4:workspace-product-metadata'),
    (refs['publishedWorkspace'], 'Test reviewed Meri local dispatch', 'gate:cleanup4:meri-local-dispatch'),
]
for ref, title, alias in reversed(stage_steps):
    step = f'      - name: {title}\n        run: pnpm {alias}\n\n'
    check(f'one unconditional CI step: {alias}', wf.count(step) == 1)
    wf = wf.replace(step, '', 1)
    check(f'prior published workflow preserved after removing only next reviewed step: {title}', wf == blob(ref, workflow_path).decode())
for alias in ['gate:cleanup4:registry-ownership', 'gate:cleanup4:duplicate-helpers', 'gate:cleanup4:tango-page-leaves']:
    check(f'original reviewed unconditional CI invocation retained: {alias}',
          f'        run: pnpm {alias}\n' in wf)

manifest_specs = [
    ('cleanup-four-runtime-controls-20261012/SHA256SUMS.json', None, 126),
    ('cleanup-strategy-runtime-controls-20261012/SHA256SUMS.json', None, 96),
    ('cleanup-workspace-runtime-controls-20261012/SHA256SUMS.json', None, 103),
    ('cleanup-tango-page-leaf-conversion-20261012/SHA256.json', refs['TangoApplication'], 24),
    ('cleanup-tango-page-leaf-independent-review-20261012/SHA256.json', refs['TangoAcceptedIntegration'], 27),
    ('cleanup-strategy-template-conversion-20261012/SHA256.json', refs['StrategyApplication'], 48),
    ('cleanup-strategy-template-independent-review-20261012/SHA256.json', refs['StrategyAcceptedIntegration'], 33),
    ('cleanup-workspace-product-conversion-20261012/SHA256.json', refs['WorkspaceApplication'], 46),
    ('cleanup-workspace-product-independent-review-20261012/SHA256-INDEX.json', refs['WorkspaceApplication'], 31),
    ('cleanup-workspace-root-adoption-independent-review-20261012/SHA256-INDEX.json', refs['WorkspaceAcceptedIntegration'], 29),
    ('cleanup-meri-local-dispatch-conversion-20261012/SHA256-INDEX.json', refs['MeriApplication'], 42),
    ('cleanup-meri-local-dispatch-independent-review-20261012/SHA256.json', refs['MeriAcceptedIntegration'], 31),
    ('cleanup-four-runtime-controls-independent-review-20261012/SHA256-E3.json', None, 10),
    ('cleanup-four-runtime-controls-independent-review-20261012/SHA256-9A23.json', None, 15),
    ('cleanup-four-runtime-controls-independent-review-20261012/SHA256-8F48.json', None, 18),
    ('cleanup-newsletter-two-contract-preservation-plan-20261012/SHA256.json', None, 34),
]
manifest_rows = []
for suffix, frozen, count in manifest_specs:
    path = 'docs/' + suffix
    index = document(HEAD, path)
    if isinstance(index, dict) and ('files' in index or 'entries' in index):
        entries = index.get('files', index.get('entries'))
    else:
        entries = [{'path': p, 'sha256': h} for p,h in index.items()]
    verified = []
    mismatches = []
    for entry in entries:
        p = entry['path']
        if not (p.startswith(('docs/', 'apps/', 'scripts/', '.github/')) or p == 'package.json'):
            p = str(Path(path).parent / p)
        raw = blob(HEAD, p)
        mode = 'current composition'
        if hashlib.sha256(raw).hexdigest() != entry['sha256']:
            if frozen and p in evolving:
                raw = blob(frozen, p)
                mode = 'accepted earlier evolving data/CI snapshot; union separately proved'
            else:
                mismatches.append({'path': p, 'expected': entry['sha256'], 'actual': hashlib.sha256(raw).hexdigest()})
        valid = hashlib.sha256(raw).hexdigest() == entry['sha256']
        if not valid and not any(x['path'] == p for x in mismatches):
            mismatches.append({'path': p, 'expected': entry['sha256'], 'actual': hashlib.sha256(raw).hexdigest()})
        if 'bytes' in entry and len(raw) != entry['bytes']:
            mismatches.append({'path': p, 'byteCount': len(raw), 'expectedByteCount': entry['bytes']})
        verified.append({'path': p, 'binding': mode, 'sha256': entry['sha256'], 'passed': valid})
    check(f'preserved master/index: {path}', len(entries) == count and not mismatches,
          {'count': len(entries), 'mismatches': mismatches})
    manifest_rows.append({'path': path, 'count': len(entries), 'entries': verified})
results['manifests'] = manifest_rows
results['scope'] = {
    'applicationBodiesInspected': False,
    'excludedUnpublishedReportingBranchesInspected': False,
    'applicationSemanticsReReviewed': False,
    'applicationOrCloseoutCliExecuted': False,
    'nativeProviderDatabaseMigrationOperations': False,
    'pendingRootMeriMasterNotAcceptancePrerequisite': True,
}
results['passed'] = not results['errors']
print(json.dumps(results, indent=2))
raise SystemExit(0 if results['passed'] else 1)
