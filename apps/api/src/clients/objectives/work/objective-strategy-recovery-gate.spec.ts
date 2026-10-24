import { ObjectiveWorkService } from './objective-work.service.js';
import { ObjectiveWorkOwnerRouter } from './objective-work-owner.router.js';
import { ObjectiveStrategyWorkOwner } from './objective-strategy-work-owner.js';
import { objectiveStrategyRequestCodec, objectiveStrategySelectionBody, objectiveStrategySelectionDigest,
  parseObjectiveStrategySelection } from './objective-strategy-selection.js';
import { ObjectiveWorkError, workDigest, type StoredWorkReceipt, type WorkAuthority, type WorkSource } from './objective-work-command.js';
import type { ApplicationAuthorityIdentityProof } from '../../../auth/application-authority.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wire = () => ({ schemaVersion: 2, command: { schemaVersion: 1, requestId: id(12), command: 'retry',
  workAction: 'objective.strategy.draft', expectedObjectiveVersion: 1, expectedControlVersion: 0,
  expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: null },
selection: { type: 'appropriations', generationRequestId: id(13) } });

/** Actual service, transaction ports, command kernel, action router and immutable
 * companion verifier. Current native identity/ACL and receipt-storage seams are
 * explicit synthetic fixtures; these tests claim no live auth or SQL durability.
 */
