import { ObjectiveStrategyWorkOwner } from './objective-strategy-work-owner.js';
import { objectiveStrategyRequestCodec, parseObjectiveStrategySelection } from './objective-strategy-selection.js';
import type { WorkAuthority, WorkState } from './objective-work-command.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a: WorkAuthority = { tenantId: id(1), clientId: id(2), objectiveId: id(3), actorUserId: id(4),
  actorMembershipId: id(5), clerkUserId: 'user_original', objectiveRevisionId: id(6), objectiveVersion: 1, objectiveStatus: 'ready' };
const state = (): WorkState => ({ source: { canonicalPlanId: id(7), canonicalEpoch: 1, canonicalStrategyId: id(8),
  canonicalProjectId: id(9), canonicalBindingVersion: 1, rootIntentId: id(10), sourceRevisionId: id(6),
  sourceObjectiveVersion: 1, sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: id(4) },
control: { id: id(11), version: 0, currentConsentId: null, cancelledAt: null, cancelledByUserId: null }, consent: null });
const selected = () => parseObjectiveStrategySelection(a.clientId, a.objectiveId, { schemaVersion: 2,
  command: { schemaVersion: 1, requestId: id(12), command: 'retry', workAction: 'objective.strategy.draft',
    expectedObjectiveVersion: 1, expectedControlVersion: 0, expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: null },
  selection: { type: 'appropriations', generationRequestId: id(13) } });
