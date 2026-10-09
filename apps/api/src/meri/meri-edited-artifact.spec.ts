import type { TenantContext } from '@capiro/shared';
import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import JSZip from 'jszip';
import { extractRawText } from 'mammoth';
import * as ExcelJS from 'exceljs';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { Response } from 'express';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriController } from './meri.controller.js';
import { MeriDocgenService } from './meri-docgen.service.js';
import { MeriPdfRenderError } from './meri-docgen-pdf.js';
import { sha256Bytes } from './meri-artifact-integrity.js';
import type { DocFormat, ExcelSpec, PptxSpec, WordSpec } from './meri-docgen.helpers.js';
import {
  MAX_EDITED_BODY_TEXT_CHARS,
  buildEditedDocumentVersion,
  hasGeneratedMarkers,
  isKnownGeneratedKind,
  resolveEditedParentFormat,
  safeEditedDocumentFilename,
  type EditedDocumentRender,
} from './meri-edited-artifact.js';

// Only the unused injected ports of MeriToolsService are stubbed; the tool
// dispatch, document normalization, the real Office/PDF generators, the real
// renderStoredDocument callback and the download boundary stay real. This
// mirrors meri-document-artifact.spec.ts.
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
const conversationId = '8418d847-7f93-4d7f-b371-6e6300a38f31';
const parentId = '238b644b-c252-44f1-a63e-cd8b1c1e1d3f';
const editedId = 'f1d61c9b-3c5a-4d6e-8f70-1a2b3c4d5e6f';

// The real render callback the service injects: MeriToolsService.renderStoredDocument.
const docgen = new MeriDocgenService();
const tools = Object.assign(Object.create(MeriToolsService.prototype), { docgen }) as MeriToolsService;
const render: EditedDocumentRender = (format, specJson) => tools.renderStoredDocument(format, specJson);

function wordSpec(marker: string): WordSpec {
  return { title: 'Glass Harbor Edited QA', subtitle: null, sections: [{ heading: `Heading ${marker}`, paragraphs: [`Paragraph ${marker}`], bullets: [], tables: [], imageArtifactIds: [], images: [] }] };
}
function excelSpec(marker: string): ExcelSpec {
  return { title: 'Edited Workbook', sheets: [{ name: 'Data', headers: ['Field'], rows: [[marker]] }] };
}
function pptxSpec(marker: string): PptxSpec {
  return { title: 'Edited Deck', subtitle: null, slides: [{ title: 'Slide', bullets: [marker], table: null, imageArtifactIds: [], images: [] }] };
}

const editedJson = (format: DocFormat) =>
  format === 'docx' || format === 'pdf'
    ? JSON.stringify(wordSpec(format === 'pdf' ? 'EDITPDF3' : 'EDITDOCX9'))
    : format === 'xlsx'
      ? JSON.stringify(excelSpec('EDITXLSX7'))
      : JSON.stringify(pptxSpec('EDITPPTX5'));

// A real 1x1 PNG, used as an already-resolved embedded chart image.
const EMBEDDED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

async function pptxText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files).filter((name) => /^ppt\/(slides|notesSlides)\/.*\.xml$/.test(name));
  let text = '';
  for (const part of parts) text += await zip.file(part)!.async('string');
  return text;
}

