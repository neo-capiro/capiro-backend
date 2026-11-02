import { buildKnowledgeGraph, type FkRelation } from '../memory/memory-graph.helpers.js';
import { cacheEdgesToFkRelations, type KgWalkEdgeRow } from '../memory/kg-cache-enrich.helpers.js';
import { graphPathInput, sourceLinkedPaths } from './meri-graph-paths.js';
import type { MeriGraphProjection } from './meri-graph-source.js';

const client = '30000000-0000-4000-8000-000000000001';
const other = '30000000-0000-4000-8000-000000000002';
function fixture(): MeriGraphProjection {
  const rows: FkRelation[] = [
    {
      srcType: 'client',
      srcSlug: client,
      srcLabel: 'Selected client',
      dstType: 'person',
      dstSlug: 'p1',
      dstLabel: 'Contact',
      relation: 'contact',
      basis: 'direct',
      sources: [{ kind: 'client_person', id: 'p1' }],
    },
    {
      srcType: 'client',
      srcSlug: other,
      srcLabel: 'Other client',
      dstType: 'person',
      dstSlug: 'p1',
      relation: 'contact',
      basis: 'direct',
      sources: [{ kind: 'client_person', id: 'p2' }],
    },
    {
      srcType: 'client',
      srcSlug: other,
      dstType: 'office',
      dstSlug: 'o2',
      relation: 'works_with',
      basis: 'direct',
      sources: [{ kind: 'client_person', id: 'p3' }],
    },
  ];
  const wiki = [
    {
      tenantId: 'test',
      srcItemId: 'memory1',
      relation: 'mentions',
      dstType: 'office',
      dstSlug: 'o1',
      sources: [{ kind: 'memory_item' as const, id: 'memory1' }],
    },
  ];
  return {
    ...buildKnowledgeGraph(
      rows,
      wiki,
      new Map([['memory1', { type: 'person', slug: 'p1', label: 'Contact' }]]),
    ),
    coverageReasons: [],
  };
}

