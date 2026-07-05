import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Empty, Popconfirm, Segmented, Select, Space, Spin, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import ForceGraph3D from 'react-force-graph-3d';
import { useApi } from '../../../lib/use-api.js';

const { Text } = Typography;

/**
 * Knowledge Graph subtab — a floating 3D force graph (react-force-graph-3d /
 * three.js, MIT) over the institutional-memory graph. Tenant + own-private
 * scoped server-side by RLS.
 *
 * Views:
 *   - Full firm:   GET /api/memory/graph            (everything you may see)
 *   - By client:   GET /api/memory/graph/client/:id (subgraph around a client)
 *   - Path to:     GET /api/memory/graph/path?to=   (routes from clients to a
 *                  target office/person — "who do we already know near X?")
 *
 * Visual language: node color = entity type, size = degree; fact edges (fk,
 * DB foreign keys) are bright + animated, mention edges (analyst wikilinks) dim.
 */

interface ApiNode { id: string; type: string; slug: string; label: string }
interface ApiEdge { src: string; dst: string; relation: string; origin: 'fk' | 'mention' }
interface GraphResponse { nodes: ApiNode[]; edges: ApiEdge[]; paths?: string[][] }

interface GNode { id: string; label: string; type: string; color: string; val: number }
interface GLink { source: string; target: string; origin: 'fk' | 'mention'; color: string; width: number }

const TYPE_COLORS: Record<string, string> = {
  client: '#38bdf8', 'client-soul': '#38bdf8', 'client-compass': '#22d3ee',
  'client-people': '#2dd4bf', 'client-hub': '#0ea5e9',
  bill: '#a78bfa', person: '#34d399', issue: '#fbbf24',
  meeting: '#f472b6', thread: '#94a3b8', office: '#fb7185', note: '#c4b5fd',
};
const colorForType = (t: string) => TYPE_COLORS[t] ?? '#cbd5e1';
const FK_COLOR = '#7dd3fc';
const MENTION_COLOR = 'rgba(148,163,184,0.4)';

type ViewMode = 'full' | 'client' | 'path';

