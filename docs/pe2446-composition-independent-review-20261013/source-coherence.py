import hashlib
import json
import pathlib
import subprocess

REPO = '/tmp/capirov2-cleanup-strategy-template-independent-review'
STAGE = pathlib.Path('/tmp/capiro-pe2446-composition-review-20261013')
BASE = '457e84e7d50f401985355cf22eedc480fd72ad8b'
TIP = 'e25b2c9ad93ae8d63ffb5332c41d7af1623d4400'
DEST = 'e33fe1af359defbe52a9a63089f05bf7a757344f'
PUBLICATION = '920c69b9273ea5846cbfcea2aa6d36760c91526a'
MAIN = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO)


def entries(head, prefix=None):
    args = ['ls-tree', '-r', '-z', head]
    if prefix is not None:
        args += ['--', prefix]
    rows = {}
    for item in git(*args).split(b'\0'):
        if not item:
            continue
        metadata, name = item.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        rows[name.decode()] = {'mode': mode, 'kind': kind, 'gitBlob': oid}
    return rows


paths = git('diff', '--name-only', BASE, TIP).decode().strip().split('\n')
rows = []
for name in paths:
    before = entries(BASE, name).get(name)
    destination = entries(DEST, name).get(name)
    tip = entries(TIP, name).get(name)
    disposition = 'conflict'
    if before == destination:
        disposition = 'modify exact-current owner' if before else 'new path absent at current destination'
    rows.append({'path': name, 'base': before, 'destination': destination, 'tip': tip,
                 'disposition': disposition,
                 'physicalTipSHA256': hashlib.sha256((STAGE / name).read_bytes()).hexdigest()})
sql = {head: {key: value for key, value in entries(head).items() if key.endswith('.sql')}
       for head in [BASE, TIP, DEST]}
production_sql = {head: {key: value for key, value in values.items() if not key.startswith('docs/')}
                  for head, values in sql.items()}
api = {head: {key: value for key, value in entries(head, 'apps/api/prisma/migrations').items()
              if key.endswith('/migration.sql')} for head in [BASE, TIP, DEST, MAIN]}
before_pkg = json.loads(git('show', BASE + ':apps/api/package.json'))
tip_pkg = json.loads(git('show', TIP + ':apps/api/package.json'))
old_trust = before_pkg['scripts']['test:pe-trust']
prefix = 'pnpm run test:pe-phase-9-migration-discovery && '
inverse_scripts = dict(tip_pkg['scripts'])
inverse_scripts.pop('test:pe-phase-9-migration-discovery')
inverse_scripts['test:pe-trust'] = old_trust
inverse_pkg = dict(tip_pkg, scripts=inverse_scripts)
checks = {
    'changedPathsExactlyEight': len(paths) == 8,
    'zeroDeletedPaths': not git('diff', '--name-only', '--diff-filter=D', BASE, TIP).strip(),
    'allDestinationOperandsEqualPublishedBase': all(row['disposition'] != 'conflict' for row in rows),
    'allGlobalSQLBlobsPreservedInPublishedDelta': sql[BASE] == sql[TIP],
    'destinationProductionSQLBlobsMatchBase': production_sql[BASE] == production_sql[DEST],
    'apiMigrationNamesModesBlobsMatchBaseTipDestination': api[BASE] == api[TIP] == api[DEST],
    'apiMigrationSQLModesRegular': all(value['mode'] in ['100644', '100755'] for value in api[TIP].values()),
    'originalPackageObjectInverseExact': inverse_pkg == before_pkg,
    'originalTrustCommandBytesExactSuffix': tip_pkg['scripts']['test:pe-trust'] == prefix + old_trust,
    'canonicalWorkerSQLThreeWayIdentical': len({git('rev-parse', head + ':scripts/ci/disposable-capiro-worker-role.sql').strip()
                                               for head in [BASE, TIP, DEST]}) == 1,
    'publicationDestinationSourceOperandsSame': all(entries(PUBLICATION, name).get(name) == row['destination']
                                                  for name, row in zip(paths, rows)),
}
result = {
    'base': BASE, 'tip': TIP, 'tipTree': git('rev-parse', TIP + '^{tree}').decode().strip(),
    'destinationSource': DEST, 'destinationPublication': PUBLICATION,
    'checks': checks, 'matrix': rows, 'globalSQLCount': len(sql[TIP]),
    'productionSQLCount': len(production_sql[TIP]),
    'apiMigrationCounts': {head: len(values) for head, values in api.items()},
    'apiMigrationBindings': api[TIP],
    'mainOnlyNames': sorted(set(api[MAIN]) - set(api[TIP])),
    'tipBeyondMainNames': sorted(set(api[TIP]) - set(api[MAIN])),
    'SQLBodiesRead': False, 'nativeReplay': False,
}
output = STAGE / 'docs/pe2446-composition-independent-review-20261013/evidence/04-source-coherence-matrix.json'
output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['checks', 'globalSQLCount', 'productionSQLCount', 'apiMigrationCounts']}))
raise SystemExit(0 if all(checks.values()) else 1)
