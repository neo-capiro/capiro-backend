/**
 * Strategies module — visual harness fixtures.
 *
 * Shapes mirror the real DTOs (`pages/strategy/types.ts`) and the
 * `strategies-api.ts` query hooks exactly, so `StrategyLibraryVNext` renders
 * as it would against a live tenant. One strategy carries a pending watcher
 * count so the "Needs review" stat's attention-ring modifier
 * (STRATEGIES-UI-PARITY.md #2) is actually exercised, not just present.
 */
import type {
  FirmPhase,
  ReferenceCalendars,
  ReferenceRow,
  StrategyDetail,
  StrategyListItem,
  StrategyNode,
} from '../../../pages/strategy/types.js';
import type { ClientLite, TenantMember } from '../../pages/strategies/strategies-api.js';

export const STRATEGIES_VISUAL_CLIENTS: ClientLite[] = [
  { id: 'client-1', name: 'Meridian Health Systems' },
  { id: 'client-2', name: 'Alpine Defense Partners' },
];

export const STRATEGIES_VISUAL_MEMBERS: TenantMember[] = [
  { id: 'member-1', clerkUserId: 'user_1', email: 'schen@capiro.ai', name: 'Sarah Chen' },
  { id: 'member-2', clerkUserId: 'user_2', email: 'mwebb@capiro.ai', name: 'Marcus Webb' },
];

export const STRATEGIES_VISUAL_FIRM_PHASES: FirmPhase[] = [
  { id: 'phase-1', label: 'Firm growth phase', startFy: 2027, startQ: 1, endFy: 2029, endQ: 4, position: 0 },
];

export const STRATEGIES_VISUAL_LIST: StrategyListItem[] = [
  {
    id: 'strategy-1',
    clientId: 'client-1',
    title: 'FY27 Appropriations Ask — Rural Health Expansion',
    type: 'appropriations',
    ownerUserId: 'user_1',
    createdByUserId: 'user_1',
    lastEditedByUserId: 'user_1',
    lastEditedAt: '2026-08-15T18:30:00.000Z',
    createdAt: '2026-05-01T12:00:00.000Z',
    nodeCount: 14,
  },
  {
    id: 'strategy-2',
    clientId: 'client-2',
    title: 'NDAA Procurement Pathway',
    type: 'procurement',
    ownerUserId: 'user_2',
    createdByUserId: 'user_2',
    lastEditedByUserId: 'user_2',
    lastEditedAt: '2026-08-10T09:15:00.000Z',
    createdAt: '2026-04-12T12:00:00.000Z',
    nodeCount: 9,
  },
  {
    id: 'strategy-3',
    clientId: 'client-1',
    title: 'Regulatory Comment Coalition — CMS Rule',
    type: 'regulatory',
    ownerUserId: 'user_1',
    createdByUserId: 'user_1',
    lastEditedByUserId: null,
    lastEditedAt: null,
    createdAt: '2026-02-20T12:00:00.000Z',
    nodeCount: 6,
  },
];

/** One pending watcher proposal on strategy-1 — needsReview resolves to 1, > 0. */
export const STRATEGIES_VISUAL_PENDING_WATCH_COUNTS: Record<string, number> = {
  'strategy-1': 1,
};

/** Same data, nothing pending — the "Needs review" card's plain (non-attention) state. */
export const STRATEGIES_VISUAL_NO_PENDING_WATCH_COUNTS: Record<string, number> = {};

/* ─────────────────────────── Strategy editor fixtures ───────────────────────
 *
 * Transcribed from what capiro-dev actually serves (read 2026-08-19 through
 * the authenticated /strategy-api routes), not invented: the seeded firm
 * phases, the global legislative baseline, the PPBE lanes, and the RTX plan's
 * own thirteen steps. Every date is anchored on FY2026 because api-strategy
 * generates them against `currentFyWindow()` — which is exactly the window the
 * editor axis has to match.
 * ────────────────────────────────────────────────────────────────────────── */

