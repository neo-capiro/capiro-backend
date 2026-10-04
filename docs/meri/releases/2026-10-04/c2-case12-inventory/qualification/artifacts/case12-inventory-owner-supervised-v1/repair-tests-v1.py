from pathlib import Path
p=Path(__file__).parent/'scratch/evals/meri/live-v1/tests/case12-memory-inventory-owner.test.mjs'
s=p.read_text()
s=s.replace('async function fixture() {', 'async function fixture(count = 509) {')
s=s.replace('const manifest = await buildFixtureManifest({', 'const manifest = structuredClone(await buildFixtureManifest({',1)
s=s.replace("    actors: { PAT: { tenantId: 'T1', physicalId: id() } },\n  });", "    actors: { PAT: { tenantId: 'T1', physicalId: id() } },\n  }));",1)
s=s.replace('const definitions = approvedMemoryDefinitions(manifest);','const definitions = approvedMemoryDefinitions(manifest, { distractorCount: count });',1)
s=s.replace('    bindingsSha256: sha256Stable(bindings),','    bindingsSha256: sha256Stable(bindings),\n    liveAcceptance: \'NOT_RUN\',',1)
s=s.replace("function spies({ manifest, definitions, seedInventory, newer = 509, deniedId, changedVersionId, foreignId, membershipRole = 'standard_user' }) {", "function spies(input) {\n  const { manifest, definitions, seedInventory, newer = input.seedInventory.bindings.length - 1, deniedId, changedVersionId, foreignId, membershipRole = 'standard_user' } = structuredClone(input);")
s=s.replace('  const byLogical = new Map(seedInventory.bindings.map((row) => [row.logicalId, row]));','  const byCandidate = new Map(seedInventory.bindings.map((row) => [row.candidateId, row]));')
start=s.index('  const tx = {');end=s.index('  // Capture stable proposer',start)
s=s[:start]+'  const tx = {};\n'+s[end:]
s=s.replace("  tx.$queryRawUnsafe = async (sql, ...args) => {", "  tx.$queryRawUnsafe = async (sql, ...args) => {\n    assert.match(sql.trim(), /^SELECT/u);",1)
s=s.replace('const row = byItem.get(args[1]);','const row = byCandidate.get(args[1]);')
s=s.replace("source_version: changedVersionId === itemId ? 'unexpected-v9' : 'v1',", "source_version: changedVersionId === itemId ? 'unexpected-v9' : `candidate:${row.candidateId}`,")
s=s.replace('sections_jsonb: { content: `unit:${row.logicalId}` },', 'sections_jsonb: [{ key: \'memory\', body: `unit:${row.logicalId}` }],')
s=s.replace('assert.equal(guard.expectedPayload,', 'assert.deepEqual(guard.expectedPayload,')
s=s.replace("      itemId: row.physicalId,\n      syntheticFixtureCandidateRowVersion: row.candidateRowVersion,\n      status: 'active',\n      governedStatus: 'active',", "      syntheticFixtureCandidateId: row.candidateId,\n      syntheticFixtureMarkerSha256: row.ownershipMarkerSha256,\n      syntheticFixtureCandidateRowVersion: row.candidateRowVersion,\n      syntheticFixtureItemRowVersion: row.itemRowVersion,")
s=s.replace('return { id: itemId, tenantId: actualTenant };', "return { id: itemId, tenantId: actualTenant, clientId, status: 'active' };")
s=s.replace("ctx: { tenantId, userId: id(), role: 'standard_user' }", "ctx: { tenantId, userId: manifest.actors.PAT.physicalId, role: 'standard_user' }")
s=s.replace('  assert.throws(() => createCase12MemoryInventoryOwner({\n    manifest: data.manifest,\n    seedInventory: altered,', '  const staleOwner = createCase12MemoryInventoryOwner({\n    manifest: data.manifest,\n    seedInventory: altered,')
s=s.replace("  }), (error) => error?.code === 'CASE12_SEED_BINDING_MISMATCH');\n  assert.equal(boundary.calls.owner, 0);", "  });\n  await expectFailure(staleOwner.inspectInTx(boundary.tx, boundary.ctx, {caseId: '12', clientId: boundary.clientId}), 'CASE12_CANDIDATE_OWNER_OR_VERSION_CHANGED');\n  assert.equal(boundary.calls.owner, 0);")
s += r'''

for (const count of [500, 600]) test(`accepts exact native receipt for ${count} defined distractors only as inventory`, async () => {
  const data = await fixture(count), b = spies(data);
  const r = await makeOwner(data,b).inspectInTx(b.tx,b.ctx,{caseId:'12',clientId:b.clientId});
  assert.equal(r.observations.length,count+1); assert.equal(r.newerPermittedAsterRecordCount,count);
  assert.equal(r.fixtureReady,false); assert.equal(r.captureAuthority,false);
});
test('requires the native receipt NOT_RUN boundary, even if the receipt otherwise hashes', async () => {
  const d=await fixture(),b=spies(d); d.seedInventory.liveAcceptance='PASS';
  assert.throws(()=>makeOwner(d,b),{code:'CASE12_SEED_RECEIPT_INVALID'});
});
test('malformed seed cannot hide behind a missing manifest', async () => {
  const d=await fixture(),b=spies(d); d.seedInventory.bindingsSha256='f'.repeat(64);
  assert.throws(()=>createCase12MemoryInventoryOwner({seedInventory:d.seedInventory, proposerForTenant:b.proposerForTenant, assertSyntheticApprovedMemoryInTx:b.owner,memoryAuthorization:b.memoryAuthorization}),{code:'CASE12_SEED_RECEIPT_INVALID'});
});
test('all four native canonical proof fields must join, not just candidate row version',async()=>{
  for(const field of ['syntheticFixtureCandidateId','syntheticFixtureMarkerSha256','syntheticFixtureCandidateRowVersion','syntheticFixtureItemRowVersion']) {
    const d=await fixture(),b=spies(d), original=b.owner;
    b.owner=async(...args)=>{const proof=await original(...args);delete proof[field];return proof;};
    await expectFailure(makeOwner(d,b).inspectInTx(b.tx,b.ctx,{caseId:'12',clientId:b.clientId}),'CASE12_CANONICAL_APPROVAL_OWNER_MISMATCH');
    assert.equal(b.calls.auth,0);
  }
});
test('canonical helper rejection is not converted to a partial positive receipt',async()=>{
  const d=await fixture(),b=spies(d); b.owner=()=>{throw Object.assign(new Error('denied'),{code:'NATIVE_OWNER_DENIED'});};
  await expectFailure(makeOwner(d,b).inspectInTx(b.tx,b.ctx,{caseId:'12',clientId:b.clientId}),'NATIVE_OWNER_DENIED');
  assert.equal(b.calls.auth,0);
});
test('foreign authorization subjects are rejected before evaluating read permission',async()=>{
  for(const field of ['id','tenantId','clientId','status']) {
    const d=await fixture(),b=spies(d),load=b.memoryAuthorization.loadItemInTx;
    b.memoryAuthorization.loadItemInTx=async(...args)=>({...await load(...args),[field]:'foreign'});
    await expectFailure(makeOwner(d,b).inspectInTx(b.tx,b.ctx,{caseId:'12',clientId:b.clientId}),'CASE12_CURRENT_READ_DENIED');
    assert.equal(b.calls.auth,0);
  }
});
test('caller context mutation and replaced auth methods cannot change an in-flight inspection',async()=>{
  const d=await fixture(),b=spies(d),owner=makeOwner(d,b),sql=b.tx.$queryRawUnsafe;
  const originalUser=b.ctx.userId;
  b.tx.$queryRawUnsafe=async(...args)=>{const r=await sql(...args);b.ctx.userId=id();return r;};
  b.memoryAuthorization.evaluateInTx=()=>{throw new Error('replaced');};
  const r=await owner.inspectInTx(b.tx,b.ctx,{caseId:'12',clientId:b.clientId});
  assert.equal(r.actorUserId,originalUser);
});
test('a different ordinary user cannot substitute for manifest Pat',async()=>{
  const d=await fixture(),b=spies(d); b.ctx.userId=id();
  await expectFailure(makeOwner(d,b).inspectInTx(b.tx,b.ctx,{caseId:'12',clientId:b.clientId}),'CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH');
  assert.equal(b.calls.membership,0);
});
test('row versions outside PostgreSQL xid range reject before any native read',async()=>{
  const d=await fixture(),b=spies(d);d.seedInventory.bindings[0].itemRowVersion='4294967296';d.seedInventory.bindingsSha256=sha256Stable(d.seedInventory.bindings);
  assert.throws(()=>makeOwner(d,b),{code:'CASE12_SEED_BINDING_MISMATCH'});assert.equal(b.calls.membership,0);
});
test('missing actual canonical row cannot be reported as inspected',async()=>{
  const d=await fixture(),b=spies(d),sql=b.tx.$queryRawUnsafe;
  b.tx.$queryRawUnsafe=async(text,...args)=>text.includes('FROM memory_items')&&!text.includes('COUNT(DISTINCT')?[]:sql(text,...args);
  await expectFailure(makeOwner(d,b).inspectInTx(b.tx,b.ctx,{caseId:'12',clientId:b.clientId}),'CASE12_CANONICAL_ITEM_BINDING_MISMATCH');
});
test('impossible or fractional newer count is refused',async()=>{
  for(const newer of [510,500.5,NaN]){
    const d=await fixture(),b=spies({...d,newer});
    await expectFailure(makeOwner(d,b).inspectInTx(b.tx,b.ctx,{caseId:'12',clientId:b.clientId}),'CASE12_500_NEWER_PERMITTED_ROWS_NOT_VERIFIED');
  }
});
'''
p.write_text(s)
print('Supervised tests saved; original Hermes tests remain unchanged in its candidate directory.')
