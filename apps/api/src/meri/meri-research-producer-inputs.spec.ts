import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import {
  assertResearchProducerInputsCurrent,
  classifyResearchProducerInputs,
  contentFreeToolFailure,
  joinResearchProducerInputs,
  pinResearchProducerInputs,
  researchProducerInputCoverableTool,
  ResearchProducerInputNotCurrent,
  type ResearchProducerInputDraftV1,
} from './meri-research-producer-inputs';
import type { MeriResearchHandoff } from './meri-research-handoff';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const PACKET = '44444444-4444-4444-8444-444444444444';
const FIRM_MEMORY = '55555555-5555-4555-8555-555555555555';
const CLIENT_MEMORY = '66666666-6666-4666-8666-666666666666';
const RECALL_MEMORY = '77777777-7777-4777-8777-777777777777';
const CONTACT = '88888888-8888-4888-8888-888888888888';
const STRATEGY = '99999999-9999-4999-8999-999999999999';
const ATTACHMENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MESSAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONVERSATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_CONVERSATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER_MEMORY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const OBSERVED = new Date('2026-10-05T10:00:00.000Z');
const COMPILED = new Date('2026-10-05T11:00:00.000Z');
const CTX = { tenantId: TENANT, userId: USER } as TenantContext;
const SCOPE = { sessionClientId: CLIENT, conversationId: CONVERSATION };
const PROMPT = '<capiro_context_plane>governed prompt</capiro_context_plane>';

