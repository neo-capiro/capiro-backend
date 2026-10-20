import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '../generated/prisma-client/index.js';
import { buildObjectivePlannerNativeFixture } from './objective-planner-native-fixture.js';
import { applicationHash } from '../src/planner/objective-canonical-application.js';
import { savedGenerationPlannerContinuation } from '../src/planner/objective-canonical-continuation.js';
import { buildSnapshot, type StrategySnapshot } from '../src/strategy/versioning.js';
import { requestKey, type ObjectiveAdmission, type ObjectiveReceipt } from '../src/meri/objective-generation.types.js';
import { canonicalGenerationAdmissionSha256, generationBindingKey, generationLedgerId,
  GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_REQUEST, GENERATION_NORMALIZATION,
  type CanonicalGenerationAdmission } from '../src/meri/objective-canonical-generation.js';
import { generationMarker, insertGenerationLedger, recordCanonicalNormalization,
  recordCanonicalGenerationProducer } from '../src/meri/objective-canonical-producer-ledger.js';
import { canonicalPublicationInputHash, canonicalPublicationSha256 } from '../src/meri/objective-canonical-request-ledger.js';
import { captureCanonicalStrategyBasis } from '../src/meri/objective-canonical-basis.js';
import { normalizeCanonicalRegenerationDraft } from '../src/meri/objective-canonical-draft.js';
import { createCanonicalRegenerationRequestPublication } from '../src/meri/objective-canonical-regeneration-request.js';
import { privateRequestJcsSha256 } from '../src/meri/objective-canonical-request.js';
import { CORE_CANONICAL_REGENERATION_RESULT_VERSION,
  verifyRetainedCanonicalRegenerationCompletion } from '../src/meri/objective-canonical-regeneration-completion-receipt.js';
import { planCanonicalStrategyRegeneration } from '../src/meri/objective-canonical-regeneration.js';
import { recordCanonicalRegenerationNormalization } from '../src/meri/objective-canonical-regeneration-ledger.js';
import { readCanonicalSavedGeneration, requireCanonicalBasisCustody } from '../src/meri/objective-canonical-saved-generation.js';
import type { DraftJobInput } from '../src/meri/draft-job.types.js';

export type ObjectivePlannerRegenerationFixtureRow = Record<string, any>;
export interface AppendObjectivePlannerRegeneration {
  /** Keep the new generation's complete observation window after the saved
   * head. The helper refuses timestamps less than 20 seconds after that head. */
  nowMs: number;
  /** A unique deterministic identifier namespace within this fixture. */
  suffix: string;
  newSourceNodeKey?: string;
}
type Row = ObjectivePlannerRegenerationFixtureRow;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

// Deliberately clone into this runner's realm. Host structuredClone objects are
// rejected by the real closed JSON codecs; ORM date columns remain Dates.
function copy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(item => copy(item)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
  return value;
}
function equal(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some((part: Row) => matches(row, part));
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((part: Row) => matches(row, part));
    if (key === 'NOT') return !(Array.isArray(expected) ? expected : [expected]).some((part: Row) => matches(row, part));
    const actual = row[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
      const filter = expected as Row;
      const value = filter.path ? filter.path.reduce((item: any, field: string) => item?.[field], actual) : actual;
      if (Object.hasOwn(filter, 'equals') && !equal(value, filter.equals)) return false;
      if (filter.in && !filter.in.some((item: unknown) => equal(value, item))) return false;
      if (Object.hasOwn(filter, 'not') && equal(value, filter.not)) return false;
      if (Object.hasOwn(filter, 'lt') && !(value < filter.lt) || Object.hasOwn(filter, 'lte') && !(value <= filter.lte) ||
          Object.hasOwn(filter, 'gt') && !(value > filter.gt) || Object.hasOwn(filter, 'gte') && !(value >= filter.gte)) return false;
      const operators = ['path', 'equals', 'in', 'not', 'lt', 'lte', 'gt', 'gte'];
      return Object.keys(filter).every(field => operators.includes(field)) || actual && matches(actual, filter);
    }
    return equal(actual, expected);
  });
}
function model(items: Row[], defaults: Row = {}) {
  const selected = (row: Row | undefined, select?: Row) => row === undefined ? null : copy(select
    ? Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, row[key]])) : row);
  const patch = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' &&
      Object.hasOwn(value, 'increment') ? row[key] + value.increment : copy(value);
  };
  return {
    async create({ data }: { data: Row }) {
      if (items.some(row => row.id === data.id)) throw Error('Duplicate synthetic fixture row');
      const row = { ...copy(defaults), ...copy(data) }; items.push(row); return copy(row);
    },
    async findFirst({ where, select }: { where: Row; select?: Row }) { return selected(items.find(row => matches(row, where)), select); },
    async findMany({ where = {}, select, take }: { where?: Row; select?: Row; take?: number } = {}) {
      const found = items.filter(row => matches(row, where));
      return (take === undefined ? found : found.slice(0, take)).map(row => selected(row, select));
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = items.find(item => matches(item, where));
      if (!row) throw Error('Missing synthetic fixture update row');
      patch(row, data); return copy(row);
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const found = items.filter(row => matches(row, where)); found.forEach(row => patch(row, data));
      return { count: found.length };
    },
  };
}

