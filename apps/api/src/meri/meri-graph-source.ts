import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { optionalString } from './meri-tool-input.helpers.js';
import { CLIENT_ID_UUID_RE } from './meri-prompt.helpers.js';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { fetchDeniedClientIds, wallExclusionSql } from '../memory/memory-wall.helpers.js';
import {
  currentMemoryReadSql,
  governedRecallColumnsAvailableInTx,
} from '../memory/memory-recall-suppression.helpers.js';
import { enrichFromKgCache } from '../memory/kg-cache-enrich.helpers.js';
import {
  buildKnowledgeGraph,
  type FkRelation,
  type KnowledgeGraph,
  type GraphSourceReference,
  restrictGraphToClient,
  walkFrom,
} from '../memory/memory-graph.helpers.js';
import type { KgTraversalSource } from './memory-recall-source.helpers.js';

export interface MeriGraphProjection extends KnowledgeGraph {
  coverageReasons: string[];
}

/** Core owns current graph access. A mention is not authority to create its destination. */
export async function loadMeriGraph(
  prisma: Pick<PrismaService, 'withTenantUser'>,
  ctx: TenantContext,
  kgSource: KgTraversalSource,
  clientId?: string,
  boundedPaths = false,
): Promise<MeriGraphProjection> {
  return prisma.withTenantUser(
    ctx.tenantId,
    ctx.userId,
    async (tx) => {
      const coverageReasons: string[] = [];
      const bound = <T>(rows: T[], source: string, limit: number): T[] => {
        if (!boundedPaths || rows.length <= limit) return rows;
        coverageReasons.push(source + '_row_limit');
        return rows.slice(0, limit);
      };
      // Ethical wall: memory items + graph edges of walled clients this user is
      // not granted are excluded (fail-closed; empty denied set adds no SQL).
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const deniedSet = new Set(denied);
      const clients = bound(
        await tx.$queryRaw<Array<{ id: string; name: string; status: string }>>`
          SELECT id, name, status FROM clients WHERE tenant_id = ${ctx.tenantId}::uuid
          ${boundedPaths ? Prisma.raw(wallExclusionSql(denied, 'id')) : Prisma.empty}
          ${boundedPaths && clientId ? Prisma.sql`AND id = ${clientId}::uuid` : Prisma.empty}
          ORDER BY id
          ${boundedPaths ? Prisma.sql`LIMIT 201` : Prisma.empty}
        `,
        'clients',
        200,
      );
      const visibleClients = clients.filter(
        (c) => !deniedSet.has(c.id) && (!clientId || c.id === clientId),
      );
      if (clientId && !visibleClients.some((c) => c.id === clientId)) {
        throw new ForbiddenException('Knowledge graph client scope is unavailable');
      }
      const memoryColumnsAvailable = await governedRecallColumnsAvailableInTx(tx);
      if (boundedPaths && !memoryColumnsAvailable)
        coverageReasons.push('memory_governance_unavailable');
      // item nodes the caller may see (RLS: tenant + own-private), plus their wikilink edges
      const items = bound(
        await tx.$queryRaw<
          Array<{ id: string; type: string; slug: string; title: string; sections: unknown }>
        >`
        SELECT id, type, slug, title, sections_jsonb AS sections
        FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND ((visibility = 'tenant' AND owner_user_id IS NULL)
               OR (visibility = 'user' AND owner_user_id = ${ctx.userId}::uuid))
          ${Prisma.raw(wallExclusionSql(denied, 'client_id'))}
          ${clientId ? Prisma.sql`AND (client_id IS NULL OR client_id = ${clientId}::uuid)` : Prisma.empty}
          ${Prisma.raw(currentMemoryReadSql(memoryColumnsAvailable))}
          ${boundedPaths ? Prisma.sql`ORDER BY id LIMIT 2001` : Prisma.empty}
      `,
        'memory_items',
        2000,
      );
      const itemNodeById = new Map(
        items.map((i) => [i.id, { type: i.type, slug: i.slug, label: i.title }]),
      );
      const wikiEdges = bound(
        await tx.$queryRaw<
          Array<{ src_item_id: string; relation: string; dst_type: string; dst_slug: string }>
        >`
        SELECT e.src_item_id, e.relation, e.dst_type, e.dst_slug
        FROM memory_edges e
        JOIN memory_items i ON i.id = e.src_item_id
        WHERE e.tenant_id = ${ctx.tenantId}::uuid AND i.tenant_id = ${ctx.tenantId}::uuid
          AND ((i.visibility = 'tenant' AND i.owner_user_id IS NULL)
               OR (i.visibility = 'user' AND i.owner_user_id = ${ctx.userId}::uuid))
          ${Prisma.raw(wallExclusionSql(denied, 'i.client_id'))}
          ${clientId ? Prisma.sql`AND (i.client_id IS NULL OR i.client_id = ${clientId}::uuid)` : Prisma.empty}
          ${Prisma.raw(currentMemoryReadSql(memoryColumnsAvailable, 'i'))}
          ${boundedPaths ? Prisma.sql`ORDER BY e.src_item_id, e.relation, e.dst_type, e.dst_slug LIMIT 4001` : Prisma.empty}
      `,
        'memory_edges',
        4000,
      );
      // FK relations (structural backbone): client->bill/issue/person, meeting->client
      const fk: FkRelation[] = [];
      const bills = bound(
        await tx.$queryRaw<Array<{ client_id: string; client_name: string; bill_id: string }>>`
        SELECT tb.client_id, c.name AS client_name, tb.bill_id FROM tracked_bill tb JOIN clients c ON c.id = tb.client_id WHERE tb.tenant_id = ${ctx.tenantId}::uuid
        ${boundedPaths ? Prisma.raw(wallExclusionSql(denied, 'tb.client_id')) : Prisma.empty}
        ${boundedPaths && clientId ? Prisma.sql`AND tb.client_id = ${clientId}::uuid` : Prisma.empty}
        ${boundedPaths ? Prisma.sql`ORDER BY tb.client_id, tb.bill_id LIMIT 2001` : Prisma.empty}
      `,
        'tracked_bills',
        2000,
      );
      for (const b of bills)
        fk.push({
          srcType: 'client',
          srcSlug: b.client_id,
          srcLabel: b.client_name,
          dstType: 'bill',
          dstSlug: b.bill_id,
          dstLabel: b.bill_id,
          relation: 'tracks',
          ...(boundedPaths
            ? {
                basis: 'direct' as const,
                sources: [
                  {
                    kind: 'tracked_bill_relationship' as const,
                    id: JSON.stringify([b.client_id, b.bill_id]),
                  },
                ],
              }
            : {}),
        });
      const people = bound(
        await tx.$queryRaw<
          Array<{ client_id: string; client_name: string; person_id: string; person_name: string }>
        >`
        SELECT cp.client_id, c.name AS client_name, cp.id AS person_id, cp.name AS person_name FROM client_people cp JOIN clients c ON c.id = cp.client_id WHERE cp.tenant_id = ${ctx.tenantId}::uuid
        ${boundedPaths ? Prisma.raw(wallExclusionSql(denied, 'cp.client_id')) : Prisma.empty}
        ${boundedPaths && clientId ? Prisma.sql`AND cp.client_id = ${clientId}::uuid` : Prisma.empty}
        ${boundedPaths ? Prisma.sql`ORDER BY cp.client_id, cp.id LIMIT 2001` : Prisma.empty}
      `,
        'client_people',
        2000,
      );
      for (const p of people)
        fk.push({
          srcType: 'client',
          srcSlug: p.client_id,
          srcLabel: p.client_name,
          dstType: 'person',
          dstSlug: p.person_id,
          dstLabel: p.person_name,
          relation: 'contact',
          ...(boundedPaths
            ? {
                basis: 'direct' as const,
                sources: [{ kind: 'client_person' as const, id: p.person_id }],
              }
            : {}),
        });
      const wiki = wikiEdges.map((e) => ({
        tenantId: ctx.tenantId,
        srcItemId: e.src_item_id,
        relation: e.relation,
        dstType: e.dst_type,
        dstSlug: e.dst_slug,
        ...(boundedPaths
          ? { sources: [{ kind: 'memory_item', id: e.src_item_id }] as GraphSourceReference[] }
          : {}),
      }));
      // Ethical wall: drop FK relations rooted at denied clients so a walled
      // client's bills/people/meetings never appear in this user's graph.
      const fkVisible = fk.filter(
        (r) =>
          !deniedSet.has(r.srcSlug) &&
          (!clientId || r.srcSlug === clientId) &&
          (!boundedPaths || visibleClients.some((client) => client.id === r.srcSlug)),
      );

      // Track B enrichment: when this tenant is on the cache traversal source,
      // layer the world-class canonical relationships (aggregated FEC money
      // flow, LDA lobbying, intel mappings) around the visible clients via
      // seed-based bounded walks. A failed or truncated cache cannot establish
      // a complete graph; propagate unavailability instead of a silent baseline.
      let fkAll = fkVisible;
      if (kgSource === 'cache') {
        try {
          // Bound the enrichment phase server-side — kg_walk_bounded's fn-scoped
          // statement_timeout is inert, so SET LOCAL is the real RC3 guard.
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '8s'`);
          const enriched = await enrichFromKgCache(tx, {
            tenantId: ctx.tenantId,
            deniedClientIds: denied,
            clients: visibleClients.filter((c) => c.status !== 'archived'),
            includeSourceReferences: boundedPaths,
          });
          fkAll = [...fkVisible, ...enriched.relations];
          // The cache walk's own depth/fanout bounds cannot prove exhaustion.
          if (boundedPaths) coverageReasons.push('cache_projection_bounded');
          if (enriched.truncated && boundedPaths) coverageReasons.push('cache_projection_limit');
          if (enriched.truncated && !boundedPaths)
            throw new ServiceUnavailableException(
              'Knowledge graph cache projection is incomplete.',
            );
        } catch {
          // Never describe a failed or truncated cache read as a complete
          // canonical baseline. The unchanged wire reports source unavailability.
          throw new ServiceUnavailableException(
            'Knowledge graph cache is unavailable or incomplete.',
          );
        }
      }
      const targets = new Set(items.map((i) => `${i.type}:${i.slug}`));
      for (const c of visibleClients) targets.add(`client:${c.id}`);
      for (const relation of fkVisible) {
        targets.add(`${relation.srcType}:${relation.srcSlug}`);
        targets.add(`${relation.dstType}:${relation.dstSlug}`);
      }
      // Public bills remain valid references even when no client tracks them.
      const billIds = [...new Set(wiki.filter((e) => e.dstType === 'bill').map((e) => e.dstSlug))];
      if (billIds.length) {
        const bills = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM congress_bill WHERE id = ANY(${billIds}::text[])
          `;
        for (const bill of bills) targets.add(`bill:${bill.id}`);
      }
      const visibleWiki = wiki.filter((e) => targets.has(`${e.dstType}:${e.dstSlug}`));
      const graph = buildKnowledgeGraph(fkAll, visibleWiki, itemNodeById);
      if (boundedPaths) {
        const visible = new Set(visibleClients.map((client) => `client:${client.id}`));
        const excluded = new Set(
          graph.nodes
            .filter((node) => node.type === 'client' && !visible.has(node.id))
            .map((node) => node.id),
        );
        graph.nodes = graph.nodes.filter((node) => !excluded.has(node.id));
        graph.edges = graph.edges.filter(
          (edge) => !excluded.has(edge.src) && !excluded.has(edge.dst),
        );
      }
      if (boundedPaths)
        for (const client of visibleClients) {
          if (!graph.nodes.some((node) => node.id === `client:${client.id}`))
            graph.nodes.push({
              id: `client:${client.id}`,
              type: 'client',
              slug: client.id,
              label: client.name,
            });
        }
      return { ...graph, coverageReasons };
    },
    // The cache branch runs bounded walks sequentially; match the intel graph
    // path's 30s ceiling instead of the 5s interactive-tx default.
    kgSource === 'cache' ? { timeoutMs: 30_000 } : undefined,
  );
}

export async function readMeriGraph(
  prisma: Pick<PrismaService, 'withTenantUser'>,
  ctx: TenantContext,
  input: Record<string, unknown>,
  kgSource: KgTraversalSource,
) {
  const seed = optionalString(input, 'seed', 120);
  const scopeClientId = optionalString(input, 'clientId', 80);
  if (scopeClientId && !CLIENT_ID_UUID_RE.test(scopeClientId)) {
    return { error: 'clientId must be a client UUID — pass the exact id, or omit it.' };
  }
  const depthRaw =
    typeof input.depth === 'number' ? input.depth : parseInt(String(input.depth ?? ''), 10);
  const depth = Number.isFinite(depthRaw) ? Math.min(4, Math.max(1, depthRaw)) : 2;
  const full = await loadMeriGraph(prisma, ctx, kgSource, scopeClientId ?? undefined);
  // Client-scoped session: walk ONLY this client's subgraph. Without this an
  // omitted seed returned the firm-wide graph — every client, their meetings
  // and their mail threads — inside a session assigned to one client.
  let graph: KnowledgeGraph = full;
  let effectiveSeed = seed;
  if (scopeClientId) {
    const scopeNode = `client:${scopeClientId}`;
    if (seed?.startsWith('client:') && seed !== scopeNode) {
      return {
        error:
          "This conversation is scoped to one client, so the knowledge graph cannot be walked from another client's node here. Omit the seed to explore this client's graph, or switch the session's client.",
      };
    }
    graph = restrictGraphToClient(full, scopeNode);
    // Always seeded when scoped, so an unscoped "overview" can never fall
    // through to the whole graph.
    effectiveSeed = seed || scopeNode;
  }
  const g = effectiveSeed ? walkFrom(graph, effectiveSeed, depth) : graph;
  if (!g.nodes.length) {
    return {
      summary:
        'The knowledge graph is empty or has nothing connected to that seed. Run "Populate graph" on the Knowledge Graph page to build it from clients, memories, meetings, and email.',
      nodes: [],
      edges: [],
    };
  }
  // Compact, LLM-friendly projection
  const nodeLabel = new Map(g.nodes.map((n) => [n.id, `${n.label} (${n.type})`]));
  const edgeLines = g.edges
    .slice(0, 120)
    .map(
      (e) =>
        `${nodeLabel.get(e.src) ?? e.src} --${e.relation}[${e.origin}]--> ${nodeLabel.get(e.dst) ?? e.dst}`,
    );
  return {
    summary: `${g.nodes.length} nodes, ${g.edges.length} connections${seed ? ` within ${depth} hop(s) of ${seed}` : ''}. Edges tagged [fact]=from firm data, [mention]=from analyst notes.`,
    nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label })),
    connections: edgeLines,
  };
}
