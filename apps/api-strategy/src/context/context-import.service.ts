import {
  BadRequestException, ConflictException, ForbiddenException, Injectable,
  NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StrategyAiCredentialResolver } from '../meri/strategy-ai-credential.resolver.js';
import { StrategyOrchestratorClient } from '../meri/strategy-orchestrator.client.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { ContextDocumentsService } from './context-documents.service.js';
import { DOCUMENT_TYPES, TEMPLATE_KEY_BY_TYPE, validateFrontmatter, type Frontmatter } from './frontmatter.js';
import { locate } from './markdown-locate.js';
import type { ResolveContextImportDto, SaveContextImportDto } from './dto/context-import.dto.js';
import type {
  ContextImportAnalysis, ContextImportComparison, ContextImportConflict, ContextImportDocument,
  ContextImportSection, ContextImportSource,
} from './context-import.types.js';

const TOKEN_MAX = 700_000;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const CHUNK_CHARS = 24_000;
const SOURCE_MAX = 120_000;
const EXISTING_FACT_LIMIT = 100;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

interface ImportIdentity {
  tenantId: string;
  userId: string;
  clientId: string;
  strategyId: string | null;
  source: ContextImportSource;
  index: number;
  warnings: string[];
}
interface ChunkToken extends ImportIdentity {
  kind: 'chunk';
  expires: number;
  sections: ContextImportSection[];
}
interface ReviewToken extends ImportIdentity {
  kind: 'review';
  expires: number;
  documents: Array<ContextImportDocument & { id: string }>;
  conflicts: ContextImportConflict[];
  existingFactIds: string[];
}
type ImportToken = ChunkToken | ReviewToken;

/**
 * A preview is signed server-owned data, not an uploaded contract. No document
 * or fact is persisted before Save. Each accepted source/category is additive:
 * import never invokes the legacy active-tuple supersession path. Deterministic
 * document IDs and a transaction lock make retries and concurrent saves no-ops,
 * including after a reviewer has rejected facts or archived the document.
 */