/** Pure, mutable in-memory ORM fixture. No SQL is executed: the three exact
 * production owner-read query shapes are resolved against these synthetic
 * rows. Unknown queries/writes refuse so a test cannot silently fake custody.
 * This does not qualify native locks, RLS, transactions, issuer grants, Meri
 * SDK execution, protected keys, provider observations or production custody. */
export async function buildObjectivePlannerRegenerationFixture(nowMs: number, options: { seed?: string } = {}) {
  const initialFixture = buildObjectivePlannerNativeFixture(nowMs - 60_000, options);
  const f = initialFixture, { id, tenantId, clerkUserId } = f;
  const rows = { resources: [] as Row[], jobs: [] as Row[], versions: [] as Row[], nodes: [] as Row[], strategies: [] as Row[] };
  const revisions = [{ id: f.source.objectiveRevisionId, version: f.source.objectiveVersion, snapshot: copy(f.objectiveSnapshot) }];
  const synthetic = {
    spPlannerResource: model(rows.resources, { projectId: null, version: 1, archived: false, shareTokenHash: null }),
    spDraftJob: model(rows.jobs, { strategyId: null, errorMessage: null }),
    spStrategy: model(rows.strategies, { archivedAt: null }), spNode: model(rows.nodes, { archivedAt: null }),
    spVersion: model(rows.versions),
    async $executeRaw(): Promise<never> { throw Error('Regeneration source fixture forbids database writes'); },
    async $queryRaw(parts: TemplateStringsArray, ...values: unknown[]) {
      const sql = parts.join('?').replace(/\s+/g, ' ').trim();
      if (sql.includes('FROM client_objective_revisions')) {
        if (values[0] !== tenantId || values[1] !== f.source.clientId || values[2] !== f.source.objectiveId) return [];
        return revisions.filter(row => row.id === values[3] && row.version === values[4]).map(row => ({ snapshot: copy(row.snapshot) }));
      }
      if (sql.startsWith('SELECT id::text AS id FROM sp_strategy'))
        return rows.strategies.filter(row => row.tenantId === values[0] && row.id === values[1]).map(row => ({ id: row.id }));
      if (sql.includes('FROM sp_version')) return rows.versions.filter(row => row.tenantId === values[0] && row.strategyId === values[1])
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id.localeCompare(a.id))
        .slice(0, 1).map(row => copy(row));
      if (sql.startsWith('SELECT id FROM sp_node'))
        return rows.nodes.filter(row => row.tenantId === values[0] && row.strategyId === values[1]).map(row => ({ id: row.id }));
      throw Error(`Unsupported synthetic regeneration owner read: ${sql}`);
    },
  };
  const tx = synthetic as unknown as Prisma.TransactionClient;
  const scope = (admission: CanonicalGenerationAdmission) => ({ tenantId, clerkUserId, generationJobId: admission.generationJobId });
  const ledger = async (kind: typeof GENERATION_ADMISSION | typeof GENERATION_ACCEPTANCE | typeof GENERATION_REQUEST,
    admission: CanonicalGenerationAdmission, data: unknown) => insertGenerationLedger(tx, kind, tenantId, clerkUserId, admission.generationJobId, data);
  const storeNodes = (snapshot: StrategySnapshot) => {
    rows.nodes.splice(0, rows.nodes.length, ...snapshot.nodes.map(node => ({ ...copy(node), tenantId,
      strategyId: snapshot.meta.id, startsOn: new Date(node.startsOn), endsOn: node.endsOn ? new Date(node.endsOn) : null,
      createdAt: new Date(node.createdAt), archivedAt: null })));
  };
  await synthetic.spStrategy.create({ data: { ...f.strategy, tenantId, createdAt: new Date(f.strategy.createdAt), draftedByMeri: true } });
  storeNodes(f.snapshot);
  await synthetic.spVersion.create({ data: { id: id('version'), tenantId, strategyId: f.strategy.id, snapshot: f.snapshot,
    authorKind: 'meri', authorUserId: clerkUserId, coalescible: false, createdAt: new Date(nowMs - 66_000) } });
  await synthetic.spDraftJob.create({ data: { id: f.admission.generationJobId, tenantId, clientId: f.source.clientId,
    ownerUserId: clerkUserId, requestKey: requestKey(tenantId, clerkUserId, f.admission.generationRequestId), input: f.pendingInput,
    status: 'running', attempt: 2, claimedBy: `canonical:${f.acceptance.issuance.issuanceKey}`,
    claimedAt: new Date(f.acceptance.acceptedAtMs), deadlineAt: new Date(f.admission.effectExpiresAtMs) } });
  await ledger(GENERATION_ADMISSION, f.admission, f.admission);
  await ledger(GENERATION_ACCEPTANCE, f.admission, f.acceptance);
  await ledger(GENERATION_REQUEST, f.admission, f.storedRequest);
  await recordCanonicalNormalization(tx, tenantId, clerkUserId, f.admission.generationJobId,
    { strategyId: f.strategy.id, strategyVersionId: id('version') }, f.normalized);
  await synthetic.spDraftJob.update({ where: { id: f.admission.generationJobId },
    data: { status: 'completed', strategyId: f.strategy.id, input: f.input, stage: 'completed' } });
  await recordCanonicalGenerationProducer(tx, tenantId, clerkUserId, f.admission.generationJobId);
  const initialSaved = await readCanonicalSavedGeneration(tx, f.scope);
  const initialWork = savedGenerationPlannerContinuation(initialSaved, { workAction: 'objective.plan.prepare', tenantId,
    actorUserId: f.actorUserId, clerkUserId, canonical: f.canonical, consentId: f.plannerConsentId, controlVersion: 1 });
  const initial = { ...f, saved: initialSaved, work: initialWork, controlVersion: 1,
    originalDeadlineAt: new Date(Math.min(f.plannerExpiresAtMs, f.admission.effectExpiresAtMs,
      f.acceptance.issuance.expiresAtMs, f.publication.request.originalExpiresAtMs)).toISOString() };
  const baseAdmission = copy(f.admission), baseDto = copy(f.input.dto), baseIntent = copy(f.compiled.intent);
  let latest = { source: copy(f.source), canonical: copy(f.canonical), controlVersion: 1,
    strategyVersionId: id('version'), sourceKeys: [...f.normalized.sourceKeys] };
  const usedSuffixes = new Set<string>();
  let appending = false;
  /** Append another real codec chain to these SAME synthetic owner rows. No
   * previous normalization, producer, saved version or Planner receipt changes.
   * Subsequent calls use the exact preceding machine version as their basis. */
  async function appendRegeneration(raw: AppendObjectivePlannerRegeneration) {
    const { nowMs, suffix, newSourceNodeKey } = copy(raw);
    const latestAt = Math.max(...rows.versions.map(row => new Date(row.createdAt).getTime()));
    if (appending || !Number.isSafeInteger(nowMs) || nowMs - 20_000 <= latestAt ||
        typeof suffix !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(suffix) || usedSuffixes.has(suffix) ||
        newSourceNodeKey !== undefined && (typeof newSourceNodeKey !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(newSourceNodeKey)))
      throw Error('Regeneration fixture requires a unique suffix, valid source key and later observation window');
    const generationId = (name: string) => id(`${suffix}-${name}`);
    appending = true;
    try {
      let expectedStrategyVersionId = latest.strategyVersionId;
      if (usedSuffixes.size === 0) {
        // Keep the first person-owned head distinct from the original machine
        // version so the real merge planner proves human-field preservation.
        rows.strategies[0]!.title = 'Human retained Strategy title';
        rows.strategies[0]!.goal = 'Human retained government relationship goal';
        rows.nodes[0]!.title = 'Human retained authorization request';
        const basisSnapshot = buildSnapshot(rows.strategies[0] as any, rows.nodes as any);
        expectedStrategyVersionId = generationId('basis-version');
        await synthetic.spVersion.create({ data: { id: expectedStrategyVersionId, tenantId, strategyId: f.strategy.id,
          snapshot: basisSnapshot, authorKind: 'person', authorUserId: clerkUserId, coalescible: false, createdAt: new Date(nowMs - 20_000) } });
      }
      const source = { ...latest.source, objectiveVersion: latest.source.objectiveVersion + 1,
        objectiveRevisionId: generationId('revision') };
      const intent = { ...baseIntent, outcome: 'Keep the revised synthetic government authority available',
        governmentProblem: 'Synthetic authority and government relationship require a revised submission' };
      const objectiveSnapshot = { id: source.objectiveId, clientId: source.clientId, version: source.objectiveVersion,
        status: 'ready', deletedAt: null, ...intent };
      revisions.push({ id: source.objectiveRevisionId, version: source.objectiveVersion, snapshot: objectiveSnapshot });
      const canonical = { ...latest.canonical, bindingVersion: latest.canonical.bindingVersion + 1, requestedIntentId: generationId('intent'),
        requestedObjectiveRevisionId: source.objectiveRevisionId, requestedObjectiveVersion: source.objectiveVersion,
        snapshotHash: applicationHash(objectiveSnapshot) };
      const admission: CanonicalGenerationAdmission = { ...baseAdmission, canonical, consentId: generationId('generation-consent'),
        controlVersion: latest.controlVersion + 1, generationJobId: generationId('job'), generationRequestId: generationId('request'),
        admittedAtMs: nowMs - 10_000, effectExpiresAtMs: nowMs + 600_000, expectedStrategyVersionId };
      const basis = await captureCanonicalStrategyBasis(tx, admission);
      if (!basis) throw Error('Synthetic regeneration did not capture its predecessor basis');
      await requireCanonicalBasisCustody(tx, basis);
      const dto = { ...baseDto, goal: 'Synthetic revised authorization work' };
      const prompt = 'Synthetic revised Objective and complete preserved government relationship context.\n';
      const sourceDigest = applicationHash({ source, intent }), coverageDigest = applicationHash([]), packetId = generationId('packet');
      const localDigest = sha('synthetic regeneration local context'), externalDigest = sha('synthetic regeneration external observation'),
        historyDigest = sha('synthetic regeneration history');
      const inputDigest = applicationHash({ sourceDigest, coverageDigest, packetId, requestId: admission.generationRequestId,
        type: dto.type, localDigest, externalDigest, historyDigest, promptDigest: applicationHash(prompt) });
      const context = { reobservedAt: null, state: 'complete' as const, packetId, compiledAt: new Date(nowMs - 9_500).toISOString(),
        sourceDigest, coverageDigest, inputDigest, issues: [] };
      const compiled: ObjectiveAdmission = { tenantId, clerkUserId, requestId: admission.generationRequestId, type: dto.type, source,
        intent, localDigest, externalDigest, historyDigest, historyObservedAt: context.compiledAt, contactIds: [], context, coverage: [] };
      const publication = createCanonicalRegenerationRequestPublication({ admission, dto, context: { schemaVersion: 1, tenantId,
        clerkUserId, requestId: admission.generationRequestId, source, intent, snapshotSha256: canonical.snapshotHash,
        sourceDigest, packetId, compiledAt: context.compiledAt, coverageDigest, promptSha256: sha(prompt), evidence: [] }, prompt,
        owners: [{ ownerRef: 'owner:qa', clerkUserId }], delegation: { ref: generationId('synthetic-delegation'),
          revision: 'synthetic-regeneration-fixture:1', issuedAtMs: nowMs - 11_000, absoluteExpiresAtMs: nowMs + 700_000 },
        requestedAtMs: nowMs - 9_000, effectExpiresAtMs: nowMs + 500_000, basis });
      const binding = { tenantId, actorId: clerkUserId, conversationId: generationId('conversation'), runId: generationId('run'),
        attemptId: generationId('attempt'), workerId: generationId('worker'), writerFence: 1 };
      const sourceRequestSha256 = applicationHash(['synthetic-regeneration-original-request', f.seed, suffix]);
      const acceptance = { schemaVersion: 1 as const, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
        sourceBinding: binding, sourceRequestSha256, acceptedAtMs: nowMs - 8_000,
        issuance: { issuanceKey: generationBindingKey(binding), binding, requestSha256: sourceRequestSha256,
          expiresAtMs: nowMs + 400_000, grantId: generationId('synthetic-grant'), capabilitySha256: sha('synthetic regeneration capability'),
          factsSha256: sha('synthetic regeneration protected facts') } };
      const liveKeys = new Set(basis.sourceIndex.filter(entry => !entry.archived).map(entry => entry.sourceNodeKey));
      const sourceKeys = latest.sourceKeys.filter(key => liveKeys.has(key));
      if (newSourceNodeKey !== undefined) {
        if (sourceKeys.includes(newSourceNodeKey)) throw Error('Synthetic regeneration source key already exists');
        sourceKeys.push(newSourceNodeKey);
      }
      const payload = { type: 'authorization', rationale: 'Synthetic revised authority work', summary: 'Prepare the revised synthetic request',
        nodes: sourceKeys.map((sourceNodeKey, index) => ({ sourceNodeKey, kind: 'action', subject: index === 0 ? 'deliverable' : 'submission',
          title: sourceNodeKey === 'prepare' ? 'Updated machine authorization request' : sourceNodeKey === 'submit'
            ? 'Submit the revised synthetic request' : `Complete synthetic ${sourceNodeKey}`,
          note: sourceNodeKey === 'prepare' ? 'Machine revised request note' : null, status: 'suggested', ownerRef: null,
          startsOn: new Date(Date.parse('2027-02-01') + index * 86_400_000).toISOString().slice(0, 10), endsOn: null,
          openEnded: false, sources: [], dependsOn: index ? [sourceKeys[index - 1]!] : [] })),
        coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } };
      const normalized = normalizeCanonicalRegenerationDraft(payload, { admission, queuedType: dto.type, basis });
      const completionHash = privateRequestJcsSha256({ binding, kind: 'completion' });
      const completionId = `${completionHash.slice(0, 8)}-${completionHash.slice(8, 12)}-4${completionHash.slice(13, 16)}-a${completionHash.slice(17, 20)}-${completionHash.slice(20, 32)}`;
      const execution = { provider: 'synthetic-regeneration-fixture', model: 'synthetic-regeneration-fixture', receiptRef: completionId,
        receiptSha256: sha('synthetic regeneration original-owner receipt'), bindingSha256: privateRequestJcsSha256(binding) };
      const resultBody = { resultVersion: CORE_CANONICAL_REGENERATION_RESULT_VERSION, operation: 'strategy.draft',
        requestId: admission.generationRequestId, jobId: admission.generationJobId, requestSha256: publication.requestSha256,
        inputSha256: publication.request.inputSha256, sourceSha256: privateRequestJcsSha256(publication.request.source),
        contextSha256: publication.request.context.contextSha256, basisSha256: applicationHash(basis), binding, execution,
        resultRef: completionId, completedAtMs: nowMs - 7_000, state: 'succeeded', payload, payloadSha256: privateRequestJcsSha256(payload), issues: [] };
      const result = { ...resultBody, resultSha256: privateRequestJcsSha256(resultBody) }, bytes = Buffer.from(JSON.stringify(result), 'utf8');
      const rawFileSha256 = sha(bytes);
      const retained = { schemaVersion: 1, generationJobId: admission.generationJobId, binding,
        sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission), sourceRequestSha256, typedRequestSha256: publication.requestSha256,
        completionId, checkpointId: generationId('checkpoint'), checkpointSha256: sha('synthetic regeneration checkpoint'), resultRef: completionId,
        resultSha256: result.resultSha256, file: { path: 'meri-objective-strategy-regeneration.result.json', object: {
          objectId: 'synthetic-regeneration-object', versionId: 'synthetic-regeneration-immutable-version', sha256: rawFileSha256,
          bytes: bytes.length, scopes: ['synthetic-regeneration-fixture'] } }, rawFileSha256, execution, result,
        checkedAtMs: nowMs - 6_500, expiresAtMs: nowMs + 1_000 };
      const witness = verifyRetainedCanonicalRegenerationCompletion(retained, { admission, acceptance,
        publication, nowMs: nowMs - 6_000 }).witness;
      const request = { requestId: admission.generationRequestId, clientId: source.clientId,
        objective: { objectiveId: source.objectiveId, objectiveVersion: source.objectiveVersion }, type: dto.type };
      const receipt: ObjectiveReceipt = { schemaVersion: 1, requestId: admission.generationRequestId, source,
        context: { ...context, reobservedAt: new Date(nowMs - 5_000).toISOString() }, result: {
          strategyId: f.strategy.id, strategyVersionId: generationId('version'), savedAt: new Date(nowMs - 6_000).toISOString(),
          sourceDigest, contextPacketId: packetId, coverageDigest, inputDigest }, failure: null };
      const pendingInput = { dto, bearer: null, canonicalGeneration: generationMarker(admission),
        objectiveGeneration: { request, fingerprint: applicationHash(request), receipt: { ...receipt, context, result: null } } } as DraftJobInput;
      const input = { ...pendingInput, canonicalCompletion: witness,
        objectiveGeneration: { ...pendingInput.objectiveGeneration!, receipt } } as DraftJobInput;
      const storedRequest = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
        inputSha256: canonicalPublicationInputHash(pendingInput), publicationSha256: canonicalPublicationSha256(publication), compiled, publication };
      await synthetic.spDraftJob.create({ data: { id: admission.generationJobId, tenantId, clientId: source.clientId, ownerUserId: clerkUserId,
        requestKey: requestKey(tenantId, clerkUserId, admission.generationRequestId), status: 'running', attempt: 2, input: pendingInput,
        claimedBy: `canonical:${acceptance.issuance.issuanceKey}`, claimedAt: new Date(acceptance.acceptedAtMs), deadlineAt: new Date(admission.effectExpiresAtMs) } });
      await ledger(GENERATION_ADMISSION, admission, admission);
      await ledger(GENERATION_ACCEPTANCE, admission, acceptance);
      await ledger(GENERATION_REQUEST, admission, storedRequest);
      const plan = planCanonicalStrategyRegeneration({ basis, normalized, current: basis.snapshot, archivedNodeIds: [],
        createdByUserId: clerkUserId, createdAt: new Date(nowMs - 6_000).toISOString(),
        normalizationId: generationLedgerId(GENERATION_NORMALIZATION, tenantId, clerkUserId, admission.generationJobId) });
      Object.assign(rows.strategies[0]!, copy(plan.metaPatch));
      storeNodes(plan.snapshot);
      await synthetic.spVersion.create({ data: { id: generationId('version'), tenantId, strategyId: f.strategy.id,
        snapshot: plan.snapshot, authorKind: 'meri', authorUserId: clerkUserId, coalescible: false, createdAt: new Date(nowMs - 6_000) } });
      await recordCanonicalRegenerationNormalization(tx, tenantId, clerkUserId, admission.generationJobId,
        { strategyId: f.strategy.id, strategyVersionId: generationId('version') }, { basis, normalized, plan });
      await synthetic.spDraftJob.update({ where: { id: admission.generationJobId },
        data: { status: 'completed', strategyId: f.strategy.id, input, stage: 'completed' } });
      await recordCanonicalGenerationProducer(tx, tenantId, clerkUserId, admission.generationJobId);
      const regeneratedScope = scope(admission), regeneratedSaved = await readCanonicalSavedGeneration(tx, regeneratedScope);
      const plannerConsentId = generationId('planner-consent'), plannerControlId = generationId('planner-control'), controlVersion = admission.controlVersion;
      const plannerExpiresAtMs = nowMs + 600_000;
      const work = savedGenerationPlannerContinuation(regeneratedSaved, { workAction: 'objective.plan.prepare', tenantId,
        actorUserId: f.actorUserId, clerkUserId, canonical, consentId: plannerConsentId, controlVersion });
      const originalDeadlineAt = new Date(Math.min(plannerExpiresAtMs, admission.effectExpiresAtMs,
        acceptance.issuance.expiresAtMs, publication.request.originalExpiresAtMs)).toISOString();
      const regenerated = { id, nowMs, tenantId, clerkUserId, actorUserId: f.actorUserId, membershipId: f.membershipId,
        canonical, source, objectiveSnapshot, admission, acceptance, publication, retained, normalized, compiled,
        receipt, input, pendingInput, storedRequest, snapshot: plan.snapshot, basis, plan, saved: regeneratedSaved,
        plannerConsentId, plannerControlId, plannerExpiresAtMs, controlVersion, originalDeadlineAt, scope: regeneratedScope, work };
      latest = { source: copy(source), canonical: copy(canonical), controlVersion,
        strategyVersionId: generationId('version'), sourceKeys: [...normalized.sourceKeys] };
      usedSuffixes.add(suffix);
      return regenerated;
    } finally { appending = false; }
  }
  const regenerated = await appendRegeneration({ nowMs, suffix: 'regeneration', newSourceNodeKey: 'submit' });
  return { initial, regenerated, tx, rows, ...rows, revisions, initialSaved,
    regeneratedSaved: regenerated.saved, basis: regenerated.basis, plan: regenerated.plan, scope: regenerated.scope, appendRegeneration };
}

export type ObjectivePlannerRegenerationFixture = Awaited<ReturnType<typeof buildObjectivePlannerRegenerationFixture>>;
