import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import JSZip from 'jszip';
import { extractRawText } from 'mammoth';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriDocgenService } from './meri-docgen.service.js';

// These unused injected services are outside the document boundary. Keep the
// actual tool dispatch, document normalization and Office binary generator.
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: jest.fn() }));
jest.mock('../intelligence/intelligence.service.js', () => ({ IntelligenceService: jest.fn() }));
jest.mock('../intelligence/actions/action-recommendation-read.service.js', () => ({ ActionRecommendationReadService: jest.fn() }));
jest.mock('../clients/client-capabilities.service.js', () => ({ ClientCapabilitiesService: jest.fn() }));
jest.mock('../clients/client-people.service.js', () => ({ ClientPeopleService: jest.fn() }));
jest.mock('../clients/client-facilities.service.js', () => ({ ClientFacilitiesService: jest.fn() }));
jest.mock('../clients/client-advocacy-matter.service.js', () => ({ ClientAdvocacyMatterService: jest.fn() }));
jest.mock('../clients/clients.service.js', () => ({ ClientsService: jest.fn() }));
jest.mock('../clients/representation-resolver.service.js', () => ({ RepresentationResolverService: jest.fn() }));
jest.mock('../regulatory-docket/regulatory-docket.service.js', () => ({ RegulatoryDocketService: jest.fn() }));
jest.mock('../engagement/mail-sender.service.js', () => ({ EngagementMailSender: jest.fn() }));
jest.mock('../lda-intel/lda-intel.service.js', () => ({ LdaIntelService: jest.fn() }));
jest.mock('./analytics/analytics-db.service.js', () => ({ AnalyticsDbService: jest.fn() }));
jest.mock('../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: jest.fn() }));
jest.mock('../federal-spending/federal-spending.service.js', () => ({ FederalSpendingService: jest.fn() }));
jest.mock('../program-element/program-element-read.service.js', () => ({ ProgramElementReadService: jest.fn() }));
jest.mock('../acquisition-personnel/acquisition-personnel-read.service.js', () => ({ AcquisitionPersonnelReadService: jest.fn() }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: jest.fn() }));
jest.mock('../funding-opportunities/meri-opportunity-tools.adapter.js', () => ({ MeriOpportunityToolsAdapter: jest.fn() }));
jest.mock('./meri-context-plane.service.js', () => ({ MeriContextPlaneService: jest.fn() }));
jest.mock('../retrieval/retrieval-v2.service.js', () => ({ RetrievalV2Service: jest.fn() }));
jest.mock('../memory/memory-ingest.service.js', () => ({ MemoryIngestService: jest.fn() }));
jest.mock('../memory/memory-candidate.service.js', () => ({ MemoryCandidateService: jest.fn() }));
jest.mock('../memory/memory-store.service.js', () => ({ MemoryStoreService: jest.fn() }));
jest.mock('./meri-client-filing.service.js', () => ({ MeriClientFilingService: jest.fn() }));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;
const artifactId = '238b644b-c252-44f1-a63e-cd8b1c1e1d3f';
const conversationId = '8418d847-7f93-4d7f-b371-6e6300a38f31';
const chartId = 'a1111111-1111-4111-8111-111111111111';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=';
const fixtureLines = [
  'SYNTHETIC QA FIXTURE — not a real client or approved plan.',
  'Project: Glass Harbor',
  'Requested appropriation: $7,500,000 for FY2027',
  'Stage: internal draft, not enacted or approved',
  'Meeting: September 16, 2026 at 10:00 UTC',
  'Action owner: Policy lead',
  'Deadline: September 14, 2026',
  'QA checksum: BLUE-ORBIT-47',
];

type Artifact = {
  id: string;
  tenantId: string;
  userId: string;
  bodyText?: string | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

function harness(initialArtifacts: Artifact[] = []) {
  const artifacts = [...initialArtifacts];
  const conversation = {
    id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId,
    archivedAt: null, clientId: null,
  };
  const tx = {
    clioArtifact: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        artifacts.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null),
      create: jest.fn(async ({ data }: { data: Omit<Artifact, 'id'> }) => {
        const row = { ...data, id: artifactId } as Artifact;
        artifacts.push(row);
        return row;
      }),
    },
    clioConversation: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        Object.entries(where).every(([key, value]) =>
          (conversation as Record<string, unknown>)[key] === value) ? conversation : null),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const docgen = new MeriDocgenService();
  const buildDocx = jest.spyOn(docgen, 'buildDocx');
  // Only these two constructor ports are used on this production path.
  const service = Object.assign(Object.create(MeriToolsService.prototype), { prisma, docgen }) as MeriToolsService;
  return { service, prisma, tx, artifacts, buildDocx };
}

function wordInput() {
  return { title: 'Glass Harbor QA Brief', conversationId,
    sections: [{ heading: 'Synthetic request', paragraphs: [...fixtureLines] }] };
}

function storedArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return { id: artifactId, tenantId: ctx.tenantId, userId: ctx.userId,
    bodyText: JSON.stringify(wordInput()),
    metadata: { docFormat: 'docx', filename: 'glass-harbor-qa-brief.docx' }, ...overrides };
}

