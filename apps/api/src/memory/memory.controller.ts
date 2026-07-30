import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import type { TenantContext } from '@capiro/shared';
import { MemoryStoreService } from './memory-store.service.js';
import { MemoryPurgeService } from './memory-purge.service.js';
import { daysOverdue } from './memory-staleness.helpers.js';
import { MemoryFkLoader } from './memory-fk-loader.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import { MemoryInterviewService } from './memory-interview.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryAccessGrantService } from './memory-access-grant.service.js';
import { MemoryConflictService } from './memory-conflict.service.js';
import {
  governedMemoryEnforcementEnabled,
  MEMORY_PERMISSIONS,
} from './memory-authorization.helpers.js';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';
import type { MemoryItemType } from './memory.types.js';
import { buildKnowledgeGraph, walkFrom } from './memory-graph.helpers.js';
import {
  MEMORY_CATALOG,
  fileDefForType,
  editableSectionKeys,
  skeletonSections,
} from './memory-catalog.js';
import { buildInterviewQuestions } from './memory-interview.helpers.js';
import {
  toManifestRow,
  selectForExport,
  type ExportManifestRow,
} from './memory-governance.helpers.js';

/**
 * Memory retrieval + knowledge-graph surface.
 *
 * Read endpoints scope via withTenant + RLS (caller's tenant only, plus their
 * own private items). The graph merges authoritative DB foreign keys (from
 * MemoryFkLoader, origin='fk') with analyst wikilink edges (origin='mention').
 *
 * Routes:
 *   GET  /memory/items                      list items the caller may see
 *   GET  /memory/items/:type/:slug/markdown Obsidian-format projection
 *   GET  /memory/export[?clientId=&type=]   provenance manifest (read-only)
 *   GET  /memory/candidates?status=pending  (1B, admin) firm-scope save review queue
 *   POST /memory/candidates/:id/approve     (1B, admin) commit a pending candidate
 *   POST /memory/candidates/:id/reject      (1B, admin) reject a pending candidate
 *   GET  /memory/graph[?seed=&depth=]       full graph or a focused walk
 *   GET  /memory/graph/client/:clientId     per-client subgraph (view #1)
 *   GET  /memory/graph/path?to=office:<id>  shortest paths to a target (view #2)
 *   POST /memory/backfill                    (admin) populate from DB sources
 *
 *   POST /memory/purge/client/:clientId     (Phase 6, admin) offboarding purge
 *
 * Phase 6 wires retention EXECUTION: client-offboarding purge removes a client's
 * memory across every store (legal-held rows excluded), dry-run by default and
 * gated behind MEMORY_PURGE_ENABLED (503 while off). See MemoryPurgeService.
 */
