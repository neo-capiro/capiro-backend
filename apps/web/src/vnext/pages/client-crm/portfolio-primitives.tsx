import { useState, type CSSProperties, type ReactNode } from 'react';
import { PORTFOLIO_ICON_DATA } from './portfolio-icon-data.js';

/**
 * Portfolio prototype primitives (PORTFOLIO-UI-BUILD-SPEC §2).
 *
 * These are the literal building blocks the prototype composes. Every value is
 * transcribed from the prototype's inline styles / the spec, never estimated.
 * Visuals are scoped under `.cap-pf` (the Portfolio prototype root) so the
 * shared vNext tokens (navy/Hanken) are untouched for other surfaces.
 */

/* ── Icons ───────────────────────────────────────────────────────────────── */

export type PortfolioIconName = keyof typeof PORTFOLIO_ICON_DATA;

export function UIcon({
  name,
  size = 24,
  color,
  style,
}: {
  name: string;
  size?: number;
  color?: string;
  style?: CSSProperties;
}) {
  const d = PORTFOLIO_ICON_DATA[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox={d.viewBox}
      fill="none"
      aria-hidden
      style={{ display: 'block', flex: '0 0 auto', color: color ?? 'currentColor', ...style }}
      dangerouslySetInnerHTML={{ __html: d.body }}
    />
  );
}

/* ── Status / tier palettes (§1.3) ───────────────────────────────────────── */

export type PillTone = 'gray' | 'brand' | 'blue' | 'error' | 'warning' | 'success';

/** [bg, ring, text, dot] — verbatim from the prototype PILL array. */
export const PILL: Record<PillTone, [string, string, string, string]> = {
  gray: ['#F9FAFB', '#EAECF0', '#344054', '#667085'],
  brand: ['#F2F4F7', '#D0D5DD', '#101828', '#101828'],
  blue: ['#F2F4F7', '#D0D5DD', '#101828', '#344054'],
  error: ['#FEF3F2', '#FECDCA', '#B42318', '#F04438'],
  warning: ['#FFFAEB', '#FEDF89', '#B54708', '#F79009'],
  success: ['#ECFDF3', '#ABEFC6', '#027A48', '#12B76A'],
};

export type EvidenceTier = 'Public record' | 'Client-verified' | 'Inferred';

/** Evidence-tier palette (§1.3) — verbatim from the prototype TIER array. */
export const TIER: Record<EvidenceTier, [string, string, string, string]> = {
  'Public record': ['#F2F4F7', '#D0D5DD', '#101828', '#101828'],
  'Client-verified': ['#ECFDF3', '#ABEFC6', '#027A48', '#12B76A'],
  Inferred: ['#FFFAEB', '#FEDF89', '#B54708', '#F79009'],
};

/** Fit ramp (§1.3): ≥90 success, ≥80 brand, <80 gray. */
export function fitTone(score: number): PillTone {
  if (score >= 90) return 'success';
  if (score >= 80) return 'brand';
  return 'gray';
}

/* ── Pill (§2.3) ─────────────────────────────────────────────────────────── */

export function Pill({
  tone,
  children,
  size = 'md',
  dotless = false,
  style,
}: {
  tone: PillTone;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xs';
  dotless?: boolean;
  style?: CSSProperties;
}) {
  const [bg, ring, fg, dot] = PILL[tone];
  const dims =
    size === 'lg'
      ? { height: 26, padding: dotless ? '0 10px' : '0 10px 0 8px', fontSize: 12, gap: 6, dotSize: 6 }
      : size === 'sm'
        ? { height: 20, padding: dotless ? '0 7px' : '0 7px 0 5px', fontSize: 11, gap: 5, dotSize: 5 }
        : size === 'xs'
          ? { height: 18, padding: '0 7px', fontSize: 11, gap: 5, dotSize: 5 }
          : { height: 22, padding: dotless ? '0 8px' : '0 8px 0 6px', fontSize: 12, gap: 6, dotSize: 6 };
  return (
    <span
      className="cap-pf-pill"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dims.gap,
        height: dims.height,
        padding: dims.padding,
        borderRadius: 9999,
        background: bg,
        boxShadow: `inset 0 0 0 1px ${ring}`,
        color: fg,
        fontSize: dims.fontSize,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dotless ? null : (
        <span style={{ width: dims.dotSize, height: dims.dotSize, borderRadius: '50%', background: dot }} aria-hidden />
      )}
      {children}
    </span>
  );
}

