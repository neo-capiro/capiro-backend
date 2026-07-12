// Program Element → curated context item mapping (plan W5.4). Pure (no React /
// network / env), so it's importable by both StepContext (search tab) and the
// wizard (watched-PE seed) AND unit-testable. Funding figures use the finder
// list endpoint's canonical-current precedence (in $M).
//
// RC1: this `body` is the SEED the client sends server-side; the outreach
// enrichment replaces it with the authoritative multi-FY truth block when the
// PE is on record. But as defense-in-depth (any path that skips enrichment),
// the seed itself must never be direction-ambiguous — so it leads with the
// request, tags the current figure's stage + authorization/appropriations
// vehicle, and only states a direction vs the request when both share a fiscal
// year (the finder derives request and current from independent latest-FY
// lookups). This kills the "$112.9M current / $72.1M request read as a cut".

import {
  FUNDING_STAGE_LABEL,
  FUNDING_STAGE_VEHICLE,
  FUNDING_VEHICLE_ADJECTIVE,
  describeDeltaVsRequest,
  type FundingStage,
} from '@capiro/shared';
import { fmtMoneyM } from '../../../program-element/charts/format.js';
import type { ProgramElementListItem } from '../../../program-element/types.js';
import type { ContextPoolItem } from './types.js';

const fy2 = (fy: number | null | undefined): string => (fy ? `FY${String(fy).slice(-2)}` : '');

/**
 * Render a Program Element into a curated context item. `body` is what PromptSpec
 * v2 drops into the CURATED CONTEXT block (so a PE-Brief draft can cite real FY
 * figures instead of the honest-gap fallback); `sub` is the compact list line.
 */
export function peToPoolItem(pe: ProgramElementListItem): ContextPoolItem {
  const rawStage = (pe.latestCurrentStage ?? 'none') as FundingStage;
  const stage: FundingStage = rawStage in FUNDING_STAGE_VEHICLE ? rawStage : 'none';
  const stageLabel = stage !== 'none' ? FUNDING_STAGE_LABEL[stage] : '';
  const vehicle = FUNDING_VEHICLE_ADJECTIVE[FUNDING_STAGE_VEHICLE[stage]];
  const curFy = fy2(pe.latestCurrentFy);
  const reqFy = fy2(pe.latestRequestFy);

  const sameFy =
    pe.latestCurrent != null &&
    pe.latestRequest != null &&
    pe.latestCurrentFy != null &&
    pe.latestCurrentFy === pe.latestRequestFy &&
    stage !== 'request';
  const direction = sameFy
    ? `; ${describeDeltaVsRequest(pe.latestCurrent! - pe.latestRequest!)}`
    : '';

  const sub = [fmtMoneyM(pe.latestCurrent), curFy, stageLabel].filter(Boolean).join(' · ');

  const currentParen =
    [curFy, stageLabel ? (vehicle ? `${stageLabel} — ${vehicle}` : stageLabel) : '']
      .filter(Boolean)
      .join(', ') || '';
  const body = [
    pe.latestRequest != null
      ? `President's request: ${fmtMoneyM(pe.latestRequest)}${reqFy ? ` (${reqFy})` : ''}`
      : null,
    pe.latestCurrent != null
      ? `Current position: ${fmtMoneyM(pe.latestCurrent)}${currentParen ? ` (${currentParen})` : ''}${direction}`
      : null,
    [
      pe.service ? `Service: ${pe.service}` : null,
      pe.budgetActivity ? `Budget Activity: ${pe.budgetActivity}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || null,
    'Latest figures on record; for the full request / HASC / SASC / HAC-D / SAC-D / enacted breakdown by chamber, ask Meri or open the PE timeline.',
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
