import {
  completeMeriCaptureEvidenceReceipt,
  observed,
  signMeriCaptureEvidenceReceipt,
  verifyMeriCaptureEvidenceReceipt,
  type MeriServerReadonlyCapturePolicy,
} from '@capiro/meriv2-core';
import { buildApiOnlyMeriServerCaptureEvidence } from './meri-server-capture-evidence.js';
import { finalizeMeriServerCaptureEvidence } from './meri-server-readonly-capture.js';
import { readMeriCaptureClockPackets } from './meri-capture-clock-packets.js';

const SECRET = 'clock-final-join-synthetic-test-secret';
const NOW = Date.parse('2026-10-03T17:00:00Z');
const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function fixture(version = 2, caseId: '01' | '14' | '20' | '72' = '01') {
  const policy = {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: id(1),
    requestId: id(2),
    traceId: id(3),
    tenantId: id(4),
    actorUserId: id(5),
    clientId: id(6),
    conversationId: id(7),
    turnId: id(8),
    caseId,
    captureRunId: id(9),
    fixtureVersion: 'meri-live-v1-2026-09-26.1',
    fixtureNamespace: 'meri-foundation-20260928',
    physicalMapSha256: 'a'.repeat(64),
    resetReceiptId: 'reset',
    seedReceiptId: 'seed',
    issuedAt: NOW - 1000,
    expiresAt: NOW + 60000,
    semanticClock: {
      version: 1,
      kind: 'qualified_original_fixture_semantic_clock',
      instant: '2026-09-26T16:00:00.000Z',
      timeZone: 'America/New_York',
      caseId,
      captureRunId: id(9),
      currentVerifySha256: 'b'.repeat(64),
      observedAt: NOW - 1000,
    },
  } as MeriServerReadonlyCapturePolicy;
  const clockUse = {
    instant: policy.semanticClock!.instant,
    timeZone: policy.semanticClock!.timeZone,
    eligibilityAt: new Date(NOW - 500).toISOString(),
    scoring: version === 1 ? ('not_run' as const) : ('used' as const),
  };
  const packet = (n: number) => ({
    packetId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`,
    persisted: true as const,
    clockUse: { ...clockUse },
  });
  const memory = ['01', '14'].includes(caseId);
  const tool = memory
    ? 'search_memory'
    : caseId === '20'
      ? 'get_pe_budget_timeline'
      : 'read_client_documents';
  const packets = memory ? [packet(1), packet(2), packet(3)] : [packet(1)];
  const initialPacket = {
    ...packets[0]!,
    clientId: caseId === '20' ? null : policy.clientId,
    items: [],
    exclusions: [],
    unauthorizedCount: 0,
    degraded: false,
  };
  const baseline = buildApiOnlyMeriServerCaptureEvidence({
    policy,
    userMessageId: policy.turnId!,
    assistantMessageId: 'assistant',
    citations: [],
    usage: null,
    completedAt: NOW,
    secret: SECRET,
  }).receipt;
  const receipt = completeMeriCaptureEvidenceReceipt({
    ...baseline,
    semanticClock: {
      binding: policy.semanticClock!,
      prompt: observed({
        instant: clockUse.instant,
        timeZone: clockUse.timeZone,
        date: '2026-09-26',
        renderedAt: NOW - 250,
        groundingSha256: 'c'.repeat(64),
      }),
      apiJoin: 'PENDING',
      invocations: [
        {
          callId: 'actual-call',
          tool,
          outcome: caseId === '72' ? 'threw' : 'returned',
          httpAttempts: 1,
          httpStatus: 200,
          responseSha256: 'd'.repeat(64),
          packets: packets.slice(1),
        },
      ],
    },
    toolCalls: [
      {
        callId: 'actual-call',
        name: tool,
        readOnly: true,
        attempt: 1,
        status: caseId === '72' ? 'failed' : 'partial',
        sourceIds: [],
      },
    ],
    ...(!memory
      ? {
          controlledReadAttempts: [
            {
              callId: 'actual-call',
              tool,
              httpStatus: 200,
              logicalError: caseId === '72' ? 'document unavailable' : null,
              caseId,
              requestId: policy.requestId,
              traceId: policy.traceId,
              turnId: policy.turnId!,
              captureRunId: policy.captureRunId!,
              responseSha256: 'd'.repeat(64),
              sourceId: 'source',
              logicalSourceId: 'fixture',
              sourceVersion: 'v1',
              currentVerifySha256: 'b'.repeat(64),
              contentSha256: 'e'.repeat(64),
              sourceTenantId: policy.tenantId,
              sourceClientId: caseId === '20' ? null : policy.clientId,
              fullRead: caseId === '20',
              passageSha256: null,
            },
          ],
        }
      : {}),
  });
  const rows = packets.map((packet, i) => ({
    id: packet.packetId,
    tenantId: policy.tenantId,
    effectiveTenantId: policy.tenantId,
    userId: policy.actorUserId,
    actorUserId: version === 2 ? policy.actorUserId : null,
    clientId: initialPacket.clientId,
    surface: 'chat',
    packetVersion: version,
    traceId: version === 2 ? policy.traceId : null,
    createdAt: new Date(NOW - 400),
    modelPolicy: { contextCompilerClockUse: { ...clockUse } },
    ref: {
      operationId: 'meri.chat',
      subjectScope: initialPacket.clientId ? 'client' : 'general',
      conversationId: policy.conversationId,
      ...(i
        ? {
            tool: 'search_memory',
            capturePolicyId: policy.policyId,
            captureRequestId: policy.requestId,
            captureTurnId: policy.turnId,
          }
        : {}),
    },
  }));
  const findMany = jest.fn(async () =>
    rows.map((row) => ({ ...JSON.parse(JSON.stringify(row)), createdAt: new Date(row.createdAt) })),
  );
  const prisma = {
    withTenantUser: jest.fn(async (_tenant, _actor, fn) => fn({ contextPacket: { findMany } })),
  };
  const args = {
    prisma: prisma as never,
    ctx: { tenantId: policy.tenantId, userId: policy.actorUserId } as never,
    policy,
    initialPacket,
    orchestrator: signMeriCaptureEvidenceReceipt(receipt, SECRET),
    secret: SECRET,
  };
  return { args, rows, receipt, findMany, prisma, packets };
}

describe('final API semantic clock packet join', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());
  it.each([
    [1, '01'],
    [2, '01'],
    [2, '14'],
    [2, '20'],
    [2, '72'],
  ] as const)(
    'joins V%s case%s actual compiler metadata and all applicable HTTP observations before signing',
    async (version, caseId) => {
      const h = fixture(version, caseId);
      const api = await readMeriCaptureClockPackets(h.args);
      expect(api).toEqual({
        initial: h.packets[0],
        tools: h.packets.slice(1),
        relativeToolWindows: 'NOT_APPLICABLE',
      });
      expect(h.prisma.withTenantUser).toHaveBeenCalledWith(
        h.args.policy.tenantId,
        h.args.policy.actorUserId,
        expect.any(Function),
      );
      expect(h.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 101,
          where: expect.objectContaining({
            tenantId: h.args.policy.tenantId,
            OR: expect.arrayContaining([
              { ref: { path: ['capturePolicyId'], equals: h.args.policy.policyId } },
              { ref: { path: ['captureRequestId'], equals: h.args.policy.requestId } },
              { ref: { path: ['captureTurnId'], equals: h.args.policy.turnId } },
            ]),
          }),
        }),
      );
      const final = finalizeMeriServerCaptureEvidence({
        policy: h.args.policy,
        orchestrator: h.args.orchestrator,
        userMessageId: h.args.policy.turnId!,
        assistantMessageId: 'assistant',
        clockPackets: api,
        secret: SECRET,
      });
      const readback = verifyMeriCaptureEvidenceReceipt(final, h.args.policy, SECRET);
      expect(readback.semanticClock!.apiJoin).toBe('VERIFIED');
      expect(readback.blockers.filter((x) => x.startsWith('semantic_clock'))).toEqual([]);
    },
  );
  it.each([
    ['missing', (h: any) => h.rows.pop()],
    [
      'duplicate',
      (h: any) => {
        h.rows[2] = h.rows[1];
      },
    ],
    [
      'extra including shadow',
      (h: any) => h.rows.push({ ...h.rows[0], id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ],
    ...['tenantId', 'effectiveTenantId', 'userId', 'actorUserId', 'clientId', 'traceId'].map(
      (key) =>
        [
          key,
          (h: any) => {
            h.rows[1][key] = id(0);
          },
        ] as const,
    ),
    ...['capturePolicyId', 'captureRequestId', 'captureTurnId', 'conversationId', 'tool'].map(
      (key) =>
        [
          key,
          (h: any) => {
            h.rows[1].ref[key] = 'other';
          },
        ] as const,
    ),
    [
      'stored actual clock differs',
      (h: any) => {
        h.rows[1].modelPolicy.contextCompilerClockUse.eligibilityAt = new Date(
          NOW - 499,
        ).toISOString();
      },
    ],
    [
      'stored fixed clock differs',
      (h: any) => {
        h.rows[1].modelPolicy.contextCompilerClockUse.instant = new Date(NOW).toISOString();
      },
    ],
    [
      'initial actual clock differs',
      (h: any) => {
        h.rows[0].modelPolicy.contextCompilerClockUse.scoring = 'not_run';
      },
    ],
    [
      'missing stored clock',
      (h: any) => {
        h.rows[1].modelPolicy = {};
      },
    ],
    [
      'initial runtime packet missing',
      (h: any) => {
        h.args.initialPacket = null;
      },
    ],
    [
      'current actor mismatch',
      (h: any) => {
        h.args.ctx = { ...h.args.ctx, userId: id(0) };
      },
    ],
  ])('keeps %s unproved and the final receipt BLOCKED', async (_name, mutate) => {
    const h = fixture();
    (mutate as (h: any) => void)(h);
    const api = await readMeriCaptureClockPackets(h.args);
    expect(api).toBeNull();
    const final = finalizeMeriServerCaptureEvidence({
      policy: h.args.policy,
      orchestrator: h.args.orchestrator,
      userMessageId: h.args.policy.turnId!,
      assistantMessageId: 'assistant',
      clockPackets: api,
      secret: SECRET,
    });
    expect(final.receipt.blockers).toContain('semantic_clock_api_tool_join_pending');
    const readback = JSON.parse(JSON.stringify(final));
    expect(Object.hasOwn(readback.receipt.semanticClock, 'api')).toBe(false);
    expect(verifyMeriCaptureEvidenceReceipt(readback, h.args.policy, SECRET)).toEqual(
      final.receipt,
    );
  });
  it.each(['prompt', 'missing call', 'extra call', 'unresolved', 'failed', 'predeclared join'])(
    'rejects signed %s without storage access',
    async (fault) => {
      const h = fixture();
      if (fault === 'prompt')
        h.receipt.semanticClock!.prompt.value!.instant = new Date(NOW).toISOString();
      if (fault === 'missing call') h.receipt.toolCalls = [];
      if (fault === 'extra call')
        h.receipt.toolCalls.push({ ...h.receipt.toolCalls[0]!, callId: 'extra' });
      if (fault === 'unresolved') h.receipt.semanticClock!.invocations![0]!.outcome = 'pending';
      if (fault === 'failed') h.receipt.semanticClock!.invocations![0]!.outcome = 'threw';
      if (fault === 'predeclared join') h.receipt.semanticClock!.apiJoin = 'VERIFIED';
      h.args.orchestrator = signMeriCaptureEvidenceReceipt(
        completeMeriCaptureEvidenceReceipt(h.receipt),
        SECRET,
      );
      expect(await readMeriCaptureClockPackets(h.args)).toBeNull();
      expect(h.findMany).not.toHaveBeenCalled();
    },
  );
  it('does not fabricate a join after storage failure or an expired read', async () => {
    const h = fixture();
    h.findMany.mockRejectedValueOnce(new Error('synthetic storage failure'));
    expect(await readMeriCaptureClockPackets(h.args)).toBeNull();
    h.findMany.mockImplementationOnce(async () => {
      jest.setSystemTime(h.args.policy.expiresAt);
      return h.rows;
    });
    expect(await readMeriCaptureClockPackets(h.args)).toBeNull();
  });
  it('discards a predeclared orchestrator API join when the API owner supplies no proof', () => {
    const h = fixture();
    const claimed = {
      initial: h.packets[0]!,
      tools: h.packets.slice(1),
      relativeToolWindows: 'NOT_APPLICABLE' as const,
    };
    h.receipt.semanticClock!.api = claimed;
    h.receipt.semanticClock!.apiJoin = 'VERIFIED';
    const orchestrator = signMeriCaptureEvidenceReceipt(
      completeMeriCaptureEvidenceReceipt(h.receipt),
      SECRET,
    );
    const final = finalizeMeriServerCaptureEvidence({
      policy: h.args.policy,
      orchestrator,
      userMessageId: h.args.policy.turnId!,
      assistantMessageId: 'assistant',
      clockPackets: null,
      secret: SECRET,
    });
    expect(final.receipt.semanticClock!.apiJoin).toBe('PENDING');
    expect(Object.hasOwn(final.receipt.semanticClock!, 'api')).toBe(false);
    expect(final.receipt.blockers).toContain('semantic_clock_api_tool_join_pending');
    expect(orchestrator.receipt.semanticClock!.api).toEqual(claimed);
    expect(
      verifyMeriCaptureEvidenceReceipt(JSON.parse(JSON.stringify(final)), h.args.policy, SECRET),
    ).toEqual(final.receipt);
  });
});
