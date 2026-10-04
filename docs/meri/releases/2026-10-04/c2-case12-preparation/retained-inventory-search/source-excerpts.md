# Source excerpts supporting the bounded inventory result

## docs/meri/implementation/01-continuation-2026-09-30.md
31: Source commit: `c22ed8525ad54c1a5c43b131a2660604ba59454b`; integration cherry-pick: `c994be504`.
32: 
33: The [approved-memory runtime](../../../evals/meri/live-v1/fixture-provisioning/approved-memory-runtime.md) composes the actual proposal, guarded approval and canonical store owners. It creates MA510 before 509 supporting memories and returns the actual allocated item IDs with candidate IDs, current versions and ownership/content hashes. Prospective manifest IDs are never presented as actual canonical item IDs. Approval rechecks current reviewer membership and exact pending content/version under the real transaction lock. Retirement retains approved-candidate history, revoked items, audit and cleanup intent. No public route or ordinary approval bypass was added.
34: 
35: Qualification: **8/8 tests, exit 0**, including six actual PostgreSQL service integrations; all 510 memories were approved, read and retired through the current owners, then disposable writes were rolled back and random-schema absence independently verified. Existing candidate regressions: **30/30, five suites, exit 0**. Targeted TypeScript over 1,148 source/dependency files had zero diagnostics. Independent actual Hermes/Kimi re-review and final dependency-check delta returned PASS, exit 0. Initial incorrect reviewer premises and valid hardening findings are separately retained with dispositions.
36: 
37: This used a deliberately minimal isolated schema. The later full 449-migration database qualification is a different check. Full-schema/RLS behavior, real application recall/citations, trusted capture binding and original case 12 remain NOT RUN. Generic `memory_item` availability remains unavailable until actual application integration proves the returned physical bindings; no manifest or LIVE guard was loosened.
67: Protected evidence root on the execution host: `C:\dev\cap-meri-foundation-evidence\file01-parallel-20260930`. Sanitized qualification receipts:
68: 
69: - `local-pgvector/root-build-verification.json`: source and artifact hashes, build exit 0.
70: - `local-pgvector/runtime-qualification.json`: extension execution and rollback, exit 0.
71: - `local-full-migration-replay-attempt2.json`: 449 matching applied migrations, exit 0.
72: - `owned-api-db-role.json`: runtime-role privilege and connection checks, exit 0.
73: - `owned-pg-rotation.json`: prior disposable credential rotation and successful readback, no secret values.
74: 
75: ## Remaining completion conditions
76: 
77: The original audit's acceptance counts and hard gates remain in force: **75 original cases, 7 CD cases, 8 required CW cases and applicable M cases have not completed served acceptance**. Complete the canonical source fixtures and physical-ID bindings, trusted capture/source/byte/parser/usage observations, missing row predicates, actual authenticated application/UI runs and fault scenarios, human rubric, exact release/schema compatibility and deployed trace/rollback verification. Local SQL qualification does not establish AWS schema compatibility. UI deployment remains exclusively `os.capiro.ai` through `web-vnext`.
78: 
79: Keep File02/03 and a separate Defense chat out of this task. Existing Meri Defense Budget/PE/Research Portfolio behavior remains part of File01.
80: 
81: ## Next bounded worker assignments
82: 
83: 1. **Full-schema fixture composition.** Reuse `createApprovedMemoryFixtureRuntime` with the real application Prisma/memory services on the explicitly owned disposable database. The 55433 rollback probe did not seed the new 55435 database. Do not repoint its minimal-schema harness. Verify the actual server identity, ordinary runtime role, approved synthetic tenant/user/client memberships and real reviewer; persist MA510 plus supporting records long enough for HTTP readback, then retire through the owner. Bind actual physical IDs, versions and retained receipts to the exact fixture instance.
84: 2. **Controlled local capture.** Reuse existing `/api/clio/conversations`, conversation stream/messages, `/api/clio/sources`, policy issuer and current-authority readback. Wire the already-supported `configureApiHttpApp.releaseShaHeader` option in the main API to independently verified build identity. Extend the controlled transport from cases 01/20 to the matching MA510 case 12, and supply its existing programmatic `controlledReceiptContext` from real server/owner observations. Do not trust caller-selected receipt strings or relax remote LIVE guards.
85: 3. **Runtime and evidence qualification.** Launch only with an explicitly bounded environment: loopback API/orchestrator URLs and ports, real synthetic Clerk identities, exact V3 tenant flags/allowlists and matching internal secret. The API/orchestrator require their actual application provider credentials; Hermes Bedrock configuration does not supply those. Avoid ambient dotenv/shared service configuration. Preserve real raw exchanges, canonical source readbacks, signed receipts and cleanup evidence. A valid signature is insufficient without independent fixture/build/source/tool/effect/usage crosschecks and server-owned spend reservation.

