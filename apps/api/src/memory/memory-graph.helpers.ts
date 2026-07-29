// Institutional Memory — Phase 3 graph builder (plan §7, criterion #5).
//
// The Intelligence Center "Knowledge Graph" tab consumes a graph that merges
// two edge sources:
//   1. DB foreign keys  (authoritative structural relations from Postgres)
//   2. wikilink edges    (analyst-authored [[type:slug]] mentions in memory)
//
// This module is the PURE merge + query logic, no I/O. The service layer feeds
// it rows from memory_edges + FK queries; the controller exposes walks. Pure so
// it is fully unit-testable (the consumption path's correctness is provable
// without a running DB).

import type { MemoryEdge } from './memory.types.js';

/** A node in the merged knowledge graph. */
export interface GraphNode {
  /** `${type}:${slug}` canonical id. */
  id: string;
  type: string;
  slug: string;
  /** label for display; falls back to slug. */
  label: string;
  /** Optional attribute bag (bill status, person title, office type, etc.). */
  attrs?: Record<string, string>;
}

/** A merged edge with provenance so the UI can distinguish fact vs. analysis. */
export interface GraphEdge {
  src: string; // node id
  dst: string; // node id
  relation: string;
  /** 'fk' = authoritative DB relation; 'mention' = analyst wikilink. */
  origin: 'fk' | 'mention';
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** A DB foreign-key relation lifted into graph form by the service layer. */
export interface FkRelation {
  srcType: string;
  srcSlug: string;
  srcLabel?: string;
  srcAttrs?: Record<string, string>;
  dstType: string;
  dstSlug: string;
  dstLabel?: string;
  dstAttrs?: Record<string, string>;
  relation: string;
}

function nodeId(type: string, slug: string): string {
  return `${type}:${slug}`;
}

/**
 * Merge DB FK relations and wikilink edges into one de-duplicated graph.
 *
 * `memoryItems` provides the source node identity for each wikilink edge:
 * an edge's src node is the item that contains the link. The map keys are
 * memory_item ids -> { type, slug, label }.
 */
export function buildKnowledgeGraph(
  fkRelations: FkRelation[],
  wikiEdges: MemoryEdge[],
  itemNodeById: Map<string, { type: string; slug: string; label: string }>,
): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addNode = (type: string, slug: string, label?: string, attrs?: Record<string, string>): string => {
    const id = nodeId(type, slug);
    const existing = nodes.get(id);
    if (!existing) {
      nodes.set(id, { id, type, slug, label: label ?? slug, ...(attrs && Object.keys(attrs).length ? { attrs } : {}) });
    } else {
      if (label && existing.label === existing.slug) {
        // upgrade a slug-only label when a real one arrives
        existing.label = label;
      }
      if (attrs && Object.keys(attrs).length) {
        existing.attrs = { ...(existing.attrs ?? {}), ...attrs };
      }
    }
    return id;
  };

  const addEdge = (
    src: string,
    dst: string,
    relation: string,
    origin: 'fk' | 'mention',
  ): void => {
    const key = `${src}|${relation}|${dst}|${origin}`;
    if (!edges.has(key)) edges.set(key, { src, dst, relation, origin });
  };

  for (const fk of fkRelations) {
    const src = addNode(fk.srcType, fk.srcSlug, fk.srcLabel, fk.srcAttrs);
    const dst = addNode(fk.dstType, fk.dstSlug, fk.dstLabel, fk.dstAttrs);
    addEdge(src, dst, fk.relation, 'fk');
  }

  for (const we of wikiEdges) {
    const srcNode = itemNodeById.get(we.srcItemId);
    if (!srcNode) continue; // edge whose source item we can't resolve — skip
    const src = addNode(srcNode.type, srcNode.slug, srcNode.label);
    const dst = addNode(we.dstType, we.dstSlug);
    addEdge(src, dst, we.relation, 'mention');
  }

  return {
    nodes: Array.from(nodes.values()).sort((a, b) => a.id.localeCompare(b.id)),
    edges: Array.from(edges.values()).sort((a, b) =>
      `${a.src}${a.relation}${a.dst}`.localeCompare(`${b.src}${b.relation}${b.dst}`),
    ),
  };
}

/**
 * Restrict a graph to ONE client's view: every OTHER client node, and every
 * edge incident to one, is removed.
 *
 * Used by Meri's graph tools when the conversation is assigned to a client. A
 * client-scoped session must not surface another client's relationships, and
 * must not route a warm-intro path THROUGH another client — dropping the nodes
 * AND their edges achieves both (an edge-only filter would leave the foreign
 * client's label visible on a dangling node).
 *
 * Non-client nodes are kept as-is: callers always walk from a seed afterwards,
 * so whatever is left unreachable is dropped by the BFS rather than here.
 * Returns the input unchanged when there is nothing to exclude.
 */
export function restrictGraphToClient(graph: KnowledgeGraph, clientNodeId: string): KnowledgeGraph {
  const excluded = new Set(
    graph.nodes.filter((n) => n.type === 'client' && n.id !== clientNodeId).map((n) => n.id),
  );
  if (excluded.size === 0) return graph;
  return {
    nodes: graph.nodes.filter((n) => !excluded.has(n.id)),
    edges: graph.edges.filter((e) => !excluded.has(e.src) && !excluded.has(e.dst)),
  };
}

/**
 * Walk the graph from a seed node up to `depth` hops (BFS). Answers questions
 * like "our history with this office on this issue" by returning the connected
 * subgraph. Deterministic ordering for stable rendering + tests.
 */
export function walkFrom(
  graph: KnowledgeGraph,
  seedId: string,
  depth: number,
): KnowledgeGraph {
  const adjacency = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    (adjacency.get(e.src) ?? adjacency.set(e.src, []).get(e.src)!).push(e);
    // undirected walk: also index by dst so we can traverse both ways
    (adjacency.get(e.dst) ?? adjacency.set(e.dst, []).get(e.dst)!).push(e);
  }

  const keptNodes = new Set<string>();
  const keptEdges = new Set<GraphEdge>();
  let frontier = [seedId];
  keptNodes.add(seedId);

  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of adjacency.get(id) ?? []) {
        keptEdges.add(e);
        const other = e.src === id ? e.dst : e.src;
        if (!keptNodes.has(other)) {
          keptNodes.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  return {
    nodes: graph.nodes
      .filter((n) => keptNodes.has(n.id))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: Array.from(keptEdges).sort((a, b) =>
      `${a.src}${a.relation}${a.dst}`.localeCompare(`${b.src}${b.relation}${b.dst}`),
    ),
  };
}
