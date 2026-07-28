/*
 * Phase 7 parity harness — deterministic fixture data.
 *
 * Every visible string here is the PROTOTYPE's own fixture content, read out of
 * the prototype bundle's decompressed source (`WATCH_PROPOSALS`, the library
 * rows, the editor header) rather than invented, so a text-metric comparison
 * measures the components and not two different sentences. Where the prototype
 * carries one combined field and the implementation carries two (a proposal's
 * `src` vs `sourceLabel` + `sourceDate`), the fixture puts the prototype's
 * literal in the field that renders it and leaves the other empty.
 *
 * Dates are all RELATIVE to a fixed "today" so the timeline lands in the same
 * place on any day the harness runs.
 */
import type {
  FirmPhase,
  ReferenceCalendars,
  StrategyChatMessage,
  StrategyDetail,
  StrategyListItem,
  StrategyNode,
  WatchProposalCard,
  WatchReviewState,
} from '../pages/strategy/types.js';

export const SID = 'strat-parity-1';
export const CLIENT_ID = 'client-brightdefense';
export const HEAD_VERSION = 'v-parity-7';

/** The prototype's own editor header content. */
export const TITLE = 'FY27 Compliance Program Funding & Authorization';
export const GOAL =
  'Secure a $10M FY27 plus-up by justifying the program early, engaging HAC-D and SAC-D through markup, and tracking conference to enactment.';
/** State 11 — long enough that one-line truncation and the tooltip must engage. */
export const LONG_TITLE =
  'FY27 Compliance Program Funding & Authorization — Multi-Committee Appropriations and Authorization Campaign for the Autonomous Compliance Program of Record';
export const LONG_GOAL =
  'Secure a $10M FY27 plus-up by justifying the program early, engaging HAC-D and SAC-D through markup, tracking conference to enactment, and holding the position through the continuing-resolution window while the coalition files its own asks in parallel.';

