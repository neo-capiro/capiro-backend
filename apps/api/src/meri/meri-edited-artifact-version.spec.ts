import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { extractRawText } from 'mammoth';
import JSZip from 'jszip';
import type { Response } from 'express';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriController } from './meri.controller.js';
import { MeriDocgenService } from './meri-docgen.service.js';
import { sha256Bytes } from './meri-artifact-integrity.js';
import type { DocFormat, WordSpec } from './meri-docgen.helpers.js';

// The unused injected ports of MeriToolsService are stubbed; the tool dispatch,
// document normalization, the real Office generator, the real
// renderStoredDocument callback and the real createArtifactVersion service
// method all run for real. MeriService is NOT mocked here.
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
const childId = 'actual-created-child';
const INTERNAL_KIND = 'internal_research_safe_read_result';

type Artifact = {
  id: string;
  tenantId: string;
  userId: string;
  clientId: string | null;
  conversationId: string;
  kind: string;
  title?: string;
  contentType?: string;
  bodyText?: string | null;
  metadata?: Record<string, unknown>;
  conversation?: unknown;
};

function parentSpec(): WordSpec {
  return {
    title: 'Parent Brief',
    subtitle: null,
    sections: [
      {
        heading: 'Overview',
        paragraphs: ['ORIGINAL1'],
        bullets: [],
        tables: [{ headers: ['Field', 'Value'], rows: [['Old', 'OLD-CELL']] }],
        imageArtifactIds: [],
        images: [],
      },
      { heading: 'Excluded', paragraphs: ['REMOVE-ME'], bullets: [], tables: [], imageArtifactIds: [], images: [] },
    ],
  };
}

function editedSpec(): WordSpec {
  return {
    title: 'Parent Brief',
    subtitle: null,
    sections: [
      {
        heading: 'Overview',
        paragraphs: ['EDITED-MARKER'],
        bullets: [],
        tables: [{ headers: ['Field', 'Value'], rows: [['New', 'NEW-CELL']] }],
        imageArtifactIds: [],
        images: [],
      },
    ],
  };
}

// A real 1x1 PNG, used as an already-resolved embedded chart image.
const EMBEDDED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageSpec(marker: string): WordSpec {
  return {
    title: 'Parent Brief',
    subtitle: null,
    sections: [
      {
        heading: 'Overview',
        paragraphs: [marker],
        bullets: [],
        tables: [],
        imageArtifactIds: [],
        images: [{ dataBase64: EMBEDDED_PNG_BASE64 }],
      },
    ],
  };
}

