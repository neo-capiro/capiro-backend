import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import JSZip from 'jszip';
import { extractRawText } from 'mammoth';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriDocgenService } from './meri-docgen.service.js';
import { MeriController } from './meri.controller.js';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Response } from 'express';
import { generatedPngBase64 } from './meri-artifact-test-fixtures.js';
import { sha256Bytes } from './meri-artifact-integrity.js';

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
jest.mock('./meri.service.js', () => ({ MeriService: jest.fn() }));
jest.mock('./meri-research.service.js', () => ({ MeriResearchService: jest.fn() }));
jest.mock('./meri-mcp.service.js', () => ({ MeriMcpService: jest.fn() }));
jest.mock('./meri-mcp-oauth.service.js', () => ({ MeriMcpOAuthService: jest.fn() }));
jest.mock('./meri-firm-skills.service.js', () => ({ MeriFirmSkillsService: jest.fn() }));
jest.mock('./meri-approval.service.js', () => ({ MeriApprovalService: jest.fn() }));
jest.mock('./meri-compliance-audit.service.js', () => ({ MeriComplianceAuditService: jest.fn() }));
jest.mock('./meri-claim-writer.js', () => ({ MeriClaimWriterService: jest.fn() }));

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;
const artifactId = '238b644b-c252-44f1-a63e-cd8b1c1e1d3f';
const conversationId = '8418d847-7f93-4d7f-b371-6e6300a38f31';
const chartId = 'a1111111-1111-4111-8111-111111111111';
const png = generatedPngBase64();
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
  const artifacts = initialArtifacts.map((artifact) =>
    typeof artifact.metadata?.imageBase64 === 'string'
      ? { kind: 'analysis_chart', clientId: null, conversationId, ...artifact }
      : artifact);
  const conversation: {
    id: string; tenantId: string; userId: string; archivedAt: Date | null; clientId: string | null;
  } = {
    id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId,
    archivedAt: null, clientId: null,
  };
  const tx = {
    meriActionProposal: {
      findFirst: jest.fn<Promise<Record<string, unknown> | null>, [unknown]>(async () => null),
    },
    clioArtifact: {
      count: jest.fn(async ({ where }: { where: { tenantId: string; userId: string; conversationId: string; metadata: { equals: string } } }) =>
        artifacts.filter((row) => row.tenantId === where.tenantId && row.userId === where.userId &&
          row.conversationId === where.conversationId &&
          (row.metadata?.textCreation as Record<string, unknown>)?.actionProposalId === where.metadata.equals).length),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = artifacts.find((candidate) => Object.entries(where).every(([key, value]) => candidate[key] === value));
        return row ? { ...row, conversation } : null;
      }),
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
  const buildPdf = jest.spyOn(docgen, 'buildPdf');
  // Only these two constructor ports are used on this production path.
  const contextPlane = { securityEnvelope: jest.fn(async () => ({
    authorizedClientIds: conversation.clientId ? [conversation.clientId] : [],
    authorizedMailboxConnectionIds: [],
  })) };
  const service = Object.assign(Object.create(MeriToolsService.prototype), { prisma, docgen, contextPlane }) as MeriToolsService;
  const controller = Object.assign(Object.create(MeriController.prototype), { tools: service }) as MeriController;
  return { service, controller, prisma, tx, artifacts, buildDocx, buildPdf, conversation, contextPlane };
}

function wordInput() {
  return { title: 'Glass Harbor QA Brief', conversationId,
    sections: [{ heading: 'Synthetic request', paragraphs: [...fixtureLines] }] };
}

