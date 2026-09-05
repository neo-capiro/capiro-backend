import type { ReactNode } from 'react';
import { cn } from './cn.js';

// Handover §5.1: "Kind, status, count, group pills → Badge (color='gray' |
// 'brand' | 'success' | 'warning', size='sm')." §2: "A tinted badge or a 2px
// rail, never both saying the same thing" — this component only ever
// renders the tint; callers are responsible for not layering a rail too.
type Color = 'gray' | 'brand' | 'success' | 'warning';

const COLOR_CLASS: Record<Color, string> = {
  gray: 'bg-neutral-bg text-neutral-ink',
  brand: 'bg-accent-tint text-accent-ink',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning-heading',
};

interface Props {
  color?: Color;
  /** Kind badges (handover §3) are mono, uppercase, letter-spaced. */
  mono?: boolean;
  children: ReactNode;
  className?: string;
}

export function Badge({ color = 'gray', mono = false, children, className = '' }: Props) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 font-medium',
        mono ? 'font-mono text-[10px] tracking-[0.06em] uppercase' : 'text-xs',
        COLOR_CLASS[color],
        className,
      )}
    >
      {children}
    </span>
  );
}