function fixture(env: Record<string, string | undefined> = {}, withSystemOwner = false) {
  const original = parseObjectiveStrategySelection(id(2), id(3), wire());
  const ctx = { tenantId: id(1), userId: id(4), clerkUserId: 'user_original', role: 'standard_user' } as any;
  // The current Objective has changed and is no longer ready. Recovery must
  // return the historical receipt before any fresh-source/version preflight.
  const authority: WorkAuthority = { tenantId: ctx.tenantId, clientId: id(2), objectiveId: id(3), actorUserId: ctx.userId,
    actorMembershipId: id(5), clerkUserId: ctx.clerkUserId, objectiveRevisionId: id(18), objectiveVersion: 2, objectiveStatus: 'draft' };
  const source: WorkSource = { canonicalPlanId: id(7), canonicalEpoch: 1, canonicalStrategyId: id(8), canonicalProjectId: id(9),
    canonicalBindingVersion: 1, rootIntentId: id(10), sourceRevisionId: id(6), sourceObjectiveVersion: 1,
    sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: ctx.userId };
  const stored: StoredWorkReceipt = { actorUserId: ctx.userId, actorMembershipId: authority.actorMembershipId, controlId: id(11),
    command: original.work.command, source, receipt: { schemaVersion: 1, receiptId: id(14), requestId: id(12),
      payloadDigest: workDigest(original.work), clientId: id(2), objectiveId: id(3), command: 'retry', workAction: 'objective.strategy.draft',
      commandRevision: { id: id(6), version: 1 }, sourceRevision: { id: id(6), version: 1 }, rootIntentId: id(10),
      controlVersionBefore: 0, controlVersionAfter: 1, targetAuthorizationRequestId: null, authorizationRequestId: id(15),
      consent: { id: id(15), confirmedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:01:00.000Z' },
      outcome: 'reconsent_recorded', committedAt: '2020-01-01T00:00:00.001Z' } };
  const draft = objectiveStrategyRequestCodec.parseObjectiveDraft({ requestId: id(13), clientId: id(2),
    objective: { objectiveId: id(3), objectiveVersion: 1 }, type: 'appropriations' });
  const companion = { id: id(16), generation_job_id: id(17), tenant_id: id(1), client_id: id(2), objective_id: id(3),
    work_action: 'objective.strategy.draft', control_id: id(11), consent_id: id(15), command_receipt_id: id(14), command_request_id: id(12),
    control_version: 1, actor_user_id: ctx.userId, actor_membership_id: authority.actorMembershipId, original_clerk_user_id: ctx.clerkUserId,
    canonical_plan_id: source.canonicalPlanId, canonical_epoch: 1, canonical_strategy_id: source.canonicalStrategyId,
    canonical_project_id: source.canonicalProjectId, canonical_binding_version: 1, root_intent_id: source.rootIntentId,
    source_revision_id: source.sourceRevisionId, source_objective_version: 1, source_snapshot_hash: source.sourceSnapshotHash,
    root_actor_user_id: source.rootActorUserId, selected_type: 'appropriations', generation_request_id: id(13),
    wrapper: objectiveStrategySelectionBody(original), wrapper_sha256: objectiveStrategySelectionDigest(original), typed_request: draft,
    request_fingerprint: objectiveStrategyRequestCodec.digest(draft), job_request_key: objectiveStrategyRequestCodec.requestKey(id(1), ctx.clerkUserId, id(13)),
    original_deadline_at: '2020-01-01T00:01:00.000Z', reserved_at: '2020-01-01T00:00:00.002Z' };
  const state = { receiptPresent: true, companionPresent: true, currentIdentity: true, currentAccess: true, currentProof: true };
  const domainWrites: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?');
      if (!sql.includes("set_config('statement_timeout'")) { domainWrites.push(sql); throw Error('Unexpected domain write'); }
      return 1;
    }),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?');
      if (sql.includes('clock_timestamp() <')) return [{ valid: state.currentProof }];
      if (sql.includes('FROM client_objective_strategy_intakes')) return state.companionPresent ? [{ record: companion }] : [];
      throw Error('Unexpected native source query');
    }),
  } as any;
  const proof: ApplicationAuthorityIdentityProof = { principal: { tenantId: ctx.tenantId, actorId: ctx.userId }, identityRevision: 'synthetic-current-native-identity',
    expiresAtMs: Date.now() + 60_000, recheckCurrent: jest.fn(async () => {
      if (!state.currentIdentity) throw Error('Synthetic current identity revoked');
      return { principal: proof.principal, identityRevision: proof.identityRevision, expiresAtMs: proof.expiresAtMs };
    }) };
  const tenant = { readApplicationAuthority: jest.fn(async () => proof) } as any;
  const prisma = { withTenant: jest.fn(async (_tenant: string, run: (tx: any) => Promise<unknown>) => run(tx)) } as any;
  const withSystem = jest.fn(async () => { throw Error('Recovery must not request global output absence'); });
  const strategy = new ObjectiveStrategyWorkOwner(env, withSystemOwner ? { withSystem } as any : undefined);
  const register = jest.spyOn(strategy, 'bindStrategySelectionWithinTx');
  const service = new ObjectiveWorkService(prisma, tenant, new ObjectiveWorkOwnerRouter(undefined, strategy));
  const currentAuthority = jest.spyOn(service as any, 'currentAuthority').mockImplementation(async () => {
    if (!state.currentAccess) throw new ObjectiveWorkError('NOT_AVAILABLE');
    return authority;
  });
  const receipt = jest.spyOn(service as any, 'receipt').mockImplementation(async () => state.receiptPresent ? stored : null);
  const currentState = jest.spyOn(service as any, 'state');
  const ports = jest.spyOn(service as any, 'ports');
  const req = { originalUrl: '/api/clients/original/objectives/original/generation/strategy-commands' } as any;
  const run = (body = wire()) => service.selectedStrategyCommand(ctx, req, parseObjectiveStrategySelection(id(2), id(3), body));
  return { service, strategy, ctx, req, original, authority, stored, companion, state, tx, prisma, tenant, proof, register,
    currentAuthority, receipt, currentState, ports, domainWrites, withSystem, run };
}

