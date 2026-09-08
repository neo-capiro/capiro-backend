import { computeStrategyHealth, hasLinkedStrategyEvidence } from '@capiro/strategy-verifier';
import type { ReportHealth, ReportNode } from './report.types.js';

/** Same policy as the editor, applied after audience and evidence filtering. */
export function computeReportHealth(nodes: readonly ReportNode[], asOf: Date): ReportHealth {
  return computeStrategyHealth(nodes.map((node) => ({
    ...node,
    hasLinkedEvidence: node.sources.some((source) => source.resolved === true) || hasLinkedStrategyEvidence(node.sources),
  })), asOf);
}
