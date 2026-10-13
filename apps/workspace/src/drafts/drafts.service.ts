import { createProspectDraft } from '../prospect-resources/prospect-draft-create.js';
import {
  withProspectDraft,
  assertProspectDraft,
  assertImmutableProspectInput,
} from '../prospect-resources/prospect-draft-access.js';
import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { preparationWorkspace } from './preparation-content.js';
import { editorialWorkspace } from './editorial-content.js';
import { researchWorkspace } from './research-content.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WSC } from '../cascade/cascade.config.js';
import { detectNames } from '../generation/anonymize.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit } from '../collaborators/role-policy.js';
import type { CreateDraftDto, UpdateDraftDto, ListDraftsQueryDto } from './dto/draft.dto.js';

/**
 * Drafts service (Phase 3, AC-3.3). Every method is tenant-scoped: tenantId is
 * a mandatory filter on every read AND a mandatory field on every write. There
 * is no path that can read or mutate another tenant's draft.
 *
 * Derivations on write:
 *  - isPacket / docCount  (handoff §12.10): packet = coverLetter || docs > 1.
 *  - ask                  (handoff §12.11): funding products carry {amount,pb,
 *                          delta}; non-funding persist "n/a". Human-set only —
 *                          never auto-populated.
 */
@Injectable()
export class DraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
  ) {}

  async create(
    tenantId: string,
    ownerId: string,
    dto: CreateDraftDto,
    transaction?: Prisma.TransactionClient,
  ): Promise<Prisma.WsDraftGetPayload<{ include: { documents: true } }>> {
    if (dto.prospectId && !transaction)
      return createProspectDraft(this.prisma, tenantId, ownerId, dto, (tx) =>
        this.create(tenantId, ownerId, dto, tx),
      );
    const db = transaction ?? this.prisma;
    const product = dto.product ?? '';
    const meta = product ? WSC.meta(product) : null;
    const sections = product ? WSC.suggestedSections(product) : [];
    const pages = product ? WSC.suggestedPages(product) : 2;
    const funding = product ? WSC.isFunding(product) : false;

    const config: Record<string, unknown> = {
      industry: dto.industry ?? null,
      product: product || null,
      client: dto.client ?? null,
      pathways: [],
      committees: [],
      personalize: meta?.personalize ?? false,
      // Personalization sub-questions ALWAYS default to "No" regardless of the
      // product meta — the user opts in per draft (correction: office/client
      // toggles must not pre-default to Yes for office-oriented products).
      officeAssociated: false,
      offices: [],
      clientAssociated: false,
      clientPersons: [],
      coverLetter: meta?.cover ?? false,
      selectedTemplate: null,
      sections,
      pages,
      tone: 'Formal',
      toneContext: '',
      linkedData: [],
      anonymize: false,
      letterhead: { custom: false, firmName: '', firmAddr: '' },
    };

    const draft = await db.wsDraft.create({
      data: {
        tenantId,
        ownerId,
        prospectId: dto.prospectId ?? null,
        lastEditedById: ownerId, // creator is the first/last editor
        docTitle: dto.docTitle ?? (product ? `${product} draft` : 'Untitled draft'),
        industry: dto.industry ?? null,
        product: product || null,
        client: dto.client ?? null,
        config: config as never,
        ask: funding ? { amount: '', pb: '', delta: '' } : 'n/a',
        isPacket: meta?.cover ?? false,
        docCount: 1,
      },
    });

    // Every draft starts with one primary document tab.
    await db.wsDocument.create({
      data: {
        tenantId,
        draftId: draft.id,
        name: product || 'Document',
        ordinal: 0,
        body: { blocks: [] },
      },
    });

    return transaction
      ? db.wsDraft.findFirstOrThrow({
          where: { tenantId, id: draft.id },
          include: { documents: { orderBy: { ordinal: 'asc' } } },
        })
      : this.byId(tenantId, draft.id);
  }

  /** All three Workspace steps and the source receipt commit together. An
   * acknowledgement lost after this transaction resumes into the same draft.
   * `prefill` is fetched from the authoritative Intel action by the controller.
   */
  async createPreparation(
    tenantId: string,
    ownerId: string,
    sourceKey: string,
    prefill: { draft: { docTitle: string }; context: Record<string, unknown>; sources: unknown[] },
  ) {
    return this.createSourceDraft(
      tenantId,
      ownerId,
      sourceKey,
      prefill,
      'legiwatch_preparation',
      preparationWorkspace,
    );
  }
  async createResearch(
    tenantId: string,
    ownerId: string,
    sourceKey: string,
    prefill: { draft: { docTitle: string }; context: Record<string, unknown>; sources: unknown[] },
  ) {
    return this.createSourceDraft(
      tenantId,
      ownerId,
      sourceKey,
      prefill,
      'legiwatch_research',
      researchWorkspace,
    );
  }
  async createEditorial(
    tenantId: string,
    ownerId: string,
    sourceKey: string,
    prefill: { draft: { docTitle: string }; context: Record<string, unknown>; sources: unknown[] },
  ) {
    return this.createSourceDraft(
      tenantId,
      ownerId,
      sourceKey,
      prefill,
      'legiwatch_editorial',
      editorialWorkspace,
    );
  }
  private async createSourceDraft(
    tenantId: string,
    ownerId: string,
    sourceKey: string,
    prefill: { draft: { docTitle: string }; context: Record<string, unknown>; sources: unknown[] },
    sourceType: string,
    render: (prefill: { context: Record<string, unknown>; sources: unknown[] }) => {
      config: Record<string, unknown>;
      contextItem: { payload: Record<string, unknown> };
    },
  ) {
    const inputHash = createHash('sha256').update(JSON.stringify(prefill)).digest('hex');
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
        const members = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT u.id FROM users u JOIN tenant_memberships m ON m.user_id=u.id
        WHERE m.tenant_id=${tenantId}::uuid AND u.clerk_user_id=${ownerId} AND m.status::text='active' FOR SHARE OF m`;
        if (!members.length) throw new ForbiddenException('ACTIVE_WORKFLOW_OWNER_REQUIRED');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + ownerId + ':' + sourceKey},0))`;
        const [prior] = await tx.$queryRaw<
          Array<{ input_hash: string; draft_id: string; context_item_id: string }>
        >`SELECT input_hash,draft_id,context_item_id FROM ws_source_action
        WHERE tenant_id=${tenantId}::uuid AND owner_id=${ownerId} AND source_type=${sourceType} AND source_key=${sourceKey}`;
        if (prior) {
          if (prior.input_hash !== inputHash)
            throw new ConflictException('SOURCE_ACTION_INPUT_CHANGED');
          const draft = await tx.wsDraft.findFirst({
            where: { tenantId, ownerId, id: prior.draft_id },
          });
          if (!draft) throw new ConflictException('SOURCE_DRAFT_REMOVED_OR_OWNERSHIP_CHANGED');
          const context = await tx.wsContextItem.findFirst({
            where: { tenantId, draftId: prior.draft_id, id: prior.context_item_id },
          });
          if (!context) throw new ConflictException('SOURCE_CONTEXT_REMOVED_REVIEW_EXISTING_DRAFT');
          return {
            draftId: prior.draft_id,
            contextItemId: prior.context_item_id,
            state: 'complete',
            replayed: true,
          };
        }
        const draft = await this.create(tenantId, ownerId, prefill.draft, tx),
          prepared = render(prefill);
        await tx.wsDraft.updateMany({
          where: { tenantId, id: draft.id, ownerId },
          data: {
            config: { ...(draft.config as Record<string, unknown>), ...prepared.config } as never,
          },
        });
        const item = await tx.wsContextItem.create({
          data: {
            tenantId,
            draftId: draft.id,
            kind: 'free-text',
            payload: prepared.contextItem.payload as never,
          },
        });
        await tx.$executeRaw`INSERT INTO ws_source_action(tenant_id,owner_id,source_type,source_key,input_hash,draft_id,context_item_id)
        VALUES(${tenantId}::uuid,${ownerId},${sourceType},${sourceKey},${inputHash},${draft.id}::uuid,${item.id}::uuid)`;
        return { draftId: draft.id, contextItemId: item.id, state: 'complete', replayed: false };
      },
      { timeout: 30000 },
    );
  }

  /**
   * Fetch one draft. Tenant-scoped first. When `actorId` is supplied (the
   * authenticated reader, from the controller), the draft is PRIVATE: only its
   * owner or an active collaborator may read it. A non-collaborator gets 404
   * (not 403) so the endpoint never confirms a foreign draft's existence by id.
   * Internal callers (create/update return paths) omit actorId — access was
   * already established by the write they just performed.
   */
  async byId(tenantId: string, id: string, actorId?: string, signal?: AbortSignal) {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id, tenantId },
      include: { documents: { orderBy: { ordinal: 'asc' } } },
    });
    if (!draft) throw new NotFoundException('Draft not found');
    if (actorId) {
      const role = await this.collaborators.resolveRole(tenantId, id, actorId, signal);
      if (!role) throw new NotFoundException('Draft not found');
    }
    await assertProspectDraft(this.prisma, draft, actorId);
    return draft;
  }

  /**
   * List the drafts a user can see. Documents are PRIVATE to their author until
   * explicitly shared: a user sees a draft only if they OWN it or are an active
   * collaborator on it. Everything is tenant-scoped first (no cross-tenant
   * leakage), then narrowed by ownership/share:
   *   - 'mine'   → drafts I own
   *   - 'shared' → drafts shared with me (an active collaborator row), not mine
   *   - default  → "all I have access to" = mine + shared-with-me (NOT every
   *                document in the tenant)
   */
  async list(tenantId: string, ownerId: string, q: ListDraftsQueryDto) {
    const shared = await this.prisma.wsCollaborator.findMany({
      where: { tenantId, subjectId: ownerId, status: 'active' },
      select: { draftId: true },
    });
    const sharedIds = shared.map((s) => s.draftId);

    const where: Record<string, unknown> = { tenantId };
    if (q.sector) where.industry = q.sector;
    if (q.prospectId) where.prospectId = q.prospectId;
    if (q.scope === 'mine') {
      where.ownerId = ownerId;
    } else if (q.scope === 'shared') {
      where.id = { in: sharedIds };
      where.ownerId = { not: ownerId };
    } else {
      where.OR = [{ ownerId }, { id: { in: sharedIds } }];
    }
    // Slim list projection only. Returning full ws_draft rows (especially the
    // giant config JSONB) produced multi-MB dashboard payloads on
    // GET /workspace-api/drafts?scope=all and froze/whited os.capiro.ai after
    // first paint. Prisma cannot nested-select keys out of a Json column, so
    // we omit `config` entirely from the list query. Library agent
    // phase/status/quality come from GET /agent on open; list stays lean.
    const rows = await this.prisma.wsDraft.findMany({
      where: where as never,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        tenantId: true,
        ownerId: true,
        lastEditedById: true,
        docTitle: true,
        industry: true,
        product: true,
        client: true,
        prospectId: true,
        versions: {
          select: { id: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        status: true,
        isPacket: true,
        docCount: true,
        ask: true,
        createdAt: true,
        updatedAt: true,
        documents: { select: { id: true } },
      },
    });

    // Never reintroduce config. phase/qualityScore stay undefined on list;
    // status is the draft column (not agent run-status).
    const allowed = [];
    for (const row of rows) {
      if (!(await this.collaborators.sourceAccess(tenantId, row.id, ownerId))) continue;
      try {
        await assertProspectDraft(this.prisma, row, ownerId);
        allowed.push(row);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    const drafts = allowed.map((row) => {
      const { config: _config, ...rest } = row as typeof row & { config?: unknown };
      return {
        ...rest,
        phase: undefined as string | undefined,
        qualityScore: null as number | null,
      };
    });

    return { drafts };
  }

  /**
   * Patch / autosave. Merges partial config into the persisted blob, promotes
   * hot fields, re-derives isPacket/docCount, and enforces the funding-only ask
   * rule. tenantId is checked first (no cross-tenant writes).
   */
  async update(tenantId: string, id: string, actorId: string, dto: UpdateDraftDto) {
    assertImmutableProspectInput(dto);
    const existing = await this.prisma.wsDraft.findFirst({
      where: { id, tenantId },
      include: { documents: { select: { id: true } } },
    });
    if (!existing) throw new NotFoundException('Draft not found');
    // Editing the draft is owner + editor only (role matrix).
    await this.collaborators.assertCan(
      tenantId,
      id,
      actorId,
      canEdit,
      'Only owners and editors can edit this document',
    );

    return withProspectDraft(this.prisma, existing, actorId, canEdit, 'write', async (db) => {
      // Prospect writes hold the parent lock. Re-read before merging so a queued
      // legacy autosave cannot restore config/doc counts read before a copy save.
      const current = existing.prospectId
        ? await db.wsDraft.findFirstOrThrow({
            where: { id, tenantId },
            include: { documents: { select: { id: true } } },
          })
        : existing;
      const mergedConfig: Record<string, unknown> = {
        ...(current.config as Record<string, unknown>),
        ...(dto.config ?? {}),
      };

      const product = dto.product ?? current.product ?? '';
      const funding = product ? WSC.isFunding(product) : false;
      const coverLetter = Boolean(
        (mergedConfig.coverLetter as boolean | undefined) ?? current.isPacket,
      );
      const docCount = current.documents.length;
      const isPacket = coverLetter || docCount > 1;

      // Funding-only ask. Non-funding products always store "n/a"; never auto-fill.
      let ask: unknown = current.ask;
      if (dto.ask !== undefined) {
        ask = funding ? dto.ask : 'n/a';
      } else if (!funding) {
        ask = 'n/a';
      }

      const updated = await db.wsDraft.update({
        where: { id },
        data: {
          ...(dto.docTitle !== undefined ? { docTitle: dto.docTitle } : {}),
          ...(dto.industry !== undefined ? { industry: dto.industry } : {}),
          ...(dto.product !== undefined ? { product: dto.product } : {}),
          ...(dto.client !== undefined ? { client: dto.client } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          lastEditedById: actorId, // stamp who last edited (for the Documents list)
          config: mergedConfig as never,
          ask: ask as never,
          isPacket,
          docCount,
        },
      });
      return db.wsDraft.findFirstOrThrow({
        where: { tenantId, id: updated.id },
        include: { documents: { orderBy: { ordinal: 'asc' } } },
      });
    });
  }

  /**
   * Anonymize review — detect candidate names (client, offices, program/product)
   * across the draft's title + section bodies (handoff §12.13). Tenant-scoped.
   * The web modal lets the user approve/reject + set scope/replacement per item;
   * this only surfaces the candidates and their occurrence counts.
   */
  async detectAnonymizeNames(tenantId: string, id: string, actorId?: string) {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id, tenantId } });
    if (!draft) throw new NotFoundException('Draft not found');
    await assertProspectDraft(this.prisma, draft, actorId);
    const cfg = draft.config as Record<string, unknown>;
    const sectionContent = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
    const sections = (cfg.sections as string[] | undefined) ?? [];
    const sectionTexts = [...sections, ...Object.values(sectionContent)];
    const detections = detectNames({
      client: (cfg.client as string | null) ?? draft.client,
      product: draft.product,
      offices: (cfg.offices as string[] | undefined) ?? [],
      title: draft.docTitle,
      sectionTexts,
    });
    return { detections };
  }

  async remove(tenantId: string, id: string, actorId: string): Promise<{ deleted: boolean }> {
    const existing = await this.prisma.wsDraft.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('Draft not found');
    // Deleting a document is owner + editor only (role matrix) — a teammate it
    // was merely shared with as reviewer/commenter/viewer cannot destroy it.
    await this.collaborators.assertCan(
      tenantId,
      id,
      actorId,
      canEdit,
      'Only owners and editors can delete this document',
    );
    await withProspectDraft(this.prisma, existing, actorId, canEdit, 'read', (db) =>
      db.wsDraft.delete({ where: { id } }),
    );
    return { deleted: true };
  }
}