describe('selected Strategy recovery is independent of fresh-write enablement', () => {
  test.each([
    ['flag off', {}, false],
    ['flag off with configured duration', { OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: '60000' }, true],
    ['malformed duration', { OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: 'not-a-duration' }, true],
    ['missing duration', { OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true' }, true],
    ['missing global output owner', { OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: '60000' }, false],
  ] as const)('recovers the exact expired v2 receipt with %s after the current Objective changes', async (_name, env, system) => {
    const f = fixture(env, system), result = await f.run();
    expect(result).toEqual({ schemaVersion: 2, commandReceipt: f.stored.receipt, selection: f.original.selection,
      generationJobId: f.companion.generation_job_id });
    expect(Date.parse(result.commandReceipt.consent!.expiresAt)).toBeLessThan(Date.now());
    expect(result.commandReceipt.commandRevision.version).not.toBe(f.authority.objectiveVersion);
    expect(f.register).toHaveBeenCalledTimes(1); expect(f.register.mock.calls[0]![3]).toBe('recovery-read');
    expect(f.ports.mock.calls.every(call => call[5] === false)).toBe(true);
    expect(f.currentState).not.toHaveBeenCalled(); expect(f.domainWrites).toEqual([]); expect(f.withSystem).not.toHaveBeenCalled();
    expect(f.tenant.readApplicationAuthority).toHaveBeenCalledWith(f.req, f.ctx);
    expect(f.proof.recheckCurrent).toHaveBeenCalledTimes(2); expect(f.currentAuthority).toHaveBeenCalledTimes(1);
    const companionRead = f.tx.$queryRaw.mock.calls.find((call: any[]) => call[0].join('?').includes('FROM client_objective_strategy_intakes'));
    expect(companionRead).toBeDefined(); expect(companionRead![0].join('?')).not.toMatch(/FOR\s+(SHARE|UPDATE)/);
  });

  test.each(['type', 'generationRequestId'] as const)('changed retained %s still conflicts while writes are disabled', async field => {
    const f = fixture(), body = wire();
    if (field === 'type') body.selection.type = 'authorization'; else body.selection.generationRequestId = id(22);
    await expect(f.run(body)).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT', requestId: id(12) });
    expect(f.register.mock.calls.map(call => call[3])).toEqual(['recovery-read']);
    expect(f.currentState).not.toHaveBeenCalled(); expect(f.domainWrites).toEqual([]);
  });

  test.each([
    {},
    { OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: 'invalid' },
  ])('missing receipt cannot turn read recovery into a disabled fresh write %#', async env => {
    const f = fixture(env, true); f.state.receiptPresent = false;
    await expect(f.run()).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE', requestId: id(12) });
    expect(f.register.mock.calls.map(call => call[3])).toEqual(['recovery-read', 'write']);
    expect(f.receipt).toHaveBeenCalledTimes(1); expect(f.currentState).not.toHaveBeenCalled();
    expect(f.domainWrites).toEqual([]); expect(f.withSystem).not.toHaveBeenCalled();
  });

  test.each(['identity', 'access', 'proof'] as const)('current native %s is still required before historical release', async condition => {
    const f = fixture();
    if (condition === 'identity') f.state.currentIdentity = false;
    if (condition === 'access') f.state.currentAccess = false;
    if (condition === 'proof') f.state.currentProof = false;
    await expect(f.run()).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(f.receipt).not.toHaveBeenCalled(); expect(f.currentState).not.toHaveBeenCalled(); expect(f.domainWrites).toEqual([]);
  });

  test('a bare legacy receipt cannot be promoted into selected v2 recovery', async () => {
    const f = fixture(); f.state.companionPresent = false;
    await expect(f.run()).rejects.toMatchObject({ code: 'RECEIPT_UNVERIFIABLE', requestId: id(12) });
    expect(f.currentState).not.toHaveBeenCalled(); expect(f.domainWrites).toEqual([]);
  });

  test('a caller cannot replace the saved generation job identity on recovery', async () => {
    const f = fixture(), body = { ...wire(), generationJobId: id(22) };
    expect(() => f.run(body)).toThrow('INVALID_REQUEST');
    expect(f.prisma.withTenant).not.toHaveBeenCalled();
  });

  test('trusted recovery mode still applies the strict existing wrapper parser', () => {
    const f = fixture(), malformed = { ...f.original, selection: { ...f.original.selection, type: 'unapproved-type' } } as any;
    expect(() => f.strategy.bindStrategySelectionWithinTx(f.tx, f.ctx, malformed, 'recovery-read')).toThrow('INVALID_REQUEST');
    expect(() => f.strategy.bindStrategySelectionWithinTx(f.tx, f.ctx, f.original)).toThrow('AUTHORITY_UNAVAILABLE');
    expect(() => f.strategy.bindStrategySelectionWithinTx(f.tx, f.ctx, f.original, 'caller-mode' as any)).toThrow('AUTHORITY_UNAVAILABLE');
    expect(f.domainWrites).toEqual([]);
  });
});

/** Keep the real command kernel, selected-store wrapper, native companion
 * verifier and transaction proof checks. Only the unchanged command-storage
 * ports and reservation SQL are synthetic here, not a durability claim. */
function freshFixture() {
  const f = fixture({ OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: '60000' }, true);
  f.state.receiptPresent = false; f.state.companionPresent = false;
  Object.assign(f.authority, { objectiveRevisionId: id(6), objectiveVersion: 1, objectiveStatus: 'ready' });
  const now = new Date(Date.now() - 1000).toISOString(), ids = [id(14), id(15)];
  const insertReceipt = jest.fn(async (_a: WorkAuthority, stored: StoredWorkReceipt) => {
    Object.assign(f.stored, stored); f.state.receiptPresent = true;
  });
  const reserve = jest.spyOn(f.strategy, 'reserveStrategyWithinTx').mockImplementation(async (_tx, _a, stored) => {
    Object.assign(f.companion, { command_receipt_id: stored.receipt.receiptId, consent_id: stored.receipt.authorizationRequestId,
      control_version: stored.receipt.controlVersionAfter, original_deadline_at: stored.receipt.consent!.expiresAt,
      reserved_at: stored.receipt.committedAt });
    f.state.companionPresent = true;
  });
  f.ports.mockImplementation(() => ({
    currentAuthority: async () => f.authority, lockOwner: async () => {},
    receipt: async () => f.state.receiptPresent ? f.stored : null,
    state: async () => ({ source: f.stored.source, control: { id: id(11), version: 0, currentConsentId: null,
      cancelledAt: null, cancelledByUserId: null }, consent: null }),
    reconcile: async () => ({ state: 'not_started', tenantId: id(1), clientId: id(2), objectiveId: id(3),
      workAction: 'objective.strategy.draft', authorizationRequestId: null, rootIntentId: id(10),
      canonicalPlanId: id(7), canonicalEpoch: 1 }),
    policy: async () => ({ configuredDurationMs: 60000, tenantDurationLimitMs: null, actionDurationLimitMs: 1800000,
      originalTokenExpiresAtMs: f.proof.expiresAtMs, originalDelegationExpiresAtMs: null, limitReference: 'objective-strategy-intake:v1' }),
    clock: async () => now, insertConsent: async () => {}, casControl: async () => true,
    insertReceipt, newId: () => ids.shift()!,
  }));
  return { ...f, insertReceipt, reserve };
}

describe('selected Strategy receipt exposes only its committed reservation', () => {
  test('original and exact-command replay return the same persisted job without changing the v1 receipt', async () => {
    const f = freshFixture(), original = await f.run(), storedReceipt = JSON.stringify(f.stored.receipt);
    expect(original.generationJobId).toBe(f.companion.generation_job_id);
    expect(original.generationJobId).not.toBe(f.original.selection.generationRequestId);
    expect(original.commandReceipt).toEqual(f.stored.receipt);
    expect(original.commandReceipt).not.toHaveProperty('generationJobId');
    const replay = await f.run();
    expect(replay).toEqual(original);
    expect(JSON.stringify(f.stored.receipt)).toBe(storedReceipt);
    expect(f.insertReceipt).toHaveBeenCalledTimes(1); expect(f.reserve).toHaveBeenCalledTimes(1);
  });

  test('transaction failure after reservation never releases the captured job', async () => {
    const f = freshFixture(); let transactions = 0;
    f.prisma.withTenant.mockImplementation(async (_tenant: string, run: (tx: any) => Promise<unknown>) => {
      const result = await run(f.tx);
      if (++transactions === 2) throw Error('Synthetic commit refused');
      return result;
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(f.reserve).toHaveBeenCalledTimes(1);
  });
});
