"""Remove only the recorded /root disposable fixture, after all consumers close."""
from pathlib import Path
import hashlib
import json
import os
import stat
import subprocess

if not __debug__:
    raise RuntimeError("Optimized Python would disable ownership fences")

PACKET = Path(__file__).resolve().parent
RECEIPT = json.loads((PACKET / "OWNED-DB-RECEIPT.json").read_text())
HEAD = "bbb38185058fdc64c204da723943aee055b3dad3"
DATABASE = "capiro_auth_http_20261013_4966f869fa"
ROLE = DATABASE + "_rls"
COMMENT = "owned /root authority HTTP fixture at " + HEAD
CONTAINER = "capiro-postgres"
assert RECEIPT["head"] == HEAD
assert RECEIPT["database"] == DATABASE and RECEIPT["databaseOid"] == "16917"
assert RECEIPT["role"] == ROLE and RECEIPT["resourceOwner"] == "/root"
assert RECEIPT["container"] == CONTAINER
assert RECEIPT["createdDatabase"] and RECEIPT["roleCreated"]
assert RECEIPT["clusterSystemIdentifier"] == "7695590366852821031"
OUTPUT = PACKET / "evidence/12-owned-target-cleanup.json"
assert not OUTPUT.exists(), "cleanup receipt must be exclusive"


def pg(sql):
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "capiro", "-d", "postgres",
         "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
        input=sql, text=True, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def container_snapshot():
    value = json.loads(subprocess.check_output(["docker", "inspect", CONTAINER]))[0]
    assert value["Id"] == "3dee5d43de72" + value["Id"][12:]
    assert value["State"]["Running"]
    assert value["State"]["Health"]["Status"] == "healthy"
    fixed = {key: value[key] for key in ["Id", "Image", "Created", "Config", "HostConfig", "Mounts"]}
    # Only a digest is persisted: existing environment/authentication is never emitted.
    digest = hashlib.sha256(json.dumps(fixed, sort_keys=True).encode()).hexdigest()
    return {"containerId": value["Id"], "immutableConfigurationSha256": digest, "healthy": True}


def catalog_fingerprint():
    value = pg("""SELECT json_build_object(
      'databases',(SELECT json_agg(d ORDER BY d.oid) FROM
         (SELECT oid,datname,datdba,encoding,datistemplate,datallowconn,datconnlimit,datacl
          FROM pg_database WHERE datname <> 'capiro_auth_http_20261013_4966f869fa') d),
      'roles',(SELECT json_agg(r ORDER BY r.oid) FROM
         (SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
                 rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig
          FROM pg_roles WHERE rolname <> 'capiro_auth_http_20261013_4966f869fa_rls') r));""")
    return hashlib.sha256(value.encode()).hexdigest()


config = Path("/tmp/capiro-authority-http-runtime.json")
config_lstat = config.lstat()
assert stat.S_ISREG(config_lstat.st_mode) and stat.S_IMODE(config_lstat.st_mode) == 0o600
assert config_lstat.st_nlink == 1
fd = os.open(config, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd) as stream:
    opened = os.fstat(stream.fileno())
    assert (opened.st_dev, opened.st_ino) == (config_lstat.st_dev, config_lstat.st_ino)
    private = json.load(stream)
assert private["sourceHead"] == HEAD and private["databaseName"] == DATABASE and private["databaseOid"] == 16917
assert private["databaseComment"] == COMMENT and private["systemIdentifier"] == RECEIPT["clusterSystemIdentifier"]
assert private["approvedOwnedDatabase"] is True
before_container = container_snapshot()
before_catalog = catalog_fingerprint()
assert pg("SELECT system_identifier::text FROM pg_control_system();") == RECEIPT["clusterSystemIdentifier"]
target = json.loads(pg("""SELECT json_build_object('oid',oid::int,'name',datname,
  'comment',shobj_description(oid,'pg_database')) FROM pg_database
  WHERE datname='capiro_auth_http_20261013_4966f869fa';"""))
assert target == {"oid": 16917, "name": DATABASE, "comment": COMMENT}, target
role = json.loads(pg("""SELECT json_build_object('name',rolname,'super',rolsuper,
 'bypass',rolbypassrls,'login',rolcanlogin,'inherit',rolinherit,
 'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication)
 FROM pg_roles WHERE rolname='capiro_auth_http_20261013_4966f869fa_rls';"""))
assert role == {"name": ROLE, "super": False, "bypass": False, "login": False,
               "inherit": False, "createdb": False, "createrole": False, "replication": False}, role
assert pg("SELECT count(*) FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='capiro_auth_http_20261013_4966f869fa_rls') OR member=(SELECT oid FROM pg_roles WHERE rolname='capiro_auth_http_20261013_4966f869fa_rls');") == "0"
assert pg("SELECT count(*) FROM pg_stat_activity WHERE datname='capiro_auth_http_20261013_4966f869fa';") == "0", "all owned consumer pools must close first"
pg('DROP DATABASE "' + DATABASE + '";')
pg('DROP ROLE "' + ROLE + '";')
assert pg("SELECT count(*) FROM pg_database WHERE datname='capiro_auth_http_20261013_4966f869fa';") == "0"
assert pg("SELECT count(*) FROM pg_roles WHERE rolname='capiro_auth_http_20261013_4966f869fa_rls';") == "0"
after_container = container_snapshot()
after_catalog = catalog_fingerprint()
assert before_container == after_container
assert before_catalog == after_catalog
config_now = config.lstat()
assert (config_now.st_dev, config_now.st_ino) == (config_lstat.st_dev, config_lstat.st_ino)
assert stat.S_ISREG(config_now.st_mode) and stat.S_IMODE(config_now.st_mode) == 0o600
config.unlink()
receipt = {"sourceHead": HEAD, "sourceTree": RECEIPT["tree"], "database": DATABASE,
           "databaseOid": 16917, "role": ROLE, "ownershipFencePassed": True,
           "openOwnedConnectionsBeforeDrop": 0, "forcedTermination": False,
           "databaseAbsent": True, "roleAbsent": True, "privateRuntimeConfigRemoved": True,
           "otherCatalogFingerprintBefore": before_catalog, "otherCatalogFingerprintAfter": after_catalog,
           "existingContainerBefore": before_container, "existingContainerAfter": after_container,
           "existingContainerOrOtherDatabaseChanges": False}
with OUTPUT.open("x") as output:
    output.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
print(json.dumps({"ownedDatabaseRemoved": True, "ownedNoLoginRoleRemoved": True,
                  "existingContainerHealthyUnchanged": True, "otherCatalogFingerprintUnchanged": True,
                  "privateRuntimeConfigRemoved": True}))
