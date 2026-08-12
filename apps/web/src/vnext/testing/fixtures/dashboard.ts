import type {
  DashboardVNextModel,
  ModuleStatus,
} from '../../adapters/legacy/useDashboardVNextModel.js';

/** Every fixture module is in its resting state; states are exercised separately. */
const READY: ModuleStatus = { state: 'ready', meta: null, title: '', body: '', action: null };

/**
 * One ModuleStatus per non-ready state (754:2885's six named states, plus
 * ready itself = seven). ModuleStateView is one shared component across all
 * four modules, so exercising it once per state — here, via Needs Attention —
 * covers the same render path every module uses. See DASHBOARD_STATE_FIXTURES.
 */
export const DASHBOARD_MODULE_STATES: Readonly<Record<string, ModuleStatus>> = {
  loading: {
    state: 'loading',
    meta: '0 of 2 sources',
    title: 'Loading Needs Attention',
    body: 'Connecting to Portfolio Alerts and Intelligence Changes.',
    action: null,
  },
  partial: {
    state: 'partial',
    meta: '1 of 2 ready',
    title: 'Partial results',
    body: 'Intelligence Changes has not responded yet; showing Portfolio Alerts.',
    action: null,
  },
  stale: {
    state: 'stale',
    meta: '18 min old',
    title: 'Showing the last successful refresh',
    body: 'Portfolio Alerts has not confirmed a newer read in 18 minutes.',
    action: { label: 'Retry source', tone: 'warning' },
  },
  unavailable: {
    state: 'unavailable',
    meta: 'Portfolio Alerts down',
    title: 'Source unavailable',
    body: 'Portfolio Alerts failed to respond. Intelligence Changes is intact.',
    action: { label: 'Retry source', tone: 'warning' },
  },
  empty: {
    state: 'empty',
    meta: null,
    title: 'No time-sensitive items',
    body: 'Nothing from your active sources needs attention right now.',
    action: null,
  },
  'all-clear': {
    state: 'all-clear',
    meta: 'Next refresh in 4m',
    title: 'All clear',
    body: 'Every tracked source confirmed a clean read this cycle.',
    action: null,
  },
};

/**
 * Visual-harness fixture for the Dashboard. Illustrative content only — it
 * never reaches the product, which reads exclusively from the canonical
 * queries in useDashboardVNextModel.
 */
