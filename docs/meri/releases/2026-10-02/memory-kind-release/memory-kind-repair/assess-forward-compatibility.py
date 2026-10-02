"""Read-only Git/evidence joins. Does not replay retired clones or access a database."""
import datetime, hashlib, json, pathlib, re, subprocess

ROOT = pathlib.Path(r'C:\dev\cap-meri-bill-deadline')
OUT = pathlib.Path(r'C:\dev\cap-meri-foundation-evidence\oct02-memory-kind-repair')
OLD = pathlib.Path(r'C:\dev\cap-meri-outcomes-validation\docs\meri\releases\2026-10-02\retirement-rolling-compatibility.json')
AUDIT = pathlib.Path(r'C:\dev\cap-meri-foundation-evidence\oct02-release\audit-retirement-compatibility.py')
SOURCE = '42988dae5fb7bc2fff3af582ca15a0836a4477c5'
MIGRATION_SOURCE = '620cf0b5afd297ec7fb5e6e7bd55256e46c26236'
BASE = 'a260004e9923ef5bbe7bd8f32bb4cbddd3c7be31'
NEW = 'apps/api/prisma/migrations/20281005010000_memory_version_candidate_source_kinds/migration.sql'

def sha(b): return hashlib.sha256(b).hexdigest()
def read(p): return json.loads(p.read_text(encoding='utf-8-sig'))
def git(*args): return subprocess.check_output(['git', '-C', str(ROOT), *args])
def blob(ref, path): return git('show', ref + ':' + path)
def evidence(p): return {'path': str(p), 'sha256': sha(p.read_bytes())}
def tree(ref, path):
    result = {}
    for entry in git('ls-tree', '-r', '-z', ref, '--', path).split(b'\0'):
        if not entry: continue
        meta, name = entry.split(b'\t', 1)
        result[name.decode()] = meta.split()[2].decode()
    return result

prior = read(OLD)
assert prior['sourceSha'] == '83304d18e5a1ab647cf6f728392cf97b3058a832'
q = read(OUT / 'qualification.json')
assert q['status'] == 'PASS' and q['sourceSha'] == MIGRATION_SOURCE
for name, digest in q['artifactSha256'].items():
    assert sha((OUT / name).read_bytes()) == digest, name
for name, digest in q['sourceGitBlobSha256'].items():
    assert sha(blob(MIGRATION_SOURCE, name)) == digest, name
assert q['tests']['exitCode'] == 0 and q['tests']['passed'] == 28 and q['tests']['skipped'] == 0
testlog = (OUT / 'migration-bounded-transaction.test.log').read_text(encoding='utf-8-sig')
assert re.search(r'# tests 28\b', testlog) and re.search(r'# pass 28\b', testlog)
assert re.search(r'# fail 0\b', testlog) and re.search(r'# skipped 0\b', testlog)
for review in q['reviews']:
    assert review['processExit'] == 0 and review['toolCalls'] == 0

baseline = {p: h for p, h in tree(prior['sourceSha'], 'apps/api/prisma/migrations').items() if p.endswith('/migration.sql')}
assert len(baseline) == 449
prefix_checks = {}
for ref in ['5e72da28863112ef3f5257caf4a480784f18720a', BASE, MIGRATION_SOURCE, SOURCE]:
    current = {p: h for p, h in tree(ref, 'apps/api/prisma/migrations').items() if p.endswith('/migration.sql')}
    assert all(current.get(p) == h for p, h in baseline.items()), ref
    additions = sorted(set(current) - set(baseline))
    assert additions == ([] if ref in ['5e72da28863112ef3f5257caf4a480784f18720a', BASE] else [NEW])
    prefix_checks[ref] = {'historical449ExactGitBlobIdentity': True, 'count': len(current), 'additions': additions}
assert blob(SOURCE, NEW) == blob(MIGRATION_SOURCE, NEW)
sql = blob(SOURCE, NEW).decode('utf-8')
assert '\r' not in sql
assert "BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '30s';" in sql
assert sql.count('ALTER TABLE') == 1 and sql.strip().endswith('COMMIT;')
workspace = {r: git('rev-parse', r + ':apps/workspace/prisma/migrations').decode().strip() for r in [prior['sourceSha'], BASE, SOURCE]}
assert len(set(workspace.values())) == 1

rehearsals = []
catalog = read(OUT / 'constraint-catalog-bounded.json')
for mode in ['fresh', 'upgrade']:
    path = OUT / ('forward-v2-' + mode + '-42988dae5fb7.json')
    value = read(path)
    logpath = path.with_suffix('.log')
    assert value['sourceSha'] == SOURCE and value['mode'] == mode and value['stage'] == 'complete'
    assert value['exitCode'] == value['migrationExitCode'] == 0
    assert value['sharedDatabaseTouched'] is False and value['manualMigrationLedgerEdits'] is False
    assert value['history'] == {'count': 450, 'exactSourceChecksums': True, 'unfinished': 0, 'unexpected': 0}
    assert sha(logpath.read_bytes()) == value['logSha256']
    assert 'All migrations have been successfully applied.' in logpath.read_text(encoding='utf-8-sig')
    assert value['newMigration']['sha256'] == sha(blob(SOURCE, NEW))
    assert value['retiredTablesAbsent'] is True
    expected = {'memory_candidate_source_kind_chk': q['constraintCatalog']['sourceKindSha256'], 'memory_candidate_version_payload_check': q['constraintCatalog']['payloadSha256']}
    for c in value['constraints']:
        assert c['validated'] and sha(c['definition'].encode()) == expected[c['name']]
    if mode == 'upgrade':
        assert value['baselineHistory'] == {'count': 449, 'exactSourceChecksums': True, 'unfinished': 0, 'unexpected': 0}
        assert value['baselineReceiptSha256'] == prior['freshRehearsal']['receipt']['sha256']
    rehearsals.append({'mode': mode, 'receipt': evidence(path), 'log': evidence(logpath), 'sourceSha': SOURCE, 'exitCode': 0, 'exact450Ledger': True, 'retiredTablesAbsent': True})

