import type { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '@prisma/client';
import { ServiceUnavailableException } from '@nestjs/common';
import { fetchDeniedClientIds, toUuidArrayLiteral } from '../memory/memory-wall.helpers.js';
import { pickKgIntelGraph, pickKgTraversalSource } from '../meri/memory-recall-source.helpers.js';
import { ClientContextV1GraphLabels } from './client-context-v1-graph-labels.js';
import { buildKnowledgeGraphMaps } from './client-context-v1-graph-presentation.js';

export type ClientContextGraphWalkRow = Awaited<
  ReturnType<ClientContextV1Graph['walkClientGraph']>
>[number];

export interface ClientContextV1GraphPorts {
  walkClientGraph(
    tenantId: string,
    clientId: string,
    viewerUserId: string | null,
  ): Promise<ClientContextGraphWalkRow[]>;
  warn(message: string): void;
}

export class ClientContextV1Graph {
  private readonly labels: ClientContextV1GraphLabels;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientContextV1GraphPorts,
  ) {
    this.labels = new ClientContextV1GraphLabels(prisma);
  }

  async walkClientGraph(tenantId: string, clientId: string, viewerUserId: string | null) {
    type WalkRow = {
      depth: number;
      src_kind: string;
      src_id: string;
      dst_kind: string;
      dst_id: string;
      edge_type: string;
      confidence: number | null;
      source: string | null;
      observed_at: Date | null;
      tenant_id: string | null;
    };
    return this.prisma.withTenant(
      tenantId,
      async (tx) => {
        // Real server-side bound on the walk. kg_walk_bounded's own fn-scoped
        // statement_timeout is inert (a fn-level SET cannot re-arm the invoking
        // statement's timer), so SET LOCAL here is what actually caps the walk
        // well under the 30s tx ceiling — closing the RC3 pooled-hold class.
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '10s'`);
        // Ethical wall: clients this viewer may not see. Fail-closed for an
        // unidentified viewer (null userId → every walled client denied).
        const denied = await fetchDeniedClientIds(tx, tenantId, viewerUserId);
        return tx.$queryRaw<Array<WalkRow>>`
            SELECT depth, src_kind, src_id, dst_kind, dst_id, edge_type, confidence, source, observed_at, tenant_id
            FROM kg_walk_bounded(
              ${tenantId}::uuid,
              ${Prisma.raw(toUuidArrayLiteral(denied))},
              'client', ${clientId}, 2, NULL::text[], 25, 500, 'both')
          `;
      },
      { timeoutMs: 30_000 },
    );
  }

  async getKnowledgeGraph(
    clientId: string,
    tenantId: string,
    opts?: {
      viewerUserId?: string | null;
      envIntelGraphOn?: boolean;
      envTraversalSource?: 'legacy' | 'cache';
    },
  ) {
    const viewerUserId = opts?.viewerUserId ?? null;

    const settings = await this.readGraphSettings(tenantId);

    const endpointOn = pickKgIntelGraph(opts?.envIntelGraphOn ?? false, settings);

    const source = pickKgTraversalSource(opts?.envTraversalSource ?? 'legacy', settings);

    if (!endpointOn || source !== 'cache') {
      throw new ServiceUnavailableException(
        'Knowledge-graph endpoint is disabled pending the scoped traversal ' +
          '(requires KG_INTEL_GRAPH/kgIntelGraph=scoped and kgTraversalSource=cache).',
      );
    }

    const [client, mappings, walkRows] = await this.readGraphSnapshot(
      clientId,
      tenantId,
      viewerUserId,
    );

    const clientLabel = client?.name ?? clientId;

    const centerNodeId = `client:${clientId}`;

    const { filteredWalkRows, idsByKind } = this.labels.collectNodeIds(walkRows);

    const labelByNodeKey = new Map<string, string>();

    const lookups: Array<Promise<void>> = [];

    this.labels.startNumericLookups(idsByKind, labelByNodeKey, lookups);

    this.labels.startStringLookups(idsByKind, labelByNodeKey, lookups, tenantId);

    await Promise.all(lookups);

    const { nodeMap, edgeMap } = buildKnowledgeGraphMaps(
      client,
      clientLabel,
      centerNodeId,
      filteredWalkRows,
      labelByNodeKey,
    );

    const confirmedMappings = mappings.filter((m) => m.confirmed);

    const avgConfidence =
      confirmedMappings.length > 0
        ? confirmedMappings.reduce((s, m) => s + (m.confidence ?? 0), 0) / confirmedMappings.length
        : 0;

    return {
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()),
      resolutionQuality: {
        avgConfidence: Math.round(avgConfidence * 100),
        confirmedCount: confirmedMappings.length,
        unconfirmedCount: mappings.filter((m) => !m.confirmed).length,
      },
    };
  }

  private readGraphSnapshot(clientId: string, tenantId: string, viewerUserId: string | null) {
    return Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({
          // Explicit tenant pin on top of the scoped-client hook: a foreign
          // clientId must not even resolve this client's NAME (IDOR guard).
          where: { id: clientId, tenantId },
          select: { id: true, name: true, sectorTag: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findMany({
          where: { clientId },
          orderBy: { confidence: 'desc' },
        }),
      ),
      // Bounded, tenant + wall-scoped kg_walk_bounded over the materialized
      // kg_edge_cache. Capped by SET LOCAL statement_timeout (10s) inside the
      // walk tx and a 30s tx ceiling. Fail-safe: a walk error degrades to an
      // empty edge set so the client + mappings still render (the endpoint does
      // not 500 the moment KG_INTEL_GRAPH is flipped to scoped).
      this.ports.walkClientGraph(tenantId, clientId, viewerUserId).catch((err) => {
        this.ports.warn(
          `kg_walk_bounded failed for client ${clientId}; rendering client+mappings only: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [] as Awaited<ReturnType<typeof this.ports.walkClientGraph>>;
      }),
    ]);
  }

  private readGraphSettings(tenantId: string) {
    return this.prisma
      .withTenant(tenantId, (tx) =>
        tx.tenant.findFirst({ where: { id: tenantId }, select: { settings: true } }),
      )
      .then((t) => t?.settings ?? null)
      .catch((err) => {
        // Fail toward the env gates (documented house pattern) but make the
        // degradation observable — a silent flap of a per-tenant off-override
        // back to an enabled env is otherwise undiagnosable.
        this.ports.warn(
          `kg intel-graph settings read failed for tenant ${tenantId}; resolving gates from env: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      });
  }
}
