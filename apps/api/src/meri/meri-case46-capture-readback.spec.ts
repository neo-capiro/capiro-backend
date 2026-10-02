import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';
import { case46BudgetHash } from './meri-case46-provider-budget.js';
import { publicCase46ConversationMetadata, readCase46CaptureAdmission, readCase46CaptureMessage } from './meri-case46-capture-readback.js';
import { readMeriControlledCaptureAdmission } from './meri-controlled-read-capture-authority.js';
import { readMeriCase01CaptureAdmission } from './meri-case01-capture-authority.js';
import { readMeriCase14CaptureAdmission } from './meri-case14-capture-authority.js';

jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({ AiCredentialResolverService: class {} }));
jest.mock('../context/context-compiler.service.js', () => ({ ContextCompilerService: class {} }));
jest.mock('./meri-case46-capture-readback.js', () => ({
  ...jest.requireActual('./meri-case46-capture-readback.js'),
  readCase46CaptureAdmission: jest.fn(),
  readCase46CaptureMessage: jest.fn(),
}));
jest.mock('./meri-controlled-read-capture-authority.js', () => ({
  readMeriControlledCaptureAdmission: jest.fn(), readMeriControlledCaptureReadback: jest.fn(),
}));
jest.mock('./meri-case01-capture-authority.js', () => ({
  readMeriCase01CaptureAdmission: jest.fn(), readMeriCase01CaptureReadback: jest.fn(),
}));
jest.mock('./meri-case14-capture-authority.js', () => ({
  readMeriCase14CaptureAdmission: jest.fn(), readMeriCase14CaptureReadback: jest.fn(),
}));
jest.mock('./meri-capture-policy-readback.js', () => ({ authorizeMeriCaptureMessageReadback: jest.fn() }));

const ctx = { tenantId: 'tenant', userId: 'actor' } as TenantContext;
const binding = { version: 1, sealedPolicy: { mac: 'test-private-mac' }, qualification: { rates: [] } };
const metadata = { unrelated: { keep: true }, governedArtifactCapture: binding };
const publicMetadata = { unrelated: { keep: true }, governedArtifactCapture: { version: 1, bindingSha256: case46BudgetHash(binding) } };
function harness(archived = false) {
  const row = { id: 'conversation', tenantId: ctx.tenantId, userId: ctx.userId,
    clientId: null, archivedAt: archived ? new Date() : null, metadata: structuredClone(metadata),
    title: 'Original', summary: null, messages: [], artifacts: [] };
  const message = { id: 'assistant', role: 'assistant', body: 'actual saved body', metadata: {} };
  const tx = {
    clioConversation: {
      findMany: jest.fn(async () => [row]),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
    },
    clioMessage: { findMany: jest.fn(async () => [message]) },
  };
  const deps = { marker: 'actual injected dependency object' };
  const service = Object.assign(Object.create(MeriService.prototype), {
    prisma: { withTenant: jest.fn(async (_id: string, fn: (value: typeof tx) => unknown) => fn(tx)) },
    case46Dependencies: deps,
    ensureConversation: jest.fn(async () => row),
    ensureConversationAnyStatus: jest.fn(async () => row),
    authorizeOrdinaryConversationSummary: jest.fn(async () => null),
    authorizeOrdinaryReportMessages: jest.fn(async (_ctx: unknown, _scope: unknown, value: unknown) => value),
  }) as MeriService;
  return { row, tx, service, deps, message };
}

