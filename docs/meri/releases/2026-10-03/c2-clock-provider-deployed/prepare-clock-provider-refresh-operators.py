from pathlib import Path
import hashlib
import json

root = Path('C:/dev/main/outputs/meri-c2-20261003')
sha = lambda data: hashlib.sha256(data).hexdigest()


def save(name, text):
    with (root / name).open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(text)


schema = (root / 'read-clock-provider-schema.mjs').read_text(encoding='utf-8')
assert schema.count("root=parent+'/clock-provider-current-schema-v1'") == 1
schema = schema.replace("root=parent+'/clock-provider-current-schema-v1'", "root=parent+'/clock-provider-current-schema-v2'")
schema = schema.replace("const c=definition.containerDefinitions[0];", "assert.equal(hash(readFileSync(parent+'/corpus-read-definition-input.json')),'6c0a447dc99ed35642df735c38d09e02b12b33983fe461b707cd0c06a8a44478');\nassert.equal(hash(body),'466f94130c5b7396ed5c9e9c3474bca95c99881adeb1aad4f6fb2f6b9f0ce386');\nconst c=definition.containerDefinitions[0];")
save('read-clock-provider-schema-v2.mjs', schema)

prepare = (root / 'prepare-clock-provider-release.mjs').read_text(encoding='utf-8')
before = "save('clock-provider-release-packet.json',packet);"
assert prepare.count(before) == 1
replacement = """const approvedPacket=JSON.parse(readFileSync(root+'/clock-provider-release-packet.json','utf8'));
const approval=JSON.parse(readFileSync(root+'/clock-provider-human-approval.json','utf8'));
assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_CLOCK_PROVIDER_RELEASE');
assert.equal(approval.packetSha256,fingerprint(approvedPacket));
assert.deepEqual({...packet,preparedAt:approvedPacket.preparedAt,expiresAt:approvedPacket.expiresAt},approvedPacket,'Approved release scope changed');
const currentSchema=JSON.parse(readFileSync(root+'/clock-provider-current-schema-v2/result.json','utf8'));
const cleanup=JSON.parse(readFileSync(root+'/clock-provider-current-schema-v2/cleanup.json','utf8'));
assert.equal(currentSchema.exitCode,0);assert.equal(currentSchema.receipts.length,1);assert.equal(currentSchema.receipts[0].status,'VERIFIED_READ_ONLY');
assert.ok(Date.parse(currentSchema.at)>Date.now()-30*60000);assert.equal(cleanup.taskStopped,true);assert.equal(cleanup.status,'INACTIVE');
const oldSchema=versioned('current-schema/result.json');assert.deepEqual(currentSchema.receipts[0],oldSchema.receipts[0]);
save('clock-provider-release-packet-refreshed.json',packet);
save('clock-provider-release-refresh.json',{status:'IDENTICAL_APPROVED_SCOPE_REVALIDATED',recordedAt:new Date().toISOString(),
  originalPacketSha256:fingerprint(approvedPacket),refreshedPacketSha256:fingerprint(packet),humanApprovalSha256:fingerprint(approval),
  changes:['preparedAt','expiresAt'],scopeChanged:false,candidateChanged:false,baselineChanged:false,configurationChanged:false,
  currentSchemaPath:'clock-provider-current-schema-v2/result.json',currentSchemaSha256:fingerprint(currentSchema),
  freshCloudImageAndBaselineChecks:true,originalSnapshotExpiryBypassed:false,
  approvalBasis:'Direct human approval of the exact original scope; successor changes freshness timestamps only.',awsWritesByPacketPreparation:0});"""
prepare = prepare.replace(before, replacement)
prepare = prepare.replace("save('clock-provider-release-packet.md',", "save('clock-provider-release-packet-refreshed.md',")
prepare = prepare.replace('[Full packet and operation order](clock-provider-release-packet.json)', '[Full packet and operation order](clock-provider-release-packet-refreshed.json)')
prepare = prepare.replace('Human approval for these exact new images is pending.', 'The human has approved these exact images. This successor refresh changes timestamps only; the original packet and approval are retained in the linked refresh receipt.')
save('prepare-clock-provider-release-refreshed.mjs', prepare)

continuity = """const approvedPacket=read('clock-provider-release-packet.json'),refresh=read('clock-provider-release-refresh.json');
assert.equal(approval.packetSha256,fingerprint(approvedPacket));
assert.equal(refresh.status,'IDENTICAL_APPROVED_SCOPE_REVALIDATED');assert.equal(refresh.originalPacketSha256,fingerprint(approvedPacket));
assert.equal(refresh.refreshedPacketSha256,fingerprint(packet));assert.equal(refresh.humanApprovalSha256,fingerprint(approval));
assert.deepEqual({...packet,preparedAt:approvedPacket.preparedAt,expiresAt:approvedPacket.expiresAt},approvedPacket);
assert.equal(refresh.scopeChanged,false);assert.equal(refresh.baselineChanged,false);
"""
promote = (root / 'promote-clock-provider-service.mjs').read_text(encoding='utf-8')
promote = promote.replace("const packet=read('clock-provider-release-packet.json')", "const packet=read('clock-provider-release-packet-refreshed.json')", 1)
assert promote.count('assert.equal(approval.packetSha256,fingerprint(packet));') == 1
promote = promote.replace('assert.equal(approval.packetSha256,fingerprint(packet));', continuity, 1)
save('promote-clock-provider-service-v2.mjs', promote)

verify = (root / 'verify-clock-provider-served.mjs').read_text(encoding='utf-8')
verify = verify.replace("const packet=read('clock-provider-release-packet.json')", "const packet=read('clock-provider-release-packet-refreshed.json')", 1)
assert verify.count('assert.equal(approval.packetSha256,fingerprint(packet));') == 1
verify = verify.replace('assert.equal(approval.packetSha256,fingerprint(packet));', continuity, 1)
save('verify-clock-provider-served-v2.mjs', verify)
print(json.dumps({'status':'PREPARED_NO_REMOTE_ACTIONS','files':[{'path':p,'sha256':sha((root/p).read_bytes())} for p in ['read-clock-provider-schema-v2.mjs','prepare-clock-provider-release-refreshed.mjs','promote-clock-provider-service-v2.mjs','verify-clock-provider-served-v2.mjs']]}))