function governedContext(): MeriGovernedTurnContext {
  return {
    version: 1,
    operationId: 'research.generate-report',
    prompt: PROMPT,
    contextPacket: {
      packetId: PACKET,
      items: [
        { id: FIRM_MEMORY, label: 'Firm', type: 'firm-soul', scope: 'firm', authority: 'authoritative', selection: 'automatic' },
        { id: CLIENT_MEMORY, label: 'Client', type: 'client-soul', scope: 'client', authority: 'authoritative', selection: 'automatic' },
        { id: USER_MEMORY, label: 'Voice', type: 'user-voice', scope: 'personal', authority: 'authoritative', selection: 'automatic' },
      ],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
    evidence: {
      version: 1,
      tenantId: TENANT,
      userId: USER,
      packetId: PACKET,
      sourceRecordCount: 5,
      projectedRecordCount: 5,
      truncated: false,
      records: [
        evidenceRecord('institutional_knowledge', `steering:${FIRM_MEMORY}`, { memoryItemId: FIRM_MEMORY }),
        evidenceRecord('clients', CLIENT, { recordUpdatedAt: OBSERVED.toISOString() }),
        evidenceRecord('contacts', CONTACT, { recordUpdatedAt: OBSERVED.toISOString() }),
        evidenceRecord('strategies_work', `strategy:${STRATEGY}`, { recordUpdatedAt: OBSERVED.toISOString() }),
        evidenceRecord('institutional_knowledge', RECALL_MEMORY, { recordUpdatedAt: OBSERVED.toISOString() }),
      ],
    },
  } as unknown as MeriGovernedTurnContext;
}

function evidenceRecord(domain: string, recordId: string, provenance: Record<string, unknown>) {
  return {
    domain,
    recordId,
    sourceRecordId: recordId,
    payload: { title: 'private body' },
    provenance,
    projection: { truncated: false, originalCharacters: 12, returnedCharacters: 12 },
  };
}

function handoff(overrides: Partial<MeriResearchHandoff> = {}): MeriResearchHandoff {
  return {
    version: 1,
    capturedAt: OBSERVED.toISOString(),
    conversationId: CONVERSATION,
    clientId: CLIENT,
    reasoningMode: 'deep',
    requestedDeliverable: 'Brief',
    summary: null,
    summaryUpToMessageId: null,
    messages: [],
    attachments: [],
    ...overrides,
  };
}

function attachmentSnapshot(text: string) {
  return {
    id: ATTACHMENT,
    sourceMessageId: MESSAGE,
    filename: 'brief.txt',
    kind: 'text',
    status: 'parsed',
    reason: null,
    textContent: text,
    mediaType: 'text/plain',
    byteSize: text.length,
    contentSha256: createHash('sha256').update(text).digest('hex'),
    source: `clio_attachment:${ATTACHMENT}`,
  };
}

function classify(overrides: Partial<Parameters<typeof classifyResearchProducerInputs>[0]> = {}) {
  return classifyResearchProducerInputs({
    hashMaterial: { run: 1 },
    durableTools: ['search_memory'],
    clientContext: PROMPT,
    governedContext: governedContext(),
    handoff: handoff(),
    inherited: { citations: 0, unavailable: 0, omitted: 0 },
    ledgerEntries: [
      { tool: 'context_plane', serialized: '', result: { origin: 'initial_context' } },
      { tool: 'search_memory', serialized: '', result: {}, durableSafeRead: { tool: 'search_memory' } },
      { tool: 'get_pe_budget_timeline', serialized: '', result: { rows: [{ fy: 2027 }] } },
      { tool: 'search_congress_bills', serialized: '', result: { error: 'Upstream unavailable' } },
    ],
    ...overrides,
  });
}

describe('research producer input classification', () => {
  it('covers a fresh client-scoped run input by input, without the per-compile prompt hash', () => {
    const result = classify();

    expect(result.producerInputMode).toBe('governed_inputs');
    expect(result.clientContextSha256).toBeNull();
    expect(result.producerInputCategories.unsupported).toEqual({});
    expect(result.producerInputDraft).toEqual({
      version: 1,
      packet: { packetId: PACKET, memoryItemIds: [FIRM_MEMORY, CLIENT_MEMORY, USER_MEMORY].sort() },
      records: [
        { domain: 'clients', id: CLIENT, observedUpdatedAt: OBSERVED.toISOString() },
        { domain: 'contacts', id: CONTACT, observedUpdatedAt: OBSERVED.toISOString() },
        { domain: 'institutional_knowledge', id: RECALL_MEMORY, observedUpdatedAt: OBSERVED.toISOString() },
        { domain: 'strategies_work', id: `strategy:${STRATEGY}`, observedUpdatedAt: OBSERVED.toISOString() },
      ],
      attachments: [],
      publicToolResults: ['get_pe_budget_timeline'],
      failedToolResults: 1,
    });
  });

  it('keeps every input class without an adapter fail-closed and names only categories', () => {
    const context = governedContext();
    context.contextPacket.packetId = null;
    context.evidence!.records.push(
      evidenceRecord('mail', 'mail-1', { recordUpdatedAt: OBSERVED.toISOString() }) as never,
    );
    const result = classify({
      governedContext: context,
      handoff: handoff({
        summary: 'earlier summary',
        messages: [
          { id: 'm1', role: 'user', body: 'q', createdAt: OBSERVED.toISOString(), metadata: {} },
          { id: 'm2', role: 'assistant', body: 'a', createdAt: OBSERVED.toISOString(), metadata: {} },
        ],
      }),
      inherited: { citations: 2, unavailable: 1, omitted: 0 },
      ledgerEntries: [
        { tool: 'get_client_context', serialized: '', result: { client: { name: 'x' } } },
        { tool: 'get_client_context', serialized: '', result: {}, durableSafeRead: { tool: 'get_client_context' } },
        { tool: 'search_committee_hearings', serialized: '', result: { hearings: [] } },
      ],
    });

    expect(result.producerInputMode).toBe('unsupported_private_inputs');
    expect(result.producerInputDraft).toBeNull();
    expect(result.producerInputCategories.unsupported).toEqual({
      handoff_summary: 1,
      assistant_handoff_turns: 1,
      inherited_citations: 2,
      inherited_unavailable: 1,
      context_packet_unpersisted: 3,
      steering_outside_packet: 1,
      'context_record:mail': 1,
      'unreceipted_tool:get_client_context': 1,
      'receipted_unowned_tool:get_client_context': 1,
      'unreceipted_tool:search_committee_hearings': 1,
    });
    expect(JSON.stringify(result.producerInputCategories)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('pins handoff attachments by their snapshot digest', () => {
    const result = classify({ handoff: handoff({ attachments: [attachmentSnapshot('brief text')] }) });
    expect(result.producerInputMode).toBe('governed_inputs');
    expect(result.producerInputDraft?.attachments).toEqual([
      {
        id: ATTACHMENT,
        sourceMessageId: MESSAGE,
        contentSha256: createHash('sha256').update('brief text').digest('hex'),
      },
    ]);
  });

  it('admits to research only tools whose results are receipted or public', () => {
    for (const tool of ['search_memory', 'read_client_meetings', 'scrape_web_page', 'get_pe_budget_timeline']) {
      expect(researchProducerInputCoverableTool(tool)).toBe(true);
    }
    for (const tool of ['search_research_sources', 'get_client_context', 'search_client_knowledge', 'search_capiro_data', 'get_representation', 'send_email']) {
      expect(researchProducerInputCoverableTool(tool)).toBe(false);
    }
  });

  it('treats only content-free failures as carrying no source content', () => {
    expect(contentFreeToolFailure({ error: 'Not found', message: 'No bill' })).toBe(true);
    expect(contentFreeToolFailure({ blocked: true, message: 'Policy' })).toBe(true);
    expect(contentFreeToolFailure({ error: 'partial', records: [{ id: 1 }] })).toBe(false);
    expect(contentFreeToolFailure({ rows: [] })).toBe(false);
  });

  it('keeps the whole-context hash for an ungoverned client context', () => {
    const result = classify({
      clientContext: 'Client: Example',
      governedContext: { ...governedContext(), contextPacket: { items: [], exclusions: [], unauthorizedCount: 0, degraded: false }, evidence: undefined } as MeriGovernedTurnContext,
      ledgerEntries: [],
    });
    expect(result.producerInputMode).toBe('covered_inputs');
    expect(result.clientContextSha256).toBe(
      createHash('sha256').update('Client: Example').digest('hex'),
    );
  });

  it('joins admitted child inputs into the parent and escalates to the strongest mode', () => {
    const parent = classify();
    const child = classify({
      clientContext: null,
      ledgerEntries: [{ tool: 'search_public_web', serialized: '', result: { results: [] } }],
    });
    const joined = joinResearchProducerInputs(parent, [child]);
    expect(joined.producerInputMode).toBe('governed_inputs');
    expect(joined.producerInputDraft?.publicToolResults).toEqual([
      'get_pe_budget_timeline',
      'search_public_web',
    ]);
    expect(joined.producerInputSha256).not.toBe(parent.producerInputSha256);

    const refused = classify({
      ledgerEntries: [{ tool: 'get_representation', serialized: '', result: { facilities: [] } }],
    });
    expect(joinResearchProducerInputs(parent, [refused]).producerInputMode).toBe(
      'unsupported_private_inputs',
    );

    const otherPacket = classify();
    otherPacket.producerInputDraft!.packet!.packetId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const mismatch = joinResearchProducerInputs(parent, [otherPacket]);
    expect(mismatch.producerInputMode).toBe('unsupported_private_inputs');
    expect(mismatch.producerInputCategories?.unsupported).toMatchObject({ context_packet_mismatch: 1 });
  });
});

type SteeringFixture = Record<string, unknown> & { id: string };

function steeringRow(overrides: Partial<SteeringFixture> & { id: string }): SteeringFixture {
  return {
    type: 'firm-soul',
    slug: 'firm',
    title: 'Firm soul',
    clientId: null,
    status: 'active',
    expiresAt: null,
    updatedAt: OBSERVED,
    confirmedAt: null,
    authority: 'human',
    sections: [{ heading: 'Soul', body: 'How the firm works', owner: 'human' }],
    visibility: 'tenant',
    ownerUserId: null,
    memoryClass: 'institutional_authoritative',
    governedAuthority: 'authoritative',
    legacyStatus: 'active',
    governedStatus: 'active',
    sourceType: 'manual',
    sourceId: null,
    sourceRef: 'firm-handbook',
    approvedByUserId: USER,
    approvedAt: OBSERVED,
    conflictStatus: 'none',
    sensitivity: 'normal',
    ...overrides,
  };
}

function recallRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECALL_MEMORY,
    tenantId: TENANT,
    clientId: null,
    ownerUserId: null,
    visibility: 'tenant',
    legacyStatus: 'active',
    updatedAt: OBSERVED,
    sections: [{ heading: 'Fact', body: 'An approved fact' }],
    memoryClass: 'institutional_authoritative',
    authority: 'authoritative',
    scope: 'firm',
    status: 'active',
    conflictStatus: 'none',
    controllingItemId: null,
    sensitivity: 'normal',
    sourceType: 'manual',
    sourceId: null,
    sourceRef: 'note',
    approvedByUserId: USER,
    approvedAt: OBSERVED,
    eligible: true,
    ...overrides,
  };
}

interface FakeState {
  walls: Map<string, boolean>;
  steering: Map<string, SteeringFixture>;
  recall: Map<string, ReturnType<typeof recallRow>>;
  clients: Map<string, { updatedAt: Date; status: string }>;
  contacts: Map<string, { clientId: string | null; updatedAt: Date }>;
  strategies: Map<string, { clientIds: Array<string | null>; updatedAt: Date; version: unknown }>;
  attachments: Map<string, { kind: string; textContent: string | null; data: Buffer | null; messageId: string | null }>;
  messages: Map<string, { conversationId: string }>;
  packet: { id: string; items: Array<{ id: string }>; createdAt: Date; userId: string | null; clientId: string | null } | null;
}

function freshState(): FakeState {
  return {
    walls: new Map([[CLIENT, true]]),
    steering: new Map([
      [FIRM_MEMORY, steeringRow({ id: FIRM_MEMORY })],
      [
        CLIENT_MEMORY,
        steeringRow({
          id: CLIENT_MEMORY,
          type: 'client-soul',
          slug: 'client-soul',
          clientId: CLIENT,
          memoryClass: 'client_steering',
        }),
      ],
      [
        USER_MEMORY,
        steeringRow({
          id: USER_MEMORY,
          type: 'user-voice',
          slug: 'user-voice',
          visibility: 'user',
          ownerUserId: USER,
          memoryClass: 'user_preference',
        }),
      ],
    ]),
    recall: new Map([[RECALL_MEMORY, recallRow()]]),
    clients: new Map([[CLIENT, { updatedAt: OBSERVED, status: 'active' }]]),
    contacts: new Map([[CONTACT, { clientId: CLIENT, updatedAt: OBSERVED }]]),
    strategies: new Map([
      [STRATEGY, { clientIds: [CLIENT], updatedAt: OBSERVED, version: { count: 2, updatedAt: OBSERVED.toISOString() } }],
    ]),
    attachments: new Map([
      [ATTACHMENT, { kind: 'text', textContent: 'brief text', data: null, messageId: MESSAGE }],
    ]),
    messages: new Map([[MESSAGE, { conversationId: CONVERSATION }]]),
    packet: {
      id: PACKET,
      items: [{ id: FIRM_MEMORY }, { id: CLIENT_MEMORY }, { id: USER_MEMORY }],
      createdAt: COMPILED,
      userId: USER,
      clientId: CLIENT,
    },
  };
}

function idIn(values: unknown[], ids: Iterable<string>): string | undefined {
  const known = new Set(ids);
  return values.find((value): value is string => typeof value === 'string' && known.has(value));
}

function fakeTx(state: FakeState, options: { ignoreUserScope?: boolean } = {}): Prisma.TransactionClient {
  // memory_items forces owner-aware RLS: a visibility='user' row is visible
  // only after app.current_user names its owner.
  let currentUser: string | null = null;
  const visible = (row: Record<string, unknown>) =>
    row.visibility !== 'user' || row.ownerUserId === currentUser;
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!options.ignoreUserScope && strings.join('?').includes('app.current_user'))
        currentUser = String(values[0]);
      return 1;
    },
    $queryRaw: async (query: Prisma.Sql) => {
      const text = query.sql;
      const values = query.values as unknown[];
      if (text.includes('last_confirmed_at AS "confirmedAt"')) {
        const ids = values.find(Array.isArray) as string[];
        return ids.flatMap((id) => {
          const row = state.steering.get(id);
          return row && visible(row) ? [row] : [];
        });
      }
      if (text.includes('SELECT client_id::text AS "clientId" FROM memory_items')) {
        const id = idIn(values, state.recall.keys());
        return id ? [{ clientId: state.recall.get(id)!.clientId }] : [];
      }
      if (text.includes('FROM memory_items mi')) {
        const id = idIn(values, state.recall.keys());
        const row = id ? state.recall.get(id) : undefined;
        return row?.eligible ? [row] : [];
      }
      if (text.includes('FROM sp_strategy s')) {
        const id = idIn(values, state.strategies.keys());
        return id ? [state.strategies.get(id)] : [];
      }
      return [];
    },
    $queryRawUnsafe: async (_sql: string, _tenantId: string, clientId: string) => [
      { allowed: state.walls.get(clientId) === true },
    ],
    client: {
      findFirst: async ({ where }: { where: { id: string } }) => state.clients.get(where.id) ?? null,
    },
    engagementContact: {
      findFirst: async ({ where }: { where: { id: string } }) => state.contacts.get(where.id) ?? null,
    },
    clioAttachment: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        state.attachments.get(where.id) ?? null,
    },
    clioMessage: {
      findFirst: async ({ where }: { where: { id: string; conversationId: string } }) =>
        state.messages.get(where.id)?.conversationId === where.conversationId
          ? { id: where.id }
          : null,
    },
    contextPacket: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        state.packet?.id === where.id ? state.packet : null,
    },
  };
  return tx as unknown as Prisma.TransactionClient;
}

