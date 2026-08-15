import type { ReactNode } from 'react';
import { VisualizationBoundary } from '../VisualizationBoundary.js';
export function EvidenceCoverage({ children }: { children?: ReactNode }) {
  return <VisualizationBoundary label="Evidence coverage">{children}</VisualizationBoundary>;
}
