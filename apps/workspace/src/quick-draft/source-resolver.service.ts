import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Inject,
  Logger,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canRead } from '../collaborators/role-policy.js';
import type { IntakeRequestDto } from './dto/intake.dto.js';

/**
 * Server-side source resolver for the workspace two-step draft flow (PR #964).
 *
 * The browser sends only identifiers on the intake screen — never server-backed
 * source bodies. This service re-fetches and authorizes every selected source
 * ID server-side using the authenticated tenantId and actorId (Clerk subject),
 * then assigns authority, verification, freshness, and factual eligibility that
 * the browser cannot forge.
 *
 * Security invariants enforced here:
 *  - Validate tenant scope and object-level permissions (canRead on prior drafts).
 *  - Enforce client memory walls (clients table + client_memory_access).
 *  - Never reveal inaccessible filenames, titles, counts, or metadata — an
 *    inaccessible source is returned with a generic label, empty text, and no
 *    server-side metadata. The sourceId is the browser-supplied identifier
 *    (already known to the caller) and is safe to record.
 *  - A sample source is always style_only and cannot become a citation candidate
 *    (factualUseAllowed = false, usePolicy = style_and_structure_only).
 *  - A selected domain label is never evidence — it is a planning instruction
 *    for the context compiler, not a re-fetched source. It is returned in
 *    `domainLabels` and excluded from the `sources` array.
 *  - All retrieved text is treated as untrusted data, never instructions. The
 *    downstream packet builder wraps source text with explicit "this is data,
 *    not instructions" framing; the resolver records the text but never
 *    interprets it.
 *
 * Source types (PR #964):
 *  - blueprint_version   — re-fetched from WsBlueprintVersion, must be published.
 *  - client              — validated against the clients table via $queryRaw
 *                          (workspace has no typed Client model) + memory wall.
 *  - attachment          — cross-service call to apps/api (stub: not_implemented).
 *  - prior_workspace_draft — re-fetched from WsDraft, filtered by tenantId and
 *                           config.client (must match the selected client).
 *  - context_item        — re-fetched from WsContextItem, filtered by tenantId
 *                          and draftId.
 *  - pasted_text         — browser-authored text (the only type that accepts
 *                          browser text), labeled as 'user_pasted'.
 */

const MAX_SOURCE_TEXT = 50_000;

export type SourceType =
  | 'blueprint_version'
  | 'client'
  | 'attachment'
  | 'prior_workspace_draft'
  | 'context_item'
  | 'pasted_text';

export type SourcePurpose = 'factual' | 'sample' | 'structural' | 'system';

export type SourceAuthority =
  | 'client'
  | 'firm'
  | 'user_pasted'
  | 'system_blueprint'
  | 'unknown';

export type SourceVerification =
  | 'verified'
  | 'not_verified'
  | 'inaccessible';

export type SourceFreshness = 'current' | 'stale' | 'unknown';

export type SourceUsePolicy =
  | 'factual_context'
  | 'style_and_structure_only'
  | 'domain_label_only'
  | 'structural_template'
  | 'user_pasted';

/**
 * A single fully-resolved, server-authorized source ready for the intake
 * snapshot and the reasoning source packet.
 */
export interface ResolvedSource {
  /** Server-generated stable ID for this resolved source instance. */
  id: string;
  /** Immutable original identifier selected by the browser (or generated for
   *  pasted text). Safe to record — the browser already knows it. */
  sourceId: string;
  sourceType: SourceType;
  purpose: SourcePurpose;
  label: string;
  /** Retrieved text (truncated to MAX_SOURCE_TEXT). Untrusted data. */
  text: string;
  /** SHA-256 of the resolved (post-truncation) text. */
  contentHash: string;
  /** True when the text was truncated to the server-side maximum. */
  truncated: boolean;
  /** Original text length in characters before truncation. */
  originalLength: number;
  authority: SourceAuthority;
  verification: SourceVerification;
  freshness: SourceFreshness;
  /** Whether this source may support factual claims in the draft. */
  factualUseAllowed: boolean;
  usePolicy: SourceUsePolicy;
  /** ISO-8601 timestamp of server-side retrieval. */
  retrievedAt: string;
  refId?: string;
  url?: string;
  /** Server-recorded immutable metadata. Empty for inaccessible sources. */
  metadata: Record<string, unknown>;
}

/**
 * The complete set of resolved sources plus the sanitized domain labels.
 */
