import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriContextPlaneService } from './meri-context-plane.service.js';
import { ContextResolverService } from '../context/context-resolver.service.js';
import type { ContextResolutionRequest } from '../context/context-resolver.types.js';
import { wrapToolResultForPrompt } from '@capiro/meriv2-core';
import { generatedOoxmlBytes } from './meri-artifact-test-fixtures.js';

// This suite supplies the engagement port below. Loading its entire mail and
// generation dependency graph is unrelated to testing Meri's tool dispatch.
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: jest.fn() }));
jest.mock('../intelligence/intelligence.service.js', () => ({ IntelligenceService: jest.fn() }));
jest.mock('../intelligence/actions/action-recommendation-read.service.js', () => ({
  ActionRecommendationReadService: jest.fn(),
}));
jest.mock('../clients/client-capabilities.service.js', () => ({
  ClientCapabilitiesService: jest.fn(),
}));
jest.mock('../clients/client-people.service.js', () => ({ ClientPeopleService: jest.fn() }));
jest.mock('../clients/client-facilities.service.js', () => ({
  ClientFacilitiesService: jest.fn(),
}));
jest.mock('../clients/client-advocacy-matter.service.js', () => ({
  ClientAdvocacyMatterService: jest.fn(),
}));
jest.mock('../clients/clients.service.js', () => ({ ClientsService: jest.fn() }));
jest.mock('../clients/representation-resolver.service.js', () => ({
  RepresentationResolverService: jest.fn(),
}));
jest.mock('../regulatory-docket/regulatory-docket.service.js', () => ({
  RegulatoryDocketService: jest.fn(),
}));
jest.mock('../engagement/mail-sender.service.js', () => ({ EngagementMailSender: jest.fn() }));
jest.mock('../lda-intel/lda-intel.service.js', () => ({ LdaIntelService: jest.fn() }));
jest.mock('./analytics/analytics-db.service.js', () => ({ AnalyticsDbService: jest.fn() }));
jest.mock('../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: jest.fn() }));
jest.mock('../federal-spending/federal-spending.service.js', () => ({
  FederalSpendingService: jest.fn(),
}));
jest.mock('../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: jest.fn(),
}));
jest.mock('../acquisition-personnel/acquisition-personnel-read.service.js', () => ({
  AcquisitionPersonnelReadService: jest.fn(),
}));
jest.mock('./meri-docgen.service.js', () => ({ MeriDocgenService: jest.fn() }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: jest.fn() }));
jest.mock('../funding-opportunities/meri-opportunity-tools.adapter.js', () => ({
  MeriOpportunityToolsAdapter: jest.fn(),
}));
jest.mock('../context/context-plane-gateway.service.js', () => ({
  ContextPlaneGatewayService: jest.fn(),
}));
jest.mock('../knowledge/entities/universal-entity-resolution-orchestrator.service.js', () => ({
  UniversalEntityResolutionOrchestratorService: jest.fn(),
}));
jest.mock('../retrieval/retrieval-v2.service.js', () => ({ RetrievalV2Service: jest.fn() }));
jest.mock('../memory/memory-ingest.service.js', () => ({ MemoryIngestService: jest.fn() }));
jest.mock('../memory/memory-candidate.service.js', () => ({ MemoryCandidateService: jest.fn() }));
jest.mock('../memory/memory-store.service.js', () => ({ MemoryStoreService: jest.fn() }));

/**
 * Wiring/shape tests for the firm-operational-data tools (tool-coverage
 * expansion). The heavy queries live in their own already-tested services, so
 * these specs mock the services and assert: (a) tenant-scope params are passed
 * through, (b) required inputs are enforced, (c) the returned shape is what the
 * model sees, (d) branch selection (list vs detail vs deadlines) is correct.
 */

const ctx = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: 'user-1',
} as TenantContext;

function makeMocks(
  extra: {
    downstreamRetrieval?: unknown;
    contextPlane?: {
      securityEnvelope: (
        actor: TenantContext,
      ) => Promise<{ authorizedClientIds: string[]; authorizedMailboxConnectionIds: string[] }>;
    };
  } = {},
) {
  const findClient = jest.fn().mockResolvedValue({ id: 'client-1' });
  const tx = {
    client: {
      findFirst: findClient,
      // These older fixtures use readable names; production resolves UUIDs or
      // exact names through the same visibility gate.
      findMany: jest.fn(async () => {
        const client = await findClient();
        return client ? [client] : [];
      }),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    clientFacility: { findMany: jest.fn().mockResolvedValue([]) },
    clientCapability: { findMany: jest.fn().mockResolvedValue([]) },
    clientPerson: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    clioConversation: {
      findFirst: jest.fn().mockResolvedValue({ id: 'conv-1', clientId: 'client-1' }),
    },
    clioArtifact: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'artifact-1',
        ...data,
      })),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, fn: (t: typeof tx) => unknown) => fn(tx),
    ),
  };
  const engagement = {
    clientContext: jest.fn().mockResolvedValue({ client: { id: 'client-1', name: 'Acme' } }),
    listMeetings: jest.fn().mockResolvedValue([]),
    getMeeting: jest.fn(),
    getClientMeeting: jest.fn(),
    listMeetingNotes: jest.fn().mockResolvedValue([]),
    listTasks: jest.fn().mockResolvedValue([]),
    readMeriTasksExact: jest.fn().mockResolvedValue({
      rows: [],
      total: 0,
      sourceStatus: 'healthy',
      sourceReason: null,
    }),
    listClientDebriefs: jest.fn().mockResolvedValue([]),
    readClientDebriefsExact: jest.fn().mockResolvedValue({
      rows: [],
      sourceStatus: 'healthy',
      sourceReason: null,
      nextAfter: null,
    }),
    listAttachments: jest.fn().mockResolvedValue([]),
    extractAttachmentText: jest.fn(),
    listCampaigns: jest.fn().mockResolvedValue([]),
    getOutreachRecord: jest.fn(),
    createTask: jest.fn(),
    updateTask: jest.fn(),
  };
  const actionRecommendations = {
    list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    readMeriActionItemsExact: jest.fn().mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      sourceStatus: 'healthy',
      sourceReason: null,
    }),
  };
  const intelligence = { listTrackedBills: jest.fn().mockResolvedValue([]) };
  const regulatoryDockets = {
    listDockets: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    getUpcomingDeadlines: jest.fn().mockResolvedValue([]),
  };
  const programElement = {
    listSamOpportunities: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  };
  const opportunityTools = { readSamSourceFreshness: jest.fn().mockResolvedValue([]) };
  const clientCapabilities = {
    listCapabilities: jest.fn().mockResolvedValue([]),
    listClientHistory: jest.fn().mockResolvedValue([]),
    createCapability: jest.fn(
      async (_ctx: unknown, _clientId: string, input: { name: string }) => ({
        id: 'cap-1',
        name: input.name,
      }),
    ),
  };
  const clientPeople = {
    listPeople: jest.fn().mockResolvedValue([]),
    createPerson: jest.fn(async (_ctx: unknown, _clientId: string, input: { name: string }) => ({
      id: 'person-1',
      name: input.name,
    })),
    upsertPersonForImport: jest.fn(
      async (_ctx: unknown, _clientId: string, input: { name: string }) => ({
        person: { id: 'person-1', name: input.name },
        created: true,
      }),
    ),
  };
  const clientFacilities = {
    listFacilities: jest.fn().mockResolvedValue([]),
    createFacility: jest.fn(async (_ctx: unknown, _clientId: string, input: { name: string }) => ({
      id: 'fac-1',
      name: input.name,
    })),
  };
  const clients = {
    get: jest.fn().mockResolvedValue({ id: 'client-1', name: 'Acme', intakeData: {} }),
    update: jest.fn(async (_ctx: unknown, id: string, data: Record<string, unknown>) => ({
      id,
      name: (data.name as string) ?? 'Acme',
    })),
  };

  const docgen = {
    buildDocx: jest.fn().mockImplementation(() => generatedOoxmlBytes('docx')),
    buildXlsx: jest.fn().mockResolvedValue(Buffer.from('xlsx')),
    buildPptx: jest.fn().mockResolvedValue(Buffer.from('pptx')),
  };
  const clientAdvocacy = {
    listMatters: jest.fn().mockResolvedValue([]),
    listRecords: jest.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
  };

  // Exercise the real Meri service and canonical resolver on every retrieval
  // dispatch; only the gateway's compilation work and downstream source are stubbed.
  const resolver = new ContextResolverService({} as never, extra.downstreamRetrieval as never);
  const gateway = {
    requestContext: jest.fn(
      async ({ resolverRequest }: { resolverRequest: ContextResolutionRequest }) => ({
        kind: 'governed_packet',
        context: await resolver.resolveAndRetrieve(resolverRequest),
      }),
    ),
  };
  const contextPlane = extra.downstreamRetrieval
    ? new MeriContextPlaneService(prisma as never, gateway as never)
    : undefined;
  if (contextPlane && extra.contextPlane) {
    jest
      .spyOn(contextPlane, 'securityEnvelope')
      .mockImplementation(extra.contextPlane.securityEnvelope);
  }

  const service = new MeriToolsService(
    prisma as never,
    { get: jest.fn() } as never,
    engagement as never,
    {} as never, // mailSender
    {} as never, // ldaIntel
    {} as never, // analyticsDb
    {} as never, // lobbyIntel
    {} as never, // federalSpending
    programElement as never,
    {} as never, // acquisitionPersonnel
    docgen as never,
    actionRecommendations as never,
    intelligence as never,
    regulatoryDockets as never,
    clientCapabilities as never,
    clientPeople as never,
    clientFacilities as never,
    { representationForClient: jest.fn().mockResolvedValue([]) } as never, // representation
    { search: jest.fn().mockResolvedValue([]) } as never, // clientKb
    { isEnabled: jest.fn().mockResolvedValue(false) } as never, // featureFlags
    clients as never,
    { projectClioMemory: jest.fn(), removeClioMemory: jest.fn() } as never, // memoryIngest
    { proposeSaveMemory: jest.fn() } as never, // memoryCandidates
    { confirmMemory: jest.fn(), correctMemory: jest.fn(), forgetMemory: jest.fn() } as never, // memoryStore
    opportunityTools as never,
    contextPlane as never,
    clientAdvocacy as never,
  );

  return {
    service,
    gateway,
    tx,
    prisma,
    engagement,
    actionRecommendations,
    intelligence,
    regulatoryDockets,
    programElement,
    opportunityTools,
    clientCapabilities,
    clientPeople,
    clientFacilities,
    clientAdvocacy,
    docgen,
    clients,
  };
}