export const STRATEGIES_VISUAL_EDITOR_FIRM_PHASES: FirmPhase[] = [
  { id: 'fp-1', label: 'Strategy refresh', startFy: 2026, startQ: 1, endFy: 2026, endQ: 2, position: 0 },
  { id: 'fp-2', label: 'Submit asks & white papers', startFy: 2026, startQ: 2, endFy: 2026, endQ: 3, position: 1 },
  { id: 'fp-3', label: 'Refine post-budget', startFy: 2026, startQ: 3, endFy: 2026, endQ: 4, position: 2 },
  { id: 'fp-4', label: 'Markup support', startFy: 2026, startQ: 4, endFy: 2027, endQ: 1, position: 3 },
  { id: 'fp-5', label: 'Outcomes & roll forward', startFy: 2027, startQ: 1, endFy: 2027, endQ: 2, position: 4 },
  { id: 'fp-6', label: 'Next-cycle strategy refresh', startFy: 2027, startQ: 2, endFy: 2027, endQ: 3, position: 5 },
  { id: 'fp-7', label: 'Submit asks & white papers', startFy: 2027, startQ: 3, endFy: 2028, endQ: 1, position: 6 },
];

const congressRow = (
  position: number,
  label: string,
  startsOn: string,
  endsOn: string,
  tone: string,
): ReferenceRow => ({
  id: `cg-${position}`,
  kind: 'congress_milestone',
  label,
  fy: null,
  startsOn,
  endsOn,
  tone,
  position,
});

export const STRATEGIES_VISUAL_CONGRESS: ReferenceRow[] = [
  congressRow(0, "President's Budget", '2026-01-29', '2026-02-19', 'ink'),
  congressRow(1, 'Budget review', '2026-02-15', '2026-04-01', 'info'),
  congressRow(2, 'Hearings', '2026-02-15', '2026-04-28', 'info'),
  congressRow(3, 'Member requests', '2026-02-07', '2026-04-05', 'accent'),
  congressRow(4, 'NDAA & approps bills', '2026-04-01', '2026-05-26', 'accent'),
  congressRow(5, 'Committee markups', '2026-04-28', '2026-07-01', 'notable'),
  congressRow(6, 'Floor & amendments', '2026-07-01', '2026-08-17', 'notable'),
  congressRow(7, 'Conference', '2026-08-17', '2026-09-22', 'notable'),
  congressRow(8, 'Continuing resolution risk', '2026-09-04', '2026-10-06', 'critical'),
  congressRow(9, 'Final bills signed', '2026-10-01', '2026-11-12', 'success'),
  congressRow(10, "President's Budget", '2027-01-29', '2027-02-19', 'ink'),
  congressRow(11, 'Hearings', '2027-02-15', '2027-04-28', 'info'),
  congressRow(12, 'Member requests', '2027-02-07', '2027-04-05', 'accent'),
  congressRow(13, 'Committee markups', '2027-04-28', '2027-07-01', 'notable'),
  congressRow(14, 'Floor & conference', '2027-07-01', '2027-09-04', 'notable'),
  congressRow(15, 'Final bills signed', '2027-10-01', '2027-11-11', 'success'),
];

const ppbeRow = (
  position: number,
  fy: number,
  label: string,
  startsOn: string,
  endsOn: string,
  tone: string,
): ReferenceRow => ({
  id: `pp-${position}`,
  kind: 'ppbe_lane_bar',
  label,
  fy,
  startsOn,
  endsOn,
  tone,
  position,
});

export const STRATEGIES_VISUAL_PPBE_LANES: ReferenceRow[] = [
  ppbeRow(0, 2026, 'Execution', '2025-10-01', '2026-11-12', 'success'),
  ppbeRow(1, 2027, 'OSD / OMB review', '2026-01-01', '2026-03-13', 'notable'),
  ppbeRow(2, 2027, "President's Budget", '2026-03-13', '2026-04-05', 'ink'),
  ppbeRow(3, 2027, 'Execution', '2026-10-01', '2027-11-11', 'success'),
  ppbeRow(4, 2028, 'Programming / POM build', '2026-04-19', '2026-08-26', 'accent'),
  ppbeRow(5, 2028, 'Budget estimate submission', '2026-08-26', '2026-11-25', 'info'),
  ppbeRow(6, 2028, 'OSD / OMB review', '2027-01-01', '2027-03-13', 'notable'),
  ppbeRow(7, 2028, "President's Budget", '2027-03-13', '2027-04-05', 'ink'),
  ppbeRow(8, 2028, 'Execution', '2027-10-01', '2027-11-11', 'success'),
];

