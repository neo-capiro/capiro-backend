import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  restrictGraphToClient,
  type GraphEdge,
  type GraphNode,
  type GraphRelationBasis,
  type GraphSourceReference,
} from '../memory/memory-graph.helpers.js';
import { loadMeriGraph, type MeriGraphProjection } from './meri-graph-source.js';
import { CLIENT_ID_UUID_RE } from './meri-prompt.helpers.js';
import type { KgTraversalSource } from './memory-recall-source.helpers.js';

export interface GraphPathInput {
  to: string;
  depth: number;
  clientId?: string;
}
export interface SourceLinkedGraphEdge {
  src: string;
  dst: string;
  relation: string;
  origin: 'fk' | 'mention';
  basis: GraphRelationBasis;
  sources: GraphSourceReference[];
}
export interface SourceLinkedGraphPath {
  nodes: Array<Pick<GraphNode, 'id' | 'type' | 'label'>>;
  edges: SourceLinkedGraphEdge[];
  basis: GraphRelationBasis;
}
const MAX_PATHS = 20;
const MAX_EXPANSIONS = 20_000;

export function graphPathInput(input: Record<string, unknown>): GraphPathInput {
  if (
    Object.keys(input).some((key) => !['to', 'depth', 'clientId'].includes(key)) ||
    typeof input.to !== 'string' ||
    input.to.trim() !== input.to ||
    input.to.length > 120 ||
    !/^[a-z][a-z0-9_-]*:.+$/u.test(input.to)
  )
    throw new BadRequestException('Provide one exact target node id.');
  const depth = input.depth ?? 3;
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 5)
    throw new BadRequestException('depth must be an integer from 1 to 5.');
  if (
    input.clientId !== undefined &&
    (typeof input.clientId !== 'string' || !CLIENT_ID_UUID_RE.test(input.clientId))
  )
    throw new BadRequestException('clientId must be an exact client UUID.');
  return {
    to: input.to,
    depth,
    ...(input.clientId === undefined ? {} : { clientId: (input.clientId as string).toLowerCase() }),
  };
}

/** One deterministic shortest path per authorized client. Depth is a search bound,
 * not a claim that the graph contains every possible relationship. */
export function sourceLinkedPaths(loaded: MeriGraphProjection, input: GraphPathInput) {
  const graph = input.clientId ? restrictGraphToClient(loaded, `client:${input.clientId}`) : loaded;
  const reasons = new Set(loaded.coverageReasons);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, SourceLinkedGraphEdge[]>();
  const edgeKey = (edge: GraphEdge) =>
    JSON.stringify([edge.src, edge.relation, edge.dst, edge.origin]);
  for (const edge of [...graph.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))) {
    if (!nodes.has(edge.src) || !nodes.has(edge.dst)) {
      reasons.add('unresolved_endpoint');
      continue;
    }
    if (!edge.sources?.length || !edge.basis) {
      reasons.add('source_reference_unavailable');
      continue;
    }
    const sourced: SourceLinkedGraphEdge = { ...edge, basis: edge.basis, sources: edge.sources };
    for (const id of new Set([edge.src, edge.dst]))
      adjacency.set(id, [...(adjacency.get(id) ?? []), sourced]);
  }
  const clients = graph.nodes
    .filter((node) => node.type === 'client')
    .sort((a, b) => a.id.localeCompare(b.id));
  const paths: SourceLinkedGraphPath[] = [];
  let expanded = 0,
    clientsSearched = 0;
  function shortest(from: string): SourceLinkedGraphPath | null {
    if (from === input.to)
      return {
        nodes: [{ id: from, type: nodes.get(from)!.type, label: nodes.get(from)!.label }],
        edges: [],
        basis: 'direct',
      };
    const seen = new Set([from]),
      previous = new Map<string, { id: string; edge: SourceLinkedGraphEdge }>();
    const queue: Array<{ id: string; depth: number }> = [{ id: from, depth: 0 }];
    for (let at = 0; at < queue.length; at++) {
      const current = queue[at]!;
      if (current.depth >= input.depth) continue;
      if (expanded >= MAX_EXPANSIONS) {
        reasons.add('traversal_limit');
        return null;
      }
      expanded++;
      for (const edge of adjacency.get(current.id) ?? []) {
        if (expanded >= MAX_EXPANSIONS) {
          reasons.add('traversal_limit');
          return null;
        }
        expanded++;
        const other = edge.src === current.id ? edge.dst : edge.src;
        if (seen.has(other)) continue;
        seen.add(other);
        previous.set(other, { id: current.id, edge });
        if (other === input.to) {
          const ids = [other],
            edges: SourceLinkedGraphEdge[] = [];
          for (let id = other; previous.has(id);) {
            const step = previous.get(id)!;
            edges.unshift(step.edge);
            ids.unshift(step.id);
            id = step.id;
          }
          return {
            nodes: ids.map((id) => {
              const node = nodes.get(id)!;
              return { id: node.id, type: node.type, label: node.label };
            }),
            edges,
            basis: edges.some((row) => row.basis === 'thematic')
              ? 'thematic'
              : edges.some((row) => row.basis === 'derived')
                ? 'derived'
                : 'direct',
          };
        }
        queue.push({ id: other, depth: current.depth + 1 });
      }
    }
    return null;
  }
  for (const client of clients) {
    const path = shortest(client.id);
    clientsSearched++;
    if (reasons.has('traversal_limit')) break;
    if (path) paths.push(path);
    if (paths.length > MAX_PATHS) {
      reasons.add('path_limit');
      break;
    }
  }
  return {
    paths: paths.slice(0, MAX_PATHS),
    coverage: {
      state: reasons.size ? ('partial' as const) : ('complete' as const),
      scope: 'one_shortest_path_per_visible_client' as const,
      maxDepth: input.depth,
      maxPaths: MAX_PATHS,
      clientsSearched,
      reasons: [...reasons].sort(),
    },
  };
}

export async function readMeriPaths(
  prisma: Pick<PrismaService, 'withTenantUser'>,
  ctx: TenantContext,
  raw: Record<string, unknown>,
  source: KgTraversalSource,
  now: () => number = Date.now,
) {
  const input = graphPathInput(raw);
  // Scope the canonical source load before resolving targets, labels or paths.
  const loaded = await loadMeriGraph(prisma, ctx, source, input.clientId, true);
  const result = sourceLinkedPaths(loaded, input);
  return {
    tool: 'find_path_to' as const,
    target: input.to,
    clientId: input.clientId ?? null,
    observedAt: new Date(now()).toISOString(),
    temporalCoverage: 'current_only' as const,
    ...result,
    summary: result.paths.length
      ? `${result.paths.length} source-linked route(s) within ${input.depth} hops in the authorized current graph projection.`
      : `No route was returned within ${input.depth} hops in the authorized current graph projection. This does not establish that a target is absent.`,
  };
}