@Controller('memory')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryController {
  constructor(
    private readonly store: MemoryStoreService,
    private readonly fkLoader: MemoryFkLoader,
    private readonly ingest: MemoryIngestService,
    private readonly interview: MemoryInterviewService,
    private readonly candidates: MemoryCandidateService,
    private readonly purge: MemoryPurgeService,
    private readonly authz: MemoryAuthorizationService,
    private readonly grants: MemoryAccessGrantService,
    private readonly conflicts: MemoryConflictService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Section catalog (help text + examples + interview questions source). */
  @Get('catalog')
  catalog() {
    return MEMORY_CATALOG;
  }

  @Get('items')
  async listItems(@Query('clientId') clientId?: string, @Query('type') type?: MemoryItemType) {
    const items = await this.store.listForCurrentTenant({ clientId, type });
    return items.map((i) => ({
      id: i.id,
      type: i.type,
      slug: i.slug,
      title: i.title,
      clientId: i.clientId,
      visibility: i.visibility,
      entityId: i.entityId,
      updatedAt: i.updatedAt,
    }));
  }

  /**
   * P2 — memories past their review cadence (§3.2/§12.6). Surfacing only:
   * these are still recalled; the list flags what a reviewer should reconfirm.
   * `daysOverdue` sorts the worst first. standard_user (own + tenant-visible).
   */
  @Get('review-due')
  async listReviewDue() {
    const items = await this.store.listReviewDue();
    const now = new Date();
    return items.map((i) => ({
      id: i.id,
      type: i.type,
      slug: i.slug,
      title: i.title,
      clientId: i.clientId,
      visibility: i.visibility,
      reviewCadenceDays: i.reviewCadenceDays,
      lastConfirmedAt: i.lastConfirmedAt,
      daysOverdue: daysOverdue(
        {
          reviewCadenceDays: i.reviewCadenceDays,
          lastConfirmedAt: i.lastConfirmedAt,
          createdAt: i.createdAt,
        },
        now,
      ),
    }));
  }

  @Get('items/:type/:slug/markdown')
  async itemMarkdown(@Param('type') type: MemoryItemType, @Param('slug') slug: string) {
    const item = await this.store.getByTypeSlug(type, slug);
    if (!item) throw new NotFoundException('memory item not found');
    return this.store.project(item);
  }

  /**
   * Structured read for the Settings editor: the item's sections plus the
   * catalog help (prompt + example) joined per section, so the UI renders the
   * editor + greyed guidance in one shot. When the file doesn't exist yet,
   * returns the catalog SKELETON (empty human sections) instead of 404, so the
   * editor + "Fill with Meri" drafts have somewhere to render and save.
   */
  @Get('items/:type/:slug/sections')
  async itemSections(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: MemoryItemType,
    @Param('slug') slug: string,
  ) {
    const def = fileDefForType(type);
    // User-scope files are keyed on the caller's own id server-side (the client
    // sends slug='me' as a placeholder). The PUT stores under ctx.userId, so the
    // GET must read the SAME slug — otherwise the saved text never reads back and
    // the editor shows the empty skeleton despite a successful save.
    const effectiveSlug = def?.scope === 'user' ? ctx.userId : slug;
    const item = await this.store.getByTypeSlug(type, effectiveSlug);
    const helpByKey = new Map((def?.sections ?? []).map((s) => [s.key, s]));
    const sections = item ? item.sections : skeletonSections(type);
    if (!item && !def) throw new NotFoundException('unknown memory file type');
    return {
      type,
      slug,
      title: item?.title ?? def?.label ?? type,
      visibility: item?.visibility ?? (def?.scope === 'user' ? 'user' : 'tenant'),
      clientId: item?.clientId ?? null,
      updatedAt: item?.updatedAt ?? null,
      exists: !!item,
      sections: sections.map((s) => ({
        key: s.key,
        heading: s.heading,
        owner: s.owner,
        body: s.body,
        prompt: helpByKey.get(s.key)?.prompt ?? '',
        example: helpByKey.get(s.key)?.example ?? '',
      })),
    };
  }

  /**
   * Create-or-save edited human sections. User-scoped files (My Profile, My
   * Writing Style) are writable by their owner (any role). Firm/client files
   * require user_admin. Engine sections are never writable (allowlist guard).
   * Creates the file from the catalog skeleton on first save, so brand-new
   * files and Meri-drafted content persist. RLS keeps writes within the tenant.
   */
  @Put('items/:type/:slug/sections')
  async updateSections(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: MemoryItemType,
    @Param('slug') slug: string,
    @Body() body: { sections: Array<{ key: string; body: string }> },
  ) {
    const def = fileDefForType(type);
    if (!def) throw new NotFoundException('unknown memory file type');
    const scope = def.scope;
    const isAdmin = ctx.role === 'user_admin' || ctx.role === 'capiro_admin';
    if (scope !== 'user' && !isAdmin) {
      throw new ForbiddenException('Editing firm and client memory requires an admin role.');
    }
    // User files key on the caller's own id — ignore any slug spoof.
    const effectiveSlug = scope === 'user' ? ctx.userId : slug;
    const clientId = scope === 'client' ? slug : null;
    // Ethical wall (fail-closed, binds admins too): a non-granted user must not
    // WRITE a walled client's file. Without this, the wall hides the existing
    // row from the read path, so upsertSections would rebuild it from the
    // catalog skeleton and clobber the real content via the RLS-bypassing
    // upsertSystem. 403 loudly rather than silently corrupt.
    if (clientId && !(await this.store.clientMemoryAllowedForCurrentUser(clientId))) {
      throw new ForbiddenException('This client is behind an ethical wall you are not granted.');
    }
    // Governed-memory authority (Phase 3). The checks above cover role and the
    // ethical wall; this adds what they do not — legal hold, terminal
    // (revoked/superseded) status, explicit per-client edit grants, and the real
    // actor role under impersonation. Only applied to an EXISTING item: this route
    // also creates a file from the catalog skeleton on first save, and there is no
    // subject to authorize yet in that case.
    if (governedMemoryEnforcementEnabled(process.env.MEMORY_GOVERNANCE_ENFORCE)) {
      const existing = await this.store.getByTypeSlug(type, effectiveSlug);
      if (existing) await this.authz.requireItem(ctx, existing.id, 'edit');
    }
    const updated = await this.store.upsertSectionsForCurrentTenant(
      type,
      effectiveSlug,
      scope,
      clientId,
      body?.sections ?? [],
      editableSectionKeys(type),
    );
    return { ok: true, updatedAt: updated.updatedAt };
  }

  /**
   * Export manifest — Phase 4 governance (plan §11.2), read-only. Returns a
   * provenance row per item the caller may see (RLS-scoped: tenant-shared
   * items plus the caller's own private items), same shape an e-discovery or
   * "export my context" download would use. Optionally narrow to one client
   * or memory type. Does not delete or modify anything.
   */
  @Get('export')
  async exportManifest(
    @Query('clientId') clientId?: string,
    @Query('type') type?: MemoryItemType,
  ): Promise<{ rows: ExportManifestRow[] }> {
    const items = await this.store.listForCurrentTenant({ clientId, type });
    return { rows: selectForExport(items).map(toManifestRow) };
  }

  /**
   * Firm-scope save_memory review queue (Phase 1, 1B). A non-admin's
   * firm-scope save no longer dead-ends in a rejection message — it lands
   * here as a real pending candidate any admin can approve or reject.
   */
  @Get('candidates')
  @Roles('user_admin')
  async listCandidates(@CurrentTenant() ctx: TenantContext) {
    return { candidates: await this.candidates.listPending(ctx.tenantId, ctx.userId) };
  }

  /**
   * Approve a pending candidate.
   *
   * `listPending` already withholds candidates for walled clients, but the WALL
   * ONLY FILTERED THE LIST — the decision routes went straight to
   * MemoryCandidateService and never consulted it, so a non-granted admin who knew
   * (or guessed) a candidate id could ratify a walled client's memory. The
   * candidate service now evaluates the canonical authorization decision while
   * holding the candidate row lock, in the same transaction as activation. It
   * applies the ethical wall, legal hold, per-client grants, and self-review rule.
   * Governed enforcement remains dark until the additive migration is applied;
   * the independent-review check remains always on.
   */
  @Post('candidates/:id/approve')
  @Roles('user_admin')
  async approveCandidate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    // Candidate authorization now runs inside the row-locked activation
    // transaction. This removes the pre-check/commit race while preserving the
    // dark enforcement switch and the always-on independent-review gate.
    const { memoryId } = await this.candidates.approve(ctx.tenantId, id, ctx.userId, ctx);
    return { ok: true, memoryId };
  }

  @Post('candidates/:id/reject')
  @Roles('user_admin')
  async rejectCandidate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    await this.candidates.reject(ctx.tenantId, id, ctx.userId, ctx);
    return { ok: true };
  }

  // ── Governed memory grants (memory_access_grant) ──────────────────────────
  //
  // MemoryAuthorizationService has READ this table since Phase 3, but nothing
  // could write it, so an explicit per-client edit/review/approve grant could only
  // be created by hand-written SQL. All three routes are admin-only AND bound by
  // the ethical wall inside MemoryAccessGrantService, so a walled admin cannot
  // grant themselves in. Dark behind MEMORY_GOVERNANCE_LIFECYCLE: the table only
  // exists after 20260729010000, which is unapplied everywhere.

  @Get('clients/:clientId/grants')
  @Roles('user_admin')
  async listGrants(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    this.requireGovernanceArmed();
    return { grants: await this.grants.list(ctx, clientId) };
  }

  @Post('clients/:clientId/grants')
  @Roles('user_admin')
  async createGrant(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: { userId?: string; permissions?: unknown; reason?: string; expiresAt?: string },
  ) {
    this.requireGovernanceArmed();
    if (!body?.userId) throw new BadRequestException('userId is required.');
    const result = await this.grants.grant(ctx, clientId, {
      userId: body.userId,
      permissions: body.permissions,
      reason: body.reason ?? null,
      expiresAt: body.expiresAt ?? null,
    });
    return { ok: true, ...result };
  }

  @Delete('clients/:clientId/grants/:userId')
  @Roles('user_admin')
  async revokeGrant(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('userId') userId: string,
  ) {
    this.requireGovernanceArmed();
    return { ok: true, ...(await this.grants.revoke(ctx, clientId, userId)) };
  }

  /** The permission vocabulary the grant body must draw from (UI + API discovery). */
  @Get('grants/permissions')
  grantPermissions() {
    return { permissions: MEMORY_PERMISSIONS };
  }

  /**
   * Resolve a memory conflict by naming the controlling item. Authorized with the
   * 'resolve_conflict' operation, which already exists in MEMORY_PERMISSIONS and in
   * memory_access_grant_permissions_check.
   */
  @Post('items/:id/conflicts/resolve')
  async resolveConflict(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { controllingItemId?: string; reason?: string },
  ) {
    this.requireGovernanceArmed();
    if (!body?.controllingItemId) {
      throw new BadRequestException('controllingItemId is required.');
    }
    const result = await this.conflicts.resolve(ctx, id, body.controllingItemId, body.reason ?? '');
    return { ok: true, ...result };
  }

  /**
   * 503 rather than a 500 on a missing relation. These routes touch tables/columns
   * from 20260729010000 / 20260729011000, and neither migration is applied in any
   * environment — so until the switch is armed the honest answer is "not available
   * here", not a Postgres error leaking through.
   */
  private requireGovernanceArmed(): void {
    if (!governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE)) {
      throw new ServiceUnavailableException(
        'Governed memory management is disabled (MEMORY_GOVERNANCE_LIFECYCLE is not "enforce").',
      );
    }
  }

  /** Interview questions for a memory type (the Meri-guided fill flow). */
  @Get('interview/:type/questions')
  interviewQuestions(@Param('type') type: MemoryItemType) {
    return { type, questions: buildInterviewQuestions(type) };
  }

  /**
   * Draft section text from collected Q&A answers (Meri polishes each answer
   * into section prose, obeying Capiro AI rules). Returns the drafted sections
   * for preview; saving is a separate PUT so the user can edit first.
   */
  @Post('interview/:type/draft')
  async interviewDraft(
    @Param('type') type: MemoryItemType,
    @Body() body: { answers: Array<{ sectionKey: string; answer: string }> },
  ) {
    const sections = await this.interview.draftSections(type, body?.answers ?? []);
    return { type, sections };
  }

  /**
   * Knowledge graph for the Intelligence Center tab (Phase 3, criterion #5).
   * Merges DB FK relations (passed by callers / future FK loader) with the
   * tenant's wikilink edges. `seed` + `depth` optionally return a subgraph
   * answering "history with this entity".
   */
  @Get('graph')
  async graph(@Query('seed') seed?: string, @Query('depth') depth?: string) {
    const full = await this.buildFullGraph();
    if (seed) {
      return walkFrom(full, seed, depth ? Math.max(1, parseInt(depth, 10) || 1) : 2);
    }
    return full;
  }

  /** View #1: per-client subgraph — everything within `depth` hops of a client. */
  @Get('graph/client/:clientId')
  async clientGraph(@Param('clientId') clientId: string, @Query('depth') depth?: string) {
    // Ethical wall: an explicit request for a walled client's subgraph fails
    // loudly (403) rather than returning a silently-empty graph, so the UI can
    // explain the wall instead of looking broken.
    if (!(await this.store.clientMemoryAllowedForCurrentUser(clientId))) {
      throw new ForbiddenException('This client is behind an ethical wall you are not granted.');
    }
    const full = await this.buildFullGraph();
    return walkFrom(full, `client:${clientId}`, depth ? Math.max(1, parseInt(depth, 10) || 1) : 2);
  }

  /**
   * View #2: "find a path to this entity" — returns the subgraph around the
   * target plus the set of shortest paths from each client to it, so a
   * lobbyist sees the warm route ("who do we already know near this office?").
   */
  @Get('graph/path')
  async pathTo(@Query('to') to?: string, @Query('depth') depth?: string) {
    if (!to) return { nodes: [], edges: [], paths: [] };
    const full = await this.buildFullGraph();
    const sub = walkFrom(full, to, depth ? Math.max(1, parseInt(depth, 10) || 1) : 3);
    const clients = sub.nodes.filter((n) => n.type === 'client').map((n) => n.id);
    // Build the undirected adjacency ONCE and reuse it for every client seed —
    // shortestPath used to rebuild it on every call, making this O(clients × edges).
    const adj = buildAdjacency(full.edges);
    const paths = clients
      .map((c) => shortestPath(adj, c, to))
      .filter((p): p is string[] => p !== null);
    return { ...sub, paths };
  }

  /**
   * Populate the graph from DB sources (clients, ClioMemory, meetings) for the
   * caller's tenant. Open to any viewer (standard_user): it is tenant-scoped and
   * idempotent — reads only the caller's own tenant data and upserts by stable
   * slug (no duplicates, no deletes, no cross-tenant access). Each projected
   * item keeps its correct visibility/owner, so a non-admin trigger never leaks
   * another user's private memory into the shared graph.
   */
  @Post('backfill')
  async backfill() {
    const counts = await this.ingest.backfillCurrentTenant();
    return { ok: true, counts };
  }

  /**
   * Phase 6 — client-offboarding retention purge. Admin-only, gated behind
   * MEMORY_PURGE_ENABLED (503 while off). Dry-run by default (counts only);
   * an actual delete requires body.dryRun===false AND body.confirm to equal the
   * client's exact name (fat-finger guard). Legal-held rows are never deleted.
   */
  @Post('purge/client/:clientId')
  @Roles('user_admin')
  async purgeClient(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: { dryRun?: boolean; reason?: string; confirm?: string },
  ) {
    if (!this.config.get('MEMORY_PURGE_ENABLED', { infer: true })) {
      throw new ServiceUnavailableException(
        'Memory purge is disabled (MEMORY_PURGE_ENABLED=false).',
      );
    }
    if (!body?.reason || typeof body.reason !== 'string') {
      throw new BadRequestException('A reason is required for a client memory purge.');
    }
    const dryRun = body.dryRun !== false;
    if (!dryRun) {
      // Destructive path: require the caller to retype the client's exact name.
      const client = await this.store.getClientNameForCurrentTenant(clientId);
      if (!client) throw new NotFoundException('Client not found in this tenant.');
      if (body.confirm !== client.name) {
        throw new BadRequestException(
          'To execute a purge, `confirm` must equal the client name exactly.',
        );
      }
    }
    const result = await this.purge.purgeClient(
      ctx.tenantId,
      clientId,
      { userId: ctx.userId, role: ctx.role },
      { dryRun, reason: body.reason },
    );
    return { ok: true, ...result };
  }

  private async buildFullGraph() {
    const [{ wikiEdges, itemNodes }, fkRelations] = await Promise.all([
      this.store.loadGraphInputs(),
      this.fkLoader.loadForCurrentTenant(),
    ]);
    const itemNodeById = new Map(
      itemNodes.map((n) => [n.itemId, { type: n.type, slug: n.slug, label: n.label }]),
    );
    return buildKnowledgeGraph(fkRelations, wikiEdges, itemNodeById);
  }
}

/** Undirected adjacency map over the graph edges — built once, reused per source. */
function buildAdjacency(edges: Array<{ src: string; dst: string }>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const push = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of edges) {
    push(e.src, e.dst);
    push(e.dst, e.src);
  }
  return adj;
}

/** BFS shortest path between two node ids over a prebuilt undirected adjacency map. */
function shortestPath(adj: Map<string, string[]>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const visited = new Set<string>([from]);
  let frontier = [from];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        prev.set(nb, id);
        if (nb === to) {
          const path = [nb];
          let cur = nb;
          while (prev.has(cur)) {
            cur = prev.get(cur)!;
            path.unshift(cur);
          }
          return path;
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}
