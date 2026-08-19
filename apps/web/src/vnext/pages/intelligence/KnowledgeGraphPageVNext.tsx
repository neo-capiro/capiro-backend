import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CytoscapeComponent from 'react-cytoscapejs';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Core, ElementDefinition, NodeSingular, StylesheetStyle } from 'cytoscape';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { IntelPill, IntelRefreshIcon, IntelSegmented, IntelSkeletonRows } from './intel-ui.js';

// Register fCoSE (fast force-directed layout) on the shared cytoscape singleton
// react-cytoscapejs uses. Replaces the built-in `cose` — an O(n²) physics sim that
// ran to convergence on the main thread and froze the UI while a large graph loaded.
cytoscape.use(fcose);

/**
 * Knowledge Graph — vNext port of the canonical standalone route
 * (pages/intelligence/KnowledgeGraphPage.tsx mounting panels/
 * KnowledgeGraphPanel.tsx).
 *
 * Same data plane: GET /api/memory/graph[/client/:id | /path?to=…] under the
 * ['memory-graph', endpoint] key, the tenant client list under
 * ['memory-graph-clients'], and the idempotent POST /api/memory/backfill
 * populate (10-minute timeout — a full backfill outruns the 30s axios
 * default). The Cytoscape scene (stylesheet, fCoSE layout, click-to-expand
 * focus, double-click client drill-in) is IDENTICAL — those literals are
 * canvas paint data, not DOM CSS. Only the surrounding chrome moved to vNext
 * primitives.
 *
 * Height: the vNext shell scrolls the page, so the canvas owns a definite
 * viewport-derived height in intelligence-vnext.css (.intel-graph-canvas) —
 * pinned by intelligence-layout.contract.test.ts (Phase 3 briefing lesson 1).
 */

interface ApiNode { id: string; type: string; slug: string; label: string }
interface ApiEdge { src: string; dst: string; relation: string; origin: 'fk' | 'mention' }
interface GraphResponse { nodes: ApiNode[]; edges: ApiEdge[]; paths?: string[][] }

const TYPE_COLORS: Record<string, string> = {
  client: '#38bdf8', 'client-soul': '#38bdf8', 'client-compass': '#22d3ee',
  'client-people': '#2dd4bf', 'client-hub': '#0ea5e9',
  bill: '#a78bfa', person: '#34d399', issue: '#fbbf24',
  meeting: '#f472b6', thread: '#94a3b8', office: '#fb7185', note: '#c4b5fd',
  // Track B cache-enriched kinds (money flow / lobbying / acquisition):
  employer: '#4ade80', fec_committee: '#16a34a', candidate: '#86efac',
  lda_client: '#c084fc', lda_registrant: '#a855f7', lda_issue_code: '#fbbf24',
  capability: '#fb923c', program_element: '#f97316',
};
const colorForType = (t: string) => TYPE_COLORS[t] ?? '#cbd5e1';
const FK_COLOR = '#7dd3fc';
const MENTION_COLOR = '#64748b';

type ViewMode = 'full' | 'client' | 'path';

// Cytoscape stylesheet. Kept module-level (stable identity) so the graph is not
// restyled on every render. `.faded` / `.highlight` drive click-to-expand focus.
const STYLESHEET: StylesheetStyle[] = [
  {
    selector: 'node',
    style: {
      'background-color': 'data(color)',
      label: 'data(label)',
      color: '#e2e8f0',
      'font-size': 9,
      'text-wrap': 'ellipsis',
      'text-max-width': '120px',
      'text-valign': 'bottom',
      'text-margin-y': 3,
      width: 'data(size)',
      height: 'data(size)',
      'border-width': 0,
    },
  },
  {
    selector: 'node[?onPath]',
    style: { 'border-width': 3, 'border-color': '#fde047' },
  },
  {
    selector: 'edge',
    style: {
      width: 'data(width)',
      'line-color': 'data(color)',
      'curve-style': 'bezier',
      'target-arrow-color': 'data(color)',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.7,
      opacity: 0.55,
    },
  },
  // Mention edges (analyst wikilinks) render dashed to distinguish from facts.
  { selector: 'edge[origin = "mention"]', style: { 'line-style': 'dashed' } },
  { selector: '.faded', style: { opacity: 0.08, 'text-opacity': 0 } },
  {
    selector: 'node.highlight',
    style: { 'border-width': 3, 'border-color': '#f8fafc', 'font-size': 11 },
  },
  { selector: 'edge.highlight', style: { opacity: 0.95, width: 2.4 } },
];

// Layout: fCoSE (fast force-directed, non-animated — computes silently, paints once).
// The mount prop uses a no-op `preset` so react-cytoscapejs never runs an expensive
// layout on mount; the data-change effect is the single layout driver. Always
// `randomize` (fresh spectral init): a view switch swaps in a DISJOINT node set
// where a warm-start collapses to (0,0).
const LAYOUT = { name: 'fcose', animate: false, quality: 'default', randomize: true, nodeRepulsion: 8000, idealEdgeLength: 90, padding: 30 } as const;
const PRESET_LAYOUT = { name: 'preset' } as const;

