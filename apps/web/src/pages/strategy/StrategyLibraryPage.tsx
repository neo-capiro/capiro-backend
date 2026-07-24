/*
 * Strategies landing + library (LIB-1..8) — ported from the prototype
 * sp-landing.jsx `Landing`, wired to real data (useStrategies / useFirmPhases /
 * useClientsLite). Manual create via GoalModal (CRT). Inline styles + tokens
 * reproduce the prototype pixel-for-pixel.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App } from 'antd';
import { Icon, Ava, Chip, btnPrimary, btnGhost } from './strategy-ui.js';
import { useStrategies, useFirmPhases, useChangeSets, useExecutionRuns } from './api.js';
import { useMe } from '../../lib/me.js';
import { useClientsLite, clientColor } from './clients-lite.js';
import { useTenantMembers, memberName, initialsOf } from './members.js';
import { STRATEGY_TYPE_LABEL, relativeTime, FIRM_PHASES_DEFAULT } from './constants.js';
import { buildCalendar } from './fiscal.js';
import { GoalModal } from './GoalModal.js';
import { FirmConfig } from './FirmConfig.js';
import type { StrategyListItem } from './types.js';

const selS: React.CSSProperties = {
  border: '1px solid var(--border-2)',
  borderRadius: 8,
  padding: '7px 11px',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-sans)',
  color: 'var(--ink-1)',
  background: 'var(--bg-surface)',
  cursor: 'pointer',
};

export function StrategyLibraryPage() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const strategies = useStrategies();
  const firmPhases = useFirmPhases();
  const clients = useClientsLite();
  const members = useTenantMembers();
  const me = useMe();
  const meriEnabled = Boolean(me.data?.features?.strategyPlannerMeri);
  // Stage D: the context-document library rides the agentic flag — the link is
  // hidden entirely (not disabled) when the tenant isn't canaried in.
  const agenticEnabled = Boolean(me.data?.features?.agenticMeri);
  // Stage F: proposed-change-set count for the review-queue nav badge (the
  // query only fires for agentic tenants — the server 403s everyone else).
  const proposedCs = useChangeSets({ status: 'proposed' }, agenticEnabled);
  const proposedCount = proposedCs.data?.length ?? 0;
  // Stage G: badge the Execution nav with runs that need a human (ready_for_review
  // / waiting_for_input). Gated on agentic (the server 403s everyone else).
  const executionRuns = useExecutionRuns(null, agenticEnabled);
  const executionCount =
    executionRuns.data?.filter(
      (r) => r.state === 'ready_for_review' || r.state === 'waiting_for_input',
    ).length ?? 0;
  const calendar = useMemo(() => buildCalendar(new Date()), []);

  const [goalOpen, setGoalOpen] = useState(false);
  const [firmOpen, setFirmOpen] = useState(false);
  const [fc, setFc] = useState('all'); // client filter
  const [fo, setFo] = useState('all'); // owner filter

  const clientName = (id: string) => clients.data?.find((c) => c.id === id)?.name ?? 'Client';
  const ownerLabel = (ownerUserId: string) => memberName(members.data, ownerUserId);
  const ownerInitials = (ownerUserId: string) => initialsOf(memberName(members.data, ownerUserId));

  const list = useMemo(() => {
    const rows = strategies.data ?? [];
    return rows.filter(
      (s) => (fc === 'all' || s.clientId === fc) && (fo === 'all' || s.ownerUserId === fo),
    );
  }, [strategies.data, fc, fo]);

  const clientFilterOptions = useMemo(
    () => [...new Set((strategies.data ?? []).map((s) => s.clientId))],
    [strategies.data],
  );
  const ownerFilterOptions = useMemo(
    () => [...new Set((strategies.data ?? []).map((s) => s.ownerUserId))],
    [strategies.data],
  );

  // Only trust the configured/first-run decision once the query resolves — a
  // pending load must not read as "unconfigured" (which would seed the default
  // template and risk overwriting real phases on save).
  const firmLoaded = firmPhases.isSuccess;
  const firmConfigured = (firmPhases.data?.length ?? 0) > 0;
  const phaseCount = firmPhases.data?.length ?? 0;

  return (
    <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-canvas)', height: '100%' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 40px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <h1
              style={{
                fontSize: 'var(--text-xl)',
                fontWeight: 700,
                color: 'var(--ink-1)',
                letterSpacing: '-0.02em',
                margin: 0,
              }}
            >
              Strategies
            </h1>
            <p
              style={{
                fontSize: 'var(--text-md)',
                color: 'var(--ink-2)',
                marginTop: 4,
                maxWidth: 640,
              }}
            >
              A strategy turns a goal into an actionable timeline against budget and legislative
              calendars. Create and edit strategies with Meri.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {agenticEnabled && (
              <button onClick={() => navigate('/strategies/agents/review')} style={btnGhost}>
                <Icon name="radar" size={14} color="var(--ink-2)" /> Review
                {proposedCount > 0 && (
                  <span
                    style={{
                      minWidth: 18,
                      height: 18,
                      borderRadius: 9,
                      background: 'var(--accent)',
                      color: '#fff',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 'var(--text-2xs)',
                      fontWeight: 700,
                      padding: '0 5px',
                    }}
                  >
                    {proposedCount}
                  </span>
                )}
              </button>
            )}
            {agenticEnabled && (
              <button onClick={() => navigate('/strategies/agents/execution')} style={btnGhost}>
                <Icon name="play" size={14} color="var(--ink-2)" /> Execution
                {executionCount > 0 && (
                  <span
                    style={{
                      minWidth: 18,
                      height: 18,
                      borderRadius: 9,
                      background: 'var(--notable)',
                      color: '#fff',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 'var(--text-2xs)',
                      fontWeight: 700,
                      padding: '0 5px',
                    }}
                  >
                    {executionCount}
                  </span>
                )}
              </button>
            )}
            {agenticEnabled && (
              <button onClick={() => navigate('/strategies/context')} style={btnGhost}>
                <Icon name="book" size={14} color="var(--ink-2)" /> Context
              </button>
            )}
            <button onClick={() => setGoalOpen(true)} style={btnPrimary}>
              <Icon name="plus" size={15} color="#fff" /> New strategy
            </button>
          </div>
        </div>

        {!firmLoaded ? null : !firmConfigured ? (
          <div
            style={{
              marginTop: 18,
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              background: 'var(--bg-surface)',
              border: '1.5px solid var(--accent)',
              borderRadius: 12,
              padding: '16px 18px',
              boxShadow: '0 4px 16px var(--accent-glow)',
            }}
          >
            <span
              style={{
                width: 42,
                height: 42,
                borderRadius: 11,
                background: 'var(--accent-soft)',
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="calendar" size={21} color="var(--accent-ink)" />
            </span>
            <div style={{ flex: 1 }}>
              <span
                style={{
                  fontSize: 'var(--text-2xs)',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 700,
                  color: 'var(--accent)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                First-time setup
              </span>
              <div
                style={{
                  fontSize: 'var(--text-md)',
                  fontWeight: 700,
                  color: 'var(--ink-1)',
                  marginTop: 3,
                }}
              >
                Set your firm's phases before you build a strategy
              </div>
              <div
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--ink-2)',
                  marginTop: 3,
                  lineHeight: 1.5,
                  maxWidth: 560,
                }}
              >
                Your firm's annual operating rhythm anchors every strategy timeline. Start from a
                standard {FIRM_PHASES_DEFAULT.length}-phase template, then adjust — it applies
                firm-wide and is editable anytime.
              </div>
            </div>
            <button onClick={() => setFirmOpen(true)} style={{ ...btnPrimary, flexShrink: 0 }}>
              <Icon name="calendar" size={14} color="#fff" /> Set firm phases
            </button>
          </div>
        ) : (
          <div
            style={{
              marginTop: 18,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'var(--success-soft)',
              border: '1px solid var(--success)',
              borderRadius: 10,
              padding: '10px 15px',
            }}
          >
            <Icon name="check" size={15} color="var(--success)" />
            <span
              style={{
                flex: 1,
                fontSize: 'var(--text-sm)',
                color: 'var(--success)',
                fontWeight: 600,
              }}
            >
              Firm phases are set ({phaseCount} phases). Every strategy aligns to them.
            </span>
            <button
              onClick={() => setFirmOpen(true)}
              style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--text-sm)' }}
            >
              <Icon name="edit" size={13} color="var(--ink-2)" /> Edit
            </button>
          </div>
        )}

        <div
          style={{
            marginTop: 28,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 700,
              color: 'var(--ink-1)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Your strategies
          </span>
          <span
            style={{
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-mono)',
              color: 'var(--ink-4)',
            }}
          >
            {list.length}
          </span>
          <span style={{ flex: 1 }} />
          <select value={fc} onChange={(e) => setFc(e.target.value)} style={selS}>
            <option value="all">All clients</option>
            {clientFilterOptions.map((c) => (
              <option key={c} value={c}>
                {clientName(c)}
              </option>
            ))}
          </select>
          <select value={fo} onChange={(e) => setFo(e.target.value)} style={selS}>
            <option value="all">All owners</option>
            {ownerFilterOptions.map((o) => (
              <option key={o} value={o}>
                {ownerLabel(o)}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {strategies.isLoading && (
            <div
              style={{
                padding: 28,
                textAlign: 'center',
                fontSize: 'var(--text-sm)',
                color: 'var(--ink-3)',
                border: '1px dashed var(--border-2)',
                borderRadius: 12,
              }}
            >
              Loading strategies…
            </div>
          )}
          {!strategies.isLoading &&
            list.map((s) => (
              <StrategyRow
                key={s.id}
                s={s}
                clientName={clientName}
                ownerLabel={ownerLabel}
                ownerInitials={ownerInitials}
                onOpen={() => navigate(`/strategies/${s.id}`)}
              />
            ))}
          {!strategies.isLoading && list.length === 0 && (
            <div
              style={{
                padding: 28,
                textAlign: 'center',
                fontSize: 'var(--text-sm)',
                color: 'var(--ink-3)',
                border: '1px dashed var(--border-2)',
                borderRadius: 12,
              }}
            >
              {strategies.data && strategies.data.length > 0
                ? 'No strategies match these filters.'
                : 'No strategies yet — create your first with “New strategy”.'}
            </div>
          )}
        </div>
      </div>

      {goalOpen && (
        <GoalModal
          clients={clients.data ?? []}
          meriEnabled={meriEnabled}
          firmConfigured={!firmLoaded || firmConfigured}
          onConfigureFirm={() => {
            setGoalOpen(false);
            setFirmOpen(true);
          }}
          onClose={() => setGoalOpen(false)}
          onCreated={(id) => {
            setGoalOpen(false);
            navigate(`/strategies/${id}`);
          }}
        />
      )}

      {firmOpen && (
        <FirmConfig
          firstRun={firmLoaded && !firmConfigured}
          phases={firmPhases.data ?? []}
          calendar={calendar}
          onClose={() => setFirmOpen(false)}
          onSaved={(m) => message.success(m)}
        />
      )}
    </div>
  );
}

function StrategyRow({
  s,
  clientName,
  ownerLabel,
  ownerInitials,
  onOpen,
}: {
  s: StrategyListItem;
  clientName: (id: string) => string;
  ownerLabel: (id: string) => string;
  ownerInitials: (id: string) => string;
  onOpen: () => void;
}) {
  const cc = clientColor(s.clientId);
  return (
    <div
      onClick={onOpen}
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        cursor: 'pointer',
      }}
    >
      <div style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: cc }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: cc }} />
          <span
            style={{
              fontSize: 'var(--text-2xs)',
              color: 'var(--ink-2)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {clientName(s.clientId)}
          </span>
        </div>
        <div
          style={{
            fontSize: 'var(--text-md)',
            fontWeight: 700,
            color: 'var(--ink-1)',
            letterSpacing: '-0.01em',
          }}
        >
          {s.title}
        </div>
        <div
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--ink-3)',
            marginTop: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <Chip tone="ink">{STRATEGY_TYPE_LABEL[s.type]}</Chip>
          <span>{s.nodeCount} nodes</span>
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span>
            Edited by {ownerLabel(s.lastEditedByUserId ?? s.ownerUserId)} ·{' '}
            {relativeTime(s.lastEditedAt ?? s.createdAt)}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <span
          style={{
            fontSize: 'var(--text-2xs)',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--ink-4)',
          }}
        >
          Owner
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Ava id={ownerInitials(s.ownerUserId)} size={20} />
          <span
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              color: 'var(--ink-1)',
              whiteSpace: 'nowrap',
            }}
          >
            {ownerLabel(s.ownerUserId)}
          </span>
        </div>
      </div>
      <Icon name="chevron" size={15} color="var(--ink-4)" />
    </div>
  );
}