/* ── Evidence chip (§2.4 — radius 6, weight 600, tier colours) ───────────── */

export function EvidenceChip({ tier, label, style }: { tier: EvidenceTier; label?: string; style?: CSSProperties }) {
  const [bg, ring, fg, dot] = TIER[tier];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 8px 0 6px',
        borderRadius: 6,
        background: bg,
        boxShadow: `inset 0 0 0 1px ${ring}`,
        color: fg,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot }} aria-hidden />
      {label ?? tier}
    </span>
  );
}

/* ── Fit chip (radius 6, weight 600, fit ramp) ───────────────────────────── */

export function FitChip({ score, suffix = '%', style }: { score: number; suffix?: string; style?: CSSProperties }) {
  const [bg, ring, fg] = PILL[fitTone(score)];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        background: bg,
        boxShadow: `inset 0 0 0 1px ${ring}`,
        color: fg,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {score}
      {suffix}
    </span>
  );
}

/* ── Neutral chip (§2.4) ─────────────────────────────────────────────────── */

export function Chip({
  children,
  selected = false,
  style,
}: {
  children: ReactNode;
  selected?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 26,
        padding: '0 10px',
        borderRadius: 8,
        background: selected ? '#F2F4F7' : '#F9FAFB',
        boxShadow: selected ? 'inset 0 0 0 1px #D0D5DD' : 'inset 0 0 0 1px #EAECF0',
        color: selected ? '#101828' : '#344054',
        fontSize: 13,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/* ── Eyebrow (§2.2) ──────────────────────────────────────────────────────── */

export function Eyebrow({ children, tight = false, style }: { children: ReactNode; tight?: boolean; style?: CSSProperties }) {
  return (
    <span
      style={{
        fontSize: tight ? 11 : 12,
        fontWeight: 600,
        letterSpacing: tight ? '.05em' : '.04em',
        textTransform: 'uppercase',
        color: '#667085',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/* ── Buttons (§2.5) ──────────────────────────────────────────────────────── */

export const GRADIENT_DARK = 'linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%)';
export const GRADIENT_DARK_HOVER = 'linear-gradient(180deg,#4A5462 0%,#252F3C 46%,#161D26 100%)';

export function PfButton({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  onClick,
  disabled,
  busy = false,
  style,
  ariaLabel,
}: {
  variant?: 'primary' | 'secondary' | 'link' | 'icon';
  size?: 'sm' | 'md';
  icon?: string;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const [hover, setHover] = useState(false);
  const height = size === 'sm' ? 36 : 40;
  const padding = size === 'sm' ? '0 14px' : '0 16px';

  if (variant === 'icon') {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 40,
          height: 40,
          borderRadius: 8,
          boxShadow: 'inset 0 0 0 1px #D0D5DD',
          color: '#475467',
          background: hover ? '#F9FAFB' : 'transparent',
          ...style,
        }}
      >
        {icon ? <UIcon name={icon} size={20} /> : children}
      </button>
    );
  }

  if (variant === 'link') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: hover ? '#0E141C' : '#101828',
          whiteSpace: 'nowrap',
          ...style,
        }}
      >
        {children}
      </button>
    );
  }

  const primary = variant === 'primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height,
        padding,
        borderRadius: 8,
        background: primary ? (hover ? GRADIENT_DARK_HOVER : GRADIENT_DARK) : hover ? '#F9FAFB' : '#ffffff',
        color: primary ? '#ffffff' : hover ? '#101828' : '#344054',
        fontSize: 14,
        fontWeight: 600,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        boxShadow: primary
          ? '0px 1px 2px rgba(16,24,40,.05)'
          : 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)',
        ...style,
      }}
    >
      {icon ? <UIcon name={icon} size={14} /> : null}
      {busy ? '…' : children}
    </button>
  );
}

