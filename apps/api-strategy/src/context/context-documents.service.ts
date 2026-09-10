import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  SpContextDocState,
  SpContextScope,
  type SpContextDocument,
} from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import {
  TEMPLATE_KEY_BY_TYPE,
  parseFrontmatter,
  validateFrontmatter,
  type DocumentTypeValue,
  type FieldError,
} from './frontmatter.js';
import { locate, locateAll } from './markdown-locate.js';
import type { UploadContextDocumentDto } from './dto/context.dto.js';

/** Caller identity for role-gated operations (from AuthTenantContext). */
export interface ContextUser {
  clerkUserId: string;
  role: string | null;
}

type ContextDocumentWithStale = SpContextDocument & { stale: boolean };

/**
 * Stage D: the context-pack document store. Upload = parse + validate the
 * frontmatter contract (every failure is FIELD-LEVEL), derive templateKey /
 * scope / validUntil, then persist with idempotency (same tuple + checksum
 * short-circuits) and supersession (the old active row is RETAINED as
 * `superseded`, never deleted — the pack README's "do not silently delete
 * history"). Client/firm-scope pinning is role-gated to org admins (a firm- or
 * client-wide source of truth binds every strategy under it).
 *
 * Staleness (validUntil < today) is DERIVED at read time, never stored — a doc
 * that was fresh yesterday must read stale today without a write.
 */