retired = prior['retirement']['retiredTables']
roots = prior['retirement']['scanRoots']
scans = []
for ref in [BASE, SOURCE]:
    args = ['git', '-C', str(ROOT), 'grep', '-n', '-I', '-E', '|'.join(retired), ref, '--', *roots]
    run = subprocess.run(args, capture_output=True, check=False)
    assert run.returncode in [0, 1]
    comments = []
    for line in run.stdout.decode('utf-8').splitlines():
        _, path, number, content = line.split(':', 3)
        if '.test.' in path or '.spec.' in path or not path.endswith(('.ts', '.tsx', '.js', '.mjs', '.cjs')): continue
        assert content.strip().startswith(('//', '*')), (ref, path, number)
        comments.append({'path': path, 'line': int(number)})
    serve = blob(ref, 'apps/api/scripts/entrypoint-dispatcher.inc').decode()
    assert re.search(r'serve\)\s*echo "Starting Capiro API"\s*exec node dist/main.js\s*;;', serve)
    assert 'CMD ["serve"]' in blob(ref, 'apps/api/Dockerfile').decode()
    scans.append({'sourceSha': ref, 'activeRetiredTableReferences': [], 'commentOnlyMatches': comments, 'apiServeSeparateFromMigration': True, 'grepExitCode': run.returncode})

result = {
    'kind': 'memory-version-kind-forward-compatibility-bridge',
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'status': 'PASS_BOUNDED_SOURCE_AND_OWNED_REHEARSAL',
    'finalMergedCandidateSha': None, 'candidateDigest': None, 'releaseBinding': 'PENDING_ROOT',
    'policySha': '39590a3bfc57ce03b0411ff7912a7c8d99deb70c',
    'migrationSource': MIGRATION_SOURCE, 'rehearsedCombinedSource': SOURCE,
    'historicalReport': evidence(OLD), 'historicalAuditScriptReadOnlyInspectedNotRerun': evidence(AUDIT),
    'sourceQualification': evidence(OUT / 'qualification.json'),
    'allSourceQualificationArtifactHashesVerified': True,
    'prefixChecks': prefix_checks, 'workspaceMigrationTrees': workspace,
    'migrationSha256': sha(blob(SOURCE, NEW)), 'schemaChange': True,
    'ddlScope': 'One atomic bounded ALTER replaces two CHECK constraints: preserve six canonical kinds, add three immutable-version kinds, reject NULL version payload predicates. No table/row/RLS/trigger/ledger rewrite.',
    'rehearsals': rehearsals, 'retiredRuntimeScans': scans,
    'historical65StepQualification': {
        'receipt': prior['upgradeRehearsal']['qualification'],
        'verifiedByPriorReportOnlyThisTurn': True,
        'replayedThisTurn': False,
        'preservedPriorVerdicts': prior['upgradeRehearsal']['preservedPriorVerdicts'],
        'dataPreservation': prior['upgradeRehearsal']['dataPreservation'],
        'limitations': prior['upgradeRehearsal']['limitations'],
        'notAuthorization': 'Historical resolve/ledger operations are evidence only and must not be repeated by the forward450 operator.'
    },
    'rollingCompatibility': {
        'status': 'PASS_BOUNDED_STATIC_AND_CONSTRAINT_TESTS',
        'existingWriters': 'All six prior source-kind values and ordinary payload behavior remain accepted. No column, relation, result, permission or route shape changes.',
        'immutableWriters': 'Existing canonical correction/restore/contradiction dispatch becomes admissible; exact typed payload and same-tenant immutable activation guards remain enforced.',
        'rollback': 'Retain forward schema when rolling application images back. Dropping the three new kinds after writes could reject existing rows; no downmigration is supplied.',
        'limits': 'No new mixed-image live execution or original-live fingerprint comparison is asserted; each image and effective flags require current release qualification.'
    },
    'remainingGates': [
        'Root bind final merged source to this exact migration prefix, payload/trigger source and actual qualified immutable API image containing450 migrations.',
        'Fresh shared DB read-only preflight must confirm exact449 ledger/catalog, expected four claims and no unexpected active conflicting state before root-owned packaged Prisma migrate deploy.',
        'No old restore/resolve path; no dispatcher workflow seeds. Execute only the single new bounded transaction through the approved migration oneoff.',
        'After execution independently verify exact450 checksums/no unfinished, both CHECK definitions validated and unchanged prior claims before fresh post-seed resume.',
        'Preserve research tool dark flag, service/tenant gates and previous image rollback; full original File01/live acceptance remains NOT_RUN.'
    ],
    'externalEffects': {'databaseQueries': 0, 'databaseWrites': 0, 'cloudWrites': 0, 'authOrProviderCalls': 0},
}
path = OUT / 'forward-compatibility-assessment.json'
path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': result['status'], 'path': str(path), 'sha256': sha(path.read_bytes()), 'releaseBinding': result['releaseBinding'], 'exitCode': 0}))
