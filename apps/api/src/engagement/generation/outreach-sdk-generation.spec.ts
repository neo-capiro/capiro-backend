import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { GenerationGatewayService } from './generation-gateway.service.js';
import { MessagePlanService } from './message-plan.service.js';
import { GenerationVerifierService } from './generation-verifier.service.js';
import type { GenerationRequest } from './generation-gateway.types.js';
import type { EvidencePacketV2 } from './evidence-packet.types.js';
import { OutreachDraftService } from '../outreach-draft.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  role: 'standard_user',
} as TenantContext;
const id = '00000000-0000-4000-8000-000000000003';
const request: GenerationRequest = {
  surface: 'outreach_email',
  clientId: null,
  outreachRecordId: id,
  templateId: '',
  templatePrompt: 'Request a meeting.',
  mainIdea: 'Arrange a meeting',
  tone: 'professional',
  audienceKind: 'individual',
  items: [],
  expectedCampaignRevision: 3,
  expectedArtifactVersion: 1,
  recipient: {
    generationKey: 'individual:one',
    scopeKeys: ['individual:one'],
    recipientKey: 'one',
    name: 'Recipient One',
    email: 'one@example.test',
    title: null,
    office: null,
    state: null,
    district: null,
    chamber: null,
    snapshot: {},
  },
};
const plan = {
  intent: 'meeting_request',
  clientRepresented: null,
  desiredOutcome: 'Arrange a meeting',
  whyRecipient: [],
  whyNow: [],
  clientAsk: [],
  supportedClaims: [],
  unsupportedOrRiskyClaims: [],
  tone: 'professional',
  callToAction: 'Could we meet?',
  missingCriticalContext: [],
};
const output = {
  plan,
  draft: { subject: 'A meeting', body: 'Could we meet next week?', contextNote: '' },
};

function fixture(persist = false) {
  const packet: EvidencePacketV2 = {
    packetId: id,
    packetVersion: 2,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    surface: 'outreach_email',
    ref: { outreachRecordId: id, generationKey: 'individual:one' },
    directives: [
      {
        id: 'one',
        kind: 'custom_note',
        scope: 'individual:one',
        text: 'ONLY_ONE_NOTE',
        authenticatedUserId: ctx.userId,
      },
      {
        id: 'two',
        kind: 'custom_note',
        scope: 'individual:two',
        text: 'PRIVATE_TWO_NOTE',
        authenticatedUserId: ctx.userId,
      },
    ],
    evidence: [],
    standingMemory: [],
    standingMemoryExclusions: [],
    failures: [],
    modelPolicy: {
      provider: 'claude-agent-sdk',
      model: 'unreported',
      promptSpecVersion: 'v2.3-gateway',
    },
    criticalFailureCount: 0,
    freshestSourceAt: null,
    stalestSourceAt: null,
    compiledAt: '2026-10-27T00:00:00Z',
    packetHash: 'hash',
    emailScope: 'mine',
  };
  const complete = jest.fn(async () => {
    throw new Error('Old model harness must never run');
  });
  const resolveOutreachCredentials = jest.fn(async () => {
    throw new Error('Old credential resolver must never run');
  });
  const config = {
    get: (key: string) => (key === 'ENGAGEMENT_EMAIL_CONTEXT_SCOPE' ? 'mine' : false),
  } as never;
  const stored = {
    id: packet.packetId,
    ...packet,
    items: [],
    exclusions: [],
    sourceFailures: [],
    createdAt: new Date(packet.compiledAt),
    policy: { emailScope: 'mine' },
    freshestSourceAt: null,
    stalestSourceAt: null,
  };
  const createdVersions: any[] = [];
  const transaction = {
    contextPacket: { findFirst: async () => stored },
    outreachRecord: {
      findFirst: async () => ({ id, createdByUserId: ctx.userId, clientId: null }),
    },
    outreachDraftArtifact: {
      findFirst: async () => ({ id: 'artifact', recipientSnapshot: {} }),
      update: jest.fn<any>(),
    },
    outreachDraftVersion: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: 'version', ...data };
        createdVersions.push(row);
        return row;
      }),
    },
    $queryRaw: jest.fn(async (query: TemplateStringsArray) =>
      query.join('').includes('outreach_records')
        ? [{ metadata_jsonb: { workflow: { revision: 3 } }, client_id: null }]
        : [{ current_version: 1 }],
    ),
  };
  const prisma = {
    withTenant: async (_tenant: string, callback: (tx: unknown) => unknown) =>
      callback(transaction),
  };
  const upsertGeneratedVersion = jest.fn(async () => ({
    id: 'version',
    artifactId: 'artifact',
    version: 2,
    generationStatus: 'generated',
    auditStatus: 'passed',
    approvalStatus: 'not_required',
    sendable: true,
  }));
  const contextPlane = {
    resolve: jest.fn(async () => ({ packet: { items: [], exclusions: [] } })),
  };
  const compileOutreachPacket = jest.fn(async () => packet);
  const drafts = new OutreachDraftService(prisma as never, {} as never);
  jest
    .spyOn(drafts as any, 'auditAndReload')
    .mockImplementation(async (_ctx, row: any) => ({
      ...row,
      generationStatus: 'generated',
      auditStatus: 'passed',
      approvalStatus: 'not_required',
      sendable: true,
    }));
  const service = new GenerationGatewayService(
    config,
    prisma as never,
    { compileOutreachPacket } as never,
    new MessagePlanService(),
    new GenerationVerifierService(),
    (persist
      ? drafts
      : { upsertGeneratedVersion, ensureArtifact: jest.fn(async () => null) }) as never,
    { scanRequired: false } as never,
    contextPlane as never,
  );
  return {
    service,
    packet,
    complete,
    resolveOutreachCredentials,
    upsertGeneratedVersion,
    compileOutreachPacket,
    contextPlane,
    transaction,
    createdVersions,
  };
}
const enrichment = () => ({
  channels: [],
  clientBrief: null,
  clientName: null,
  topicTerms: [],
  auditLedger: [],
  includeRelevantEmail: false,
});

