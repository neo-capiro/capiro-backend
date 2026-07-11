import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { formatTime } from './meetings-format.js';
import {
  JoinLink,
  MaterialBadges,
  ProviderTag,
  SendMeriButton,
  showSendMeri,
} from './meetings-ui.js';
import type { Meeting } from './meetings-types.js';

/** A single meeting row (Day + List views) — a direct port of the prototype
 *  MeetingRow: time · identity + Meri/Join action on the left, uniform P/N/D
 *  status + chevron on the right. */
export function MeetingRow({
  meeting: m,
  selected,
  onSelect,
  onSendMeri,
}: {
  meeting: Meeting;
  selected: boolean;
  onSelect: (m: Meeting) => void;
  onSendMeri: (m: Meeting) => void;
}) {
  const [hover, setHover] = useState(false);
  const bg = selected ? 'var(--accent-soft)' : hover ? 'var(--bg-surface-2)' : 'var(--bg-surface)';
  const showJoin = m.isVirtual && Boolean(m.joinLink);
  const showMeri = showSendMeri(m);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(m)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(m);
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        cursor: 'pointer',
        minHeight: 76,
        borderBottom: '1px solid var(--border-1)',
        background: bg,
        borderLeft: `3px solid ${selected ? 'var(--accent)' : 'transparent'}`,
        padding: '14px 22px 14px 19px',
      }}
    >
      {/* Time */}
      <div
        style={{
          width: 82,
          flexShrink: 0,
          textAlign: 'right',
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--ink-2)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatTime(m.startsAt)}
      </div>
      {/* Identity + Meri / Join action */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--ink-1)',
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {m.subject}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 3,
            fontSize: 12.5,
            color: 'var(--ink-3)',
          }}
        >
          {m.client && (
            <>
              <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{m.client.name}</span>
              <span
                style={{
                  width: 3,
                  height: 3,
                  borderRadius: '50%',
                  background: 'var(--border-strong)',
                }}
              />
            </>
          )}
          <ProviderTag m={m} />
        </div>
        {(showMeri || showJoin) && (
          <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 14 }}>
            {showMeri && <SendMeriButton m={m} onClick={onSendMeri} size="sm" />}
            {showJoin && <JoinLink m={m} size={13} />}
          </div>
        )}
      </div>
      {/* Uniform status */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <MaterialBadges m={m} />
      </div>
      <ChevronRight size={16} style={{ color: 'var(--ink-4)', flexShrink: 0 }} />
    </div>
  );
}