describe('native governed text artifact creation', () => {
  const textInput = () => ({ title: 'Aster Synthetic Briefing', format: 'txt', text: 'Synthetic Aster briefing v1\n', sections: [], conversationId });
  it('creates one real stored artifact and returns the same immutable bytes and durable operation on download', async () => {
    const h = harness();
    const result = await h.service.execute(ctx, 'create_word', textInput()) as any;
    expect(h.tx.clioArtifact.create).toHaveBeenCalledTimes(1);
    expect(result.operationReceipt).toMatchObject({ artifactId, tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId, filename: 'aster-synthetic-briefing.txt', sha256: 'c26beebc62f179a568981d811784dc75ad7e2cad79c94165d6f4859dcb278c53', byteLength: 28 });
    expect(h.artifacts[0]).toMatchObject({ kind: 'text_document', bodyText: textInput().text, metadata: { textCreation: { operationId: result.operationReceipt.operationId } } });
    const stored = await h.service.getDocumentArtifact(ctx, artifactId);
    expect(stored?.operationReceipt).toEqual(result.operationReceipt);
    const response = downloadResponse();
    await h.controller.downloadArtifact(ctx, artifactId, response.response);
    expect(response.send).toHaveBeenCalledWith(Buffer.from(textInput().text));
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Operation-Id', result.operationReceipt.operationId);
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Creation-Receipt', Buffer.from(JSON.stringify(result.operationReceipt)).toString('base64url'));
    expect(h.buildDocx).not.toHaveBeenCalled();
    expect(h.buildPdf).not.toHaveBeenCalled();
  });
  it('binds a completed canonical proposal and permits an authorized retry without trusting attempt count', async () => {
    const h = harness();
    const actionProposalId = '713b7393-e35e-4c26-940b-2e10ea94eb70';
    const input = textInput();
    const result = await h.service.execute(ctx, 'create_word', input, { actionProposalId }) as any;
    expect(result.operationReceipt.actionProposalId).toBe(actionProposalId);
    expect(result).toMatchObject({ artifactId, operationId: result.operationReceipt.operationId, sha256: result.operationReceipt.sha256, byteLength: 28 });
    await expect(h.service.getDocumentArtifact(ctx, artifactId)).rejects.toBeInstanceOf(UnprocessableEntityException);
    const proposal = { input, resultSummary: { ok: true, artifactId, operationId: result.operationId, sha256: result.sha256, byteLength: result.byteLength, filename: result.filename }, executedAt: new Date(), attemptCount: 2, approvedBy: ctx.userId, approvedAt: new Date() };
    h.tx.meriActionProposal.findFirst.mockResolvedValue(proposal);
    expect((await h.service.getDocumentArtifact(ctx, artifactId))?.operationReceipt).toMatchObject({ ...result.operationReceipt, currentAction: {
      proposalId: actionProposalId, status: 'succeeded', artifactEffectCount: 1, attemptCount: 2, approvedBy: ctx.userId,
    } });
    expect(h.tx.clioArtifact.count).toHaveBeenLastCalledWith({ where: { tenantId: ctx.tenantId, userId: ctx.userId, conversationId, metadata: { path: ['textCreation', 'actionProposalId'], equals: actionProposalId } } });
    // A duplicate actual effect remains downloadable but must be visible to the
    // capture receipt; the attempt count is deliberately unchanged.
    h.artifacts.push({ ...h.artifacts[0]!, id: 'duplicate-effect' });
    expect((await h.service.getDocumentArtifact(ctx, artifactId))?.operationReceipt?.currentAction?.artifactEffectCount).toBe(2);
    const response = downloadResponse();
    await h.controller.downloadArtifact(ctx, artifactId, response.response);
    const header = response.setHeader.mock.calls.find(([name]) => name === 'X-Capiro-Artifact-Creation-Receipt')?.[1];
    expect(JSON.parse(Buffer.from(String(header), 'base64url').toString('utf8')).currentAction.artifactEffectCount).toBe(2);
    expect(h.tx.meriActionProposal.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: actionProposalId, tenantId: ctx.tenantId, userId: ctx.userId, actorUserId: ctx.userId, conversationId, tool: 'create_word', surface: 'chat', status: 'succeeded' } }));
    for (const field of ['artifactId', 'operationId', 'sha256', 'byteLength', 'filename']) {
      h.tx.meriActionProposal.findFirst.mockResolvedValue({ ...proposal, resultSummary: { ...proposal.resultSummary, [field]: 'changed' } });
      await expect(h.service.getDocumentArtifact(ctx, artifactId)).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
    h.tx.meriActionProposal.findFirst.mockResolvedValue({ ...proposal, input: { ...input, text: 'changed' } });
    await expect(h.service.getDocumentArtifact(ctx, artifactId)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.tx.clioArtifact.create).toHaveBeenCalledTimes(1);
  });
  it('requires actual conversation/client authority and rejects changed receipt ownership/bytes', async () => {
    const h = harness();
    await expect(h.service.execute(ctx, 'create_word', { ...textInput(), conversationId: undefined })).rejects.toThrow();
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
    await h.service.execute(ctx, 'create_word', textInput());
    const metadata = h.artifacts[0]!.metadata!;
    const original = { ...(metadata.textCreation as Record<string, unknown>) };
    for (const key of ['tenantId', 'userId', 'clientId', 'conversationId', 'filename', 'sha256', 'byteLength', 'operationId']) {
      metadata.textCreation = { ...original, [key]: 'changed' };
      await expect(h.service.getDocumentArtifact(ctx, artifactId)).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
    metadata.textCreation = original;
    expect(await h.service.getDocumentArtifact({ ...ctx, userId: 'another-user' }, artifactId)).toBeNull();
    expect(await h.service.getDocumentArtifact({ ...ctx, tenantId: 'another-tenant' }, artifactId)).toBeNull();
    h.conversation.archivedAt = new Date();
    expect(await h.service.getDocumentArtifact(ctx, artifactId)).toBeNull();
  });
});

function storedArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return { id: artifactId, tenantId: ctx.tenantId, userId: ctx.userId,
    clientId: null, conversationId,
    bodyText: JSON.stringify(wordInput()),
    metadata: { docFormat: 'docx', filename: 'glass-harbor-qa-brief.docx' }, ...overrides };
}

// Decode the renderer's standard WinAnsi PDF text operators independently of
// the input spec. PDFDocument also verifies that the produced bytes reopen.
async function readPdf(bytes: Buffer) {
  const document = await PDFDocument.load(bytes);
  const text: string[] = [];
  for (const page of document.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    for (const entry of streams) {
      const stream = document.context.lookup(entry);
      if (!(stream instanceof PDFRawStream)) throw new Error('Expected a PDF content stream');
      const operators = Buffer.from(decodePDFRawStream(stream).decode()).toString('ascii');
      for (const match of operators.matchAll(/<([0-9a-f]+)>\s*Tj/gi)) {
        text.push(new TextDecoder('windows-1252').decode(Buffer.from(match[1]!, 'hex')));
      }
    }
  }
  return { document, text: text.join('\n') };
}

function downloadResponse() {
  const setHeader = jest.fn();
  const send = jest.fn();
  return { setHeader, send, response: { setHeader, send } as unknown as Response };
}