/* ── Horizontal milestone track (§2.14) ──────────────────────────────────── */

export type MilestoneState = 'done' | 'current' | 'gap' | 'closed' | 'pending';

export interface MilestoneStep {
  label: string;
  date: string;
  state: MilestoneState;
}

const MILESTONE_NODE: Record<MilestoneState, { bg: string; ring: string; mark: string; markFg: string; fg: string }> = {
  done: { bg: GRADIENT_DARK, ring: 'none', mark: '✓', markFg: '#ffffff', fg: '#101828' },
  current: { bg: '#ffffff', ring: 'inset 0 0 0 2px #101828', mark: '', markFg: '#101828', fg: '#101828' },
  gap: { bg: '#FFFAEB', ring: 'inset 0 0 0 1px #FEDF89', mark: '!', markFg: '#B54708', fg: '#B54708' },
  closed: { bg: '#F2F4F7', ring: 'inset 0 0 0 1px #D0D5DD', mark: '·', markFg: '#475467', fg: '#475467' },
  pending: { bg: '#F9FAFB', ring: 'inset 0 0 0 1px #EAECF0', mark: '', markFg: '#98A2B3', fg: '#667085' },
};

/**
 * The track never scrolls — steps compress and labels wrap. A connector line
 * is dark only when both adjacent steps are filled (done/closed/current).
 */
export function MilestoneTrack({ steps, nodeSize = 18 }: { steps: MilestoneStep[]; nodeSize?: number }) {
  const filled = (s: MilestoneState) => s === 'done' || s === 'closed' || s === 'current';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', width: '100%' }}>
      {steps.map((step, i) => {
        const node = MILESTONE_NODE[step.state];
        const prev = i > 0 ? steps[i - 1] : undefined;
        const next = i < steps.length - 1 ? steps[i + 1] : undefined;
        const leftDark = prev != null && filled(prev.state) && filled(step.state);
        const rightDark = next != null && filled(step.state) && filled(next.state);
        return (
          <span key={`${step.label}-${i}`} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
              <span style={{ flex: 1, height: 2, background: i === 0 ? 'transparent' : leftDark ? '#101828' : '#EAECF0' }} />
              <span
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: nodeSize,
                  height: nodeSize,
                  borderRadius: '50%',
                  background: node.bg,
                  boxShadow: node.ring,
                  color: node.markFg,
                  fontSize: nodeSize >= 24 ? 11 : 11,
                  fontWeight: nodeSize >= 24 ? 700 : 600,
                }}
              >
                {node.mark}
              </span>
              <span style={{ flex: 1, height: 2, background: i === steps.length - 1 ? 'transparent' : rightDark ? '#101828' : '#EAECF0' }} />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '0 4px', textAlign: 'center', minWidth: 0 }}>
            <span style={{ fontSize: nodeSize >= 24 ? 11 : 12, fontWeight: 600, lineHeight: '16px', color: node.fg, textWrap: 'pretty', overflowWrap: 'break-word', textTransform: nodeSize >= 24 ? 'uppercase' : 'none', letterSpacing: nodeSize >= 24 ? '.02em' : 0 }}>
                {step.label}
              </span>
              <span style={{ fontSize: 11, color: '#98A2B3' }}>{step.date}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

/* ── Vertical timeline rail (§2.13) ──────────────────────────────────────── */

export function TimelineRail({
  live = false,
  first = false,
  last = false,
  gutterWidth = 44,
  padTop = 19,
  nodeSize = 9,
}: {
  live?: boolean;
  first?: boolean;
  last?: boolean;
  gutterWidth?: number;
  padTop?: number;
  nodeSize?: number;
}) {
  return (
    <div style={{ flex: '0 0 auto', width: gutterWidth, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: padTop }}>
      <span style={{ width: 2, height: padTop, background: first ? 'transparent' : '#EAECF0' }} />
      <span
        style={{
          flex: '0 0 auto',
          width: nodeSize,
          height: nodeSize,
          borderRadius: '50%',
          background: live ? '#ffffff' : GRADIENT_DARK,
          boxShadow: live ? 'inset 0 0 0 2.5px #101828' : 'none',
        }}
      />
      <span style={{ flex: 1, width: 2, background: last ? 'transparent' : '#EAECF0', minHeight: 6 }} />
    </div>
  );
}

/* ── Avatar / tile (§2.10) ───────────────────────────────────────────────── */

export function Tile({
  initials,
  size = 40,
  dark = false,
  round = false,
  src,
}: {
  initials: string;
  size?: number;
  dark?: boolean;
  round?: boolean;
  src?: string | null;
}) {
  const fontSize = size >= 56 ? 15 : size >= 48 ? 18 : size >= 40 ? 13 : size >= 32 ? 11 : 10;
  return (
    <span
      aria-hidden
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: round ? '50%' : size >= 40 ? 8 : 6,
        background: src ? '#F2F4F7' : dark ? GRADIENT_DARK : '#F2F4F7',
        color: dark && !src ? '#ffffff' : '#101828',
        fontSize,
        fontWeight: 600,
        letterSpacing: '.02em',
        overflow: 'hidden',
      }}
    >
      {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials}
    </span>
  );
}