const settings = { clioFeatureFlags: { 'strategyPlanner.enabled': true }, objectiveStrategyIntake: { enabled: true } };
function fixture() {
  const trace: string[] = [], h = { present: false, globalOccupied: false, jobs: [] as any[], resources: [] as any[], settings: settings as any };
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string) => { trace.push(sql); return sql.includes('objective_strategy_output_gate') ? [{ acquired: true }] : []; }),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?'); trace.push(sql);
      if (sql.includes('AS present')) return [{ present: h.present }];
      if (sql.includes('SELECT canonical_strategy_id')) return [{ strategyId: id(8) }];
      if (sql.includes('SELECT role::text AS role')) return [{ role: 'standard_user' }];
      if (sql.includes('FROM sp_draft_job')) return h.jobs;
      if (sql.includes('FROM sp_planner_resources')) return h.resources;
      if (sql.includes('settings_jsonb AS settings')) return [{ settings: h.settings }];
      throw Error(`Unexpected source read: ${sql}`);
    }),
  } as any;
  const audit = jest.fn(async () => ({}));
  const prisma = { withSystem: jest.fn(async (run: any) => run({ $queryRaw: async () => [{ occupied: h.globalOccupied }],
    auditLog: { create: audit } })) } as any;
  const owner = new ObjectiveStrategyWorkOwner({ OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: '60000' }, prisma);
  const s = state(), request = selected();
  const ctx = { tenantId: a.tenantId, userId: a.actorUserId, role: 'standard_user' } as any;
  const lock = async () => {
    owner.bindStrategySelectionWithinTx(tx, ctx, request);
    await owner.lockWithinTx(tx, ctx, request.work);
    owner.observeLockedStrategyStateWithinTx(tx, a, 'objective.strategy.draft', s);
  };
  return { ...h, h, tx, owner, s, request, lock, trace, ctx, prisma, audit };
}
describe('initial native selected Strategy owner', () => {
  test('default off does not acquire locks, reconcile or grant policy', async () => {
    const f = fixture(), owner = new ObjectiveStrategyWorkOwner({});
    await owner.lockWithinTx(f.tx, { tenantId: a.tenantId } as any, f.request.work);
    expect((await owner.reconcileWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).state).toBe('unavailable');
    await expect(owner.policyWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(f.trace).toEqual([]);
  });
  test('only the selected real write fence can qualify bounded initial absence and policy', async () => {
    const f = fixture(); await f.lock();
    expect((await f.owner.reconcileWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).state).toBe('not_started');
    expect(f.trace[0]).toContain('pg_advisory_xact_lock'); expect(f.trace[1]).toContain('FOR UPDATE NOWAIT');
    expect(await f.owner.policyWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).toMatchObject({ configuredDurationMs: 60000,
      originalDelegationExpiresAtMs: null, actionDurationLimitMs: 1800000 });
    expect(f.prisma.withSystem).toHaveBeenCalledTimes(1);
    expect(f.audit).toHaveBeenCalledWith({ data: { tenantId: a.tenantId, actorUserId: a.actorUserId, actorRole: 'standard_user',
      action: 'objective_strategy_intake_output_presence_observed', entityType: 'canonical_strategy', entityId: id(8),
      requestId: id(12), after: { occupied: false } } });
    f.s.source.sourceObjectiveVersion = 2;
    await expect(f.owner.policyWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
  });
  test('a read gate and shared state never qualify absence or issuance', async () => {
    const f = fixture(); await f.owner.lockReadWithinTx(f.tx, f.ctx,
      { clientId: a.clientId, objectiveId: a.objectiveId, workAction: 'objective.strategy.draft' });
    expect((await f.owner.reconcileWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).state).toBe('outcome_unconfirmed');
    await expect(f.owner.policyWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
  });
  test.each(['present', 'foreign-occupied', 'job', 'hidden-receipt', 'unknown-kind', 'resource-overflow'])('refuses %s owner ambiguity', async variant => {
    const f = fixture(); await f.lock();
    if (variant === 'present') f.h.present = true;
    if (variant === 'foreign-occupied') f.h.globalOccupied = true;
    if (variant === 'job') f.h.jobs = [{ id: id(40), clientId: a.clientId, strategyId: null,
      input: { objectiveGeneration: { request: { requestId: id(41), clientId: a.clientId,
        objective: { objectiveId: a.objectiveId, objectiveVersion: 1 }, type: 'authorization' } } } }];
    if (variant === 'hidden-receipt') f.h.resources = [{ kind: 'renamed', data: { work: { canonical: {
      canonicalPlanId: f.s.source.canonicalPlanId } } } }];
    if (variant === 'unknown-kind') f.h.resources = [{ kind: 'objective_unknown_future', data: {} }];
    if (variant === 'resource-overflow') f.h.resources = Array.from({ length: 257 }, () => ({ kind: 'ordinary', data: {} }));
    expect((await f.owner.reconcileWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).state).toBe('outcome_unconfirmed');
    await expect(f.owner.policyWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
  });
  test('an existing consent or terminal is not reinterpreted as an initial operation', async () => {
    const f = fixture(); await f.lock(); f.s.control!.version = 1; f.s.control!.currentConsentId = id(50);
    expect((await f.owner.reconcileWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).state).toBe('outcome_unconfirmed');
  });
  test('a closed unrelated Objective envelope remains unrelated', async () => {
    const f = fixture(); await f.lock();
    const request = { requestId: id(61), clientId: a.clientId, objective: { objectiveId: id(62), objectiveVersion: 1 }, type: 'appropriations' as const };
    f.h.jobs = [{ id: id(60), clientId: a.clientId, strategyId: null, input: { objectiveGeneration: { request,
      fingerprint: objectiveStrategyRequestCodec.digest(request), receipt: objectiveStrategyRequestCodec.pendingReceipt(request,
        { clientId: a.clientId, objectiveId: id(62), objectiveVersion: 1, objectiveRevisionId: id(63) }) } } }];
    expect((await f.owner.reconcileWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).state).toBe('not_started');
  });
  test.each(['objectiveGeneration', 'canonicalGeneration', 'objectiveCanonicalReservation'])(
    'own null %s on an unrelated persisted job remains uncertain', async key => {
      const f = fixture(); await f.lock();
      const request = { requestId: id(61), clientId: a.clientId, objective: { objectiveId: id(62), objectiveVersion: 1 }, type: 'appropriations' as const };
      const input: any = { objectiveGeneration: { request, fingerprint: objectiveStrategyRequestCodec.digest(request),
        receipt: objectiveStrategyRequestCodec.pendingReceipt(request,
          { clientId: a.clientId, objectiveId: id(62), objectiveVersion: 1, objectiveRevisionId: id(63) }) } };
      input[key] = null;
      f.h.jobs = [{ id: id(60), clientId: a.clientId, strategyId: null, input }];
      expect((await f.owner.reconcileWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).state).toBe('outcome_unconfirmed');
    });
  test.each([{}, { enabled: true, durationLimitMs: null }, { enabled: true, durationLimitMs: 1800001 }])(
    'requires explicit well-formed tenant opt-in %#', async p => {
      const f = fixture(); await f.lock(); await f.owner.reconcileWithinTx(f.tx, a, 'objective.strategy.draft', f.s);
      f.h.settings = { ...settings, objectiveStrategyIntake: p };
      await expect(f.owner.policyWithinTx(f.tx, a, 'objective.strategy.draft', f.s)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    });
});