@Injectable()
export class ContextDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
  ) {}

  /** Imports use the same scope authorization as direct document uploads. */
  async assertImportScopeAllowed(tenantId: string, user: ContextUser, scope: 'client' | 'strategy') {
    this.assertScopeAllowed(scope, await this.isOrgAdmin(tenantId, user));
  }

  async upload(tenantId: string, user: ContextUser, dto: UploadContextDocumentDto, reviewed?: { id: string; checksum: string; operation?: 'approve' | 'reassign' }) {
    const parsed = parseFrontmatter(dto.content);
    if (parsed.errors.length > 0 || parsed.frontmatter === null) {
      throw this.badFrontmatter(
        parsed.errors.length > 0
          ? parsed.errors
          : [{ field: '_structure', message: 'missing frontmatter' }],
      );
    }
    const fm = parsed.frontmatter;
    const validationErrors = validateFrontmatter(fm);
    if (validationErrors.length > 0) {
      throw this.badFrontmatter(validationErrors);
    }

    const documentType = fm.document_type as DocumentTypeValue;
    const templateKey = TEMPLATE_KEY_BY_TYPE[documentType];
    const scope = fm.scope as SpContextScope;
    // The validated frontmatter state IS the persisted state — a doc uploaded
    // as `state: draft` must never silently go live.
    const state = fm.state as SpContextDocState;

    // Scope-gated pinning: a client- or firm-scope document becomes context for
    // EVERY strategy under that client/firm — only an org admin may pin one.
    const isAdmin = await this.isOrgAdmin(tenantId, user);
    this.assertScopeAllowed(scope, isAdmin);

    const validUntil =
      typeof fm.valid_until === 'string' ? new Date(fm.valid_until) : null;
    const checksum = createHash('sha256').update(dto.content, 'utf8').digest('hex');
    const title = dto.title ?? firstHeading(parsed.body) ?? templateKey;

    // IDENTITY BINDING: the persisted (clientId, scopeRef) columns are the
    // supersession/idempotency key, so they must come from the VALIDATED
    // frontmatter ids (client_id, and strategy_id/node_id for scoped docs),
    // not just whatever the caller happened to send. The library upload modal
    // sends only { content, clientId } — without frontmatter binding every
    // strategy/node-scope upload landed unbound (scopeRef=null) and collided
    // in the supersession tuple (Strategy B's brief silently superseding
    // Strategy A's), and a client-scope doc uploaded without dto.clientId
    // persisted clientId=null and read as firm-wide. When BOTH the DTO and the
    // frontmatter carry an id they must AGREE (mismatch = field-level 400),
    // and a non-UUID frontmatter id (the template placeholders) 400s here
    // instead of 500ing at the uuid-typed column.
    const identityErrors: FieldError[] = [];
    const clientId = bindIdentity(
      identityErrors,
      'client_id',
      fm.client_id,
      'clientId',
      dto.clientId,
    );
    const scopeRefField =
      scope === 'strategy' ? 'strategy_id' : scope === 'node' ? 'node_id' : null;
    const scopeRef = scopeRefField
      ? bindIdentity(identityErrors, scopeRefField, fm[scopeRefField], 'scopeRef', dto.scopeRef)
      : (dto.scopeRef ?? null);
    if (identityErrors.length > 0) throw this.badFrontmatter(identityErrors);

    return this.prisma.withTenantUser(tenantId, user.clerkUserId, async (tx) => {
      if (reviewed) {
        await tx.$queryRaw`SELECT id FROM sp_context_document WHERE id = ${reviewed.id}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
        const current = await tx.spContextDocument.findFirst({ where: { id: reviewed.id } });
        if (!current || current.state !== 'active' || current.checksum !== reviewed.checksum || (reviewed.operation !== 'reassign' && isStale(current.validUntil))) {
          throw new ConflictException('This document changed or expired. Reload and review the current version before saving a revision.');
        }
        if (reviewed.operation === 'reassign') {
          if (current.clientId !== clientId || scope !== 'strategy' || !scopeRef) throw new BadRequestException('Reassignment must stay within the original client.');
          await tx.$queryRaw`SELECT id FROM sp_strategy WHERE id = ${scopeRef}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
          const target = await tx.spStrategy.findFirst({ where: { id: scopeRef, clientId: clientId!, archivedAt: null } });
          if (!target) throw new NotFoundException('Select an active strategy belonging to this document’s client.');
          const existing = await tx.spContextDocument.findFirst({ where: { templateKey, scope, clientId, scopeRef, state: 'active' } });
          if (existing && existing.id !== current.id) throw new ConflictException('That strategy already has an active document for this topic. Review it before replacing anything.');
        }
      }
      // IDEMPOTENT: same key-tuple + same content (checksum) on a row already
      // in the INCOMING state -> return it unchanged. No new row, no activity.
      // Matching is state-exact: an archived (or superseded) row must never be
      // silently returned for an `active` upload — that would hand back dead
      // history instead of re-activating the content.
      const identical = await tx.spContextDocument.findFirst({
        where: {
          templateKey,
          scope,
          clientId,
          scopeRef,
          checksum,
          state,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (identical) return identical;

      // SUPERSESSION — only when the NEW doc goes live. An explicit
      // frontmatter `supersedes` (the prior doc's frontmatter document_id —
      // pack README rule 5) names the exact active row of the SAME templateKey
      // to replace, reaching across the tuple (e.g. re-binding a brief to a
      // different strategy); without one, the active doc for the
      // {templateKey, scope, clientId, scopeRef} tuple is replaced. Either way
      // IN THIS TX — the new row goes live and the old row is RETAINED as
      // `superseded`. A doc uploaded in any other state (e.g. `draft`) is
      // staged ALONGSIDE the tuple-holder and must not displace it (its
      // `supersedes` is recorded lineage, acted on only when an active
      // revision lands). `scope` is PART of the tuple: assertCanPinScope only
      // gates the NEW doc's scope, so a cross-scope match (e.g. an un-gated
      // `once` doc hitting an admin-pinned firm doc with the same templateKey
      // and null clientId/scopeRef) must never supersede — and the explicit
      // pointer re-checks the TARGET's scope for the same reason.
      const fmSupersedes = typeof fm.supersedes === 'string' ? fm.supersedes : null;
      let active: SpContextDocument | null = null;
      if (state === 'active') {
        active = reviewed
          ? await tx.spContextDocument.findFirst({ where: { id: reviewed.id, templateKey, state: 'active' } })
          : fmSupersedes
          ? await tx.spContextDocument.findFirst({
              where: {
                templateKey,
                state: 'active',
                frontmatter: { path: ['document_id'], equals: fmSupersedes },
              },
              orderBy: { createdAt: 'desc' },
            })
          : await tx.spContextDocument.findFirst({
              where: { templateKey, scope, clientId, scopeRef, state: 'active' },
              orderBy: { createdAt: 'desc' },
            });
        if (fmSupersedes) {
          if (!active) {
            // The named target must exist and be active — silently ignoring
            // the pointer (or falling back to the tuple) would supersede the
            // wrong document.
            throw this.badFrontmatter([
              {
                field: 'supersedes',
                message: `no active '${templateKey}' document has document_id '${fmSupersedes}'`,
              },
            ]);
          }
          // Retiring a client/firm-scope target un-pins a firm- or client-wide
          // source of truth — same org-admin gate as pinning/archival.
          this.assertScopeAllowed(active.scope, isAdmin, 'supersession');
        }
      }

      const created = await tx.spContextDocument.create({
        data: {
          tenantId,
          clientId,
          scope,
          scopeRef,
          templateKey,
          title,
          state,
          content: dto.content,
          frontmatter: fm as Prisma.InputJsonValue,
          checksum,
          supersedesId: active?.id ?? null,
          validUntil,
          createdByUserId: user.clerkUserId,
        },
      });

      if (active) {
        await tx.spContextDocument.update({
          where: { id: active.id },
          data: { state: 'superseded', updatedByUserId: user.clerkUserId },
        });
        // Stage E: the superseded document's ACTIVE facts flip to `stale` in
        // the SAME tx — the deterministic reprocess signal. The review UI
        // surfaces stale facts; re-extracting the NEW document refreshes the
        // corpus (the Steward supersedes/re-inserts). Never deleted.
        await tx.spContextFact.updateMany({
          where: { documentId: active.id, state: 'active' },
          data: { state: 'stale' },
        });
        await this.versioning.logActivity(tx, {
          tenantId,
          actorUserId: user.clerkUserId,
          authorKind: 'person',
          action: 'context_doc.superseded',
          entityType: 'context_document',
          entityId: active.id,
          before: { state: 'active' },
          after: { state: 'superseded', supersededById: created.id },
        });
      }
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: user.clerkUserId,
        authorKind: 'person',
        action: 'context_doc.uploaded',
        entityType: 'context_document',
        entityId: created.id,
        after: {
          templateKey,
          scope,
          state,
          clientId,
          scopeRef,
          checksum,
          supersedesId: created.supersedesId,
        },
      });
      if (reviewed) await this.versioning.logActivity(tx, {
        tenantId, actorUserId: user.clerkUserId, authorKind: 'person',
        action: reviewed.operation === 'reassign' ? 'context_doc.reassigned' : 'context_doc.approved', entityType: 'context_document', entityId: created.id,
        before: { documentId: reviewed.id, checksum: reviewed.checksum },
        after: { authority: fm.authority, source_of_truth: fm.source_of_truth, scope, scopeRef, clientId, checksum },
      });
      return created;
    });
  }

  /** Explicit human approval creates a revision; the imported original remains history. */
  async approve(tenantId: string, user: ContextUser, id: string, expectedChecksum: string) {
    if (!await this.isOrgAdmin(tenantId, user)) throw new ForbiddenException('Document approval requires an org admin');
    const doc = await this.get(tenantId, id);
    if (doc.state !== 'active' || doc.stale || doc.checksum !== expectedChecksum) {
      throw new ConflictException('This document changed or expired. Reload and review the current version before approving.');
    }
    const parsed = parseFrontmatter(doc.content);
    const fm = parsed.frontmatter;
    if (!fm || parsed.errors.length || validateFrontmatter(fm).length) throw new BadRequestException('Document metadata must be valid before approval');
    if (fm.confidentiality !== 'client_confidential') throw new BadRequestException('Firm-internal documents cannot be approved for client reports');
    if (!fm.document_id) throw new BadRequestException('Document is missing its revision identity');
    if (['firm_approved', 'client_approved'].includes(String(fm.authority)) && fm.source_of_truth === true) return doc;
    // Replace only metadata; source text and stable heading/table refs remain exact.
    const next = { ...fm, document_id: randomUUID(), authority: 'firm_approved', source_of_truth: true, supersedes: fm.document_id };
    const content = `---\n${Object.entries(next).map(([key, value]) => `${key}: ${value === null ? 'null' : typeof value === 'boolean' ? value : `"${value}"`}`).join('\n')}\n---\n${parsed.body}`;
    return this.upload(tenantId, user, { content, title: doc.title }, { id, checksum: expectedChecksum });
  }

  /** Resolve a document's target without treating archived plans as active context. */
  async association(tenantId: string, id: string) {
    const doc = await this.get(tenantId, id);
    if (doc.scope !== 'strategy' || !doc.scopeRef) return { state: 'not_strategy_scoped', strategy: null };
    const strategy = await this.prisma.withTenant(tenantId, (tx) => tx.spStrategy.findFirst({
      where: { id: doc.scopeRef! }, select: { id: true, title: true, clientId: true, archivedAt: true },
    }));
    if (!strategy) return { state: 'missing', strategy: null };
    if (strategy.clientId !== doc.clientId) return { state: 'client_mismatch', strategy: null };
    return { state: strategy.archivedAt ? 'archived' : 'active', strategy: { id: strategy.id, title: strategy.title } };
  }

  /**
   * F06 batched association projection for list surfaces (the Context
   * Library's cards). Same states as `association()`, resolved in ONE query
   * instead of one request per card: strategy-scoped documents are matched
   * against their target strategies in a single findMany keyed by scopeRef.
   */
  async associations(
    tenantId: string,
    ids: string[],
  ): Promise<Record<string, { state: string; strategy: { id: string; title: string } | null }>> {
    const unique = [...new Set(ids)].filter((id) => UUID_RE.test(id));
    if (unique.length === 0) return {};
    const docs = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spContextDocument.findMany({
        where: { id: { in: unique } },
        select: { id: true, clientId: true, scope: true, scopeRef: true },
      }),
    );
    const strategyRefs = [...new Set(docs.filter((d) => d.scope === 'strategy' && d.scopeRef).map((d) => d.scopeRef!))];
    const strategies = strategyRefs.length
      ? await this.prisma.withTenant(tenantId, (tx) =>
          tx.spStrategy.findMany({
            where: { id: { in: strategyRefs } },
            select: { id: true, title: true, clientId: true, archivedAt: true },
          }),
        )
      : [];
    const byId = new Map(strategies.map((s) => [s.id, s]));
    const out: Record<string, { state: string; strategy: { id: string; title: string } | null }> = {};
    for (const doc of docs) {
      if (doc.scope !== 'strategy' || !doc.scopeRef) {
        out[doc.id] = { state: 'not_strategy_scoped', strategy: null };
        continue;
      }
      const strategy = byId.get(doc.scopeRef);
      if (!strategy) {
        out[doc.id] = { state: 'missing', strategy: null };
        continue;
      }
      if (strategy.clientId !== doc.clientId) {
        out[doc.id] = { state: 'client_mismatch', strategy: null };
        continue;
      }
      out[doc.id] = {
        state: strategy.archivedAt ? 'archived' : 'active',
        strategy: { id: strategy.id, title: strategy.title },
      };
    }
    return out;
  }

  /** Reassignment creates an unapproved revision in the same client and preserves the source. */
  async reassign(tenantId: string, user: ContextUser, id: string, expectedChecksum: string, strategyId: string) {
    const doc = await this.get(tenantId, id);
    if (doc.state !== 'active' || doc.checksum !== expectedChecksum) throw new ConflictException('This document changed. Reload and review the current version before moving it.');
    if (doc.scope !== 'strategy' || !doc.clientId) throw new BadRequestException('Only a strategy document with a client can be reassigned.');
    if (doc.scopeRef === strategyId) throw new BadRequestException('Select a different strategy.');
    const parsed = parseFrontmatter(doc.content);
    const fm = parsed.frontmatter;
    if (!fm || parsed.errors.length || validateFrontmatter(fm).length) throw new BadRequestException('Document metadata must be valid before reassignment.');
    const next = { ...fm, document_id: randomUUID(), strategy_id: strategyId, authority: 'working_draft', source_of_truth: false, supersedes: fm.document_id };
    const content = `---\n${Object.entries(next).map(([key, value]) => `${key}: ${value === null ? 'null' : typeof value === 'boolean' ? value : `"${value}"`}`).join('\n')}\n---\n${parsed.body}`;
    return this.upload(tenantId, user, { content, title: doc.title }, { id, checksum: expectedChecksum, operation: 'reassign' });
  }

  /**
   * List documents with the DERIVED stale flag. Stale rows (validUntil strictly
   * before today) are excluded unless `includeStale` — a stale source of truth
   * should never silently feed downstream consumers.
   */
  async list(
    tenantId: string,
    opts: {
      clientId?: string;
      templateKey?: string;
      state?: string;
      includeStale?: boolean;
      includeFirm?: boolean;
      firmOnly?: boolean;
    } = {},
  ): Promise<ContextDocumentWithStale[]> {
    // ?state= is raw client input — validate against the enum so a bogus value
    // 400s instead of a PrismaClientValidationError 500 (Stage C list idiom).
    if (opts.state && !(Object.values(SpContextDocState) as string[]).includes(opts.state)) {
      throw new BadRequestException(
        `Invalid state '${opts.state}' — expected one of: ${Object.values(SpContextDocState).join(', ')}`,
      );
    }
    // ?clientId= feeds a uuid-typed column (@db.Uuid) — validate the shape so
    // a bogus value 400s instead of a Prisma P2023 500 (same idiom as ?state=).
    if (opts.clientId && !UUID_RE.test(opts.clientId)) {
      throw new BadRequestException(`Invalid clientId '${opts.clientId}' — expected a UUID`);
    }
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spContextDocument.findMany({
        where: {
          ...(opts.firmOnly ? { clientId: null, scope: 'firm' as const }
            : opts.clientId ? { AND: [opts.includeFirm ? { OR: [{ clientId: opts.clientId }, { clientId: null, scope: 'firm' as const }] } : { clientId: opts.clientId }] } : {}),
          ...(opts.templateKey ? { templateKey: opts.templateKey } : {}),
          ...(opts.state ? { state: opts.state as SpContextDocState } : {}),
          ...(!opts.includeStale ? {
            OR: [
              { validUntil: null },
              { validUntil: { gte: new Date(new Date().toISOString().slice(0, 10)) } },
            ],
          } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
    const withStale = rows.map((r) => ({ ...r, stale: isStale(r.validUntil) }));
    return opts.includeStale ? withStale : withStale.filter((r) => !r.stale);
  }

  /**
   * F06 (2026-09-10 remediation plan §4): server-backed availability
   * projection for the New-strategy overlay — what the intended DRAFT
   * operation can actually ground on, not a filtered inventory list.
   *
   * Scope policy mirrors the draft operation's grounding (StewardService
   * `factsForOrchestrator` with no strategyId): for a NEW strategy only
   * client-scope documents of the selected client and firm-scope documents are
   * eligible, and only while active and not stale. Strategy/node/once-scoped
   * material can never apply to a strategy that does not exist yet. Fact
   * counts include only facts whose PARENT document is eligible, filtered
   * before any row limit.
   *
   * The response is additive and read-only: eligible document ids, an
   * eligible fact count, per-reason exclusion counts, and an explicit
   * `truncated` flag when the eligible-document read hit its cap — a capped
   * read must never be presented as an authoritative total (the inventory
   * list's 200-row cap is exactly the defect this replaces).
   */
  async availability(
    tenantId: string,
    clientId: string,
    opts: { documentTakeLimit?: number } = {},
  ): Promise<{
    clientId: string;
    eligibleDocumentIds: string[];
    eligibleFactCount: number;
    excluded: {
      strategyScoped: number;
      nodeScoped: number;
      stale: number;
      retired: number;
    };
    truncated: boolean;
  }> {
    if (!UUID_RE.test(clientId)) {
      throw new BadRequestException(`Invalid clientId '${clientId}' — expected a UUID`);
    }
    const takeLimit = Math.min(Math.max(opts.documentTakeLimit ?? 500, 1), 500);
    const today = new Date(new Date().toISOString().slice(0, 10));

    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.spContextDocument.findMany({
        where: {
          OR: [{ clientId }, { clientId: null, scope: 'firm' as const }],
        },
        select: { id: true, scope: true, scopeRef: true, state: true, validUntil: true },
        take: takeLimit + 1,
        orderBy: { createdAt: 'desc' },
      });
      const truncated = rows.length > takeLimit;
      const candidates = truncated ? rows.slice(0, takeLimit) : rows;

      const eligibleIds: string[] = [];
      const excluded = { strategyScoped: 0, nodeScoped: 0, stale: 0, retired: 0 };
      for (const doc of candidates) {
        if (doc.state !== 'active') {
          // draft/superseded/archived rows are all unusable as working context
          // (draft-state documents were never approved for grounding).
          excluded.retired++;
          continue;
        }
        if (doc.validUntil && doc.validUntil < today) {
          excluded.stale++;
          continue;
        }
        // Positive scope eligibility — a scoped row with a missing scopeRef
        // (possible 'once' rows, see the unbound-context list tests) must fall
        // into its scope-kind exclusion, never into the eligible set.
        if (doc.scope === 'strategy') {
          excluded.strategyScoped++;
          continue;
        }
        if (doc.scope === 'node' || doc.scope === 'once') {
          excluded.nodeScoped++;
          continue;
        }
        eligibleIds.push(doc.id);
      }

      // Facts count only when BOTH the fact and its parent document are
      // eligible — the same where-clause the draft operation grounds on.
      const eligibleFactCount = await tx.spContextFact.count({
        where: {
          OR: [{ clientId }, { clientId: null }],
          state: 'active',
          documentId: { in: eligibleIds },
          document: {
            is: {
              tenantId,
              state: 'active',
              OR: [{ validUntil: null }, { validUntil: { gte: today } }],
            },
          },
        },
      });

      return { clientId, eligibleDocumentIds: eligibleIds, eligibleFactCount, excluded, truncated };
    });
  }

  async get(tenantId: string, id: string): Promise<ContextDocumentWithStale> {
    const doc = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spContextDocument.findFirst({ where: { id } }),
    );
    if (!doc) throw new NotFoundException('Context document not found');
    return { ...doc, stale: isStale(doc.validUntil) };
  }

  async archive(tenantId: string, user: ContextUser, id: string) {
    // Resolved OUTSIDE the tx: the membership lookup runs on the system
    // connection (tenant_memberships is FORCE-RLS and owned by apps/api), so it
    // must not be nested inside this service's tenant-scoped transaction.
    const isAdmin = await this.isOrgAdmin(tenantId, user);
    return this.prisma.withTenantUser(tenantId, user.clerkUserId, async (tx) => {
      const doc = await tx.spContextDocument.findFirst({ where: { id } });
      if (!doc) throw new NotFoundException('Context document not found');
      // SYMMETRY with upload: pinning a client/firm-scope doc requires an org
      // admin, so retiring one from rotation must too — otherwise any member
      // could un-pin an admin-pinned firm-wide source of truth.
      this.assertScopeAllowed(doc.scope, isAdmin, 'archival');
      if (doc.state === 'archived') {
        throw new ConflictException('Context document is already archived');
      }
      if (doc.state === 'superseded') {
        throw new ConflictException(
          'A superseded document is retained history — archive the active document instead',
        );
      }
      const updated = await tx.spContextDocument.update({
        where: { id },
        data: { state: 'archived', updatedByUserId: user.clerkUserId },
      });
      // Stage E symmetry with supersession: a retired document's ACTIVE facts
      // flip to `stale` in the SAME tx — otherwise they would keep grounding
      // every draft/assistant call and serving as conflict-pairing targets
      // forever (extract() 409s on non-active docs, so there is no re-extract
      // path to supersede them). Reviewer verdicts (rejected) are preserved.
      await tx.spContextFact.updateMany({
        where: { documentId: id, state: 'active' },
        data: { state: 'stale' },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: user.clerkUserId,
        authorKind: 'person',
        action: 'context_doc.archived',
        entityType: 'context_document',
        entityId: id,
        before: { state: doc.state },
        after: { state: 'archived' },
      });
      return updated;
    });
  }

  /** All sections + tables with their STABLE refs (LLM-free, line-exact). */
  async sections(tenantId: string, id: string) {
    const doc = await this.get(tenantId, id);
    return locateAll(doc.content);
  }

  /** Resolve one stable ref to exact content + line span; 404 when unknown. */
  async locate(tenantId: string, id: string, ref: string) {
    const doc = await this.get(tenantId, id);
    const result = locate(doc.content, ref);
    if (!result) throw new NotFoundException(`ref not found in document: ${ref}`);
    return result;
  }

  private badFrontmatter(errors: FieldError[]): BadRequestException {
    // The FieldError array rides in the response body so the client can
    // annotate each offending frontmatter key (the acceptance criterion).
    return new BadRequestException({
      statusCode: 400,
      message: 'front-matter validation failed',
      errors,
    });
  }

  /**
   * Resolve whether this caller is an org admin for the tenant.
   *
   * The Clerk claim alone is NOT sufficient. The deployed 'capiro' JWT template
   * emits only { capiro_tenant_id, capiro_tenant_slug, email, ... } — it carries
   * NO org_role/o.rol claim at all, so AuthTenantContext.role arrives `null` for
   * every browser request. The scope gate below then rejected real admins with
   * "client/firm-scope pinning requires an org admin" on any client- or
   * firm-scope upload. Fall back to the canonical local membership row
   * (tenant_memberships.role), which is the same source apps/api authorizes on,
   * so admin-ness is decided by Capiro's own record rather than an optional
   * token claim. Fails CLOSED: any lookup error is treated as not-admin.
   */
  private async isOrgAdmin(tenantId: string, user: ContextUser): Promise<boolean> {
    if (roleClaimIsAdmin(user.role)) return true;
    try {
      const rows = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<Array<{ role: string }>>`
          SELECT tm.role::text AS role
          FROM tenant_memberships tm
          JOIN users u ON u.id = tm.user_id
          WHERE tm.tenant_id = ${tenantId}::uuid
            AND u.clerk_user_id = ${user.clerkUserId}
            AND tm.status::text = 'active'
          LIMIT 1
        `,
      );
      const role = rows[0]?.role;
      return role === 'capiro_admin' || role === 'user_admin';
    } catch {
      return false;
    }
  }

  /**
   * The client/firm-scope org-admin gate, taking a pre-resolved admin verdict
   * (see isOrgAdmin — the Clerk role claim alone is not sufficient).
   */
  private assertScopeAllowed(
    scope: SpContextScope,
    isAdmin: boolean,
    verb: 'pinning' | 'archival' | 'supersession' = 'pinning',
  ): void {
    if (scope !== 'client' && scope !== 'firm') return;
    if (!isAdmin) {
      throw new ForbiddenException(`client/firm-scope ${verb} requires an org admin`);
    }
  }
}