describe('read_client_meetings', () => {
  const meeting = (id: string, startsAt: string, clientId: string | null = 'client-1') => ({
    id,
    clientId,
    subject: `Meeting ${id}`,
    startsAt: new Date(startsAt),
    endsAt: new Date(Date.parse(startsAt) + 3_600_000),
    status: 'completed',
    updatedAt: new Date('2026-09-22T00:00:00.000Z'),
    transcriptS3Key: null,
  });

  function authorized() {
    const m = makeMocks();
    m.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: true }]);
    return m;
  }

  it('uses the canonical meeting owner, paginates history, and does not fabricate a transcript', async () => {
    const m = authorized();
    m.engagement.listMeetings.mockResolvedValue([
      meeting('meeting-1', '2026-08-01T10:00:00.000Z'),
      meeting('meeting-2', '2026-08-02T10:00:00.000Z'),
    ]);
    m.engagement.getClientMeeting.mockImplementation(async (_ctx, _clientId, id) =>
      meeting(id, id === 'meeting-1' ? '2026-08-01T10:00:00.000Z' : '2026-08-02T10:00:00.000Z'),
    );

    const result = (await m.service.execute(ctx, 'read_client_meetings', {
      clientId: 'client-1',
      limit: 1,
    })) as any;

    expect(m.engagement.listMeetings).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-1',
        from: '0001-01-01T00:00:00.000Z',
        to: '9999-12-31T23:59:59.999Z',
        limit: 2,
      }),
    );
    expect(m.engagement.getClientMeeting).toHaveBeenCalledWith(ctx, 'client-1', 'meeting-1');
    expect(result.coverage).toMatchObject({ meetingPaginationComplete: false, complete: false });
    expect(result.meetings[0].sourceAvailability).toEqual({
      notes: 'empty',
      transcript: 'unavailable',
      transcriptReason: 'calendar_event_without_persisted_transcript',
    });
  });

  it('returns exact authorized note bytes and rejects a different-client parent', async () => {
    const m = authorized();
    m.engagement.getClientMeeting.mockResolvedValue(
      meeting('meeting-1', '2026-08-01T10:00:00.000Z'),
    );
    m.engagement.listMeetingNotes.mockResolvedValue([
      {
        id: 'note-1',
        meetingId: 'meeting-1',
        clientId: 'client-1',
        body: 'Pat promised the demo by October 8.',
        status: 'approved',
        createdAt: new Date('2026-08-01T11:00:00.000Z'),
        updatedAt: new Date('2026-08-02T11:00:00.000Z'),
      },
    ]);

    const result = (await m.service.execute(ctx, 'read_client_meetings', {
      clientId: 'client-1',
      meetingId: 'meeting-1',
      sourceKind: 'note',
      sourceId: 'note-1',
    })) as any;
    expect(result.source).toMatchObject({
      sourceKind: 'note',
      sourceId: 'note-1',
      body: 'Pat promised the demo by October 8.',
      provenance: {
        owner: 'meeting_notes',
        sourceVersion: '2026-08-02T11:00:00.000Z',
      },
    });
    expect(result.coverage.complete).toBe(true);

    m.engagement.getClientMeeting.mockRejectedValue(new Error('Meeting not found'));
    await expect(
      m.service.execute(ctx, 'read_client_meetings', {
        clientId: 'client-1',
        meetingId: 'meeting-1',
      }),
    ).rejects.toThrow('Meeting not found');
  });

  it('reads only a persisted authorized transcript attachment through its storage owner', async () => {
    const m = authorized();
    m.engagement.getClientMeeting.mockResolvedValue({
      ...meeting('meeting-1', '2026-08-01T10:00:00.000Z'),
      transcriptS3Key: 'tenant/client/transcript.txt',
    });
    m.engagement.listAttachments.mockResolvedValue([
      {
        id: 'transcript-1',
        source: 'notetaker',
        contentType: 'text/plain',
        s3Key: 'tenant/client/transcript.txt',
        fileName: 'transcript.txt',
        calculatedSha256: null,
        lifecycleStatus: 'ready',
        usable: true,
        blockedReason: null,
        createdAt: new Date('2026-08-01T11:00:00.000Z'),
        updatedAt: new Date('2026-08-01T11:00:00.000Z'),
      },
    ]);
    m.engagement.extractAttachmentText.mockResolvedValue({
      attachmentId: 'transcript-1',
      fileName: 'transcript.txt',
      contentType: 'text/plain',
      text: 'Full persisted transcript bytes.',
      contentHash: createHash('sha256')
        .update('Full persisted transcript bytes.', 'utf8')
        .digest('hex'),
      truncated: false,
      section: 1,
      sectionCount: 1,
    });

    const result = (await m.service.execute(ctx, 'read_client_meetings', {
      clientId: 'client-1',
      meetingId: 'meeting-1',
      sourceKind: 'transcript',
      sourceId: 'transcript-1',
    })) as any;

    expect(m.engagement.extractAttachmentText).toHaveBeenCalledWith(ctx, 'transcript-1', {
      section: 1,
    });
    expect(result.source).toMatchObject({
      sourceKind: 'transcript',
      sourceId: 'transcript-1',
      body: 'Full persisted transcript bytes.',
      contentHash: createHash('sha256')
        .update('Full persisted transcript bytes.', 'utf8')
        .digest('hex'),
      provenance: {
        owner: 'engagement_attachment_storage',
      },
    });
  });

  it('fails closed when the ethical-wall grant is revoked after the owner read', async () => {
    const m = authorized();
    m.engagement.getClientMeeting.mockResolvedValue(
      meeting('meeting-1', '2026-08-01T10:00:00.000Z'),
    );
    let wallCalls = 0;
    m.tx.$queryRawUnsafe.mockImplementation(async () => [{ allowed: wallCalls++ < 1 }]);

    await expect(
      m.service.execute(ctx, 'read_client_meetings', {
        clientId: 'client-1',
        meetingId: 'meeting-1',
      }),
    ).rejects.toThrow('Client not found');
  });

  it.each(['wall', 'membership'] as const)(
    'denies exact note bytes when %s is revoked by the final owner await',
    async (revocation) => {
      const m = authorized();
      const parent = meeting('meeting-1', '2026-08-01T10:00:00.000Z');
      const source = {
        id: 'note-1',
        meetingId: 'meeting-1',
        clientId: 'stale-child-client',
        body: 'FINAL_AWAIT_PRIVATE_BODY',
        status: 'approved',
        createdAt: new Date('2026-08-01T11:00:00.000Z'),
        updatedAt: new Date('2026-08-02T11:00:00.000Z'),
      };
      let allowed = true;
      let noteReads = 0;
      m.engagement.getClientMeeting.mockResolvedValue(parent);
      m.engagement.listMeetingNotes.mockImplementation(async () => {
        if (++noteReads === 4) allowed = false;
        return [source];
      });
      if (revocation === 'wall') {
        m.tx.$queryRawUnsafe.mockImplementation(async () => [{ allowed }]);
      } else {
        m.tx.client.findFirst.mockImplementation(async () => (allowed ? { id: 'client-1' } : null));
      }
      await expect(
        m.service.execute(ctx, 'read_client_meetings', {
          clientId: 'client-1',
          meetingId: 'meeting-1',
          sourceKind: 'note',
          sourceId: 'note-1',
        }),
      ).rejects.toThrow('Client not found');
      expect(noteReads).toBe(4);
    },
  );

  it('uses current parent association, rejects wrong note parents, and preserves stale child-client semantics', async () => {
    const parentChanged = authorized();
    let currentParent = true;
    let noteReads = 0;
    parentChanged.engagement.getClientMeeting.mockImplementation(async () => {
      if (!currentParent) throw new Error('Meeting not found');
      return meeting('meeting-1', '2026-08-01T10:00:00.000Z');
    });
    parentChanged.engagement.listMeetingNotes.mockImplementation(async () => {
      if (++noteReads === 4) currentParent = false;
      return [
        {
          id: 'note-1',
          meetingId: 'meeting-1',
          clientId: 'client-2',
          body: 'body',
          status: 'approved',
          createdAt: new Date('2026-08-01T11:00:00.000Z'),
          updatedAt: new Date('2026-08-02T11:00:00.000Z'),
        },
      ];
    });
    await expect(
      parentChanged.service.execute(ctx, 'read_client_meetings', {
        clientId: 'client-1',
        meetingId: 'meeting-1',
        sourceKind: 'note',
        sourceId: 'note-1',
      }),
    ).rejects.toThrow('Meeting not found');

    const wrongParent = authorized();
    wrongParent.engagement.getClientMeeting.mockResolvedValue(
      meeting('meeting-1', '2026-08-01T10:00:00.000Z'),
    );
    wrongParent.engagement.listMeetingNotes.mockResolvedValue([
      {
        id: 'note-1',
        meetingId: 'different-meeting',
        clientId: 'client-1',
        body: 'wrong parent',
        status: 'approved',
        createdAt: new Date('2026-08-01T11:00:00.000Z'),
        updatedAt: new Date('2026-08-02T11:00:00.000Z'),
      },
    ]);
    await expect(
      wrongParent.service.execute(ctx, 'read_client_meetings', {
        clientId: 'client-1',
        meetingId: 'meeting-1',
        sourceKind: 'note',
        sourceId: 'note-1',
      }),
    ).rejects.toThrow('Meeting source not found');

    const staleChildClient = authorized();
    staleChildClient.engagement.getClientMeeting.mockResolvedValue(
      meeting('meeting-1', '2026-08-01T10:00:00.000Z'),
    );
    staleChildClient.engagement.listMeetingNotes.mockResolvedValue([
      {
        id: 'note-1',
        meetingId: 'meeting-1',
        clientId: 'client-2',
        body: 'current parent authority',
        status: 'approved',
        createdAt: new Date('2026-08-01T11:00:00.000Z'),
        updatedAt: new Date('2026-08-02T11:00:00.000Z'),
      },
    ]);
    await expect(
      staleChildClient.service.execute(ctx, 'read_client_meetings', {
        clientId: 'client-1',
        meetingId: 'meeting-1',
        sourceKind: 'note',
        sourceId: 'note-1',
      }),
    ).resolves.toMatchObject({
      clientId: 'client-1',
      source: { clientId: 'client-1', body: 'current parent authority' },
    });
  });

  it('keeps canonical null-client associations and reports inaccessible mixed rows as partial', async () => {
    const associated = authorized();
    const nullClient = meeting('associated-null', '2026-08-01T10:00:00.000Z', null);
    const assigned = meeting('assigned', '2026-08-02T10:00:00.000Z');
    associated.engagement.listMeetings.mockResolvedValue([nullClient, assigned]);
    associated.engagement.getClientMeeting.mockImplementation(async (_ctx, _clientId, id) =>
      id === nullClient.id ? nullClient : assigned,
    );
    const page = (await associated.service.execute(ctx, 'read_client_meetings', {
      clientId: 'client-1',
      limit: 2,
    })) as any;
    expect(page.meetings).toEqual([
      expect.objectContaining({ id: 'associated-null', clientId: 'client-1' }),
      expect.objectContaining({ id: 'assigned', clientId: 'client-1' }),
    ]);

    const mixed = authorized();
    mixed.engagement.listMeetings.mockResolvedValue([nullClient, assigned]);
    mixed.engagement.getClientMeeting.mockImplementation(async (_ctx, _clientId, id) => {
      if (id === assigned.id) throw new Error('Meeting not found');
      return nullClient;
    });
    const partial = (await mixed.service.execute(ctx, 'read_client_meetings', {
      clientId: 'client-1',
      limit: 2,
    })) as any;
    expect(partial.meetings).toEqual([
      expect.objectContaining({ id: 'associated-null', clientId: 'client-1' }),
    ]);
    expect(partial.coverage).toMatchObject({
      sourceStatus: 'degraded',
      complete: false,
      partial: true,
      omittedMeetings: 1,
    });
    expect(partial.coverage.note).not.toContain('No eligible authorized meetings');
  });

  it('denies extracted transcript bytes when the canonical parent changes during extraction', async () => {
    const m = authorized();
    let parentCurrent = true;
    m.engagement.getClientMeeting.mockImplementation(async () => {
      if (!parentCurrent) throw new Error('Meeting not found');
      return {
        ...meeting('meeting-1', '2026-08-01T10:00:00.000Z'),
        transcriptS3Key: 'transcript.txt',
      };
    });
    m.engagement.listAttachments.mockResolvedValue([
      {
        id: 'transcript-1',
        source: 'notetaker',
        contentType: 'text/plain',
        s3Key: 'transcript.txt',
        calculatedSha256: null,
        lifecycleStatus: 'ready',
        usable: true,
        blockedReason: null,
        createdAt: new Date('2026-08-01T11:00:00.000Z'),
      },
    ]);
    m.engagement.extractAttachmentText.mockImplementation(async () => {
      parentCurrent = false;
      const text = 'TRANSCRIPT_PRIVATE_BODY';
      return {
        contentType: 'text/plain',
        text,
        truncated: false,
        contentHash: createHash('sha256').update(text).digest('hex'),
      };
    });
    await expect(
      m.service.execute(ctx, 'read_client_meetings', {
        clientId: 'client-1',
        meetingId: 'meeting-1',
        sourceKind: 'transcript',
        sourceId: 'transcript-1',
      }),
    ).rejects.toThrow('Meeting not found');
  });
});

