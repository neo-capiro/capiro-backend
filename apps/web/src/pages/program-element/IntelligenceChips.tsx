import { Tooltip } from 'antd';

/**
 * Intelligence chips row for the PE profile hero (product plan F1): committee
 * posture, procurement runway, acquisition maturity, anomaly flags — verdicts
 * from GET /api/program-elements/:peCode/intelligence. Chips with insufficient
 * data are simply not rendered (honest empty state = no chip, never a guess).
 */

import type { AppropriabilityData, MaturityLadderData } from './types.js';

export interface PeIntelligence {
  budgetYearFy: number | null;
  posture: {
    posture: string;
    action: string;
    rationale: string;
  } | null;
  runway: {
    runway: string;
    cagr: number | null;
    rationale: string;
  } | null;
  maturity: {
    stage: string;
    hasBuyLine: boolean;
    rationale: string;
  };
  anomalies: Array<{ type: string; severity: number; sentence: string }>;
  // ── BL-2 graph-aware verdicts (from the derive-time cache; null until the
  //    first derive-intelligence-cache run) ──
  lineType?: string | null;
  maturityLadder?: MaturityLadderData | null;
  appropriability?: AppropriabilityData | null;
  valleyOfDeath?: boolean;
  cacheComputedAt?: string | null;
}

const POSTURE_LABELS: Record<string, { label: string; tone: string }> = {
  restoration_opportunity: { label: 'Restoration opportunity', tone: 'warn' },
  cut_risk: { label: 'Cut risk', tone: 'critical' },
  conference_target: { label: 'Conference target', tone: 'warn' },
  appropriations_target: { label: 'Appropriations target', tone: 'warn' },
  plus_up_defense: { label: 'Defend the add', tone: 'success' },
  aligned: { label: 'Marks aligned', tone: 'muted' },
};

const RUNWAY_LABELS: Record<string, { label: string; tone: string }> = {
  ramping: { label: 'Ramping', tone: 'success' },
  flat: { label: 'Flat funding', tone: 'muted' },
  declining: { label: 'Declining', tone: 'warn' },
  zeroed: { label: 'Zeroed', tone: 'critical' },
  cliff: { label: 'Funding cliff', tone: 'critical' },
  one_year_plus_up: { label: 'One-year plus-up', tone: 'warn' },
  new_start: { label: 'New start', tone: 'success' },
};

const MATURITY_LABELS: Record<string, string> = {
  early_rnd: 'Early R&D',
  prototype: 'Prototype',
  system_development: 'System development',
  support_fielded: 'Fielded / support',
  procurement: 'Procurement',
  sustainment: 'Sustainment',
};

function Chip({ label, tone, tip }: { label: string; tone: string; tip: string }) {
  // Reuse the page's existing pill palette (success/critical/muted) so severity
  // reads without new CSS; 'warn' falls back to the neutral pe-tag treatment.
  const cls =
    tone === 'critical' || tone === 'success'
      ? `pill ${tone} pe-intel-chip`
      : `pe-tag pe-intel-chip pe-intel-${tone}`;
  return (
    <Tooltip title={tip}>
      <span className={cls} data-testid="pe-intel-chip">
        {label}
      </span>
    </Tooltip>
  );
}

export function IntelligenceChips({ intel }: { intel: PeIntelligence | null | undefined }) {
  if (!intel) return null;
  const chips: JSX.Element[] = [];

  const posture = intel.posture && POSTURE_LABELS[intel.posture.posture];
  if (posture && intel.posture) {
    chips.push(
      <Chip key="posture" label={posture.label} tone={posture.tone} tip={intel.posture.rationale} />,
    );
  }
  const runway = intel.runway && RUNWAY_LABELS[intel.runway.runway];
  if (runway && intel.runway) {
    chips.push(
      <Chip key="runway" label={runway.label} tone={runway.tone} tip={intel.runway.rationale} />,
    );
  }
  // Prefer the graph-aware 0-5 ladder chip when the derive cache has run;
  // fall back to the coarse stage label meanwhile.
  const ladder = intel.maturityLadder;
  if (ladder && Array.isArray(ladder.rungs) && ladder.rungs.length > 0) {
    chips.push(
      <Chip
        key="maturity"
        label={`Maturity ${ladder.current}/5`}
        tone="muted"
        tip={ladder.rungs[ladder.current]?.evidence ?? intel.maturity?.rationale ?? ''}
      />,
    );
  } else {
    const maturityLabel = intel.maturity ? MATURITY_LABELS[intel.maturity.stage] : undefined;
    if (maturityLabel && intel.maturity) {
      chips.push(
        <Chip key="maturity" label={maturityLabel} tone="muted" tip={intel.maturity.rationale} />,
      );
    }
  }
  const approp = intel.appropriability;
  if (approp && approp.score != null && approp.tier) {
    chips.push(
      <Chip
        key="approp"
        label={`Appropriability ${approp.tier === 'high' ? 'High' : approp.tier === 'med' ? 'Medium' : 'Low'} · ${approp.score}`}
        tone={approp.tier === 'high' ? 'success' : approp.tier === 'low' ? 'critical' : 'warn'}
        tip={approp.reason}
      />,
    );
  }
  if (intel.valleyOfDeath) {
    chips.push(
      <Chip
        key="vod"
        label="Valley-of-death risk"
        tone="critical"
        tip="RDT&E money with no linked procurement line, no O&M sustainment, and no award evidence — development with no visible path to a buy."
      />,
    );
  }
  for (const a of (intel.anomalies ?? []).slice(0, 3)) {
    chips.push(
      <Chip
        key={`anomaly-${a.type}`}
        label="Anomaly"
        tone={a.severity >= 3 ? 'critical' : 'warn'}
        tip={a.sentence}
      />,
    );
  }
  if (chips.length === 0) return null;
  return (
    <div className="pe-hero-tags pe-intel-chips" data-testid="pe-intel-chips">
      {chips}
    </div>
  );
}
