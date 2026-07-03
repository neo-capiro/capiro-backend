/**
 * Transition-maturity ladder (F19): places a budget line on the 0-5
 * research → contracts ladder, with per-rung evidence sentences derived from
 * real signals only. Builds on classifyMaturity (the coarse stage classifier)
 * and the money-graph links.
 *
 *   0 Research                 RDT&E BA 1-2
 *   1 Prototype                RDT&E BA 3-4
 *   2 Development              RDT&E BA 5-8 (SDD / operational-system dev)
 *   3 Procurement line exists  PROC line itself, or an rdte_to_procurement edge
 *   4 O&M sustainment          OM line itself, or a procurement_to_om / OM edge
 *   5 Active contracts         award-evidenced (FederalAward resolved to the line)
 *
 * Pure module — no DB, no I/O. HONESTY RULE: a rung is `reached` only with a
 * stated evidence source; earlier rungs implied by a later stage say so
 * explicitly ("implied by procurement stage") rather than pretending we
 * observed them.
 */
import { classifyMaturity, parseBudgetActivity } from './acquisition-maturity.js';

export interface MaturityLadderInput {
  /** 'RDT&E' | 'PROC' | 'OM' | null. */
  appropriationType: string | null;
  /** Raw budget_activity string as stored. */
  budgetActivity: string | null;
  /** The line has an accepted rdte_to_procurement / procurement edge. */
  hasProcurementLink: boolean;
  /** The line has an accepted O&M edge. */
  hasOmLink: boolean;
  /** FederalAward rows resolved to this line (award evidence). */
  awardCount: number;
}

export interface MaturityRung {
  n: number;
  label: string;
  reached: boolean;
  evidence: string;
}

export interface MaturityLadder {
  /** Highest reached rung, 0-5. */
  current: number;
  rungs: MaturityRung[];
}

const RUNG_LABELS = [
  'Research',
  'Prototype',
  'Development',
  'Procurement line exists',
  'O&M sustainment',
  'Active contracts',
] as const;

/**
 * Returns null when the line is not placeable on the ladder at all (no
 * appropriation type and no links) — the UI renders "Not applicable".
 */
export function buildMaturityLadder(input: MaturityLadderInput): MaturityLadder | null {
  const stage = classifyMaturity({
    appropriationType: input.appropriationType,
    budgetActivity: input.budgetActivity,
    hasProcurementLink: input.hasProcurementLink,
    hasOmLink: input.hasOmLink,
  });
  const t = (input.appropriationType ?? '').toUpperCase();
  const ba = parseBudgetActivity(input.budgetActivity);

  if (stage.stage === 'unknown' && !input.hasProcurementLink && !input.hasOmLink && input.awardCount === 0) {
    return null;
  }

  // Which development rung does the line's own appropriation evidence?
  // RDT&E BA1-2 → 0, BA3-4 → 1, BA5+ → 2. PROC/OM lines evidence rungs 3/4
  // directly; their development history is implied, not observed.
  let ownRung: number | null = null;
  let ownEvidence = '';
  if (t === 'RDT&E' || t.startsWith('RDT')) {
    if (ba === null) {
      ownRung = 0;
      ownEvidence = 'RDT&E line (budget activity not stated).';
    } else if (ba <= 2) {
      ownRung = 0;
      ownEvidence = `BA ${ba} — basic/applied research.`;
    } else if (ba <= 4) {
      ownRung = 1;
      ownEvidence = `BA ${ba} — advanced technology development / prototyping.`;
    } else {
      ownRung = 2;
      ownEvidence = `BA ${ba} — system development for a program of record.`;
    }
  }

  const procReached = t === 'PROC' || input.hasProcurementLink;
  const omReached = t === 'OM' || input.hasOmLink;
  const awardReached = input.awardCount > 0;

  const current = awardReached ? 5 : omReached ? 4 : procReached ? 3 : (ownRung ?? 0);

  const rungs: MaturityRung[] = RUNG_LABELS.map((label, n) => {
    let reached = false;
    let evidence = 'Not yet reached';
    if (n <= 2) {
      if (ownRung !== null && n < ownRung) {
        reached = true;
        evidence = `Preceded this line's stage (${ownEvidence.replace(/\.$/, '')}).`;
      } else if (ownRung !== null && n === ownRung) {
        reached = true;
        evidence = ownEvidence;
      } else if (ownRung !== null && n > ownRung && current > 2) {
        reached = true;
        evidence = 'Implied by the later stage this line has reached.';
      } else if (ownRung === null && current >= 3) {
        reached = true;
        evidence = `Implied by ${t === 'PROC' ? 'procurement' : t === 'OM' ? 'sustainment' : 'a later'} stage — development history not directly observed.`;
      }
    } else if (n === 3) {
      reached = procReached;
      evidence = procReached
        ? t === 'PROC'
          ? 'This line IS a procurement line item.'
          : 'Linked procurement line (accepted rdte_to_procurement edge).'
        : 'No procurement line linked yet.';
    } else if (n === 4) {
      reached = omReached;
      evidence = omReached
        ? t === 'OM'
          ? 'This line IS an O&M sustainment line.'
          : 'Linked O&M sustainment line (accepted edge).'
        : 'No O&M sustainment line linked yet.';
    } else {
      reached = awardReached;
      evidence = awardReached
        ? `${input.awardCount} award${input.awardCount === 1 ? '' : 's'} resolved to this line (USAspending).`
        : 'No award evidence resolved to this line yet.';
    }
    return { n, label, reached, evidence };
  });

  return { current, rungs };
}
