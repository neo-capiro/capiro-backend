import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../engagement/engagement.service';
import { MeriToolsService } from './meri-tools.service';
import { MeriService } from './meri.service';
import { MeriResearchService } from './meri-research.service';
import { RESEARCH_REPORT_BODY_WITHHELD } from './meri-research-replay-authorization';
import { researchToolVersion, sealDurableResearchResult } from './meri-research-durable-result';
import {
  buildResearchReportProvenance,
  certifyResearchProducerInputs,
} from './meri-report-provenance';

const clientId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const ctx = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  userId: actorId,
  role: 'standard_user',
  tenantSlug: 'tenant',
} as TenantContext;
const bodyMarker = 'PRIVATE_DEBRIEF_WALL_MARKER';
const date = (value: string) => new Date(value);

function row(id = 'debrief-1', overrides: Record<string, unknown> = {}) {
  return {
    id,
    tenantId: ctx.tenantId,
    meetingId: 'meeting-1',
    clientId: 'stale-child-client',
    authorUserId: actorId,
    bodyCiphertext: 'cipher',
    iv: 'iv',
    authTag: 'tag',
    keyVersion: 'v1',
    confidential: true,
    accessLevel: 'tenant_admins_and_author',
    status: 'approved',
    sharedAt: null,
    createdAt: date('2026-09-20T10:00:00.000Z'),
    updatedAt: date('2026-09-21T10:00:00.000Z'),
    author: {
      id: actorId,
      email: 'reader@example.test',
      firstName: 'Reader',
      lastName: 'One',
    },
    meeting: {
      id: 'meeting-1',
      clientId,
      subject: 'Private internal meeting',
      startsAt: date('2026-09-19T14:00:00.000Z'),
      status: 'scheduled',
      visibility: 'private',
      createdByUserId: 'other-user',
    },
    ...overrides,
  };
}

function ownerHarness(options: { rows?: ReturnType<typeof row>[]; body?: string } = {}) {
  let rows = options.rows ?? [row()];
  let wallAllowed = true;
  const decrypt = jest.fn(() => options.body ?? bodyMarker);
  const qualifies = (candidate: ReturnType<typeof row>, where: any) =>
    candidate.tenantId === ctx.tenantId &&
    candidate.status === 'approved' &&
    candidate.meeting.clientId === clientId &&
    !['pending', 'deleted', 'archived'].includes(candidate.meeting.status) &&
    (!where.id || candidate.id === where.id) &&
    (!where.meeting.startsAt ||
      ((!where.meeting.startsAt.gte || candidate.meeting.startsAt >= where.meeting.startsAt.gte) &&
        (!where.meeting.startsAt.lte || candidate.meeting.startsAt <= where.meeting.startsAt.lte)));
  const tx: any = {
    client: { findFirst: jest.fn(async () => ({ id: clientId })) },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: wallAllowed }]),
    meetingDebrief: {
      findMany: jest.fn(async ({ where, take }: any) =>
        rows
          .filter((candidate) => qualifies(candidate, where))
          .filter(
            (candidate) =>
              !where.AND ||
              candidate.createdAt < where.AND[0].OR[0].createdAt.lt ||
              (candidate.createdAt.getTime() === where.AND[0].OR[1].createdAt.getTime() &&
                candidate.id < where.AND[0].OR[1].id.lt),
          )
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
          .slice(0, take),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        rows.find((candidate) => qualifies(candidate, where)) ?? null,
      ),
    },
  };
  const prisma: any = {
    withTenant: jest.fn(async (_tenant: string, callback: (value: typeof tx) => unknown) => callback(tx)),
    withTenantUser: jest.fn(
      async (_tenant: string, _user: string, callback: (value: typeof tx) => unknown) => callback(tx),
    ),
  };
  const engagement = Object.assign(Object.create(EngagementService.prototype), {
    prisma,
    notesCrypto: { decrypt },
  }) as EngagementService;
  const tools = Object.assign(Object.create(MeriToolsService.prototype), {
    prisma,
    engagement,
  }) as MeriToolsService;
  const read = (input: Record<string, unknown> = {}) =>
    (tools as unknown as {
      queryDebriefs(context: TenantContext, value: Record<string, unknown>): Promise<any>;
    }).queryDebriefs(ctx, { clientId, ...input });
  return {
    tx,
    prisma,
    engagement,
    tools,
    decrypt,
    read,
    setWallAllowed: (value: boolean) => {
      wallAllowed = value;
    },
    setRows: (value: ReturnType<typeof row>[]) => {
      rows = value;
    },
  };
}

const debriefSchema = {
  type: 'object',
  properties: {
    clientId: { type: 'string' },
    debriefId: { type: 'string' },
    characterLimit: { type: 'integer' },
  },
  required: ['clientId'],
};
const debriefInput = { clientId, debriefId: 'debrief-1', characterLimit: 100 };

