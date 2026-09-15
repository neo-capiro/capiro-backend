/**
 * Contract-valid fixture data for the Meri vNext visual harness.
 *
 * Every value here is shaped exactly the way the real backend shapes it
 * (workspaces via /api/clio/vnext/workspaces, conversations via
 * /api/clio/conversations, controller PendingApproval rows, per-turn
 * trustSteps/citations/verification metadata). Text content mirrors the
 * prototype's *interaction scenarios* (a budget-mark analysis turn with a
 * chart, an artifact turn with a queued external send) without copying any
 * production data. This module is dev/test-only: nothing in the production
 * bundle imports it.
 */
import type {
  ChatMessage,
  MeriConversation,
  MeriCitation,
} from '../../../components/chat/chat-store.js';
import type { TrustStep } from '../../../components/chat/work-performed-shared.js';
import type {
  PendingApproval,
} from '../../../components/chat/useMeriChatController.js';
import type { MeriTurnScope } from '../../../components/chat/meri-turn-scope.js';
import type { MeriSavedDocumentArtifact } from '../../../components/chat/meri-artifact-download.js';
import type { MeResponse } from '../../../lib/me.js';
import type { MeriWorkspace, MeriContextPacket } from '../../meri/meri-vnext-api.js';
import type { MeriEvidenceSource } from '../../meri/MeriEvidenceTray.js';
import type { ArtifactResponse } from '../../../components/chat/analysis-chart-shared.js';

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const date = (msAgo: number) => new Date(NOW - msAgo);

export const FIXTURE_CLIENTS = [
  { id: 'client-overland', name: 'Overland AI' },
  { id: 'client-halcyon', name: 'Halcyon Grid' },
  { id: 'client-boresight', name: 'Boresight' },
  { id: 'client-cascade', name: 'Cascade Biosciences' },
];

export const FIXTURE_ME: MeResponse = {
  user: {
    id: 'user-fixture',
    clerkUserId: 'clerk-fixture',
    email: 'smcgrath@capitolstrategies.example',
    firstName: 'Sarah',
    lastName: 'McGrath',
    title: 'Principal',
    emailSignatureEnabled: false,
    hasEmailSignature: false,
    tourCompleted: true,
    legiwatchIntroSeen: true,
  },
  tenant: { id: 'tenant-fixture', slug: 'capitol-strategies', name: 'Capitol Strategies Group' },
  role: 'member' as MeResponse['role'],
  billingAdmin: false,
  features: {
    meetingsV2: false,
    meriDockUndockUi: true,
    meriv3Chat: true,
  } as MeResponse['features'],
};

export const FIXTURE_WORKSPACES: MeriWorkspace[] = [
  {
    id: 'ws-fy27',
    name: 'FY27 Appropriations',
    clientId: 'client-overland',
    threadCount: 4,
    createdAt: iso(86_400_000 * 30),
    updatedAt: iso(3_600_000),
  } as MeriWorkspace,
  {
    id: 'ws-grid',
    name: 'Grid resilience',
    clientId: 'client-halcyon',
    threadCount: 2,
    createdAt: iso(86_400_000 * 20),
    updatedAt: iso(7_200_000),
  } as MeriWorkspace,
  {
    id: 'ws-firm',
    name: 'Firm-wide',
    clientId: null,
    threadCount: 3,
    createdAt: iso(86_400_000 * 15),
    updatedAt: iso(86_400_000),
  } as MeriWorkspace,
];

export const FIXTURE_ACTIVE_CONVERSATION_ID = 'conv-mark-analysis';

