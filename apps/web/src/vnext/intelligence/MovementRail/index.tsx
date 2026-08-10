import type { ReactNode } from 'react';
import { VisualizationBoundary } from '../VisualizationBoundary.js';
export function MovementRail({ children }: { children?: ReactNode }) {
  return <VisualizationBoundary label="Movement rail">{children}</VisualizationBoundary>;
}