export const STRATEGIES_VISUAL_REFERENCE_CALENDARS: ReferenceCalendars = {
  congress: STRATEGIES_VISUAL_CONGRESS,
  ppbeLanes: STRATEGIES_VISUAL_PPBE_LANES,
  ppbeCurrentPhases: [],
  source: { congress: 'baseline', ppbeLanes: 'baseline', ppbeCurrentPhases: 'baseline' },
};

const editorStep = (
  id: string,
  kind: StrategyNode['kind'],
  title: string,
  startsOn: string,
  endsOn: string | null,
  ownerUserId: string | null,
): StrategyNode => ({
  id,
  strategyId: '7f1c9a20-4d3e-4b8a-9c21-6e0f5a8b1d34',
  kind,
  subject: 'deliverable',
  title,
  note: null,
  ownerUserId,
  status: 'draft',
  startsOn,
  endsOn,
  openEnded: false,
  dependsOnIds: [],
  provenance: null,
  targetRef: null,
  meriAuthored: false,
  createdAt: '2026-06-01T12:00:00.000Z',
  updatedAt: '2026-08-19T11:00:00.000Z',
});

export const STRATEGIES_VISUAL_EDITOR_DETAIL: StrategyDetail = {
  id: '7f1c9a20-4d3e-4b8a-9c21-6e0f5a8b1d34',
  clientId: 'client-2',
  title: 'Secure a $10M plus-up',
  type: 'appropriations',
  goal: 'Secure a $10M plus-up',
  meriContext: null,
  meriSummary: null,
  draftedByMeri: false,
  targetDate: null,
  ownerUserId: 'user_1',
  createdByUserId: 'user_1',
  lastEditedByUserId: 'user_1',
  lastEditedAt: '2026-08-19T11:00:00.000Z',
  archivedAt: null,
  createdAt: '2026-06-01T12:00:00.000Z',
  updatedAt: '2026-08-19T11:00:00.000Z',
  artifacts: [],
  nodes: [
    editorStep('sn-1', 'action', 'Identify target program element(s) for the plus-up across RTX business units', '2026-08-15', '2026-09-30', 'user_1'),
    editorStep('sn-2', 'decision', 'Select final PE target(s) and allocate the ask across HASC/SASC/HAC-D/SAC-D', '2026-10-01', null, 'user_1'),
    editorStep('sn-3', 'action', 'Draft and submit white papers justifying the plus-up', '2027-01-15', '2027-02-28', 'user_2'),
    editorStep('sn-4', 'action', 'Secure member requests for the plus-up', '2027-02-28', '2027-04-26', 'user_1'),
    editorStep('sn-5', 'gate', 'HASC/SASC/HAC-D/SAC-D markup windows open', '2027-04-28', null, null),
    editorStep('sn-6', 'action', 'Support markup advocacy and provide technical detail', '2027-04-28', '2027-07-01', 'user_2'),
    editorStep('sn-7', 'milestone', 'Committee marks published; assess the plus-up', '2027-07-01', null, 'user_1'),
    editorStep('sn-8', 'action', 'Prepare floor amendments if the plus-up is not secured', '2027-07-01', '2027-08-15', 'user_2'),
    editorStep('sn-9', 'gate', 'NDAA and defense appropriations conference', '2027-08-17', null, null),
    editorStep('sn-10', 'risk', 'Continuing Resolution risk: the plus-up may slip', '2027-09-04', '2027-10-06', null),
    editorStep('sn-11', 'milestone', 'Conference reports released; final outcome recorded', '2027-09-22', null, 'user_1'),
    editorStep('sn-12', 'milestone', 'FY27 NDAA and defense appropriations bills signed', '2027-10-01', '2027-11-11', 'user_1'),
    editorStep('sn-13', 'action', 'Document lessons learned and roll forward', '2027-11-12', '2027-12-31', 'user_2'),
  ],
};
