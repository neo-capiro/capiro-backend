import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  readMeriCase01CaptureAdmission,
  readMeriCase01CaptureReadback,
} from './meri-case01-capture-authority.js';
import { registerMeriCase01FixtureAuthority } from './meri-case01-fixture-authority-registry.js';
import * as capture from './meri-server-readonly-capture.js';
import * as runtime from './meri-context-plane-runtime.js';
import { validateMeriCapturePolicyPair } from './meri-capture-policy-readback.js';
import { inspectCaptureProviderBudgetReadiness } from './meri-capture-provider-budget-owner.js';
import { MeriService } from './meri.service.js';

jest.mock('./meri-server-readonly-capture.js', () => ({
  ...jest.requireActual('./meri-server-readonly-capture.js'),
  assertMeriServerReadonlyCaptureCurrentAuthority: jest.fn(async () => {}),
  issueMeriServerReadonlyCapturePolicy: jest.fn(),
  isMeriReadonlyCaptureTenant: jest.fn(() => true),
}));
jest.mock('./meri-context-plane-runtime.js', () => ({
  ...jest.requireActual('./meri-context-plane-runtime.js'),
  currentMeriServerReadonlyCapturePolicy: jest.fn(),
}));
jest.mock('./meri-capture-policy-readback.js', () => ({
  ...jest.requireActual('./meri-capture-policy-readback.js'),
  validateMeriCapturePolicyPair: jest.fn(),
}));
jest.mock('./meri-capture-provider-budget-owner.js', () => ({
  inspectCaptureProviderBudgetReadiness: jest.fn(),
}));

const id = (n: number) =>
  `${n}`.repeat(8) +
  '-' +
  `${n}`.repeat(4) +
  '-4' +
  `${n}`.repeat(3) +
  '-8' +
  `${n}`.repeat(3) +
  '-' +
  `${n}`.repeat(12);
const hash = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as any)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const ctx: TenantContext = {
  tenantId: id(1),
  tenantSlug: 'meri-foundation-20260928-t1',
  userId: id(2),
  role: 'standard_user',
  clerkUserId: 'synthetic-clerk',
};
function harness() {
  const source = {
    frozenFixtureId: 'MA1-v2',
    physicalId: id(4),
    tenantPhysicalId: ctx.tenantId,
    clientPhysicalId: id(3),
    kind: 'memory',
    version: 'memory-version:canonical-proposal',
  };
  const sourceMap = { 'MA1-v2': source };
  const currentVerify = {
    current: {
      correction: {
        itemId: source.physicalId,
        sourceVersion: source.version,
        sourceContentHash: 'd'.repeat(64),
      },
    },
  };
  const fixture = {
    fixtureReady: true,
    missing: [],
    caseId: '01',
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: id(3),
    fixtureNamespace: 'meri-foundation-20260928',
    fixtureVersion: 'meri-live-v1-2026-09-26.1',
    seedReceiptId: `meri-synthetic-fixture-seed-receipt:sha256:${'a'.repeat(64)}`,
    resetReceiptId: `meri-synthetic-fixture-reset-receipt:sha256:${'b'.repeat(64)}`,
    sourceMap,
    physicalMapSha256: hash(sourceMap),
    currentVerify,
    currentVerifySha256: hash(currentVerify),
  };
  const now = Date.now();
  const policy = {
    ...fixture,
    tenantSlug: ctx.tenantSlug,
    captureRunId: id(5),
    conversationId: id(6),
    turnId: id(7),
    policyId: id(8),
    requestId: 'request',
    traceId: 'trace',
    issuedAt: now,
    expiresAt: now + 1800000,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: 'c'.repeat(64),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
  };
  const binding = { ...fixture, captureRunId: policy.captureRunId };
  const tx = {
    $queryRaw: jest.fn(async () => [
      { settings: { meriFoundationFixture: { captureEvidence: binding } } },
    ]),
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant, _user, fn) => fn(tx)),
  } as unknown as PrismaService;
  const owner = { qualifyInTx: jest.fn(async () => fixture) };
  const dispose = registerMeriCase01FixtureAuthority(prisma, owner);
  jest.mocked(capture.issueMeriServerReadonlyCapturePolicy).mockResolvedValue(policy as never);
  jest.mocked(validateMeriCapturePolicyPair).mockReturnValue(policy as never);
  const budget = {
    ready: true,
    qualificationSha256: 'e'.repeat(64),
    currentVerifySha256: fixture.currentVerifySha256,
    maxCostMicros: 3000000,
    coverage: 'case01_memory_turn',
  };
  jest.mocked(inspectCaptureProviderBudgetReadiness).mockResolvedValue(budget as never);
  return {
    prisma,
    owner,
    dispose,
    policy,
    fixture,
    binding,
    tx,
    budget,
    args: { prisma, ctx, conversationId: policy.conversationId },
  };
}