export function Avatar({
  initials,
  size = 32,
  overlap = false,
  dark = false,
}: {
  initials: string;
  size?: number;
  overlap?: boolean;
  dark?: boolean;
}) {
  const fontSize = size >= 32 ? 11 : 10;
  return (
    <span
      aria-hidden
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        marginLeft: overlap ? -8 : 0,
        borderRadius: '50%',
        background: dark ? GRADIENT_DARK : '#F2F4F7',
        color: dark ? '#ffffff' : '#101828',
        fontSize,
        fontWeight: 600,
        boxShadow: overlap ? '0 0 0 2px #ffffff' : 'none',
      }}
    >
      {initials}
    </span>
  );
}

/* ── Segmented sub-tab bar (§2.7) ────────────────────────────────────────── */

export function SegmentedTabs<V extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ key: V; label: string }>;
  value: V;
  onChange: (v: V) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        gap: 4,
        padding: 4,
        borderRadius: 10,
        background: '#ffffff',
        boxShadow: '0 0 0 1px #EAECF0',
      }}
    >
      {options.map((opt) => (
        <SegmentedItem key={opt.key} active={value === opt.key} label={opt.label} onClick={() => onChange(opt.key)} />
      ))}
    </div>
  );
}

function SegmentedItem({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 32,
        padding: '0 14px',
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 600,
        background: active ? '#F9FAFB' : 'transparent',
        boxShadow: active ? 'inset 0 0 0 1px #EAECF0' : 'none',
        color: active ? '#101828' : hover ? '#101828' : '#667085',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

/* ── Card scaffolding (§2.1) ─────────────────────────────────────────────── */

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <section
      style={{
        background: '#ffffff',
        borderRadius: 12,
        boxShadow: '0 0 0 1px #EAECF0,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </section>
  );
}

export function CardHead({
  title,
  description,
  action,
  withDesc = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  withDesc?: boolean;
}) {
  if (withDesc || description) {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '20px 24px 16px', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 240 }}>
          <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>{title}</span>
          {description ? (
            <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>{description}</span>
          ) : null}
        </span>
        {action}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 24px', borderBottom: '1px solid #EAECF0' }}>
      <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#101828' }}>{title}</h3>
      <span style={{ flex: 1 }} />
      {action}
    </div>
  );
}

export function CardFoot({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '13px 24px',
        borderTop: '1px solid #EAECF0',
        background: '#FCFCFD',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontSize: 13, color: '#475467' }}>{left}</span>
      <span style={{ flex: 1, minWidth: 12 }} />
      {right ? <span style={{ fontSize: 13, color: '#667085' }}>{right}</span> : null}
    </div>
  );
}

/* ── Page header (each tab panel opens with this, §5.3) ──────────────────── */

export function TabPageHead({ title, sub, actions }: { title: string; sub: string; actions?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 260 }}>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>{title}</h2>
        <div style={{ marginTop: 4, fontSize: 16, color: '#475467', textWrap: 'pretty' }}>{sub}</div>
      </div>
      {actions}
    </div>
  );
}