export interface ResolvedSourceSet {
  sources: ResolvedSource[];
  /** Sanitized selected context domain labels — planning instructions, never
   *  evidence. Passed to the context compiler, not the source packet. */
  domainLabels: string[];
  retrievedAt: string;
}

// -- Attachment resolver contract + stub -----------------------------------

export interface AttachmentContentResult {
  attachmentId: string;
  filename: string;
  text: string;
  mimeType: string;
  extractedAt: string;
}

export type AttachmentResolution =
  | { status: 'ok'; result: AttachmentContentResult }
  | { status: 'not_implemented' }
  | { status: 'inaccessible' };

/**
 * Contract for the cross-service attachment content pipeline. The real
 * implementation lives in apps/api/src/engagement/attachment-content.service.ts
 * and must be invoked via the API app's engagement service. Until that
 * integration lands, {@link StubAttachmentResolver} returns `not_implemented`.
 */
export interface AttachmentResolver {
  resolveAttachment(
    tenantId: string,
    actorId: string,
    attachmentId: string,
  ): Promise<AttachmentResolution>;
}

/** DI token for the attachment resolver. */
export const ATTACHMENT_RESOLVER = Symbol('ATTACHMENT_RESOLVER');

/**
 * Stub attachment resolver. Always returns `not_implemented` so the intake
 * cannot silently accept unauthorized attachment text. The intake endpoint
 * should mark attachment sources as inaccessible until the real pipeline
 * is wired.
 *
 * TODO(PR-964): Replace with the real cross-service attachment pipeline that
 * delegates to apps/api/src/engagement/attachment-content.service.ts.
 */
@Injectable()
export class StubAttachmentResolver implements AttachmentResolver {
  async resolveAttachment(
    _tenantId: string,
    _actorId: string,
    _attachmentId: string,
  ): Promise<AttachmentResolution> {
    return { status: 'not_implemented' };
  }
}

// -- Internal helpers -----------------------------------------------------

interface ClientResolution {
  clientId: string;
  name: string;
  wallAllowed: boolean;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// -- Service --------------------------------------------------------------

@Injectable()
export class SourceResolverService {
  private readonly logger = new Logger(SourceResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
    @Inject(ATTACHMENT_RESOLVER)
    private readonly attachmentResolver: AttachmentResolver,
  ) {}

  /**
   * Re-fetch and authorize every selected source ID from the aggregate intake
   * request. Returns the complete resolved source set for the intake snapshot
   * and reasoning source packet.
   *
   * @param tenantId  Authenticated tenant ID (from TenantGuard).
   * @param actorId   Authenticated Clerk user ID (from TenantGuard).
   * @param draftId   The draft the context items belong to.
   * @param intake    The aggregate intake request (IDs only, plus pasted text).
   */
  async resolve(
    tenantId: string,
    actorId: string,
    draftId: string,
    intake: IntakeRequestDto,
  ): Promise<ResolvedSourceSet> {
    const retrievedAt = new Date().toISOString();
    const sources: ResolvedSource[] = [];

    // 1. Blueprint version — required structural contract, must be published.
    sources.push(
      await this.resolveBlueprintVersion(
        tenantId,
        intake.blueprintVersionId,
        retrievedAt,
      ),
    );

    // 2. Client — validate existence + memory wall. Enforced hard (throws).
    let client: ClientResolution | null = null;
    const clientId = intake.clientId?.trim();
    if (clientId) {
      client = await this.resolveClientRecord(tenantId, actorId, clientId);
      if (!client) {
        throw new BadRequestException('The selected client is not available');
      }
      if (!client.wallAllowed) {
        // Memory wall — do not reveal client metadata, reject the intake.
        throw new ForbiddenException(
          'You do not have access to the selected client context',
        );
      }
      sources.push(this.makeClientSource(client, retrievedAt));
    }

    // 3. Factual attachments — cross-service call (stub returns not_implemented).
    for (const attachmentId of intake.factualAttachmentIds) {
      sources.push(
        await this.resolveAttachmentSource(
          tenantId,
          actorId,
          attachmentId,
          'factual',
          retrievedAt,
        ),
      );
    }

    // 4. Sample attachments — style_only, never a citation candidate.
    for (const attachmentId of intake.sampleAttachmentIds) {
      sources.push(
        await this.resolveAttachmentSource(
          tenantId,
          actorId,
          attachmentId,
          'sample',
          retrievedAt,
        ),
      );
    }

    // 5. Prior workspace drafts — tenant + client wall + object-level read.
    for (const priorDraftId of intake.priorWorkspaceDraftIds) {
      sources.push(
        await this.resolvePriorDraft(
          tenantId,
          actorId,
          priorDraftId,
          client,
          retrievedAt,
        ),
      );
    }

    // 6. Context items — tenant + draft scoped.
    for (const itemId of intake.selectedContextItemIds ?? []) {
      sources.push(
        await this.resolveContextItem(tenantId, draftId, itemId, retrievedAt),
      );
    }

    // 7. Pasted context — user-authored, labeled user_pasted (factual eligible).
    if (intake.pastedContext?.trim()) {
      sources.push(
        this.makePastedSource(intake.pastedContext, 'factual', retrievedAt),
      );
    }

    // 8. Pasted sample — style_only, never a citation candidate.
    if (intake.pastedSample?.trim()) {
      sources.push(
        this.makePastedSource(intake.pastedSample, 'sample', retrievedAt),
      );
    }

    // 9. Selected context domains — sanitized labels, never evidence.
    const domainLabels = this.sanitizeDomainLabels(
      intake.selectedContextDomains ?? [],
    );

    return { sources, domainLabels, retrievedAt };
  }

