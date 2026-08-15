import type { ReactNode } from 'react';
import { VisualizationBoundary } from '../VisualizationBoundary.js';
export function CongressionalPath({ children }: { children?: ReactNode }) {
  return <VisualizationBoundary label="Congressional path">{children}</VisualizationBoundary>;
}
