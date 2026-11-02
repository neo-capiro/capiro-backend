// These unit fixtures inject transaction owners; do not initialize a generated Prisma service.
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
import { createHash } from 'node:crypto';
import { createObjectiveStrategyRequestCodec, OBJECTIVE_STRATEGY_TYPES } from '@capiro/shared/objective-strategy-intake';
import { ObjectiveCanonicalProducerService } from './objective-canonical-producer.service.js';
import { digest, parseObjectiveDraft, pendingReceipt, requestKey } from './objective-generation.types.js';
import { STRATEGY_TYPES } from '../strategy/dto/create-strategy.dto.js';
import { applicationHash } from '../planner/objective-canonical-application.js';

const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const codec = createObjectiveStrategyRequestCodec({ sha256: text => createHash('sha256').update(text).digest('hex'),
  invalidRequest: () => { throw Error('invalid'); } });
/** Real promotion guard and native association reader; SQL observations are
 * synthetic. This suite does not qualify caller authentication or PostgreSQL. */
function fixture() {
  const snapshot = { id: id(3), clientId: id(2), version: 7, status: 'ready', deletedAt: null, outcome: 'Original outcome' };
  const canonical = { tenantId: id(9), clientId: id(2), objectiveId: id(3), canonicalPlanId: id(11),
    canonicalStrategyId: id(12), canonicalProjectId: id(13), bindingVersion: 1, epoch: 1, requestedIntentId: id(14),
    requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 7, snapshotHash: digest(snapshot) };
  const fresh: any = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1', canonical,
    actorUserId: id(15), clerkUserId: 'user_original', consentId: id(6), controlVersion: 1,
    generationJobId: id(5), generationRequestId: id(1), admittedAtMs: 1100, effectExpiresAtMs: 4000,
    expectedStrategyVersionId: null };
  const request = { requestId: id(1), clientId: id(2), objective: { objectiveId: id(3), objectiveVersion: 7 }, type: 'earmark' as const };
  const source = { clientId: id(2), objectiveId: id(3), objectiveVersion: 7, objectiveRevisionId: id(8) };
  const command = { schemaVersion: 1, requestId: id(16), command: 'retry', workAction: 'objective.strategy.draft',
    expectedObjectiveVersion: 7, expectedControlVersion: 0, expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: null };
  const wrapper = { schemaVersion: 2, command, selection: { type: request.type, generationRequestId: request.requestId } };
  const wrapperSha256 = digest({ clientId: id(2), objectiveId: id(3), body: wrapper });
  const marker = { schemaVersion: 1, intakeId: id(4), consentId: id(6), commandReceiptId: id(7), wrapperSha256 };
  const fields = { canonical_plan_id: id(11), canonical_epoch: 1, canonical_strategy_id: id(12), canonical_project_id: id(13),
    canonical_binding_version: 1, root_intent_id: id(14), source_revision_id: id(8), source_objective_version: 7,
    source_snapshot_hash: canonical.snapshotHash, root_actor_user_id: id(17) };
  const intake: any = { ...fields, id: id(4), tenant_id: id(9), client_id: id(2), objective_id: id(3),
    work_action: 'objective.strategy.draft', control_id: id(18), consent_id: id(6), command_receipt_id: id(7),
    command_request_id: id(16), actor_user_id: id(15), actor_membership_id: id(19), original_clerk_user_id: 'user_original',
    control_version: 1, selected_type: request.type, generation_request_id: id(1), wrapper, wrapper_sha256: wrapperSha256,
    typed_request: request, request_fingerprint: digest(request), job_request_key: requestKey(id(9), 'user_original', id(1)),
    generation_job_id: id(5) };
  const consent: any = { ...fields, id: id(6), control_id: id(18), command_receipt_id: id(7),
    consenting_actor_user_id: id(15), consenting_membership_id: id(19), command_request_id: id(16), payload_digest: 'b'.repeat(64),
    confirmed_at: new Date(800).toISOString() };
  const receipt: any = { ...fields, id: id(7), created_consent_id: id(6), result_consent_id: id(6), control_version_after: 1,
    actor_user_id: id(15), actor_membership_id: id(19), command_kind: 'retry', outcome: 'reconsent_recorded',
    request_id: id(16), command, payload_digest: 'b'.repeat(64), committed_at: new Date(900).toISOString() };
  const row: any = { intake, consent, receipt, snapshot, deadlineMs: '5000', reservedMs: '1000', consentExpiresMs: '5000' };
  const job: any = { id: id(5), tenantId: id(9), clientId: id(2), ownerUserId: 'user_original',
    requestKey: intake.job_request_key, deadlineAt: new Date(5000), input: { dto: { clientId: id(2), type: 'earmark', goal: snapshot.outcome },
      bearer: null, objectiveGeneration: { request, fingerprint: digest(request), receipt: pendingReceipt(request, source) },
      objectiveCanonicalReservation: marker } };
  const queries: Array<{ sql: string; args: any[] }> = [];
  const tx: any = { $queryRawUnsafe: async (sql: string, ...args: any[]) => { queries.push({ sql, args }); return [row]; } };
  const service = new ObjectiveCanonicalProducerService({} as any, {} as any) as any;
  return { fresh, job, row, tx, queries, check: () => service.requireReservation(tx, job, fresh) };
}
describe('canonical reservation promotion source', () => {
  test('original recovery binds all shared answers to the saved revision and reserved DTO', async () => {
    const f = fixture();
    const answers = { schemaVersion: 1, type: 'earmark', goal: 'G'.repeat(4000), ownerUserId: 'user_selected',
      targetDate: '2028-02-29', meriContext: 'C'.repeat(8000) };
    f.row.snapshot.strategyIntake = answers;
    const { schemaVersion: _version, ...fields } = answers;
    f.job.input.dto = { clientId: id(2), ...fields };
    const hash = applicationHash(f.row.snapshot); f.fresh.canonical.snapshotHash = hash;
    for (const row of [f.row.intake, f.row.consent, f.row.receipt]) row.source_snapshot_hash = hash;
    await expect(f.check()).resolves.toBeUndefined();
    f.job.input.dto.targetDate = '2028-03-01';
    await expect(f.check()).rejects.toThrow();
  });
  test('accepts only the actual original native C1 pair and untouched queued input', async () => {
    const f = fixture(); await expect(f.check()).resolves.toBeUndefined();
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]!.args).toEqual([id(9), id(4)]);
    expect(f.queries[0]!.sql).toContain('c.command_receipt_id=i.command_receipt_id');
    expect(f.queries[0]!.sql).not.toMatch(/FOR SHARE|FOR UPDATE/);
    expect(f.job.input).toHaveProperty('objectiveCanonicalReservation');
    expect(f.job.input).not.toHaveProperty('canonicalGeneration');
  });
  test.each(['consentId', 'controlVersion', 'actorUserId', 'clerkUserId', 'generationRequestId', 'generationJobId'])('later or foreign admission %s cannot adopt C1', async key => {
    const f = fixture(); f.fresh[key] = key === 'controlVersion' ? 2 : id(100);
    await expect(f.check()).rejects.toThrow();
  });
  test.each(['tenantId', 'clientId', 'objectiveId', 'canonicalPlanId', 'canonicalStrategyId', 'canonicalProjectId', 'bindingVersion', 'requestedIntentId',
    'requestedObjectiveRevisionId', 'requestedObjectiveVersion', 'snapshotHash'])('changed source %s refuses promotion', async key => {
    const f = fixture(); f.fresh.canonical[key] = ['bindingVersion', 'requestedObjectiveVersion'].includes(key) ? 99 : id(100);
    await expect(f.check()).rejects.toThrow();
  });
  test.each(['selected_type', 'request_fingerprint', 'job_request_key', 'original_clerk_user_id', 'generation_job_id',
    'command_receipt_id', 'actor_membership_id', 'root_actor_user_id'])('native %s mismatch refuses', async key => {
    const f = fixture(); f.row.intake[key] = 'wrong'; await expect(f.check()).rejects.toThrow();
  });
  test.each([null, {}, { schemaVersion: 1 }, { schemaVersion: 1, intakeId: `${id(4)}\n`, consentId: id(6),
    commandReceiptId: id(7), wrapperSha256: 'a'.repeat(64) }])('malformed present marker refuses before native lookup', async marker => {
    const f = fixture(); f.job.input.objectiveCanonicalReservation = marker;
    await expect(f.check()).rejects.toThrow(); expect(f.queries).toHaveLength(0);
  });
  test.each(['canonicalGeneration', 'bearer', 'dto', 'objectiveGeneration'])('mutated reserved %s refuses', async key => {
    const f = fixture(); f.job.input[key] = { fake: true }; await expect(f.check()).rejects.toThrow();
  });
  test('cannot extend original job/deadline or accept missing original native evidence', async () => {
    const f = fixture(); f.job.deadlineAt = new Date(6000); await expect(f.check()).rejects.toThrow();
    const g = fixture(); g.row.consentExpiresMs = '4000'; await expect(g.check()).rejects.toThrow();
    const h = fixture(); h.tx.$queryRawUnsafe = async () => []; await expect(h.check()).rejects.toThrow();
  });
  test('legacy unreserved capture remains on the original admission path', async () => {
    const f = fixture(); delete f.job.input.objectiveCanonicalReservation;
    await expect(f.check()).resolves.toBeUndefined(); expect(f.queries).toHaveLength(0);
  });
  test('canonical root snapshots use their actual canonical hash, including numeric object keys', async () => {
    const f = fixture(); f.row.snapshot.extra = { '2': 'two', '10': 'ten' };
    const canonicalHash = applicationHash(f.row.snapshot), requestDialectHash = codec.digest(f.row.snapshot);
    expect(canonicalHash).not.toBe(requestDialectHash);
    f.fresh.canonical.snapshotHash = canonicalHash;
    for (const row of [f.row.intake, f.row.consent, f.row.receipt]) row.source_snapshot_hash = canonicalHash;
    await expect(f.check()).resolves.toBeUndefined();
    f.fresh.canonical.snapshotHash = requestDialectHash;
    for (const row of [f.row.intake, f.row.consent, f.row.receipt]) row.source_snapshot_hash = requestDialectHash;
    await expect(f.check()).rejects.toThrow();
  });
  test('shared request codec is the actual legacy dialect for all selected types and envelopes', () => {
    expect(OBJECTIVE_STRATEGY_TYPES).toEqual(STRATEGY_TYPES);
    for (const type of STRATEGY_TYPES) {
      const f = fixture(), request = { ...f.job.input.objectiveGeneration.request, type };
      expect(codec.parseObjectiveDraft(request)).toEqual(parseObjectiveDraft(request));
      expect(codec.digest(request)).toBe(digest(request));
      expect(codec.requestKey(id(9), 'user_original', id(1))).toBe(requestKey(id(9), 'user_original', id(1)));
      expect(codec.pendingReceipt(request, f.job.input.objectiveGeneration.receipt.source)).toEqual(
        pendingReceipt(request, f.job.input.objectiveGeneration.receipt.source));
    }
  });
});
