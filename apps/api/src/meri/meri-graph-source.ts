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
  restrictGraphToClient,
  walkFrom,
} from '../memory/memory-graph.helpers.js';
import type { KgTraversalSource } from './memory-recall-source.helpers.js';

/** Core owns current graph access. A mention is not authority to create its destination. */
export async function loadMeriGraph(
  prisma: Pick<PrismaService, 'withTenantUser'>,
  ctx: TenantContext,
  kgSource: KgTraversalSource,
  clientId?: string,
): Promise<KnowledgeGraph> {
  return prisma.withTenantUser(
    ctx.tenantId,
    ctx.userId,
    async (tx) => {
      // Ethical wall: memory items + graph edges of walled clients this user is
      // not granted are excluded (fail-closed; empty denied set adds no SQL).
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const deniedSet = new Set(denied);
      const clients = await tx.$queryRaw<Array<{ id: string; name: string; status: string }>>`
          SELECT id, name, status FROM clients WHERE tenant_id = ${ctx.tenantId}::uuid
          ORDER BY id
        `;
      const visibleClients = clients.filter(
        (c) => !deniedSet.has(c.id) && (!clientId || c.id === clientId),
      );
      if (clientId && !visibleClients.some((c) => c.id === clientId)) {
        throw new ForbiddenException('Knowledge graph client scope is unavailable');
      }
      const memoryColumnsAvailable = await governedRecallColumnsAvailableInTx(tx);
      // item nodes the caller may see (RLS: tenant + own-private), plus their wikilink edges
      const items = await tx.$queryRaw<
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
      `;
      const itemNodeById = new Map(
        items.map((i) => [i.id, { type: i.type, slug: i.slug, label: i.title }]),
      );
      const wikiEdges = await tx.$queryRaw<
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
      `;
      // FK relations (structural backbone): client->bill/issue/person, meeting->client
      const fk: FkRelation[] = [];
      const bills = await tx.$queryRaw<
        Array<{ client_id: string; client_name: string; bill_id: string }>
      >`
        SELECT tb.client_id, c.name AS client_name, tb.bill_id FROM tracked_bill tb JOIN clients c ON c.id = tb.client_id WHERE tb.tenant_id = ${ctx.tenantId}::uuid`;
      for (const b of bills)
        fk.push({
          srcType: 'client',
          srcSlug: b.client_id,
          srcLabel: b.client_name,
          dstType: 'bill',
          dstSlug: b.bill_id,
          dstLabel: b.bill_id,
          relation: 'tracks',
        });
      const people = await tx.$queryRaw<
        Array<{ client_id: string; client_name: string; person_id: string; person_name: string }>
      >`
        SELECT cp.client_id, c.name AS client_name, cp.id AS person_id, cp.name AS person_name FROM client_people cp JOIN clients c ON c.id = cp.client_id WHERE cp.tenant_id = ${ctx.tenantId}::uuid`;
      for (const p of people)
        fk.push({
          srcType: 'client',
          srcSlug: p.client_id,
          srcLabel: p.client_name,
          dstType: 'person',
          dstSlug: p.person_id,
          dstLabel: p.person_name,
          relation: 'contact',
        });
      const wiki = wikiEdges.map((e) => ({
        tenantId: ctx.tenantId,
        srcItemId: e.src_item_id,
        relation: e.relation,
        dstType: e.dst_type,
        dstSlug: e.dst_slug,
      }));
      // Ethical wall: drop FK relations rooted at denied clients so a walled
      // client's bills/people/meetings never appear in this user's graph.
      const fkVisible = fk.filter(
        (r) => !deniedSet.has(r.srcSlug) && (!clientId || r.srcSlug === clientId),
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
          });
          fkAll = [...fkVisible, ...enriched.relations];
          if (enriched.truncated)
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
      return buildKnowledgeGraph(fkAll, visibleWiki, itemNodeById);
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
  let graph = full;
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
