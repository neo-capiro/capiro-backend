/*
 * Strategy Planner shared UI primitives — ported VERBATIM from the locked
 * prototype (sp-shell.jsx / sp-landing.jsx / sp-app.jsx). These reproduce the
 * prototype look pixel-for-pixel via inline styles + the `.sp-root` tokens; we
 * deliberately do NOT use Ant Design here (the app's navy/Public-Sans AntD
 * theme does not match this warm/Hanken redesign). Mirrors the established
 * convention in pages/workspace/kit.tsx and pages/engagement/meetings.
 */
import React from 'react';

// ---- minimal stroke icons (verbatim from sp-shell.jsx) ----
type IconName =
  | 'grid'
  | 'radar'
  | 'users'
  | 'folder'
  | 'star'
  | 'calendar'
  | 'network'
  | 'briefcase'
  | 'book'
  | 'userplus'
  | 'bell'
  | 'search'
  | 'plus'
  | 'target'
  | 'map'
  | 'play'
  | 'gear'
  | 'arrow'
  | 'check'
  | 'x'
  | 'spark'
  | 'layers'
  | 'grip'
  | 'edit'
  | 'trash'
  | 'chevron'
  | 'chevleft'
  | 'up'
  | 'info'
  | 'lock'
  | 'panel'
  | 'clock'
  | 'link'
  | 'upload'
  | 'paperclip'
  | 'video'
  | 'pin'
  | 'circle'
  | 'download'
  | 'refresh'
  | 'mic'
  | 'pencil'
  | 'alert'
  | 'external'
  | 'chevdown'
  | 'doc'
  | 'note'
  | 'linkoff';

export function Icon({
  name,
  size = 17,
  color = 'currentColor',
  sw = 1.6,
}: {
  name: IconName | string;
  size?: number;
  color?: string;
  sw?: number;
}) {
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: sw,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
      </>
    ),
    radar: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4" />
        <path d="M12 12l6-4" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20c0-3 3-5 6-5s6 2 6 5" />
        <path d="M16 6a3 3 0 010 6" />
      </>
    ),
    folder: (
      <>
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      </>
    ),
    star: (
      <>
        <path d="M12 3l2.6 6.3 6.4.5-4.9 4.2 1.5 6.3L12 17.2 6.9 20.6l1.5-6.3L3.5 9.8l6.4-.5z" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M3 9h18M8 2v4M16 2v4" />
      </>
    ),
    network: (
      <>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="M7.5 8l3 8M16.5 8l-3 8M8 6h8" />
      </>
    ),
    briefcase: (
      <>
        <rect x="3" y="8" width="18" height="12" rx="2" />
        <path d="M9 8V6a2 2 0 012-2h2a2 2 0 012 2v2" />
      </>
    ),
    book: (
      <>
        <path d="M5 4h11a2 2 0 012 2v14H7a2 2 0 01-2-2z" />
        <path d="M5 18a2 2 0 012-2h11" />
      </>
    ),
    userplus: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20c0-3 3-5 6-5s5 1.5 5.5 3" />
        <path d="M18 8v6M15 11h6" />
      </>
    ),
    bell: (
      <>
        <path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z" />
        <path d="M10 20a2 2 0 004 0" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14M5 12h14" />
      </>
    ),
    target: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" />
      </>
    ),
    map: (
      <>
        <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" />
        <path d="M9 4v14M15 6v14" />
      </>
    ),
    play: (
      <>
        <path d="M8 5l11 7-11 7z" />
      </>
    ),
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14M13 6l6 6-6 6" />
      </>
    ),
    check: (
      <>
        <path d="M20 6L9 17l-5-5" />
      </>
    ),
    x: (
      <>
        <path d="M6 6l12 12M18 6L6 18" />
      </>
    ),
    spark: (
      <>
        <path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z" />
      </>
    ),
    layers: (
      <>
        <path d="M12 3l9 5-9 5-9-5z" />
        <path d="M3 13l9 5 9-5" />
      </>
    ),
    grip: (
      <>
        <circle cx="9" cy="6" r="1" />
        <circle cx="15" cy="6" r="1" />
        <circle cx="9" cy="12" r="1" />
        <circle cx="15" cy="12" r="1" />
        <circle cx="9" cy="18" r="1" />
        <circle cx="15" cy="18" r="1" />
      </>
    ),
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2 2 0 013 3L7 19l-4 1 1-4z" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13h10l1-13" />
      </>
    ),
    chevron: (
      <>
        <path d="M9 6l6 6-6 6" />
      </>
    ),
    chevleft: (
      <>
        <path d="M15 6l-6 6 6 6" />
      </>
    ),
    up: (
      <>
        <path d="M12 19V5M6 11l6-6 6 6" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 018 0v3" />
      </>
    ),
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    link: (
      <>
        <path d="M9 15l6-6" />
        <path d="M11 6l1-1a4 4 0 015 5l-1 1" />
        <path d="M13 18l-1 1a4 4 0 01-5-5l1-1" />
      </>
    ),
    upload: (
      <>
        <path d="M12 15V4M8 8l4-4 4 4" />
        <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
      </>
    ),
    paperclip: (
      <>
        <path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 6" />
      </>
    ),
    video: (
      <>
        <rect x="2" y="6" width="14" height="12" rx="2" />
        <path d="M16 10l6-3v10l-6-3z" />
      </>
    ),
    pin: (
      <>
        <path d="M12 21s-7-6.4-7-11a7 7 0 1114 0c0 4.6-7 11-7 11z" />
        <circle cx="12" cy="10" r="2.5" />
      </>
    ),
    circle: (
      <>
        <circle cx="12" cy="12" r="7" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12M7 11l5 5 5-5" />
        <path d="M4 19h16" />
      </>
    ),
    refresh: (
      <>
        <path d="M3 12a9 9 0 019-9 9 9 0 018 5" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 01-9 9 9 9 0 01-8-5" />
        <path d="M3 21v-5h5" />
      </>
    ),
    mic: (
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M6 11a6 6 0 0012 0M12 17v4" />
      </>
    ),
    pencil: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2 2 0 013 3L7 19l-4 1 1-4z" />
      </>
    ),
    alert: (
      <>
        <path d="M12 3l9 16H3z" />
        <path d="M12 9v5M12 17h.01" />
      </>
    ),
    external: (
      <>
        <path d="M14 5h5v5" />
        <path d="M19 5l-9 9" />
        <path d="M19 13v6H5V5h6" />
      </>
    ),
    chevdown: (
      <>
        <path d="M6 9l6 6 6-6" />
      </>
    ),
    doc: (
      <>
        <path d="M6 2h8l4 4v16H6z" />
        <path d="M14 2v4h4M9 13h6M9 17h6" />
      </>
    ),
    note: (
      <>
        <path d="M4 4h16v10l-6 6H4z" />
        <path d="M20 14h-6v6" />
      </>
    ),
    linkoff: (
      <>
        <path d="M9 15l-2 2a4 4 0 01-5-5l2-2" />
        <path d="M15 9l2-2a4 4 0 015 5l-2 2" />
        <path d="M3 3l18 18" />
      </>
    ),
  };
  return <svg {...p}>{paths[name] ?? null}</svg>;
}