describe('authenticated canonical case01 capture authority', () => {
  const oldSha = process.env.GIT_SHA;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(capture.isMeriReadonlyCaptureTenant).mockReturnValue(true);
    jest
      .mocked(capture.assertMeriServerReadonlyCaptureCurrentAuthority)
      .mockResolvedValue(null);
    process.env.GIT_SHA = 'f'.repeat(40);
  });
  afterAll(() => {
    if (oldSha === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = oldSha;
  });
  it('uses current source owner in the same tenant transaction and does not reserve budget', async () => {
    const h = harness();
    const value = await readMeriCase01CaptureAdmission(h.args);
    expect(value).toMatchObject({
      status: 'READY',
      kind: 'meri-case01-authenticated-admission',
      caseId: '01',
      apiReleaseSha: 'f'.repeat(40),
      providerBudget: h.budget,
    });
    expect(h.owner.qualifyInTx).toHaveBeenCalledWith(h.tx, ctx, { caseId: '01', clientId: id(3) });
    expect(h.prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
    );
    expect(capture.assertMeriServerReadonlyCaptureCurrentAuthority).toHaveBeenCalledTimes(2);
    expect(value?.expiresAt).toBe(h.policy.issuedAt + 60000);
    h.dispose();
  });
  it('keeps ordinary conversations unchanged and missing canonical owners unready', async () => {
    const h = harness();
    h.dispose();
    expect(await readMeriCase01CaptureAdmission(h.args)).toMatchObject({
      status: 'NOT_READY',
      reason: 'CANONICAL_FIXTURE_OWNER_MISSING',
    });
    expect(inspectCaptureProviderBudgetReadiness).not.toHaveBeenCalled();
    jest.mocked(capture.isMeriReadonlyCaptureTenant).mockReturnValue(false);
    expect(await readMeriCase01CaptureAdmission(h.args)).toBeUndefined();
  });
  it.each([
    'actor',
    'client',
    'map',
    'version',
    'revocation',
    'currentHash',
    'reset',
    'payloadHash',
  ] as const)('rejects current %s drift', async (kind) => {
    const h = harness();
    if (kind === 'actor') h.binding.actorUserId = id(9);
    if (kind === 'client') h.fixture.sourceMap['MA1-v2'].clientPhysicalId = id(9);
    if (kind === 'map') h.fixture.physicalMapSha256 = '9'.repeat(64);
    if (kind === 'version') h.fixture.currentVerify.current.correction.sourceVersion = 'stale';
    if (kind === 'revocation') h.fixture.fixtureReady = false;
    if (kind === 'currentHash') h.binding.currentVerifySha256 = '9'.repeat(64);
    if (kind === 'reset') h.binding.resetReceiptId = 'stale';
    if (kind === 'payloadHash')
      h.fixture.currentVerify.current.correction.sourceContentHash = 'not-a-hash';
    await expect(readMeriCase01CaptureAdmission(h.args)).rejects.toThrow(
      'meri_case01_capture_authority_denied',
    );
    h.dispose();
  });
  it('rechecks authorization after canonical read and rejects a concurrent revocation', async () => {
    const h = harness();
    jest
      .mocked(capture.assertMeriServerReadonlyCaptureCurrentAuthority)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('revoked'));
    await expect(readMeriCase01CaptureAdmission(h.args)).rejects.toThrow('revoked');
    expect(inspectCaptureProviderBudgetReadiness).not.toHaveBeenCalled();
    h.dispose();
  });
  it('retains provider qualification failures and missing served source as blockers', async () => {
    const h = harness();
    jest
      .mocked(inspectCaptureProviderBudgetReadiness)
      .mockRejectedValueOnce(new Error('provider_budget_not_run'));
    await expect(readMeriCase01CaptureAdmission(h.args)).rejects.toThrow('provider_budget_not_run');
    delete process.env.GIT_SHA;
    await expect(readMeriCase01CaptureAdmission(h.args)).rejects.toThrow(
      'meri_case01_capture_authority_denied',
    );
    h.dispose();
  });
  it('binds server-verified receipt and exact saved answer bytes without returning any secret', async () => {
    const h = harness();
    const envelope = { signature: 'signed-server-envelope' };
    const message = {
      id: id(9),
      role: 'assistant',
      body: 'synthetic answer',
      metadata: { serverReadonlyCapturePolicy: h.policy, serverCaptureEvidenceReceipt: envelope },
    };
    const value = await readMeriCase01CaptureReadback({ ...h.args, message });
    expect(validateMeriCapturePolicyPair).toHaveBeenCalledWith(h.policy, envelope);
    expect(value).toMatchObject({
      kind: 'meri-case01-authenticated-readback',
      messageId: message.id,
      turnId: h.policy.turnId,
      envelopeSha256: hash(envelope),
      answerSha256: createHash('sha256').update(message.body).digest('hex'),
    });
    expect(JSON.stringify(value)).not.toContain('signed-server-envelope');
    h.dispose();
  });
  it('rejects invalid signature before canonical source reads', async () => {
    const h = harness();
    jest.mocked(validateMeriCapturePolicyPair).mockImplementationOnce(() => {
      throw new Error('invalid-signature');
    });
    await expect(
      readMeriCase01CaptureReadback({
        ...h.args,
        message: {
          id: id(9),
          role: 'assistant',
          body: '',
          metadata: { serverCaptureEvidenceReceipt: {} },
        },
      }),
    ).rejects.toThrow('invalid-signature');
    expect(h.owner.qualifyInTx).not.toHaveBeenCalled();
    h.dispose();
  });
  it('refuses the unqualified legacy path before any conversation or provider work', async () => {
    jest.mocked(runtime.currentMeriServerReadonlyCapturePolicy).mockReturnValue({
      expectedCaptureWrites: [
        'context_packet_and_evidence',
        'conversation_user_message',
        'conversation_assistant_message',
        'provider_budget_ledger',
      ],
    } as never);
    const service = Object.create(MeriService.prototype);
    service.ensureConversation = jest.fn(() => {
      throw new Error('must not be reached');
    });
    await expect(service.streamMessage(ctx, id(6), 'test', {})).rejects.toThrow(
      'meri_case01_provider_budget_legacy_path_not_qualified',
    );
    expect(service.ensureConversation).not.toHaveBeenCalled();
    jest.mocked(runtime.currentMeriServerReadonlyCapturePolicy).mockReturnValue(null);
  });
});
