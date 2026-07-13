import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import type { MemoryItem, MemoryItemType, MemorySection } from './memory.types.js';
import { MEMORY_SCHEMA_VERSION, defaultMemoryGovernanceFields } from './memory.types.js';
import { renderMemoryItem, vaultPathForItem } from './memory-render.helpers.js';
import { extractWikiLinks } from './memory-parse.helpers.js';
import { mergeEditedSections, fileDefForType } from './memory-catalog.js';
import { embedAndUpsert } from '../embeddings/embedder.js';

/** Result shape returned by the Phase 1 (1D) user-facing memory verbs. */
export interface MemoryVerbResult {
  found: boolean;
  /** True when the item exists but is under legal hold, so forget/correct refused. */
  blockedByLegalHold?: boolean;
  title?: string;
  /** correct_memory only: the id of the new (superseding) row. */
  newItemId?: string;
}

/**
 * Canonical institutional-memory store (plan §0.5).
 *
 * Reads/writes go through the existing tenant scoping primitives:
 *   - withTenant(tenantId, fn) sets app.current_tenant; RLS does the rest.
 *   - withSystem(fn) bypasses RLS for trusted ingestion only.
 *
 * Memory items are ROWS scoped by the SAME RLS the rest of the product uses —
 * a cross-tenant read returns zero rows (criterion #3, fail-closed). The
 * markdown vault is a projection: project() renders an item; persisting an item
 * also re-derives its wikilink edges (criterion #5).
 */
@Injectable()
export class MemoryStoreService {
  private readonly logger = new Logger(MemoryStoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextStore,
  ) {}