export const FIXTURE_CONVERSATIONS: MeriConversation[] = [
  {
    id: FIXTURE_ACTIVE_CONVERSATION_ID,
    title: 'FY27 Ground Robotics mark analysis',
    clientId: 'client-overland',
    client: { id: 'client-overland', name: 'Overland AI' },
    latestMessage: {
      body: 'HAC-D marked the line $18.0M above the FY27 request; the Senate mark sits below it.',
      createdAt: iso(12 * 60_000),
    },
    updatedAt: iso(12 * 60_000),
    workspaceId: 'ws-fy27',
    workspace: { id: 'ws-fy27', name: 'FY27 Appropriations', clientId: 'client-overland' },
  },
  {
    id: 'conv-halcyon-doe',
    title: 'Halcyon Grid — DOE loan timeline',
    clientId: 'client-halcyon',
    client: { id: 'client-halcyon', name: 'Halcyon Grid' },
    latestMessage: {
      body: 'Two of three milestones slipped past the Q3 window. The filing date is unchanged.',
      createdAt: iso(2 * 3_600_000),
    },
    updatedAt: iso(2 * 3_600_000),
    workspaceId: 'ws-grid',
    workspace: { id: 'ws-grid', name: 'Grid resilience', clientId: 'client-halcyon' },
  },
  {
    id: 'conv-weekly-moves',
    title: 'What moved last week',
    clientId: null,
    client: null,
    latestMessage: {
      body: 'Five items across four clients. Two need a decision before Friday.',
      createdAt: iso(26 * 3_600_000),
    },
    updatedAt: iso(26 * 3_600_000),
    workspaceId: 'ws-firm',
    workspace: { id: 'ws-firm', name: 'Firm-wide', clientId: null },
  },
  {
    id: 'conv-boresight-sasc',
    title: 'Boresight — committee language',
    clientId: 'client-boresight',
    client: { id: 'client-boresight', name: 'Boresight' },
    latestMessage: {
      body: 'SASC report language is narrower than the House version on sensor autonomy.',
      createdAt: iso(4 * 86_400_000),
    },
    updatedAt: iso(4 * 86_400_000),
  },
  {
    id: 'conv-overland-board',
    title: 'Overland AI board memo',
    clientId: 'client-overland',
    client: { id: 'client-overland', name: 'Overland AI' },
    latestMessage: {
      body: 'Artifact ready — FY27 outlook, two pages, three cited sources.',
      createdAt: iso(27 * 86_400_000),
    },
    updatedAt: iso(27 * 86_400_000),
    workspaceId: 'ws-fy27',
    workspace: { id: 'ws-fy27', name: 'FY27 Appropriations', clientId: 'client-overland' },
  },
  {
    id: 'conv-cascade-barda',
    title: 'Cascade — BARDA pathway questions',
    clientId: 'client-cascade',
    client: { id: 'client-cascade', name: 'Cascade Biosciences' },
    latestMessage: {
      body: 'The pathway depends on which appropriation carries the award.',
      createdAt: iso(28 * 86_400_000),
    },
    updatedAt: iso(28 * 86_400_000),
  },
];

const TURN_ONE_STEPS: TrustStep[] = [
  { tool: 'resolve_scope', label: 'Resolved conversation scope — Overland AI', status: 'done' },
  { tool: 'context_packet', label: 'Read 5 compiled context items', status: 'done', count: 5 },
  { tool: 'document_search', label: 'Searched the HAC-D FY27 report · pp. 176–190', status: 'done' },
  { tool: 'compare', label: 'Compared request, House and Senate figures for PE 0605053A', status: 'done' },
];

const TURN_TWO_STEPS: TrustStep[] = [
  { tool: 'resolve_scope', label: 'Resolved conversation scope — Overland AI', status: 'done' },
  { tool: 'recall', label: 'Read the FY27 mark comparison from this thread', status: 'done' },
  { tool: 'draft_document', label: 'Drafted a two-page memo', status: 'done' },
  { tool: 'prepare_send', label: 'Prepared an external send for your approval', status: 'done' },
];

const TURN_ONE_CITATIONS: MeriCitation[] = [
  {
    n: 1,
    type: 'document',
    id: 'cite-hacd-report',
    title: 'HAC-D FY27 Appropriations Report, pp. 176–190',
    url: null,
    snippet: 'Ground Robotics is marked at $210.2M, $18.0M above the FY27 request of $192.2M.',
    tool: 'document_search',
  },
  {
    n: 2,
    type: 'document',
    id: 'cite-sacd-summary',
    title: 'SAC-D FY27 summary table',
    url: null,
    snippet: 'The Senate mark carries Ground Robotics at $186.0M with no report language on autonomy.',
    tool: 'document_search',
  },
  {
    n: 3,
    type: 'record',
    id: 'cite-advocacy-record',
    title: 'Advocacy record — FY27 ask definition (Feb 04)',
    url: null,
    snippet: 'The ask was defined as $25M above the request for PE 0605053A.',
    tool: 'query_engagement',
  },
];

/**
 * The memo drafted on turn 2, as the server persists it: kind word_document
 * and bodyText is the saved Word document spec (JSON) — the same shape
 * MeriArtifactCanvas.test.tsx feeds the canvas.
 */