function iso(daysFromToday: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

/** The current federal FY, on the same rule buildCalendar uses (Oct rollover). */
const NOW = new Date();
export const CUR_FY = NOW.getUTCMonth() + 1 >= 10 ? NOW.getUTCFullYear() + 1 : NOW.getUTCFullYear();

/**
 * The prototype positions everything on the timeline in QUARTER UNITS
 * (`q: 1.34`, `from: 3.7`) rather than in dates, and `buildCalendar` anchors
 * the axis at Oct 1 of the first shown FY. A quarter unit therefore converts
 * to a date by walking `q * 3` months from that anchor, fractional months
 * included — the prototype's bounds are fractional.
 *
 * Phase 7 §3 requires both captures to show the same visible content, so every
 * date below is derived this way instead of invented.
 */
const AXIS_START = new Date(CUR_FY - 1, 9, 1);

function qIso(q: number): string {
  const monthsFloat = q * 3;
  const whole = Math.floor(monthsFloat);
  const frac = monthsFloat - whole;
  const d = new Date(AXIS_START.getFullYear(), AXIS_START.getMonth() + whole, 1);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(1 + Math.round(frac * daysInMonth));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function node(over: Partial<StrategyNode> & { id: string; title: string }): StrategyNode {
  return {
    strategyId: SID,
    kind: 'action',
    subject: 'deliverable',
    note: null,
    ownerUserId: null,
    status: 'in_progress',
    startsOn: iso(30),
    endsOn: iso(60),
    openEnded: false,
    dependsOnIds: [],
    provenance: null,
    targetRef: null,
    meriAuthored: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  } as StrategyNode;
}

/**
 * The prototype's own NODES_SEED (asset05), converted from quarter units.
 *
 * The earlier fixture invented seven DIFFERENT steps ("Submit the FY27 program
 * justification", "Markup defense", …). Every node title, kind, subject,
 * status and position on screen therefore differed from the prototype's, which
 * is a large part of why the §6 image diff could not return a verdict.
 *
 * `dur: 0` nodes are points (gate / decision / milestone) and carry no end
 * date; n5 is the prototype's open-ended risk ("Ongoing").
 */
export const NODES: StrategyNode[] = [
  node({
    id: 'n1', title: 'White paper to House committee staff',
    kind: 'action', subject: 'deliverable', status: 'in_progress',
    note: 'Grounds the ask; drafted before the Feb submission.',
    startsOn: qIso(1.0), endsOn: qIso(1.34),
  }),
  node({
    id: 'n2', title: 'File HAC-D request packet',
    kind: 'gate', subject: 'submission', status: 'draft',
    note: 'Portal-ready package for the Defense subcommittee. Hard deadline.',
    startsOn: qIso(1.34), endsOn: null,
  }),
  node({
    id: 'n3', title: 'Confirm Sen. Cruz as champion',
    kind: 'action', subject: 'member', status: 'in_progress',
    note: 'Lock a Senate-side champion before markup.',
    startsOn: qIso(1.67), endsOn: qIso(2.01),
  }),
  node({
    id: 'n4', title: 'Go / no-go on Senate companion ask',
    kind: 'decision', subject: 'ask', status: 'active',
    note: 'Decide whether to open a second-chamber front.',
    startsOn: qIso(1.8), endsOn: null,
  }),
  node({
    id: 'n5', title: 'Single-company earmark optics',
    kind: 'risk', subject: 'optics', status: 'active',
    note: 'Mitigate with coalition framing and report language.',
    startsOn: qIso(1.67), endsOn: qIso(3.67), openEnded: true,
  }),
  node({
    id: 'n6', title: 'Defend ask through markup',
    kind: 'action', subject: 'committee', status: 'draft',
    note: 'Markup-day talking points and rebuttal one-pager.',
    startsOn: qIso(2.34), endsOn: qIso(3.01),
  }),
  node({
    id: 'n7', title: `FY${String(CUR_FY + 1).slice(-2)} funding secured & authorized`,
    kind: 'milestone', subject: 'outcome', status: 'suggested',
    note: 'North-star outcome. Feeds learnings into the next cycle.',
    startsOn: qIso(4.67), endsOn: null,
  }),
];

/** State 10 — the same plan with an open context gap on two steps. */
export const NODES_LOW_CONTEXT: StrategyNode[] = NODES.map((n) =>
  n.id === 'n1' || n.id === 'n3'
    ? ({
        ...n,
        provenance: { contextNeeds: [{ code: 'strategy_brief', label: 'the strategy brief' }] },
      } as StrategyNode)
    : n,
);

/** State 12/13 — a plan entirely after / entirely before today, so the
 *  today-line clamps to an edge instead of centring. */
export const NODES_FUTURE: StrategyNode[] = NODES.map((n, i) =>
  node({ ...n, id: n.id, title: n.title, startsOn: iso(500 + i * 40), endsOn: iso(530 + i * 40) }),
);
export const NODES_PAST: StrategyNode[] = NODES.map((n, i) =>
  node({ ...n, id: n.id, title: n.title, startsOn: iso(-700 + i * 40), endsOn: iso(-670 + i * 40) }),
);

export function detail(over: Partial<StrategyDetail> = {}): StrategyDetail {
  return {
    id: SID,
    clientId: CLIENT_ID,
    title: TITLE,
    type: 'appropriations',
    goal: GOAL,
    meriContext: null,
    meriSummary: null,
    draftedByMeri: true,
    targetDate: null,
    ownerUserId: 'user_parity',
    createdByUserId: 'user_parity',
    lastEditedByUserId: 'user_parity',
    lastEditedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    archivedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    nodes: NODES,
    artifacts: [],
    violations: [],
    groundingHealth: null,
    ...over,
  };
}

/** The prototype's library rows, in its own order and wording. */
export const LIST: StrategyListItem[] = [
  {
    id: SID,
    clientId: CLIENT_ID,
    title: TITLE,
    type: 'appropriations',
    ownerUserId: 'user_maya',
    createdByUserId: 'user_maya',
    lastEditedByUserId: 'user_maya',
    lastEditedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    createdAt: '2026-06-01T00:00:00.000Z',
    nodeCount: 7,
  },
  {
    id: 'strat-parity-2',
    clientId: 'client-aerovance',
    title: 'NDAA FY27 Authorization — Autonomous ISR',
    type: 'authorization',
    ownerUserId: 'user_james',
    createdByUserId: 'user_james',
    lastEditedByUserId: 'user_james',
    lastEditedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
    createdAt: '2026-06-02T00:00:00.000Z',
    nodeCount: 5,
  },
  {
    id: 'strat-parity-3',
    clientId: 'client-meridian',
    title: 'Dual-Use Export Control Policy Reform',
    type: 'regulatory',
    ownerUserId: 'user_ava',
    createdByUserId: 'user_ava',
    lastEditedByUserId: 'user_ava',
    lastEditedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    createdAt: '2026-06-03T00:00:00.000Z',
    nodeCount: 8,
  },
  {
    id: 'strat-parity-4',
    clientId: 'client-northwind',
    title: 'Defense Tech Coalition — AI Procurement Standards',
    type: 'coalition',
    ownerUserId: 'user_parity',
    createdByUserId: 'user_parity',
    lastEditedByUserId: 'user_parity',
    // The prototype's row reads "Jan 24". A 2027 date is in the FUTURE relative
    // to the capture date, which the relative formatter renders as "just now".
    // Midday UTC: a midnight-UTC stamp renders as Jan 23 west of UTC.
    lastEditedAt: '2026-01-24T12:00:00.000Z',
    createdAt: '2025-06-04T00:00:00.000Z',
    nodeCount: 6,
  },
];

export const CLIENTS = [
  { id: CLIENT_ID, name: 'Brightdefense' },
  { id: 'client-aerovance', name: 'Aerovance Systems' },
  { id: 'client-meridian', name: 'Meridian Defense' },
  { id: 'client-northwind', name: 'Northwind Robotics' },
];

/**
 * `memberName()` resolves owners by `clerkUserId` (members.ts) — keying these
 * on `userId` made every owner in the list fall back to "Team member" and made
 * the list capture non-comparable with the prototype, which names them.
 */
export const MEMBERS = [
  { id: 'm_maya', clerkUserId: 'user_maya', name: 'Maya Reyes', email: 'maya@example.com' },
  { id: 'm_james', clerkUserId: 'user_james', name: 'James Okafor', email: 'james@example.com' },
  { id: 'm_ava', clerkUserId: 'user_ava', name: 'Ava Lin', email: 'ava@example.com' },
  { id: 'm_neo', clerkUserId: 'user_parity', name: 'Neo Martinez', email: 'neo@capiro.ai' },
];

/**
 * The prototype's FIRM_PHASES_DEFAULT labels on the real (fy, quarter) shape the
 * app's FirmPhase carries — quarter indices 1-4, `position` for order.
 */
export const FIRM_PHASES: FirmPhase[] = [
  // The prototype's FIRM_PHASES_DEFAULT verbatim (asset05), in its own quarter
  // units. SEVEN phases, not six — and the seventh spans two quarters. The
  // earlier fixture listed six with a synthetic (fy, quarter) mapping, so the
  // FIRM PHASE band rendered different labels in different columns.
  { label: 'Strategy refresh', from: 0, to: 1 },
  { label: 'Submit asks & white papers', from: 1, to: 2 },
  { label: 'Refine post-budget', from: 2, to: 3 },
  { label: 'Markup support', from: 3, to: 4 },
  { label: 'Outcomes & roll forward', from: 4, to: 5 },
  { label: 'Next-cycle strategy refresh', from: 5, to: 6 },
  { label: 'Submit asks & white papers', from: 6, to: 8 },
].map(({ label, from, to }, i) => {
  // Quarter unit q → FY offset floor(q/4), quarter (q % 4) + 1. `to` is
  // exclusive, so the closing quarter is `to - 1`.
  const lastQ = to - 1;
  return {
    id: `fp-${i}`,
    label,
    startFy: CUR_FY + Math.floor(from / 4),
    startQ: (from % 4) + 1,
    endFy: CUR_FY + Math.floor(lastQ / 4),
    endQ: (lastQ % 4) + 1,
    position: i,
  };
});

/** The prototype's legislative-calendar rows (labels + windows verbatim) on the
 *  app's ReferenceRow shape. */
/** The prototype's CONGRESS array, verbatim (asset05, `const CONGRESS`). */
const PROTO_CONGRESS: Array<{ label: string; from: number; to: number; tone: string }> = [
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

export const REFERENCE: ReferenceCalendars = {
  congress: PROTO_CONGRESS.map((r, i) => ({
    id: `c${i}`,
    kind: 'congress' as const,
    label: r.label,
    fy: null,
    startsOn: qIso(r.from),
    endsOn: qIso(r.to),
    tone: r.tone,
    position: i,
  })),
  ppbeLanes: [
    { label: 'Programming', fy: CUR_FY + 1 },
    { label: 'Budgeting', fy: CUR_FY + 1 },
    { label: 'Execution', fy: CUR_FY },
  ].map((r, i) => ({
    id: `p${i}`,
    kind: 'ppbe' as const,
    label: r.label,
    fy: r.fy,
    startsOn: null,
    endsOn: null,
    tone: null,
    position: i,
  })),
  ppbeCurrentPhases: [
    {
      id: 'pc1',
      kind: 'ppbe' as const,
      label: 'Budgeting',
      fy: CUR_FY,
      startsOn: null,
      endsOn: null,
      tone: null,
      position: 0,
    },
  ],
  source: {},
} as unknown as ReferenceCalendars;

/** WATCH_PROPOSALS, verbatim from the prototype bundle. */
const PROTO_PROPOSALS: Array<{
  id: string;
  kind: 'dependency' | 'calendar' | 'deadline';
  src: string;
  title: string;
  body: string;
  impact: string;
  revised?: boolean;
}> = [
  {
    id: 'w1',
    kind: 'dependency',
    src: 'Dependency check · first run',
    title: 'Markup defense runs before the hearing it depends on',
    body: 'Meri proposes pushing markup defense one quarter so it follows the hearing prep it depends on.',
    impact: '1 step re-timed',
  },
  {
    id: 'w2',
    kind: 'calendar',
    src: 'Legislative calendar · changed Jul 24',
    title: 'CR chatter ahead of final bills',
    body: 'Two approps bills are behind schedule. Meri proposes flagging a CR risk in FY27 Q4 with bridge messaging.',
    impact: '1 risk added',
  },
  {
    id: 'w3',
    kind: 'calendar',
    src: 'Congressional watch · 3 days ago',
    title: 'Single-company optics before markup',
    body: 'Two similar asks were filed this month. Meri proposes adding a coalition sign-on letter in FY27 Q3.',
    impact: '1 step added',
    revised: true,
  },
  {
    id: 'w4',
    kind: 'dependency',
    src: 'Dependency check · first run',
    title: 'White paper lands after the staff briefing that cites it',
    body: 'Meri proposes moving the white paper a quarter earlier so the briefing has it in hand.',
    impact: '1 step re-timed',
  },
  {
    id: 'w5',
    kind: 'deadline',
    src: 'Firm phases · changed Jul 20',
    title: 'Two steps now sit outside a firm phase',
    body: "Your firm shifted 'Submit asks' by three weeks. Meri proposes re-timing the two steps that fall outside it.",
    impact: '2 steps re-timed',
  },
];

/** The prototype's Why copy is one fixed sentence; production passes the
 *  finding's own message through `why`, so the fixture supplies the
 *  prototype's sentence to keep the compared text identical. */
const PROTO_WHY =
  "Meri compared this plan against the legislative calendar, the PPBE reference, your firm phases and each step's dependencies.";

export const PROPOSALS: WatchProposalCard[] = PROTO_PROPOSALS.map((p) => ({
  id: p.id,
  watchKey: `key-${p.id}`,
  strategyVersionId: HEAD_VERSION,
  sourceLabel: p.src,
  sourceDate: null,
  badges: [
    ...(p.kind === 'dependency' ? (['out_of_order'] as const) : []),
    ...(p.revised ? (['updated'] as const) : []),
  ],
  title: p.title,
  proposal: p.body,
  impact: p.impact,
  why: PROTO_WHY,
  risk: 'medium',
  recheckStatus: p.revised ? 'updated' : null,
})) as WatchProposalCard[];

export function watchState(over: Partial<WatchReviewState> = {}): WatchReviewState {
  return {
    strategyId: SID,
    headVersionId: HEAD_VERSION,
    mission: {
      id: 'mission-parity',
      state: 'active',
      cadence: 'weekly',
      lastRunAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      nextRunAt: null,
    },
    pendingCount: PROPOSALS.length,
    proposals: PROPOSALS,
    lastRecheck: null,
    ...over,
  } as WatchReviewState;
}

export const MISSIONS = [
  {
    id: 'mission-parity',
    strategyId: SID,
    name: 'Watch the plan',
    state: 'active',
    cadence: 'weekly',
    nextRunAt: null,
    lastRunAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    createdAt: '2026-07-01T00:00:00.000Z',
  },
];

function chat(over: Partial<StrategyChatMessage> & { id: string }): StrategyChatMessage {
  return {
    strategyId: SID,
    nodeId: null,
    role: 'meri',
    kind: 'message',
    body: '',
    attachments: [],
    action: null,
    state: 'active',
    createdByUserId: null,
    createdAt: '2026-07-27T09:00:00.000Z',
    ...over,
  } as StrategyChatMessage;
}

/** State 4 — the strategy thread: Meri opener, a user turn with an attachment
 *  chip, a reply carrying the Open-step action. */
export const STRATEGY_THREAD: StrategyChatMessage[] = [
  chat({
    id: 'm1',
    body: 'I drafted this plan from your goal. Seven steps, front-loaded before markup, with the coalition letter ahead of the optics window.',
  }),
  chat({
    id: 'm2',
    role: 'user',
    body: 'Read the markup memo and add a coalition sign-on letter before the optics window.',
    createdByUserId: 'user_parity',
    attachments: [
      { id: '11111111-1111-4111-8111-111111111111', filename: 'FY27 markup memo.pdf', kind: 'pdf', status: 'ready' },
    ],
  }),
  chat({
    id: 'm3',
    body: 'Added a coalition sign-on letter in FY27 Q3, ahead of the optics window.',
    action: { type: 'open_node', nodeId: 'n3', title: 'Coalition sign-on letter' },
  }),
];

/** State 5 — a long thread, so the message area must scroll to newest with the
 *  composer still pinned. */
export const LONG_THREAD: StrategyChatMessage[] = [
  ...STRATEGY_THREAD,
  ...Array.from({ length: 7 }, (_, i) => [
    chat({
      id: `u${i}`,
      role: 'user',
      body: `Follow-up question number ${i + 1} about the markup timing.`,
      createdByUserId: 'user_parity',
    }),
    chat({
      id: `a${i}`,
      body: 'Answered, and re-checked the downstream steps against the updated dates. Nothing else conflicts.',
    }),
  ]).flat(),
];

/** State 6 — a step thread, separate from the strategy thread. */
export const STEP_THREAD: StrategyChatMessage[] = [
  chat({ id: 's1', nodeId: 'n3', body: 'This step sits in FY27 Q3, ahead of the optics window.' }),
  chat({
    id: 's2',
    nodeId: 'n3',
    role: 'user',
    body: 'Who signs it?',
    createdByUserId: 'user_parity',
  }),
  chat({ id: 's3', nodeId: 'n3', body: 'Four coalition members plus the two committee-aligned associations.' }),
];

/** State 10 — the single persistent context-gap message. */
export const LOW_CONTEXT_THREAD: StrategyChatMessage[] = [
  chat({
    id: 'g1',
    kind: 'context_gap',
    body: 'I drafted this without the strategy brief. Attach it here and I will factor it in.',
  }),
  ...STRATEGY_THREAD,
];
