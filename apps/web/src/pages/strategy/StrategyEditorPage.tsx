/*
 * Strategy editor shell — prototype sp-app StrategyView frame + the G3 editing
 * surface: node rail (select → edit fields / quick actions / delete), Add step,
 * drag-to-retime, version history + restore, applied-confirmation flashes. The
 * Meri "Ask Meri" CTA + rail assistant land in G5 (behind strategyPlannerMeri);
 * with it off the rail opens via an "Edit panel" ghost button (SHL-4).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';
import { App } from 'antd';
import { Icon, btnGhost, iconBtn } from './strategy-ui.js';
import { StrategyTimeline } from './StrategyTimeline.js';
import { EditorRail } from './NodeRail.js';
import { HistoryModal } from './HistoryModal.js';
import { FirmConfig } from './FirmConfig.js';
import { RefCalendarConfig } from './RefCalendarConfig.js';
import { useStrategy, useReferenceCalendars, useFirmPhases, useAddNode, useUpdateNode } from './api.js';
import { useClientsLite } from './clients-lite.js';
import { useTenantMembers } from './members.js';
import { useMe } from '../../lib/me.js';
import { STRATEGY_TYPE_LABEL } from './constants.js';
import { buildCalendar, formatDbDate } from './fiscal.js';

type LayerKey = 'ppbe' | 'congress';

export function StrategyEditorPage() {
  const { id = null } = useParams();
  const navigate = useNavigate();
  const { user } = useUser();
  const { message } = App.useApp();
  const strategy = useStrategy(id);
  const reference = useReferenceCalendars();
  const firmPhases = useFirmPhases();
  const clients = useClientsLite();
  const members = useTenantMembers();
  const me = useMe();

  const calendar = useMemo(() => buildCalendar(new Date()), []);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ ppbe: true, congress: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [firmOpen, setFirmOpen] = useState(false);
  const [refEdit, setRefEdit] = useState<'congress' | 'ppbe' | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [draftBannerClosed, setDraftBannerClosed] = useState(false);
  const flashTimer = useRef<number>();

  const addNode = useAddNode(id ?? '');
  const updateNode = useUpdateNode(id ?? '');

  const flash = (msg: string) => {
    setApplied(msg);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setApplied(null), 4000);
  };
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const meriEnabled = Boolean(me.data?.features?.strategyPlannerMeri);

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
  const sid = s.id;
  const clientName = clients.data?.find((c) => c.id === s.clientId)?.name ?? 'Client';
  const selectedNode = s.nodes.find((n) => n.id === selectedId) ?? null;

  // SHL-5: one-time banner after a Meri draft. Keyed off draftedByMeri (set only
  // by the draft path) — NOT meriSummary, which a rail assist also writes and
  // would falsely flag a manual plan. Dismissal is per-strategy, per-browser
  // (localStorage), and also held in state so the banner disappears immediately
  // on click without a re-read.
  const draftKey = `sp-draft-banner-${sid}`;
  const draftDismissedStored = (() => {
    try {
      return localStorage.getItem(draftKey) === '1';
    } catch {
      return false;
    }
  })();
  const showDraftBanner = s.draftedByMeri && !draftBannerClosed && !draftDismissedStored;
  const dismissDraftBanner = () => {
    try {
      localStorage.setItem(draftKey, '1');
    } catch {
      /* localStorage unavailable — state still hides it this session */
    }
    setDraftBannerClosed(true);
  };

  const layerDefs: Array<[LayerKey, string, string]> = [
    ['ppbe', 'PPBE', 'var(--info)'],
    ['congress', 'Congress', 'var(--accent)'],
  ];

  const selectNode = (nid: string) => {
    setSelectedId(nid);
    setRailOpen(true);
  };

  const onAddStep = () => {
    const existing = new Set(s.nodes.map((n) => n.id));
    const startsOn = formatDbDate(new Date(Date.now() + 30 * 86_400_000));
    addNode.mutate(
      { kind: 'action', subject: 'deliverable', title: 'New step', status: 'draft', startsOn },
      {
        onSuccess: (detail) => {
          const created = detail.nodes.find((n) => !existing.has(n.id));
          if (created) selectNode(created.id);
          flash('Step added.');
        },
        onError: () => message.error('Could not add a step.'),
      },
    );
  };

  const onRetime = (nodeId: string, startsOn: string, endsOn: string | null, title: string) => {
    updateNode.mutate(
      { nodeId, input: { startsOn, endsOn, changeNote: `Re-timed ${title}` } },
      { onSuccess: () => flash(`Re-timed ${title}`), onError: () => message.error('Could not re-time the step.') },
    );
  };

  return (
    <div
      style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%' }}
    >
      <div
        style={{
          padding: '14px 26px 24px',
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
                fontSize: 'var(--text-xs)',
                color: 'var(--ink-3)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
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
                <span style={{ width: 8, height: 8, borderRadius: 2, background: on ? c : 'var(--ink-4)' }} />
                {label}
              </button>
            );
          })}
          <span style={{ flex: 1 }} />

          <button
            onClick={onAddStep}
            disabled={addNode.isPending}
            style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)' }}
          >
            <Icon name="plus" size={14} color="var(--ink-2)" /> Add step
          </button>
          <button
            onClick={() => setHistoryOpen(true)}
            style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)' }}
          >
            <Icon name="clock" size={14} color="var(--ink-2)" /> History
          </button>
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
          {!railOpen &&
            (meriEnabled ? (
              // AI on (G5): accent "Ask Meri" CTA.
              <button
                onClick={() => setRailOpen(true)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  whiteSpace: 'nowrap',
                  padding: '8px 16px',
                  borderRadius: 9,
                  border: 'none',
                  background: 'var(--accent)',
                  color: '#fff',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 700,
                  fontFamily: 'var(--font-sans)',
                  cursor: 'pointer',
                }}
              >
                <Icon name="spark" size={14} color="#fff" /> Ask Meri
              </button>
            ) : (
              // AI off (SHL-4): ghost "Edit panel" button opens the manual rail.
              <button
                onClick={() => setRailOpen(true)}
                style={{ ...btnGhost, padding: '8px 12px', fontSize: 'var(--text-sm)' }}
              >
                <Icon name="panel" size={14} color="var(--ink-2)" /> Edit panel
              </button>
            ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
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
          {showDraftBanner && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                background: 'var(--accent-soft)',
                border: '1px solid #C6D4F4',
                borderRadius: 10,
                padding: '11px 14px',
                marginBottom: 14,
              }}
            >
              <div style={{ marginTop: 1 }}>
                <Icon name="spark" size={15} color="var(--accent-ink)" />
              </div>
              <div style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--ink-2)', lineHeight: 1.5 }}>
                <b style={{ color: 'var(--accent-ink)' }}>Meri drafted this plan from your goal.</b> Every step is
                editable — drag to re-time, click to open, or ask Meri to change anything from the rail.
              </div>
              <button
                onClick={dismissDraftBanner}
                title="Dismiss"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'grid' }}
              >
                <Icon name="x" size={13} color="var(--ink-4)" />
              </button>
            </div>
          )}
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
              onSelectNode={selectNode}
              onRetime={onRetime}
              onEditCongress={() => setRefEdit('congress')}
              onEditPpbe={() => setRefEdit('ppbe')}
              onConfigureFirm={() => setFirmOpen(true)}
            />
          </div>
        </div>

        {railOpen && (
          <EditorRail
            strategyId={sid}
            node={selectedNode}
            calendar={calendar}
            members={members.data ?? []}
            meriEnabled={meriEnabled}
            meriSummary={s.meriSummary}
            currentUserId={user?.id}
            applied={applied}
            onFlash={flash}
            onClose={() => {
              setRailOpen(false);
              setSelectedId(null);
            }}
            onDeselect={() => setSelectedId(null)}
          />
        )}
      </div>

      {historyOpen && (
        <HistoryModal
          strategyId={sid}
          members={members.data ?? []}
          onClose={() => setHistoryOpen(false)}
          onRestored={(m) => flash(m)}
        />
      )}

      {firmOpen && (
        <FirmConfig
          firstRun={firmPhases.isSuccess && (firmPhases.data?.length ?? 0) === 0}
          phases={firmPhases.data ?? []}
          calendar={calendar}
          onClose={() => setFirmOpen(false)}
          onSaved={(m) => flash(m)}
        />
      )}

      {refEdit && reference.data && (
        <RefCalendarConfig
          kind={refEdit}
          calendars={reference.data}
          calendar={calendar}
          meriEnabled={meriEnabled}
          onClose={() => setRefEdit(null)}
          onSaved={(m) => flash(m)}
        />
      )}
    </div>
  );
}
