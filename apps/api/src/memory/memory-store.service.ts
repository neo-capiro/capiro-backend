import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import type {
  MemoryItem,
  MemoryItemType,
  MemorySection,
} from './memory.types.js';
import { MEMORY_SCHEMA_VERSION } from './memory.types.js';
import { renderMemoryItem, vaultPathForItem } from './memory-render.helpers.js';
import { extractWikiLinks } from './memory-parse.helpers.js';
import { mergeEditedSections, fileDefForType } from './memory-catalog.js';

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
    };
  }

  /** List items the current tenant may see, optionally filtered by client/type. */
  async listForCurrentTenant(filter?: {
    clientId?: string;
    type?: MemoryItemType;
  }): Promise<MemoryItem[]> {
    const ctx = this.tenantCtx.require();
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<MemoryItemRow[]>`
        SELECT * FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid
          ${filter?.clientId ? Prisma.sql`AND client_id = ${filter.clientId}::uuid` : Prisma.empty}
          ${filter?.type ? Prisma.sql`AND type = ${filter.type}` : Prisma.empty}
          -- private items are visible only to their owner
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
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
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<MemoryItemRow[]>`
        SELECT * FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid AND type = ${type} AND slug = ${slug}
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
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
    wikiEdges: Array<{ tenantId: string; srcItemId: string; relation: string; dstType: string; dstSlug: string }>;
    itemNodes: Array<{ itemId: string; type: string; slug: string; label: string }>;
  }> {
    const ctx = this.tenantCtx.require();
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const edges = await tx.$queryRaw<
        Array<{ tenant_id: string; src_item_id: string; relation: string; dst_type: string; dst_slug: string }>
      >`SELECT tenant_id, src_item_id, relation, dst_type, dst_slug FROM memory_edges WHERE tenant_id = ${ctx.tenantId}::uuid`;
      const items = await tx.$queryRaw<Array<{ id: string; type: string; slug: string; title: string }>>`
        SELECT id, type, slug, title FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
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
          sections_jsonb, schema_version
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
          ${item.schemaVersion ?? MEMORY_SCHEMA_VERSION}
        )
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

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
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
          id: '', tenantId: ctx.tenantId,
          clientId: scope === 'client' ? clientId : null,
          ownerUserId: scope === 'user' ? ctx.userId : null,
          type,
          visibility: scope === 'user' ? 'user' : 'tenant',
          entityId: null,
          slug, title: label, aliases: [], tags: ['memory-file', scope],
          source: 'manual', sourceRef: null, provenance: 'human',
          sections: mergedSections,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          schemaVersion: MEMORY_SCHEMA_VERSION,
        };

    await this.upsertSystem(item);
    return { ...item, updatedAt: new Date().toISOString() };
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
}