function reportHarness(saved: any, execute: jest.Mock) {
  const sealed = sealDurableResearchResult({
    executionId: 'execution-1',
    providerCallId: 'provider-1',
    runId: 'run-1',
    leaseEpoch: 1,
    tool: 'query_debriefs',
    toolVersion: researchToolVersion(debriefSchema),
    classifier: 'complete',
    input: debriefInput,
    result: saved,
    completedAt: '2026-09-28T00:00:00.000Z',
  });
  const receipt: any = {
    version: 2,
    receiptId: 'receipt-1',
    runId: 'run-1',
    leaseEpoch: 1,
    sequence: 1,
    effectClass: 'safe_read',
    toolCallId: 'provider-1',
    tool: 'query_debriefs',
    label: 'Debrief',
    status: 'complete',
    summary: 'Completed',
    completedAt: '2026-09-28T00:00:00.000Z',
    executionId: 'execution-1',
    providerCallId: 'provider-1',
    toolVersion: sealed.envelope.toolVersion,
    inputSha256: sealed.envelope.inputSha256,
    resultSha256: sealed.envelope.resultSha256,
    resultBodySha256: sealed.bodySha256,
    resultRef: 'safe-result-1',
    resultByteSize: sealed.byteSize,
    classifier: 'complete',
  };
  const session: any = {
    id: 'session-1',
    tenantId: ctx.tenantId,
    userId: actorId,
    clientId: null,
    reportArtifactId: 'report-1',
    metadata: {
      handoff: {
        version: 1,
        capturedAt: '2026-09-28T00:00:00.000Z',
        conversationId: 'conversation-1',
        clientId: null,
        reasoningMode: 'deep',
        requestedDeliverable: 'Report',
        summary: null,
        summaryUpToMessageId: null,
        messages: [],
        attachments: [],
      },
      run: {
        id: 'run-1',
        leaseEpoch: 1,
        eventSequence: 1,
        phase: 'research',
        status: 'complete',
        stage: 'Saved',
        startedAt: '2026-09-28T00:00:00.000Z',
        heartbeatAt: '2026-09-28T00:01:00.000Z',
        finishedAt: '2026-09-28T00:01:00.000Z',
      },
      durableStepReceipts: [receipt],
    },
  };
  const report: any = {
    id: 'report-1',
    tenantId: ctx.tenantId,
    userId: actorId,
    clientId: null,
    conversationId: 'conversation-1',
    messageId: 'report-message-1',
    kind: 'research_report',
    title: 'Report',
    bodyText: 'REPORT_MARKER_PRIVATE',
    metadata: { researchSessionId: 'session-1', toolsUsed: ['query_debriefs'] },
    createdAt: date('2026-09-28T00:01:00.000Z'),
  };
  const producer = certifyResearchProducerInputs({
    hashMaterial: { body: report.bodyText },
    toolsUsed: ['query_debriefs'],
    clientContext: null,
    handoffSummaryPresent: false,
    handoffAttachmentCount: 0,
    assistantHandoffTurns: 0,
    inheritedCitationCount: 0,
    inheritedUnavailableCount: 0,
    inheritedOmittedCount: 0,
    contextPacketItemCount: 0,
    unreceiptedLedgerEntryCount: 0,
  });
  const proof = buildResearchReportProvenance({
    artifactId: report.id,
    messageId: report.messageId,
    sessionId: session.id,
    tenantId: ctx.tenantId,
    userId: actorId,
    clientId: null,
    conversationId: 'conversation-1',
    runId: 'run-1',
    leaseEpoch: 1,
    body: report.bodyText,
    receipts: [receipt],
    toolsUsed: ['query_debriefs'],
    producerInputSha256: producer.producerInputSha256,
    producerInputMode: producer.producerInputMode as 'covered_inputs',
    clientContextSha256: producer.clientContextSha256,
  });
  session.metadata.reportProvenance = proof;
  report.metadata.reportProvenance = proof;
  const message: any = {
    id: 'report-message-1',
    tenantId: ctx.tenantId,
    userId: actorId,
    clientId: null,
    conversationId: 'conversation-1',
    role: 'assistant',
    body: report.bodyText,
    metadata: { researchSessionId: 'session-1', researchReport: true },
    artifacts: [report],
    createdAt: report.createdAt,
  };
  const conversation: any = {
    id: 'conversation-1',
    tenantId: ctx.tenantId,
    userId: actorId,
    clientId: null,
    archivedAt: null,
    summary: report.bodyText,
    messages: [message],
    artifacts: [report],
  };
  const tx: any = {
    clioResearchSession: { findFirst: jest.fn(async () => session) },
    clioConversation: {
      findFirst: jest.fn(async () => conversation),
      findMany: jest.fn(async () => [conversation]),
    },
    clioMessage: { findMany: jest.fn(async () => [message]) },
    clioArtifact: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === report.id
          ? report
          : where.id === 'safe-result-1'
            ? { bodyText: sealed.body }
            : null,
      ),
      findMany: jest.fn(async () => [report]),
    },
  };
  const prisma: any = {
    withTenant: jest.fn(async (_tenant: string, callback: (value: typeof tx) => unknown) => callback(tx)),
    withTenantUser: jest.fn(
      async (_tenant: string, _user: string, callback: (value: typeof tx) => unknown) => callback(tx),
    ),
  };
  const meri = Object.assign(Object.create(MeriService.prototype), {
    prisma,
    tools: { execute },
  }) as MeriService;
  const research = Object.assign(Object.create(MeriResearchService.prototype), {
    prisma,
    tools: {
      execute,
      anthropicToolSchemas: () => [{ name: 'query_debriefs', input_schema: debriefSchema }],
      isConcurrencySafe: () => true,
    },
  }) as MeriResearchService;
  const resume = () => {
    session.reportArtifactId = null;
    session.metadata = {
      ...session.metadata,
      run: {
        ...session.metadata.run,
        id: 'run-2',
        leaseEpoch: 2,
        status: 'running',
        heartbeatAt: new Date().toISOString(),
      },
    };
  };
  const replay = () =>
    research.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
      leaseEpoch: 2,
      tool: 'query_debriefs',
      toolVersion: sealed.envelope.toolVersion,
      input: debriefInput,
    });
  return { meri, research, resume, replay };
}