describe('Meri generated document download boundary (MW-01)', () => {
  it('reopens the same persisted artifact and renders a readable DOCX retaining every Glass Harbor field', async () => {
    const h = harness();
    const input = wordInput();
    const generated = await h.service.execute(ctx, 'create_word', input) as {
      filename: string; mimeType: string; artifact: { id: string }; downloadUrl: string;
    };
    expect(generated).toMatchObject({
      artifact: { id: artifactId },
      filename: 'glass-harbor-qa-brief.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      downloadUrl: `/api/clio/artifacts/${artifactId}/download`,
    });
    expect(h.tx.clioArtifact.create).toHaveBeenCalledTimes(1);
    expect(h.artifacts[0]).toMatchObject({
      tenantId: ctx.tenantId, userId: ctx.userId, conversationId, kind: 'word_document',
    });

    // A later composer edit must not change the artifact's stored generation spec.
    input.sections[0]!.paragraphs = ['A different current prompt'];
    const stored = await h.service.getDocumentArtifact(ctx, generated.artifact.id);
    expect(stored).toMatchObject({ filename: generated.filename, mimeType: generated.mimeType, format: 'docx' });
    expect(stored).not.toBeNull();
    const bytes = await h.service.renderStoredDocument(stored!.format, stored!.specJson);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    expect(zip.file('word/document.xml')).not.toBeNull();
    const documentText = (await extractRawText({ buffer: bytes })).value;
    for (const exactLine of fixtureLines) expect(documentText).toContain(exactLine);
    expect(documentText).not.toContain('A different current prompt');
    expect(h.buildDocx).toHaveBeenCalledTimes(2);
    expect(h.tx.clioArtifact.create).toHaveBeenCalledTimes(1);
    expect(h.artifacts).toHaveLength(1);
    expect(await h.service.getDocumentArtifact(ctx, artifactId)).toEqual(stored);
  });

  it.each([
    ['another tenant', { tenantId: 'tenant-b', userId: ctx.userId }],
    ['another user', { tenantId: ctx.tenantId, userId: 'user-b' }],
  ])('denies the existing artifact to %s', async (_label, actor) => {
    const h = harness([storedArtifact()]);
    await expect(h.service.getDocumentArtifact(actor as TenantContext, artifactId)).resolves.toBeNull();
    expect(h.prisma.withTenant).toHaveBeenCalledWith(actor.tenantId, expect.any(Function));
    expect(h.tx.clioArtifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: artifactId, tenantId: actor.tenantId, userId: actor.userId },
    }));
    expect(h.buildDocx).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', []],
    ['not a generated document', [storedArtifact({ metadata: { source: 'research' } })]],
    ['empty generation spec', [storedArtifact({ bodyText: '' })]],
    ['unsupported format', [storedArtifact({ metadata: { docFormat: 'pdf' } })]],
  ] as Array<[string, Artifact[]]>)('returns no downloadable document for %s', async (_label, artifacts) => {
    const h = harness(artifacts);
    await expect(h.service.getDocumentArtifact(ctx, artifactId)).resolves.toBeNull();
    expect(h.buildDocx).not.toHaveBeenCalled();
  });

  it('refuses to create a document in another user’s conversation', async () => {
    const h = harness();
    await expect(h.service.execute({ ...ctx, userId: 'user-b' } as TenantContext,
      'create_word', wordInput())).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('does not fabricate a successful document from corrupt stored JSON', async () => {
    const h = harness([storedArtifact({ bodyText: '{corrupt' })]);
    const stored = await h.service.getDocumentArtifact(ctx, artifactId);
    await expect(h.service.renderStoredDocument(stored!.format, stored!.specJson)).rejects.toThrow(SyntaxError);
    expect(h.buildDocx).not.toHaveBeenCalled();
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it.each([
    ['current owner', ctx.tenantId, ctx.userId, true],
    ['another user', ctx.tenantId, 'user-b', false],
    ['another tenant', 'tenant-b', ctx.userId, false],
  ])('embeds a chart only when readable by the current actor: %s', async (_label, tenantId, userId, allowed) => {
    const h = harness([{ id: chartId, tenantId, userId, metadata: { imageBase64: png } }]);
    await h.service.execute(ctx, 'create_word', {
      ...wordInput(),
      sections: [{ heading: 'Chart', paragraphs: ['Synthetic chart'], imageArtifactIds: [chartId] }],
    });
    const stored = await h.service.getDocumentArtifact(ctx, artifactId);
    const spec = JSON.parse(stored!.specJson) as { sections: Array<{ images: unknown[]; imageArtifactIds: string[] }> };
    expect(spec.sections[0]!.images).toHaveLength(allowed ? 1 : 0);
    expect(spec.sections[0]!.imageArtifactIds).toEqual([]);
    expect(h.tx.clioArtifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: chartId, tenantId: ctx.tenantId, userId: ctx.userId },
    }));
    const bytes = await h.service.renderStoredDocument(stored!.format, stored!.specJson);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).filter((name) => /^word\/media\/.*\.png$/.test(name)))
      .toHaveLength(allowed ? 1 : 0);
  });
});