describe('case46 public DTO boundary and existing service callsites (authority ports mocked here)', () => {
  beforeEach(() => jest.resetAllMocks());
  it('replaces the private transport with its hash without changing stored metadata', () => {
    const before = structuredClone(metadata);
    expect(publicCase46ConversationMetadata(metadata)).toEqual(publicMetadata);
    expect(metadata).toEqual(before);
    expect(JSON.stringify(publicCase46ConversationMetadata(metadata))).not.toContain('test-private-mac');
    const ordinary = { brand: 'Meri', custom: ['unchanged'] };
    expect(publicCase46ConversationMetadata(ordinary)).toBe(ordinary);
    expect(publicCase46ConversationMetadata(null)).toBeNull();
  });
  it('dispatches governed admission first so unrelated readonly bindings cannot claim its conversation', async () => {
    const h = harness();
    const proof = { version: 1, kind: 'meri_case46_current_capture', phase: 'READY' };
    jest.mocked(readCase46CaptureAdmission).mockResolvedValue(proof as never);
    jest.mocked(readMeriControlledCaptureAdmission).mockRejectedValue(new Error('different readonly binding'));
    const result = await h.service.getConversation(ctx, h.row.id);
    expect(result).toMatchObject({ metadata: publicMetadata, captureAdmission: proof });
    expect(readCase46CaptureAdmission).toHaveBeenCalledWith({ prisma: expect.anything(), deps: h.deps,
      ctx, conversationId: h.row.id, conversationMetadata: h.row.metadata });
    expect(readMeriControlledCaptureAdmission).not.toHaveBeenCalled();
    expect(readMeriCase14CaptureAdmission).not.toHaveBeenCalled();
    expect(readMeriCase01CaptureAdmission).not.toHaveBeenCalled();
  });
  it('keeps the original readonly chain and ordinary metadata when no governed binding admits', async () => {
    const h = harness();
    h.row.metadata = { ordinary: true } as never;
    jest.mocked(readCase46CaptureAdmission).mockResolvedValue(null);
    const proof = { caseId: '01' };
    jest.mocked(readMeriCase01CaptureAdmission).mockResolvedValue(proof as never);
    const result = await h.service.getConversation(ctx, h.row.id);
    expect(result).toMatchObject({ metadata: { ordinary: true }, captureAdmission: proof });
    expect(readMeriControlledCaptureAdmission).toHaveBeenCalledTimes(1);
    expect(readMeriCase14CaptureAdmission).toHaveBeenCalledTimes(1);
    expect(readMeriCase01CaptureAdmission).toHaveBeenCalledTimes(1);
  });
  it('strips the internal transport on list, no-op update, actual update, active restore and archived restore', async () => {
    const h = harness();
    expect((await h.service.listConversations(ctx))[0]!.metadata).toEqual(publicMetadata);
    expect((await h.service.updateConversation(ctx, h.row.id, {})).metadata).toEqual(publicMetadata);
    expect((await h.service.updateConversation(ctx, h.row.id, { title: 'New' })).metadata).toEqual(publicMetadata);
    expect((await h.service.restoreConversation(ctx, h.row.id)).metadata).toEqual(publicMetadata);
    const archived = harness(true);
    expect((await archived.service.restoreConversation(ctx, archived.row.id)).metadata).toEqual(publicMetadata);
    expect(h.row.metadata).toEqual(metadata);
    expect(archived.row.metadata).toEqual(metadata);
  });
  it('attaches only the current server readback to the actual returned message and propagates refusal', async () => {
    const h = harness();
    const proof = { caseId: '46', phase: 'ARTIFACT_CREATED' };
    jest.mocked(readCase46CaptureMessage).mockResolvedValue(proof as never);
    const rows = await h.service.listMessages(ctx, h.row.id);
    expect(rows[0]!.metadata).toEqual({ case46CaptureAuthority: proof });
    expect(readCase46CaptureMessage).toHaveBeenCalledWith({ prisma: expect.anything(), deps: h.deps,
      ctx, conversationId: h.row.id, conversationMetadata: h.row.metadata, message: h.message });
    jest.mocked(readCase46CaptureMessage).mockRejectedValue(new Error('meri_case46_readback_current_approval_missing'));
    await expect(h.service.listMessages(ctx, h.row.id)).rejects.toThrow('current_approval_missing');
  });
});
