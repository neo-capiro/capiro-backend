import { Tooltip } from 'antd';

/**
 * Intelligence chips row for the PE profile hero (product plan F1): committee
 * posture, procurement runway, acquisition maturity, anomaly flags — verdicts
 * from GET /api/program-elements/:peCode/intelligence. Chips with insufficient
 * data are simply not rendered (honest empty state = no chip, never a guess).
 */

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
  const maturityLabel = intel.maturity ? MATURITY_LABELS[intel.maturity.stage] : undefined;
  if (maturityLabel && intel.maturity) {
    chips.push(
      <Chip key="maturity" label={maturityLabel} tone="muted" tip={intel.maturity.rationale} />,
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
