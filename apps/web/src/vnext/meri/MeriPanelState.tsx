import type { ReactNode } from 'react';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

/**
 * MeriPanelState — the v4 loading/error/empty treatment for a rail section,
 * replacing bare `.vnext-meri__ctx-empty` text with an icon and a tone-coded
 * box. Every call site already had real loading/error/empty booleans; this
 * only changes how they're presented, not when they fire.
 */

interface MeriPanelStateProps {
  tone: 'loading' | 'error' | 'empty';
  children: ReactNode;
}

const TONE: Record<MeriPanelStateProps['tone'], { icon: MeriIconName; bg: string; ring: string; fg: string; spin?: boolean }> = {
  loading: { icon: 'Loading01', bg: '#FAF9F6', ring: '#E8E5DF', fg: '#667085', spin: true },
  error: { icon: 'AlertCircle', bg: '#FEF3F2', ring: '#FECDCA', fg: '#B42318' },
  empty: { icon: 'InfoCircle', bg: '#FAF9F6', ring: '#E8E5DF', fg: '#667085' },
};

export function MeriPanelState({ tone, children }: MeriPanelStateProps) {
  const spec = TONE[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 9,
        padding: '12px 13px',
        borderRadius: 9,
        background: spec.bg,
        border: `1px solid ${spec.ring}`,
      }}
    >
      <span
        className={spec.spin ? 'vnext-meri__panel-state-icon is-spinning' : undefined}
        style={{ flex: '0 0 auto', marginTop: 1 }}
      >
        <MeriIcon name={spec.icon} size={14} color={spec.fg} />
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: '18px', color: '#475467' }}>
        {children}
      </span>
    </div>
  );
}