  // -- Blueprint version --------------------------------------------------

  private async resolveBlueprintVersion(
    tenantId: string,
    blueprintVersionId: string,
    retrievedAt: string,
  ): Promise<ResolvedSource> {
    const version = await this.prisma.wsBlueprintVersion.findFirst({
      where: {
        id: blueprintVersionId,
        status: 'published',
        OR: [{ tenantId: null }, { tenantId }],
      },
      select: {
        id: true,
        blueprintId: true,
        version: true,
        definition: true,
        definitionHash: true,
      },
    });
    if (!version) {
      throw new BadRequestException(
        'The selected blueprint version is not published or is no longer available',
      );
    }
    // The blueprint definition is the structural contract, not evidence text.
    // It is passed to the reasoning gateway separately as the structural
    // template. We record the definition hash as the content hash and store
    // the definition in metadata for the immutable intake snapshot.
    const definition = version.definition as Record<string, unknown> | null;
    return {
      id: randomUUID(),
      sourceId: version.id,
      sourceType: 'blueprint_version',
      purpose: 'structural',
      label: `Blueprint v${version.version}`,
      text: '',
      contentHash: version.definitionHash,
      truncated: false,
      originalLength: 0,
      authority: 'system_blueprint',
      verification: 'verified',
      freshness: 'current',
      factualUseAllowed: false,
      usePolicy: 'structural_template',
      retrievedAt,
      refId: version.id,
      metadata: {
        blueprintId: version.blueprintId,
        version: version.version,
        definitionHash: version.definitionHash,
        definition: definition ?? {},
      },
    };
  }

  // -- Client --------------------------------------------------------------