export const DASHBOARD_VISUAL_FIXTURE: DashboardVNextModel = {
  header: {
    greeting: 'Good Evening, Neo.',
    eyebrow: 'ALL CLIENTS · PORTFOLIO WIDE',
    meta: 'Monday, August 10, 2026 · 49 new signals overnight · 4 critical actions today',
    refreshedLabel: 'Refreshed 3m ago',
  },
  needsAttention: {
    status: READY,
    total: 4,
    items: [
      {
        id: 'a1',
        kind: 'CRITICAL',
        severity: 'critical',
        eyebrow: 'OVERLAND AI',
        title: 'HAC-D reduced Army robotics by $22.7M',
        context: 'Conference restoration window',
        due: 'in 2 days',
        href: '/program-elements',
        actionLabel: 'Open',
      },
      {
        id: 'a2',
        kind: 'DEADLINE',
        severity: 'high',
        eyebrow: 'BORESIGHT',
        title: 'DoD autonomy rule comment closes',
        context: 'Federal Register',
        due: 'in 5 days',
        href: '/explorer',
        actionLabel: 'Open',
      },
      {
        id: 'a3',
        kind: 'HEARING',
        severity: 'high',
        eyebrow: 'APERTURE DEFENSE',
        title: 'HASC contested logistics hearing',
        context: 'Preparation window open',
        due: 'in 1 day',
        href: '/legiwatch',
        actionLabel: 'Prepare',
      },
      {
        id: 'a4',
        kind: 'BUDGET',
        severity: 'normal',
        eyebrow: 'APPROPRIATIONS',
        title: 'SAC-D mark adds $14M to ground autonomy',
        context: 'Senate mark',
        due: '2h ago',
        href: '/program-elements',
        actionLabel: 'Open',
      },
    ],
  },
  news: {
    status: READY,
    meta: '5 clients monitored',
    unavailableReason: null,
    preferences: {
      clientIds: [],
      policyTopics: [],
      signalKinds: [],
      customTopics: [],
      lookback: '48h',
    },
    setPreferences: () => undefined,
    items: [
      {
        id: 'n1',
        source: 'DEFENSE NEWS · 3h ago',
        title: 'Army accelerates autonomous ground vehicles procurement.',
        reason: 'Matches Overland AI capability profile',
        clients: 'Overland AI',
        url: 'https://example.com/1',
        imageUrl: null,
        publishedLabel: '3h ago',
      },
      {
        id: 'n2',
        source: 'POLITICO PRO · 6h ago',
        title: 'House appropriators reduce Army robotics funding.',
        reason: 'Affects a tracked program element',
        clients: 'Overland AI, Boresight',
        url: 'https://example.com/2',
        imageUrl: null,
        publishedLabel: '6h ago',
      },
      {
        id: 'n3',
        source: 'BREAKING DEFENSE · 9h ago',
        title: 'Senate hearing spotlights contested logistics.',
        reason: 'Issue the client lobbies on',
        clients: 'Aperture Defense',
        url: 'https://example.com/3',
        imageUrl: null,
        publishedLabel: '9h ago',
      },
      {
        id: 'n4',
        source: 'FEDSCOOP · 14h ago',
        title: 'DoD releases new AI acquisition guidance.',
        reason: 'Matches tracked procurement topic',
        clients: 'Perseus Defense',
        url: 'https://example.com/4',
        imageUrl: null,
        publishedLabel: '14h ago',
      },
    ],
  },
  today: {
    status: READY,
    week: [
      { id: '1', weekday: 'MON', day: '10', today: true, hasEvents: true },
      { id: '2', weekday: 'TUE', day: '11', today: false, hasEvents: false },
      { id: '3', weekday: 'WED', day: '12', today: false, hasEvents: false },
      { id: '4', weekday: 'THU', day: '13', today: false, hasEvents: false },
      { id: '5', weekday: 'FRI', day: '14', today: false, hasEvents: false },
      { id: '6', weekday: 'SAT', day: '15', today: false, hasEvents: false },
      { id: '7', weekday: 'SUN', day: '16', today: false, hasEvents: false },
    ],
    events: [
      {
        id: 'e1',
        time: '9:30 AM',
        title: 'Client strategy review',
        meta: 'Overland AI · Zoom',
        href: '/engagement',
        action: 'join',
        joinUrl: 'https://example.com/join',
        isMeeting: true,
        isVirtual: true,
        meri: null,
      },
      {
        id: 'e2',
        time: '1:00 PM',
        title: 'Internal pipeline review',
        meta: 'Capiro · Conference room',
        href: '/engagement',
        action: 'brief',
        isMeeting: true,
        isVirtual: false,
      },
      {
        id: 'e3',
        time: '3:00 PM',
        title: 'HASC logistics hearing',
        meta: 'Hearing · Rayburn 2118',
        href: '/legiwatch',
        action: 'open',
        isMeeting: false,
      },
    ],
    nextMeeting: {
      id: 'e1',
      time: '9:30 AM',
      title: 'Client strategy review',
      meta: 'Overland AI · 45 min',
      href: '/engagement',
      action: 'join',
      joinUrl: 'https://example.com/join',
      isMeeting: true,
      isVirtual: true,
      meri: null,
    },
    sendMeri: {
      targetEventId: null,
      pending: false,
      open: () => {},
      close: () => {},
      submit: () => {},
    },
  },
  workQueue: {
    status: READY,
    total: 3,
    items: [
      {
        id: 'w1',
        kind: 'OUTREACH',
        title: 'Hill staff follow-up draft',
        status: 'Ready to send',
        href: '/engagement',
      },
      {
        id: 'w2',
        kind: 'DOCUMENT',
        title: 'Army validation brief',
        status: 'Draft',
        href: '/workspace',
      },
      {
        id: 'w3',
        kind: 'DOCUMENT',
        title: 'Conference restoration memo',
        status: 'Draft',
        href: '/workspace',
      },
    ],
  },
  visibility: { today: true, work: true, news: true },
  setVisibility: () => undefined,
  order: ['news', 'today', 'work'],
  setOrder: () => undefined,
  density: 'standard',
  setDensity: () => undefined,
  isMobile: false,
  retry: () => undefined,
};

/**
 * Needs Attention forced into each non-ready state, items cleared so the
 * state block is the only thing on screen — matches how `754:2885`'s gallery
 * isolates one state per frame. Selected in the visual harness via
 * `?attnState=loading|partial|stale|unavailable|empty|all-clear`.
 */
export const DASHBOARD_STATE_FIXTURES: Readonly<Record<string, DashboardVNextModel>> = Object.fromEntries(
  Object.entries(DASHBOARD_MODULE_STATES).map(([key, status]) => [
    key,
    { ...DASHBOARD_VISUAL_FIXTURE, needsAttention: { status, total: 0, items: [] } },
  ]),
);