const FIXTURE_WORD_SPEC = {
  version: 1,
  title: 'Overland AI — FY27 Ground Robotics outlook',
  sections: [
    {
      heading: 'Where the marks landed',
      paragraphs: [
        'HAC-D marked Ground Robotics at $210.2M, $18.0M above the FY27 request of $192.2M. The Senate mark sits at $186.0M, $6.2M below the request, so conference decides the line.',
      ],
      bullets: [
        'House: $210.2M, with report language naming autonomous ground system test capacity.',
        'Senate: $186.0M, with no report language on autonomy.',
      ],
      tables: [],
      imageArtifactIds: [],
      images: [],
    },
    {
      heading: 'What it means for the ask',
      paragraphs: [
        'The $25M ask is met on the House side only. Conference posture should defend the House number and price the Senate gap.',
      ],
      bullets: [],
      tables: [],
      imageArtifactIds: [],
      images: [],
    },
  ],
} as const;

const TURN_SCOPE_OVERLAND: MeriTurnScope = {
  kind: 'client',
  clientId: 'client-overland',
  clientName: 'Overland AI',
  targetHint: null,
};

export const FIXTURE_MESSAGES: ChatMessage[] = [
  {
    id: 'msg-user-1',
    role: 'user',
    content:
      'What happened to Ground Robotics in the HAC-D mark, and what does it mean for the FY27 ask?',
    createdAt: date(14 * 60_000),
  },
  {
    id: 'msg-assistant-1',
    role: 'assistant',
    content: [
      'HAC-D marked Ground Robotics at $210.2M, $18.0M above the FY27 request of $192.2M. The Senate mark sits at $186.0M, $6.2M below the request.',
      '',
      '- House: $210.2M, with report language naming autonomous ground system test capacity.',
      '- Senate: $186.0M, with no report language on autonomy.',
      '- Conference decides the line. The $25M ask is met on the House side only.',
      '',
      'The advocacy record shows the ask was defined on Feb 04, and the House mark is the first government action above the request baseline.',
    ].join('\n'),
    createdAt: date(13 * 60_000),
    citations: TURN_ONE_CITATIONS,
    verification: {
      claims: [],
      totalCount: 3,
      unsupportedCount: 0,
      unsupportedRatio: 0,
      lowConfidence: false,
      confidence: { level: 'high', label: '3 of 3 claims verified' },
    },
    suggestions: [
      'Compare this to the FY26 outcome',
      'Draft the client memo',
      'What does conference risk look like?',
    ],
    turnScope: TURN_SCOPE_OVERLAND,
    contextPacketId: 'packet-turn-1',
    orchestratorIntent: 'query_intelligence',
    orchestratorTier: 'deep',
    planSteps: ['Resolve scope', 'Read compiled context', 'Search the HAC-D report', 'Compare the figures'],
    trustSteps: TURN_ONE_STEPS,
    chartArtifacts: [{ id: 'chart-mark-comparison', title: 'House and Senate marks · PE 0605053A' }],
  },
  {
    id: 'msg-user-2',
    role: 'user',
    content: 'Draft the client memo and send it to the Overland AI team.',
    createdAt: date(6 * 60_000),
  },
  {
    id: 'msg-assistant-2',
    role: 'assistant',
    content:
      'The memo is drafted and sitting in the artifact canvas. Sending it to the Overland AI team needs your approval — the card is on the right.',
    createdAt: date(5 * 60_000),
    suggestions: ['Shorten it to one page', 'Add the FY26 comparison'],
    turnScope: TURN_SCOPE_OVERLAND,
    contextPacketId: 'packet-turn-2',
    orchestratorIntent: 'draft_deliverable',
    orchestratorTier: 'deep',
    planSteps: ['Resolve scope', 'Read thread context', 'Draft the memo', 'Prepare the send'],
    trustSteps: TURN_TWO_STEPS,
    documentArtifacts: [
      {
        id: 'doc-fy27-outlook',
        title: 'Overland AI — FY27 Ground Robotics outlook',
        kind: 'word_document',
        bodyText: JSON.stringify(FIXTURE_WORD_SPEC),
      },
    ],
  },
];

/**
 * The queued external send shown in the transcript notice, the rail's
 * Approvals tab, and the turn inspector. Shape mirrors the server's
 * action-proposal payload 1:1 (see useMeriChatController pending_approval).
 */
