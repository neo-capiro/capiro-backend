/*
 * Strategies landing + library (LIB-1..8) — ported from the prototype
 * sp-landing.jsx `Landing`, wired to real data (useStrategies / useFirmPhases /
 * useClientsLite). Manual create via GoalModal (CRT). Inline styles + tokens
 * reproduce the prototype pixel-for-pixel.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, Ava, Chip, btnPrimary } from './strategy-ui.js';
import { useStrategies, useFirmPhases } from './api.js';
import { useClientsLite, clientColor } from './clients-lite.js';
import { useTenantMembers, memberName, initialsOf } from './members.js';
import { STRATEGY_TYPE_LABEL, relativeTime } from './constants.js';
import { GoalModal } from './GoalModal.js';
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
  const strategies = useStrategies();
  const firmPhases = useFirmPhases();
  const clients = useClientsLite();
  const members = useTenantMembers();

  const [goalOpen, setGoalOpen] = useState(false);
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
          <button onClick={() => setGoalOpen(true)} style={btnPrimary}>
            <Icon name="plus" size={15} color="#fff" /> New strategy
          </button>
        </div>

        {!firmConfigured ? (
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
                Firm phases
              </span>
              <div
                style={{
                  fontSize: 'var(--text-md)',
                  fontWeight: 700,
                  color: 'var(--ink-1)',
                  marginTop: 3,
                }}
              >
                Firm phases aren't set yet
              </div>
              <div
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--ink-2)',
                  marginTop: 3,
                  lineHeight: 1.5,
                  maxWidth: 620,
                }}
              >
                Your firm's annual operating rhythm anchors every strategy timeline. You can build
                strategies now — phase setup arrives in a later release and will fill in the Firm
                phase band on every timeline.
              </div>
            </div>
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
          onClose={() => setGoalOpen(false)}
          onCreated={(id) => {
            setGoalOpen(false);
            navigate(`/strategies/${id}`);
          }}
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