export function KnowledgeGraphPageVNext() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const cyRef = useRef<Core | null>(null);
  const [originFilter, setOriginFilter] = useState<'all' | 'fk' | 'mention'>('all');
  const [view, setView] = useState<ViewMode>('full');
  const [clientId, setClientId] = useState<string | undefined>();
  const [target, setTarget] = useState<string | undefined>();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [populateConfirmOpen, setPopulateConfirmOpen] = useState(false);

  // Populate the graph from the tenant's DB data (idempotent backfill).
  const populateMutation = useMutation({
    // A full backfill (clients + memories + meetings + emails + Meri sessions +
    // embeddings) can run for minutes on a large tenant — the 30s default axios
    // timeout aborts it. Give it 10 min (well under the 4000s ALB idle timeout).
    mutationFn: async () =>
      (await api.post<{ counts: { clients: number; clioMemories: number; meetings: number } }>(
        '/api/memory/backfill', {}, { timeout: 600_000 },
      )).data,
    onSuccess: (d) => {
      const c = d.counts;
      toast.success(`Graph populated: ${c.clients} clients, ${c.clioMemories} memories, ${c.meetings} meetings.`);
      void qc.invalidateQueries({ queryKey: ['memory-graph'] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Populate failed'),
  });

  // Client list for the selectors (clients appear as nodes in the full graph,
  // but we fetch the canonical list for stable labels).
  const clientsQuery = useQuery<{ id: string; name: string }[]>({
    queryKey: ['memory-graph-clients'],
    // The firm's own tenant-scoped clients (bare array). NOT /api/lda-intel/clients,
    // which is the global federal LDA database and won't contain the firm's clients.
    queryFn: async () => (await api.get<Array<{ id: string; name: string }>>(
      '/api/clients')).data ?? [],
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });

  const endpoint = useMemo(() => {
    if (view === 'client' && clientId) return `/api/memory/graph/client/${clientId}`;
    if (view === 'path' && target) return `/api/memory/graph/path?to=${encodeURIComponent(target)}`;
    return '/api/memory/graph';
  }, [view, clientId, target]);

  const graphQuery = useQuery<GraphResponse>({
    queryKey: ['memory-graph', endpoint],
    queryFn: async () => (await api.get<GraphResponse>(endpoint)).data,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  // office/person targets available for "path to" (from the loaded graph)
  const targetOptions = useMemo(() => {
    const data = graphQuery.data;
    if (!data) return [];
    return data.nodes
      .filter((n) => n.type === 'office' || n.type === 'person')
      .map((n) => ({ label: `${n.label} (${n.type})`, value: n.id }));
  }, [graphQuery.data]);

  const elements = useMemo<ElementDefinition[]>(() => {
    const data = graphQuery.data;
    if (!data) return [];
    const onPath = new Set<string>((data.paths ?? []).flat());
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
      degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
    }
    const nodeIds = new Set(data.nodes.map((n) => n.id));
    const nodes: ElementDefinition[] = data.nodes.map((n) => ({
      data: {
        id: n.id,
        label: `${n.label || n.slug}`,
        type: n.type,
        color: onPath.has(n.id) ? '#fde047' : colorForType(n.type),
        size: 14 + Math.min(26, (degree.get(n.id) ?? 0) * 2),
        onPath: onPath.has(n.id) ? 1 : 0,
      },
    }));
    const filtered = originFilter === 'all' ? data.edges : data.edges.filter((e) => e.origin === originFilter);
    const edges: ElementDefinition[] = filtered
      // Cytoscape drops edges whose endpoints are missing; guard defensively.
      .filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst))
      .map((e, i) => ({
        data: {
          id: `e${i}:${e.src}->${e.dst}`,
          source: e.src,
          target: e.dst,
          label: e.relation,
          origin: e.origin,
          color: e.origin === 'fk' ? FK_COLOR : MENTION_COLOR,
          width: e.origin === 'fk' ? 1.6 : 0.8,
        },
      }));
    return [...nodes, ...edges];
  }, [graphQuery.data, originFilter]);

  // Click-to-expand focus: highlight a node + its immediate neighborhood, fade
  // the rest. Clicking blank space clears the focus. Runs against the live cy
  // instance (imperative, as Cytoscape intends) so it never rebuilds the graph.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass('faded highlight');
    if (!focusId) return;
    const node = cy.getElementById(focusId);
    if (node.empty()) return;
    const hood = node.closedNeighborhood();
    cy.elements().not(hood).addClass('faded');
    hood.addClass('highlight');
  }, [focusId, elements]);

  // Lay out whenever the graph DATA changes. The mount `layout` prop is a no-op
  // preset (above), so this effect is the SINGLE layout driver — one fCoSE run per
  // dataset, no double-layout on load. Keyed on the fetched data only (NOT
  // focusId/originFilter, which must not re-scatter nodes).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;
    cy.layout(LAYOUT).run();
  }, [graphQuery.data]);

  const nodeCount = graphQuery.data?.nodes.length ?? 0;
  const edgeCount = useMemo(
    () => elements.filter((el) => el.data && 'source' in el.data).length,
    [elements],
  );

  const populateButton = (variant: 'primary' | 'secondary' = 'secondary') => (
    <CapiroButton
      size="compact"
      variant={variant}
      leadingIcon={<IntelRefreshIcon size={13} />}
      loading={populateMutation.isPending}
      onClick={() => setPopulateConfirmOpen(true)}
    >
      Populate graph
    </CapiroButton>
  );

  let body: ReactNode;
  if (graphQuery.isLoading) {
    body = <IntelSkeletonRows rows={10} testId="graph-loading" />;
  } else if (graphQuery.isError) {
    body = <CapiroEmptyState title="Could not load the knowledge graph." />;
  } else if (view === 'client' && !clientId) {
    body = <CapiroEmptyState title="Select a client to see their subgraph." />;
  } else if (view === 'path' && !target) {
    body = <CapiroEmptyState title="Pick a target office or person to find routes from your clients." />;
  } else if (nodeCount === 0) {
    body = (
      <CapiroEmptyState
        title="No connections yet."
        description="Populate the graph from your clients, memories, and meetings to get started."
        action={populateButton('primary')}
      />
    );
  } else {
    body = (
      <div className="intel-graph-canvas">
        <CytoscapeComponent
          elements={elements}
          stylesheet={STYLESHEET}
          style={{ width: '100%', height: '100%' }}
          layout={PRESET_LAYOUT}
          minZoom={0.1}
          maxZoom={3}
          cy={(cy: Core) => {
            cyRef.current = cy;
            cy.removeAllListeners();
            // Single click: focus a node's neighborhood (click-to-expand).
            cy.on('tap', 'node', (evt) => setFocusId((evt.target as NodeSingular).id()));
            // Double click a client node: drill into its subgraph.
            cy.on('dbltap', 'node', (evt) => {
              const n = evt.target as NodeSingular;
              if (n.data('type') === 'client') {
                setClientId(n.id());
                setView('client');
                setFocusId(null);
              }
            });
            // Click empty canvas: clear focus.
            cy.on('tap', (evt) => {
              if (evt.target === cy) setFocusId(null);
            });
          }}
        />
      </div>
    );
  }

  return (
    <div className="intel intel-knowledge-graph">
      <header className="intel-head">
        <div>
          <div className="intel-head__title-row">
            <h2 className="intel-head__title">Knowledge Graph</h2>
            <span className="intel-muted">
              {nodeCount} nodes · {edgeCount} connections
              {graphQuery.data?.paths?.length ? ` · ${graphQuery.data.paths.length} route(s)` : ''}
              {' · click a node to focus, double-click a client to drill in'}
            </span>
          </div>
        </div>
      </header>

      <div className="intel-graph-controls">
        <IntelSegmented<ViewMode>
          value={view}
          ariaLabel="Graph view"
          onChange={(v) => { setView(v); setFocusId(null); }}
          options={[
            { label: 'Full firm', value: 'full' },
            { label: 'By client', value: 'client' },
            { label: 'Path to…', value: 'path' },
          ]}
        />
        {view === 'client' ? (
          <label className="capiro-field">
            <span className="capiro-field__label">Client</span>
            <select
              className="capiro-select"
              aria-label="Select client"
              value={clientId ?? ''}
              onChange={(event) => setClientId(event.target.value || undefined)}
            >
              <option value="">Select client</option>
              {(clientsQuery.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {view === 'path' ? (
          <label className="capiro-field" style={{ minWidth: 240 }}>
            <span className="capiro-field__label">Target office / person</span>
            <select
              className="capiro-select"
              aria-label="Target office / person"
              value={target ?? ''}
              onChange={(event) => setTarget(event.target.value || undefined)}
            >
              <option value="">Target office / person</option>
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <IntelPill tone="cyan">— fact</IntelPill>
        <IntelPill title="Analyst wikilinks render dashed">· · mention</IntelPill>
        <IntelSegmented<'all' | 'fk' | 'mention'>
          value={originFilter}
          ariaLabel="Edge origin filter"
          onChange={setOriginFilter}
          options={[
            { label: 'All', value: 'all' },
            { label: 'Facts', value: 'fk' },
            { label: 'Mentions', value: 'mention' },
          ]}
        />
        {focusId ? (
          <CapiroButton size="compact" variant="quiet" onClick={() => setFocusId(null)}>
            Clear focus
          </CapiroButton>
        ) : null}
        {populateButton()}
      </div>

      {body}

      <CapiroModal
        open={populateConfirmOpen}
        title="Populate the knowledge graph?"
        onClose={() => setPopulateConfirmOpen(false)}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <span className="intel-muted" style={{ fontSize: 13 }}>
            Builds graph nodes/links from your clients, memories, and meetings. Safe to run anytime.
          </span>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <CapiroButton size="compact" onClick={() => setPopulateConfirmOpen(false)}>
              Cancel
            </CapiroButton>
            <CapiroButton
              size="compact"
              variant="primary"
              onClick={() => {
                setPopulateConfirmOpen(false);
                populateMutation.mutate();
              }}
            >
              Populate
            </CapiroButton>
          </div>
        </div>
      </CapiroModal>
    </div>
  );
}