function draft(): ResearchProducerInputDraftV1 {
  return classify({ handoff: handoff({ attachments: [attachmentSnapshot('brief text')] }) })
    .producerInputDraft!;
}

async function pinned() {
  return pinResearchProducerInputs(fakeTx(freshState()), CTX, SCOPE, draft());
}

async function readFails(mutate: (state: FakeState) => void) {
  const manifest = await pinned();
  const state = freshState();
  mutate(state);
  return assertResearchProducerInputsCurrent(fakeTx(state), CTX, SCOPE, manifest);
}

describe('governed producer input re-check', () => {
  it('pins every governed input and releases an unchanged read', async () => {
    const manifest = await pinned();
    expect(manifest.packet?.items.map((item) => item.memoryItemId)).toEqual(
      [FIRM_MEMORY, CLIENT_MEMORY, USER_MEMORY].sort(),
    );
    expect(manifest.records).toHaveLength(4);
    expect(manifest.attachments).toHaveLength(1);
    await expect(
      assertResearchProducerInputsCurrent(fakeTx(freshState()), CTX, SCOPE, manifest),
    ).resolves.toBeUndefined();
  });

  it.each<[string, (state: FakeState) => void]>([
    ['packet item revoked', (s) => (s.steering.get(FIRM_MEMORY)!.governedStatus = 'revoked')],
    ['packet item changed', (s) => (s.steering.get(FIRM_MEMORY)!.sections = [{ heading: 'Soul', body: 'edited' }])],
    ['packet item missing', (s) => s.steering.delete(FIRM_MEMORY)],
    ['client steering behind a new wall', (s) => s.walls.set(CLIENT, false)],
    ['client record changed', (s) => s.clients.set(CLIENT, { updatedAt: COMPILED, status: 'active' })],
    ['client record missing', (s) => s.clients.delete(CLIENT)],
    ['contact changed', (s) => s.contacts.set(CONTACT, { clientId: CLIENT, updatedAt: COMPILED })],
    ['contact missing', (s) => s.contacts.delete(CONTACT)],
    ['recalled memory revoked', (s) => (s.recall.get(RECALL_MEMORY)!.eligible = false)],
    ['recalled memory changed', (s) => (s.recall.get(RECALL_MEMORY)!.sections = [{ heading: 'Fact', body: 'edited' }])],
    ['recalled memory missing', (s) => s.recall.delete(RECALL_MEMORY)],
    ['strategy archived or missing', (s) => s.strategies.delete(STRATEGY)],
    ['strategy node changed', (s) => (s.strategies.get(STRATEGY)!.version = { count: 3, updatedAt: COMPILED.toISOString() })],
    ['strategy client archived', (s) => s.clients.set(CLIENT, { updatedAt: OBSERVED, status: 'archived' })],
    ['attachment changed', (s) => (s.attachments.get(ATTACHMENT)!.textContent = 'edited')],
    ['attachment missing', (s) => s.attachments.delete(ATTACHMENT)],
    ['attachment moved to another conversation', (s) => s.messages.set(MESSAGE, { conversationId: OTHER_CONVERSATION })],
  ])('withholds the report when %s', async (_name, mutate) => {
    await expect(readFails(mutate)).rejects.toBeInstanceOf(ResearchProducerInputNotCurrent);
  });

  it('pins a record whose projected provenance dropped its update time, then re-checks it', async () => {
    const context = governedContext();
    context.evidence!.records = context.evidence!.records.map((record) =>
      record.domain === 'contacts' ? { ...record, provenance: { source: 'engagement_contacts' } } : record,
    );
    const unversioned = classify({ governedContext: context }).producerInputDraft!;
    expect(unversioned.records.find((ref) => ref.domain === 'contacts')).toMatchObject({
      observedUpdatedAt: null,
    });
    const manifest = await pinResearchProducerInputs(fakeTx(freshState()), CTX, SCOPE, unversioned);
    const state = freshState();
    state.contacts.set(CONTACT, { clientId: CLIENT, updatedAt: COMPILED });
    await expect(
      assertResearchProducerInputsCurrent(fakeTx(state), CTX, SCOPE, manifest),
    ).rejects.toBeInstanceOf(ResearchProducerInputNotCurrent);
  });

  it('reads a user-private steering item only under the reader identity', async () => {
    await expect(
      pinResearchProducerInputs(fakeTx(freshState(), { ignoreUserScope: true }), CTX, SCOPE, draft()),
    ).rejects.toMatchObject({ category: 'context_packet_item_missing' });
  });

  it('accepts a staged attachment claimed by the research topic message', async () => {
    const staged = draft();
    staged.attachments = staged.attachments.map((item) => ({ ...item, sourceMessageId: null }));
    await expect(
      pinResearchProducerInputs(fakeTx(freshState()), CTX, SCOPE, staged),
    ).resolves.toMatchObject({ attachments: [{ id: ATTACHMENT, sourceMessageId: null }] });
  });

  it.each<[string, (state: FakeState) => void, string]>([
    [
      'a record changed after the producer observed it',
      (s) => s.contacts.set(CONTACT, { clientId: CLIENT, updatedAt: COMPILED }),
      'context_record_changed:contacts',
    ],
    [
      'a packet item was edited after compilation',
      (s) => (s.steering.get(FIRM_MEMORY)!.updatedAt = new Date('2026-10-05T12:00:00.000Z')),
      'context_packet_item_changed',
    ],
    [
      'the packet row does not hold the item',
      (s) => (s.packet = { ...s.packet!, items: [{ id: CLIENT_MEMORY }] }),
      'context_packet_unbound',
    ],
    ['the packet row is missing', (s) => (s.packet = null), 'context_packet_unbound'],
  ])('refuses publication when %s', async (_name, mutate, category) => {
    const state = freshState();
    mutate(state);
    await expect(pinResearchProducerInputs(fakeTx(state), CTX, SCOPE, draft())).rejects.toMatchObject({
      category,
    });
  });
});
