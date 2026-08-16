/**
 * Workspace vNext parity primitives (design-handoff §2, §12).
 *
 * Small, stateless building blocks shared by every workspace surface. All
 * visual values resolve through the --ws-* tokens in styles/workspace.css,
 * which this parity pass extends with the handoff's literal values.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon.js';

// ── Buttons ─────────────────────────────────────────────────────────────────

type WsButtonVariant = 'metal' | 'secondary' | 'ghost' | 'danger';
type WsButtonSize = 'sm' | 'md' | 'lg';

export interface WsButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: WsButtonVariant;
  size?: WsButtonSize;
  icon?: WorkspaceIconName;
  iconSize?: number;
}

/** Handoff button: metal gradient primary, ringed secondary, ghost, danger. */
export function WsButton({
  variant = 'secondary',
  size = 'md',
  icon,
  iconSize,
  className = '',
  children,
  ...rest
}: WsButtonProps) {
  return (
    <button
      type="button"
      className={`ws-btn ws-btn--${variant} ws-btn--${size} ${className}`.trim()}
      {...rest}
    >
      {icon ? (
        <WorkspaceIcon
          name={icon}
          size={iconSize ?? (size === 'lg' ? 17 : size === 'sm' ? 14 : 15)}
          color="currentColor"
        />
      ) : null}
      {children}
    </button>
  );
}

// ── Pills & chips ───────────────────────────────────────────────────────────

export type WsTone =
  | 'neutral'
  | 'navy'
  | 'lavender'
  | 'amber'
  | 'red'
  | 'green'
  | 'cream';

/** Mono uppercase pill — status, scope, provenance, kind tags (handoff §2.2). */
export function WsPill({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: WsTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`ws-pill ws-pill--${tone} ${className}`.trim()}>
      {children}
    </span>
  );
}

/** Mono eyebrow / field key / meta label. */
export function WsMono({
  variant = 'eyebrow',
  children,
  className = '',
  style,
}: {
  variant?: 'eyebrow' | 'panel' | 'field' | 'tag' | 'num' | 'endpoint';
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={`ws-mono ws-mono--${variant} ${className}`.trim()}
      style={style}
    >
      {children}
    </span>
  );
}

// ── Spinner ─────────────────────────────────────────────────────────────────

export function WsSpinner({
  size = 14,
  onDark = false,
}: {
  size?: number;
  onDark?: boolean;
}) {
  return (
    <span
      className={`ws-spinner ${onDark ? 'ws-spinner--dark' : ''}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

// ── Segmented control ───────────────────────────────────────────────────────

export interface WsSegment {
  key: string;
  label: ReactNode;
}

export function WsSegmented({
  segments,
  value,
  onChange,
  ariaLabel,
}: {
  segments: readonly WsSegment[];
  value: string;
  onChange: (key: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="ws-segmented" role="tablist" aria-label={ariaLabel}>
      {segments.map((segment) => (
        <button
          key={segment.key}
          type="button"
          role="tab"
          aria-selected={value === segment.key}
          data-active={value === segment.key}
          onClick={() => onChange(segment.key)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}

// ── Toggle switch (38×22) ───────────────────────────────────────────────────

export function WsToggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="ws-toggle"
      data-on={on}
      onClick={() => onChange(!on)}
    >
      <span className="ws-toggle__knob" />
    </button>
  );
}

// ── Checkbox (gradient when on) ─────────────────────────────────────────────

export function WsCheckbox({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className="ws-checkbox"
      data-on={on}
      onClick={() => onChange(!on)}
    >
      <span className="ws-checkbox__tick">
        {on ? <WorkspaceIcon name="Check" size={10} color="#ffffff" /> : null}
      </span>
    </button>
  );
}

// ── Paper swatches (theme state, handoff §2.6) ──────────────────────────────

export interface WsPaperSwatch {
  value: string;
  label: string;
}

export const WS_PAPERS: readonly WsPaperSwatch[] = [
  { value: '#FEFDFA', label: 'Ivory' },
  { value: '#FFFFFF', label: 'Bright white' },
  { value: '#FBF6EC', label: 'Warm cream' },
  { value: '#F7F8FA', label: 'Cool grey' },
];

export function WsPaperSwatches({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange?: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ws-paper-swatches">
      {WS_PAPERS.map((paper) => (
        <button
          key={paper.value}
          type="button"
          title={paper.label}
          disabled={disabled}
          className="ws-paper-swatches__swatch"
          data-active={
            value.toUpperCase() === paper.value.toUpperCase()
          }
          style={{ background: paper.value }}
          onClick={() => onChange?.(paper.value)}
        />
      ))}
    </div>
  );
}

// ── Honest-gap note (amber "No endpoint yet" card) ──────────────────────────

export function WsGapNote({
  title = 'No endpoint yet',
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="ws-gap-note">
      <span className="ws-gap-note__title">{title}</span>
      <span className="ws-gap-note__body">{children}</span>
    </div>
  );
}
