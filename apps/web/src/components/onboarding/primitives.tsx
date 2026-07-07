/**
 * Onboarding overlay primitives — verbatim style ports of the prototype's
 * shared primitives (apps/onboard-web/prototype/01-primitives.jsx) used by
 * the Phase-5 overlay components (PersonalSetupGate, DashboardTour,
 * TrialBanner, LockedFeatureNotice). Style objects are copied 1:1 from the
 * prototype; the only changes are TypeScript types and lucide-react icon
 * components instead of the prototype's window.lucide Icon-by-name helper.
 *
 * These render inside a `.ob-overlay` wrapper (see ob-overlay.css) which
 * supplies the prototype font tokens; all color tokens already exist in
 * src/theme.css with identical values.
 */
import type { CSSProperties, ComponentType, ReactNode } from 'react';
import './ob-overlay.css';

type LucideIconComponent = ComponentType<{
  size?: string | number;
  strokeWidth?: string | number;
  style?: CSSProperties;
}>;

/* Prototype Btn (01-primitives.jsx) — style objects verbatim. */
export function ObBtn({
  variant = 'secondary',
  size,
  disabled,
  onClick,
  children,
  style,
  icon: IconComponent,
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'lg';
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  style?: CSSProperties;
  icon?: LucideIconComponent;
}) {
  const base: CSSProperties = {
    fontFamily: 'var(--font-sans)',
    fontSize: size === 'sm' ? 12 : 13.5,
    fontWeight: 600,
    letterSpacing: '-0.005em',
    padding: size === 'sm' ? '5px 11px' : size === 'lg' ? '10px 20px' : '8px 16px',
    borderRadius: 6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    border: '1px solid transparent',
    opacity: disabled ? 0.45 : 1,
    transition: 'background 0.12s ease',
  };
  const variants: Record<string, CSSProperties> = {
    primary: { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' },
    secondary: { background: '#fff', color: 'var(--ink-1)', borderColor: 'var(--border-1)' },
    ghost: { background: 'transparent', color: 'var(--ink-2)' },
    danger: { background: '#fff', color: 'var(--critical)', borderColor: 'var(--border-1)' },
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {IconComponent && <IconComponent size={size === 'sm' ? 13 : 15} />}
      {children}
    </button>
  );
}

/* Prototype Field (01-primitives.jsx) — verbatim. */
export function ObField({
  label,
  hint,
  optional,
  children,
  style,
}: {
  label: ReactNode;
  hint?: ReactNode;
  optional?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, ...style }}>
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--ink-2)',
          display: 'flex',
          gap: 6,
          alignItems: 'baseline',
        }}
      >
        {label}
        {optional && (
          <span style={{ fontWeight: 400, color: 'var(--ink-3)', fontSize: 11 }}>optional</span>
        )}
      </span>
      {children}
      {hint && (
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.45 }}>{hint}</span>
      )}
    </label>
  );
}

/* Prototype obInputStyle (01-primitives.jsx) — verbatim. */
export const obInputStyle: CSSProperties = {
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border-1)',
  borderRadius: 6,
  padding: '8px 11px',
  fontSize: 13.5,
  fontFamily: 'var(--font-sans)',
  color: 'var(--ink-1)',
  outline: 'none',
  width: '100%',
  letterSpacing: '-0.005em',
};

/* Prototype SelectInput (01-primitives.jsx) — verbatim. */
export function ObSelectInput({
  options,
  value,
  onChange,
  placeholder,
  style,
}: {
  options: string[];
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  style?: CSSProperties;
}) {
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange && onChange(e.target.value)}
      style={{
        ...obInputStyle,
        appearance: 'auto',
        color: value ? 'var(--ink-1)' : 'var(--ink-3)',
        ...style,
      }}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/* Prototype Tag (01-primitives.jsx) — verbatim. */
export function ObTag({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'blue' | 'success' | 'critical' | 'notable';
  children?: ReactNode;
}) {
  const tones: Record<
    'neutral' | 'blue' | 'success' | 'critical' | 'notable',
    { bg: string; fg: string; bd: string }
  > = {
    neutral: { bg: 'var(--bg-sunken)', fg: 'var(--ink-2)', bd: 'var(--border-1)' },
    blue: { bg: 'var(--accent-soft)', fg: 'var(--accent-ink)', bd: 'transparent' },
    success: { bg: 'var(--success-soft)', fg: 'var(--success)', bd: 'transparent' },
    critical: { bg: 'var(--critical-soft)', fg: 'var(--critical)', bd: 'transparent' },
    notable: { bg: 'var(--notable-soft)', fg: 'var(--notable)', bd: 'transparent' },
  };
  const t = tones[tone];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.bd}`,
        borderRadius: 4,
        padding: '2px 7px',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      {children}
    </span>
  );
}

/* Prototype Card (01-primitives.jsx) — verbatim. */
export function ObCard({
  children,
  style,
  pad = 24,
}: {
  children?: ReactNode;
  style?: CSSProperties;
  pad?: number;
}) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--border-1)',
        borderRadius: 8,
        boxShadow: '0 1px 2px rgba(21,22,26,0.04)',
        padding: pad,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* Prototype Spinner (01-primitives.jsx) — verbatim (keyframes in ob-overlay.css). */
export function ObSpinner({
  size = 14,
  color = 'var(--accent)',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'inline-block',
        border: `2px solid ${color}`,
        borderTopColor: 'transparent',
        animation: 'ob-spin 0.7s linear infinite',
      }}
    ></span>
  );
}

/* Prototype MsGlyph / GGlyph (03-flow2a-it.jsx) — verbatim. */
export function MsGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 21 21">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export function GGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.1 3.7-8.6z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 6-1.1 8-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.2 1.2-3.2 0-5.9-2.1-6.9-5l-3.9 3C3.2 21.3 7.3 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.1 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-4-3C.4 8.2 0 10 0 12s.4 3.8 1.2 5.4l3.9-3z"
      />
      <path
        fill="#EA4335"
        d="M12 4.7c1.8 0 3 .8 3.7 1.4l2.7-2.6C16.4 1.3 14 0 12 0 7.3 0 3.2 2.7 1.2 6.6l4 3c.9-2.8 3.6-4.9 6.8-4.9z"
      />
    </svg>
  );
}