describe('buildEditedDocumentVersion (A3 helper) rebuilds a fresh, real byte receipt', () => {
  it.each(['docx', 'pdf', 'xlsx', 'pptx'] as const)(
    'rebuilds %s bytes with a self-consistent receipt whose content reopens',
    async (format) => {
      const prepared = await buildEditedDocumentVersion(
        { title: 'Glass Harbor Edited QA', metadata: { docFormat: format, filename: 'old.docx' } },
        editedJson(format),
        render,
      );
      expect(prepared.format).toBe(format);
      expect(prepared.metadata.documentByteAuthority).toBe('persisted_at_creation_v1');
      expect(prepared.metadata.documentByteFormat).toBe(format);
      expect(prepared.filename).toBe(`glass-harbor-edited-qa.${format}`);
      const bytes = Buffer.from(prepared.metadata.documentBytesBase64, 'base64');
      expect(bytes.toString('base64')).toBe(prepared.metadata.documentBytesBase64);
      expect(bytes.length).toBe(prepared.metadata.documentByteLength);
      expect(prepared.byteLength).toBe(bytes.length);
      expect(sha256Bytes(bytes)).toBe(prepared.metadata.documentSha256);
      expect(prepared.sha256).toBe(prepared.metadata.documentSha256);
      expect(typeof prepared.metadata.documentBytesBase64).toBe('string');

      if (format === 'docx') {
        const text = (await extractRawText({ buffer: bytes })).value;
        expect(text).toContain('EDITDOCX9');
      } else if (format === 'pdf') {
        expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
        expect((await readPdf(bytes)).text).toContain('EDITPDF3');
      } else if (format === 'xlsx') {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(bytes);
        expect(wb.worksheets[0]!.getCell('A2').value).toBe('EDITXLSX7');
      } else {
        expect(await pptxText(bytes)).toContain('EDITPPTX5');
      }
    },
  );

  it('rebuilds a text artifact with a fresh, non-inherited creation receipt', async () => {
    const parentReceipt = {
      version: 1 as const,
      kind: 'meri_text_artifact_creation' as const,
      operationId: '11111111-1111-4111-8111-111111111111',
      actionProposalId: null,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      clientId: null,
      conversationId,
      filename: 'old.txt',
      mimeType: 'text/plain' as const,
      sha256: 'a'.repeat(64),
      byteLength: 9,
    };
    const prepared = await buildEditedDocumentVersion(
      { title: 'Edited Briefing', metadata: { docFormat: 'txt', textCreation: parentReceipt } },
      'Edited briefing text v2\n',
      render,
      { tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId },
    );
    expect(prepared.format).toBe('txt');
    expect(prepared.bodyText).toBe('Edited briefing text v2\n');
    const bytes = Buffer.from(prepared.metadata.documentBytesBase64, 'base64');
    expect(bytes.toString('utf8')).toBe('Edited briefing text v2\n');
    const receipt = prepared.metadata.textCreation!;
    expect(receipt.operationId).not.toBe(parentReceipt.operationId);
    expect(receipt.actionProposalId).toBeNull();
    expect(receipt.sha256).toBe(prepared.metadata.documentSha256);
    expect(receipt.byteLength).toBe(bytes.length);
    expect(receipt).toMatchObject({ tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId, filename: 'edited-briefing.txt' });
  });

  it('never copies the parent immutable byte receipt', async () => {
    const prepared = await buildEditedDocumentVersion(
      {
        title: 'Glass Harbor Edited QA',
        metadata: {
          docFormat: 'docx',
          documentBytesBase64: Buffer.from('stale-parent-bytes').toString('base64'),
          documentSha256: 'f'.repeat(64),
          documentByteLength: 18,
          documentByteFormat: 'docx',
          documentByteAuthority: 'persisted_at_creation_v1',
        },
      },
      editedJson('docx'),
      render,
    );
    expect(prepared.metadata.documentSha256).not.toBe('f'.repeat(64));
    expect(prepared.metadata.documentBytesBase64).not.toBe(Buffer.from('stale-parent-bytes').toString('base64'));
    const bytes = Buffer.from(prepared.metadata.documentBytesBase64, 'base64');
    expect(sha256Bytes(bytes)).toBe(prepared.metadata.documentSha256);
    expect((await extractRawText({ buffer: bytes })).value).toContain('EDITDOCX9');
  });

  it('leaves the parent facts unchanged (no mutation of the parent row)', async () => {
    const parentMetadata: Record<string, unknown> = { docFormat: 'docx', filename: 'parent.docx', documentSha256: '0'.repeat(64) };
    const snapshot = JSON.parse(JSON.stringify(parentMetadata));
    const parent = { title: 'Parent', metadata: parentMetadata, bodyText: JSON.stringify(wordSpec('ORIGINAL1')) };
    const bodySnapshot = parent.bodyText;

    await buildEditedDocumentVersion(parent, editedJson('docx'), render);

    // The helper is pure: it never mutates the parent's stored facts. Verified
    // byte-for-byte identity of a separately regenerated DOCX is deliberately
    // not asserted here (OOXML ZIP timestamps can differ).
    expect(parent.metadata).toEqual(snapshot);
    expect(parent.bodyText).toBe(bodySnapshot);
  });

  it('rejects an edit that leaves unresolved chart references', async () => {
    const spec: WordSpec = {
      title: 'Charts',
      subtitle: null,
      sections: [{ heading: 'H', paragraphs: [], bullets: [], tables: [], imageArtifactIds: ['11111111-1111-4111-8111-111111111111'], images: [] }],
    };
    await expect(
      buildEditedDocumentVersion({ title: 'Charts', metadata: { docFormat: 'docx' } }, JSON.stringify(spec), render),
    ).rejects.toThrow(/references charts that cannot be resolved/);
  });

  it.each([
    ['missing docFormat', null],
    ['unknown docFormat', { docFormat: 'odt' }],
    ['non-document metadata', { source: 'clio_tool' }],
  ] as Array<[string, Record<string, unknown> | null]>)('fails closed for %s', (_label, metadata) => {
    expect(() => resolveEditedParentFormat(metadata)).toThrow(/not a generated document/);
  });

  it('accepts every supported native format', () => {
    for (const format of ['docx', 'pdf', 'xlsx', 'pptx', 'txt'] as const) {
      expect(resolveEditedParentFormat({ docFormat: format })).toBe(format);
    }
  });

  it('fails closed instead of fabricating bytes for invalid edits', async () => {
    await expect(buildEditedDocumentVersion({ title: 'X', metadata: { docFormat: 'docx' } }, '', render)).rejects.toThrow(/text is empty/);
    await expect(buildEditedDocumentVersion({ title: 'X', metadata: { docFormat: 'docx' } }, 'not json', render)).rejects.toThrow(/saved document structure/);
    await expect(buildEditedDocumentVersion({ title: 'X', metadata: { docFormat: 'docx' } }, JSON.stringify({ sections: [] }), render)).rejects.toThrow(/structure is invalid/);
    await expect(buildEditedDocumentVersion({ title: 'X', metadata: { docFormat: 'txt' } }, 'plain', render)).rejects.toThrow('meri_edited_artifact_receipt_context_required');
    await expect(
      buildEditedDocumentVersion({ title: 'X', metadata: { docFormat: 'txt' } }, 'x'.repeat(MAX_EDITED_BODY_TEXT_CHARS + 1), render, { tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId }),
    ).rejects.toThrow(/too large/);
    await expect(buildEditedDocumentVersion({ title: 'X', metadata: null }, 'x', render)).rejects.toThrow(/not a generated document/);
  });

  it('normalizes more malformed edits to BadRequest without invoking the generator', async () => {
    let renderCalls = 0;
    const counting: EditedDocumentRender = async (format, specJson) => {
      renderCalls += 1;
      return render(format, specJson);
    };
    await expect(
      buildEditedDocumentVersion({ title: 'X', metadata: { docFormat: 'docx' } }, JSON.stringify([]), counting),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      buildEditedDocumentVersion(
        { title: 'X', metadata: { docFormat: 'txt' } },
        'bad\u0001text',
        counting,
        { tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(renderCalls).toBe(0);
  });

  it('wraps generator and integrity failures in the sanitized generation contract', async () => {
    const failing: EditedDocumentRender = async () => {
      throw new Error('boom: internal generator detail');
    };
    const genError = await buildEditedDocumentVersion(
      { title: 'X', metadata: { docFormat: 'docx' } },
      editedJson('docx'),
      failing,
    ).then(
      () => {
        throw new Error('expected rejection');
      },
      (err: unknown) => err,
    );
    expect(genError).toBeInstanceOf(UnprocessableEntityException);
    expect((genError as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'MERI_DOCUMENT_GENERATION_FAILED',
      format: 'docx',
      reason: 'render_failed',
    });
    expect(JSON.stringify((genError as UnprocessableEntityException).getResponse())).not.toContain(
      'internal generator detail',
    );

    const badBytes: EditedDocumentRender = async () => Buffer.from('not a docx');
    await expect(
      buildEditedDocumentVersion({ title: 'X', metadata: { docFormat: 'docx' } }, editedJson('docx'), badBytes),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MERI_DOCUMENT_GENERATION_FAILED' }),
    });
  });

  it('carries a safe PDF reason through the sanitized generation contract', async () => {
    const failing: EditedDocumentRender = async () => {
      throw new MeriPdfRenderError('unsupported_text', 'PDF cannot render this text. Download Word instead.');
    };
    const error = await buildEditedDocumentVersion(
      { title: 'X', metadata: { docFormat: 'pdf' } },
      editedJson('pdf'),
      failing,
    ).then(
      () => {
        throw new Error('expected rejection');
      },
      (err: unknown) => err,
    );
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'MERI_DOCUMENT_GENERATION_FAILED',
      format: 'pdf',
      reason: 'unsupported_text',
    });
  });

  it('keeps an already-resolved embedded image in the rebuilt DOCX', async () => {
    const spec: WordSpec = {
      title: 'Charts',
      subtitle: null,
      sections: [
        {
          heading: 'H',
          paragraphs: ['EDIT'],
          bullets: [],
          tables: [],
          imageArtifactIds: [],
          images: [{ dataBase64: EMBEDDED_PNG_BASE64 }],
        },
      ],
    };
    const prepared = await buildEditedDocumentVersion(
      { title: 'Charts', metadata: { docFormat: 'docx' } },
      JSON.stringify(spec),
      render,
    );
    const bytes = Buffer.from(prepared.metadata.documentBytesBase64, 'base64');
    const zip = await JSZip.loadAsync(bytes);
    const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'));
    expect(media.length).toBeGreaterThan(0);
  });

  it('recognizes generated kinds and receipt markers for fail-closed dispatch', () => {
    for (const kind of ['text_document', 'pdf_document', 'word_document', 'excel_workbook', 'powerpoint_deck']) {
      expect(isKnownGeneratedKind(kind)).toBe(true);
    }
    expect(isKnownGeneratedKind('document')).toBe(false);
    expect(hasGeneratedMarkers({ source: 'clio_tool' })).toBe(false);
    expect(hasGeneratedMarkers({ docFormat: 'docx' })).toBe(true);
    expect(hasGeneratedMarkers({ textCreation: { version: 1 } })).toBe(true);
    expect(hasGeneratedMarkers(null)).toBe(false);
  });

  it('produces a filesystem-safe filename', () => {
    expect(safeEditedDocumentFilename('Q1\n"../Report"', 'docx')).toBe('q1-report.docx');
    expect(safeEditedDocumentFilename('', 'pdf')).toBe('document.pdf');
  });
});