describe('query_tasks', () => {
  it('uses exact authorized counts and the signed-in assignee without a selected client', async () => {
    const m = makeMocks();
    const result = (await m.service.execute(ctx, 'query_tasks', {
      status: 'overdue', assignedToMe: true, dueBefore: '2026-10-02T00:00:00.000Z',
    })) as any;
    expect(m.engagement.listTasks).not.toHaveBeenCalled();
    expect(m.engagement.readMeriTasksExact).toHaveBeenCalledWith(ctx, expect.objectContaining({
      clientId: null, ownerUserId: ctx.userId, openOnly: true,
      dueBefore: new Date('2026-10-02T00:00:00.000Z'),
    }));
    expect(result).toMatchObject({ clientId: null, total: 0, returned: 0,
      scope: { kind: 'authorized_tasks', actorUserId: ctx.userId, ownerUserId: ctx.userId },
      coverage: { complete: true, absenceSupported: true },
    });
  });

  it('maps the exact client-scoped canonical owner result with honest coverage', async () => {
    const m = makeMocks();
    m.engagement.readMeriTasksExact.mockResolvedValue({
      rows: [
        {
          id: 'task-1',
          clientId: 'client-1',
          meetingId: null,
          contactId: null,
          mailThreadId: null,
          title: 'Deliver demo',
          description: 'Demo body',
          ownerUserId: null,
          dueDate: null,
          status: 'done',
          sourceType: 'meeting',
          sourceId: 'meeting-1',
          createdByUserId: 'user-1',
          createdAt: new Date('2026-09-20T00:00:00.000Z'),
          updatedAt: new Date('2026-09-21T00:00:00.000Z'),
          client: { id: 'client-1', name: 'Acme' },
          meeting: null,
        },
      ],
      total: 1,
      sourceStatus: 'healthy',
      sourceReason: null,
    });
    const result = (await m.service.execute(ctx, 'query_tasks', { clientId: 'client-1' })) as any;
    expect(m.engagement.readMeriTasksExact).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-1',
        offset: 0,
        limit: 25,
      }),
    );
    expect(result).toMatchObject({
      total: 1,
      returned: 1,
      coverage: { complete: true, absenceSupported: false },
      tasks: [
        {
          id: 'task-1',
          title: 'Deliver demo',
          ownerUserId: null,
          dueDate: null,
          nativeCompletion: { completed: true, establishesDeliveryOrAcceptance: false },
        },
      ],
    });
  });

  it('derives overdue from past due date on open tasks only', async () => {
    const m = makeMocks();
    const rows = [
      {
        id: 'task-1',
        title: 'Past-due open task',
        status: 'todo',
        dueDate: new Date('2020-01-01'),
        clientId: null,
        client: null,
        meeting: null,
        description: null,
        createdAt: new Date('2019-12-01'),
      },
      {
        id: 'task-2',
        title: 'Past-due DONE task',
        status: 'done',
        dueDate: new Date('2020-01-01'),
        clientId: null,
        client: null,
        meeting: null,
        description: null,
        createdAt: new Date('2019-12-01'),
      },
    ].map((row) => ({ ownerUserId: null, meetingId: null, contactId: null, mailThreadId: null,
      sourceType: null, sourceId: null, createdByUserId: null, updatedAt: row.createdAt, ...row }));
    m.engagement.readMeriTasksExact.mockResolvedValue({ rows, total: rows.length, sourceStatus: 'healthy', sourceReason: null });
    const result = (await m.service.execute(ctx, 'query_tasks', {})) as {
      tasks: Array<{ id: string; overdue: boolean }>;
    };
    expect(result.tasks.find((t) => t.id === 'task-1')!.overdue).toBe(true);
    expect(result.tasks.find((t) => t.id === 'task-2')!.overdue).toBe(false);
  });

  it('maps status=overdue to openOnly + dueBefore', async () => {
    const m = makeMocks();
    await m.service.execute(ctx, 'query_tasks', { status: 'overdue', limit: 10 });
    const call = m.engagement.readMeriTasksExact.mock.calls[0]!;
    expect(call[0]).toBe(ctx);
    expect(call[1]).toMatchObject({ openOnly: true, limit: 10 });
    expect(call[1].dueBefore).toBeInstanceOf(Date);
  });

  it('rejects unknown statuses', async () => {
    const m = makeMocks();
    await expect(
      m.service.execute(ctx, 'query_tasks', { status: 'nonsense' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('query_action_items', () => {
  it('passes ctx + filters to the read service and returns the cards', async () => {
    const m = makeMocks();
    m.actionRecommendations.readMeriActionItemsExact.mockResolvedValue({
      data: [
        {
          id: 'action-1',
          clientId: 'client-1',
          clientName: 'Acme',
          issueTitle: 'PE cut',
          recommendedAction: 'Prepare response',
          whatChanged: 'Cut',
          whyItMatters: 'Risk',
          status: 'new',
          ownerUserId: null,
          deadline: null,
          deadlineSource: null,
          actionType: 'monitor',
          outcome: null,
          evidence: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      sourceStatus: 'healthy',
      sourceReason: null,
    });
    const result = (await m.service.execute(ctx, 'query_action_items', {
      clientId: 'client-1',
      status: 'new',
      sort: 'priority',
    })) as { total: number; actions: Array<{ id: string }> };
    expect(m.actionRecommendations.readMeriActionItemsExact).toHaveBeenCalledWith(ctx, {
      clientId: 'client-1',
      actionItemId: null,
      status: 'new',
      sort: 'priority',
      page: 1,
      limit: 20,
    });
    expect(result.total).toBe(1);
    expect(result.actions[0]!.id).toBe('action-1');
  });
});

describe('search_tracked_bills', () => {
  it('requires clientId', async () => {
    const m = makeMocks();
    await expect(m.service.execute(ctx, 'search_tracked_bills', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns the tracked bills for a visible client', async () => {
    const m = makeMocks();
    m.intelligence.listTrackedBills.mockResolvedValue([{ billId: 'hr-1', bill: null }]);
    const result = (await m.service.execute(ctx, 'search_tracked_bills', {
      clientId: 'client-1',
    })) as { total: number; bills: unknown[] };
    expect(m.intelligence.listTrackedBills).toHaveBeenCalledWith('client-1', ctx.tenantId);
    expect(result.total).toBe(1);
  });
});

describe('query_regulatory_dockets', () => {
  it('list branch', async () => {
    const m = makeMocks();
    await m.service.execute(ctx, 'query_regulatory_dockets', {
      agencyId: 'EPA',
      documentType: 'Proposed Rule',
      limit: 5,
    });
    expect(m.regulatoryDockets.listDockets).toHaveBeenCalledWith({
      agencyId: 'EPA',
      documentType: 'Proposed Rule',
      limit: 5,
    });
  });

  it('upcoming-deadlines branch', async () => {
    const m = makeMocks();
    await m.service.execute(ctx, 'query_regulatory_dockets', { upcomingOnly: true, days: 45 });
    expect(m.regulatoryDockets.getUpcomingDeadlines).toHaveBeenCalledWith(45);
    expect(m.regulatoryDockets.listDockets).not.toHaveBeenCalled();
  });
});

describe('search_sam_opportunities', () => {
  const freshSam = {
    source: 'sam_gov',
    state: 'current',
    recordCount: 100,
    activeRecordCount: 90,
    lastSyncedAt: new Date(Date.now() - 5 * 3600000).toISOString(),
  };
  it('passes filters and summarizes long descriptions', async () => {
    const m = makeMocks();
    m.programElement.listSamOpportunities.mockResolvedValue({
      data: [{ id: 'opp-1', title: 'Radar RFI', description: 'x'.repeat(2000) }],
      total: 1,
    });
    const result = (await m.service.execute(ctx, 'search_sam_opportunities', {
      query: 'radar',
      naics: '3364',
    })) as { results: Array<{ description: string }> };
    expect(m.programElement.listSamOpportunities).toHaveBeenCalledWith({
      query: 'radar',
      naics: '3364',
      includeInactive: undefined,
      limit: 20,
    });
    expect(result.results[0]!.description.length).toBeLessThanOrEqual(300);
  });

  it('keeps off output identical and adds deterministic deadline facts only under enforce', async () => {
    const previous = {
      mode: process.env.MERI_EVIDENCE_ACCURACY_MODE,
      tenants: process.env.MERI_EVIDENCE_ACCURACY_TENANTS,
      surfaces: process.env.MERI_EVIDENCE_ACCURACY_SURFACES,
    };
    try {
      const m = makeMocks();
      m.programElement.listSamOpportunities.mockResolvedValue({
        data: [
          {
            id: 'opp-1',
            title: 'Radar RFI',
            description: 'short',
            responseDeadline: new Date('2099-07-15T21:00:00Z'),
          },
        ],
        total: 1,
      });
      process.env.MERI_EVIDENCE_ACCURACY_MODE = 'off';
      const off = (await m.service.execute(ctx, 'search_sam_opportunities', {})) as {
        results: Array<Record<string, unknown>>;
      };
      expect(off.results[0]).toEqual({
        id: 'opp-1',
        title: 'Radar RFI',
        description: 'short',
        responseDeadline: new Date('2099-07-15T21:00:00Z'),
      });

      process.env.MERI_EVIDENCE_ACCURACY_MODE = 'enforce';
      process.env.MERI_EVIDENCE_ACCURACY_TENANTS = 'all';
      process.env.MERI_EVIDENCE_ACCURACY_SURFACES = 'chat';
      const enforced = (await m.service.execute(ctx, 'search_sam_opportunities', {})) as {
        results: Array<{ deadline: Record<string, unknown> }>;
      };
      expect(enforced.results[0]!.deadline).toMatchObject({
        at: '2099-07-15T21:00:00.000Z',
        basis: 'explicit_datetime',
        status: 'open',
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        const envKey = `MERI_EVIDENCE_ACCURACY_${key.toUpperCase()}`;
        if (value == null) delete process.env[envKey];
        else process.env[envKey] = value;
      }
    }
  });

  it.each([
    ['clean recent source', freshSam, 'healthy', null],
    [
      'stale source',
      { ...freshSam, lastSyncedAt: new Date(Date.now() - 48 * 3600000).toISOString() },
      'degraded',
      'source_sync_stale',
    ],
    [
      'failed attempt',
      { ...freshSam, state: 'error_cached' },
      'degraded',
      'latest_source_sync_incomplete',
    ],
    [
      'partial attempt',
      { ...freshSam, state: 'initial_partial' },
      'degraded',
      'latest_source_sync_incomplete',
    ],
    [
      'running attempt',
      { ...freshSam, state: 'degraded' },
      'degraded',
      'latest_source_sync_incomplete',
    ],
    [
      'never synchronized',
      { ...freshSam, state: 'never_synced', lastSyncedAt: null },
      'degraded',
      'all_federal_source_never_synced',
    ],
    [
      'unreadable health',
      { ...freshSam, state: 'unknown', recordCount: null },
      'unknown',
      'source_freshness_unavailable',
    ],
  ])('preserves zero matches separately from %s', async (_label, freshness, status, reason) => {
    const m = makeMocks();
    m.opportunityTools.readSamSourceFreshness.mockResolvedValue([freshness]);
    const result = await m.service.execute(ctx, 'search_sam_opportunities', { query: 'unmatched' });
    expect(result).toMatchObject({
      total: 0,
      results: [],
      sourceFreshness: [freshness],
      sourceStatus: status,
      sourceReason: reason,
    });
    expect((result as { notes: string[] }).notes.join(' ')).toContain('does not establish');
  });

  it('propagates a failed catalog read instead of manufacturing zero matches', async () => {
    const m = makeMocks();
    m.programElement.listSamOpportunities.mockRejectedValue(new Error('catalog unavailable'));
    await expect(m.service.execute(ctx, 'search_sam_opportunities', {})).rejects.toThrow(
      'catalog unavailable',
    );
  });
});

describe('query_debriefs', () => {
  it('requires clientId and maps the canonical exact owner page without summarizing', async () => {
    const m = makeMocks();
    m.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: true }] as never);
    await expect(m.service.execute(ctx, 'query_debriefs', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const body = 'x'.repeat(2000);
    m.engagement.readClientDebriefsExact.mockResolvedValue({
      rows: [
        {
          id: 'debrief-1',
          meetingId: 'meeting-1',
          clientId: 'client-1',
          meeting: {
            id: 'meeting-1',
            clientId: 'client-1',
            subject: 'Hill day',
            startsAt: new Date('2026-06-01T14:00:00.000Z'),
          },
          body,
          status: 'approved',
          authorUserId: 'user-1',
          author: null,
          createdAt: new Date('2026-06-01T15:00:00.000Z'),
          updatedAt: new Date('2026-06-01T16:00:00.000Z'),
        },
      ],
      sourceStatus: 'healthy',
      sourceReason: null,
      nextAfter: null,
    });
    const result = (await m.service.execute(ctx, 'query_debriefs', {
      clientId: 'client-1',
      debriefId: 'debrief-1',
      characterLimit: 2000,
    })) as { debriefs: Array<{ body: string; bodyCoverage: { complete: boolean } }> };
    expect(result.debriefs[0]!.body).toBe(body);
    expect(result.debriefs[0]!.bodyCoverage.complete).toBe(true);
    expect(m.engagement.listClientDebriefs).not.toHaveBeenCalled();
    expect(m.tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });
});

describe('query_outreach', () => {
  it('list branch maps campaigns with recipient counts', async () => {
    const m = makeMocks();
    m.engagement.listCampaigns.mockResolvedValue([
      {
        id: 'campaign-1',
        name: 'June Hill blitz',
        type: 'custom',
        status: 'draft',
        subject: null,
        clientId: 'client-1',
        client: { id: 'client-1', name: 'Acme' },
        recipients: [{ id: 'recipient-1' }, { id: 'recipient-2' }, { id: 'recipient-3' }],
        createdBy: { email: 'neo@capiro.ai' },
        sentAt: null,
        createdAt: new Date('2026-06-01'),
      },
    ]);
    const result = (await m.service.execute(ctx, 'query_outreach', {})) as {
      campaigns: Array<Record<string, unknown>>;
    };
    expect(m.engagement.listCampaigns).toHaveBeenCalledWith(ctx, {
      clientId: undefined,
      status: undefined,
    });
    expect(result.campaigns[0]).toMatchObject({ recipientCount: 3, clientName: 'Acme' });
  });

  it('detail branch fetches a single record', async () => {
    const m = makeMocks();
    m.engagement.getOutreachRecord.mockResolvedValue({ id: 'outreach-9', body: 'b' });
    const result = (await m.service.execute(ctx, 'query_outreach', {
      outreachId: 'outreach-9',
    })) as { record: { id: string } };
    expect(m.engagement.getOutreachRecord).toHaveBeenCalledWith(ctx, 'outreach-9');
    expect(result.record.id).toBe('outreach-9');
  });
});

describe('get_client_context profile depth', () => {
  it('adds the additive profile key without touching the engagement context', async () => {
    const m = makeMocks();
    m.clientCapabilities.listCapabilities.mockResolvedValue([
      { id: 'cap-1', name: 'Radar', type: 'product', peNumbers: ['0604123A'] },
    ]);
    m.clientPeople.listPeople.mockResolvedValue([{ id: 'person-1', name: 'Dr. Smith' }]);
    m.clientFacilities.listFacilities.mockResolvedValue([{ id: 'facility-1', name: 'HQ' }]);
    m.clientCapabilities.listClientHistory.mockResolvedValue([
      { id: 'history-1', fiscalYear: 2026, title: 'FY26 approps', outcomeType: 'won' },
    ]);
    const result = (await m.service.execute(ctx, 'get_client_context', {
      clientId: 'client-1',
    })) as { context: unknown; profile: Record<string, unknown[]> };
    expect(m.engagement.clientContext).toHaveBeenCalledWith(ctx, 'client-1');
    expect(result.context).toEqual({ client: { id: 'client-1', name: 'Acme' } });
    expect(result.profile.capabilities).toHaveLength(1);
    expect(result.profile.people).toHaveLength(1);
    expect(result.profile.facilities).toHaveLength(1);
    expect(result.profile.submissionHistory).toHaveLength(1);
  });

  it('profile reads are best-effort: a failing profile service never breaks the tool', async () => {
    const m = makeMocks();
    m.clientPeople.listPeople.mockRejectedValue(new Error('boom'));
    const result = (await m.service.execute(ctx, 'get_client_context', {
      clientId: 'client-1',
    })) as { profile: { people: unknown[] } };
    expect(result.profile.people).toEqual([]);
  });
});

describe('P2 write tools', () => {
  it('create_task maps inputs onto EngagementService.createTask', async () => {
    const m = makeMocks();
    m.engagement.createTask.mockResolvedValue({
      id: 'task-9',
      title: 'Follow up with PEO',
      status: 'todo',
      dueDate: new Date('2026-06-20'),
      clientId: 'client-1',
      createdAt: new Date('2026-06-10'),
    });
    const result = (await m.service.execute(ctx, 'create_task', {
      title: 'Follow up with PEO',
      clientId: 'client-1',
      dueDate: '2026-06-20',
    })) as { created: boolean; task: { id: string } };
    expect(m.engagement.createTask).toHaveBeenCalledWith(ctx, {
      title: 'Follow up with PEO',
      clientId: 'client-1',
      dueDate: '2026-06-20',
      description: undefined,
    });
    expect(result.created).toBe(true);
    expect(result.task.id).toBe('task-9');
  });

  it('update_task maps open->todo, rejects an empty update', async () => {
    const m = makeMocks();
    m.engagement.updateTask.mockResolvedValue({
      id: 'task-9',
      title: 'x',
      status: 'todo',
      dueDate: null,
      clientId: null,
      updatedAt: new Date('2026-06-10'),
    });
    await m.service.execute(ctx, 'update_task', { taskId: 'task-9', status: 'open' });
    expect(m.engagement.updateTask).toHaveBeenCalledWith(ctx, 'task-9', { status: 'todo' });

    await expect(
      m.service.execute(ctx, 'update_task', { taskId: 'task-9' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      m.service.execute(ctx, 'update_task', { taskId: 'task-9', status: 'bogus' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('create_word artifact persistence (regression: conversationId threading)', () => {
  it('rejects invalid document bytes before persistence', async () => {
    const m = makeMocks();
    m.docgen.buildDocx.mockResolvedValueOnce(Buffer.from('docx'));

    await expect(
      m.service.execute(ctx, 'create_word', {
        title: 'Strategy Memo',
        clientId: 'client-1',
        conversationId: 'conv-1',
        sections: [{ heading: 'Overview', body: 'Body text' }],
      }),
    ).rejects.toThrow('ooxml_zip_end_missing');
    expect(m.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('persists the document artifact and returns a download URL when conversationId is supplied', async () => {
    const m = makeMocks();
    const result = (await m.service.execute(ctx, 'create_word', {
      title: 'Strategy Memo',
      clientId: 'client-1',
      conversationId: 'conv-1',
      sections: [{ heading: 'Overview', body: 'Body text' }],
    })) as { downloadUrl: string | null; artifact: { persisted?: boolean; id?: string } };

    // The artifact row must be created (so it has a download URL) — the whole
    // point of the fix: without conversationId this silently no-ops.
    expect(m.tx.clioArtifact.create).toHaveBeenCalledTimes(1);
    const createArg = (m.tx.clioArtifact.create.mock.calls[0]?.[0] ?? { data: {} }) as {
      data: { conversationId: string; kind: string; metadata: Record<string, unknown> };
    };
    expect(createArg.data.conversationId).toBe('conv-1');
    expect(createArg.data.kind).toBe('word_document');
    expect(createArg.data.metadata.docFormat).toBe('docx');
    expect(result.downloadUrl).toBe('/api/clio/artifacts/artifact-1/download');
    expect(m.docgen.buildDocx).toHaveBeenCalledTimes(1);
  });

  it('does NOT persist (no download URL) when conversationId is absent', async () => {
    const m = makeMocks();
    const result = (await m.service.execute(ctx, 'create_word', {
      title: 'Strategy Memo',
      clientId: 'client-1',
      sections: [{ heading: 'Overview', body: 'Body text' }],
    })) as { downloadUrl: string | null; artifact: { persisted?: boolean } };

    expect(m.tx.clioArtifact.create).not.toHaveBeenCalled();
    expect(result.downloadUrl).toBeNull();
    expect(result.artifact.persisted).toBe(false);
  });
});

describe('update_client_profile (Meri writes to the web app)', () => {
  it('writes only whitelisted fields and returns fieldsWritten', async () => {
    const m = makeMocks();
    const result = (await m.service.execute(ctx, 'update_client_profile', {
      clientId: 'client-1',
      name: 'Acme Robotics',
      website: 'https://acme.example',
      issueCodes: ['DEF', 'TEC', ''],
      bogusField: 'ignored',
    })) as { updated: boolean; fieldsWritten: string[]; clientName: string };

    expect(m.clients.update).toHaveBeenCalledTimes(1);
    const [, id, data] = m.clients.update.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe('client-1');
    expect(data).toMatchObject({
      name: 'Acme Robotics',
      website: 'https://acme.example',
      issueCodes: ['DEF', 'TEC'], // empty string dropped
    });
    expect(data).not.toHaveProperty('bogusField');
    expect(result.updated).toBe(true);
    expect(result.fieldsWritten).toEqual(expect.arrayContaining(['name', 'website', 'issueCodes']));
  });

  it('merges per-field provenance into intakeData.__webImport without clobbering', async () => {
    const m = makeMocks();
    m.clients.get.mockResolvedValue({
      id: 'client-1',
      name: 'Acme',
      intakeData: { existingKey: 'keep', __webImport: { fields: { name: { sourceUrl: 'old' } } } },
    });
    await m.service.execute(ctx, 'update_client_profile', {
      clientId: 'client-1',
      website: 'https://acme.example',
      provenance: { website: { sourceUrl: 'https://acme.example/about', confidence: 'high' } },
    });
    const [, , data] = m.clients.update.mock.calls[0] as [unknown, string, Record<string, unknown>];
    const intake = data.intakeData as Record<string, unknown>;
    expect(intake.existingKey).toBe('keep');
    const webImport = intake.__webImport as Record<string, unknown>;
    const fields = webImport.fields as Record<string, unknown>;
    expect(fields.name).toEqual({ sourceUrl: 'old' }); // prior provenance preserved
    expect(fields.website).toEqual({ sourceUrl: 'https://acme.example/about', confidence: 'high' });
  });

  it('rejects when no recognized fields are supplied', async () => {
    const m = makeMocks();
    await expect(
      m.service.execute(ctx, 'update_client_profile', { clientId: 'client-1', junk: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.clients.update).not.toHaveBeenCalled();
  });

  it('404s for a client outside the tenant (visibility gate)', async () => {
    const m = makeMocks();
    m.tx.client.findFirst.mockResolvedValue(null);
    await expect(
      m.service.execute(ctx, 'update_client_profile', {
        clientId: '22222222-2222-4222-8222-222222222222',
        name: 'X',
      }),
    ).rejects.toThrow('Client not found');
    expect(m.clients.update).not.toHaveBeenCalled();
  });

  it('appends facilities and capabilities discovered on the website', async () => {
    const m = makeMocks();
    const result = (await m.service.execute(ctx, 'update_client_profile', {
      clientId: 'client-1',
      facilities: [
        {
          name: 'HQ',
          city: 'Jacksonville',
          state: 'fl',
          congressionalDistrict: '5',
          employeeCount: 25,
        },
        { notUseful: true }, // dropped: no name
      ],
      capabilities: [{ name: 'Autonomous ISR', type: 'product', sector: 'DEFENSE' }],
    })) as {
      updated: boolean;
      facilitiesCreated: string[];
      capabilitiesCreated: string[];
      fieldsWritten: string[];
    };

    // Scalar update skipped (no scalar fields), child rows appended.
    expect(m.clients.update).not.toHaveBeenCalled();
    expect(m.clientFacilities.createFacility).toHaveBeenCalledTimes(1);
    const [, facClientId, facInput] = m.clientFacilities.createFacility.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(facClientId).toBe('client-1');
    expect(facInput).toMatchObject({
      name: 'HQ',
      city: 'Jacksonville',
      state: 'FL', // upper-cased
      congressionalDistrict: '5',
      employeeCount: 25,
      districtSource: 'web_import',
    });
    expect(m.clientCapabilities.createCapability).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(true);
    expect(result.facilitiesCreated).toEqual(['HQ']);
    expect(result.capabilitiesCreated).toEqual(['Autonomous ISR']);
    expect(result.fieldsWritten).toEqual([]);
  });

  it('appends key people discovered on the website', async () => {
    const m = makeMocks();
    const result = (await m.service.execute(ctx, 'update_client_profile', {
      clientId: 'client-1',
      people: [
        {
          name: 'Jane Doe',
          title: 'VP of Government Affairs',
          email: 'jane@acme.example',
          role: 'decision-maker',
          lastContact: '2026-07-01',
        },
        { title: 'no name here' }, // dropped: no name
      ],
    })) as {
      updated: boolean;
      peopleCreated: string[];
      fieldsWritten: string[];
    };

    // Scalar update skipped (no scalar fields), person row appended.
    expect(m.clients.update).not.toHaveBeenCalled();
    expect(m.clientPeople.upsertPersonForImport).toHaveBeenCalledTimes(1);
    const [, personClientId, personInput] = m.clientPeople.upsertPersonForImport.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(personClientId).toBe('client-1');
    expect(personInput).toMatchObject({
      name: 'Jane Doe',
      title: 'VP of Government Affairs',
      email: 'jane@acme.example',
      role: 'decision-maker',
      lastContact: '2026-07-01',
    });
    expect(result.updated).toBe(true);
    expect(result.peopleCreated).toEqual(['Jane Doe']);
    expect(result.fieldsWritten).toEqual([]);
  });

  it('writes scalar fields AND appends children in one call', async () => {
    const m = makeMocks();
    const result = (await m.service.execute(ctx, 'update_client_profile', {
      clientId: 'client-1',
      sectorTag: 'DEFENSE',
      facilities: [{ name: 'Plant 2', state: 'TX' }],
      people: [{ name: 'John Roe', title: 'CEO' }],
    })) as { facilitiesCreated: string[]; peopleCreated: string[]; fieldsWritten: string[] };
    expect(m.clients.update).toHaveBeenCalledTimes(1);
    expect(m.clientFacilities.createFacility).toHaveBeenCalledTimes(1);
    expect(m.clientPeople.upsertPersonForImport).toHaveBeenCalledTimes(1);
    expect(result.fieldsWritten).toEqual(['sectorTag']);
    expect(result.facilitiesCreated).toEqual(['Plant 2']);
    expect(result.peopleCreated).toEqual(['John Roe']);
  });

  it('rejects when only empty/nameless children are supplied', async () => {
    const m = makeMocks();
    await expect(
      m.service.execute(ctx, 'update_client_profile', {
        clientId: 'client-1',
        facilities: [{ city: 'Nowhere' }],
        capabilities: [{ type: 'product' }],
        people: [{ title: 'nobody' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.clients.update).not.toHaveBeenCalled();
    expect(m.clientFacilities.createFacility).not.toHaveBeenCalled();
    expect(m.clientPeople.createPerson).not.toHaveBeenCalled();
  });
});

describe('client visibility gate', () => {
  it('rejects when the client is not visible in the tenant', async () => {
    const m = makeMocks();
    m.tx.client.findFirst.mockResolvedValue(null);
    await expect(
      m.service.execute(ctx, 'query_tasks', { clientId: '22222222-2222-4222-8222-222222222222' }),
    ).rejects.toThrow('Client not found');
    expect(m.engagement.listTasks).not.toHaveBeenCalled();
  });
});

describe('get_client_context canonical rich profile', () => {
  const clientId = '11111111-1111-4111-8111-111111111111';
  function makeContextMocks() {
    const m = makeMocks();
    m.tx.client.findFirst.mockResolvedValue({ id: clientId });
    const wallRead = jest.fn().mockResolvedValue([]);
    const withTenantUser = jest.fn(
      async (_tenantId: string, _userId: string, fn: (tx: unknown) => unknown) =>
        fn({ $queryRawUnsafe: wallRead }),
    );
    Object.assign(m.prisma, { withTenantUser });
    return { ...m, wallRead, withTenantUser };
  }

  it('loads authorized sections with complete counts and keeps engagement context', async () => {
    const m = makeContextMocks();
    const history = Array.from({ length: 63 }, (_, i) => ({
      id: `history-${String(i).padStart(3, '0')}`,
      title: `Ask ${i}`,
      outcome: 'Full history',
    }));
    m.clientCapabilities.listClientHistory.mockResolvedValue(history);
    m.clientCapabilities.listCapabilities.mockResolvedValue([
      { id: 'cap-1', name: 'Robotics', description: 'Evidence' },
    ]);
    m.clientPeople.listPeople.mockResolvedValue([{ id: 'person-1', name: 'Director' }]);
    m.clientFacilities.listFacilities.mockResolvedValue([{ id: 'facility-1', city: 'Seattle' }]);
    const result = (await m.service.execute(ctx, 'get_client_context', { clientId })) as any;
    expect(m.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function));
    expect(m.wallRead).toHaveBeenCalledWith(expect.any(String), ctx.tenantId, ctx.userId);
    expect(m.engagement.clientContext).toHaveBeenCalledWith(ctx, clientId);
    expect(m.clientCapabilities.listClientHistory).toHaveBeenCalledWith(ctx, clientId, null);
    expect(m.clientCapabilities.listCapabilities).toHaveBeenCalledWith(ctx, clientId);
    expect(m.clientPeople.listPeople).toHaveBeenCalledWith(ctx, clientId);
    expect(m.clientFacilities.listFacilities).toHaveBeenCalledWith(ctx, clientId);
    expect(m.clientAdvocacy.listMatters).toHaveBeenCalledWith(ctx, clientId);
    expect(m.clientAdvocacy.listRecords).toHaveBeenCalledWith(ctx, clientId, {
      limit: 25,
      afterId: undefined,
    });
    expect(result.context.client.name).toBe('Acme');
    expect(result.profile.capabilities[0].name).toBe('Robotics');
    expect(result.profileSections.submissionHistory).toMatchObject({
      status: 'partial',
      total: 63,
      returned: 25,
      truncated: true,
    });
    const second = (await m.service.execute(ctx, 'get_client_context', {
      clientId,
      section: 'submissionHistory',
      cursor: result.profileSections.submissionHistory.nextCursor,
      limit: 50,
    })) as any;
    expect(second.profile.submissionHistory).toHaveLength(38);
    expect(second.profileSections.submissionHistory).toMatchObject({
      status: 'complete',
      total: 63,
      nextCursor: null,
    });
    expect(second.profileSections.capabilities.status).toBe('not_requested');
    expect(m.clientCapabilities.listCapabilities).toHaveBeenCalledTimes(1);
  });

  it('distinguishes section failures from a client with no records', async () => {
    const m = makeContextMocks();
    m.clientPeople.listPeople.mockRejectedValue(new Error('Database unavailable'));
    const result = (await m.service.execute(ctx, 'get_client_context', { clientId })) as any;
    expect(result.profileSections.people).toMatchObject({ status: 'unavailable', total: null });
    expect(result.profileSections.facilities).toMatchObject({ status: 'complete', total: 0 });
    expect(result.context.client).toBeDefined();
  });

  it('withholds every section when the ethical wall denies the caller', async () => {
    const m = makeContextMocks();
    m.wallRead.mockResolvedValue([{ id: clientId }]);
    await expect(m.service.execute(ctx, 'get_client_context', { clientId })).rejects.toThrow(
      'Client not found',
    );
    expect(m.engagement.clientContext).not.toHaveBeenCalled();
    expect(m.clientCapabilities.listCapabilities).not.toHaveBeenCalled();
    expect(m.clientPeople.listPeople).not.toHaveBeenCalled();
    expect(m.clientFacilities.listFacilities).not.toHaveBeenCalled();
    expect(m.clientAdvocacy.listMatters).not.toHaveBeenCalled();
    expect(m.clientAdvocacy.listRecords).not.toHaveBeenCalled();
  });

  it('fails closed if the wall cannot be checked', async () => {
    const m = makeContextMocks();
    m.wallRead.mockRejectedValue(new Error('Wall check unavailable'));
    await expect(m.service.execute(ctx, 'get_client_context', { clientId })).rejects.toThrow(
      'Wall check unavailable',
    );
    expect(m.engagement.clientContext).not.toHaveBeenCalled();
    expect(m.clientAdvocacy.listMatters).not.toHaveBeenCalled();
    expect(m.clientAdvocacy.listRecords).not.toHaveBeenCalled();
  });

  it('keeps every section cursor visible before large records in the model prompt', async () => {
    const m = makeContextMocks();
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `row-${i}`,
      name: 'x'.repeat(30000),
      description: 'y'.repeat(30000),
    }));
    m.clientCapabilities.listCapabilities.mockResolvedValue(rows);
    m.clientPeople.listPeople.mockResolvedValue(rows);
    m.clientFacilities.listFacilities.mockResolvedValue(rows);
    m.clientCapabilities.listClientHistory.mockResolvedValue(rows);
    m.clientAdvocacy.listMatters.mockResolvedValue(rows);
    m.clientAdvocacy.listRecords.mockResolvedValue({
      items: rows.slice(0, 25),
      total: 30,
      hasMore: true,
    });
    const result = (await m.service.execute(ctx, 'get_client_context', { clientId })) as any;
    const prompt = wrapToolResultForPrompt('get_client_context', result, 12000);
    for (const section of [
      'capabilities',
      'people',
      'facilities',
      'submissionHistory',
      'advocacyMatters',
      'advocacyRecords',
    ]) {
      expect(result.profileSections[section].sourceReferences).toBeUndefined();
      expect(result.profileSources[section]).toHaveLength(25);
      expect(prompt).toContain(result.profileSections[section].nextCursor);
    }
    expect(prompt).toContain('Unavailable or unrequested sections are not empty');
    expect(prompt).toContain('[truncated tool result]');
  });

  it('makes all 26 capability summaries available in a single inventory page within the prompt budget', async () => {
    const m = makeContextMocks();
    const capabilities = Array.from({ length: 26 }, (_, i) => ({
      id: `cap-${String(i).padStart(2, '0')}`,
      name: `Capability ${i}`,
      description: 'Recorded evidence',
    }));
    m.clientCapabilities.listCapabilities.mockResolvedValue(capabilities);
    const result = (await m.service.execute(ctx, 'get_client_context', {
      clientId,
      section: 'capabilities',
      representation: 'summary',
      limit: 50,
    })) as any;
    expect(result.profile.capabilities).toHaveLength(26);
    expect(result.profileSections.capabilities).toMatchObject({
      status: 'complete',
      total: 26,
      returned: 26,
      nextCursor: null,
      representation: 'summary',
    });
    const prompt = wrapToolResultForPrompt('get_client_context', result, 12000);
    expect(prompt).toContain('Capability 25');
    expect(prompt).not.toContain('[truncated tool result]');
    expect(m.clientAdvocacy.listRecords).not.toHaveBeenCalled();
  });

  it('keeps current matters and evidence records distinct from the old submission ledger, with full record continuation', async () => {
    const m = makeContextMocks();
    m.clientCapabilities.listClientHistory.mockResolvedValue([
      { id: 'old-1', title: 'Older submission' },
    ]);
    m.clientAdvocacy.listMatters.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        id: `matter-${i}`,
        title: `Matter ${i}`,
        recordCount: i === 0 ? 2 : 1,
        autoGenerated: true,
        summary: 'Proposed grouping',
        updatedAt: '2026-09-07T00:00:00.000Z',
      })),
    );
    const records = Array.from({ length: 8 }, (_, i) => ({
      id: `record-${i}`,
      title: `Activity ${i}`,
      matterId: i === 7 ? null : `matter-${i % 7}`,
      summary: 'Original evidence '.repeat(40),
      sourceType: 'lda',
      sourceId: `filing-${i}`,
      sourceUrl: `https://example.gov/filing/${i}`,
      evidenceClass: 'inferred',
      confidence: 0.4,
      updatedAt: '2026-09-07T00:00:00.000Z',
    }));
    m.clientAdvocacy.listRecords.mockImplementation(async (_ctx, _clientId, page) => {
      const after = page.afterId ? records.findIndex((r) => r.id === page.afterId) + 1 : 0;
      return {
        items: records.slice(after, after + page.limit),
        total: 8,
        hasMore: after + page.limit < 8,
      };
    });
    const overview = (await m.service.execute(ctx, 'get_client_context', { clientId })) as any;
    expect(overview.profileSections.advocacyMatters.total).toBe(7);
    expect(overview.profileSections.advocacyRecords.total).toBe(8);
    expect(overview.profileSections.submissionHistory.total).toBe(1);
    expect(overview.profile.advocacyRecords[7].matterId).toBeNull();
    expect(overview.profile.advocacyRecords[0]).toMatchObject({
      evidenceClass: 'inferred',
      confidence: 0.4,
    });
    const first = (await m.service.execute(ctx, 'get_client_context', {
      clientId,
      section: 'advocacyRecords',
      limit: 3,
    })) as any;
    expect(first.profile.advocacyRecords[0].summary).toBe(records[0]!.summary);
    expect(first.profileSources.advocacyRecords[0]).toMatchObject({
      recordId: 'record-0',
      sourceUrl: 'https://example.gov/filing/0',
    });
    const remaining = (await m.service.execute(ctx, 'get_client_context', {
      clientId,
      section: 'advocacyRecords',
      cursor: first.profileSections.advocacyRecords.nextCursor,
      limit: 50,
    })) as any;
    expect(remaining.profile.advocacyRecords.map((r: any) => r.id)).toEqual(
      records.slice(3).map((r) => r.id),
    );
    expect(remaining.profileSections.advocacyRecords).toMatchObject({
      total: 8,
      returned: 5,
      nextCursor: null,
    });
    expect(remaining.profileSections.submissionHistory.status).toBe('not_requested');
  });

  it('does not describe an unavailable current advocacy source as an empty history', async () => {
    const m = makeContextMocks();
    m.clientAdvocacy.listRecords.mockRejectedValue(new Error('Read unavailable'));
    const result = (await m.service.execute(ctx, 'get_client_context', { clientId })) as any;
    expect(result.profileSections.advocacyRecords).toMatchObject({
      status: 'unavailable',
      total: null,
    });
    expect(result.profileSections.submissionHistory).toMatchObject({
      status: 'complete',
      total: 0,
    });
  });
});

describe('search_capiro_data canonical dispatch', () => {
  const clientId = '11111111-1111-4111-8111-111111111111';

  it('advertises the callable schema and dispatches through the authorized shared retrieval plane', async () => {
    const coverage = {
      complete: false,
      sources: [{ domain: 'strategies_work', nextCursor: 'next-strategy' }],
    };
    const retrieve = jest.fn().mockResolvedValue({ records: [], coverage });
    const securityEnvelope = jest
      .fn()
      .mockResolvedValue({ authorizedClientIds: [clientId], authorizedMailboxConnectionIds: [] });
    const m = makeMocks({ downstreamRetrieval: { retrieve }, contextPlane: { securityEnvelope } });
    const schema = m.service
      .anthropicToolSchemas()
      .find((tool) => tool.name === 'search_capiro_data');
    expect(schema?.input_schema.required).toEqual(['query', 'domains']);
    const result = (await m.service.executeFromAuthenticatedUser(ctx, 'search_capiro_data', {
      query: 'client strategy',
      domains: ['strategies_work'],
      clientId,
    })) as any;
    expect(securityEnvelope).toHaveBeenCalledWith(ctx);
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientIds: [clientId],
          authorizedClientIds: [clientId],
          authorizedMailboxConnectionIds: [],
        },
      }),
    );
    expect(result.coverage).toBe(coverage);
  });

  it('rejects unauthorized client scopes before invoking any retrieval adapter', async () => {
    const retrieve = jest.fn();
    const m = makeMocks({
      downstreamRetrieval: { retrieve },
      contextPlane: {
        securityEnvelope: jest
          .fn()
          .mockResolvedValue({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }),
      },
    });
    await expect(
      m.service.executeFromAuthenticatedUser(ctx, 'search_capiro_data', {
        query: 'strategy',
        domains: ['strategies_work'],
        clientId,
      }),
    ).rejects.toThrow('Client not found');
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('reports missing runtime wiring as unavailable, never as an empty successful search', async () => {
    const m = makeMocks();
    await expect(
      m.service.executeFromAuthenticatedUser(ctx, 'search_capiro_data', {
        query: 'strategy',
        domains: ['strategies_work'],
      }),
    ).rejects.toThrow('Shared retrieval is unavailable');
  });
});

describe('get_research_evidence canonical dispatch', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const clientId = '22222222-2222-4222-8222-222222222222';

  it('advertises and executes the server-owned research evidence read', async () => {
    const m = makeMocks();
    const findSession = jest.fn().mockResolvedValue({
      id: sessionId,
      clientId,
      metadata: {
        handoff: {
          version: 1,
          clientId,
          conversationId: null,
          capturedAt: '2026-09-06T00:00:00Z',
          attachments: [],
        },
      },
    });
    Object.assign(m.tx, { clioResearchSession: { findFirst: findSession } });
    m.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: true }]);
    const schema = m.service
      .anthropicToolSchemas()
      .find((tool) => tool.name === 'get_research_evidence');
    expect(schema?.input_schema.required).toEqual(['sessionId']);
    const result = (await m.service.executeFromAuthenticatedUser(ctx, 'get_research_evidence', {
      sessionId,
      clientId,
    })) as any;
    expect(findSession).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId },
      }),
    );
    expect(result).toMatchObject({
      tool: 'get_research_evidence',
      coverage: { total: 0, complete: true },
      records: [],
    });
  });
});

describe('search_memory canonical recall dispatch', () => {
  const clientId = '11111111-1111-4111-8111-111111111111';
  const fullBody = 'Client approved funding constraint. '.repeat(1000);
  const record = {
    domain: 'institutional_knowledge',
    recordId: '22222222-2222-4222-8222-222222222222',
    payload: {
      memoryItemId: '22222222-2222-4222-8222-222222222222',
      title: 'Funding constraint',
      value: fullBody,
      sections: [{ key: 'constraint', heading: 'Constraint', body: fullBody }],
      governance: { status: 'active', approvedByUserId: 'reviewer-1' },
    },
    provenance: {
      source: 'memory_items',
      recordId: '22222222-2222-4222-8222-222222222222',
      contentHash: 'source-hash',
    },
  };

  it('returns approved fact bodies, source references and coverage from the same shared recall plane', async () => {
    const coverage = {
      complete: false,
      sources: [
        { domain: 'institutional_knowledge', sourceStatus: 'degraded', nextCursor: 'memory:8' },
      ],
    };
    const retrieve = jest.fn().mockResolvedValue({ records: [record], coverage });
    const securityEnvelope = jest
      .fn()
      .mockResolvedValue({ authorizedClientIds: [clientId], authorizedMailboxConnectionIds: [] });
    const m = makeMocks({ downstreamRetrieval: { retrieve }, contextPlane: { securityEnvelope } });
    const result = (await m.service.executeFromAuthenticatedUser(ctx, 'search_memory', {
      query: 'What do you remember about this client?',
      clientId,
      cursor: 'memory:3',
      k: 5,
    })) as any;
    expect(securityEnvelope).toHaveBeenCalledWith(ctx);
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        queryClass: 'semantic_recall',
        requestedDomains: ['institutional_knowledge'],
        pageSize: 3,
        cursors: { institutional_knowledge: 'memory:3' },
        caller: expect.objectContaining({ clientIds: [clientId], authorizedClientIds: [clientId] }),
      }),
    );
    expect(result.coverage).toBe(coverage);
    expect(result.nextCursor).toBe('memory:8');
    expect(result.records[0].payload.value).toBe(fullBody.slice(0, 500));
    expect(result.records[0].payload.content).toMatchObject({
      totalCharacters: fullBody.length,
      truncated: true,
    });
    expect(result.records[0].provenance.contentHash).toBe('source-hash');
    expect(result.results[0]).toMatchObject({
      memoryItemId: '22222222-2222-4222-8222-222222222222',
    });
    expect(result.results[0]).not.toHaveProperty('value');
    const schema = m.service.anthropicToolSchemas().find((tool) => tool.name === 'search_memory')!;
    expect(schema.input_schema.properties).toHaveProperty('cursor');
    expect(schema.input_schema.properties).toHaveProperty('clientId');
  });

  it('the source panel reads exact canonical memory and preserves metadata-only disclosure', async () => {
    const legacy = {
      ...record,
      payload: {
        ...record.payload,
        contentStatus: 'metadata_only',
        contentLimitation: 'The original source must be reviewed.',
        value: '{"summary":"crm_finding_accepted on crm.fill_with_meri"}',
      },
    };
    const retrieve = jest.fn().mockResolvedValue({
      records: [legacy],
      coverage: {
        complete: true,
        sources: [{ domain: 'institutional_knowledge', sourceStatus: 'healthy' }],
      },
    });
    const m = makeMocks({
      downstreamRetrieval: { retrieve },
      contextPlane: {
        securityEnvelope: jest.fn().mockResolvedValue({
          authorizedClientIds: [clientId],
          authorizedMailboxConnectionIds: [],
        }),
      },
    });
    const result = (await m.service.readGovernedMemorySource(ctx, {
      memoryItemId: record.recordId,
      clientId,
    })) as any;
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ queryClass: 'lookup', memoryItemId: record.recordId, pageSize: 1 }),
    );
    expect(result.contentStatus).toBe('metadata_only');
    expect(result.factContentUnavailableCount).toBe(1);
    expect(result.records[0].payload.contentLimitation).toBe(
      'The original source must be reviewed.',
    );
    expect(result.governanceCoverage.excluded).toContain('Pending proposals');
  });

  it('rejects invalid exact memory IDs before dispatching the source-panel read', async () => {
    const retrieve = jest.fn();
    const m = makeMocks({ downstreamRetrieval: { retrieve } });
    await expect(
      m.service.readGovernedMemorySource(ctx, { memoryItemId: 'not-a-uuid' }),
    ).rejects.toThrow('exact canonical memory UUID');
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('rejects a client that is no longer in the current authorization envelope', async () => {
    const retrieve = jest.fn();
    const m = makeMocks({
      downstreamRetrieval: { retrieve },
      contextPlane: {
        securityEnvelope: jest
          .fn()
          .mockResolvedValue({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }),
      },
    });
    await expect(
      m.service.executeFromAuthenticatedUser(ctx, 'search_memory', { query: 'funding', clientId }),
    ).rejects.toThrow('Client not found');
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('does not turn unavailable canonical recall into a successful empty result', async () => {
    const m = makeMocks();
    await expect(
      m.service.executeFromAuthenticatedUser(ctx, 'search_memory', { query: 'funding' }),
    ).rejects.toThrow('Shared retrieval is unavailable');
  });
  it('reads a long fact completely through targeted pages and withholds it after revocation', async () => {
    let eligible = true;
    const coverage = {
      complete: true,
      sources: [{ domain: 'institutional_knowledge', sourceStatus: 'healthy' }],
    };
    const retrieve = jest.fn(async () => ({ records: eligible ? [record] : [], coverage }));
    const securityEnvelope = jest
      .fn()
      .mockResolvedValue({ authorizedClientIds: [clientId], authorizedMailboxConnectionIds: [] });
    const m = makeMocks({ downstreamRetrieval: { retrieve }, contextPlane: { securityEnvelope } });
    let args: Record<string, unknown> = {
      query: 'Read approved funding constraint',
      memoryItemId: record.recordId,
      clientId,
    };
    let recovered = '';
    let pages = 0;
    let continuation: Record<string, unknown> | null = null;
    do {
      const page = (await m.service.executeFromAuthenticatedUser(
        ctx,
        'search_memory',
        args,
      )) as any;
      const prompt = wrapToolResultForPrompt('search_memory', page, 12000);
      expect(prompt).not.toContain('[truncated tool result]');
      recovered += page.records[0].payload.value;
      pages += 1;
      continuation = page.records[0].payload.content.nextRead;
      if (!continuation) break;
      args = continuation;
      expect(pages).toBeLessThan(30);
    } while (true);
    expect(recovered).toBe(fullBody);
    expect(pages).toBeGreaterThan(2);
    expect(retrieve).toHaveBeenLastCalledWith(
      expect.objectContaining({ memoryItemId: record.recordId, queryClass: 'lookup', pageSize: 1 }),
    );
    expect(securityEnvelope).toHaveBeenCalledTimes(pages);
    eligible = false;
    const revoked = (await m.service.executeFromAuthenticatedUser(
      ctx,
      'search_memory',
      args,
    )) as any;
    expect(revoked.records).toEqual([]);
    expect(revoked.contentStatus).toBe('unavailable_or_ineligible');
  });

  it('re-reads the same source cursor with a smaller page when provenance needs more room', async () => {
    const heavy = {
      ...record,
      payload: {
        ...record.payload,
        title: 'T'.repeat(160),
        governance: {
          memoryClass: 'client_steering',
          authority: 'client_approved',
          status: 'active',
          conflictStatus: null,
          controllingItemId: null,
          approvedByUserId: record.recordId,
          approvedAt: '2026-08-20T00:00:00Z',
          asOf: '2026-08-20T00:00:00Z',
          effectiveFrom: '2026-08-20T00:00:00Z',
          validUntil: null,
          expiresAt: null,
          lastConfirmedAt: '2026-08-20T00:00:00Z',
          reviewDueAt: null,
          stale: false,
          instructionsAllowed: false,
        },
      },
      provenance: {
        ...record.provenance,
        sourceId: 's'.repeat(200),
        sourceRef: 'r'.repeat(600),
        sourceVersion: 'v'.repeat(200),
      },
    };
    const retrieve = jest.fn(async (request: { pageSize: number }) => ({
      records: Array.from({ length: request.pageSize }, () => heavy),
      coverage: {
        complete: false,
        sources: [
          { domain: 'institutional_knowledge', nextCursor: `memory:${3 + request.pageSize}` },
        ],
      },
    }));
    const m = makeMocks({
      downstreamRetrieval: { retrieve },
      contextPlane: {
        securityEnvelope: jest.fn().mockResolvedValue({
          authorizedClientIds: [clientId],
          authorizedMailboxConnectionIds: [],
        }),
      },
    });
    const page = (await m.service.executeFromAuthenticatedUser(ctx, 'search_memory', {
      query: 'funding',
      clientId,
      cursor: 'memory:3',
    })) as any;
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageSize: 1, cursors: { institutional_knowledge: 'memory:3' } }),
    );
    expect(page.effectivePageSize).toBe(1);
    expect(page.nextCursor).toBe('memory:4');
    expect(wrapToolResultForPrompt('search_memory', page, 12000)).not.toContain(
      '[truncated tool result]',
    );
  });
});

describe('read_client_documents canonical evidence reads', () => {
  it('binds each section read to the selected client and exposes continuation before evidence', async () => {
    const m = makeMocks();
    m.engagement.extractAttachmentText.mockResolvedValue({
      attachmentId: 'doc-1',
      fileName: 'Evidence.pdf',
      contentType: 'application/pdf',
      contentHash: 'a'.repeat(64),
      text: 'Evidence '.repeat(2000),
      source: 'pdf',
      section: 2,
      sectionCount: 5,
      sectionKind: 'page',
      sectionLabel: 'Page 2',
      disclosure: 'Unscanned source',
      extractionMetadata: { truncated: false },
    });
    const result = (await m.service.execute(ctx, 'read_client_documents', {
      clientId: 'client-1',
      documentId: 'doc-1',
      section: 2,
    })) as any;
    expect(m.engagement.extractAttachmentText).toHaveBeenCalledWith(ctx, 'doc-1', {
      clientId: 'client-1',
      section: 2,
    });
    expect(result.coverage).toMatchObject({
      section: 2,
      sectionCount: 5,
      complete: false,
      disclosure: 'Unscanned source',
    });
    expect(result.coverage.nextCursor).toBeTruthy();
    expect(result.records[0].provenance).toMatchObject({
      sourceRecordId: 'doc-1',
      clientId: 'client-1',
      section: 2,
    });
  });

  it('propagates an ACL or readiness failure instead of returning a successful empty document', async () => {
    const m = makeMocks();
    m.engagement.extractAttachmentText.mockRejectedValue(new Error('Attachment not found'));
    await expect(
      m.service.execute(ctx, 'read_client_documents', {
        clientId: 'client-1',
        documentId: 'restricted',
      }),
    ).rejects.toThrow('Attachment not found');
  });

  it('pages file listings and retains readiness/disclosure metadata', async () => {
    const m = makeMocks();
    m.engagement.listAttachments.mockResolvedValue([
      {
        id: 'doc-a',
        fileName: 'A.txt',
        usable: false,
        blockedReason: 'ATTACHMENT_SCAN_PENDING',
        scanDisclosure: 'Scan pending',
      },
      { id: 'doc-b', fileName: 'B.txt', usable: true },
    ]);
    const result = (await m.service.execute(ctx, 'read_client_documents', {
      clientId: 'client-1',
      limit: 1,
    })) as any;
    expect(result.coverage).toMatchObject({
      total: 2,
      returned: 1,
      nextCursor: 'documents:doc-a',
      truncated: true,
    });
    expect(result.documents[0]).toMatchObject({
      usable: false,
      blockedReason: 'ATTACHMENT_SCAN_PENDING',
      disclosure: 'Scan pending',
    });
    const next = (await m.service.execute(ctx, 'read_client_documents', {
      clientId: 'client-1',
      limit: 1,
      cursor: result.coverage.nextCursor,
    })) as any;
    expect(next.documents[0].id).toBe('doc-b');
  });
});

describe('search_committee_hearings canonical transcript reads', () => {
  it('preserves the exact record view, historical cutoff and current client envelope through the governed handler', async () => {
    const retrieve = jest
      .fn()
      .mockResolvedValue({ coverage: { complete: false, sources: [] }, records: [] });
    const securityEnvelope = jest
      .fn()
      .mockResolvedValue({ authorizedClientIds: ['client-1'], authorizedMailboxConnectionIds: [] });
    const m = makeMocks({ downstreamRetrieval: { retrieve }, contextPlane: { securityEnvelope } });
    await m.service.execute(ctx, 'search_committee_hearings', {
      hearingId: 'fl-event',
      clientId: 'client-1',
      recordsView: 'briefs',
      recordId: 'approved-brief',
      asOf: '2026-09-03T12:00:00Z',
      cursor: 'exact-continuation',
    });
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        asOf: new Date('2026-09-03T12:00:00Z'),
        hearingFilters: expect.objectContaining({
          hearingId: 'fl-event',
          recordsView: 'briefs',
          recordId: 'approved-brief',
        }),
        cursors: { hearings: 'exact-continuation' },
        caller: expect.objectContaining({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientIds: ['client-1'],
          authorizedClientIds: ['client-1'],
        }),
      }),
    );
    await expect(
      m.service.execute(ctx, 'search_committee_hearings', { recordsView: 'guessed-unscoped-view' }),
    ).rejects.toThrow('Invalid published-record view');
    await expect(
      m.service.execute(ctx, 'search_committee_hearings', {
        recordsView: 'briefs',
        asOf: 'invalid-date',
      }),
    ).rejects.toThrow('Valid historical record timestamp required');
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
  it('calls the shared hearing reader with current security and exact hearing filters', async () => {
    const records = [
      {
        recordId: 'official:source:0000000002',
        payload: { text: 'Late transcript evidence' },
        provenance: { sourceRecordId: 'source' },
      },
    ];
    const coverage = {
      complete: false,
      sources: [{ domain: 'hearings', nextCursor: 'official:source:0000000002' }],
    };
    const retrieve = jest.fn().mockResolvedValue({ coverage, records });
    const securityEnvelope = jest
      .fn()
      .mockResolvedValue({ authorizedClientIds: ['client-1'], authorizedMailboxConnectionIds: [] });
    const m = makeMocks({ downstreamRetrieval: { retrieve }, contextPlane: { securityEnvelope } });
    const result = (await m.service.execute(ctx, 'search_committee_hearings', {
      hearingId: 'hearing-1',
      clientId: 'client-1',
      chamber: 'House',
      committeeName: 'Appropriations',
      cursor: 'official:source:0000000001',
    })) as any;
    expect(securityEnvelope).toHaveBeenCalledWith(ctx);
    expect(m.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'meri.chat',
        resolverRequest: expect.objectContaining({
          subjectScope: 'client',
          clientId: 'client-1',
          retrieval: expect.objectContaining({ query: null }),
        }),
      }),
    );
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        query: undefined,
        requestedDomains: ['hearings'],
        pageSize: 1,
        hearingFilters: {
          hearingId: 'hearing-1',
          chamber: 'House',
          committeeName: 'Appropriations',
        },
        cursors: { hearings: 'official:source:0000000001' },
        caller: expect.objectContaining({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientIds: ['client-1'],
          authorizedClientIds: ['client-1'],
        }),
      }),
    );
    expect(result.records).toEqual(records);
    expect(result.coverage).toBe(coverage);
  });
});

