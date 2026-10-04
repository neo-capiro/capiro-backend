// Only the immutable fixture loader and authority I/O are replaced. The API
// dispatcher, result construction and before/after proof comparisons are real.
jest.mock('node:url', () => ({ ...jest.requireActual('node:url'),
  pathToFileURL: () => ({ href: 'controlled-case20-owner-test' }) }));
jest.mock('controlled-case20-owner-test', () => ({ qualifyControlledReadInTx: jest.fn() }), { virtual: true });
jest.mock('./meri-server-readonly-capture.js', () => ({
  assertMeriServerReadonlyCaptureCurrentAuthority: jest.fn(),
  meriReadonlyCaptureCatalogSha256: () => 'a'.repeat(64),
}));
jest.mock('./meri-tool-request-control.js', () => ({
  currentMeriToolCapturePolicy: jest.fn(), assertMeriToolRequestActive: jest.fn(),
}));
import { tryExecuteMeriControlledRead, meriControlledReadHttpStatus } from './meri-controlled-read-fixture.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';
import { captureBudgetTestContext as ctx, captureBudgetTestPolicy } from './meri-capture-provider-budget.spec-helper.js';
import { currentMeriToolCapturePolicy } from './meri-tool-request-control.js';
import { assertMeriServerReadonlyCaptureCurrentAuthority } from './meri-server-readonly-capture.js';

const owner = require('controlled-case20-owner-test') as { qualifyControlledReadInTx: jest.Mock };
const text = 'R2-27, page 14. PE 0912345T. FY27 President’s Budget request: $42M.';
const sourceId = '2d0c016e-8dad-5f6e-80dd-e36740fff7ee';
function fixture() {
  const sourceMap = { 'R2-27': { physicalId: sourceId } }; const currentVerify = { sourceId };
  const p = { ...captureBudgetTestPolicy(), caseId: '20', clientId: 'aster',
    captureRunId: '11111111-1111-4111-8111-111111111111', physicalMapSha256: captureBudgetHash(sourceMap) };
  const proof = { fixtureReady: true, missing: [], liveAcceptance: 'NOT_RUN',
    fixtureNamespace: p.fixtureNamespace, fixtureVersion: p.fixtureVersion, tenantId: ctx.tenantId,
    actorUserId: ctx.userId, clientId: p.clientId, caseId: p.caseId, captureRunId: p.captureRunId,
    sourceMap, physicalMapSha256: p.physicalMapSha256, currentVerify,
    currentVerifySha256: captureBudgetHash(currentVerify), seedReceiptId: p.seedReceiptId, resetReceiptId: p.resetReceiptId,
    definition: { reads: [{ logicalId: 'R2-27', physicalId: sourceId, kind: 'program_element', version: 'v1',
      content: text, contentSha256: 'd'.repeat(64), facts: { peCode: '0912345T', fiscalYear: 2027, amountUsd: 42000000, page: 14 } }] } };
  const tx = { tenant: { findUnique: jest.fn(async () => ({ settings: { meriFoundationFixture: {
    captureEvidence: { actorUserId: ctx.userId, clientId: p.clientId, currentVerifySha256: proof.currentVerifySha256 } } } })) } };
  const prisma = { withTenantUser: jest.fn(async (tenant: string, actor: string, fn: (tx: unknown) => unknown) => {
    expect([tenant, actor]).toEqual([ctx.tenantId, ctx.userId]); return fn(tx);
  }) };
  jest.mocked(currentMeriToolCapturePolicy).mockReturnValue(p);
  owner.qualifyControlledReadInTx.mockResolvedValue(proof);
  return { p, proof, prisma };
}
describe('Case20 qualified source coverage', () => {
  const namespace = process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE;
  beforeEach(() => { jest.clearAllMocks(); process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'meri-foundation-20260928'; });
  afterAll(() => { if (namespace === undefined) delete process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE; else process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = namespace; });
  test.each(['search_program_elements', 'get_program_element', 'get_pe_budget_timeline'])(
    '%s reports completion only for the exact returned, currently qualified source', async (tool) => {
      const { prisma } = fixture();
      const result = await tryExecuteMeriControlledRead(prisma as never, ctx, tool,
        tool === 'search_program_elements' ? { query: '0912345T', limit: 1 } : { peCode: '0912345T' });
      expect(result!.coverage).toEqual({ total: 1, returned: 1, complete: true, paginationComplete: true,
        truncated: false, nextCursor: null });
      expect(result!.records).toEqual([expect.objectContaining({ id: sourceId, text })]);
      expect(result!.controlledRead).toMatchObject({ sourceTenantId: ctx.tenantId, sourceClientId: null, logicalSourceId: 'R2-27' });
      expect(owner.qualifyControlledReadInTx).toHaveBeenCalledTimes(2);
      expect(assertMeriServerReadonlyCaptureCurrentAuthority).toHaveBeenCalledTimes(2);
      expect(meriControlledReadHttpStatus(result)).toBe(200);
    });
  test('a changed after-read binding cannot release complete coverage', async () => {
    const { prisma, proof } = fixture();
    owner.qualifyControlledReadInTx.mockResolvedValueOnce(proof).mockResolvedValueOnce({ ...proof, clientId: 'other-client' });
    await expect(tryExecuteMeriControlledRead(prisma as never, ctx, 'get_pe_budget_timeline', { peCode: '0912345T' }))
      .rejects.toThrow('current_proof_mismatch');
  });
  test('does not manufacture coverage for ordinary traffic or a different selector', async () => {
    const { prisma } = fixture();
    await expect(tryExecuteMeriControlledRead(prisma as never, ctx, 'get_pe_budget_timeline', { peCode: 'OTHER' }))
      .rejects.toThrow('budget_selector_unsupported');
    jest.mocked(currentMeriToolCapturePolicy).mockReturnValue(undefined);
    expect(await tryExecuteMeriControlledRead(prisma as never, ctx, 'get_pe_budget_timeline', { peCode: '0912345T' })).toBeUndefined();
  });
});
