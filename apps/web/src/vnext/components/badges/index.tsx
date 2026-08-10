import type { HTMLAttributes, ReactNode } from 'react';

export type CapiroBadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface CapiroBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: CapiroBadgeTone;
  dot?: ReactNode;
}

export function CapiroBadge({ tone = 'neutral', dot, className = '', children, ...props }: CapiroBadgeProps) {
  return (
    <span
      className={`capiro-badge${tone === 'neutral' ? '' : ` capiro-badge--${tone}`} ${className}`.trim()}
      {...props}
    >
      {dot}
      {children}
    </span>
  );
}