export const FIXTURE_PENDING_APPROVAL: PendingApproval = {
  proposalId: 'proposal-send-memo',
  status: 'proposed',
  tool: 'send_email',
  preview: {
    label: 'Email the FY27 mark memo to the Overland AI team',
    riskTier: 'high',
    leavesFirm: true,
    reversible: false,
    fields: {
      to: 'kmiller@overland.ai, dpark@overland.ai, and 1 more',
      subject: 'FY27 Ground Robotics — House and Senate marks',
      attachment: 'Overland AI — FY27 outlook.docx · 2 pages',
    },
    counts: { recipients: 3, attachments: 1, externalDomains: 1 },
    reason:
      'You asked for the memo to go to the client team. The send leaves the firm and cannot be recalled.',
  },
  expiresAt: new Date(NOW + 23 * 3_600_000).toISOString(),
  reason:
    'You asked for the memo to go to the client team. The send leaves the firm and cannot be recalled, so it needs your approval.',
  riskTier: 'high',
  policyCode: 'external_send',
  ruleId: 'external-send-v2',
  policy: {
    source: 'policy-pack',
    mode: 'enforce',
    packKey: 'capiro-writes',
    packVersion: '2026.09',
    binding: 'external_send',
    decisionHash: 'd3adb33f',
    contextHash: 'c0ffee12',
    decision: 'hold',
    jurisdiction: 'firm',
    channel: 'email',
    recipientType: 'external',
  },
  approvedAt: null,
  approvedBy: null,
  attemptCount: 0,
  resultSummary: null,
  createdAt: iso(5 * 60_000),
  updatedAt: iso(5 * 60_000),
} satisfies PendingApproval;

/**
 * Latest compiled context packet for the active conversation (the rail's
 * ACTIVE CONTEXT list). Mirrors GET /api/clio/context-packets/conversation/:id/latest.
 */
export const FIXTURE_CONTEXT_PACKET: MeriContextPacket = {
  packetId: 'packet-turn-2',
  persisted: true,
  persistenceErrorCode: null,
  compiledAt: iso(5 * 60_000),
  surface: 'meri',
  clientId: 'client-overland',
  items: [
    {
      id: 'ctx-advocacy-record',
      label: 'Advocacy record — FY27 ask definition',
      type: 'engagement',
      scope: 'client',
      authority: 'firm',
      userScoped: false,
      rationale: 'Scoped conversation context',
      selection: 'automatic',
    },
    {
      id: 'ctx-hacd-report',
      label: 'HAC-D FY27 Appropriations Report, pp. 176–190',
      type: 'document',
      scope: 'firm',
      authority: 'firm',
      userScoped: false,
      rationale: 'Cited in this thread',
      selection: 'automatic',
    },
    {
      id: 'ctx-sacd-summary',
      label: 'SAC-D FY27 summary table',
      type: 'document',
      scope: 'firm',
      authority: 'firm',
      userScoped: false,
      rationale: 'Cited in this thread',
      selection: 'automatic',
    },
    {
      id: 'ctx-client-profile',
      label: 'Overland AI — client profile',
      type: 'client_record',
      scope: 'client',
      authority: 'firm',
      userScoped: false,
      rationale: 'Scoped client',
      selection: 'automatic',
    },
    {
      id: 'ctx-prior-turn',
      label: 'Earlier answer — FY27 mark comparison',
      type: 'thread_memory',
      scope: 'client',
      authority: 'firm',
      userScoped: false,
      rationale: 'Same thread',
      selection: 'automatic',
    },
  ],
  exclusions: [],
  unauthorizedCount: 0,
  degraded: false,
} as MeriContextPacket;

/**
 * Saved bar chart on the first assistant turn. Mirrors GET
 * /api/clio/analysis-artifacts/:id — the exact figure set the answer prose
 * cites (192.2 / 210.2 / 186.0).
 */
export const FIXTURE_CHART_ARTIFACT: ArtifactResponse = {
  id: 'chart-mark-comparison',
  title: 'House and Senate marks · PE 0605053A',
  visualization: {
    version: 1,
    chartType: 'bar',
    title: 'House and Senate marks · PE 0605053A',
    footer: 'Compiled from the HAC-D report and the SAC-D summary, retrieved Aug 28.',
    xKey: 'mark',
    data: [
      { mark: 'FY27 request', amount: 192.2 },
      { mark: 'House mark', amount: 210.2 },
      { mark: 'Senate mark', amount: 186.0 },
    ],
    series: [{ dataKey: 'amount', label: 'Amount', valueFormat: 'currency', valueSuffix: 'M' }],
  },
  imageAvailable: false,
  provenance: {
    evidence: 'derived',
    generatedAt: iso(13 * 60_000),
    datasetCount: 2,
    rowCount: 3,
    datasets: [
      { name: 'HAC-D FY27 report', rowCount: 2 },
      { name: 'SAC-D FY27 summary', rowCount: 1 },
    ],
  },
};

