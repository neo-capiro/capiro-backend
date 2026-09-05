import type { ReactNode } from 'react';
import { cn } from './cn.js';

// Handover §5.2: "Card (every panel)." Plain surface + hairline + radius —
// the one container treatment (handover §2's "Surfaces" table).
export function Card({
  children,
  className = '',
  floating = false,
}: {
  children: ReactNode;
  className?: string;
  floating?: boolean;
}) {
  return (
    <div className={cn('rounded-lg border border-line-hairline bg-surface', floating && 'shadow-card', className)}>
      {children}
    </div>
  );
}