  /**
   * Validate that a client belongs to the tenant and check the memory wall.
   * Uses $queryRaw because workspace has no typed Client model — the clients
   * table is owned by apps/api and protected by RLS. The tenant GUC is set
   * inside a transaction so RLS permits the read.
   */
  private async resolveClientRecord(
    tenantId: string,
    actorId: string,
    clientId: string,
  ): Promise<ClientResolution | null> {
    // Step 1: resolve the actor's Capiro user ID from their Clerk subject.
    // The users table is queried with plain $queryRaw (no tenant GUC) — this
    // mirrors WorkspaceContextCompilerService.resolveUserIdByClerkId.
    let userId: string | null = null;
    try {
      const userRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE clerk_user_id = ${actorId} LIMIT 1
      `;
      userId = userRows[0]?.id ?? null;
    } catch (err) {
      this.logger.warn(
        `Client resolution: Clerk identity lookup failed: ${(err as Error).message}`,
      );
      return null;
    }

    // Step 2: validate client existence + memory wall (tenant-scoped, RLS).
    try {
      const rows = await this.prisma.$transaction(async (tx) => {
        await tx
          .$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return tx.$queryRaw<
          Array<{ id: string; name: string; wall_allowed: boolean }>
        >`
          SELECT c.id::text AS id,
                 c.name,
                 (NOT c.memory_wall OR EXISTS (
                   SELECT 1 FROM client_memory_access a
                   WHERE a.tenant_id = c.tenant_id
                     AND a.client_id = c.id
                     AND a.user_id = ${userId}::uuid
                 )) AS wall_allowed
          FROM clients c
          WHERE c.tenant_id = ${tenantId}::uuid
            AND c.id = ${clientId}::uuid
          LIMIT 1
        `;
      });
      const row = rows[0];
      if (!row) return null;
      return {
        clientId: row.id,
        name: row.name,
        wallAllowed: row.wall_allowed,
      };
    } catch (err) {
      this.logger.warn(
        `Client resolution failed for tenant ${tenantId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private makeClientSource(
    client: ClientResolution,
    retrievedAt: string,
  ): ResolvedSource {
    // The client source is a pointer, not evidence text. The actual client
    // steering is compiled by the context compiler using the domain labels.
    // factualUseAllowed is true because the client context (when authorized)
    // may support factual claims about the client.
    return {
      id: randomUUID(),
      sourceId: client.clientId,
      sourceType: 'client',
      purpose: 'system',
      label: client.name,
      text: '',
      contentHash: this.hashText(''),
      truncated: false,
      originalLength: 0,
      authority: 'client',
      verification: 'verified',
      freshness: 'current',
      factualUseAllowed: true,
      usePolicy: 'factual_context',
      retrievedAt,
      refId: client.clientId,
      metadata: {},
    };
  }

  // -- Attachments --------------------------------------------------------

  private async resolveAttachmentSource(
    tenantId: string,
    actorId: string,
    attachmentId: string,
    purpose: 'factual' | 'sample',
    retrievedAt: string,
  ): Promise<ResolvedSource> {
    const result = await this.attachmentResolver.resolveAttachment(
      tenantId,
      actorId,
      attachmentId,
    );

    if (result.status === 'ok') {
      const { text, truncated, originalLength } = this.truncateText(
        result.result.text,
      );
      return {
        id: randomUUID(),
        sourceId: attachmentId,
        sourceType: 'attachment',
        purpose,
        label: result.result.filename,
        text,
        contentHash: this.hashText(text),
        truncated,
        originalLength,
        authority: 'client',
        verification: 'verified',
        freshness: 'current',
        factualUseAllowed: purpose === 'factual',
        usePolicy:
          purpose === 'sample'
            ? 'style_and_structure_only'
            : 'factual_context',
        retrievedAt,
        refId: attachmentId,
        metadata: {
          mimeType: result.result.mimeType,
          extractedAt: result.result.extractedAt,
        },
      };
    }

    // not_implemented or inaccessible — do not reveal filename/title/metadata.
    this.logger.warn(
      `Attachment ${attachmentId} resolution returned ${result.status}`,
    );
    return this.makeInaccessible(
      attachmentId,
      'attachment',
      purpose,
      retrievedAt,
    );
  }

  // -- Prior workspace drafts ---------------------------------------------

  private async resolvePriorDraft(
    tenantId: string,
    actorId: string,
    priorDraftId: string,
    client: ClientResolution | null,
    retrievedAt: string,
  ): Promise<ResolvedSource> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: priorDraftId, tenantId },
      select: { id: true, docTitle: true, config: true, ownerId: true },
    });
    if (!draft) {
      return this.makeInaccessible(
        priorDraftId,
        'prior_workspace_draft',
        'factual',
        retrievedAt,
      );
    }

    // Object-level permission: the actor must have read access to the prior
    // draft. Tenant scope alone is not object authorization (GAI-31).
    const role = await this.collaborators.resolveRole(
      tenantId,
      priorDraftId,
      actorId,
    );
    if (!canRead(role)) {
      return this.makeInaccessible(
        priorDraftId,
        'prior_workspace_draft',
        'factual',
        retrievedAt,
      );
    }

    // Client memory wall: when a client is selected, the prior draft must be
    // for the same client. If the draft's config references a different client
    // (or no client), it is inaccessible — do not reveal its title or content.
    const config = (draft.config as Record<string, unknown> | null) ?? {};
    const draftClientName = safeString(config.client);
    if (client) {
      const sameClient =
        draftClientName.trim().toLowerCase() ===
        client.name.trim().toLowerCase();
      if (!sameClient) {
        return this.makeInaccessible(
          priorDraftId,
          'prior_workspace_draft',
          'factual',
          retrievedAt,
        );
      }
    }

    // Extract the draft's section content as the source text. The config's
    // sectionContent maps section titles to HTML content.
    const sectionContent =
      (config.sectionContent as Record<string, unknown> | null) ?? {};
    const text = Object.values(sectionContent)
      .map((value) => safeString(value))
      .join('\n\n');
    const { text: truncatedText, truncated, originalLength } =
      this.truncateText(text);

