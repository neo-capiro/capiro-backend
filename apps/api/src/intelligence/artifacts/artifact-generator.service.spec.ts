import type { TenantContext } from '@capiro/shared';
import { NotFoundException } from '@nestjs/common';
import { ArtifactGeneratorService } from './artifact-generator.service.js';
import { ArtifactController } from './artifact.controller.js';
import type { ActionCard } from '../actions/action-recommendation-read.service.js';
import type { ArtifactType, FactSheet } from './artifact-types.js';

/**
 * Step 3.3 — ArtifactGeneratorService behaviour with a MOCKED LLM (no live call).
 *
 * `callArtifactLlm` is protected/overridable; we subclass to feed canned paragraph
 * JSON. The read service is a stub returning a fixed card; prisma is an in-memory
 * double whose `withTenant` runs the callback against a fake tx that records
 * clioArtifact/clioConversation writes.
 */

const ctx: TenantContext = {
  tenantId: '00000000-0000-0000-0000-0000000000a1',
  tenantSlug: 'capiro',
  userId: '00000000-0000-0000-0000-0000000000b2',
  clerkUserId: 'user_test',
  role: 'standard_user',
};

const CARD: ActionCard = {
  id: 'card-1',
  clientId: '11111111-1111-1111-1111-111111111111',
  clientName: 'ClientCo',
  peCode: '0604123A',
  programId: null,
  deltaId: 'delta-1',
  actionType: 'restore_cut',
  issueTitle: 'House cut to PE 0604123A',
  whatChanged: 'House mark of $90M is below the $120M request.',
  whyItMatters: 'Affects ClientCo radar program.',
  recommendedAction: 'Push to restore the $30M cut before conference.',
  targetAudience: [{ kind: 'committee', id: 'cmte-hasc', label: 'HASC' }],
  suggestedArtifactType: 'committee_staff_memo',
  deadline: null,
  deadlineSource: null,
  ownerUserId: null,
  priority: 80,
  confidence: { delta: 'high' },
  uncertainty: 'PE-to-client mapping is medium confidence; confirm the radar linkage.',
  evidence: [
    { kind: 'delta', deltaId: 'delta-1', note: 'HASC mark cut $30M' },
    { kind: 'source', sourceDocumentId: 'R-2A', page: 144 },
  ],
  status: 'new',
  dismissalReason: null,
  outcome: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
};

interface ArtifactRow {
  id: string;
  tenantId: string;
  userId: string;
  clientId: string | null;
  conversationId: string;
  title: string;
  kind: string;
  contentType: string | null;
  bodyText: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

function makePrisma() {
  const artifacts: ArtifactRow[] = [];
  const conversations: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  let seq = 0;

  const tx = {
    clioConversation: {
      findFirst: jest.fn(async (args: { where: { metadata?: { equals?: unknown } } }) => {
        const want = args.where.metadata?.equals;
        return conversations.find((c) => c.metadata.actionArtifactBacking === want) ?? null;
      }),
      create: jest.fn(async (args: { data: { metadata: Record<string, unknown> } }) => {
        const row = { id: `conv-${++seq}`, metadata: args.data.metadata };
        conversations.push(row);
        return { id: row.id };
      }),
    },
    clioArtifact: {
      create: jest.fn(async (args: { data: Omit<ArtifactRow, 'id' | 'createdAt'> }) => {
        const row: ArtifactRow = { id: `art-${++seq}`, createdAt: new Date(), ...args.data };
        artifacts.push(row);
        return { id: row.id, title: row.title, kind: row.kind };
      }),
      findMany: jest.fn(async (args: { where: { metadata?: { equals?: unknown } } }) => {
        const want = args.where.metadata?.equals;
        return artifacts
          .filter((a) => a.metadata.actionId === want)
          .map((a) => ({
            id: a.id,
            title: a.title,
            kind: a.kind,
            bodyText: a.bodyText,
            metadata: a.metadata,
          }));
      }),
      findFirst: jest.fn(async (args: { where: { id: string } }) => {
        const row = artifacts.find((a) => a.id === args.where.id);
        return row
          ? { id: row.id, title: row.title, kind: row.kind, metadata: { ...row.metadata } }
          : null;
      }),
      updateMany: jest.fn(
        async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = artifacts.find((a) => a.id === args.where.id);
          if (!row) return { count: 0 };
          Object.assign(row, args.data);
          return { count: 1 };
        },
      ),
    },
  };

