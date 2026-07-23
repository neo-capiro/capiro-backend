/**
 * Capiro-maintained GLOBAL reference baseline for the Strategy Planner's
 * Legislative + PPBE bands (REF-1). Ported from the prototype's `CONGRESS`,
 * `PPBE_LANES`, and `PPBE_NOW` (sp-data.jsx). Quarter positions are mapped to
 * real dates via the live fiscal calendar at build time (plan D2/D14).
 *
 * This is the initial baseline (seeded insert-if-empty). Firms fork it per
 * tenant via the in-app editors (SpReferenceOverride); Capiro updates the
 * global baseline via the `update-strategy-reference` ops verb (FND-8).
 */
import { currentFyWindow, qToDate } from '../fiscal/fiscal.js';

export const REFERENCE_KINDS = [
  'congress_milestone',
  'ppbe_lane_bar',
  'ppbe_current_phase',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface ReferenceRow {
  kind: ReferenceKind;
  label: string;
  fy: number | null;
  startsOn: Date | null;
  endsOn: Date | null;
  tone: string | null;
  position: number;
  active: boolean;
}

// Legislative calendar milestones (label, from-quarter, to-quarter, tone),
// repeating across two sessions. Verbatim from the prototype's CONGRESS.
const CONGRESS: Array<{ label: string; from: number; to: number; tone: string }> = [
  { label: "President's Budget", from: 1.3, to: 1.55, tone: 'ink' },
  { label: 'Budget review', from: 1.5, to: 2.0, tone: 'info' },
  { label: 'Hearings', from: 1.5, to: 2.3, tone: 'info' },
  { label: 'Member requests', from: 1.4, to: 2.05, tone: 'accent' },
  { label: 'NDAA & approps bills', from: 2.0, to: 2.6, tone: 'accent' },
  { label: 'Committee markups', from: 2.3, to: 3.0, tone: 'notable' },
  { label: 'Floor & amendments', from: 3.0, to: 3.5, tone: 'notable' },
  { label: 'Conference', from: 3.5, to: 3.9, tone: 'notable' },
  { label: 'Continuing resolution risk', from: 3.7, to: 4.05, tone: 'critical' },
  { label: 'Final bills signed', from: 4.0, to: 4.45, tone: 'success' },
  { label: "President's Budget", from: 5.3, to: 5.55, tone: 'ink' },
  { label: 'Hearings', from: 5.5, to: 6.3, tone: 'info' },
  { label: 'Member requests', from: 5.4, to: 6.05, tone: 'accent' },
  { label: 'Committee markups', from: 6.3, to: 7.0, tone: 'notable' },
  { label: 'Floor & conference', from: 7.0, to: 7.7, tone: 'notable' },
  { label: 'Final bills signed', from: 8.0, to: 8.45, tone: 'success' },
];

// PPBE lanes: one set of bars per in-flight FY (index into the 3-FY window).
// Verbatim from the prototype's PPBE_LANES.
const PPBE_LANES: Array<{ fyIndex: 0 | 1 | 2; bars: Array<{ label: string; from: number; to: number; tone: string }> }> = [
  { fyIndex: 0, bars: [{ label: 'Execution', from: 0, to: 4.45, tone: 'success' }] },
  {
    fyIndex: 1,
    bars: [
      { label: 'OSD / OMB review', from: 1.0, to: 1.8, tone: 'notable' },
      { label: "President's Budget", from: 1.8, to: 2.05, tone: 'ink' },
      { label: 'Execution', from: 4.0, to: 8.45, tone: 'success' },
    ],
  },
  {
    fyIndex: 2,
    bars: [
      { label: 'Programming / POM build', from: 2.2, to: 3.6, tone: 'accent' },
      { label: 'Budget estimate submission', from: 3.6, to: 4.6, tone: 'info' },
      { label: 'OSD / OMB review', from: 5.0, to: 5.8, tone: 'notable' },
      { label: "President's Budget", from: 5.8, to: 6.05, tone: 'ink' },
      { label: 'Execution', from: 8.0, to: 8.45, tone: 'success' },
    ],
  },
];

// Current-phase summary chips per in-flight FY. Verbatim from PPBE_NOW.
const PPBE_NOW: Array<{ fyIndex: 0 | 1 | 2; phase: string; tone: string }> = [
  { fyIndex: 0, phase: 'Execution', tone: 'success' },
  { fyIndex: 1, phase: 'OSD / OMB review', tone: 'notable' },
  { fyIndex: 2, phase: 'POM / BES build', tone: 'accent' },
];

/**
 * Materialize the baseline into DB rows, mapping quarter positions to real
 * dates against the fiscal calendar as of `now`.
 */
export function buildBaselineEntries(now: Date = new Date()): ReferenceRow[] {
  const fys = currentFyWindow(now);
  const rows: ReferenceRow[] = [];

  CONGRESS.forEach((c, i) => {
    rows.push({
      kind: 'congress_milestone',
      label: c.label,
      fy: null,
      startsOn: qToDate(c.from, now),
      endsOn: qToDate(c.to, now),
      tone: c.tone,
      position: i,
      active: true,
    });
  });

  let laneIdx = 0;
  for (const lane of PPBE_LANES) {
    for (const bar of lane.bars) {
      rows.push({
        kind: 'ppbe_lane_bar',
        label: bar.label,
        fy: fys[lane.fyIndex],
        startsOn: qToDate(bar.from, now),
        endsOn: qToDate(bar.to, now),
        tone: bar.tone,
        position: laneIdx++,
        active: true,
      });
    }
  }

  PPBE_NOW.forEach((p, i) => {
    rows.push({
      kind: 'ppbe_current_phase',
      label: p.phase,
      fy: fys[p.fyIndex],
      startsOn: null,
      endsOn: null,
      tone: p.tone,
      position: i,
      active: true,
    });
  });

  return rows;
}

/**
 * Parse + validate an external reference payload for the ops verb. Accepts a
 * JSON array of entries (dates as ISO `YYYY-MM-DD` strings or null). Throws on
 * a malformed payload rather than silently writing garbage into the baseline.
 */
export function parseReferencePayload(json: string): ReferenceRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`reference payload is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('reference payload must be a JSON array of entries');
  }
  return parsed.map((raw, i) => normalizeRow(raw, i));
}

function normalizeRow(raw: unknown, i: number): ReferenceRow {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`reference entry #${i} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== 'string' || !REFERENCE_KINDS.includes(kind as ReferenceKind)) {
    throw new Error(`reference entry #${i}: invalid kind ${JSON.stringify(kind)}`);
  }
  if (typeof r.label !== 'string' || r.label.length === 0) {
    throw new Error(`reference entry #${i}: label is required`);
  }
  if (typeof r.position !== 'number' || !Number.isInteger(r.position)) {
    throw new Error(`reference entry #${i}: position must be an integer`);
  }
  return {
    kind: kind as ReferenceKind,
    label: r.label,
    fy: r.fy == null ? null : toInt(r.fy, i, 'fy'),
    startsOn: toDate(r.startsOn, i, 'startsOn'),
    endsOn: toDate(r.endsOn, i, 'endsOn'),
    tone: r.tone == null ? null : String(r.tone),
    position: r.position,
    active: r.active == null ? true : Boolean(r.active),
  };
}

function toInt(v: unknown, i: number, field: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) {
    throw new Error(`reference entry #${i}: ${field} must be an integer`);
  }
  return n;
}

function toDate(v: unknown, i: number, field: string): Date | null {
  if (v == null) return null;
  if (typeof v !== 'string') {
    throw new Error(`reference entry #${i}: ${field} must be an ISO date string or null`);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`reference entry #${i}: ${field} is not a valid date (${v})`);
  }
  return d;
}
