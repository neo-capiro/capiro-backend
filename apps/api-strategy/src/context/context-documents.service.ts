import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
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

  async upload(tenantId: string, user: ContextUser, dto: UploadContextDocumentDto) {
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
    this.assertCanPinScope(scope, user.role);

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
        active = fmSupersedes
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
          this.assertCanPinScope(active.scope, user.role, 'supersession');
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
      return created;
    });
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
          ...(opts.clientId ? { clientId: opts.clientId } : {}),
          ...(opts.templateKey ? { templateKey: opts.templateKey } : {}),
          ...(opts.state ? { state: opts.state as SpContextDocState } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
    const withStale = rows.map((r) => ({ ...r, stale: isStale(r.validUntil) }));
    return opts.includeStale ? withStale : withStale.filter((r) => !r.stale);
  }

  async get(tenantId: string, id: string): Promise<ContextDocumentWithStale> {
    const doc = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spContextDocument.findFirst({ where: { id } }),
    );
    if (!doc) throw new NotFoundException('Context document not found');
    return { ...doc, stale: isStale(doc.validUntil) };
  }

  async archive(tenantId: string, user: ContextUser, id: string) {
    return this.prisma.withTenantUser(tenantId, user.clerkUserId, async (tx) => {
      const doc = await tx.spContextDocument.findFirst({ where: { id } });
      if (!doc) throw new NotFoundException('Context document not found');
      // SYMMETRY with upload: pinning a client/firm-scope doc requires an org
      // admin, so retiring one from rotation must too — otherwise any member
      // could un-pin an admin-pinned firm-wide source of truth.
      this.assertCanPinScope(doc.scope, user.role, 'archival');
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

  private assertCanPinScope(
    scope: SpContextScope,
    role: string | null,
    verb: 'pinning' | 'archival' | 'supersession' = 'pinning',
  ): void {
    if (scope !== 'client' && scope !== 'firm') return;
    // Clerk org role strings look like 'org:admin' / 'org:member' (or a bare
    // custom role). Gate on the segment after 'org:', case-insensitively.
    // Exact-match allowlist: tenants can define custom Clerk roles whose names
    // merely CONTAIN 'admin' (e.g. 'org:admin_readonly'); those must NOT pass.
    const segment = role?.startsWith('org:') ? role.slice('org:'.length) : (role ?? '');
    if (!['admin', 'administrator'].includes(segment.toLowerCase())) {
      throw new ForbiddenException(`client/firm-scope ${verb} requires an org admin`);
    }
  }
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