export function KnowledgeGraphPanel() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const fgRef = useRef<unknown>(null);
  const [originFilter, setOriginFilter] = useState<'all' | 'fk' | 'mention'>('all');
  const [view, setView] = useState<ViewMode>('full');
  const [clientId, setClientId] = useState<string | undefined>();
  const [target, setTarget] = useState<string | undefined>();

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
      message.success(`Graph populated: ${c.clients} clients, ${c.clioMemories} memories, ${c.meetings} meetings.`);
      qc.invalidateQueries({ queryKey: ['memory-graph'] });
    },
    onError: (e: unknown) => message.error(e instanceof Error ? e.message : 'Populate failed'),
  });

  // Client list for the selectors (clients appear as nodes in the full graph,
  // but we fetch the canonical list for stable labels).
  const clientsQuery = useQuery<{ id: string; name: string }[]>({
    queryKey: ['memory-graph-clients'],
    // The firm's own tenant-scoped clients (bare array). NOT /api/lda-intel/clients,
    // which is the global federal LDA database and won't contain the firm's clients
    // — that mismatch is why this dropdown was empty.
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

  const graphData = useMemo(() => {
    const data = graphQuery.data;
    if (!data) return { nodes: [] as GNode[], links: [] as GLink[] };
    const onPath = new Set<string>((data.paths ?? []).flat());
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
      degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
    }
    const nodes: GNode[] = data.nodes.map((n) => ({
      id: n.id,
      label: `${n.label || n.slug} (${n.type})`,
      type: n.type,
      color: onPath.size && onPath.has(n.id) ? '#fde047' : colorForType(n.type),
      val: (1 + Math.min(12, degree.get(n.id) ?? 0)) * (onPath.has(n.id) ? 1.8 : 1),
    }));
    const filtered = originFilter === 'all' ? data.edges : data.edges.filter((e) => e.origin === originFilter);
    const links: GLink[] = filtered.map((e) => ({
      source: e.src, target: e.dst, origin: e.origin,
      color: e.origin === 'fk' ? FK_COLOR : MENTION_COLOR,
      width: e.origin === 'fk' ? 1.4 : 0.6,
    }));
    return { nodes, links };
  }, [graphQuery.data, originFilter]);

  const controls = (
    <Space wrap>
      <Segmented
        size="small"
        value={view}
        onChange={(v) => setView(v as ViewMode)}
        options={[
          { label: 'Full firm', value: 'full' },
          { label: 'By client', value: 'client' },
          { label: 'Path to…', value: 'path' },
        ]}
      />
      {view === 'client' && (
        <Select
          size="small" showSearch placeholder="Select client" style={{ width: 200 }}
          value={clientId} onChange={setClientId} loading={clientsQuery.isLoading}
          options={(clientsQuery.data ?? []).map((c) => ({ label: c.name, value: c.id }))}
          filterOption={(i, o) => (o?.label as string ?? '').toLowerCase().includes(i.toLowerCase())}
        />
      )}
      {view === 'path' && (
        <Select
          size="small" showSearch placeholder="Target office / person" style={{ width: 240 }}
          value={target} onChange={setTarget} options={targetOptions}
          filterOption={(i, o) => (o?.label as string ?? '').toLowerCase().includes(i.toLowerCase())}
        />
      )}
      <Tag color="cyan">— fact</Tag>
      <Tag color="default" style={{ opacity: 0.6 }}>· mention</Tag>
      <Segmented
        size="small" value={originFilter}
        onChange={(v) => setOriginFilter(v as 'all' | 'fk' | 'mention')}
        options={[{ label: 'All', value: 'all' }, { label: 'Facts', value: 'fk' }, { label: 'Mentions', value: 'mention' }]}
      />
      <Popconfirm
        title="Populate the knowledge graph?"
        description="Builds graph nodes/links from your clients, memories, and meetings. Safe to run anytime."
        okText="Populate" onConfirm={() => populateMutation.mutate()}
      >
        <Button size="small" icon={<ReloadOutlined />} loading={populateMutation.isPending}>
          Populate graph
        </Button>
      </Popconfirm>
    </Space>
  );

  let body: React.ReactNode;
  if (graphQuery.isLoading) {
    body = <div style={{ display: 'grid', placeItems: 'center', height: 620 }}><Spin tip="Loading knowledge graph…" /></div>;
  } else if (graphQuery.isError) {
    body = <Empty style={{ paddingTop: 80 }} description="Could not load the knowledge graph." />;
  } else if (view === 'client' && !clientId) {
    body = <Empty style={{ paddingTop: 80 }} description="Select a client to see their subgraph." />;
  } else if (view === 'path' && !target) {
    body = <Empty style={{ paddingTop: 80 }} description="Pick a target office or person to find routes from your clients." />;
  } else if (graphData.nodes.length === 0) {
    body = (
      <Empty
        style={{ paddingTop: 80 }}
        description="No connections yet. Populate the graph from your clients, memories, and meetings to get started."
      >
        <Button type="primary" icon={<ReloadOutlined />} loading={populateMutation.isPending}
          onClick={() => populateMutation.mutate()}>
          Populate graph
        </Button>
      </Empty>
    );
  } else {
    body = (
      <div style={{ height: 620, background: '#0b1220', borderRadius: 8, overflow: 'hidden' }}>
        <ForceGraph3D
          ref={fgRef as never}
          graphData={graphData}
          backgroundColor="#0b1220"
          nodeColor={(n: GNode) => n.color}
          nodeVal={(n: GNode) => n.val}
          nodeLabel={(n: GNode) => n.label}
          nodeOpacity={0.95}
          nodeResolution={16}
          linkColor={(l: GLink) => l.color}
          linkWidth={(l: GLink) => l.width}
          linkOpacity={0.5}
          linkDirectionalParticles={(l: GLink) => (l.origin === 'fk' ? 2 : 0)}
          linkDirectionalParticleWidth={1.2}
          linkDirectionalParticleSpeed={0.006}
          enableNodeDrag
          showNavInfo={false}
          warmupTicks={40}
          cooldownTicks={120}
        />
      </div>
    );
  }

  return (
    <Card
      size="small"
      styles={{ body: { padding: 0 } }}
      title={
        <Space size="middle">
          <span>Knowledge Graph</span>
          <Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>
            {graphData.nodes.length} nodes · {graphData.links.length} connections
            {graphQuery.data?.paths?.length ? ` · ${graphQuery.data.paths.length} route(s)` : ''}
          </Text>
        </Space>
      }
      extra={controls}
    >
      {body}
    </Card>
  );
}