@Injectable()
export class ContextImportService {
  private readonly apiBaseUrl: string;
  private readonly secret: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly documents: ContextDocumentsService,
    private readonly versioning: VersioningService,
    private readonly resolver: StrategyAiCredentialResolver,
    private readonly orchestrator: StrategyOrchestratorClient,
  ) {
    this.apiBaseUrl = (config.get<string>('API_INTERNAL_URL') ?? config.get<string>('API_BASE_URL') ?? 'https://app.capiro.ai').replace(/\/+$/, '');
    this.secret = config.get<string>('INTERNAL_SERVICE_SECRET') ?? '';
  }

  async resolve(tc: AuthTenantContext, bearer: string | undefined, dto: ResolveContextImportDto) {
    this.requireSigning();
    await this.assertScope(tc, dto.clientId, dto.strategyId ?? null);
    const raw = await this.sourceRequest(bearer, dto.clientId, dto.attachmentId, 'context-text');
    const source = readSource(raw, dto.clientId, dto.attachmentId);
    const sections = readSections(raw);
    const warnings = stringWarnings(raw.warnings);
    if (typeof raw.disclosure === 'string' && raw.disclosure.trim()) warnings.push(raw.disclosure.slice(0, 1000));
    if (raw.truncated === true) {
      // Partial source extraction must never masquerade as whole-file coverage.
      warnings.push('This file could only be read in part. Review the extracted information and upload the missing pages separately.');
    }
    const chunks = splitContextSections(sections);
    return {
      source,
      chunks: chunks.map((part, index) => ({ index, token: this.sign({
        kind: 'chunk', expires: Date.now() + TOKEN_TTL_MS,
        tenantId: tc.tenantId, userId: tc.clerkUserId, clientId: dto.clientId,
        strategyId: dto.strategyId ?? null, source, index, warnings, sections: part,
      }) })),
      warnings,
    };
  }

  async analyze(tc: AuthTenantContext, bearer: string | undefined, token: string) {
    const chunk = this.readToken(token, tc, 'chunk');
    await this.assertScope(tc, chunk.clientId, chunk.strategyId);
    await this.revalidateSource(bearer, chunk);
    const existing = await this.eligibleFacts(tc.tenantId, chunk.clientId, chunk.strategyId);
    const warnings = [...chunk.warnings];
    if (existing.length > EXISTING_FACT_LIMIT) {
      warnings.push('Meri compared this upload with the 100 most recent active items. Older information may still need your review.');
    }
    const compared = fitFacts(existing.slice(0, EXISTING_FACT_LIMIT), 24_000);
    if (compared.length < Math.min(existing.length, EXISTING_FACT_LIMIT)) warnings.push('Some lengthy existing information could not fit into this comparison and may need your review.');
    const response = await this.orchestrator.contextImport({
      clientId: chunk.clientId,
      source: chunk.source,
      sections: chunk.sections.map(({ ref, text }) => ({ ref, text })),
      existingFacts: compared.map((f) => ({ id: f.id, fact: f.fact, documentTitle: f.document.title,
        authority: f.authority, asOf: f.asOf?.toISOString().slice(0, 10) ?? null })),
    }, bearer, await this.resolver.resolve(tc.tenantId), { tenantId: tc.tenantId, clerkUserId: tc.clerkUserId });
    const validated = validateImportAnalysis(response, chunk.sections, new Set(compared.map((f) => f.id)));
    warnings.push(...stringWarnings(response.warnings));
    const documents = validated.documents.map((doc) => ({ ...doc,
      id: stableImportId(chunk, doc.documentType),
    }));
    if (!documents.length) {
      return { source: chunk.source, documents: [], token: null,
        warnings: [...warnings, 'Meri did not find supported strategy information in this part of the file. Nothing has been saved.'] };
    }
    const review: ReviewToken = {
      ...chunk, kind: 'review', expires: Date.now() + TOKEN_TTL_MS,
      documents, conflicts: validated.conflicts, existingFactIds: compared.map((f) => f.id), warnings,
    };
    // Only the reviewed derived content is needed after analysis. Source text
    // stays in the canonical attachment and is checked again through its hash.
    delete (review as ReviewToken & { sections?: ContextImportSection[] }).sections;
    return { token: this.sign(review), source: chunk.source, documents, warnings };
  }

  async save(tc: AuthTenantContext, bearer: string | undefined, dto: SaveContextImportDto) {
    const review = this.readToken(dto.token, tc, 'review');
    await this.assertScope(tc, review.clientId, review.strategyId);
    const ids = [...new Set(dto.selectedDocumentIds)];
    if (!ids.length || ids.some((id) => !review.documents.some((doc) => doc.id === id))) {
      throw new BadRequestException('Select only documents from this review.');
    }
    await this.revalidateSource(bearer, review);
    const snapshot = await this.prisma.withTenant(tc.tenantId, async (tx) => ({
      facts: await this.eligibleFactsInTransaction(tx, tc.tenantId, review.clientId, review.strategyId),
      documents: await tx.spContextDocument.findMany({ where: { id: { in: ids } } }),
    }));
    const previousIds = new Set(snapshot.documents.map((doc) => doc.id));
    const selected = review.documents.filter((doc) => ids.includes(doc.id) && !previousIds.has(doc.id));
    const incomingFacts = selected.flatMap((doc) => doc.sections.map((section, index) => ({
      id: `${doc.id}:${index}`, fact: section.content, documentTitle: doc.title,
    })));
    if (!incomingFacts.length) return {
      documents: snapshot.documents.map((doc) => ({ id: doc.id, title: doc.title, templateKey: doc.templateKey })),
      warnings: [...review.warnings, 'The selected information was already imported. Its content and review decisions were preserved.'],
    };
    const warnings = [...review.warnings];
    const incomingChars = incomingFacts.reduce((sum, fact) => sum + fact.fact.length, 0);
    const compared = fitFacts(snapshot.facts.slice(0, EXISTING_FACT_LIMIT), 64_000 - incomingChars);
    if (compared.length < snapshot.facts.length) warnings.push(`Meri compared this information with ${compared.length} recent active items. Additional existing information may need your review.`);
    // Comparison happens immediately before Save and includes earlier saved
    // files and all selected sections together. It can only identify conflicts;
    // it cannot rewrite the information the user already reviewed.
    const comparison = await this.orchestrator.contextCompare({
      clientId: review.clientId, incomingFacts,
      existingFacts: compared.map((f) => ({ id: f.id, fact: f.fact, documentTitle: f.document.title,
        authority: f.authority, asOf: f.asOf?.toISOString().slice(0, 10) ?? null })),
    }, bearer, await this.resolver.resolve(tc.tenantId), { tenantId: tc.tenantId, clerkUserId: tc.clerkUserId });
    const conflicts = validateImportComparison(comparison,
      new Set(incomingFacts.map((fact) => fact.id)), new Set(compared.map((fact) => fact.id)));
    warnings.push(...stringWarnings(comparison.warnings));
    const fingerprint = factFingerprint(snapshot.facts);
    return this.prisma.withTenantUser(tc.tenantId, tc.clerkUserId, async (tx) => {
      // Same tenant/client import operations serialize before checking IDs and
      // facts. No raw lookup is permitted without explicit tenant binding.
      const lockKey = `context-import:${tc.tenantId}:${review.clientId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      if (review.strategyId) await this.assertStrategy(tx, review.clientId, review.strategyId);
      const result: Array<{ id: string; title: string; templateKey: string }> = [];
      const eligible = await this.eligibleFactsInTransaction(tx, tc.tenantId, review.clientId, review.strategyId);
      if (factFingerprint(eligible) !== fingerprint) throw new ConflictException({
        code: 'CONTEXT_IMPORT_CORPUS_CHANGED',
        message: 'The library changed while Meri was checking for differences. Save again to check the latest information.',
      });
      const factIds = new Map<string, string>();
      const createdDocuments: Array<{ id: string; templateKey: string; scope: string; facts: number }> = [];
      for (let documentIndex = 0; documentIndex < review.documents.length; documentIndex++) {
        const draft = review.documents[documentIndex]!;
        if (!ids.includes(draft.id)) continue;
        const existing = await tx.spContextDocument.findFirst({ where: { id: draft.id } });
        if (existing) {
          result.push({ id: existing.id, title: existing.title, templateKey: existing.templateKey });
          warnings.push(`${existing.title} was already imported. Its existing content and review decisions were preserved.`);
          continue;
        }
        const built = buildImportMarkdown(review, draft, tc.clerkUserId);
        const created = await tx.spContextDocument.create({ data: {
          id: draft.id, tenantId: tc.tenantId, clientId: review.clientId,
          scope: review.strategyId ? 'strategy' : 'client', scopeRef: review.strategyId,
          templateKey: TEMPLATE_KEY_BY_TYPE[draft.documentType], title: built.title,
          state: 'active', content: built.content, frontmatter: built.frontmatter as Prisma.InputJsonValue,
          checksum: sha256(built.content), supersedesId: null, validUntil: null,
          createdByUserId: tc.clerkUserId,
        } });
        for (let sectionIndex = 0; sectionIndex < draft.sections.length; sectionIndex++) {
          const section = draft.sections[sectionIndex]!;
          const sourceRef = `heading:Imported information ${sectionIndex + 1}`;
          if (!locate(built.content, sourceRef)) throw new BadRequestException('The source reference could not be saved.');
          const fact = await tx.spContextFact.create({ data: {
            tenantId: tc.tenantId, documentId: created.id, clientId: review.clientId,
            fact: section.content, sourceRef, authority: 'working_draft', asOf: null,
            confidence: null, state: 'active',
            citation: JSON.stringify({ attachmentId: review.source.attachmentId,
              fileName: review.source.fileName, contentHash: review.source.contentHash, evidence: section.evidence }),
          } });
          factIds.set(`${draft.id}:${sectionIndex}`, fact.id);
        }
        createdDocuments.push({ id: created.id, templateKey: created.templateKey, scope: created.scope, facts: draft.sections.length });
        result.push({ id: created.id, title: created.title, templateKey: created.templateKey });
      }
      for (const conflict of conflicts) {
        const factAId = factIds.get(conflict.incomingFactId);
        const factBId = factIds.get(conflict.otherFactId) ?? conflict.otherFactId;
        if (!factAId) throw new ConflictException('This information was saved by another request. Try saving again.');
        await tx.spContextConflict.create({ data: { tenantId: tc.tenantId, factAId, factBId,
          material: conflict.material, state: 'open' } });
      }
      for (const created of createdDocuments) {
        await this.versioning.logActivity(tx, {
          tenantId: tc.tenantId, actorUserId: tc.clerkUserId, authorKind: 'person',
          action: 'context_doc.imported', entityType: 'context_document', entityId: created.id,
          after: { attachmentId: review.source.attachmentId, contentHash: review.source.contentHash,
            templateKey: created.templateKey, scope: created.scope, facts: created.facts,
            conflicts: conflicts.length, authority: 'working_draft', sourceOfTruth: false },
        });
      }
      if (conflicts.length) warnings.push(`${conflicts.length} possible difference${conflicts.length === 1 ? '' : 's'} between sources need your review. Existing information was preserved.`);
      return { documents: result, warnings: [...new Set(warnings)] };
    }, { timeoutMs: 20_000 });
  }

  private async assertScope(tc: AuthTenantContext, clientId: string, strategyId: string | null) {
    if (!UUID.test(clientId) || (strategyId !== null && !UUID.test(strategyId))) throw new BadRequestException('Select a valid client and strategy.');
    await this.documents.assertImportScopeAllowed(tc.tenantId, { clerkUserId: tc.clerkUserId, role: tc.role }, strategyId ? 'strategy' : 'client');
    if (strategyId) await this.prisma.withTenant(tc.tenantId, (tx) => this.assertStrategy(tx, clientId, strategyId));
  }

  private async assertStrategy(tx: Prisma.TransactionClient, clientId: string, strategyId: string) {
    const strategy = await tx.spStrategy.findFirst({ where: { id: strategyId, clientId, archivedAt: null }, select: { id: true } });
    if (!strategy) throw new NotFoundException('The selected strategy is not available for this client.');
  }

  private eligibleFacts(tenantId: string, clientId: string, strategyId: string | null) {
    return this.prisma.withTenant(tenantId, (tx) => this.eligibleFactsInTransaction(tx, tenantId, clientId, strategyId));
  }

  private eligibleFactsInTransaction(tx: Prisma.TransactionClient, tenantId: string, clientId: string, strategyId: string | null) {
    return tx.spContextFact.findMany({
      where: { state: 'active', OR: [{ clientId }, { clientId: null }],
        document: { is: { tenantId, state: 'active',
          AND: [
            { OR: [{ validUntil: null }, { validUntil: { gte: new Date(new Date().toISOString().slice(0, 10)) } }] },
            { OR: [
              { scope: 'firm', clientId: null },
              { scope: 'client', clientId },
              ...(strategyId ? [{ scope: 'strategy' as const, clientId, scopeRef: strategyId }] : []),
            ] },
          ],
        } } },
      orderBy: { createdAt: 'desc' }, take: EXISTING_FACT_LIMIT + 1,
      include: { document: { select: { title: true } } },
    });
  }

  private async revalidateSource(bearer: string | undefined, data: ImportIdentity) {
    const raw = await this.sourceRequest(bearer, data.clientId, data.source.attachmentId, 'context-source');
    const current = readSource(raw, data.clientId, data.source.attachmentId);
    if (current.contentHash !== data.source.contentHash) throw new ConflictException({ code: 'CONTEXT_IMPORT_SOURCE_CHANGED', message: 'This file changed after it was reviewed. Upload it again to review the current version.' });
  }

  private async sourceRequest(bearer: string | undefined, clientId: string, attachmentId: string, route: 'context-text' | 'context-source'): Promise<Record<string, unknown>> {
    if (!bearer) throw new ForbiddenException('Sign in again to access this file.');
    if (!UUID.test(attachmentId)) throw new BadRequestException('Select a valid file.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), route === 'context-text' ? 50_000 : 20_000);
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/engagement/attachments/${attachmentId}/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: bearer.startsWith('Bearer ') ? bearer : `Bearer ${bearer}` },
        body: JSON.stringify({ clientId }), signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw new ForbiddenException('You do not have access to this file or client.');
      if (response.status === 404) throw new NotFoundException('This file is no longer available.');
      if (response.status === 409) throw new ConflictException('This file is still processing or has changed. Try again when it is ready.');
      if (response.status === 400 || response.status === 413 || response.status === 415 || response.status === 422) {
        const detail = await response.json().catch(() => null) as { message?: unknown } | null;
        throw new UnprocessableEntityException(typeof detail?.message === 'string' ? detail.message.slice(0, 500) : 'This file could not be read. Try a readable PDF, Word document, presentation, spreadsheet, image, or text file.');
      }
      if (!response.ok) throw new ServiceUnavailableException('File reading is temporarily unavailable. Please try again.');
      return await response.json() as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException || error instanceof ConflictException || error instanceof UnprocessableEntityException || error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('File reading did not finish. Please try again.');
    } finally { clearTimeout(timer); }
  }

  private requireSigning() {
    if (!this.secret) throw new ServiceUnavailableException('Document import is not configured.');
  }

  private sign(data: ImportToken): string {
    this.requireSigning();
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const sig = createHmac('sha256', this.secret).update(`context-import:v1:${payload}`).digest('base64url');
    const result = `${payload}.${sig}`;
    if (result.length > TOKEN_MAX) throw new UnprocessableEntityException('This file contains too much information for one review. Split it into smaller files.');
    return result;
  }

  private readToken<K extends ImportToken['kind']>(token: string, tc: AuthTenantContext, kind: K): Extract<ImportToken, { kind: K }> {
    this.requireSigning();
    if (typeof token !== 'string' || token.length > TOKEN_MAX) throw new BadRequestException('This document review is invalid. Upload the file again.');
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new BadRequestException('This document review is invalid. Upload the file again.');
    const expected = createHmac('sha256', this.secret).update(`context-import:v1:${payload}`).digest();
    const provided = Buffer.from(signature, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new ForbiddenException('This document review could not be verified. Upload the file again.');
    let value: ImportToken;
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ImportToken; }
    catch { throw new BadRequestException('This document review is invalid. Upload the file again.'); }
    if (!value || value.kind !== kind || value.tenantId !== tc.tenantId || value.userId !== tc.clerkUserId) throw new ForbiddenException('This document review belongs to a different session. Upload the file again.');
    if (!Number.isFinite(value.expires) || value.expires < Date.now()) throw new ConflictException({ code: 'CONTEXT_IMPORT_EXPIRED', message: 'This document review expired. Upload the file again.' });
    return value as Extract<ImportToken, { kind: K }>;
  }
}

function readSource(raw: Record<string, unknown>, clientId: string, attachmentId: string): ContextImportSource {
  if (raw.attachmentId !== attachmentId || raw.clientId !== clientId || typeof raw.fileName !== 'string' || typeof raw.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.contentHash)) {
    throw new UnprocessableEntityException('The file could not be verified for the selected client.');
  }
  return { attachmentId, fileName: raw.fileName.slice(0, 500), contentHash: raw.contentHash };
}

function readSections(raw: Record<string, unknown>): ContextImportSection[] {
  if (!Array.isArray(raw.sections) || raw.sections.length > 2_000) throw new UnprocessableEntityException('This file did not provide readable source sections.');
  const result = raw.sections.filter((s): s is ContextImportSection => Boolean(s && typeof s.ref === 'string' && s.ref.length <= 300 && typeof s.label === 'string' && typeof s.text === 'string'));
  if (result.length !== raw.sections.length || new Set(result.map((s) => s.ref)).size !== result.length) throw new UnprocessableEntityException('The file source references could not be verified.');
  if (!result.some((s) => s.text.trim())) throw new UnprocessableEntityException('No readable text was found. Try a clearer scan or export the original document as PDF.');
  if (result.reduce((sum, s) => sum + s.text.length, 0) > SOURCE_MAX) throw new UnprocessableEntityException('This file is too large to review at once. Split it into smaller files.');
  return result.filter((section) => section.text.trim());
}

/** Every character appears in a chunk; section refs survive splits as part refs. */
export function splitContextSections(sections: ContextImportSection[]): ContextImportSection[][] {
  const chunks: ContextImportSection[][] = [];
  let current: ContextImportSection[] = [];
  let size = 0;
  for (const section of sections) {
    for (let offset = 0, part = 1; offset < section.text.length; part++) {
      if (size === CHUNK_CHARS || current.length === 160) { chunks.push(current); current = []; size = 0; }
      let end = Math.min(section.text.length, offset + CHUNK_CHARS - size);
      const continued = end < section.text.length;
      if (continued && end - offset > 2_000) {
        // Keep surrounding qualifications together when paragraphs or lines
        // offer a nearby boundary. Never delete even the separating newline.
        const candidate = section.text.slice(Math.max(offset, end - 2_000), end);
        const paragraph = candidate.lastIndexOf('\n\n');
        const newline = candidate.lastIndexOf('\n');
        const boundary = paragraph >= 0 ? paragraph + 2 : newline >= 0 ? newline + 1 : -1;
        if (boundary > 0) end = end - candidate.length + boundary;
      }
      const text = section.text.slice(offset, end);
      current.push({ ref: `${section.ref}#part${part}`, label: section.label, text });
      offset += text.length;
      size += text.length;
      if (continued) { chunks.push(current); current = []; size = 0; }
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Revalidate the model at the persistence boundary, independent of orchestrator checks. */
export function validateImportAnalysis(response: ContextImportAnalysis, sections: ContextImportSection[], existingIds: Set<string>) {
  const invalid = () => new UnprocessableEntityException('Meri could not reliably match the organized information to this file. Please try again.');
  if (!response || !Array.isArray(response.documents) || response.documents.length > 14) throw invalid();
  const byRef = new Map(sections.map((s) => [s.ref, s.text]));
  const types = new Set<string>();
  let totalChars = 0;
  let sectionCount = 0;
  for (const doc of response.documents) {
    if (!doc || !DOCUMENT_TYPES.includes(doc.documentType) || types.has(doc.documentType) || typeof doc.title !== 'string' || !doc.title.trim() || doc.title.length > 200 || !Array.isArray(doc.sections) || doc.sections.length < 1) throw invalid();
    types.add(doc.documentType);
    for (const section of doc.sections) {
      if (++sectionCount > 80) throw invalid();
      if (!section || typeof section.heading !== 'string' || section.heading.length > 200 || typeof section.content !== 'string' || !section.content.trim() || section.content.length > 12_000 || !Array.isArray(section.evidence) || !section.evidence.length || section.evidence.length > 20) throw invalid();
      for (const evidence of section.evidence) {
        if (!evidence || typeof evidence.sourceRef !== 'string' || typeof evidence.quote !== 'string' || !evidence.quote.trim() || !byRef.get(evidence.sourceRef)?.includes(evidence.quote)) throw invalid();
      }
      // Imported facts are excerpts. The model selects and organizes evidence;
      // invented paraphrases or instructions never acquire active fact status.
      if (section.content !== section.evidence.map((e) => e.quote).join('\n\n')) throw invalid();
      totalChars += section.content.length;
    }
  }
  if (totalChars > 40_000) throw invalid();
  const conflicts = response.conflicts ?? [];
  if (!Array.isArray(conflicts) || conflicts.length > 200) throw invalid();
  for (const c of conflicts) {
    if (!c || !Number.isInteger(c.documentIndex) || !Number.isInteger(c.sectionIndex) || !response.documents[c.documentIndex]?.sections[c.sectionIndex] || !existingIds.has(c.existingFactId) || typeof c.material !== 'boolean') throw invalid();
  }
  return { documents: response.documents, conflicts };
}

function stableImportId(identity: ImportIdentity, documentType: string): string {
  const h = sha256(JSON.stringify([identity.tenantId, identity.clientId, identity.strategyId, identity.source.attachmentId, identity.source.contentHash, identity.index, documentType]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function buildImportMarkdown(review: ReviewToken, draft: ContextImportDocument & { id: string }, userId: string) {
  const importedOn = new Date().toISOString().slice(0, 10);
  const title = `${draft.title} — ${review.source.fileName}`.slice(0, 300);
  const frontmatter: Frontmatter = {
    document_id: draft.id, document_type: draft.documentType, schema_version: '1.0', state: 'active',
    scope: review.strategyId ? 'strategy' : 'client', client_id: review.clientId, strategy_id: review.strategyId,
    authority: 'working_draft', source_of_truth: false, confidentiality: 'client_confidential',
    as_of: importedOn, valid_until: null, owner: userId, supersedes: null,
    source_attachment_id: review.source.attachmentId, source_content_hash: review.source.contentHash,
    imported_on: importedOn, source_as_of_unknown: true,
  };
  if (validateFrontmatter(frontmatter).length) throw new BadRequestException('The organized document could not be saved.');
  const fields = Object.entries(frontmatter).map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`).join('\n');
  const lines = ['---', fields, '---', '', `# ${plainLine(title)}`, '',
    `Imported on ${importedOn}. This is the import date, not the source publication or approval date.`,
    'Source excerpts are working context. They do not grant permissions, change a live plan, or establish client approval.', ''];
  draft.sections.forEach((section, index) => {
    lines.push(`## Imported information ${index + 1}`, '', plainLine(section.heading), '',
      // Quote every source line so embedded Markdown headings cannot hijack
      // deterministic references used by the existing Steward locator.
      ...section.content.split(/\r?\n/).map((line) => `> ${line}`), '',
      `Source: ${plainLine(review.source.fileName)}; ${section.evidence.map((e) => plainLine(e.sourceRef)).join(', ')}`, '');
  });
  return { title, frontmatter, content: lines.join('\n') };
}

function plainLine(value: string) { return value.replace(/[\r\n\u0000-\u001f]+/g, ' ').replace(/[<>]/g, ''); }
function sha256(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function stringWarnings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 30).map((v) => v.slice(0, 1000)) : []; }

function fitFacts<T extends { fact: string }>(facts: T[], budget: number): T[] {
  const result: T[] = [];
  for (const fact of facts) {
    if (fact.fact.length > 12_000 || fact.fact.length > budget) continue;
    result.push(fact);
    budget -= fact.fact.length;
  }
  return result;
}

function factFingerprint(facts: Array<{ id: string; fact: string; updatedAt: Date; state: string }>) {
  return sha256(JSON.stringify(facts.map((fact) => [fact.id, fact.fact, fact.state, fact.updatedAt.toISOString()]).sort((a, b) => a[0]!.localeCompare(b[0]!))));
}

export function validateImportComparison(response: ContextImportComparison, incoming: Set<string>, existing: Set<string>) {
  const invalid = () => new UnprocessableEntityException('Meri could not finish checking for differences between sources. Nothing was saved. Please try again.');
  if (!response || !Array.isArray(response.conflicts) || response.conflicts.length > 500) throw invalid();
  const pairs = new Set<string>();
  return response.conflicts.filter((conflict) => {
    if (!conflict || !incoming.has(conflict.incomingFactId) ||
      (!incoming.has(conflict.otherFactId) && !existing.has(conflict.otherFactId)) ||
      conflict.incomingFactId === conflict.otherFactId || typeof conflict.material !== 'boolean') throw invalid();
    const pair = [conflict.incomingFactId, conflict.otherFactId].sort().join('|');
    if (pairs.has(pair)) return false;
    pairs.add(pair);
    return true;
  });
}