describe('canonical debrief ethical-wall authority', () => {
  it('denies the actual owner and tool before private query/decryption', async () => {
    const h = ownerHarness();
    h.setWallAllowed(false);

    await expect(h.read({ debriefId: 'debrief-1' })).rejects.toThrow('Client not found');
    expect(h.tx.meetingDebrief.findMany).not.toHaveBeenCalled();
    expect(h.decrypt).not.toHaveBeenCalled();
    await expect(
      h.engagement.readClientDebriefsExact(ctx, {
        clientId,
        debriefId: 'debrief-1',
        from: null,
        to: null,
        limit: 1,
        listAfter: null,
      }),
    ).rejects.toThrow('Client not found');
    expect(h.tx.meetingDebrief.findMany).not.toHaveBeenCalled();
  });

  it('preserves authorized 61-row pagination and exact body continuation', async () => {
    const rows = Array.from({ length: 61 }, (_, index) =>
      row(`d-${String(index).padStart(3, '0')}`, {
        createdAt: new Date(date('2026-09-20T10:00:00.000Z').getTime() - index * 1000),
      }),
    );
    const paged = ownerHarness({ rows });
    const ids = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = await paged.read({ limit: 25, ...(cursor ? { cursor } : {}) });
      result.debriefs.forEach((item: any) => ids.add(item.id));
      cursor = result.coverage.nextCursor;
      pages += 1;
    } while (cursor);
    expect({ rows: ids.size, pages }).toEqual({ rows: 61, pages: 3 });

    const longBody = 'abcdef'.repeat(300);
    const body = ownerHarness({ body: longBody });
    const first = await body.read({ debriefId: 'debrief-1', characterLimit: 100 });
    const second = await body.read({
      debriefId: 'debrief-1',
      characterLimit: 100,
      cursor: first.coverage.nextCursor,
    });
    expect(first.debriefs[0].body).toBe(longBody.slice(0, 100));
    expect(second.debriefs[0].body).toBe(longBody.slice(100, 200));
    expect(first.scope.statusEligibility).toBe('approved_only');
    expect(first.coverage.appliesTo).toBe('approved_only_eligible_debriefs');
  });

  it('denies unfocused report read, export, and replay after source-client wall revocation', async () => {
    const owner = ownerHarness();
    const saved = await owner.read({ debriefId: 'debrief-1', characterLimit: 100 });
    const execute = jest.fn((_ctx: TenantContext, _tool: string, input: Record<string, unknown>) =>
      owner.read(input),
    );

    const allowed = reportHarness(saved, execute);
    expect((await allowed.meri.listMessages(ctx, 'conversation-1'))[0]!.body).toBe(
      'REPORT_MARKER_PRIVATE',
    );
    await expect(allowed.research.getReportMarkdown(ctx, 'session-1')).resolves.toEqual({
      title: 'Report',
      markdown: 'REPORT_MARKER_PRIVATE',
    });
    allowed.resume();
    await expect(allowed.replay()).resolves.toMatchObject({
      replayed: true,
      result: { debriefs: [{ body: bodyMarker }] },
    });

    const denied = reportHarness(saved, execute);
    const decryptsBeforeDenial = owner.decrypt.mock.calls.length;
    owner.setWallAllowed(false);
    const messages = await denied.meri.listMessages(ctx, 'conversation-1');
    expect(messages[0]!.body).toBe(RESEARCH_REPORT_BODY_WITHHELD);
    expect(JSON.stringify(messages)).not.toContain('REPORT_MARKER_PRIVATE');
    await expect(denied.research.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'no longer authorized',
    );
    denied.resume();
    await expect(denied.replay()).resolves.toEqual({ replayed: false });
    expect(owner.decrypt).toHaveBeenCalledTimes(decryptsBeforeDenial);
  });
});
