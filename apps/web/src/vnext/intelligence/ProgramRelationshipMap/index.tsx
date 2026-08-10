import type { ReactNode } from 'react';
import { VisualizationBoundary } from '../VisualizationBoundary.js';
export function ProgramRelationshipMap({ children }: { children?: ReactNode }) {
  return <VisualizationBoundary label="Program relationship map">{children}</VisualizationBoundary>;
}