## evals/meri/live-v1/fixture-provisioning/approved-memory-runtime.mjs
16:   const ownership = ownedIdentity(
17:     // Canonical synthetic candidate markers accept uppercase identifiers. Keep
18:     // the frozen logical source ID unchanged in sourceLogicalId and receipts.
19:     `APPROVED-${logicalId.toUpperCase()}`,
20:     source.tenantId,
21:     'memory_candidate',
22:     manifest.fixtureVersion,
23:     manifest.fixtureInstanceId,
24:   );
25:   const payload = {
26:     fixtureKind: 'approved_memory_fixture',
27:     facts,
28:     sourceAsset: null,
29:     sourceLogicalId: logicalId,
30:     supporting,
31:   };
32:   return {
33:     logicalId,
34:     supporting,
35:     proposedItemId: supporting ? null : source.physicalId,
36:     candidate: {
37:       ...source,
38:       logicalId: ownership.marker.logicalId,
39:       owner: 'memory_candidate',
40:       physicalId: ownership.physicalId,
41:       ownership,
42:       payload,
43:       payloadSha256: sha256Stable(payload),
44:     },
45:   };
109: export function approvedMemoryDefinitions(manifest, { distractorCount = 509 } = {}) {
110:   assertManifest(manifest);
111:   if (!Number.isInteger(distractorCount) || distractorCount < 500 || distractorCount > 600)
112:     fail('APPROVED_MEMORY_DISTRACTOR_COUNT_INVALID', 'MA510');
113:   const source = manifest.records.find((record) => record.logicalId === 'MA510');
114:   if (!source || source.owner !== 'memory_item' || source.payload.facts.lifecycle !== 'approved')
115:     fail('APPROVED_MEMORY_SOURCE_INVALID', 'MA510');
116:   const inputs = [
117:     { logicalId: 'MA510', facts: source.payload.facts, supporting: false },
118:     ...Array.from({ length: distractorCount }, (_, index) => ({
119:       logicalId: `MA510-DISTRACTOR-${String(index + 1).padStart(4, '0')}`,
120:       facts: {
121:         lifecycle: 'approved',
122:         text: `Synthetic archive preference ${String(index + 1).padStart(4, '0')}: use the routine quarterly checklist`,
123:       },
124:       supporting: true,
125:     })),
126:   ];
127:   return inputs.map((input) => approvedCandidateDefinition(manifest, source, input));
230:     if (!proof || !UUID.test(proof.approvedItemId ?? ''))
231:       fail('APPROVED_MEMORY_READBACK_REQUIRED', entry.logicalId);
232:     return {
233:       logicalId: entry.logicalId,
234:       supporting: entry.supporting,
235:       owner: 'memory_item',
236:       tenantId: entry.candidate.tenantId,
237:       clientId: entry.candidate.clientPhysicalId,
238:       physicalId: proof.approvedItemId,
239:       proposedItemId: entry.proposedItemId,
240:       candidateId: entry.candidate.physicalId,
241:       ownershipMarkerSha256: entry.candidate.ownership.markerSha256,
242:       candidatePayloadSha256: entry.candidate.payloadSha256,
243:       candidateRowVersion: proof.rowVersion,
244:       itemRowVersion: proof.itemRowVersion,
245:       lifecycle: 'approved',
246:     };
247:   }
248: 
249:   async function inspect(logicalId) {
250:     const entry = definition(logicalId);
251:     await reviewer(entry.candidate);
252:     const proof = await retirement.inspect(entry.candidate);
253:     return proof ? binding(entry, proof) : null;
254:   }
255: 
256:   async function create(logicalId) {
257:     const entry = definition(logicalId);
258:     const record = entry.candidate;
259:     const ctx = await reviewer(record);
260:     const existing = await inspect(logicalId);
261:     if (existing) return existing;
262:     let pending = await candidates.read(record);
263:     if (!pending) {
264:       await candidates.create(record, {
265:         tenantId: record.tenantId,
266:         physicalId: record.physicalId,
267:         expectedOwnershipMarkerSha256: record.ownership.markerSha256,
348:   return Object.freeze({
349:     logicalIds: Object.freeze(definitions.map((entry) => entry.logicalId)),
350:     inspect,
351:     create,
352:     retire,
353:     inspectRetirement,
354:     async createDataset() {
355:       const bindings = [];
356:       // MA510 must predate the supporting rows; do not parallelize this loop.
357:       for (const entry of definitions) bindings.push(await create(entry.logicalId));
358:       return Object.freeze({
359:         kind: 'meri-approved-memory-local-bindings',
360:         fixtureMapSha256: manifest.contentSha256,
361:         bindings,
362:         bindingsSha256: sha256Stable(bindings),
363:         liveAcceptance: 'NOT_RUN',
364:       });

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

## evals/meri/live-v1/tests/approved-memory-runtime.postgres.test.mjs
20: describe(
21:   'approved-memory runtime over actual canonical services and owned PostgreSQL',
22:   { skip: !configPath },
23:   () => {
24:     it('creates MA510 before 509 approved distractors and binds actual items, retrying without duplicates', async () => {
25:       await withOwnedApprovedMemory(
26:         configPath,
27:         async ({ runtime, tx, manifest, projectionCalls, memoryStore, tenantContext }) => {
28:           const receipt = await runtime.createDataset();
29:           assert.equal(receipt.bindings.length, 510);
30:           assert.equal(receipt.liveAcceptance, 'NOT_RUN');
31:           assert.equal(new Set(receipt.bindings.map((row) => row.physicalId)).size, 510);
32:           const binding = receipt.bindings[0];
33:           assert.equal(binding.logicalId, 'MA510');
34:           assert.notEqual(binding.physicalId, binding.proposedItemId);
35:           assert.deepEqual(await runtime.create('MA510'), binding);
36:           const rows = await tx.$queryRawUnsafe(
76:               )
77:             )[0].n,
78:             0,
79:           );
80:           const retired = await runtime.retireDataset(receipt);
81:           assert.equal(retired.proofs.length, 510);
82:           assert.ok(
83:             retired.proofs.every(
84:               (proof) => proof.retained && proof.itemGovernedStatus === 'revoked',
85:             ),
86:           );
87:           assert.deepEqual(
88:             (
89:               await tx.$queryRawUnsafe(`SELECT
90:         (SELECT count(*)::int FROM memory_candidate WHERE status='approved') AS candidates,
91:         (SELECT count(*)::int FROM memory_items WHERE status='revoked') AS items,
92:         (SELECT count(*)::int FROM memory_cleanup_outbox WHERE operation='revoke_projections') AS outbox,

## evals/meri/live-v1/tests/approved-memory-postgres-harness.mjs
171:           const projectionCalls = [];
172:           memoryCandidates.dispatchProjectionFastPath = (...args) => {
173:             projectionCalls.push(args.slice(0, 2));
174:           };
175:           const manifest = await buildFixtureManifest({
176:             fixtureInstanceId: randomUUID(),
177:             clients: {
178:               ASTER: { tenantId: 'T1', physicalId: CLIENT },
179:               BLUEHAVEN: { tenantId: 'T1', physicalId: OTHER_CLIENT },
180:               CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
181:             },
182:           });
183:           const deps = {
184:             manifest,
185:             memoryCandidates,
186:             memoryStore,
187:             tenantContext,
200:             memoryStore,
201:             memoryCandidates,
202:             tenantContext,
203:           });
204:           completed = true;
205:           throw rollback;
206:         },
207:         { timeout: 240_000, maxWait: 10_000 },
208:       );
209:     } catch (error) {
210:       if (error !== rollback) throw error;
211:     }
212:     assert.equal(completed, true, 'Qualification callback completed before rollback');
213:     return result;
214:   } finally {
215:     await prisma?.$disconnect();
216:     for (const [key, value] of beforeEnv) {
217:       if (value === undefined) delete process.env[key];
218:       else process.env[key] = value;
219:     }
220:     try {
221:       const residue = await probe.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
222:       assert.equal(
223:         residue.rowCount,
224:         0,
225:         'Owned schema and all fixture data must be absent after rollback',

## apps/api/src/memory/synthetic-approved-memory.helpers.ts
124:     Number(guard.expectedItemRowVersion) > 0xffffffff
125:   )
126:     deny();
127:   const candidates = await tx.$queryRaw<
128:     Array<{ proposedBy: string; approvedBy: string; clioId: string }>
129:   >`
130:     SELECT proposed_by::text AS "proposedBy", approved_by_user_id::text AS "approvedBy",
131:            committed_memory_id::text AS "clioId"
132:     FROM memory_candidate
133:     WHERE tenant_id=${ctx.tenantId}::uuid AND id=${guard.candidateId}::uuid
134:       AND xmin::text=${guard.expectedRowVersion} AND status='approved' AND governed_status='active'
135:       AND committed_memory_item_id=${itemId}::uuid AND committed_memory_id IS NOT NULL
136:       AND source_kind='model_extraction' AND source_type='meri_synthetic_fixture'
137:       AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
138:       AND decided_by=approved_by_user_id AND decided_at=approved_at
139:       AND legal_hold=false AND instructions_allowed=false AND confidence IS NULL
140:       AND revision_number=1 AND revision_root_id IS NULL AND predecessor_candidate_id IS NULL
141:       AND superseded_by_id IS NULL AND duplicate_of_id IS NULL AND contradicts_id IS NULL
142:       AND duplicate_memory_item_id IS NULL AND contradicts_memory_item_id IS NULL
143:       AND second_approved_by_user_id IS NULL AND second_approved_at IS NULL
144:       AND conflict_status='none' AND conflict_group_id IS NULL AND controlling_item_id IS NULL
145:       AND retention_policy_jsonb IS NULL AND expires_at IS NULL AND valid_until IS NULL
146:     FOR UPDATE
147:   `;
148:   const candidate = candidates[0];
149:   if (candidates.length !== 1 || !candidate) deny();
150:   const expected = validateSyntheticCandidateFixtureIdentity(
151:     ctx.tenantId,
152:     candidate.proposedBy,
153:     guard.candidateId,
154:     guard,
155:   );
156:   const membership = await tx.$queryRaw<Array<{ id: string }>>`
157:     SELECT tm.user_id::text AS id FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id
158:     WHERE tm.tenant_id=${ctx.tenantId}::uuid AND tm.user_id=${ctx.userId}::uuid
159:       AND tm.status='active' AND tm.role::text=${ctx.role}
160:       AND t.slug=${expected.tenantSlug}
161:     FOR SHARE OF tm,t
162:   `;
163:   if (membership.length !== 1) deny();
164:   if (expected.clientId) {
165:     await tx.$queryRaw`SELECT id FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${expected.clientId}::uuid FOR SHARE`;
166:     await tx.$queryRaw`SELECT user_id FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${expected.clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
167:     await tx.$queryRaw`SELECT id FROM memory_access_grant WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${expected.clientId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
168:   }
169:   const record = {
170:     key: expected.payload.key as string,
171:     value: expected.payload.value as string,
172:     source: 'meri_synthetic_fixture',
173:     scope: expected.payload.scope as 'firm' | 'client' | 'user_private',
188:     tenantId: ctx.tenantId,
189:     userId: candidate.proposedBy,
190:     sourceConversationId: null,
191:     sourceMessageId: null,
192:     sourceExcerpt: expected.sourceExcerpt,
193:   };
194:   const matching = await tx.$queryRaw<Array<{ id: string }>>`
195:     SELECT id FROM memory_candidate WHERE id=${guard.candidateId}::uuid AND tenant_id=${ctx.tenantId}::uuid
196:       AND source_id=${expected.markerSha256} AND scope=${expected.scope}
197:       AND client_id IS NOT DISTINCT FROM ${expected.clientId}::uuid
198:       AND payload_jsonb=${JSON.stringify(expected.payload)}::jsonb AND provenance_jsonb=${JSON.stringify(provenance)}::jsonb
199:       AND memory_class=${governance.memoryClass} AND memory_authority=${governance.memoryAuthority}
200:       AND memory_scope=${governance.memoryScope}
201:   `;
202:   if (matching.length !== 1) deny();
203:   const sections = [
204:     { key: 'memory', heading: 'Memory', owner: 'human', body: record.value.trim() },
205:   ];
206:   const items = await tx.$queryRaw<Array<{ id: string }>>`
207:     SELECT id FROM memory_items WHERE id=${itemId}::uuid AND tenant_id=${ctx.tenantId}::uuid
208:       AND ((${retired}=false AND xmin::text=${guard.expectedItemRowVersion})
209:         OR (${retired}=true AND xmin::text<>${guard.expectedItemRowVersion}))
210:       AND status=${lifecycle} AND governed_status=${lifecycle}
211:       AND slug=${`clio:${candidate.clioId}`} AND type=${governance.canonicalType} AND title=${record.key}
212:       AND visibility=${record.scope === 'user_private' ? 'user' : 'tenant'}
213:       AND owner_user_id IS NOT DISTINCT FROM ${record.ownerUserId}::uuid
214:       AND client_id IS NOT DISTINCT FROM ${record.clientId}::uuid
215:       AND sections_jsonb=${JSON.stringify(sections)}::jsonb AND source='manual' AND provenance='human'
216:       AND source_ref='meri_synthetic_fixture' AND source_type=${governance.sourceType}
217:       AND source_id=${guard.candidateId} AND source_version=${governance.sourceVersion}
218:       AND source_excerpt=${governance.sourceExcerpt} AND source_content_hash=${governance.sourceContentHash}
219:       AND memory_class=${governance.memoryClass} AND memory_authority=${governance.memoryAuthority}
220:       AND memory_scope=${governance.memoryScope} AND asserted_by_user_id=${candidate.proposedBy}::uuid
221:       AND approved_by_user_id=${candidate.approvedBy}::uuid AND approved_at IS NOT NULL
222:       AND legal_hold=false AND instructions_allowed=false AND retention_policy_jsonb IS NULL
223:       AND second_approved_by_user_id IS NULL AND second_approved_at IS NULL
224:       AND conflict_status='none' AND conflict_group_id IS NULL AND controlling_item_id IS NULL
225:       AND expires_at IS NULL AND valid_until IS NULL AND confidence IS NULL
226:       AND review_due_at IS NULL AND review_state='confirmed' AND last_confirmed_at=approved_at
227:       AND sensitivity='normal' AND schema_version=1 AND entity_id IS NULL
228:       AND aliases=ARRAY[]::text[] AND tags=ARRAY['memory','meri_synthetic_fixture']::text[]
229:     FOR UPDATE

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

## apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts
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
167:           const rows = await tx.$queryRaw<GovernedMemoryRow[]>(Prisma.sql`
168:           WITH eligible_base AS NOT MATERIALIZED (
169:             SELECT mi.*,
170:                    COALESCE(body_projection.body, '') AS recall_body
171:             FROM memory_items mi
172:             LEFT JOIN LATERAL (
173:               SELECT STRING_AGG(section.value ->> 'body', E'\n\n' ORDER BY section.ordinality) AS body
174:               FROM JSONB_ARRAY_ELEMENTS(
175:                 CASE
176:                   WHEN JSONB_TYPEOF(mi.sections_jsonb) = 'array' THEN mi.sections_jsonb
177:                   ELSE '[]'::jsonb
178:                 END
179:               ) WITH ORDINALITY AS section(value, ordinality)
180:               WHERE JSONB_TYPEOF(section.value) = 'object'
181:                 AND JSONB_TYPEOF(section.value -> 'body') = 'string'
182:             ) body_projection ON TRUE
183:             WHERE mi.tenant_id = ${request.caller.tenantId}::uuid
184:               AND (mi.visibility = 'tenant' OR mi.owner_user_id = ${request.caller.userId}::uuid)
185:               AND mi.status = 'active'
186:               ${request.memoryItemId ? Prisma.sql`AND mi.id = ${request.memoryItemId}::uuid` : Prisma.empty}
187:               AND mi.memory_class IN ('institutional_authoritative', 'client_steering', 'user_preference', 'episodic_working')
188:               AND (mi.memory_scope <> 'user_private' OR mi.owner_user_id = ${request.caller.userId}::uuid)
189:               AND (mi.memory_scope <> 'client' OR mi.client_id = ANY(${allowedClientIds}::uuid[]))
190:               AND (
191:                 mi.memory_class NOT IN ('institutional_authoritative', 'client_steering')
192:                 OR mi.approved_by_user_id IS NOT NULL
193:               )
194:               AND (
195:                 mi.source_type <> 'unknown'
196:                 OR mi.source_ref IS NOT NULL
197:                 OR mi.source_id IS NOT NULL
198:               )
199:               AND (
200:                 mi.memory_class <> 'episodic_working'
201:                 OR mi.expires_at IS NOT NULL
202:                 OR mi.valid_until IS NOT NULL
203:               )
204:               AND COALESCE(mi.sensitivity, 'normal') = 'normal'
205:               AND (mi.expires_at IS NULL OR mi.expires_at > now())
206:               AND (mi.valid_until IS NULL OR mi.valid_until > now())
207:               AND (mi.effective_from IS NULL OR mi.effective_from <= now())
208:               AND (mi.client_id IS NULL OR mi.client_id = ANY(${allowedClientIds}::uuid[]))
209:               AND ${Prisma.raw(governedRecallEligibilitySql('mi'))}
210:           ), eligible AS NOT MATERIALIZED (
211:             SELECT mi.*, ${memoryLexicalScoreSql(request.query ?? '', 'mi')} AS recall_lexical_score
212:             FROM eligible_base mi
213:           ), lexical_candidates AS (
214:             SELECT mi.id,
215:                    ROW_NUMBER() OVER (
216:                      ORDER BY mi.recall_lexical_score DESC, mi.updated_at DESC, mi.id ASC
217:                    ) AS lexical_rank
218:             FROM eligible mi
219:             ORDER BY mi.recall_lexical_score DESC, mi.updated_at DESC, mi.id ASC
220:             LIMIT ${MEMORY_CANDIDATE_LOOKAHEAD}

## evals/meri/live-v1/deterministic-predicates.mjs
254:   } else if (id === '12') {
255:     const setup = artifacts.setup;
256:     const candidates = setup?.candidates;
257:     if (!Array.isArray(candidates)) defects.push('case 12 setup artifact has no candidate rows');
258:     else {
259:       const target = candidates.find((item) => item?.sourceId === 'MA510');
260:       const newer = candidates.filter((item) => item?.eligible === true && Number.isInteger(item?.retrievalOrdinal) && item.retrievalOrdinal < 510 && item.sourceId !== 'MA510');
261:       if (new Set(newer.map((item) => item.sourceId)).size < 500) defects.push('case 12 setup does not contain 500 distinct newer eligible distractors');
262:       if (!target || target.eligible !== true || target.lifecycle !== 'approved' || target.retrievalOrdinal !== 510) defects.push('case 12 setup does not contain eligible approved MA510 at ordinal 510');
263:     }
264:     if (!hasAll(answer, ['MA510', 'autonomous maritime demo']) || !hasAll(passage('MA510'), ['MA510', 'approved', 'autonomous maritime demo'])) defects.push('case 12 answer/passage bytes do not prove retrieval of MA510');