  private rowToItem(row: MemoryItemRow): MemoryItem {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      clientId: row.client_id,
      ownerUserId: row.owner_user_id,
      type: row.type as MemoryItemType,
      visibility: row.visibility as MemoryItem['visibility'],
      entityId: row.entity_id,
      slug: row.slug,
      title: row.title,
      aliases: row.aliases,
      tags: row.tags,
      source: row.source as MemoryItem['source'],
      sourceRef: row.source_ref,
      provenance: row.provenance as MemoryItem['provenance'],
      sections: (row.sections_jsonb as unknown as MemorySection[]) ?? [],
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      schemaVersion: row.schema_version,
      status: (row.status ?? 'active') as MemoryItem['status'],
      lastConfirmedAt: row.last_confirmed_at ? row.last_confirmed_at.toISOString() : null,
      reviewCadenceDays: row.review_cadence_days,
      supersedesId: row.supersedes_id,
      contradictsId: row.contradicts_id,
      sensitivity: row.sensitivity ?? 'normal',
      retentionPolicy: row.retention_policy_jsonb ?? null,
      legalHold: row.legal_hold ?? false,
      revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
      revokedBy: row.revoked_by,
      exportable: row.exportable ?? true,
      trainingUse: (row.training_use ?? 'excluded') as MemoryItem['trainingUse'],
    };
  }

  /** List items the current tenant may see, optionally filtered by client/type. */
  async listForCurrentTenant(filter?: {
    clientId?: string;
    type?: MemoryItemType;
  }): Promise<MemoryItem[]> {
    const ctx = this.tenantCtx.require();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await tx.$queryRaw<MemoryItemRow[]>`
        SELECT * FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid
          ${filter?.clientId ? Prisma.sql`AND client_id = ${filter.clientId}::uuid` : Prisma.empty}
          ${filter?.type ? Prisma.sql`AND type = ${filter.type}` : Prisma.empty}
          -- private items are visible only to their owner (app-level filter,
          -- kept as defense-in-depth alongside the 1C DB-level RLS predicate)
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
          -- a forgotten item stops recall immediately (1D)
          AND status != 'revoked'
          -- G2 ephemeral: expired working memory never reaches recall
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY type, slug
      `;
      return rows.map((r) => this.rowToItem(r));
    });
  }

  /** Project an item to its Obsidian-format markdown + canonical vault path. */
  project(item: MemoryItem): { path: string; markdown: string } {
    return { path: vaultPathForItem(item), markdown: renderMemoryItem(item) };
  }

  /** Fetch one item by type+slug for the current tenant (markdown retrieval). */
  async getByTypeSlug(type: MemoryItemType, slug: string): Promise<MemoryItem | null> {
    const ctx = this.tenantCtx.require();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await tx.$queryRaw<MemoryItemRow[]>`
        SELECT * FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid AND type = ${type} AND slug = ${slug}
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
          AND status != 'revoked'
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1
      `;
      const row = rows[0];
      return row ? this.rowToItem(row) : null;
    });
  }

  /**
   * Load the current tenant's wikilink edges + the source-node identity for
   * each, so the graph builder can merge them with DB FKs (criterion #5).
   * Returns edges scoped by RLS and a map of srcItemId -> node identity.
   */
  async loadGraphInputs(): Promise<{
    wikiEdges: Array<{
      tenantId: string;
      srcItemId: string;
      relation: string;
      dstType: string;
      dstSlug: string;
    }>;
    itemNodes: Array<{ itemId: string; type: string; slug: string; label: string }>;
  }> {
    const ctx = this.tenantCtx.require();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const edges = await tx.$queryRaw<
        Array<{
          tenant_id: string;
          src_item_id: string;
          relation: string;
          dst_type: string;
          dst_slug: string;
        }>
      >`SELECT tenant_id, src_item_id, relation, dst_type, dst_slug FROM memory_edges WHERE tenant_id = ${ctx.tenantId}::uuid`;
      const items = await tx.$queryRaw<
        Array<{ id: string; type: string; slug: string; title: string }>
      >`
        SELECT id, type, slug, title FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
          AND status != 'revoked'
          AND (expires_at IS NULL OR expires_at > now())
      `;
      return {
        wikiEdges: edges.map((e) => ({
          tenantId: e.tenant_id,
          srcItemId: e.src_item_id,
          relation: e.relation,
          dstType: e.dst_type,
          dstSlug: e.dst_slug,
        })),
        itemNodes: items.map((i) => ({ itemId: i.id, type: i.type, slug: i.slug, label: i.title })),
      };
    });
  }

  /**
   * Upsert an item for a tenant via the trusted ingestion path, then re-derive
   * its wikilink edges. Used by ingestion workers and seeding (not per-request
   * user writes, which go through withTenant).
   */
  async upsertSystem(item: MemoryItem): Promise<string> {
    return this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO memory_items (
          tenant_id, client_id, owner_user_id, type, visibility, entity_id,
          slug, title, aliases, tags, source, source_ref, provenance,
          sections_jsonb, schema_version,
          status, sensitivity, legal_hold, exportable, training_use, expires_at
        ) VALUES (
          ${item.tenantId}::uuid,
          ${item.clientId}::uuid,
          ${item.ownerUserId}::uuid,
          ${item.type},
          ${item.visibility},
          ${item.entityId}::uuid,
          ${item.slug},
          ${item.title},
          ${item.aliases},
          ${item.tags},
          ${item.source},
          ${item.sourceRef},
          ${item.provenance},
          ${JSON.stringify(item.sections)}::jsonb,
          ${item.schemaVersion ?? MEMORY_SCHEMA_VERSION},
          ${item.status ?? 'active'},
          ${item.sensitivity ?? 'normal'},
          ${item.legalHold ?? false},
          ${item.exportable ?? true},
          ${item.trainingUse ?? 'excluded'},
          ${item.expiresAt ? new Date(item.expiresAt) : null}
        )
        -- Governance/temporal columns (status, legal_hold, revoked_*, etc.)
        -- are deliberately NOT in this UPDATE SET: upsertSystem is also the
        -- routine content-resync path (ingestion, Settings-editor re-saves),
        -- and it must never silently reset a revoked/confirmed item's
        -- governance state back to defaults. Those fields only change via
        -- the dedicated confirm/correct/forget methods (1D).
        ON CONFLICT (tenant_id, type, slug) DO UPDATE SET
          client_id = EXCLUDED.client_id,
          owner_user_id = EXCLUDED.owner_user_id,
          visibility = EXCLUDED.visibility,
          entity_id = EXCLUDED.entity_id,
          title = EXCLUDED.title,
          aliases = EXCLUDED.aliases,
          tags = EXCLUDED.tags,
          source = EXCLUDED.source,
          source_ref = EXCLUDED.source_ref,
          provenance = EXCLUDED.provenance,
          sections_jsonb = EXCLUDED.sections_jsonb,
          -- expires_at IS content-resync (it mirrors the SOURCE row's expiry,
          -- e.g. an ephemeral clio_memory), not governance state — a
          -- re-projection must keep the projection's expiry in sync.
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
        RETURNING id
      `;
      const row = rows[0];
      if (!row) {
        throw new Error('memory_items upsert returned no row');
      }
      const id = row.id;
      await this.deriveEdges(tx, item, id);
      return id;
    });
  }

  /**
   * Update the human-authored sections of an existing item under RLS (the
   * Settings editor + interview save path). Engine-owned sections and identity
   * fields are preserved from the stored item; only human sections whose keys
   * are in `edits` are replaced. Runs under withTenant so a caller can only
   * write within their own tenant (and RLS blocks writing items they can't see).
   * Returns the updated item, or null if the item does not exist / is not visible.
   */
  async updateSectionsForCurrentTenant(
    type: MemoryItemType,
    slug: string,
    edits: Array<{ key: string; body: string }>,
    allowedKeys: Set<string>,
  ): Promise<MemoryItem | null> {
    const ctx = this.tenantCtx.require();
    const existing = await this.getByTypeSlug(type, slug);
    if (!existing) return null;

    const editByKey = new Map(
      edits.filter((e) => allowedKeys.has(e.key)).map((e) => [e.key, e.body]),
    );
    const mergedSections: MemorySection[] = existing.sections.map((s) => {
      if (s.owner === 'human' && editByKey.has(s.key)) {
        return { ...s, body: editByKey.get(s.key) ?? s.body };
      }
      return s; // engine-owned or untouched human sections preserved as-is
    });

    const updated: MemoryItem = { ...existing, sections: mergedSections };

    // withTenantUser (not plain withTenant): a user-scope item's RLS policy
    // (1C) requires app.current_user to match owner_user_id, or this UPDATE
    // silently affects 0 rows instead of erroring.
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.$executeRaw`
        UPDATE memory_items
        SET sections_jsonb = ${JSON.stringify(mergedSections)}::jsonb, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid AND type = ${type} AND slug = ${slug}
      `;
      await this.deriveEdges(tx, updated, existing.id);
    });
    return { ...updated, updatedAt: new Date().toISOString() };
  }

  /**
   * Create-or-update the human sections of a Settings memory file. Unlike
   * updateSectionsForCurrentTenant, this CREATES the item from the catalog
   * skeleton when it doesn't exist yet — so a brand-new firm/client/user file
   * (and Meri-drafted content for one) persists on first save. Scope/visibility/
   * owner are derived from the catalog + caller:
   *   - firm files   -> visibility 'tenant', owner null, slug 'firm'
   *   - client files -> visibility 'tenant', owner null, slug <clientId>
   *   - user files   -> visibility 'user',   owner <caller>, slug <userId>
   */
  async upsertSectionsForCurrentTenant(
    type: MemoryItemType,
    slug: string,
    scope: 'firm' | 'client' | 'user',
    clientId: string | null,
    edits: Array<{ key: string; body: string }>,
    allowedKeys: Set<string>,
  ): Promise<MemoryItem> {
    const ctx = this.tenantCtx.require();
    const existing = await this.getByTypeSlug(type, slug);

    // Canonical merge: walks the catalog skeleton so every human-editable section
    // is present + saveable (fixes "some files don't save" for stale rows), keeps
    // engine-owned + unlisted sections intact. Pure + unit-tested in the catalog.
    const mergedSections: MemorySection[] = mergeEditedSections(
      type,
      existing?.sections ?? null,
      edits,
      allowedKeys,
    );

    const label = fileDefForType(type)?.label ?? type;
    const item: MemoryItem = existing
      ? { ...existing, sections: mergedSections }
      : {
          id: '',
          tenantId: ctx.tenantId,
          clientId: scope === 'client' ? clientId : null,
          ownerUserId: scope === 'user' ? ctx.userId : null,
          type,
          visibility: scope === 'user' ? 'user' : 'tenant',
          entityId: null,
          slug,
          title: label,
          aliases: [],
          tags: ['memory-file', scope],
          source: 'manual',
          sourceRef: null,
          provenance: 'human',
          sections: mergedSections,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: MEMORY_SCHEMA_VERSION,
          ...defaultMemoryGovernanceFields(),
        };

    await this.upsertSystem(item);
    return { ...item, updatedAt: new Date().toISOString() };
  }

  // ── Phase 1 (1D) — user-facing memory verbs ──────────────────────────────
  // All three run under withTenantUser so the 1C owner-aware RLS policy admits
  // the caller's own private items. They operate on the canonical memory_items
  // governance row; forget/correct also reconcile the clio_memory fast-path
  // source so recall stops on BOTH surfaces (searchMemory tool over
  // context_embeddings AND semanticMemorySearch over clio_memory) and the
  // nightly refresh cannot resurrect a forgotten/corrected item.

  /** confirm: re-affirm an item is still true (blueprint §3.5 "Confirm"). */
  async confirmMemory(itemId: string): Promise<MemoryVerbResult> {
    const ctx = this.tenantCtx.require();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ title: string }>>`
        SELECT title FROM memory_items
        WHERE id = ${itemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
          AND status <> 'revoked'
        LIMIT 1
      `;
      if (!rows[0]) return { found: false };
      await tx.$executeRaw`
        UPDATE memory_items SET last_confirmed_at = now(), updated_at = now()
        WHERE id = ${itemId}::uuid
      `;
      return { found: true, title: rows[0].title };
    });
  }

  /**
   * forget: revoke an item and stop recall immediately (blueprint §5.4).
   * status='revoked' (excluded by every read filter) + purge the semantic
   * embedding + delete the clio_memory source (if any) so it can't be
   * re-recalled or re-projected + an audit_logs tombstone. Refuses when the
   * item is under legal hold. Soft delete — the canonical row is retained
   * (revoked), so an accidental forget is administratively recoverable.
   */
  async forgetMemory(itemId: string, reason?: string): Promise<MemoryVerbResult> {
    const ctx = this.tenantCtx.require();
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ title: string; slug: string; legal_hold: boolean }>>`
        SELECT title, slug, legal_hold FROM memory_items
        WHERE id = ${itemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
          AND status <> 'revoked'
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return { found: false };
      if (row.legal_hold) return { found: true, blockedByLegalHold: true, title: row.title };

      await tx.$executeRaw`
        UPDATE memory_items
        SET status = 'revoked', revoked_at = now(), revoked_by = ${ctx.userId}::uuid, updated_at = now()
        WHERE id = ${itemId}::uuid
      `;
      // Purge the semantic projection (no FK cascade from memory_items).
      await tx.$executeRaw`
        DELETE FROM context_embeddings WHERE source_type = 'memory_item' AND source_id = ${itemId}
      `;
      // If this item was projected from a clio_memory KV row, delete that
      // source too — otherwise semanticMemorySearch (which reads clio_memory
      // directly) keeps returning it and the nightly refresh re-projects it.
      const clioId = row.slug.startsWith('clio:') ? row.slug.slice('clio:'.length) : null;
      if (clioId) {
        await tx.$executeRaw`
          DELETE FROM clio_memory WHERE id = ${clioId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        `;
      }
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'memory.forget',
          entityType: 'memory_item',
          entityId: itemId,
          before: { title: row.title, slug: row.slug, reason: reason ?? null },
        },
      });
      return { found: true, title: row.title };
    });
  }

  /**
   * correct: supersede an item with new content, preserving history (blueprint
   * §4.6.5 step 8). Creates a NEW active row whose supersedesId points at the
   * old one; the old row becomes status='superseded' (retained for history,
   * excluded from active recall). If the old item was clio-sourced, its stale
   * source row + embedding are removed so recall reflects only the correction.
   */
  async correctMemory(itemId: string, newContent: string): Promise<MemoryVerbResult> {
    const ctx = this.tenantCtx.require();
    const body = (newContent ?? '').trim();
    if (!body) return { found: false };

    const outcome = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          type: string;
          slug: string;
          title: string;
          client_id: string | null;
          owner_user_id: string | null;
          visibility: string;
          entity_id: string | null;
          tags: string[];
          legal_hold: boolean;
        }>
      >`
        SELECT type, slug, title, client_id, owner_user_id, visibility, entity_id, tags, legal_hold
        FROM memory_items
        WHERE id = ${itemId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
          AND status <> 'revoked'
        LIMIT 1
      `;
      const old = rows[0];
      if (!old) return { found: false as const };
      if (old.legal_hold)
        return { found: true as const, blockedByLegalHold: true, title: old.title };

      // New slug dodges the (tenant,type,slug) unique constraint; a corrected
      // item is a distinct row so both versions coexist.
      const newSlug = `${old.slug}~c${Date.now().toString(36)}`.slice(0, 200);
      const sections = JSON.stringify([{ key: 'memory', heading: 'Memory', owner: 'human', body }]);
      const ins = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO memory_items (
          tenant_id, client_id, owner_user_id, type, visibility, entity_id,
          slug, title, aliases, tags, source, source_ref, provenance,
          sections_jsonb, schema_version, status, supersedes_id,
          sensitivity, legal_hold, exportable, training_use
        ) VALUES (
          ${ctx.tenantId}::uuid, ${old.client_id}::uuid, ${old.owner_user_id}::uuid,
          ${old.type}, ${old.visibility}, ${old.entity_id}::uuid,
          ${newSlug}, ${old.title}, '{}', ${old.tags}, 'manual', NULL, 'human',
          ${sections}::jsonb, ${MEMORY_SCHEMA_VERSION}, 'active', ${itemId}::uuid,
          'normal', false, true, 'excluded'
        )
        RETURNING id
      `;
      const newId = ins[0]?.id;
      if (!newId) throw new Error('correctMemory: insert returned no row');

      await tx.$executeRaw`
        UPDATE memory_items SET status = 'superseded', updated_at = now() WHERE id = ${itemId}::uuid
      `;
      // Drop the old item's stale embedding + clio source so recall reflects
      // only the correction.
      await tx.$executeRaw`
        DELETE FROM context_embeddings WHERE source_type = 'memory_item' AND source_id = ${itemId}
      `;
      const clioId = old.slug.startsWith('clio:') ? old.slug.slice('clio:'.length) : null;
      if (clioId) {
        await tx.$executeRaw`
          DELETE FROM clio_memory WHERE id = ${clioId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        `;
      }
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'memory.correct',
          entityType: 'memory_item',
          entityId: itemId,
          before: { slug: old.slug, title: old.title },
          after: { newItemId: newId, newSlug },
        },
      });
      return {
        found: true as const,
        newId,
        title: old.title,
        clientId: old.client_id,
        ownerUserId: old.owner_user_id,
      };
    });

    if (!outcome.found || outcome.blockedByLegalHold || !('newId' in outcome)) {
      return {
        found: outcome.found,
        blockedByLegalHold: outcome.blockedByLegalHold,
        title: outcome.title,
      };
    }
    const newId = outcome.newId as string; // guaranteed by the `'newId' in outcome` guard above
    // Embed the corrected row immediately (best-effort; nightly refresh is the
    // backstop). Same bypass-write path the ingest embedder uses.
    try {
      await embedAndUpsert(this.prisma, {
        tenantId: ctx.tenantId,
        clientId: outcome.clientId,
        ownerUserId: outcome.ownerUserId,
        sourceType: 'memory_item',
        sourceId: newId,
        text: `${outcome.title}: ${body}`,
        bypassRls: true,
      });
    } catch (err) {
      this.logger.warn(`correctMemory embed failed (non-fatal): ${(err as Error).message}`);
    }
    return { found: true, title: outcome.title, newItemId: newId };
  }

  /** Re-derive wikilink edges for an item (criterion #5). Replace-all per item. */
  private async deriveEdges(
    tx: Prisma.TransactionClient,
    item: MemoryItem,
    itemId: string,
  ): Promise<void> {
    await tx.$executeRaw`DELETE FROM memory_edges WHERE src_item_id = ${itemId}::uuid`;
    const text = item.sections.map((s) => s.body).join('\n');
    const links = extractWikiLinks(text);
    for (const link of links) {
      await tx.$executeRaw`
        INSERT INTO memory_edges (tenant_id, src_item_id, relation, dst_type, dst_slug)
        VALUES (${item.tenantId}::uuid, ${itemId}::uuid, 'mentions', ${link.type}, ${link.slug})
        ON CONFLICT (src_item_id, relation, dst_type, dst_slug) DO NOTHING
      `;
    }
  }
}

interface MemoryItemRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  owner_user_id: string | null;
  type: string;
  visibility: string;
  entity_id: string | null;
  slug: string;
  title: string;
  aliases: string[];
  tags: string[];
  source: string;
  source_ref: string | null;
  provenance: string;
  sections_jsonb: unknown;
  schema_version: number;
  created_at: Date;
  updated_at: Date;
  status: string | null;
  last_confirmed_at: Date | null;
  review_cadence_days: number | null;
  supersedes_id: string | null;
  contradicts_id: string | null;
  sensitivity: string | null;
  retention_policy_jsonb: unknown;
  legal_hold: boolean | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  exportable: boolean | null;
  training_use: string | null;
}