    return {
      id: randomUUID(),
      sourceId: draft.id,
      sourceType: 'prior_workspace_draft',
      purpose: 'factual',
      label: draft.docTitle,
      text: truncatedText,
      contentHash: this.hashText(truncatedText),
      truncated,
      originalLength,
      authority: 'firm',
      verification: 'not_verified',
      freshness: 'unknown',
      factualUseAllowed: true,
      usePolicy: 'factual_context',
      retrievedAt,
      refId: draft.id,
      metadata: {},
    };
  }

  // -- Context items ------------------------------------------------------

  private async resolveContextItem(
    tenantId: string,
    draftId: string,
    itemId: string,
    retrievedAt: string,
  ): Promise<ResolvedSource> {
    const item = await this.prisma.wsContextItem.findFirst({
      where: { id: itemId, tenantId, draftId },
      select: { id: true, kind: true, payload: true },
    });
    if (!item) {
      return this.makeInaccessible(
        itemId,
        'context_item',
        'factual',
        retrievedAt,
      );
    }

    const payload = (item.payload as Record<string, unknown> | null) ?? {};
    const label = safeString(payload.label) || 'Context item';
    const text = safeString(payload.text);
    const { text: truncatedText, truncated, originalLength } =
      this.truncateText(text);

    return {
      id: randomUUID(),
      sourceId: item.id,
      sourceType: 'context_item',
      purpose: 'factual',
      label,
      text: truncatedText,
      contentHash: this.hashText(truncatedText),
      truncated,
      originalLength,
      authority: 'firm',
      verification: 'not_verified',
      freshness: 'unknown',
      factualUseAllowed: true,
      usePolicy: 'factual_context',
      retrievedAt,
      refId: item.id,
      metadata: {},
    };
  }

  // -- Pasted text --------------------------------------------------------

  private makePastedSource(
    rawText: string,
    purpose: 'factual' | 'sample',
    retrievedAt: string,
  ): ResolvedSource {
    // Pasted text is the only source type that accepts browser-authored text.
    // It is labeled as 'user_pasted' authority. A pasted sample is style_only
    // and can never become a citation candidate.
    const { text, truncated, originalLength } = this.truncateText(rawText);
    return {
      id: randomUUID(),
      sourceId: randomUUID(),
      sourceType: 'pasted_text',
      purpose,
      label: purpose === 'sample' ? 'Pasted sample' : 'Pasted context',
      text,
      contentHash: this.hashText(text),
      truncated,
      originalLength,
      authority: 'user_pasted',
      verification: 'not_verified',
      freshness: 'current',
      factualUseAllowed: purpose === 'factual',
      usePolicy:
        purpose === 'sample' ? 'style_and_structure_only' : 'user_pasted',
      retrievedAt,
      metadata: {},
    };
  }

  // -- Domain labels ------------------------------------------------------

  private sanitizeDomainLabels(domains: string[]): string[] {
    // Domain labels are planning instructions for the context compiler, never
    // evidence. They are sanitized (trimmed, empties filtered, length-capped)
    // and returned separately — they are NOT included in the sources array.
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of domains) {
      const label = safeString(raw).trim().slice(0, 120);
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(label);
    }
    return result;
  }

  // -- Inaccessible helper ------------------------------------------------

  /**
   * Build a resolved source for an inaccessible ID. Does not reveal the
   * inaccessible filename, title, or any server-side metadata — only the
   * browser-supplied sourceId (already known to the caller) is recorded.
   */
  private makeInaccessible(
    sourceId: string,
    sourceType: SourceType,
    purpose: SourcePurpose,
    retrievedAt: string,
  ): ResolvedSource {
    return {
      id: randomUUID(),
      sourceId,
      sourceType,
      purpose,
      label: 'Inaccessible source',
      text: '',
      contentHash: this.hashText(''),
      truncated: false,
      originalLength: 0,
      authority: 'unknown',
      verification: 'inaccessible',
      freshness: 'unknown',
      factualUseAllowed: false,
      usePolicy: 'factual_context',
      retrievedAt,
      metadata: {},
    };
  }

  // -- Utilities ----------------------------------------------------------

  private truncateText(raw: string): {
    text: string;
    truncated: boolean;
    originalLength: number;
  } {
    const originalLength = raw.length;
    if (originalLength <= MAX_SOURCE_TEXT) {
      return { text: raw, truncated: false, originalLength };
    }
    return {
      text: raw.slice(0, MAX_SOURCE_TEXT),
      truncated: true,
      originalLength,
    };
  }

  private hashText(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }
}