describe('source-linked current graph paths', () => {
  it('returns exact source references and distinguishes a thematic path from a direct relationship', () => {
    const out = sourceLinkedPaths(fixture(), { to: 'office:o1', depth: 3, clientId: client });
    expect(out.paths).toEqual([
      {
        nodes: [
          { id: `client:${client}`, type: 'client', label: 'Selected client' },
          { id: 'person:p1', type: 'person', label: 'Contact' },
          { id: 'office:o1', type: 'office', label: 'o1' },
        ],
        edges: [
          {
            src: `client:${client}`,
            dst: 'person:p1',
            relation: 'contact',
            origin: 'fk',
            basis: 'direct',
            sources: [{ kind: 'client_person', id: 'p1' }],
          },
          {
            src: 'person:p1',
            dst: 'office:o1',
            relation: 'mentions',
            origin: 'mention',
            basis: 'thematic',
            sources: [{ kind: 'memory_item', id: 'memory1' }],
          },
        ],
        basis: 'thematic',
      },
    ]);
    expect(out.coverage).toEqual({
      state: 'complete',
      scope: 'one_shortest_path_per_visible_client',
      maxDepth: 3,
      maxPaths: 20,
      clientsSearched: 1,
      reasons: [],
    });
    expect(
      sourceLinkedPaths(fixture(), { to: 'person:p1', depth: 1, clientId: client }).paths[0]?.basis,
    ).toBe('direct');
  });
  it('does not route through another client or reveal an inaccessible target through a different result shape', () => {
    const hidden = sourceLinkedPaths(fixture(), { to: 'office:o2', depth: 5, clientId: client });
    const absent = sourceLinkedPaths(fixture(), {
      to: 'office:absent',
      depth: 5,
      clientId: client,
    });
    expect(hidden).toEqual(absent);
    expect(hidden.paths).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain('Other client');
  });
  it('enforces depth, ignores cycles and deterministically chooses one shortest route per client', () => {
    const graph = fixture();
    graph.edges.push({ ...graph.edges[0]! });
    expect(sourceLinkedPaths(graph, { to: 'office:o1', depth: 1, clientId: client }).paths).toEqual(
      [],
    );
    const result = sourceLinkedPaths(graph, { to: 'office:o1', depth: 5 });
    expect(result.paths).toHaveLength(2);
    expect(result.paths.every((path) => path.edges.length === 2)).toBe(true);
    graph.edges.reverse();
    graph.nodes.reverse();
    expect(sourceLinkedPaths(graph, { to: 'office:o1', depth: 5 })).toEqual(result);
  });
  it('keeps separate source references when multiple notes support the same edge', () => {
    const rows = [
      {
        tenantId: 't',
        srcItemId: 'a',
        relation: 'mentions',
        dstType: 'office',
        dstSlug: 'o',
        sources: [{ kind: 'memory_item' as const, id: 'a' }],
      },
      {
        tenantId: 't',
        srcItemId: 'b',
        relation: 'mentions',
        dstType: 'office',
        dstSlug: 'o',
        sources: [{ kind: 'memory_item' as const, id: 'b' }],
      },
    ];
    const graph = buildKnowledgeGraph(
      [],
      rows,
      new Map(['a', 'b'].map((id) => [id, { type: 'person', slug: 'p', label: 'Contact' }])),
    );
    expect(graph.edges[0]?.sources).toEqual([
      { kind: 'memory_item', id: 'a' },
      { kind: 'memory_item', id: 'b' },
    ]);
  });
  it('omits unsupported edges and carries source truncation into coverage', () => {
    const graph = fixture();
    graph.coverageReasons = ['memory_items_row_limit'];
    delete graph.edges.find((edge) => edge.origin === 'mention')!.sources;
    const out = sourceLinkedPaths(graph, { to: 'office:o1', depth: 3, clientId: client });
    expect(out.paths).toEqual([]);
    expect(out.coverage.state).toBe('partial');
    expect(out.coverage.reasons).toEqual([
      'memory_items_row_limit',
      'source_reference_unavailable',
    ]);
  });
  it('caps paths without calling a truncated result complete', () => {
    const graph = fixture();
    graph.edges = [];
    graph.nodes = [{ id: 'office:o', type: 'office', slug: 'o', label: 'Office' }];
    for (let i = 0; i < 25; i++) {
      const id = `client:c${i}`;
      graph.nodes.push({ id, type: 'client', slug: `c${i}`, label: `Client ${i}` });
      graph.edges.push({
        src: id,
        dst: 'office:o',
        relation: 'contact',
        origin: 'fk',
        basis: 'direct',
        sources: [{ kind: 'client_person', id: `p${i}` }],
      });
    }
    const out = sourceLinkedPaths(graph, { to: 'office:o', depth: 1 });
    expect(out.paths).toHaveLength(20);
    expect(out.coverage.state).toBe('partial');
    expect(out.coverage.reasons).toContain('path_limit');
  });
  it('labels cache projections as derived and keeps their exact logical source identity', () => {
    const row = {
      src_kind: 'client',
      src_id: client,
      dst_kind: 'office',
      dst_id: 'o',
      edge_type: 'related_to',
      agg_count: 2,
      agg_weight: '900719925474099.001',
    } as KgWalkEdgeRow;
    const [relation] = cacheEdgesToFkRelations([row], new Map(), true);
    expect(relation?.basis).toBe('derived');
    expect(relation?.sources).toEqual([
      {
        kind: 'kg_cache_projection',
        id: `client\u001f${client}\u001frelated_to\u001foffice\u001fo`,
      },
    ]);
    expect(relation?.relation).toBe('related_to'); // Do not turn a formatted, rounded aggregate label into path evidence.
    expect(cacheEdgesToFkRelations([row], new Map())[0]?.sources).toBeUndefined();
  });
  it('validates exact input, closes authority fields, and never clamps a wrong critical selector', () => {
    expect(graphPathInput({ to: 'office:o', clientId: client })).toEqual({
      to: 'office:o',
      clientId: client,
      depth: 3,
    });
    for (const input of [
      { to: ' office:o' },
      { to: 'missing-type' },
      { to: 'office:o', depth: 0 },
      { to: 'office:o', depth: 6 },
      { to: 'office:o', depth: '3' },
      { to: 'office:o', clientId: '' },
      { to: 'office:o', tenantId: 'forged' },
      { to: 'office:o', knownAt: '2026-01-01' },
    ])
      expect(() => graphPathInput(input)).toThrow();
  });
});