  const prisma = {
    __artifacts: artifacts,
    __tx: tx,
    __insert: (row: ArtifactRow) => artifacts.push(row),
    withTenant: jest.fn(async (_t: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return prisma;
}

function makeReadService(card: ActionCard = CARD) {
  return { getOne: jest.fn(async (_ctx: TenantContext, _id: string) => card) };
}

const config = {
  get: (key: string) =>
    key === 'CLIO_RESEARCH_MODEL' ? 'claude-sonnet-4-6' : 'test-anthropic-key',
} as unknown as ConstructorParameters<typeof ArtifactGeneratorService>[0];

/** Subclass exposing a settable canned LLM response (string). */
class TestableGenerator extends ArtifactGeneratorService {
  public cannedResponse = '';
  public llmCalls = 0;
  protected override async callArtifactLlm(
    _factSheet: FactSheet,
    _card: ActionCard,
    _type: ArtifactType,
  ): Promise<string> {
    this.llmCalls += 1;
    return this.cannedResponse;
  }
}

function makeGenerator(card?: ActionCard) {
  const prisma = makePrisma();
  const read = makeReadService(card);
  const svc = new TestableGenerator(config, prisma as never, read as never);
  return { svc, prisma, read };
}

describe('ArtifactGeneratorService', () => {
  it('generates an artifact with prose + Sources appendix + Caveats, and persists it', async () => {
    const { svc, prisma } = makeGenerator();
    // Claim ids (from buildFactSheet): c1=$30M (delta note), c2=R-2A source ref,
    // c3=$90M (whatChanged), c4=$120M (whatChanged).
    svc.cannedResponse = JSON.stringify({
      paragraphs: [
        {
          text: 'The House mark of $90M falls short of the $120M request, a $30M cut.',
          claimIds: ['c1', 'c2', 'c3', 'c4'],
        },
      ],
    });

    const result = await svc.generate(ctx, 'card-1', 'committee_staff_memo');

    expect(result.kind).toBe('artifact_committee_staff_memo');
    expect(result.bodyText).toContain('$90M');
    expect(result.bodyText).toContain('## Sources');
    expect(result.bodyText).toContain('R-2A p.144');
    // Caveats present because the card carries uncertainty.
    expect(result.bodyText).toContain('## Caveats');
    expect(result.bodyText).toContain('medium confidence');
    expect(result.metadata.actionId).toBe('card-1');
    expect(result.metadata.version).toBe(1);
    expect(result.metadata.verification.ok).toBe(true);
    // Persisted exactly one artifact row.
    expect(prisma.__artifacts).toHaveLength(1);
  });

  it('verifier drops an unsourced-numeral paragraph but keeps clean prose', async () => {
    const { svc } = makeGenerator();
    svc.cannedResponse = JSON.stringify({
      paragraphs: [
        { text: 'The House mark is $90M.', claimIds: ['c3'] }, // c3 = $90M
        { text: 'A surprise $999M cut is coming.', claimIds: ['c3'] },
      ],
    });

    const result = await svc.generate(ctx, 'card-1', 'internal_brief');

    expect(result.bodyText).toContain('$90M');
    expect(result.bodyText).not.toContain('$999M');
    expect(result.metadata.verification.ok).toBe(false);
    expect(result.metadata.verification.rejected).toHaveLength(1);
    expect(result.metadata.verification.rejected[0]!.index).toBe(1);
  });

  it('omits Caveats when the card has no uncertainty', async () => {
    const noUncertainty: ActionCard = { ...CARD, uncertainty: null };
    const { svc } = makeGenerator(noUncertainty);
    svc.cannedResponse = JSON.stringify({
      paragraphs: [{ text: 'The House mark is $90M.', claimIds: ['c3'] }],
    });

    const result = await svc.generate(ctx, 'card-1', 'internal_brief');
    expect(result.bodyText).not.toContain('## Caveats');
  });

  it('updateContent preserves edits as a new version without regenerating', async () => {
    const { svc } = makeGenerator();
    svc.cannedResponse = JSON.stringify({
      paragraphs: [{ text: 'The House mark is $90M.', claimIds: ['c3'] }],
    });
    const generated = await svc.generate(ctx, 'card-1', 'internal_brief');
    const callsAfterGenerate = svc.llmCalls;

    const edited = await svc.updateContent(ctx, generated.id, 'My hand-edited body. Keep this.');

    expect(edited.bodyText).toBe('My hand-edited body. Keep this.');
    expect(edited.metadata.version).toBe(2); // bumped from 1
    // No regeneration: the LLM was not called again by updateContent.
    expect(svc.llmCalls).toBe(callsAfterGenerate);
  });

  it('lists artifacts generated for an action', async () => {
    const { svc } = makeGenerator();
    svc.cannedResponse = JSON.stringify({
      paragraphs: [{ text: 'The House mark is $90M.', claimIds: ['c3'] }],
    });
    await svc.generate(ctx, 'card-1', 'internal_brief');
    await svc.generate(ctx, 'card-1', 'client_email');

    const list = await svc.listForAction(ctx, 'card-1');
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.kind).sort()).toEqual([
      'artifact_client_email',
      'artifact_internal_brief',
    ]);
  });

  it('excludes a server-only marker even when its kind looks like an ordinary action artifact', async () => {
    const { svc, prisma } = makeGenerator();
    const base = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      clientId: null,
      conversationId: 'conversation-1',
      contentType: 'text/markdown',
      createdAt: new Date(),
    };
    prisma.__insert({
      ...base,
      id: 'ordinary-row',
      title: 'Ordinary',
      kind: 'artifact_internal_brief',
      bodyText: 'ORDINARY_BODY',
      metadata: { actionId: 'card-1', version: 1 },
    });
    prisma.__insert({
      ...base,
      id: 'server-only-row',
      title: 'Private',
      kind: 'artifact_internal_brief',
      bodyText: 'PRIVATE_OWNER_RESULT',
      metadata: { actionId: 'card-1', serverOnly: true },
    });

    const list = await svc.listForAction(ctx, 'card-1');

    expect(list.map((row) => row.id)).toEqual(['ordinary-row']);
    expect(JSON.stringify(list)).not.toContain('PRIVATE_OWNER_RESULT');
    expect(prisma.__tx.clioArtifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { NOT: { metadata: { path: ['serverOnly'], equals: true } } },
          ]),
        }),
      }),
    );
  });

  it('does not expose or mutate a server-only research result through known-id ordinary routes', async () => {
    const { svc, prisma } = makeGenerator();
    const privateBody = '{"result":"PRIVATE OWNER RESULT"}';
    prisma.__insert({
      id: 'private-result',
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      clientId: null,
      conversationId: 'private-conversation',
      title: 'Internal research safe-read result',
      kind: 'internal_research_safe_read_result',
      contentType: 'application/json',
      bodyText: privateBody,
      metadata: { serverOnly: true },
      createdAt: new Date(),
    });
    const otherUser = { ...ctx, userId: '00000000-0000-0000-0000-0000000000c3' };
    const response = { setHeader: jest.fn(), send: jest.fn() };
    const controller = new ArtifactController(svc);

    await expect(svc.renderDocx(otherUser, 'private-result')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      svc.updateContent(otherUser, 'private-result', 'attacker replacement'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.exportDocx(otherUser, 'private-result', response as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
    expect(prisma.__tx.clioArtifact.updateMany).not.toHaveBeenCalled();
    expect(prisma.__artifacts.find((row) => row.id === 'private-result')?.bodyText).toBe(
      privateBody,
    );
  });
});
