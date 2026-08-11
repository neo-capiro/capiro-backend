import type { ReactNode } from 'react';
import { VisualizationBoundary } from '../VisualizationBoundary.js';

export function FundingTrajectory({ children }: { children?: ReactNode }) {
  return <VisualizationBoundary label="Funding trajectory">{children}</VisualizationBoundary>;
}