describe('Meri canonical PDF export (MW-11)', () => {
  it('creates a PDF, reopens it, and exports both formats from exactly one saved Word spec', async () => {
    const h = harness();
    const input = { ...wordInput(), format: 'pdf' };
    const result = await h.service.execute(ctx, 'create_word', input) as {
      artifact: { id: string }; filename: string; mimeType: string; downloads: unknown[];
    };
    expect(result).toMatchObject({ filename: 'glass-harbor-qa-brief.pdf', mimeType: 'application/pdf' });
    expect(result.downloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ format: 'pdf', downloadUrl: `/api/clio/artifacts/${artifactId}/download?format=pdf` }),
      expect.objectContaining({ format: 'docx', downloadUrl: `/api/clio/artifacts/${artifactId}/download?format=docx` }),
    ]));
    expect(h.artifacts[0]).toMatchObject({ kind: 'pdf_document', userId: ctx.userId, tenantId: ctx.tenantId, conversationId });
    input.sections[0]!.paragraphs = ['Unrelated edited prompt'];

    const saved = await h.service.getDocumentArtifact(ctx, result.artifact.id);
    const bytes = await h.service.renderStoredDocument(saved!.format, saved!.specJson);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const pdf = await readPdf(bytes);
    expect(pdf.document.getPageCount()).toBe(1);
    for (const line of fixtureLines) expect(pdf.text).toContain(line);
    expect(pdf.text).not.toContain('Unrelated edited prompt');

    const word = await h.service.getDocumentArtifact(ctx, result.artifact.id, 'docx');
    expect(word!.specJson).toBe(saved!.specJson);
    expect(word!.filename).toBe('glass-harbor-qa-brief.docx');
    const wordBytes = await h.service.renderStoredDocument(word!.format, word!.specJson);
    for (const line of fixtureLines) expect((await extractRawText({ buffer: wordBytes })).value).toContain(line);
    expect(h.tx.clioArtifact.create).toHaveBeenCalledTimes(1);
    expect(h.buildPdf).toHaveBeenCalledTimes(2);
  });

  it('converts a saved Word artifact through the private download endpoint with real PDF bytes and canonical headers', async () => {
    const h = harness([storedArtifact()]);
    const response = downloadResponse();
    await h.controller.downloadArtifact(ctx, artifactId, response.response, 'pdf');
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(response.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="glass-harbor-qa-brief.pdf"');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    const bytes = response.send.mock.calls[0]![0] as Buffer;
    for (const line of fixtureLines) expect((await readPdf(bytes)).text).toContain(line);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it.each([
    ['another tenant', { tenantId: 'tenant-b', userId: ctx.userId }],
    ['another user', { tenantId: ctx.tenantId, userId: 'user-b' }],
  ])('denies PDF conversion to %s before any renderer runs', async (_label, actor) => {
    const h = harness([storedArtifact()]);
    const response = downloadResponse();
    await expect(h.controller.downloadArtifact(actor as TenantContext, artifactId, response.response, 'pdf')).rejects.toBeInstanceOf(NotFoundException);
    expect(h.buildPdf).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
  });

  it('rejects unsupported conversions without interpreting a workbook as a Word spec', async () => {
    const h = harness([storedArtifact({ metadata: { docFormat: 'xlsx' } })]);
    await expect(h.service.getDocumentArtifact(ctx, artifactId, 'pdf')).rejects.toBeInstanceOf(BadRequestException);
    expect(h.buildPdf).not.toHaveBeenCalled();
    await expect(h.service.execute(ctx, 'create_word', { ...wordInput(), format: 'exe' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('reports a render failure without returning fake bytes, while keeping the saved Word available', async () => {
    const h = harness([storedArtifact()]);
    h.buildPdf.mockRejectedValueOnce(new Error('private renderer detail'));
    const response = downloadResponse();
    await expect(h.controller.downloadArtifact(ctx, artifactId, response.response, 'pdf')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MERI_DOCUMENT_RENDER_FAILED', format: 'pdf' }),
    });
    expect(response.send).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
    const word = await h.service.getDocumentArtifact(ctx, artifactId);
    expect(await h.service.renderStoredDocument(word!.format, word!.specJson)).toBeInstanceOf(Buffer);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('fails PDF generation explicitly for unsupported Unicode and saves nothing instead of dropping text', async () => {
    const h = harness();
    await expect(h.service.execute(ctx, 'create_word', {
      ...wordInput(), format: 'pdf', sections: [{ heading: 'Source', paragraphs: ['Exact source: 東京'] }],
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'MERI_DOCUMENT_GENERATION_FAILED', reason: 'unsupported_text' }) });
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
    expect(h.artifacts).toHaveLength(0);
  });

  it('retains paragraphs, bullets, numbered citations, long table cells and images across pages', async () => {
    const h = harness();
    await h.service.execute(ctx, 'create_word', {
      ...wordInput(), format: 'pdf',
      sections: [{
        heading: 'Evidence',
        paragraphs: ['The request remains an internal draft [1].'],
        bullets: ['No enacted appropriation is claimed.'],
        tables: [{ headers: ['Field', 'Evidence'], rows: [
          ['Long source', `${'Source sentence with facts. '.repeat(160)} END-OF-LONG-CELL`],
          ['Final row', 'TAIL-CHECK-92'],
        ] }],
        images: [{ dataBase64: png }],
      }, { heading: 'Sources', paragraphs: ['[1] Synthetic source https://example.test/source'] }],
    });
    const stored = await h.service.getDocumentArtifact(ctx, artifactId);
    const bytes = await h.service.renderStoredDocument(stored!.format, stored!.specJson);
    const pdf = await readPdf(bytes);
    expect(pdf.document.getPageCount()).toBeGreaterThan(1);
    for (const text of ['internal draft [1]', 'No enacted appropriation', 'END-OF-LONG-CELL', 'TAIL-CHECK-92', '[1] Synthetic source https://example.test/source']) {
      expect(pdf.text).toContain(text);
    }
    expect(pdf.document.getPages().some((page) => {
      const xObjects = page.node.normalizedEntries().XObject;
      return xObjects.keys().length > 0;
    })).toBe(true);
  });

  it('rejects too many combined embedded and referenced charts before saving a spec that would lose images on reopen', async () => {
    const h = harness([{ id: chartId, tenantId: ctx.tenantId, userId: ctx.userId, metadata: { imageBase64: png } }]);
    await expect(h.service.execute(ctx, 'create_word', {
      ...wordInput(), format: 'pdf', sections: [{ heading: 'Charts',
        images: Array.from({ length: 4 }, () => ({ dataBase64: png })), imageArtifactIds: [chartId],
      }],
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.buildPdf).not.toHaveBeenCalled();
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('rejects oversized stored charts before saving a spec whose image would be dropped on reopen', async () => {
    const h = harness([{ id: chartId, tenantId: ctx.tenantId, userId: ctx.userId, metadata: { imageBase64: 'A'.repeat(4 * 1024 * 1024) } }]);
    await expect(h.service.execute(ctx, 'create_word', {
      ...wordInput(), format: 'pdf', sections: [{ heading: 'Chart', imageArtifactIds: [chartId] }],
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.buildPdf).not.toHaveBeenCalled();
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });
});

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

  it('serves immutable native bytes with their creation checksum instead of regenerating them', async () => {
    const h = harness();
    const generated = await h.service.execute(ctx, 'create_word', wordInput()) as {
      artifact: { id: string };
    };
    const metadata = h.artifacts[0]!.metadata!;
    const persisted = Buffer.from(metadata.documentBytesBase64 as string, 'base64');
    expect(metadata).toMatchObject({
      documentSha256: sha256Bytes(persisted),
      documentByteLength: persisted.length,
      documentByteFormat: 'docx',
      documentByteAuthority: 'persisted_at_creation_v1',
    });
    h.buildDocx.mockRejectedValueOnce(new Error('native download must not regenerate'));
    const response = downloadResponse();

    await h.controller.downloadArtifact(ctx, generated.artifact.id, response.response);

    expect(response.send).toHaveBeenCalledWith(persisted);
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Sha256', sha256Bytes(persisted));
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Byte-Authority', 'persisted_at_creation_v1');
    expect(h.buildDocx).toHaveBeenCalledTimes(1);
  });

  it('rejects a partial or mismatched persisted byte receipt instead of regenerating', async () => {
    const h = harness();
    await h.service.execute(ctx, 'create_word', wordInput());
    h.artifacts[0]!.metadata = {
      ...h.artifacts[0]!.metadata,
      documentSha256: '0'.repeat(64),
    };
    const response = downloadResponse();

    await expect(h.controller.downloadArtifact(ctx, artifactId, response.response))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(response.send).not.toHaveBeenCalled();
    expect(h.buildDocx).toHaveBeenCalledTimes(1);
  });

  it('blocks alternate exports when any native byte receipt is partial', async () => {
    const h = harness([storedArtifact({ metadata: {
      docFormat: 'docx',
      filename: 'glass-harbor-qa-brief.docx',
      documentSha256: '0'.repeat(64),
    } })]);

    await expect(h.service.getDocumentArtifact(ctx, artifactId, 'pdf'))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.buildPdf).not.toHaveBeenCalled();
  });

  it('keeps legacy rows compatible but rechecks conversation state and client wall at delivery', async () => {
    const legacy = storedArtifact({ clientId: 'client-1' });
    const h = harness([legacy]);
    h.conversation.clientId = 'client-1';
    h.contextPlane.securityEnvelope.mockResolvedValue({
      authorizedClientIds: ['client-1'],
      authorizedMailboxConnectionIds: [],
    });
    const response = downloadResponse();
    await h.controller.downloadArtifact(ctx, artifactId, response.response);
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Byte-Authority', 'regenerated_legacy');

    h.contextPlane.securityEnvelope.mockResolvedValue({
      authorizedClientIds: [],
      authorizedMailboxConnectionIds: [],
    });
    await expect(h.service.getDocumentArtifact(ctx, artifactId)).resolves.toBeNull();
    h.conversation.archivedAt = new Date('2026-09-28T00:00:00.000Z');
    await expect(h.service.getDocumentArtifact(ctx, artifactId)).resolves.toBeNull();
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
    ['unsupported format', [storedArtifact({ metadata: { docFormat: 'odt' } })]],
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
    const generation = h.service.execute(ctx, 'create_word', {
      ...wordInput(),
      sections: [{ heading: 'Chart', paragraphs: ['Synthetic chart'], imageArtifactIds: [chartId] }],
    });
    if (!allowed) {
      await expect(generation).rejects.toBeInstanceOf(NotFoundException);
      expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
      return;
    }
    await generation;
    const stored = await h.service.getDocumentArtifact(ctx, artifactId);
    const spec = JSON.parse(stored!.specJson) as { sections: Array<{ images: unknown[]; imageArtifactIds: string[] }> };
    expect(spec.sections[0]!.images).toHaveLength(allowed ? 1 : 0);
    expect(spec.sections[0]!.imageArtifactIds).toEqual([]);
    expect(h.tx.clioArtifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: chartId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        kind: 'analysis_chart',
        conversationId,
        clientId: null,
      },
    }));
    const bytes = await h.service.renderStoredDocument(stored!.format, stored!.specJson);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).filter((name) => /^word\/media\/.*\.png$/.test(name)))
      .toHaveLength(allowed ? 1 : 0);
  });

  it('refuses an archived chart from another client even if a data adapter returns it', async () => {
    const h = harness();
    h.conversation.clientId = 'client-a';
    h.tx.clioArtifact.findFirst.mockResolvedValueOnce({
      id: chartId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      kind: 'analysis_chart',
      clientId: 'client-b',
      conversationId: 'conversation-b',
      metadata: { imageBase64: png, imageSha256: sha256Bytes(Buffer.from(png, 'base64')) },
      conversation: {
        id: 'conversation-b',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId: 'client-b',
        archivedAt: new Date('2026-09-28T00:00:00.000Z'),
      },
    } as never);

    await expect(h.service.execute(ctx, 'create_word', {
      ...wordInput(),
      sections: [{ heading: 'Chart', imageArtifactIds: [chartId] }],
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });
});

describe('Meri legacy analysis image route', () => {
  it('serves the owner-scoped reader result with no-store and persisted integrity headers', async () => {
    const bytes = Buffer.from(png, 'base64');
    const getArtifactImage = jest.fn(async () => ({
      buffer: bytes,
      contentType: 'image/png',
      sha256: sha256Bytes(bytes),
      integrityPolicy: 'persisted_hash_match' as const,
    }));
    const controller = Object.assign(Object.create(MeriController.prototype), {
      service: { getArtifactImage },
    }) as MeriController;
    const response = downloadResponse();

    await controller.artifactImage(ctx, chartId, response.response);

    expect(getArtifactImage).toHaveBeenCalledWith(ctx, chartId);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Id', chartId);
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Image-Integrity', 'persisted_hash_match');
    expect(response.setHeader).toHaveBeenCalledWith('ETag', `"sha256-${sha256Bytes(bytes)}"`);
    expect(response.send).toHaveBeenCalledWith(bytes);
  });
});
