jest.mock('./meri-case01-capture-authority.js', () => ({ qualifyMeriCase01CaptureFixture: jest.fn() }));
jest.mock('./meri-case14-capture-authority.js', () => ({ assertMeriCase14BindingInTx: jest.fn() }));
jest.mock('./meri-controlled-read-fixture.js', () => ({ assertMeriControlledReadBindingInTx: jest.fn() }));
jest.mock('./meri-server-readonly-capture.js', () => ({ assertMeriServerReadonlyCaptureCurrentAuthority: jest.fn(), meriReadonlyCaptureCatalogSha256: () => 'a'.repeat(64) }));
jest.mock('./meri-case46-provider-budget-owner.js', () => ({ issueCurrentCase46Policy: jest.fn() }));

import { qualifyMeriCaptureSemanticClock } from './meri-capture-semantic-clock.js';
import { qualifyMeriCase01CaptureFixture } from './meri-case01-capture-authority.js';
import { assertMeriCase14BindingInTx } from './meri-case14-capture-authority.js';
import { assertMeriControlledReadBindingInTx } from './meri-controlled-read-fixture.js';
import { assertMeriServerReadonlyCaptureCurrentAuthority } from './meri-server-readonly-capture.js';
import { captureBudgetTestPolicy } from './meri-capture-provider-budget.spec-helper.js';

const ctx = { tenantId: 'tenant', userId: 'actor' } as never;
const prisma = { withTenantUser: async (_t: string, _u: string, fn: (tx: never) => unknown) => fn({} as never) } as never;
const currentVerifySha256 = 'a'.repeat(64);
function policy() {
  return { ...captureBudgetTestPolicy(), fixtureVersion: 'meri-live-v1-2026-09-26.1',
    caseId: '01', captureRunId: '11111111-1111-4111-8111-111111111111' };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(qualifyMeriCase01CaptureFixture).mockResolvedValue({ currentVerifySha256 } as never);
  jest.mocked(assertMeriCase14BindingInTx).mockResolvedValue({ currentVerifySha256 } as never);
  jest.mocked(assertMeriControlledReadBindingInTx).mockResolvedValue({ currentVerifySha256 } as never);
});
test.each(['01', '14', '20', '72'])('only canonical owner proof mints the fixed case %s clock', async (caseId) => {
  const p = { ...policy(), caseId };
  const clock = await qualifyMeriCaptureSemanticClock({ prisma, ctx, policy: p });
  expect(clock).toEqual({ version: 1, kind: 'qualified_original_fixture_semantic_clock',
    instant: '2026-09-26T16:00:00.000Z', timeZone: 'America/New_York', caseId,
    captureRunId: p.captureRunId, currentVerifySha256, observedAt: p.issuedAt });
  expect(assertMeriServerReadonlyCaptureCurrentAuthority).toHaveBeenCalledTimes(2);
  const owner = caseId === '01' ? qualifyMeriCase01CaptureFixture : caseId === '14'
    ? assertMeriCase14BindingInTx : assertMeriControlledReadBindingInTx;
  expect(owner).toHaveBeenCalledTimes(1);
});
test('ordinary, unqualified and budget-only captures cannot acquire fixture time', async () => {
  for (const p of [null, { ...policy(), fixtureVersion: null },
    { ...policy(), syntheticReadBudget: {} }]) {
    expect(await qualifyMeriCaptureSemanticClock({ prisma, ctx, policy: p as never })).toBeUndefined();
  }
  expect(qualifyMeriCase01CaptureFixture).not.toHaveBeenCalled();
});
test('closed cases and a failed current owner remain fail closed', async () => {
  await expect(qualifyMeriCaptureSemanticClock({ prisma, ctx, policy: { ...policy(), caseId: '21' } }))
    .rejects.toThrow('case_not_qualified');
  jest.mocked(qualifyMeriCase01CaptureFixture).mockRejectedValueOnce(new Error('canonical proof unavailable'));
  await expect(qualifyMeriCaptureSemanticClock({ prisma, ctx, policy: policy() }))
    .rejects.toThrow('canonical proof unavailable');
});
