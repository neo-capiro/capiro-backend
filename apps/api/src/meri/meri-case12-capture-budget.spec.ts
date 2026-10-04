jest.mock('./meri-case12-capture-authority.js', () => ({assertMeriCase12BindingInTx: jest.fn()}));
jest.mock('./meri-server-readonly-capture.js', () => ({
  assertMeriServerReadonlyCaptureCurrentAuthority: jest.fn(async () => undefined),
  meriReadonlyCaptureCatalogSha256: () => 'f'.repeat(64),
}));
import { assertMeriCase12BindingInTx } from './meri-case12-capture-authority.js';
import { admitCaptureProviderBudget, readCaptureProviderBudget, reserveCaptureProviderAttempt,
  settleCaptureProviderAttempt, captureProviderBudgetCoverage } from './meri-capture-provider-budget.js';
import { inspectCaptureProviderBudgetReadiness, captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import { withCaptureApiProviderScope, assertCaptureApiRetrievalPlan } from './meri-capture-api-provider-scope.js';
import {captureBudgetTestPolicy, captureBudgetTestQualification, captureBudgetTestBinding,
  captureBudgetTestContext as ctx} from './meri-capture-provider-budget.spec-helper.js';

function policy() {
  return {...captureBudgetTestPolicy(), caseId: '12', captureRunId: '33333333-3333-4333-8333-333333333333',
    clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
    resetReceiptId: null, seedReceiptId: null, case12Setup: {
      setupRunId: '11111111-1111-4111-8111-111111111111', fixtureInstanceId: '22222222-2222-4222-8222-222222222222',
      setupPlanSha256: 'a'.repeat(64), setupClaimSha256: 'b'.repeat(64), setupLedgerSha256: 'c'.repeat(64),
    }};
}
beforeEach(() => jest.mocked(assertMeriCase12BindingInTx).mockReset());

test('Case12 capture ledger uses its own boundary and setup identity, with ordinary attempt accounting', () => {
  const p = policy(), q = captureBudgetTestQualification(p), b = captureBudgetTestBinding();
  expect(captureProviderBudgetCoverage('12')).toBe('case12_memory_turn');
  const admitted = admitCaptureProviderBudget({unrelated: 'kept'}, p, q);
  const reserved = reserveCaptureProviderAttempt(admitted.metadata, p, q, b);
  expect(reserved.dispatchAllowed).toBe(true);
  expect(reserveCaptureProviderAttempt(reserved.metadata, p, q, b).dispatchAllowed).toBe(false);
  const settled = settleCaptureProviderAttempt(reserved.metadata, p, q, {reservationId: reserved.reservationId,
    binding: b, outcome: {kind: 'known', inputTokens: 10, outputTokens: 5}});
  expect(settled.state.ledger.chargedCostMicros).toBe(20);
  expect(settled.metadata).toMatchObject({unrelated: 'kept'});
  for (const changed of [
    {...p, case12Setup: {...p.case12Setup, setupLedgerSha256: 'd'.repeat(64)}},
    {...p, case12Setup: {...p.case12Setup, setupClaimSha256: 'd'.repeat(64)}},
    {...p, captureRunId: p.case12Setup.setupRunId}, {...p, seedReceiptId: 'borrowed'},
    {...p, resetReceiptId: 'borrowed'}, {...p, case12Setup: undefined},
  ]) expect(() => readCaptureProviderBudget(settled.metadata, changed, q)).toThrow();
  expect(() => admitCaptureProviderBudget({}, p, {...q, caseId: '14'})).toThrow();
});

test('Case12 provider scope accepts only the existing selected-client memory retrieval plan', async () => {
  await withCaptureApiProviderScope({} as never, ctx, policy(), async () => {
    expect(() => assertCaptureApiRetrievalPlan({subjectScope: 'client', requestedDomains: ['institutional_knowledge']})).not.toThrow();
    for (const plan of [
      {subjectScope: 'general', requestedDomains: ['institutional_knowledge']},
      {subjectScope: 'client', requestedDomains: ['mail']},
      {subjectScope: 'client', requestedDomains: ['institutional_knowledge', 'contacts']},
    ]) expect(() => assertCaptureApiRetrievalPlan(plan)).toThrow('unqualified');
  });
});

test.each(['readiness', 'admit', 'read', 'reserve', 'settle'] as const)(
  'Case12 %s rechecks the current native corpus/setup before inspecting or mutating its ledger', async stage => {
    const p = policy();
    const tx = {tenant: {findUnique: jest.fn()}, $queryRaw: jest.fn(async () => []), $executeRaw: jest.fn()};
    const prisma = {withTenantUser: jest.fn(async (_tenant, _user, callback) => callback(tx))};
    jest.mocked(assertMeriCase12BindingInTx).mockRejectedValue(new Error('CURRENT_CASE12_REVOKED'));
    const args = {prisma: prisma as never, ctx, policy: p};
    const attempt = stage === 'readiness' ? inspectCaptureProviderBudgetReadiness(args)
      : captureProviderBudgetOwner({...args, operation: stage === 'reserve' ? {kind: 'reserve', binding: captureBudgetTestBinding()}
        : stage === 'settle' ? {kind: 'settle', input: {reservationId: 'not-dispatched', binding: captureBudgetTestBinding(), outcome: {kind: 'uncertain'}}}
        : {kind: stage}});
    await expect(attempt).rejects.toThrow('CURRENT_CASE12_REVOKED');
    expect(assertMeriCase12BindingInTx).toHaveBeenCalledWith(prisma, tx, ctx, p);
    expect(tx.tenant.findUnique).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  },
);
