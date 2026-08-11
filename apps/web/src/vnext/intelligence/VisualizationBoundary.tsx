import type { ReactNode } from 'react';
import { CapiroSurface } from '../components/Surface.js';

/**
 * Stable no-data presentation boundary for future intelligence visualizations.
 * Foundation components take rendered children only; data loading/normalization
 * stays in existing domain hooks or explicit adapters when a screen is built.
 */
export function VisualizationBoundary({
  label,
  children,
  className = '',
}: {
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <CapiroSurface
      elevated
      className={className}
      aria-label={label}
      style={{ minHeight: 120, padding: 16 }}
    >
      {children}
    </CapiroSurface>
  );
}
