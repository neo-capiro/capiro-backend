import { ObjectiveWorkService } from './objective-work.service.js';
import { ObjectiveWorkController } from './objective-work.controller.js';
import { ObjectiveWorkOwnerRouter } from './objective-work-owner.router.js';
import { parseObjectiveStrategySelection } from './objective-strategy-selection.js';
import { workDigest, type StoredWorkReceipt, type WorkAction } from './objective-work-command.js';
import type { ApplicationAuthorityIdentityProof } from '../../../auth/application-authority.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wire = () => ({ schemaVersion: 2, command: { schemaVersion: 1, requestId: id(1), command: 'retry',
  workAction: 'objective.strategy.draft', expectedObjectiveVersion: 1, expectedControlVersion: 0,
  expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: null },
selection: { type: 'appropriations', generationRequestId: id(2) } });

// Actual service and unchanged recovery kernel; authority/SQL responses below
// are synthetic. These cases prove replay routing, not native identity or DB
// atomicity. Native database qualification is a separate check.
function legacyFixture() {
  const ctx = { tenantId: id(3), userId: id(6), clerkUserId: 'user_original', role: 'standard_user' } as any;
  const request = parseObjectiveStrategySelection(id(4), id(5), wire()).work;
  const planner = { ...request, command: { ...request.command, requestId: id(7), workAction: 'objective.plan.prepare' as const } };
  const a = { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorMembershipId: id(8), clerkUserId: ctx.clerkUserId,
    clientId: id(4), objectiveId: id(5), objectiveRevisionId: id(9), objectiveVersion: 1, objectiveStatus: 'ready' };
  const stored = (action: WorkAction, command = action === 'objective.strategy.draft' ? request.command : planner.command): StoredWorkReceipt => ({
    actorUserId: a.actorUserId, actorMembershipId: a.actorMembershipId,
    controlId: action === 'objective.strategy.draft' ? id(10) : id(19), command,
    source: { canonicalPlanId: id(11), canonicalEpoch: 1, canonicalStrategyId: id(12), canonicalProjectId: id(13),
      canonicalBindingVersion: 1, rootIntentId: id(14), sourceRevisionId: id(9), sourceObjectiveVersion: 1,
      sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: a.actorUserId },
    receipt: { schemaVersion: 1, receiptId: action === 'objective.strategy.draft' ? id(15) : id(16),
      requestId: command.requestId, payloadDigest: workDigest({ ...request, command }), clientId: id(4), objectiveId: id(5),
      command: 'retry', workAction: action, commandRevision: { id: id(9), version: 1 }, sourceRevision: { id: id(9), version: 1 },
      rootIntentId: id(14), controlVersionBefore: 0, controlVersionAfter: 1, targetAuthorizationRequestId: null,
      authorizationRequestId: action === 'objective.strategy.draft' ? id(17) : id(20),
      consent: { id: action === 'objective.strategy.draft' ? id(17) : id(20),
        confirmedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:01:00.000Z' },
      outcome: 'reconsent_recorded', committedAt: '2026-01-01T00:00:00.001Z' },
  });
  const rows: Partial<Record<WorkAction, StoredWorkReceipt>> = { 'objective.strategy.draft': stored('objective.strategy.draft'),
    'objective.plan.prepare': stored('objective.plan.prepare') };
  const h = { selected: false };
  const tx = { $executeRaw: jest.fn(async () => 1), $queryRaw: jest.fn(async (parts: TemplateStringsArray) =>
    parts.join('?').includes('FROM client_objective_strategy_intakes') ? h.selected ? [{ id: id(18) }] : [] : [{ valid: true }]) };
  const prisma = { withTenant: jest.fn(async (_tenant, run) => run(tx)) } as any;
  const proof: ApplicationAuthorityIdentityProof = { principal: { tenantId: ctx.tenantId, actorId: ctx.userId }, identityRevision: 'native-test-revision',
    expiresAtMs: Date.now() + 60_000, recheckCurrent: jest.fn(async () => ({ principal: proof.principal,
      identityRevision: proof.identityRevision, expiresAtMs: proof.expiresAtMs })) };
  const tenant = { readApplicationAuthority: jest.fn(async () => proof) } as any;
  const service = new ObjectiveWorkService(prisma, tenant, new ObjectiveWorkOwnerRouter());
  const domainWrite = jest.fn(() => { throw Error('Replay attempted a domain mutation'); });
  const ports = jest.spyOn(service as any, 'ports').mockImplementation(() => ({ currentAuthority: async () => a,
    receipt: async (_a: unknown, action: WorkAction) => rows[action] ?? null,
    state: domainWrite, lockOwner: domainWrite, insertConsent: domainWrite, insertReceipt: domainWrite, casControl: domainWrite }));
  const pair = { clientId: request.clientId, objectiveId: request.objectiveId, strategy: request, planner };
  return { service, request, pair, ctx, rows, h, tx, domainWrite, ports, tenant };
}
describe('selected Strategy route and action routing boundary', () => {
  test('the new controller forwards the actual wrapper Request, never a fabricated v1 Request', async () => {
    const actualRequest = { originalUrl: '/api/clients/client/objectives/objective/generation/strategy-commands' }, ctx = { tenantId: id(3) };
    const selectedStrategyCommand = jest.fn(async (_ctx, _request, selected) => selected);
    const controller = new ObjectiveWorkController({ selectedStrategyCommand } as any), body = wire();
    const result = await controller.selectedStrategy(ctx as any, actualRequest as any, id(4), id(5), body);
    expect(selectedStrategyCommand).toHaveBeenCalledWith(ctx, actualRequest, parseObjectiveStrategySelection(id(4), id(5), body));
    expect(result.selection).toEqual({ type: 'appropriations', generationRequestId: id(2) });
  });
  test('the old v1 receipt is recovered exactly without renewing its expired consent or entering a writer', async () => {
    const f = legacyFixture(), req = {} as any;
    expect(await f.service.command(f.ctx, req, f.request)).toEqual(f.rows['objective.strategy.draft']!.receipt);
    expect(f.tenant.readApplicationAuthority).toHaveBeenCalledWith(req, f.ctx);
    expect(f.ports.mock.calls.every(call => call[5] === false)).toBe(true);
    expect(f.domainWrite).not.toHaveBeenCalled();
  });
  test.each(['single', 'pair'])('a selected v2 companion refuses the old %s replay path', async kind => {
    const f = legacyFixture(); f.h.selected = true;
    await expect(kind === 'single' ? f.service.command(f.ctx, {} as any, f.request) :
      f.service.confirmPair(f.ctx, {} as any, f.pair)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(f.domainWrite).not.toHaveBeenCalled();
  });
  test('missing untyped work cannot create an empty control, consent or job', async () => {
    const f = legacyFixture(); delete f.rows['objective.strategy.draft'];
    await expect(f.service.command(f.ctx, {} as any, f.request)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(f.domainWrite).not.toHaveBeenCalled();
  });
  test('a complete old pair recovers its two original receipts, while a partial pair stays uncertain', async () => {
    const f = legacyFixture();
    expect(await f.service.confirmPair(f.ctx, {} as any, f.pair)).toEqual({ schemaVersion: 1,
      strategy: f.rows['objective.strategy.draft']!.receipt, planner: f.rows['objective.plan.prepare']!.receipt });
    delete f.rows['objective.plan.prepare'];
    await expect(f.service.confirmPair(f.ctx, {} as any, f.pair)).rejects.toMatchObject({ code: 'OUTCOME_UNCONFIRMED' });
    expect(f.domainWrite).not.toHaveBeenCalled();
  });
});
