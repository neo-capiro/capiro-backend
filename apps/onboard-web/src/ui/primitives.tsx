// ── Capiro Onboarding — shared UI primitives ────────────────────────────────
// 1:1 TypeScript port of the onboarding prototype's primitives
// (prototype/01-primitives.jsx). Style values are copied verbatim — pixel
// fidelity to the prototype is a hard requirement. Deliberately dropped from
// the prototype: EnvBar (the fake browser chrome was a demo affordance) and
// the Navigator harness.
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  CircleHelp,
  Clock,
  CreditCard,
  Download,
  FileUp,
  Hourglass,
  ImageUp,
  Info,
  Landmark,
  LifeBuoy,
  Lock,
  MailCheck,
  MailPlus,
  MousePointerClick,
  Plug,
  Plus,
  ReceiptText,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';

// Named registry keeps the prototype's `<Icon name="..."/>` call sites
// verbatim while letting Vite tree-shake the rest of lucide.
const ICONS: Record<string, LucideIcon> = {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  CircleHelp,
  Clock,
  CreditCard,
  Download,
  FileUp,
  Hourglass,
  ImageUp,
  Info,
  Landmark,
  LifeBuoy,
  Lock,
  MailCheck,
  MailPlus,
  MousePointerClick,
  Plug,
  Plus,
  ReceiptText,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserCog,
  Users,
  X,
};

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.8,
  style,
}: {
  name: string;
  size?: number;
  strokeWidth?: number;
  style?: React.CSSProperties;
}) {
  const Cmp = ICONS[name];
  if (!Cmp) return null;
  return <Cmp size={size} strokeWidth={strokeWidth} style={{ flexShrink: 0, ...style }} />;
}

export function Wordmark({ dark = false, size = 15 }: { dark?: boolean; size?: number }) {
  const ring = dark ? '#cfc9bd' : '#4F525A';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <span
        style={{
          width: size * 1.45,
          height: size * 1.45,
          borderRadius: '50%',
          border: `2px solid ${ring}`,
          position: 'relative',
          display: 'inline-block',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: size * 0.6,
            height: 1.6,
            background: ring,
            transformOrigin: 'left',
            transform: 'rotate(-38deg)',
          }}
        ></span>
      </span>
      <b
        style={{
          fontSize: size,
          color: dark ? '#fff' : 'var(--ink-1)',
          fontWeight: 600,
          letterSpacing: '-0.01em',
        }}
      >
        Capiro
      </b>
    </span>
  );
}

export function Btn({
  variant = 'secondary',
  size,
  disabled,
  onClick,
  children,
  style,
  icon,
  type = 'button',
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'lg';
  disabled?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  icon?: string;
  type?: 'button' | 'submit';
}) {
  const base: React.CSSProperties = {
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
  const variants: Record<string, React.CSSProperties> = {
    primary: { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' },
    secondary: { background: '#fff', color: 'var(--ink-1)', borderColor: 'var(--border-1)' },
    ghost: { background: 'transparent', color: 'var(--ink-2)' },
    danger: { background: '#fff', color: 'var(--critical)', borderColor: 'var(--border-1)' },
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  optional,
  children,
  style,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  optional?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
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

export const obInputStyle: React.CSSProperties = {
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

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [focus, setFocus] = React.useState(false);
  return (
    <input
      {...props}
      onFocus={(e) => {
        setFocus(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocus(false);
        props.onBlur?.(e);
      }}
      style={{
        ...obInputStyle,
        ...(focus
          ? {
              boxShadow: '0 0 0 3px var(--accent-glow)',
              borderColor: 'var(--accent)',
              background: '#fff',
            }
          : {}),
        ...props.style,
      }}
    />
  );
}

export function SelectInput({
  options,
  value,
  onChange,
  placeholder,
  style,
}: {
  options: string[];
  value?: string | null;
  onChange?: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
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

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 9,
        alignItems: 'flex-start',
        cursor: 'pointer',
        fontSize: 13,
        color: 'var(--ink-1)',
        lineHeight: 1.5,
      }}
    >
      <span
        onClick={(e) => {
          e.preventDefault();
          onChange(!checked);
        }}
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          marginTop: 1,
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          border: checked ? '1px solid var(--accent)' : '1px solid var(--border-strong)',
          background: checked ? 'var(--accent)' : '#fff',
        }}
      >
        {checked && <Icon name="Check" size={11} strokeWidth={3} style={{ color: '#fff' }} />}
      </span>
      <span
        onClick={(e) => {
          e.preventDefault();
          onChange(!checked);
        }}
      >
        {children}
      </span>
    </label>
  );
}

// 11px uppercase severity tag
export function Tag({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'blue' | 'success' | 'critical' | 'notable';
  children?: React.ReactNode;
}) {
  const tones = {
    neutral: { bg: 'var(--bg-sunken)', fg: 'var(--ink-2)', bd: 'var(--border-1)' },
    blue: { bg: 'var(--accent-soft)', fg: 'var(--accent-ink)', bd: 'transparent' },
    success: { bg: 'var(--success-soft)', fg: 'var(--success)', bd: 'transparent' },
    critical: { bg: 'var(--critical-soft)', fg: 'var(--critical)', bd: 'transparent' },
    notable: { bg: 'var(--notable-soft)', fg: 'var(--notable)', bd: 'transparent' },
  }[tone];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        background: tones.bg,
        color: tones.fg,
        border: `1px solid ${tones.bd}`,
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

export function Card({
  children,
  style,
  pad = 24,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
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

// Radio-select option card (plan selection, import preference)
export function OptionCard({
  selected,
  onClick,
  title,
  price,
  children,
  badge,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  price?: string;
  children?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1,
        cursor: 'pointer',
        background: '#fff',
        borderRadius: 8,
        padding: '20px 20px 18px',
        position: 'relative',
        border: selected ? '1.5px solid var(--accent)' : '1px solid var(--border-1)',
        boxShadow: selected ? '0 0 0 3px var(--accent-glow)' : '0 1px 2px rgba(21,22,26,0.04)',
        margin: selected ? 0 : '0.5px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <span
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            flexShrink: 0,
            marginTop: 2,
            display: 'grid',
            placeItems: 'center',
            border: selected ? '5px solid var(--accent)' : '1.5px solid var(--border-strong)',
            background: '#fff',
          }}
        ></span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 15, letterSpacing: '-0.01em', color: 'var(--ink-1)' }}>{title}</b>
            {badge}
          </div>
          {price && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--ink-2)',
                marginTop: 3,
                letterSpacing: 0,
              }}
            >
              {price}
            </div>
          )}
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.55, paddingLeft: 26 }}>
        {children}
      </div>
    </div>
  );
}

