/*
 * Strategy editor shell (SHL read paths) — ported from the prototype
 * sp-app.jsx `StrategyView` frame: back button, {CLIENT}·{type} eyebrow +
 * title, Layers chips (PPBE + Congress; Meetings deferred per plan D18),
 * Export + History affordances (present; Export ships in G6, History in G3),
 * and the read-only timeline. The Meri rail, "Add step", drag-retime, and node
 * editing arrive in G3/G5.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon, btnGhost, iconBtn } from './strategy-ui.js';
import { StrategyTimeline } from './StrategyTimeline.js';
import { useStrategy, useReferenceCalendars, useFirmPhases } from './api.js';
import { useClientsLite, clientColor } from './clients-lite.js';
import { STRATEGY_TYPE_LABEL } from './constants.js';
import { buildCalendar } from './fiscal.js';

type LayerKey = 'ppbe' | 'congress';

export function StrategyEditorPage() {
  const { id = null } = useParams();
  const navigate = useNavigate();
  const strategy = useStrategy(id);
  const reference = useReferenceCalendars();
  const firmPhases = useFirmPhases();
  const clients = useClientsLite();

  const calendar = useMemo(() => buildCalendar(new Date()), []);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ ppbe: true, congress: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (strategy.isLoading) {
    return <div style={{ padding: 40, color: 'var(--ink-3)' }}>Loading strategy…</div>;
  }
  if (strategy.isError || !strategy.data) {
    return (
      <div style={{ padding: 40 }}>
        <button onClick={() => navigate('/strategies')} style={{ ...btnGhost, marginBottom: 16 }}>
          <Icon name="chevleft" size={14} color="var(--ink-2)" /> Back to strategies
        </button>
        <div style={{ color: 'var(--ink-3)' }}>This strategy could not be loaded.</div>
      </div>
    );
  }

  const s = strategy.data;
  const clientName = clients.data?.find((c) => c.id === s.clientId)?.name ?? 'Client';
  const cc = clientColor(s.clientId);

  const layerDefs: Array<[LayerKey, string, string]> = [
    ['ppbe', 'PPBE', 'var(--info)'],
    ['congress', 'Congress', 'var(--accent)'],
  ];

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: '100%',
      }}
    >
      <div
        style={{
          padding: '14px 26px 20px',
          borderBottom: '1px solid var(--border-1)',
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/strategies')}
            style={{ ...iconBtn, border: '1px solid var(--border-2)', width: 30, height: 30 }}
          >
            <Icon name="chevleft" size={16} color="var(--ink-2)" />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 'var(--text-xs)',
                color: 'var(--ink-3)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 2, background: cc }} />
              {clientName} · {STRATEGY_TYPE_LABEL[s.type]}
            </div>
            <div
              style={{
                fontSize: 25,
                fontWeight: 700,
                color: 'var(--ink-1)',
                letterSpacing: '-0.02em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                marginTop: 1,
              }}
            >
              {s.title}
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            rowGap: 10,
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-2xs)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--ink-4)',
              marginRight: 2,
            }}
          >
            Layers
          </span>
          {layerDefs.map(([k, label, c]) => {
            const on = layers[k];
            return (
              <button
                key={k}
                onClick={() => setLayers((st) => ({ ...st, [k]: !st[k] }))}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 11px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  border: on ? `1px solid ${c}` : '1px solid var(--border-2)',
                  background: on ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
                  color: on ? 'var(--ink-1)' : 'var(--ink-3)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: on ? c : 'var(--ink-4)',
                  }}
                />
                {label}
              </button>
            );
          })}
          <span style={{ flex: 1 }} />
          <button
            style={{
              ...btnGhost,
              padding: '8px 12px',
              fontSize: 'var(--text-sm)',
              opacity: 0.5,
              cursor: 'not-allowed',
            }}
            title="Export ships in a later phase"
            disabled
          >
            <Icon name="upload" size={14} color="var(--ink-2)" /> Export
          </button>
          <button
            style={{
              ...btnGhost,
              padding: '8px 12px',
              fontSize: 'var(--text-sm)',
              opacity: 0.5,
              cursor: 'not-allowed',
            }}
            title="Version history ships in a later phase"
            disabled
          >
            <Icon name="clock" size={14} color="var(--ink-2)" /> History
          </button>
        </div>
      </div>

      <div
        data-sp-scroll="true"
        onClick={() => setSelectedId(null)}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '16px 26px 24px',
          background: 'var(--bg-canvas)',
        }}
      >
        <div style={{ zoom: 0.82 as unknown as number }}>
          <StrategyTimeline
            calendar={calendar}
            nodes={s.nodes}
            congress={reference.data?.congress ?? []}
            ppbeLanes={reference.data?.ppbeLanes ?? []}
            ppbeCurrentPhases={reference.data?.ppbeCurrentPhases ?? []}
            firmPhases={firmPhases.data ?? []}
            layers={layers}
            selectedId={selectedId}
            onSelectNode={(nid) => setSelectedId(nid)}
          />
        </div>
      </div>
    </div>
  );
}