/**
 * Clerk org role strings look like 'org:admin' / 'org:member' (or a bare custom
 * role). Gate on the segment after 'org:', case-insensitively. Exact-match
 * allowlist: tenants can define custom Clerk roles whose names merely CONTAIN
 * 'admin' (e.g. 'org:admin_readonly'); those must NOT pass.
 */
function roleClaimIsAdmin(role: string | null): boolean {
  const segment = role?.startsWith('org:') ? role.slice('org:'.length) : (role ?? '');
  return ['admin', 'administrator'].includes(segment.toLowerCase());
}

/** Shape check for uuid-typed query filters (Postgres uuid — any hex version). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bind ONE persisted identity column (clientId / scopeRef) from the validated
 * frontmatter id and the optional DTO field. The frontmatter is the contract:
 * when it declares an id, that value binds the row; a DTO value is accepted as
 * a fallback (frontmatter id null) or a confirmation — a CONTRADICTION between
 * the two is pushed as a field-level error, as is a frontmatter id that is not
 * a UUID (both columns are @db.Uuid — an unreplaced template placeholder like
 * 'client_123' must 400 with the offending field, not 500 at the database).
 */
function bindIdentity(
  errors: FieldError[],
  fmField: string,
  fmValue: string | boolean | null | undefined,
  dtoField: string,
  dtoValue: string | undefined,
): string | null {
  const fmId = typeof fmValue === 'string' && fmValue.trim() !== '' ? fmValue.trim() : null;
  const dtoId = dtoValue ?? null;
  if (fmId === null) return dtoId;
  if (!UUID_RE.test(fmId)) {
    errors.push({
      field: fmField,
      message: `'${fmId}' is not a UUID — fill in the real ${fmField} (template placeholders cannot bind a document)`,
    });
    return dtoId;
  }
  if (dtoId !== null && dtoId.toLowerCase() !== fmId.toLowerCase()) {
    errors.push({
      field: fmField,
      message: `frontmatter ${fmField} '${fmId}' contradicts the request's ${dtoField} '${dtoId}' — they must reference the same record`,
    });
  }
  return fmId;
}

/** First H1/H2 heading text of the body, for a default display title. */
function firstHeading(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#{1,2}\s+(.*?)\s*$/.exec(line);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Derived staleness: validUntil strictly before today's UTC calendar day. */
function isStale(validUntil: Date | null): boolean {
  if (!validUntil) return false;
  const todayUtcMidnight = Date.parse(new Date().toISOString().slice(0, 10));
  return validUntil.getTime() < todayUtcMidnight;
}