// Flow-1 funnel step indicator
export const OB_F1_STEPS = [
  'Account',
  'Verify',
  'Plan',
  'Legal',
  'Billing',
  'Admins',
  'Clients',
  'Org',
  'Done',
] as const;

export function StepRail({ current }: { current: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {OB_F1_STEPS.map((s, i) => (
        <React.Fragment key={s}>
          {i > 0 && (
            <span
              style={{
                width: 22,
                height: 1,
                background: i <= current ? 'var(--accent)' : 'var(--border-2)',
              }}
            ></span>
          )}
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 15,
                height: 15,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                fontSize: 8.5,
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                background: i < current ? 'var(--accent)' : i === current ? '#fff' : 'transparent',
                border:
                  i === current
                    ? '1.5px solid var(--accent)'
                    : i < current
                      ? '1px solid var(--accent)'
                      : '1px solid var(--border-strong)',
                color: i < current ? '#fff' : i === current ? 'var(--accent)' : 'var(--ink-3)',
              }}
            >
              {i < current ? <Icon name="Check" size={8} strokeWidth={3.4} /> : i + 1}
            </span>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: i === current ? 700 : 500,
                color:
                  i === current ? 'var(--ink-1)' : i < current ? 'var(--ink-2)' : 'var(--ink-4)',
                letterSpacing: '0.01em',
              }}
            >
              {s}
            </span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

// Funnel page shell — the registration flow (no sidebar). The prototype's
// EnvBar (fake browser chrome) is intentionally not rendered in production.
// Data-entry steps the user may step BACK through (identity + provisioning
// screens are excluded). Kept in sync with FunnelStepGuard's ladder.
const FUNNEL_BACK_ORDER = ['/plan', '/legal', '/billing', '/admins', '/clients', '/org'];

export function FunnelShell({
  step,
  children,
  maxWidth = 520,
}: {
  step?: number | null;
  children?: React.ReactNode;
  maxWidth?: number;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const backIdx = FUNNEL_BACK_ORDER.indexOf(location.pathname);
  const backTo = backIdx > 0 ? FUNNEL_BACK_ORDER[backIdx - 1] : null;
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-canvas)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '18px 40px 0',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <Wordmark />
        {step != null && <StepRail current={step} />}
        <span style={{ width: 70 }}></span>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '44px 40px 64px',
        }}
      >
        <div style={{ width: '100%', maxWidth }}>
          {backTo && (
            <button
              type="button"
              onClick={() => navigate(backTo)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                marginBottom: 16,
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--ink-3)',
              }}
            >
              <ArrowLeft size={14} />
              Back
            </button>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

export function ScreenTitle({
  kicker,
  title,
  sub,
}: {
  kicker?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      {kicker && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--accent)',
            marginBottom: 8,
          }}
        >
          {kicker}
        </div>
      )}
      <h1
        style={{
          margin: 0,
          fontFamily: 'var(--font-serif)',
          fontWeight: 500,
          fontSize: 28,
          letterSpacing: '-0.015em',
          color: 'var(--ink-1)',
          lineHeight: 1.2,
        }}
      >
        {title}
      </h1>
      {sub && (
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 13.5,
            color: 'var(--ink-2)',
            lineHeight: 1.55,
            textWrap: 'pretty',
          }}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

export function Spinner({ size = 14, color = 'var(--accent)' }: { size?: number; color?: string }) {
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

// Shared modal scaffold
export function Modal({
  title,
  onClose,
  children,
  width = 520,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(12,26,56,0.42)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 60,
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 10,
          width: '100%',
          maxWidth: width,
          boxShadow: '0 18px 50px rgba(12,26,56,0.28)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '14px 20px',
            borderBottom: '1px solid var(--border-1)',
          }}
        >
          <b style={{ fontSize: 14.5, letterSpacing: '-0.005em' }}>{title}</b>
          <button
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--ink-3)',
              display: 'grid',
              placeItems: 'center',
              padding: 4,
            }}
          >
            <Icon name="X" size={16} />
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

export function InfoBlock({
  icon,
  title,
  tag,
  children,
}: {
  icon: string;
  title: React.ReactNode;
  tag?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border-1)',
        borderRadius: 6,
        padding: '12px 14px',
      }}
    >
      <Icon name={icon} size={16} style={{ color: 'var(--ink-3)', marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <b style={{ fontSize: 12.5 }}>{title}</b>
          {tag}
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--ink-2)',
            lineHeight: 1.55,
            overflowWrap: 'break-word',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

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