function downloadResponse() {
  const setHeader = jest.fn();
  const send = jest.fn();
  return { setHeader, send, response: { setHeader, send } as unknown as Response };
}

function boundaryHarness(rows: Array<Record<string, unknown>>, conversationOverride?: Record<string, unknown>) {
  const conversation = conversationOverride
    ? { id: conversationId, ...conversationOverride }
    : { id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId, archivedAt: null, clientId: null };
  const tx = {
    clioArtifact: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = rows.find((candidate) =>
          Object.entries(where).every(([key, value]) => candidate[key] === value),
        );
        return row ? { ...row, conversation } : null;
      }),
    },
    meriActionProposal: { findFirst: jest.fn(async () => null) },
  };
  const prisma = { withTenant: jest.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)) };
  const service = Object.assign(Object.create(MeriToolsService.prototype), { prisma, docgen }) as MeriToolsService;
  const controller = Object.assign(Object.create(MeriController.prototype), { tools: service }) as MeriController;
  return { service, controller };
}

describe('edited ordinary document version survives the real download boundary', () => {
  it('serves the rebuilt persisted bytes and reopens with the edited DOCX content', async () => {
    const parentBytes = await docgen.buildDocx(wordSpec('ORIGINAL1'));
    const prepared = await buildEditedDocumentVersion({ title: 'Glass Harbor Edited QA', metadata: { docFormat: 'docx' } }, editedJson('docx'), render);
    const rows = [
      { id: parentId, tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId, kind: 'word_document', bodyText: JSON.stringify(wordSpec('ORIGINAL1')), metadata: { docFormat: 'docx', filename: 'parent.docx', documentBytesBase64: parentBytes.toString('base64'), documentSha256: sha256Bytes(parentBytes), documentByteLength: parentBytes.length, documentByteFormat: 'docx', documentByteAuthority: 'persisted_at_creation_v1' } },
      { id: editedId, tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId, kind: 'word_document', bodyText: prepared.bodyText, metadata: { versionOf: parentId, editedBy: ctx.userId, ...prepared.metadata } },
    ];
    const { service, controller } = boundaryHarness(rows);

    const read = await service.getDocumentArtifact(ctx, editedId);
    expect(read).not.toBeNull();
    expect(read).toMatchObject({ format: 'docx', byteAuthority: 'persisted_at_creation_v1', filename: 'glass-harbor-edited-qa.docx' });
    expect(read!.persistedSha256).toBe(prepared.metadata.documentSha256);
    expect(read!.persistedBytes!.equals(Buffer.from(prepared.metadata.documentBytesBase64, 'base64'))).toBe(true);

    const response = downloadResponse();
    await controller.downloadArtifact(ctx, editedId, response.response);
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Byte-Authority', 'persisted_at_creation_v1');
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Sha256', prepared.metadata.documentSha256);
    expect(response.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="glass-harbor-edited-qa.docx"');
    const downloaded = response.send.mock.calls[0]![0] as Buffer;
    const reopened = (await extractRawText({ buffer: downloaded })).value;
    expect(reopened).toContain('EDITDOCX9');
    expect(reopened).not.toContain('ORIGINAL1');

    // The parent artifact keeps its own immutable bytes and digest.
    const parentRead = await service.getDocumentArtifact(ctx, parentId);
    expect(parentRead!.persistedSha256).toBe(sha256Bytes(parentBytes));
    expect((await extractRawText({ buffer: parentRead!.persistedBytes! })).value).toContain('ORIGINAL1');
  });

  it('serves an edited text version with a fresh matching operation receipt', async () => {
    const prepared = await buildEditedDocumentVersion(
      { title: 'Edited Briefing', metadata: { docFormat: 'txt' } },
      'Edited briefing text v2\n',
      render,
      { tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId },
    );
    const rows = [
      { id: editedId, tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId, kind: 'text_document', bodyText: prepared.bodyText, metadata: { versionOf: parentId, editedBy: ctx.userId, ...prepared.metadata } },
    ];
    const { service, controller } = boundaryHarness(rows);

    const read = await service.getDocumentArtifact(ctx, editedId);
    expect(read?.operationReceipt).toMatchObject({ sha256: prepared.metadata.documentSha256, byteLength: prepared.byteLength, filename: 'edited-briefing.txt' });
    expect(read?.operationReceipt?.currentAction).toBeUndefined();

    const response = downloadResponse();
    await controller.downloadArtifact(ctx, editedId, response.response);
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Operation-Id', prepared.metadata.textCreation!.operationId);
    expect(response.send).toHaveBeenCalledWith(Buffer.from('Edited briefing text v2\n', 'utf8'));
  });
});
