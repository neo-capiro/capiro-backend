import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Empty, Skeleton } from 'antd';
import { RightOutlined, WarningOutlined } from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import { getMoneyGraph } from './api.js';
import { GraphView, type GraphEdge, type GraphNode } from './charts/index.js';
import { LINE_TYPES, PeCodeBadge } from './pe-shared.js';

/**
 * Money graph view (BL-3 / F12): every relationship-bearing line as a node,
 * clustered into color-of-money columns (RDT&E → procurement → O&M), every
 * edge typed + evidence-bearing. Valley-of-death watch (F24) rolls up flagged
 * RDT&E lines. Deterministic layout — no physics, no randomness.
 */

const REL_META: Record<string, { label: string; color: string }> = {
  rdte_to_procurement: { label: 'RDT&E → Procurement', color: '#1A6E78' },
  procurement_to_om: { label: 'Procurement → O&M', color: '#A26913' },
  predecessor_successor: { label: 'Predecessor', color: '#B5301B' },
  same_program: { label: 'Same program', color: '#4E5A86' },
  same_capability: { label: 'Same capability', color: '#2A57CE' },
  related_pe_exhibit: { label: 'Related PEs (P-40)', color: '#2A57CE' },
};

const COL_ORDER = ['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_BLI'];
/** Cap nodes per column so the SVG stays legible; the cap is stated on-screen. */
const MAX_PER_COL = 24;

export function MoneyGraphView({ onOpen }: { onOpen: (peCode: string) => void }) {
  const api = useApi();
  const query = useQuery({
    queryKey: ['budget-lines-graph'],
    queryFn: () => getMoneyGraph(api),
    staleTime: 5 * 60 * 1000,
  });

  const layout = useMemo(() => {
    const data = query.data;
    if (!data) return null;
    // Rank nodes by degree so the cap keeps the most-connected lines.
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const cols = COL_ORDER.map((lt) =>
      data.nodes
        .filter((n) => n.lineType === lt)
        .sort((a, b) => (degree.get(b.peCode) ?? 0) - (degree.get(a.peCode) ?? 0))
        .slice(0, MAX_PER_COL),
    );
    const other = data.nodes.filter((n) => !COL_ORDER.includes(n.lineType ?? ''));
    if (other.length) cols.push(other.slice(0, MAX_PER_COL));
    const totalShown = cols.reduce((s, c) => s + c.length, 0);
    const nodes: GraphNode[] = [];
    cols.forEach((group, ci) => {
      const nx = cols.length === 1 ? 0.5 : ci / (cols.length - 1);
      group.forEach((n, ri) => {
        const ny = group.length === 1 ? 0.5 : ri / (group.length - 1);
        nodes.push({
          id: n.peCode,
          code: n.peCode,
          label: n.title.split(' ').slice(0, 2).join(' '),
          nx,
          ny,
          color: (n.lineType && LINE_TYPES[n.lineType]?.color) || 'var(--ink-3)',
          size: 22,
        });
      });
    });
    const shownIds = new Set(nodes.map((n) => n.id));
    const edges: GraphEdge[] = data.edges
      .filter((e) => shownIds.has(e.from) && shownIds.has(e.to))
      .map((e) => ({
        from: e.from,
        to: e.to,
        color: (REL_META[e.relType] ?? { color: 'var(--ink-3)' }).color,
        confidence: e.status === 'candidate' ? 'low' : e.confidence,
      }));
    const usedRels = [...new Set(data.edges.map((e) => e.relType))];
    const height = Math.max(420, Math.max(...cols.map((c) => c.length)) * 34 + 120);
    return { nodes, edges, usedRels, totalShown, totalNodes: data.nodes.length, height };
  }, [query.data]);

  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (query.isError || !query.data) {
    return <Alert type="error" showIcon message="Unable to load the money graph" />;
  }
  const vodLines = query.data.nodes.filter((n) => n.valleyOfDeath);

  return (
    <div className="bl-graph-view">
      <div className="pe-idx-card">
        <div className="pe-idx-card-head">
          <h3>Defense money graph</h3>
          <span className="pe-idx-count">
            {query.data.nodes.length} lines · {query.data.edges.length} evidence-bearing edges
            {layout && layout.totalShown < layout.totalNodes
              ? ` · showing the ${layout.totalShown} most-connected`
              : ''}
          </span>
        </div>
        {!layout || layout.nodes.length === 0 ? (
          <Empty description="No relationships derived yet — the graph populates as derive-relationships runs over P-40 related PEs, shared programs, and consolidation detection." />
        ) : (
          <div className="bl-panel-body">
            <GraphView nodes={layout.nodes} edges={layout.edges} w={860} h={layout.height} padding={70} onNode={onOpen} />
            <div className="bl-graph-legend">
              {layout.usedRels.map((t) => (
                <span key={t} className="bl-gl-item">
                  <span className="bl-gl-ln" style={{ background: (REL_META[t] ?? { color: 'var(--ink-3)' }).color }} />
                  {(REL_META[t] ?? { label: t }).label}
                </span>
              ))}
              <span className="bl-gl-item muted">
                <span className="bl-gl-ln dashed" />
                dashed = lower confidence / candidate
              </span>
              <span className="bl-gl-item muted">columns = color of money (RDT&amp;E → Procurement → O&amp;M)</span>
            </div>
          </div>
        )}
      </div>

      <div className="pe-idx-card">
        <div className="pe-idx-card-head">
          <h3>Valley-of-death watch</h3>
          <span className="pe-idx-count">
            {vodLines.length} RDT&amp;E line{vodLines.length === 1 ? '' : 's'} with no path to a buy
          </span>
        </div>
        <div className="bl-panel-body">
          {vodLines.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No valley-of-death flags among graph-connected lines."
            />
          ) : (
            <div className="bl-vod-list">
              {vodLines.slice(0, 20).map((l) => (
                <button key={l.peCode} type="button" className="bl-vod-row" onClick={() => onOpen(l.peCode)}>
                  <WarningOutlined className="bl-vod-ico" />
                  <PeCodeBadge code={l.peCode} size="sm" />
                  <span className="bl-vod-nm">{l.title}</span>
                  <span className="bl-vod-diag">RDT&amp;E present · no procurement / O&amp;M / award link</span>
                  <RightOutlined />
                </button>
              ))}
              <div className="bl-vod-note">
                Flagged: prototype/development-stage RDT&amp;E with no linked procurement line, no O&amp;M
                sustainment, and no award evidence — development money with no visible path to a buy.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
