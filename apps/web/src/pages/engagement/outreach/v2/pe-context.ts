// Program Element → curated context item mapping (plan W5.4). Pure (no React /
// network / env), so it's importable by both StepContext (search tab) and the
// wizard (watched-PE seed) AND unit-testable. Funding figures use the finder
// list endpoint's canonical-current precedence (in $M).

import { fmtMoneyM } from '../../../program-element/charts/format.js';
import type { ProgramElementListItem } from '../../../program-element/types.js';
import type { ContextPoolItem } from './types.js';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const fy2 = (fy: number | null | undefined): string => (fy ? `FY${String(fy).slice(-2)}` : '');

/**
 * Render a Program Element into a curated context item. `body` is what PromptSpec
 * v2 drops into the CURATED CONTEXT block (so a PE-Brief draft can cite real FY
 * figures instead of the honest-gap fallback); `sub` is the compact list line.
 */
export function peToPoolItem(pe: ProgramElementListItem): ContextPoolItem {
  const fy = fy2(pe.latestCurrentFy);
  const stage =
    pe.latestCurrentStage && pe.latestCurrentStage !== 'none' ? cap(pe.latestCurrentStage) : '';
  const sub = [fmtMoneyM(pe.latestCurrent), fy, stage].filter(Boolean).join(' · ');
  const body = [
    `Current: ${fmtMoneyM(pe.latestCurrent)}${fy ? ` (${fy}${stage ? ` · ${stage}` : ''})` : ''}`,
    pe.latestRequest != null
      ? `Request: ${fmtMoneyM(pe.latestRequest)}${pe.latestRequestFy ? ` (${fy2(pe.latestRequestFy)})` : ''}`
      : null,
    [
      pe.service ? `Service: ${pe.service}` : null,
      pe.budgetActivity ? `Budget Activity: ${pe.budgetActivity}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || null,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    id: `pe-${pe.peCode}`,
    kind: 'programElement',
    title: `${pe.peCode} — ${pe.title}`,
    body,
    tag: pe.service ?? undefined,
    sub: sub || undefined,
  };
}