/** Generic Prisma where-matcher: scalar equality plus the ordinary-artifact
 * AND/NOT shapes used by ordinaryClioArtifactWhere. */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND') {
      if (!(value as Record<string, unknown>[]).every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matchesWhere(row, value as Record<string, unknown>)) return false;
      continue;
    }
    if (key === 'kind' && value && typeof value === 'object' && 'not' in value) {
      if (row.kind === (value as { not: unknown }).not) return false;
      continue;
    }
    if (key === 'metadata' && value && typeof value === 'object' && 'path' in value) {
      const { path, equals } = value as { path: string[]; equals: unknown };
      let node: unknown = row.metadata;
      for (const segment of path) {
        node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
      }
      if (node !== equals) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

async function fixture(
  parentOverrides: Partial<Artifact> = {},
  options: {
    proposal?: Record<string, unknown> | null;
    renderError?: Error;
    parentWordSpec?: WordSpec;
    authorizedClientIds?: string[];
  } = {},
) {
  const docgen = new MeriDocgenService();
  const spec = options.parentWordSpec ?? parentSpec();
  const parentBytes = await docgen.buildDocx(spec);
  const parent: Artifact = {
    id: parentId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    conversationId,
    kind: 'word_document',
    title: 'Parent Brief',
    contentType: 'text/markdown',
    bodyText: JSON.stringify(spec),
    metadata: {
      docFormat: 'docx',
      filename: 'parent-brief.docx',
      documentBytesBase64: parentBytes.toString('base64'),
      documentSha256: sha256Bytes(parentBytes),
      documentByteLength: parentBytes.length,
      documentByteFormat: 'docx',
      documentByteAuthority: 'persisted_at_creation_v1',
    },
    ...parentOverrides,
  };
  const conversation: { id: string; tenantId: string; userId: string; clientId: string | null; archivedAt: Date | null } = {
    id: conversationId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    archivedAt: null,
  };
  const artifacts: Artifact[] = [parent];
  const children: Artifact[] = [];
  let renderHook: (() => void) | null = null;
  const authorizedClientIds = [...(options.authorizedClientIds ?? [])];
  const contextPlane = {
    securityEnvelope: jest.fn(async () => ({ authorizedClientIds: [...authorizedClientIds] })),
  };

  const tx = {
    $executeRaw: jest.fn(async () => 1),
    clioArtifact: {
      count: jest.fn(async () => 1),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = artifacts.find((candidate) => matchesWhere(candidate as unknown as Record<string, unknown>, where));
        return row ? { ...row, conversation } : null;
      }),
      create: jest.fn(async ({ data }: { data: Omit<Artifact, 'id'> }) => {
        const row = { ...data, id: childId } as Artifact;
        children.push(row);
        artifacts.push(row);
        return row;
      }),
    },
    meriActionProposal: { findFirst: jest.fn(async () => options.proposal ?? null) },
  };
  const prisma = { withTenant: jest.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)) };
  const tools = Object.assign(Object.create(MeriToolsService.prototype), { prisma, docgen, contextPlane }) as MeriToolsService;
  const realRender = tools.renderStoredDocument.bind(tools);
  tools.renderStoredDocument = jest.fn(async (format: DocFormat, specJson: string) => {
    if (options.renderError) throw options.renderError;
    const out = await realRender(format, specJson);
    const hook = renderHook;
    renderHook = null;
    hook?.();
    return out;
  });
  const service = Object.assign(Object.create(MeriService.prototype), { prisma, tools }) as MeriService;
  const controller = Object.assign(Object.create(MeriController.prototype), { tools }) as MeriController;
  return {
    service,
    controller,
    prisma,
    tx,
    tools,
    artifacts,
    children,
    conversation,
    parentBytes,
    setRenderHook: (hook: (() => void) | null) => {
      renderHook = hook;
    },
    setAuthorizedClientIds: (ids: string[]) => {
      authorizedClientIds.length = 0;
      authorizedClientIds.push(...ids);
    },
  };
}

function downloadResponse() {
  const setHeader = jest.fn();
  const send = jest.fn();
  return { setHeader, send, response: { setHeader, send } as unknown as Response };
}

