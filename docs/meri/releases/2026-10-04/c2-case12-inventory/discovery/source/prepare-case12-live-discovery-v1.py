from pathlib import Path
import hashlib,subprocess
r=Path(__file__).resolve().parent
inner=r/'case12-live-discovery-inner-v1.mjs'
outer=(r/'read-case14-source-schema-v1.mjs').read_text(encoding='utf-8')
replacements={
 'case14-source-schema-read-v1':'case12-live-discovery-v1',
 'case14-source-schema-inner-v1':'case12-live-discovery-inner-v1',
 'c0f393f863bf73bd4e65e7a94e17c073e7be021e':'945179d44223882f9fe1da2fb4e41213bf5813c2',
 '4d8808af4b92dd4133f0c74410082e876630ede11fea2d168ac50b6ffed48ac7':hashlib.sha256(inner.read_bytes()).hexdigest(),
 'capiro-dev-api:523':'capiro-dev-api:525','serviceRevision:523':'serviceRevision:525',
 'capiro-dev-meri-c2-memory-source-schema-20261004':'capiro-dev-meri-c2-case12-discovery-20261004',
 'sha256:024fcc82a2db7701f4a3e3311598a9a1d0933b3fe4fcf73751bf0e3fb866d8ce':'sha256:00e8c5cac10d8b4cd3cc46a0a9a7602b51db4657e38fabe86f1f12999d2b2e31',
 'C2_MEMORY_SOURCE_SCHEMA':'C2_CASE12_DISCOVERY','EXACT_MEMORY_SOURCE_SCHEMA_READ':'EXACT_CASE12_READ_ONLY_DISCOVERY',
 'C2 memory source schema read cleanup':'C2 Case12 read-only discovery cleanup','schema-proof.json':'discovery-proof.json',
 "assert.equal(owner.status,'VERIFIED_READ_ONLY');":"assert.equal(owner.status,'VERIFIED_READ_ONLY_DIAGNOSTIC');",
 "assert.equal(owner.migrationExecution,false);":"assert.equal(owner.canonicalInventoryVerified,false);",
 "assert.equal(owner.ledgerRows,609);assert.equal(owner.prior608Sha256,'9a82cbc9dcecc3b049c312ad4e39ec5a96eb33c6e5af033a3339d1e292c06e90');assert.equal(owner.retirementTablesAbsent,true);":"assert.equal(owner.fixtureReady,false);assert.equal(owner.captureAuthority,false);assert.equal(owner.queryCompleteForVisibleKeyPredicate,true);",
}
for a,b in replacements.items():
 assert a in outer,a
 outer=outer.replace(a,b)
outer=outer.replace("c.image='967807", "c.dockerLabels={'org.opencontainers.image.revision':'945179d44223882f9fe1da2fb4e41213bf5813c2'};\nc.image='967807",1)
out=r/'read-case12-live-discovery-v1.mjs'
assert not out.exists()
out.write_bytes(outer.encode())
for p in (inner,out):
 subprocess.run(['C:/Program Files/nodejs/node.exe','--check',str(p)],check=True)
 print(p.name,hashlib.sha256(p.read_bytes()).hexdigest())
