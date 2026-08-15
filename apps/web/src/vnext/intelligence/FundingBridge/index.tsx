import type { ReactNode } from 'react';
import { VisualizationBoundary } from '../VisualizationBoundary.js';
export function FundingBridge({ children }: { children?: ReactNode }) {
  return <VisualizationBoundary label="Request to current funding bridge">{children}</VisualizationBoundary>;
}