// ---- Chip (verbatim from sp-landing.jsx) ----
export function Chip({
  children,
  tone = 'ink',
}: {
  children: React.ReactNode;
  tone?: 'accent' | 'notable' | 'info' | 'success' | 'critical' | 'ink';
}) {
  const map: Record<string, [string, string]> = {
    accent: ['var(--accent-soft)', 'var(--accent-ink)'],
    notable: ['var(--notable-soft)', 'var(--notable)'],
    info: ['var(--info-soft)', 'var(--info)'],
    success: ['var(--success-soft)', 'var(--success)'],
    critical: ['var(--critical-soft)', 'var(--critical)'],
    ink: ['var(--bg-sunken)', 'var(--ink-2)'],
  };
  const fallback: [string, string] = ['var(--bg-sunken)', 'var(--ink-2)'];
  const [bg, fg] = map[tone] ?? fallback;
  return (
    <span
      style={{
        background: bg,
        color: fg,
        fontSize: 'var(--text-2xs)',
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        padding: '3px 8px',
        borderRadius: 5,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

// ---- Overlay / modal backdrop (verbatim from sp-landing.jsx) ----
export function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(12,26,56,0.35)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 50,
        padding: 20,
      }}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

// ---- Avatars ----
// The prototype maps fixed initials → colors (AVA_TONE). For real data we hash
// initials to that same 6-color palette so the look matches while working for
// any user. `meri` renders the accent gradient with no label (verbatim).
const AVA_PALETTE = ['#2A57CE', '#7A4FB5', '#2E6B43', '#A26913', '#B5301B', '#2C5BD4'];
const MERI_GRADIENT = 'linear-gradient(135deg,#4E78D8,#1A3F9F)';

export function avaColor(id: string): string {
  if (id === 'meri') return MERI_GRADIENT;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVA_PALETTE[h % AVA_PALETTE.length]!;
}

export function Ava({ id, size = 24 }: { id: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: avaColor(id),
        color: '#fff',
        display: 'inline-grid',
        placeItems: 'center',
        fontSize: size * 0.4,
        fontWeight: 700,
        flexShrink: 0,
        border: '1.5px solid var(--bg-surface)',
      }}
    >
      {id === 'meri' ? '' : id}
    </span>
  );
}

export function AvaStack({ ids, size = 24 }: { ids: string[]; size?: number }) {
  return (
    <span style={{ display: 'inline-flex' }}>
      {ids.map((id, i) => (
        <span key={i} style={{ marginLeft: i ? -7 : 0 }}>
          <Ava id={id} size={size} />
        </span>
      ))}
    </span>
  );
}

// ---- shared style objects (verbatim from sp-landing.jsx + sp-app.jsx) ----
export const btnPrimary: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  whiteSpace: 'nowrap',
  background: 'var(--ink-1)',
  color: '#fff',
  border: 'none',
  borderRadius: 9,
  padding: '9px 16px',
  fontSize: 'var(--text-base)',
  fontWeight: 600,
  fontFamily: 'var(--font-sans)',
  cursor: 'pointer',
};

export const btnGhost: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  background: 'var(--bg-surface)',
  color: 'var(--ink-2)',
  border: '1px solid var(--border-2)',
  borderRadius: 9,
  padding: '9px 16px',
  fontSize: 'var(--text-base)',
  fontWeight: 600,
  fontFamily: 'var(--font-sans)',
  cursor: 'pointer',
};

export const iconBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  padding: 4,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 6,
};

export const lbl: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-xs)',
  fontWeight: 700,
  color: 'var(--ink-2)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 7,
};

export const fieldS: React.CSSProperties = {
  width: '100%',
  border: '1px solid var(--border-2)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-sans)',
  color: 'var(--ink-1)',
  background: 'var(--bg-surface)',
  boxSizing: 'border-box',
};

export const fieldLbl: React.CSSProperties = {
  fontSize: 'var(--text-2xs)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--ink-4)',
  marginBottom: 5,
  display: 'block',
};

export const chipBtn: React.CSSProperties = {
  fontSize: 'var(--text-2xs)',
  fontWeight: 600,
  padding: '5px 10px',
  borderRadius: 20,
  border: '1px solid var(--border-2)',
  background: 'var(--bg-surface)',
  color: 'var(--ink-2)',
  cursor: 'pointer',
};