describe('document ethical-wall enforcement', () => {
  it.each([{}, { documentId: 'doc-1' }])(
    'denies wall-restricted listing/read before any evidence is loaded: %j',
    async (selection) => {
      const m = makeMocks();
      m.tx.$queryRawUnsafe.mockResolvedValue([{ id: 'client-1' }]);
      await expect(
        m.service.execute(ctx, 'read_client_documents', { clientId: 'client-1', ...selection }),
      ).rejects.toThrow('Client not found');
      expect(m.engagement.extractAttachmentText).not.toHaveBeenCalled();
      expect(m.engagement.listAttachments).not.toHaveBeenCalled();
    },
  );

  it('rechecks a wall revocation before honoring a continuation cursor', async () => {
    const m = makeMocks();
    m.engagement.extractAttachmentText.mockResolvedValue({
      attachmentId: 'doc-1',
      fileName: 'Evidence.txt',
      contentType: 'text/plain',
      contentHash: 'a'.repeat(64),
      text: 'Evidence '.repeat(2000),
      source: 'text',
      section: 1,
      sectionCount: 1,
    });
    const first = (await m.service.execute(ctx, 'read_client_documents', {
      clientId: 'client-1',
      documentId: 'doc-1',
    })) as any;
    expect(first.coverage.nextCursor).toBeTruthy();
    m.tx.$queryRawUnsafe.mockResolvedValue([{ id: 'client-1' }]);
    await expect(
      m.service.execute(ctx, 'read_client_documents', {
        clientId: 'client-1',
        documentId: 'doc-1',
        cursor: first.coverage.nextCursor,
      }),
    ).rejects.toThrow('Client not found');
    expect(m.engagement.extractAttachmentText).toHaveBeenCalledTimes(1);
  });
});
