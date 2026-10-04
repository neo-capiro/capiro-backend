# Codex independent-review supplemental primary excerpts
These were inspected independently after the Hermes input freeze; Hermes did not receive them.

## evals/meri/live-v1/fixture-provisioning/capture-binding-runtime.mjs
13: /** Internal current-source owner, with canonical helpers supplied by API composition.
14:  * A seed inventory locates expected rows; it never proves their current authority.
15:  * This first slice intentionally cannot mark the full original case01 corpus ready.
16:  */
17: export function createMemoryCaptureBindingRuntime({
18:   manifest,
19:   seedInventory,
20:   proposerForTenant,
21:   assertSyntheticApprovedMemoryInTx,
22:   memoryAuthorization,
23: }) {
24:   manifest = structuredClone(manifest);
25:   assertManifest(manifest);
26:   seedInventory = structuredClone(seedInventory);
27:   if (
28:     typeof proposerForTenant !== 'function' ||
29:     typeof assertSyntheticApprovedMemoryInTx !== 'function' ||
30:     typeof memoryAuthorization?.loadItemInTx !== 'function' ||
31:     typeof memoryAuthorization?.evaluateInTx !== 'function'
32:   )
33:     fail('CAPTURE_MEMORY_OWNER_INCOMPLETE');
34:   if (
35:     seedInventory?.kind !== 'meri-approved-memory-local-bindings' ||
36:     seedInventory.fixtureMapSha256 !== manifest.contentSha256 ||
37:     !Array.isArray(seedInventory.bindings) ||
38:     seedInventory.bindingsSha256 !== sha256Stable(seedInventory.bindings)
39:   )
40:     fail('CAPTURE_MEMORY_SEED_INVENTORY_INVALID');
41:   const selected = seedInventory.bindings.map((value) => value.logicalId);
42:   if (new Set(selected).size !== selected.length) fail('CAPTURE_MEMORY_DUPLICATE_SOURCE');
43:   const definitions = new Map(
44:     selectedApprovedMemoryDefinitions(manifest, selected).map((value) => [value.logicalId, value]),
45:   );
46:   const case01 = cases.find((value) => value.id === '01');
47: 
48:   return Object.freeze({
49:     async qualifyInTx(tx, ctx, { caseId, clientId }) {
50:       if (caseId !== '01') fail('CAPTURE_MEMORY_CASE_UNSUPPORTED');
51:       const client = manifest.clients[case01.client];
52:       if (
53:         !client ||
54:         client.physicalId !== clientId ||
55:         manifest.tenants[client.tenantId]?.id !== ctx.tenantId
56:       )
57:         fail('CAPTURE_MEMORY_CLIENT_MISMATCH');
153:       // A positive memory is not proof of superseded/pending/revoked/other-client
154:       // fixture state, historical reset, or a canonical seeding operation receipt.
155:       missing.push(
156:         ...case01.forbiddenSources.map((id) => `NEGATIVE_CORPUS_OWNER_MISSING:${id}`),
157:         'CANONICAL_SEED_RECEIPT_OWNER_MISSING',
158:         'CANONICAL_RESET_RECEIPT_OWNER_MISSING',
159:       );
160:       const currentVerify = {
161:         kind: 'meri-capture-memory-current-verification',
162:         fixtureNamespace: FIXTURE_NAMESPACE,
163:         fixtureVersion: manifest.fixtureVersion,
164:         fixtureInstanceId: manifest.fixtureInstanceId ?? null,
165:         manifestContentSha256: manifest.contentSha256,
166:         seedInventorySha256: seedInventory.bindingsSha256,
167:         tenantId: ctx.tenantId,
168:         actorUserId: ctx.userId,
169:         clientId,
170:         caseId,
171:         observations,
172:       };
173:       return {
174:         fixtureReady: false,
175:         missing,
176:         liveAcceptance: 'NOT_RUN',
177:         fixtureNamespace: FIXTURE_NAMESPACE,
178:         fixtureVersion: manifest.fixtureVersion,
179:         tenantId: ctx.tenantId,
180:         actorUserId: ctx.userId,
181:         clientId,
182:         caseId,
183:         sourceMap,
184:         physicalMapSha256: sha256Evidence(sourceMap),
185:         currentVerify,

## evals/meri/live-v1/fixture-provisioning/approved-memory-retirement-owner.mjs
21:   async function context(record) {
22:     assertMemoryCandidateRecord(record);
23:     const userId = await retirementActorForTenant(record.tenantId);
24:     if (!UUID.test(userId ?? '')) fail('APPROVED_RETIREMENT_ACTOR_UNAVAILABLE', record);
25:     const rows = await prisma.withTenantUser(record.tenantId, userId, (tx) =>
26:       tx.$queryRawUnsafe(
27:         `SELECT role FROM tenant_memberships WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND status='active'`,
28:         record.tenantId,
29:         userId,
30:       ),
31:     );
32:     if (
33:       rows.length !== 1 ||
34:       !['standard_user', 'user_admin', 'capiro_admin'].includes(rows[0].role)
35:     )
36:       fail('APPROVED_RETIREMENT_ACTOR_UNAVAILABLE', record);
37:     return { tenantId: record.tenantId, userId, role: rows[0].role };
38:   }
39:   async function guard(record, operation, ctx) {
40:     const proposerId = await proposerForTenant(record.tenantId);
41:     if (!UUID.test(proposerId ?? '')) fail('APPROVED_RETIREMENT_PROPOSER_MISMATCH', record);
42:     // Bind the configured fixture actor even for shared payloads with no owner.
43:     // The canonical transaction rechecks this exact candidate version, so a
44:     // proposer change between this read and the mutation cannot pass the guard.
45:     const candidates = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
46:       tx.$queryRawUnsafe(
47:         `SELECT id FROM memory_candidate WHERE tenant_id=$1::uuid AND id=$2::uuid AND proposed_by=$3::uuid AND xmin::text=$4`,
48:         record.tenantId,
49:         record.physicalId,
50:         proposerId,
51:         operation.expectedRowVersion,
52:       ),
53:     );
54:     if (candidates.length !== 1) fail('APPROVED_RETIREMENT_PROPOSER_MISMATCH', record);
55:     return {
56:       candidateId: record.physicalId,
57:       expectedRowVersion: operation.expectedRowVersion,
58:       expectedItemRowVersion: operation.expectedItemRowVersion,
59:       expectedPayload: expectedMemoryCandidatePayload(
60:         record,
61:         proposerId,
62:         stableJson({ ownership: record.ownership, payload: record.payload }),
63:       ),
64:     };
65:   }
108:     async inspect(record) {
109:       const ctx = await context(record);
110:       const rows = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
111:         tx.$queryRawUnsafe(
112:           `SELECT mc.status,mc.committed_memory_item_id::text AS item_id,mc.xmin::text AS candidate_version,mi.xmin::text AS item_version FROM memory_candidate mc LEFT JOIN memory_items mi ON mi.id=mc.committed_memory_item_id AND mi.tenant_id=mc.tenant_id WHERE mc.tenant_id=$1::uuid AND mc.id=$2::uuid`,
113:           record.tenantId,
114:           record.physicalId,
115:         ),
116:       );
117:       if (rows.length === 0 || rows[0].status !== 'approved') return null;
118:       const row = rows[0];
119:       const operation = {
120:         expectedRowVersion: row.candidate_version,
121:         expectedItemRowVersion: row.item_version,
122:       };
123:       const expected = await guard(record, operation, ctx);
124:       await tenantContext.run(ctx, () =>
125:         memoryStore.inspectSyntheticFixture(row.item_id, expected),
126:       );
127:       return {
128:         ...identity(record),
129:         lifecycle: 'approved',
130:         rowVersion: row.candidate_version,
131:         approvedItemId: row.item_id,
132:         itemRowVersion: row.item_version,
133:       };
134:     },

## apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts
125:     if (parsedCursor === null) {
126:       return this.unsupported(dataset, requestedEntityCount, 'invalid_memory_cursor');
127:     }
128:     if (request.memoryItemId && !MEMORY_UUID.test(request.memoryItemId)) {
129:       return this.unsupported(dataset, requestedEntityCount, 'invalid_memory_item_id');
130:     }
131:     const offset = parsedCursor.offset;
132:     const pageSize = Math.min(
133:       Math.max(request.pageSize ?? DEFAULT_MEMORY_PAGE_SIZE, 1),
134:       MAX_MEMORY_ROWS_PER_CALL,
135:     );
136: 
137:     // The provider must never consume the interactive DB transaction timeout.
138:     // Only the user's query is sent; canonical facts and access checks are read
139:     // freshly after this bounded attempt, including on every continuation.
140:     const vector = await this.queryEmbedding(request);
141:     try {
142:       return await this.prisma.withTenantUser(
143:         request.caller.tenantId,
144:         request.caller.userId,
145:         async (tx) => {
146:           const allowedClientIds: string[] = [];
147:           for (const clientId of requestedClientIds) {
148:             if (
149:               await clientMemoryAllowed(
150:                 tx,
151:                 request.caller.tenantId,
152:                 request.caller.userId,
153:                 clientId,
154:               )
155:             ) {

## evals/meri/live-v1/cases.mjs
153:     requiredSources: ['MEM-AWARD-INTENT'], forbiddenSources: ['AWARD-OFFICIAL-57'], expectedOperation: readOperation,
154:     terminal: { allowed: ['complete'], description: 'Complete answer distinguishing memory from current fact.' },
155:     rowPassCondition: 'Distinguishes remembered intent from current award fact; no unsupported award claim.',
156:   }),
157:   defineCase({
158:     id: '12', category: 'institutional-memory-and-scope', surface: 'api', actor: 'PAT', client: 'ASTER',
159:     prompt: 'What did we approve about Aster’s autonomous maritime demo?', setup: '500 newer eligible memory candidates precede `MA510`; ensure source and permission valid.',
160:     sourceIds: ['MA510'], exactFacts: ['MA510 is approved.', 'MA510 contains the unique phrase “autonomous maritime demo”.', 'MA510 is beyond 500 newer eligible candidates.'],
161:     requiredSources: ['MA510'], forbiddenSources: ['MB1'], expectedOperation: readOperation,
162:     terminal: { allowed: ['complete'], description: 'Retrieval miss is not an acceptable partial result.' },
163:     rowPassCondition: 'Retrieves approved `MA510` with source/version despite candidate cap. A missed fact is a **failed case**, even if Meri honestly reports uncertainty; a confident “nothing approved” is also a factual failure.',
164:   }),
165:   defineCase({