/**
 * Landing "Start work" cards: the skills endpoint's catalog shape is
 * { enabled: true, skills: [...] } with quickAction entries (see
 * normalizeMeriQuickActionCatalog). The six reference routines with their
 * real descriptions.
 */
export const FIXTURE_SKILLS = {
  enabled: true,
  skills: [
    {
      id: 'monday-brief',
      label: 'Monday Brief',
      description: 'What moved last week, what needs a decision, and the sources for each.',
      starterPrompt: 'Run Monday Brief.',
      quickAction: true,
      requiresClient: false,
    },
    {
      id: 'mark-comparison',
      label: 'Mark comparison',
      description: 'House and Senate marks for a program element, with every delta against the request.',
      starterPrompt: 'Compare the House and Senate marks for PE 0605053A and flag the deltas against the request.',
      quickAction: true,
      requiresClient: true,
    },
    {
      id: 'hearing-prep-pack',
      label: 'Hearing prep pack',
      description: 'Members, witnesses, and where this client is exposed.',
      starterPrompt: 'Build a hearing prep pack for the next HASC autonomy hearing.',
      quickAction: true,
      requiresClient: true,
    },
    {
      id: 'deep-research',
      label: 'Deep research',
      description: 'A plan, clarifying questions, then a cited report. Multi-phase.',
      starterPrompt: 'Run deep research on FY27 autonomy funding across the portfolio.',
      quickAction: true,
      requiresClient: false,
    },
    {
      id: 'filing-sweep',
      label: 'Filing sweep',
      description: 'Every LDA filing due this quarter, by registrant and period.',
      starterPrompt: 'Sweep the LDA filings due this quarter.',
      quickAction: true,
      requiresClient: false,
    },
    {
      id: 'client-one-pager',
      label: 'Client one-pager',
      description: 'Capabilities, federal footprint and current asks on one page.',
      starterPrompt: 'Draft a one-pager for this client.',
      quickAction: true,
      requiresClient: true,
    },
  ],
};

export const FIXTURE_SAVED_PROMPTS = [
  {
    id: 'prompt-weekly-moves',
    title: 'What moved this week',
    body: 'What moved this week across my clients? Rank by what needs a decision first.',
    createdAt: iso(9 * 86_400_000),
    updatedAt: iso(2 * 86_400_000),
  },
  {
    id: 'prompt-board-two-pager',
    title: 'Board two-pager',
    body: 'Draft a two-page board memo on the current state of play, with cited sources.',
    createdAt: iso(20 * 86_400_000),
    updatedAt: iso(6 * 86_400_000),
  },
];

const TURN_ONE_EVIDENCE_SOURCES: MeriEvidenceSource[] = [
  {
    citationNumber: 1,
    icon: 'File05',
    provider: 'HAC-D FY27 REPORT',
    date: 'RETRIEVED AUG 28',
    title: 'HAC-D FY27 Appropriations Report, pp. 176–190',
    snippet: 'Ground Robotics is marked at $210.2M, $18.0M above the FY27 request of $192.2M.',
    locator: 'HAC-D FY27 REPORT · PP. 176–190',
  },
  {
    citationNumber: 2,
    icon: 'File05',
    provider: 'SAC-D FY27 SUMMARY',
    date: 'RETRIEVED AUG 28',
    title: 'SAC-D FY27 summary table',
    snippet: 'The Senate mark carries Ground Robotics at $186.0M with no report language on autonomy.',
    locator: 'SAC-D FY27 SUMMARY TABLE',
  },
  {
    citationNumber: 3,
    icon: 'File05',
    provider: 'ADVOCACY RECORD',
    date: 'FEB 04',
    title: 'Advocacy record — FY27 ask definition',
    snippet: 'The ask was defined as $25M above the request for PE 0605053A.',
    locator: 'ENGAGEMENT · FY27 ASK DEFINITION',
  },
];

/** Thinking-tab view model for the second (artifact) turn. */
export const fixtureTurnInspectorData = {
  turnId: 'msg-assistant-2',
  turnScope: TURN_SCOPE_OVERLAND,
  contextPacketId: 'packet-turn-2',
  thinking: {
    plan: '',
    steps: TURN_TWO_STEPS,
    intent: 'draft_deliverable',
    tier: 'deep' as const,
  },
  evidence: {
    sources: TURN_ONE_EVIDENCE_SOURCES,
    verifyStats: [],
    claims: [],
    groundingCaveat: null,
    retrieval: null,
  },
  approvals: [FIXTURE_PENDING_APPROVAL],
};
