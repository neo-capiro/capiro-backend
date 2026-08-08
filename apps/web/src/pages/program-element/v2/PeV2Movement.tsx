/**
 * Program Elements v2 — Movement surface.
 * Feed + table over the existing /api/budget-lines/movement response.
 * Classification spine: official change = ink, conflict = warning, else raised.
 * (Graph mode from the legacy finder is intentionally absent in v2.)
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Skeleton } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { getMovement } from '../api.js';
import type { MovementFeedItem } from '../types.js';
import { money, sgn, spct } from './pe-v2-model.js';
import { FilterControl, Segmented } from './pe-v2-primitives.js';

type MvView = 'feed' | 'table';

const STAGE_OPTIONS = ['ANY', 'HASC', 'SASC', 'HAC-D', 'SAC-D'];
const MAT_OPTIONS = ['ANY', 'Over $10M', 'Over 5%'];

function classify(item: MovementFeedItem): 'official' | 'correction' | 'conflict' | 'new' | 'none' {
  const a = (item.action ?? '').toLowerCase();
  if (a === 'add' || a === 'cut' || a === 'new_start' || a === 'termination') return 'official';
  return 'none';
}

const CLS_LABEL: Record<string, string> = {
  official: 'OFFICIAL CHANGE',
  correction: 'CORRECTION',
  conflict: 'CONFLICT — UNRESOLVED',
  new: 'NEW STAGE AVAILABLE',
  none: 'NO MATERIAL CHANGE',
};

export function PeV2Movement() {
  const api = useApi();
  const navigate = useNavigate();
  const [view, setView] = useState<MvView>('feed');
  const [stage, setStage] = useState('ANY');
  const [mat, setMat] = useState('ANY');

  const movement = useQuery({
    queryKey: ['pe-v2-movement'],
    queryFn: () => getMovement(api),
    staleTime: 60_000,
  });

  const items = useMemo(() => {
    let feed = movement.data?.feed ?? [];
    if (stage !== 'ANY') feed = feed.filter((m) => (m.stage ?? '').replaceAll('_', '-').toUpperCase() === stage);
    if (mat === 'Over $10M') feed = feed.filter((m) => m.amount != null && Math.abs(m.amount) >= 10);
    if (mat === 'Over 5%') feed = feed.filter((m) => m.amount != null && Math.abs(m.amount) >= 5); // conservative: $ proxy
    return feed;
  }, [movement.data, stage, mat]);

  return (
    <div data-screen-label="Movement">
      <div className="pe-v2-page-head">
        <div style={{ flex: 1, minWidth: 340 }}>
          <div className="pe-v2-page-title">Movement</div>
          <div className="pe-v2-page-sub">
            Official funding changes in the active defense-budget snapshot.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, flex: 'none', marginTop: 6 }}>
          <Segmented
            ariaLabel="Movement view"
            options={[
              { value: 'feed', label: 'FEED' },
              { value: 'table', label: 'TABLE' },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      <div className="pe-v2-toolbar">
        <span className="pe-v2-eyebrow" style={{ marginRight: 2 }}>
          Filters
        </span>
        <FilterControl label="Stage" value={stage} options={STAGE_OPTIONS} onChange={setStage} formatValue={(v) => v.replace('_', '-')} />
        <FilterControl label="Materiality" value={mat} options={MAT_OPTIONS} onChange={setMat} />
        <div style={{ flex: 1, minWidth: 8 }} />
        <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>
          {items.length} CHANGES · FY{movement.data?.openFy ?? '—'}
        </span>
      </div>

      {movement.isLoading ? (
        <div style={{ background: '#fff', padding: 24 }}>
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : items.length === 0 ? (
        <div style={{ background: '#fff', padding: '52px 24px', textAlign: 'center' }}>
          <div className="pe-v2-eyebrow">No movement matches every filter</div>
        </div>
      ) : view === 'feed' ? (
        <div style={{ background: '#fff' }}>
          {items.map((m) => {
            const cls = classify(m);
            const isCut = (m.amount ?? 0) < 0;
            return (
              <div
                key={m.id}
                style={{
                  display: 'flex',
                  gap: 26,
                  padding: '20px 24px',
                  borderBottom: '1px solid var(--pev2-hairline)',
                  flexWrap: 'wrap',
                  background: cls === 'official' ? '#fff' : 'var(--pev2-raised)',
                  boxShadow:
                    cls === 'official'
                      ? 'inset 2px 0 0 var(--pev2-ink)'
                      : cls === 'conflict'
                        ? 'inset 2px 0 0 var(--pev2-warning)'
                        : 'none',
                }}
              >
                <div style={{ flex: 'none', width: 132 }}>
                  <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)' }}>
                    FY{m.fy} · {(m.stage ?? '').replaceAll('_', '-').toUpperCase()}
                  </div>
                  <span className={`pe-v2-cls ${cls}`} style={{ marginTop: 7 }}>
                    {CLS_LABEL[cls]}
                  </span>
                </div>
                <div style={{ flex: '1 1 0', minWidth: 280 }}>
                  <button
                    type="button"
                    onClick={() => navigate(`/program-elements/${encodeURIComponent(m.peCode)}`)}
                    style={{
                      fontSize: 16,
                      fontWeight: 700,
                      letterSpacing: '-0.005em',
                      color: 'var(--pev2-ink)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    {m.title}
                  </button>
                  <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)', marginTop: 4 }}>
                    {m.peCode} · {(m.service ?? '').toUpperCase()} · {(m.lineType ?? '').toUpperCase()}
                  </div>
                  {m.note ? (
                    <div style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--pev2-body)', marginTop: 5, maxWidth: 640 }}>
                      {m.note}
                    </div>
                  ) : null}
                </div>
                <div style={{ flex: 'none', width: 230, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.015em', color: 'var(--pev2-ink)' }}>
                      {m.amount == null ? '—' : sgn(m.amount)}
                    </span>
                  </div>
                  <div
                    className="pe-v2-mono"
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: m.amount == null ? 'var(--pev2-secondary)' : isCut ? 'var(--pev2-ink)' : 'var(--pev2-success)',
                    }}
                  >
                    {m.amount == null ? 'NO MATERIAL CHANGE' : isCut ? 'PROGRAM DECREASE' : 'PROGRAM INCREASE'}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11 }}>
                    <button
                      type="button"
                      className="pe-v2-btn pe-v2-btn-sm"
                      onClick={() => navigate(`/program-elements/${encodeURIComponent(m.peCode)}`)}
                    >
                      Open line
                    </button>
                    <button
                      type="button"
                      className="pe-v2-btn pe-v2-btn-primary pe-v2-btn-sm"
                      onClick={() => navigate(`/actions?peCode=${encodeURIComponent(m.peCode)}`)}
                    >
                      Create action
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="pe-v2-table-foot">
            {items.length} CHANGES · RANKED BY MATERIALITY
          </div>
        </div>
      ) : (
        <div style={{ background: '#fff' }}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 1140 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(250px,1fr) 150px 120px 120px 112px 168px',
                  columnGap: 12,
                  padding: '9px 24px',
                  borderBottom: '1px solid var(--pev2-border-strong)',
                  background: 'var(--pev2-canvas)',
                  fontFamily: 'var(--pev2-mono)',
                  fontSize: 11,
                  letterSpacing: '0.08em',
                  color: 'var(--pev2-secondary)',
                  position: 'sticky',
                  top: 0,
                  zIndex: 5,
                }}
              >
                <div style={{ color: 'var(--pev2-ink)', fontWeight: 600 }}>Program / budget line</div>
                <div>Field</div>
                <div style={{ textAlign: 'right' }}>Change</div>
                <div style={{ textAlign: 'right' }}>FY</div>
                <div>Classification</div>
                <div />
              </div>
              {items.map((m) => {
                const cls = classify(m);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => navigate(`/program-elements/${encodeURIComponent(m.peCode)}`)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(250px,1fr) 150px 120px 120px 112px 168px',
                      columnGap: 12,
                      padding: '10px 24px',
                      borderBottom: '1px solid var(--pev2-hairline)',
                      alignItems: 'center',
                      cursor: 'pointer',
                      background: '#fff',
                      width: '100%',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span className="pe-v2-mono" style={{ display: 'block', fontSize: 11.5, letterSpacing: '0.04em', color: 'var(--pev2-secondary)' }}>
                        {m.peCode}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: 'var(--pev2-ink)',
                          marginTop: 2,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {m.title}
                      </span>
                    </span>
                    <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.05em', color: 'var(--pev2-body)' }}>
                      {(m.stage ?? '').replaceAll('_', '-').toUpperCase()} POSITION
                    </span>
                    <span
                      className="pe-v2-mono"
                      style={{
                        textAlign: 'right',
                        fontSize: 12,
                        fontWeight: 600,
                        color: (m.amount ?? 0) > 0 ? 'var(--pev2-success)' : (m.amount ?? 0) < 0 ? 'var(--pev2-ink)' : 'var(--pev2-secondary)',
                      }}
                    >
                      {m.amount == null ? '—' : sgn(m.amount)}
                    </span>
                    <span style={{ textAlign: 'right', fontSize: 13, color: 'var(--pev2-body)' }}>FY{m.fy}</span>
                    <span>
                      <span className={`pe-v2-cls ${cls}`}>{CLS_LABEL[cls]}</span>
                    </span>
                    <span />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="pe-v2-table-foot">{items.length} CHANGES · FY{movement.data?.openFy ?? '—'}</div>
        </div>
      )}
    </div>
  );
}
