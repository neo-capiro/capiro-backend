"""One fenced Workspace fixture in the existing local container; no role changes."""
from pathlib import Path
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import uuid

if not __debug__:
    raise RuntimeError('Optimized Python would disable ownership fences')
PACKET = Path(__file__).resolve().parent
ROOT = PACKET.parents[1]
HEAD = '76f50b2667d06a121b2dd772abc9d64adb556c36'
TREE = 'd6e615533e4c36970779962b1391af90e5576314'
CONTAINER = 'capiro-postgres'
CONTAINER_ID = '3dee5d43de72a973ce75866d936064df2c747f3d02f5010050bff2587c837183'
SYSTEM_ID = '7695590366852821031'
PRIVATE = Path('/tmp/workspace-brief-native-runtime-20261013.json')
PLAN = PACKET / 'OWNED-TARGET-PLAN.json'
RECEIPT = PACKET / 'OWNED-DB-RECEIPT.json'
TABLES = {'tenants', 'users', 'tenant_memberships', 'clients', 'client_memory_access',
          'business_development_prospects', 'business_development_briefs',
          'business_development_brief_versions'}


def sha(value):
    return hashlib.sha256(value).hexdigest()


def write(path, value, exclusive=False):
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x') as stream:
        stream.write(json.dumps(value, indent=2, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    if exclusive:
        os.link(temporary, path)
        temporary.unlink()
    else:
        os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def pg(sql, database='postgres'):
    if database != 'postgres':
        target = json.loads(PLAN.read_text())
        assert database == target['database']
    result = subprocess.run(['docker', 'exec', '-i', CONTAINER, 'psql', '-U', 'capiro',
                             '-d', database, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
                            input=sql, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def container_snapshot():
    value = json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER]))[0]
    assert value['Id'] == CONTAINER_ID and value['State']['Running']
    assert value['State']['Health']['Status'] == 'healthy'
    fixed = {key: value[key] for key in ['Id', 'Image', 'Created', 'Config', 'HostConfig', 'Mounts']}
    return {'containerId': value['Id'], 'configurationSha256': sha(json.dumps(fixed, sort_keys=True).encode()), 'healthy': True}


def catalog(database):
    assert re.fullmatch(r'capiro_ws_copy_20261013_[0-9a-f]{16}', database)
    raw = pg("""SELECT json_build_object(
      'databases',(SELECT json_agg(d ORDER BY d.oid) FROM
        (SELECT oid,datname,datdba,encoding,datistemplate,datallowconn,datconnlimit,datacl
         FROM pg_database WHERE datname <> '""" + database + """') d),
      'roles',(SELECT json_agg(r ORDER BY r.oid) FROM
        (SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
          rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles) r));""")
    return {'sha256': sha(raw.encode()), 'snapshot': json.loads(raw)}


def validate_plan():
    value = json.loads(PLAN.read_text())
    assert value['head'] == HEAD and value['tree'] == TREE and value['resourceOwner'] == '/root'
    assert value['container'] == CONTAINER and value['clusterSystemIdentifier'] == SYSTEM_ID
    assert re.fullmatch(r'capiro_ws_copy_20261013_[0-9a-f]{16}', value['database'])
    assert value['databaseComment'] == 'owned /root Workspace copy fixture at ' + HEAD + ' ' + value['ownershipToken']
    assert pg('SELECT system_identifier::text FROM pg_control_system();') == SYSTEM_ID
    assert container_snapshot() == value['containerBefore']
    assert catalog(value['database']) == value['unrelatedCatalogBefore']
    assert not subprocess.check_output(['git', 'diff', '--name-only', HEAD, '--', 'apps', 'packages', 'scripts'], cwd=ROOT)
    return value


def fixture_sql():
    archive = json.loads((ROOT / 'docs/meri-http-qualification-20261013/evidence/01-current-schema-native-diff.sql').read_text())
    original = base64.b64decode(archive['data'], validate=True)
    assert len(original) == archive['bytes'] and sha(original) == archive['sha256'] == 'a5c1d59d93f18d5f3ca6272ab142ba1b0bc408057d62a4888325805163f99793'
    assert sha((ROOT / 'apps/api/prisma/schema.prisma').read_bytes()) == '215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb'
    blocks = re.split(r'(?m)(?=^-- \w)', original.decode())
    tables = [b for b in blocks if b.startswith('-- CreateTable') and re.search(r'CREATE TABLE "([^"\n]+)"', b).group(1) in TABLES]
    assert len(tables) == 8
    joined = ''.join(tables)
    enums = [b for b in blocks if b.startswith('-- CreateEnum') and '"' + re.search(r'CREATE TYPE "([^"\n]+)"', b).group(1) + '"' in joined]
    indexes = [b for b in blocks if b.startswith('-- CreateIndex') and re.search(r' ON "([^"\n]+)"', b).group(1) in TABLES]
    foreign_keys = [b for b in blocks if b.startswith('-- AddForeignKey') and set(re.search(r'ALTER TABLE "([^"\n]+)".*REFERENCES "([^"\n]+)"', b, re.S).groups()) <= TABLES]
    baseline_archive = json.loads((PACKET / 'evidence/pre-copy-workspace-ddl.sql').read_text())
    baseline_bytes = base64.b64decode(baseline_archive['data'], validate=True)
    assert baseline_archive['rawCheckpoint'] == 'c7d1a4b088beb57e02dcd57d54b1eb54599a3102' and len(baseline_bytes) == baseline_archive['bytes'] and sha(baseline_bytes) == baseline_archive['sha256']
    baseline = baseline_bytes.decode()
    assert sha(baseline.encode()) == '0d15663f559610adad4cae4082ac3c478a0784776736b331b506f4b768b93972'
    origin_path = ROOT / 'apps/workspace/prisma/migrations/20261012030000_prospect_resource_origin/migration.sql'
    origin = origin_path.read_text()
    functions = origin[origin.index('CREATE FUNCTION ws_preserve_prospect_origin()'):]
    saved_path = ROOT / 'apps/workspace/prisma/migrations/20261012040000_saved_version_immutability/migration.sql'
    result = 'CREATE EXTENSION IF NOT EXISTS "citext";\n' + ''.join(enums + tables + indexes + foreign_keys) + baseline + '\n' + functions + '\n' + saved_path.read_text()
    return result, {'coreCurrentDdlArchiveSha256': archive['sha256'], 'coreCurrentSchemaSha256': '215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb', 'selectedCoreTables': sorted(TABLES), 'workspaceBaseDdlSha256': sha(baseline.encode()), 'existingPrerequisiteBindings': [{'path': str(path.relative_to(ROOT)), 'sha256': sha(path.read_bytes())} for path in [origin_path, saved_path]], 'fullHistoricalMigrationReplay': False}


def plan():
    assert not PLAN.exists() and not RECEIPT.exists() and not os.path.lexists(PRIVATE)
    token = uuid.uuid4().hex
    database = 'capiro_ws_copy_20261013_' + token[:16]
    assert pg('SELECT system_identifier::text FROM pg_control_system();') == SYSTEM_ID
    assert pg("SELECT count(*) FROM pg_database WHERE datname='" + database + "';") == '0'
    disk = int(subprocess.check_output(['docker', 'exec', CONTAINER, 'df', '--output=avail', '-B1', '/var/lib/postgresql/data'], text=True).splitlines()[-1])
    # The fixture is bounded and small; retain capacity evidence before mutation.
    assert disk >= 32 * 1024 * 1024, 'At least 32MiB free is required for this bounded empty-schema fixture'
    value = {'head': HEAD, 'tree': TREE, 'resourceOwner': '/root', 'container': CONTAINER, 'clusterSystemIdentifier': SYSTEM_ID, 'database': database, 'ownershipToken': token, 'databaseComment': 'owned /root Workspace copy fixture at ' + HEAD + ' ' + token, 'mustNotPreexist': True, 'containerBefore': container_snapshot(), 'unrelatedCatalogBefore': catalog(database), 'availableContainerFilesystemBytesBefore': disk, 'rolesCredentialsGrantsSecurityOrContainerChanges': False, 'privateRuntimeConfig': str(PRIVATE)}
    write(PLAN, value, True)
    print(json.dumps({'plannedOwnedDatabase': database, 'existingLocalPgSupported': True, 'databaseCreated': False, 'freeBytes': disk}))


def prepare():
    value = validate_plan()
    database = value['database']
    assert not RECEIPT.exists() and not os.path.lexists(PRIVATE)
    assert pg("SELECT count(*) FROM pg_database WHERE datname='" + database + "';") == '0'
    ddl, bindings = fixture_sql()
    (PACKET / 'evidence/selected-baseline-fixture.sql').write_text(ddl)
    pg('CREATE DATABASE "' + database + '";')
    oid = int(pg("SELECT oid FROM pg_database WHERE datname='" + database + "';"))
    receipt = {**value, 'databaseOid': oid, 'createdDatabase': True, 'commentApplied': False, 'schemaApplied': False, 'newMigrationApplied': False, 'newRoleCreated': False, 'fixtureBindings': bindings, 'selectedFixtureSha256': sha(ddl.encode())}
    write(RECEIPT, receipt, True)
    write(PACKET / 'evidence/created-owned-database.json', receipt, True)
    pg('COMMENT ON DATABASE "' + database + '" IS ' + "'" + value['databaseComment'] + "';")
    receipt['commentApplied'] = True
    write(RECEIPT, receipt)
    pg(ddl, database)
    receipt['schemaApplied'] = True
    write(RECEIPT, receipt)
    migration_path = ROOT / 'apps/workspace/prisma/migrations/20261013090000_prospect_brief_workspace_copy/migration.sql'
    migration = migration_path.read_text()
    # A preexisting ordinary tab verifies the additive nullable column/backfill.
    draft_id, document_id, tenant_id = [str(uuid.uuid4()) for _ in range(3)]
    pg(f"INSERT INTO ws_draft(id,tenant_id,owner_id,doc_title,config,updated_at) VALUES ('{draft_id}','{tenant_id}','native_baseline','Native baseline','{{}}',now()); INSERT INTO ws_document(id,tenant_id,draft_id,name,ordinal,body,updated_at) VALUES ('{document_id}','{tenant_id}','{draft_id}','Preexisting ordinary tab',0,'{{\"blocks\":[]}}',now());", database)
    pg('BEGIN;\n' + migration + '\nCOMMIT;', database)
    assert pg(f"SELECT source_brief_version IS NULL FROM ws_document WHERE id='{document_id}';", database) == 't'
    receipt['newMigrationApplied'] = True
    receipt['migrationBinding'] = {'path': str(migration_path.relative_to(ROOT)), 'sha256': sha(migration_path.read_bytes())}
    receipt['preexistingOrdinaryTab'] = {'draftId': draft_id, 'documentId': document_id, 'tenantId': tenant_id, 'sourceRemainsNull': True}
    disk_after = int(subprocess.check_output(['docker', 'exec', CONTAINER, 'df', '--output=avail', '-B1', '/var/lib/postgresql/data'], text=True).splitlines()[-1])
    receipt['availableContainerFilesystemBytesAfterSchema'] = disk_after
    write(RECEIPT, receipt)
    assert disk_after >= 16 * 1024 * 1024, 'Stop before HTTP cases and recover the owned DB if the 16MiB reserve is unavailable'
    inspected = json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER]))[0]
    environment = dict(entry.split('=', 1) for entry in inspected['Config']['Env'])
    assert environment['POSTGRES_USER'] == 'capiro'
    from urllib.parse import quote
    url = 'postgresql://capiro:' + quote(environment['POSTGRES_PASSWORD'], safe='') + '@127.0.0.1:5432/' + database + '?schema=public&connection_limit=4'
    private = {'sourceHead': HEAD, 'sourceTree': TREE, 'databaseName': database, 'databaseOid': oid, 'databaseComment': value['databaseComment'], 'systemIdentifier': SYSTEM_ID, 'containerId': CONTAINER_ID, 'approvedOwnedDatabase': True, 'databaseUrl': url}
    private_bytes = json.dumps(private).encode()
    receipt['privateConfigSha256'] = sha(private_bytes)
    write(RECEIPT, receipt)
    fd = os.open(PRIVATE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(private_bytes.decode())
        stream.flush()
        os.fsync(stream.fileno())
    info = PRIVATE.lstat()
    receipt['privateConfigIdentity'] = {'device': info.st_dev, 'inode': info.st_ino, 'mode': stat.S_IMODE(info.st_mode)}
    write(RECEIPT, receipt)
    print(json.dumps({'ownedDatabase': database, 'oid': oid, 'newMigrationApplied': True, 'preexistingOrdinaryTabSourceNull': True, 'newRolesOrCredentials': False, 'ownerConnectionRlsQualification': False}))


def cleanup():
    value = validate_plan()
    receipt = json.loads(RECEIPT.read_text())
    assert receipt['createdDatabase'] and receipt['database'] == value['database'] and receipt['head'] == HEAD
    assert not receipt['newRoleCreated']
    database = value['database']
    target = json.loads(pg("SELECT COALESCE((SELECT json_build_object('oid',oid::int,'name',datname,'owner',pg_get_userbyid(datdba),'comment',shobj_description(oid,'pg_database'))::text FROM pg_database WHERE datname='" + database + "'),'null');"))
    if target is not None:
        assert target == {'oid': receipt['databaseOid'], 'name': database, 'owner': 'capiro', 'comment': value['databaseComment'] if receipt['commentApplied'] else None}
    assert pg("SELECT count(*) FROM pg_stat_activity WHERE datname='" + database + "';") == '0', 'Close all owned pools; never force termination'
    private_info = None
    if os.path.lexists(PRIVATE):
        private_info = PRIVATE.lstat()
        assert stat.S_ISREG(private_info.st_mode) and stat.S_IMODE(private_info.st_mode) == 0o600 and private_info.st_nlink == 1
        assert private_info.st_uid == os.getuid()
        if 'privateConfigIdentity' in receipt:
            assert receipt['privateConfigIdentity'] == {'device': private_info.st_dev, 'inode': private_info.st_ino, 'mode': stat.S_IMODE(private_info.st_mode)}
        fd = os.open(PRIVATE, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            opened = os.fstat(stream.fileno())
            assert (opened.st_dev, opened.st_ino) == (private_info.st_dev, private_info.st_ino)
            private_bytes = stream.read().encode()
            assert sha(private_bytes) == receipt['privateConfigSha256']
            config = json.loads(private_bytes)
        assert config['sourceHead'] == HEAD and config['databaseName'] == database and config['databaseOid'] == receipt['databaseOid'] and config['databaseComment'] == value['databaseComment'] and config['approvedOwnedDatabase'] is True
    if target is not None:
        pg('DROP DATABASE "' + database + '";')
    assert pg("SELECT count(*) FROM pg_database WHERE datname='" + database + "';") == '0'
    after_container, after_catalog = container_snapshot(), catalog(database)
    assert after_container == value['containerBefore'] and after_catalog == value['unrelatedCatalogBefore']
    if private_info:
        now = PRIVATE.lstat()
        assert (now.st_dev, now.st_ino) == (private_info.st_dev, private_info.st_ino)
        PRIVATE.unlink()
    result = {'head': HEAD, 'tree': TREE, 'ownedDatabase': database, 'databaseOid': receipt['databaseOid'], 'ownedDatabaseAbsent': True, 'targetAlreadyAbsentOnRecovery': target is None, 'openOwnedConnectionsBeforeDrop': 0, 'forcedTermination': False, 'partialPreparationRecoverySupported': True, 'privateConfigRemoved': not os.path.lexists(PRIVATE), 'newRoleCreated': False, 'unrelatedCatalogBefore': value['unrelatedCatalogBefore'], 'unrelatedCatalogAfter': after_catalog, 'containerBefore': value['containerBefore'], 'containerAfter': after_container, 'unrelatedDatabasesRolesAndContainerConfigurationUnchanged': True}
    write(PACKET / 'evidence/owned-target-cleanup.json', result, True)
    print(json.dumps({'ownedDatabaseRemoved': True, 'privateConfigRemoved': True, 'unrelatedDatabasesRolesAndContainerConfigurationUnchanged': True}))


def recover_unsealed_create():
    """Only the CREATE-to-receipt gap; refuse any nonempty application schema."""
    value = validate_plan()
    assert not RECEIPT.exists() and not os.path.lexists(PRIVATE)
    database = value['database']
    target = json.loads(pg("SELECT json_build_object('oid',oid::int,'name',datname,'owner',pg_get_userbyid(datdba),'comment',shobj_description(oid,'pg_database')) FROM pg_database WHERE datname='" + database + "';"))
    assert target['name'] == database and target['owner'] == 'capiro' and target['comment'] is None and target['oid'] > 0
    assert pg("SELECT count(*) FROM pg_stat_activity WHERE datname='" + database + "';") == '0'
    assert pg("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f','S');", database) == '0'
    pg('DROP DATABASE "' + database + '";')
    assert pg("SELECT count(*) FROM pg_database WHERE datname='" + database + "';") == '0'
    assert container_snapshot() == value['containerBefore'] and catalog(database) == value['unrelatedCatalogBefore']
    write(PACKET / 'evidence/unsealed-create-recovery.json', {'sourceHead': HEAD, 'database': database, 'observedOid': target['oid'], 'emptyApplicationSchemaProven': True, 'nullCommentProven': True, 'ownedDatabaseAbsent': True, 'forcedTermination': False, 'unrelatedCatalogAndContainerUnchanged': True}, True)
    print(json.dumps({'unsealedOwnedCreationRecovered': True, 'emptySchemaRequired': True}))


def add_source_action_prerequisite():
    value = validate_plan()
    receipt = json.loads(RECEIPT.read_text())
    database = value['database']
    assert receipt['database'] == database and receipt['createdDatabase'] and receipt['newMigrationApplied']
    observed = json.loads(pg("SELECT json_build_object('oid',oid::int,'name',datname,'owner',pg_get_userbyid(datdba),'comment',shobj_description(oid,'pg_database')) FROM pg_database WHERE datname='" + database + "';"))
    assert observed == {'oid': receipt['databaseOid'], 'name': database, 'owner': 'capiro', 'comment': value['databaseComment']}
    assert pg("SELECT count(*) FROM pg_stat_activity WHERE datname='" + database + "';") == '0'
    assert pg("SELECT to_regclass('public.ws_source_action') IS NULL;", database) == 't'
    migration_path = ROOT / 'apps/workspace/prisma/migrations/20260913020000_legiwatch_preparation_actions/migration.sql'
    original = migration_path.read_text()
    selected = original[:original.index('GRANT SELECT,INSERT')] + original[original.index('CREATE FUNCTION ws_source_action_immutable()'):]
    assert 'GRANT ' not in selected and 'REVOKE ' not in selected
    (PACKET / 'evidence/selected-source-action-prerequisite.sql').write_text(selected)
    pg('BEGIN;\n' + selected + '\nCOMMIT;', database)
    assert pg("SELECT to_regclass('public.ws_source_action') IS NOT NULL;", database) == 't'
    result = {'sourceHead': HEAD, 'database': database, 'databaseOid': receipt['databaseOid'], 'existingMigration': str(migration_path.relative_to(ROOT)), 'wholeMigrationSha256': sha(original.encode()), 'selectedStatementSha256': sha(selected.encode()), 'onlyExistingTableFunctionTrigger': True, 'roleGrantOrPermissionStatementsExecuted': False, 'sourceTableInitiallyAbsent': True, 'ownedScopeFencesRevalidated': True, 'fullHistoricalMigrationReplay': False}
    write(PACKET / 'evidence/source-action-prerequisite-applied.json', result, True)
    print(json.dumps({'ownedExistingManualPrerequisiteApplied': True, 'roleOrPermissionChanges': False}))


if __name__ == '__main__':
    {'plan': plan, 'prepare': prepare, 'cleanup': cleanup, 'recover-unsealed-create': recover_unsealed_create, 'add-source-action-prerequisite': add_source_action_prerequisite}[sys.argv[1]]()