describe('MeriService.createArtifactVersion ordinary generated-document branch', () => {
  it('creates a real DOCX revision whose edited bytes download and reopen, leaving the parent row untouched', async () => {
    const h = await fixture();
    const parentSnapshot = JSON.parse(JSON.stringify(h.artifacts[0]!.metadata));

    const child = (await h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))) as unknown as Artifact;
    expect(h.tx.clioArtifact.create).toHaveBeenCalledTimes(1);
    expect(h.children).toHaveLength(1);
    expect(child.parentArtifactId).toBe(parentId);
    expect(child.userId).toBe(ctx.userId);
    expect(child.clientId).toBeNull();
    expect(child.conversationId).toBe(conversationId);
    expect(child.kind).toBe('word_document');
    expect(child.metadata).toMatchObject({
      versionOf: parentId,
      editedBy: ctx.userId,
      docFormat: 'docx',
      filename: 'parent-brief.docx',
      documentByteAuthority: 'persisted_at_creation_v1',
    });
    expect(child.metadata!.documentByteFormat).toBe('docx');
    // Real edited bytes, not an inherited receipt.
    expect(child.metadata!.documentSha256).not.toBe(parentSnapshot.documentSha256);

    // Download boundary serves the persisted edited bytes; reopen shows the edit.
    const read = await h.service.getDocumentArtifact(ctx, childId);
    expect(read).toMatchObject({ format: 'docx', byteAuthority: 'persisted_at_creation_v1', filename: 'parent-brief.docx' });
    expect(read!.persistedSha256).toBe(child.metadata!.documentSha256);
    const response = downloadResponse();
    await h.controller.downloadArtifact(ctx, childId, response.response);
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Sha256', child.metadata!.documentSha256);
    const downloaded = response.send.mock.calls[0]![0] as Buffer;
    const reopened = (await extractRawText({ buffer: downloaded })).value;
    expect(reopened).toContain('EDITED-MARKER');
    expect(reopened).toContain('NEW-CELL');
    expect(reopened).not.toContain('OLD-CELL');
    expect(reopened).not.toContain('REMOVE-ME');
    expect(reopened).not.toContain('ORIGINAL1');

    // The parent row and its original persisted bytes are unchanged.
    expect(h.artifacts[0]!.metadata).toEqual(parentSnapshot);
    expect(h.artifacts[0]!.bodyText).toBe(JSON.stringify(parentSpec()));
    const parentRead = await h.service.getDocumentArtifact(ctx, parentId);
    expect(parentRead!.byteAuthority).toBe('persisted_at_creation_v1');
    expect(parentRead!.persistedBytes!.equals(h.parentBytes)).toBe(true);
    expect((await extractRawText({ buffer: parentRead!.persistedBytes! })).value).toContain('ORIGINAL1');
  });

  it('creates a TXT revision with a fresh, non-inherited creation receipt and no action proposal', async () => {
    const parentText = 'Original briefing\n';
    const parentBytes = Buffer.from(parentText, 'utf8');
    const parentSha = sha256Bytes(parentBytes);
    const parentReceipt = {
      version: 1,
      kind: 'meri_text_artifact_creation',
      operationId: '11111111-1111-4111-8111-111111111111',
      actionProposalId: '99999999-9999-4999-8999-999999999999',
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      clientId: null,
      conversationId,
      filename: 'parent-brief.txt',
      mimeType: 'text/plain',
      sha256: parentSha,
      byteLength: parentBytes.length,
    };
    const h = await fixture(
      {
        kind: 'text_document',
        bodyText: parentText,
        metadata: {
          docFormat: 'txt',
          filename: 'parent-brief.txt',
          documentBytesBase64: parentBytes.toString('base64'),
          documentSha256: parentSha,
          documentByteLength: parentBytes.length,
          documentByteFormat: 'txt',
          documentByteAuthority: 'persisted_at_creation_v1',
          textCreation: parentReceipt,
        },
      },
      {
        // The parent was an approved, completed action; its read guard must
        // validate that proposal before a version can be prepared.
        proposal: {
          input: { format: 'txt', title: 'Parent Brief', text: parentText, conversationId, clientId: null },
          resultSummary: {
            ok: true,
            artifactId: parentId,
            operationId: parentReceipt.operationId,
            sha256: parentSha,
            byteLength: parentBytes.length,
            filename: 'parent-brief.txt',
          },
          executedAt: new Date('2026-10-08T00:00:00.000Z'),
          attemptCount: 1,
          approvedBy: ctx.userId,
          approvedAt: new Date('2026-10-08T00:00:00.000Z'),
        },
      },
    );

    const child = (await h.service.createArtifactVersion(ctx, parentId, 'Edited briefing v2\n')) as unknown as Artifact;
    const receipt = child.metadata!.textCreation as Record<string, unknown>;
    const editedBytes = Buffer.from('Edited briefing v2\n', 'utf8');
    expect(receipt.operationId).not.toBe(parentReceipt.operationId);
    expect(receipt.actionProposalId).toBeNull();
    expect(receipt.sha256).toBe(sha256Bytes(editedBytes));
    expect(receipt.byteLength).toBe(editedBytes.length);
    expect(receipt).toMatchObject({ tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId, filename: 'parent-brief.txt' });

    const read = await h.service.getDocumentArtifact(ctx, childId);
    expect(read?.operationReceipt).toMatchObject({ sha256: sha256Bytes(editedBytes), byteLength: editedBytes.length });
    expect(read?.operationReceipt?.currentAction).toBeUndefined();

    // The parent approval/bytes remain immutable.
    expect(h.artifacts[0]!.metadata!.documentSha256).toBe(parentSha);
    expect((h.artifacts[0]!.metadata!.textCreation as Record<string, unknown>).actionProposalId).toBe(parentReceipt.actionProposalId);
  });

  it.each([
    ['another user', { ...ctx, userId: 'user-b' }],
    ['another tenant', { ...ctx, tenantId: 'tenant-b' }],
  ])('creates no child for %s', async (_label, actor) => {
    const h = await fixture();
    await expect(h.service.createArtifactVersion(actor as TenantContext, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(NotFoundException);
    expect(h.children).toHaveLength(0);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it.each([
    ['an internal kind', { kind: INTERNAL_KIND }],
    ['a server-only metadata marker', { metadata: { docFormat: 'docx', serverOnly: true } }],
  ])('creates no child from %s', async (_label, overrides) => {
    const h = await fixture(overrides as Partial<Artifact>);
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(NotFoundException);
    expect(h.children).toHaveLength(0);
  });

  it('creates no child when the client/conversation wall no longer matches', async () => {
    const h = await fixture({ clientId: 'client-1' });
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(NotFoundException);
    expect(h.children).toHaveLength(0);
  });

  it('creates no child when the conversation is already archived', async () => {
    const h = await fixture();
    h.conversation.archivedAt = new Date('2026-10-08T00:00:00.000Z');
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(NotFoundException);
    expect(h.children).toHaveLength(0);
  });

  it('creates no child when the conversation is archived during generation', async () => {
    const h = await fixture();
    h.setRenderHook(() => {
      h.conversation.archivedAt = new Date('2026-10-08T00:00:00.000Z');
    });
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(NotFoundException);
    expect(h.children).toHaveLength(0);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('creates no child when a valid parent receipt is missing its integrity fields', async () => {
    const h = await fixture({ metadata: { docFormat: 'docx', filename: 'parent-brief.docx', documentSha256: '0'.repeat(64) } });
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.children).toHaveLength(0);
  });

  it('rejects a malformed office edit with an existing HTTP exception instead of a 500 or an empty document', async () => {
    const h = await fixture();
    await expect(h.service.createArtifactVersion(ctx, parentId, 'this is not a document spec')).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.createArtifactVersion(ctx, parentId, '')).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.service.createArtifactVersion(ctx, parentId, JSON.stringify({ sections: [] })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.children).toHaveLength(0);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('refuses to fabricate a child when the parent format changes during generation', async () => {
    const h = await fixture();
    h.setRenderHook(() => {
      h.artifacts[0]!.metadata = { docFormat: 'pdf', filename: 'parent-brief.pdf' };
    });
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(ConflictException);
    expect(h.children).toHaveLength(0);
  });

  it('refuses to fabricate a child when the parent title changes during generation', async () => {
    const h = await fixture();
    h.setRenderHook(() => {
      h.artifacts[0]!.title = 'Retitled During Render';
    });
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(ConflictException);
    expect(h.children).toHaveLength(0);
  });

  it('refuses to fabricate a child when the parent body changes during generation', async () => {
    const h = await fixture();
    h.setRenderHook(() => {
      h.artifacts[0]!.bodyText = 'tampered body';
    });
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(ConflictException);
    expect(h.children).toHaveLength(0);
  });

  it('refuses to fabricate a child when the parent byte receipt changes during generation', async () => {
    const h = await fixture();
    h.setRenderHook(() => {
      h.artifacts[0]!.metadata!.documentSha256 = 'f'.repeat(64);
    });
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(ConflictException);
    expect(h.children).toHaveLength(0);
  });

  it('creates no child when the client permission is revoked during generation', async () => {
    const h = await fixture({ clientId: 'client-1' }, { authorizedClientIds: ['client-1'] });
    h.conversation.clientId = 'client-1';
    h.setRenderHook(() => h.setAuthorizedClientIds([]));
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(NotFoundException);
    expect(h.children).toHaveLength(0);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('creates no child when the conversation client association changes during generation', async () => {
    const h = await fixture({ clientId: 'client-1' }, { authorizedClientIds: ['client-1'] });
    h.conversation.clientId = 'client-1';
    h.setRenderHook(() => {
      h.conversation.clientId = 'client-2';
    });
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(NotFoundException);
    expect(h.children).toHaveLength(0);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a known generated kind with no format metadata', { kind: 'word_document', metadata: { filename: 'parent-brief.docx' } }],
    ['a known generated kind with an unsupported format', { kind: 'word_document', metadata: { docFormat: 'odt', filename: 'x.odt' } }],
    ['a bare receipt marker without a resolvable format', { kind: 'document', metadata: { documentByteFormat: 'docx', filename: 'parent-brief.docx' } }],
  ])('creates no child from %s', async (_label, overrides) => {
    const h = await fixture(overrides as Partial<Artifact>);
    await expect(h.service.createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))).rejects.toBeInstanceOf(BadRequestException);
    expect(h.children).toHaveLength(0);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('keeps a legacy kind=document without generated markers on the ordinary metadata path', async () => {
    const h = await fixture({
      kind: 'document',
      metadata: { source: 'clio_tool' },
      contentType: 'text/markdown',
      bodyText: 'legacy text',
    });
    const child = (await h.service.createArtifactVersion(ctx, parentId, 'edited legacy text')) as unknown as Artifact;
    expect(h.children).toHaveLength(1);
    expect(child.kind).toBe('document');
    expect(child.bodyText).toBe('edited legacy text');
    expect(child.metadata).toEqual({ versionOf: parentId, editedBy: ctx.userId });
  });

  it('creates no child and surfaces only the sanitized generation failure when the generator throws', async () => {
    const h = await fixture({}, { renderError: new Error('internal generator exploded at line 42') });
    const error = await h.service
      .createArtifactVersion(ctx, parentId, JSON.stringify(editedSpec()))
      .then(
        () => {
          throw new Error('expected createArtifactVersion to reject');
        },
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'MERI_DOCUMENT_GENERATION_FAILED',
      reason: 'render_failed',
    });
    expect(JSON.stringify((error as UnprocessableEntityException).getResponse())).not.toContain(
      'internal generator exploded',
    );
    expect(h.children).toHaveLength(0);
    expect(h.tx.clioArtifact.create).not.toHaveBeenCalled();
  });

  it('preserves embedded image bytes when versioning a DOCX that already has a resolved chart image', async () => {
    const h = await fixture({}, { parentWordSpec: imageSpec('ORIGINAL1') });
    const child = (await h.service.createArtifactVersion(ctx, parentId, JSON.stringify(imageSpec('EDITED-MARKER')))) as unknown as Artifact;

    const read = await h.service.getDocumentArtifact(ctx, childId);
    const bytes = read!.persistedBytes!;
    const zip = await JSZip.loadAsync(bytes);
    const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'));
    expect(media.length).toBeGreaterThan(0);
    const expected = Buffer.from(EMBEDDED_PNG_BASE64, 'base64');
    let preserved = false;
    for (const name of media) {
      const content = await zip.file(name)!.async('nodebuffer');
      if (content.equals(expected)) preserved = true;
    }
    expect(preserved).toBe(true);
    // The edited content is present alongside the preserved embedded image.
    expect((await extractRawText({ buffer: bytes })).value).toContain('EDITED-MARKER');

    const response = downloadResponse();
    await h.controller.downloadArtifact(ctx, childId, response.response);
    expect(response.setHeader).toHaveBeenCalledWith('X-Capiro-Artifact-Sha256', child.metadata!.documentSha256);
  });
});
