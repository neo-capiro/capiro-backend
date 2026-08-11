import type { ReactNode } from 'react';
import { VisualizationBoundary } from '../VisualizationBoundary.js';
export function MovementDistribution({ children }: { children?: ReactNode }) {
  return <VisualizationBoundary label="Movement distribution">{children}</VisualizationBoundary>;
}
