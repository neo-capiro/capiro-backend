/**
 * Program Elements v2 — shared model helpers.
 *
 * Every value rendered in the v2 workspace derives from the same API reads the
 * legacy PE pages use (program-element/api.ts, funding-model.ts). No mock data,
 * no invented state: where the API has no figure the UI says so explicitly
 * (NOT FILED / PENDING / NOT ENACTED …) per the v2 refinement-notes contract.
 */
import type {
  FundingPoint,
} from '../funding-model.js';
import type {
  ProgramElementDetail,
  ProgramElementListItem,
} from '../types.js';
import { fmtMoneyM } from '../charts/index.js';

// ── Money / percent formatting (mockup: $1,796.1M grouped, signed deltas) ────

export function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}B`;
  return `$${v.toFixed(1)}M`;
}

export function sgn(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(v).toFixed(1)}M`;
}

export function spct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(1)}%`;
}

export { fmtMoneyM };

// ── Stage vocabulary ─────────────────────────────────────────────────────────

/** v2 stage ids, in mockup order. `conf` = appropriations conference; ndaa = auth conference. */
export type V2StageId =
  | 'request'
  | 'hasc'
  | 'sasc'
  | 'ndaaConf'
  | 'hacd'
  | 'sacd'
  | 'conf'
  | 'enacted';

export const V2_STAGE_LABEL: Record<V2StageId, string> = {
  request: 'REQUEST',
  hasc: 'HASC',
  sasc: 'SASC',
  ndaaConf: 'NDAA CONF.',
  hacd: 'HAC-D',
  sacd: 'SAC-D',
  conf: 'APPROPS CONF.',
  enacted: 'ENACTED',
};

export const AUTH_LADDER: V2StageId[] = ['request', 'hasc', 'sasc', 'ndaaConf'];
export const APPR_LADDER: V2StageId[] = ['request', 'hacd', 'sacd', 'conf', 'enacted'];

const STAGE_SUB: Record<V2StageId, string> = {
  request: "President's Budget",
  hasc: 'House authorization',
  sasc: 'Senate authorization',
  ndaaConf: 'Authorization conference',
  hacd: 'House appropriations mark',
  sacd: 'Senate appropriations mark',
  conf: 'Appropriations conference',
  enacted: 'Enacted appropriation',
};

export function stageSub(id: V2StageId): string {
  return STAGE_SUB[id];
}

// ── Evidence state ───────────────────────────────────────────────────────────

export type EvState =
  | 'VERIFIED'
  | 'PARTIAL'
  | 'PENDING'
  | 'CONFLICT'
  | 'REVIEW REQUIRED'
  | 'ABSENT';

export function evMarkClass(state: EvState): string {
  switch (state) {
    case 'VERIFIED':
      return 'verified';
    case 'PARTIAL':
      return 'partial';
    case 'PENDING':
      return 'pending';
    case 'CONFLICT':
      return 'conflict';
    case 'REVIEW REQUIRED':
      return 'review';
    default:
      return 'absent';
  }
}

// ── Per-FY stage cell ────────────────────────────────────────────────────────

export interface V2StageCell {
  stage: V2StageId;
  label: string;
  sub: string;
  value: number | null;
  /** Signed delta vs the request for the same FY, when both exist. */
  delta: number | null;
  /** Absent-reason word when value is null (never a coerced zero). */
  stateWord: string;
  ev: EvState;
}

function stageValue(fp: FundingPoint, stage: V2StageId): number | null {
  switch (stage) {
    case 'request':
      return fp.request;
    case 'hasc':
      return fp.hascMark;
    case 'sasc':
      return fp.sascMark;
    case 'ndaaConf':
      return fp.ndaaConference;
    case 'hacd':
      return fp.hacDMark;
    case 'sacd':
      return fp.sacDMark;
    case 'conf':
      return fp.conference;
    case 'enacted':
      return fp.enacted;
  }
}

/** Build one ladder track for a fiscal year. Later stages absent ⇒ explicit state. */
export function ladderCells(fp: FundingPoint, track: 'auth' | 'appr'): V2StageCell[] {
  const ids = track === 'auth' ? AUTH_LADDER : APPR_LADDER;
  const request = fp.request;
  return ids.map((id) => {
    const value = stageValue(fp, id);
    const delta = value != null && request != null && id !== 'request' ? value - request : null;
    let stateWord = '';
    let ev: EvState = 'VERIFIED';
    if (value == null) {
      if (id === 'enacted') stateWord = 'NOT ENACTED';
      else if (id === 'conf' || id === 'ndaaConf') stateWord = 'NOT FILED';
      else if (id === 'request') stateWord = 'NOT FILED';
      else stateWord = 'NOT FILED';
      ev = 'ABSENT';
    }
    return {
      stage: id,
      label: V2_STAGE_LABEL[id],
      sub: STAGE_SUB[id],
      value,
      delta,
      stateWord,
      ev,
    };
  });
}

/**
 * The stage the line's "current" figure came from, mapped onto the v2 ladder id.
 * Uses the canonical precedence pick already computed by funding-model.
 */
export function currentStageId(fp: FundingPoint | undefined | null): V2StageId | null {
  if (!fp) return null;
  switch (fp.current.stage) {
    case 'enacted':
      return 'enacted';
    case 'conference':
      return 'conf';
    case 'sacd':
      return 'sacd';
    case 'hacd':
      return 'hacd';
    case 'sasc':
      return 'sasc';
    case 'hasc':
      return 'hasc';
    case 'request':
      return 'request';
    default:
      return null;
  }
}

// ── List-row derivation (Explore / Portfolio) ───────────────────────────────

export interface V2LineRow {
  code: string;
  title: string;
  service: string | null;
  lineType: string | null;
  budgetActivity: string | null;
  request: number | null;
  requestFy: number | null;
  current: number | null;
  currentFy: number | null;
  currentStage: string | null;
  /** Delta vs request, $M — only when current and request share an FY. */
  delta: number | null;
  /** Percent vs request (paired FY only — never cross-FY). */
  pct: number | null;
  spark: number[];
  watched: boolean;
  signalType: string | null;
  signalDeltaPct: number | null;
  actionSignalType: string | null;
  billCount: number | null;
}

export function toLineRow(item: ProgramElementListItem): V2LineRow {
  const request = item.latestRequest ?? null;
  const current = item.latestCurrent ?? null;
  const sameFy =
    item.latestCurrentFy != null &&
    item.latestRequestFy != null &&
    item.latestCurrentFy === item.latestRequestFy;
  const delta = sameFy && current != null && request != null ? current - request : null;
  const pct =
    sameFy && current != null && request != null && request !== 0
      ? ((current - request) / Math.abs(request)) * 100
      : (item.deltaPct ?? null);
  return {
    code: item.peCode,
    title: item.title,
    service: item.service,
    lineType: item.lineType ?? item.appropriationType,
    budgetActivity: item.budgetActivity,
    request,
    requestFy: item.latestRequestFy ?? null,
    current,
    currentFy: item.latestCurrentFy ?? null,
    currentStage: item.latestCurrentStage ?? null,
    delta,
    pct,
    spark: Array.isArray(item.spark) ? item.spark.filter((v): v is number => typeof v === 'number') : [],
    watched: item.watched ?? false,
    signalType: item.signalType ?? null,
    signalDeltaPct: item.signalDeltaPct ?? null,
    actionSignalType: item.actionSignalType ?? null,
    billCount: item.billCount ?? null,
  };
}

/** Recommended-action word for a line — derived from its live signals, never invented. */
export function recommendedAction(row: V2LineRow): string {
  if (row.actionSignalType === 'cut') return 'Protect funding';
  if (row.actionSignalType === 'termination') return 'Protect funding';
  if (row.actionSignalType === 'add') return 'Sustain increase';
  if (row.actionSignalType === 'new_start') return 'Review new start';
  if (row.delta != null && row.delta < 0) return 'Protect funding';
  if (row.delta != null && row.delta > 0) return 'Sustain increase';
  return 'Monitor enactment';
}

/** Current-stage label as the mockup prints it (PB for request-only lines). */
export function stageLabelShort(stage: string | null): string {
  if (!stage) return 'PB';
  const s = stage.toUpperCase().replaceAll('_', '-');
  if (s === 'REQUEST' || s === 'PB') return 'PB';
  if (s === 'CONFERENCE') return 'CONF';
  return s;
}

/** BudgetDeltaRail geometry — refinement notes §07 DELTA RAIL. */
export function railGeometry(pct: number | null): {
  kind: 'bar' | 'none' | 'nopos';
  style?: Record<string, string | number>;
} {
  if (pct == null) {
    return {
      kind: 'nopos',
      style: {
        position: 'absolute',
        left: 'calc(50% - 10px)',
        top: 3,
        width: 20,
        height: 6,
        border: '1px dashed #8A6218',
      },
    };
  }
  if (pct === 0) return { kind: 'none' };
  const w = Math.max(6, Math.round(Math.min(1, Math.abs(pct) / 15) * 58));
  return pct < 0
    ? {
        kind: 'bar',
        style: {
          position: 'absolute',
          right: '50%',
          top: 3,
          height: 6,
          width: w,
          background: '#131A24',
        },
      }
    : {
        kind: 'bar',
        style: {
          position: 'absolute',
          left: '50%',
          top: 3,
          height: 6,
          width: w,
          background: '#2F6B4F',
        },
      };
}

/** Row sparkline — 72×18 viewBox, 1px #B6BFCC polyline, 3px ink square on final point. */
export function sparkGeometry(data: number[]): {
  points: string;
  endX: number;
  endY: number;
  label: string;
} | null {
  if (!data || data.length < 2) return null;
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const span = mx - mn || 1;
  const pts = data.map((v, i) => {
    const x = Math.round(i * (70 / (data.length - 1)));
    const y = Math.round(15 - ((v - mn) / span) * 12);
    return [x, y] as const;
  });
  const last = pts[pts.length - 1]!;
  return {
    points: pts.map((p) => `${p[0]},${p[1]}`).join(' '),
    endX: last[0] - (pts.length > 1 ? 2 : 0),
    endY: last[1] - 1.5,
    label: '',
  };
}

/** History series for the profile FY bar chart / sparkline, with stage kinds. */
export interface V2HistPoint {
  fy: string;
  value: number;
  kind: 'enacted' | 'request' | 'current' | 'fydp';
}

export function historySeries(detail: ProgramElementDetail, funding: FundingPoint[]): V2HistPoint[] {
  const out: V2HistPoint[] = [];
  const sorted = [...funding].sort((a, b) => a.fy - b.fy);
  for (const fp of sorted) {
    if (fp.enacted != null) {
      out.push({ fy: `FY${String(fp.fy).slice(-2)}`, value: fp.enacted, kind: 'enacted' });
    } else if (fp.current.value != null && fp.current.stage !== 'request') {
      out.push({ fy: `FY${String(fp.fy).slice(-2)} CUR`, value: fp.current.value, kind: 'current' });
    } else if (fp.request != null) {
      out.push({ fy: `FY${String(fp.fy).slice(-2)} REQ`, value: fp.request, kind: 'request' });
    }
  }
  return out;
}