describe('native Outreach SDK unit', () => {
  test('prepares a recipient-isolated schema/prompt with no legacy credential or model call', async () => {
    const f = fixture();
    const result = await f.service.executeSdk(ctx, request, enrichment(), { phase: 'prepare' });
    expect(result).toHaveProperty('kind', 'sdk_prepared');
    if (!('kind' in result)) throw new Error('Expected SDK preparation');
    expect(result.prompt.startsWith('[Capiro Outreach recipient unit v1]\n')).toBe(true);
    expect(result.prompt).toContain('ONLY_ONE_NOTE');
    expect(result.prompt).not.toContain('PRIVATE_TWO_NOTE');
    expect(result.outputSchema).toMatchObject({
      required: ['plan', 'draft'],
      additionalProperties: false,
    });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.resolveOutreachCredentials).not.toHaveBeenCalled();
    expect(f.upsertGeneratedVersion).not.toHaveBeenCalled();
  });
  test('validates SDK plan and draft then persists the exact immutable output/revision', async () => {
    const f = fixture();
    const result = await f.service.executeSdk(ctx, request, enrichment(), {
      phase: 'complete',
      output,
      packetId: id,
    });
    expect(result.versionId).toBe('version');
    expect(f.upsertGeneratedVersion).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        subject: output.draft.subject,
        body: output.draft.body,
        contextPacketId: id,
        expectedCampaignRevision: 3,
        expectedArtifactVersion: 1,
      }),
    );
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.resolveOutreachCredentials).not.toHaveBeenCalled();
  });
  test('refuses a claim citing another recipient/source before persisting any version', async () => {
    const f = fixture();
    const result = await f.service.executeSdk(ctx, request, enrichment(), {
      phase: 'complete',
      packetId: id,
      output: {
        ...output,
        plan: {
          ...plan,
          supportedClaims: [
            {
              claim: 'They committed support',
              sourceIds: ['private-other-recipient-source'],
              asOf: null,
              claimType: 'relationship_history',
            },
          ],
        },
      },
    });
    expect(result.sendable).toBe(false);
    expect(f.upsertGeneratedVersion).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });
  test('rechecks current source access before using the original evidence packet', async () => {
    const f = fixture();
    f.packet.criticalFailureCount = 1;
    const result = await f.service.executeSdk(ctx, request, enrichment(), {
      phase: 'complete',
      packetId: id,
      output,
    });
    expect(result.sendable).toBe(false);
    expect(f.contextPlane.resolve).toHaveBeenCalledTimes(1);
    expect(f.upsertGeneratedVersion).not.toHaveBeenCalled();
  });
  test('completion appends through the actual immutable draft owner', async () => {
    const f = fixture(true);
    const result = await f.service.executeSdk(ctx, request, enrichment(), {
      phase: 'complete',
      packetId: id,
      output,
    });
    expect(result.versionId).toBe('version');
    expect(f.createdVersions).toEqual([
      expect.objectContaining({
        version: 2,
        subject: output.draft.subject,
        body: output.draft.body,
        auditStatus: 'pending',
        contextPacketId: id,
        createdByUserId: ctx.userId,
      }),
    ]);
  });
  test('changed campaign revision cannot append an immutable version', async () => {
    const f = fixture(true);
    f.transaction.$queryRaw.mockResolvedValue([
      { metadata_jsonb: { workflow: { revision: 4 } }, client_id: null },
    ] as never);
    await expect(
      f.service.executeSdk(ctx, request, enrichment(), { phase: 'complete', packetId: id, output }),
    ).rejects.toThrow('changed');
    expect(f.createdVersions).toEqual([]);
  });
});
