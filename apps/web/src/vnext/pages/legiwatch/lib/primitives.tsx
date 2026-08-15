/**
 * LegiWatch vNext — shared primitives. Every status pill carries a dot AND a
 * text label (§5.2: status is never colour-only).
 */
import type { ReactNode } from 'react';
import type { Tone } from './types.js';

export function LwPill({
  tone,
  children,
  size,
  pulse,
}: {
  tone: Tone;
  children: ReactNode;
  size?: '22' | '24' | '26';
  pulse?: boolean;
}) {
  return (
    <span className={`lw-pill lw-pill--${tone}${size ? ` lw-pill--${size}` : ''}`}>
      <span
        className="lw-pill__dot"
        style={pulse ? { animation: 'lwPulse 1.6s ease-in-out infinite' } : undefined}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

export function LwButton({
  variant,
  size,
  children,
  onClick,
  disabled,
  title,
  className,
  type,
}: {
  variant?: 'primary' | 'secondary';
  size?: '36' | '40' | '42';
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type ?? 'button'}
      className={`lw-btn${variant === 'primary' ? ' lw-btn--primary' : ''}${size && size !== '36' ? ` lw-btn--${size}` : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export function LwSeg<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="lw-seg" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          className={`lw-seg__item${value === opt.id ? ' is-active' : ''}`}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** A.4 skeleton that preserves module geometry (§9 LOADING — never a spinner
 *  over an empty page, never a collapsed module). */
export function LwSkeleton({ height, delay }: { height: number; delay?: 2 | 3 }) {
  return (
    <span
      className={`lw-skel${delay ? ` lw-skel--${delay}` : ''}`}
      style={{ height, width: '100%' }}
      aria-hidden="true"
    />
  );
}
