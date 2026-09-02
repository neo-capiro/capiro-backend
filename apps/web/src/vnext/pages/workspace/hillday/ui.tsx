/**
 * Hill Day module — shared presentation primitives.
 *
 * One icon component over the module's verbatim Untitled UI PRO icon registry
 * (icons.tsx), the three-part button language (metal primary / outlined
 * secondary / ghost), and the status pill with leading dot. Everything reads
 * tokens via hillday.css classes — no inline colors anywhere (foundation
 * contract).
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { HILLDAY_ICONS, type HillDayIconName } from './icons.js';
import type { PillTone } from './types.js';
import './hillday-tokens.css';
import './hillday.css';

/**
 * Names the prototype referenced that its own icon registry did not carry,
 * resolved to their nearest kit equivalents (documented decision, 2026-09-01).
 */
const FALLBACKS: Record<string, HillDayIconName> = {
  UsersPlus: 'UserCheck01',
  Microphone01: 'MessageSquare01',
  BarChartSquare02: 'File04',
  Users02: 'Users01',
  Loading01: 'Clock',
};

export type HillDayIcon = HillDayIconName | keyof typeof FALLBACKS;

export function HdIcon({
  name,
  size = 20,
  className,
}: {
  name: HillDayIcon;
  size?: number;
  className?: string;
}) {
  const resolved = (name in HILLDAY_ICONS ? name : FALLBACKS[name] ?? 'File04') as HillDayIconName;
  const icon = HILLDAY_ICONS[resolved];
  return (
    <svg
      width={size}
      height={size}
      viewBox={icon.viewBox}
      className={className}
      fill="none"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}


export function HdPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={`hd-pill hd-pill--${tone}`}>
      <span className="hd-pill__dot" />
      {children}
    </span>
  );
}

export function HdPrimary({
  children,
  disabled,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`hd-btn${disabled ? ' hd-btn--disabled' : ''}`}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

export function HdSecondary({
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`hd-btn-secondary ${className}`} {...rest}>
      {children}
    </button>
  );
}
