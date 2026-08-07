/**
 * Outreach V3 UI-to-API capability matrix (schema version 1).
 *
 * Maps every state in the Phase 2.1 prototype contract to the backend
 * capability Phase 2 either exposes safely or denies explicitly, and proves the
 * mapping against two accepted upstream contracts:
 *
 *   - the Phase 0 route manifest (a referenced route must really exist);
 *   - the Phase 1 runtime route policy (a shadow-denied route must really carry
 *     runtime-action metadata).
 *
 * Nothing here implements Outreach V3. Every entry describes Phase 2 behaviour
 * and names a future owner.
 *
 * This module lives under `src/` on purpose. `apps/api/scripts/` sits outside
 * every tsconfig `rootDir`, so a spec importing the CLI directly would raise
 * TS6059 — the exact pre-existing breakage recorded in the Phase 2 input lock.
 * The CLI is a thin wrapper over these pure functions.
 */
import { ENGAGEMENT_RUNTIME_ROUTE_POLICY } from './runtime/engagement-runtime-route-policy.js';

export type CapabilityClass =
  | 'safe_read'
  | 'safe_local_write'
  | 'external_action_blocked_in_shadow'
  | 'future_phase_not_implemented'
  | 'current_ui_only'
  | 'prototype_only';

export type ShadowExpectation =
  | 'same_as_main'
  | '503_external_action_disabled'
  | 'not_called'
  | 'not_implemented';

export type FuturePhase =
  | 'phase_3'
  | 'phase_5'
  | 'phase_6'
  | 'phase_7'
  | 'phase_8'
  | 'phase_9'
  | 'phase_11';

export type SensitiveScope = 'tenant' | 'client' | 'target' | 'group' | 'user' | 'ethical_wall';

export interface UiCapabilityEntry {
  stateId: string;
  stateLabel: string;
  visibleStage: string;
  menuGroup: string;
  requiredData: string[];
  currentRouteRefs: string[];
  routeManifestKeys: string[];
  capabilityClass: CapabilityClass;
  shadowExpectation: ShadowExpectation;
  futureOwner: FuturePhase;
  futureOwnerNote?: string;
  sensitiveScopes: SensitiveScope[];
  fixtureRequirements: string[];
  observabilityFamily: string;
  gap?: string;
}

/** Route families allowed by the Phase 2 observability contract. */
const OBSERVABILITY_FAMILIES = new Set([
  'meetings',
  'reports',
  'integrations',
  'outreach_records',
  'targets',
  'profiles',
  'context',
  'drafts',
  'preflight',
  'delivery_history',
  'health',
]);

/** The six user-visible stages, plus `any` for states that span all of them. */
const VISIBLE_STAGES = new Set(['Goal', 'Targets', 'Delivery', 'Context', 'Drafts', 'Send', 'any']);

// ─────────────────────────────────────────────────────────── route shorthand

const R = {
  capabilities: 'GET /api/engagement/capabilities',
  meetings: 'GET /api/engagement/meetings',
  meetingDetail: 'GET /api/engagement/meetings/:id',
  reports: 'GET /api/engagement/reports/overview',
  integrations: 'GET /api/engagement/integrations',
  googleCaps: 'GET /api/engagement/integrations/google/capabilities',
  microsoftCaps: 'GET /api/engagement/integrations/microsoft/capabilities',
  outreachList: 'GET /api/engagement/outreach',
  outreachDetail: 'GET /api/engagement/outreach/:id',
  contacts: 'GET /api/engagement/contacts',
  audiences: 'GET /api/engagement/outreach/audiences',
  recentContacts: 'GET /api/engagement/outreach/outbound/contact-data',
  contextClient: 'GET /api/engagement/context/:clientId',
  contextLibrary: 'GET /api/engagement/outreach/context-library',
  draftArtifacts: 'GET /api/engagement/outreach/:outreachRecordId/draft-artifacts',
  draftVersion: 'GET /api/engagement/outreach/draft-versions/:versionId',
  jobStatus: 'GET /api/engagement/outreach/jobs/:id',
  sendIntentRead: 'GET /api/engagement/outreach/send-intents/:id',
  campaigns: 'GET /api/engagement/campaigns',
  campaignDetail: 'GET /api/engagement/campaigns/:id',
  insights: 'GET /api/engagement/outreach/insights',

  // Shadow-denied. Note the first one is a GET that still generates.
  templatePreview: 'GET /api/engagement/outreach/ai-templates/:id/preview',
  genCampaign: 'POST /api/engagement/campaigns/:id/generate',
  genBatch: 'POST /api/engagement/outreach/generate-batch',
  genJob: 'POST /api/engagement/outreach/jobs/generate',
  genDraft: 'POST /api/engagement/outreach/:id/generate-draft',
  genVersion: 'POST /api/engagement/outreach/draft-artifacts/:artifactId/versions',
  genTalkingPoints: 'POST /api/engagement/outreach/insights/talking-points',
  genRetry: 'POST /api/engagement/outreach/jobs/:id/items/:itemId/retry',
  testSend: 'POST /api/engagement/campaigns/:id/send-test',
  sendCampaign: 'POST /api/engagement/campaigns/:id/send',
  sendOutreach: 'POST /api/engagement/outreach/:id/send-campaign',
  sendJob: 'POST /api/engagement/outreach/jobs/send',
  sendBatch: 'POST /api/engagement/outreach/send-batch',
  createSendIntent: 'POST /api/engagement/outreach/send-intents',
} as const;

const GENERATION_ROUTES = [
  R.templatePreview,
  R.genCampaign,
  R.genBatch,
  R.genJob,
  R.genDraft,
  R.genVersion,
  R.genTalkingPoints,
  R.genRetry,
];
const SEND_ROUTES = [
  R.testSend,
  R.sendCampaign,
  R.sendOutreach,
  R.sendJob,
  R.sendBatch,
  R.createSendIntent,
];

/** Gap notes reused across states whose data has no current Engagement route. */
const GAP_DIRECTORY =
  'The Capiro Directory is not part of the Engagement route manifest. Directory search, ' +
  'office expansion and target profiles have no current /api/engagement route. Phase 7 owns ' +
  'the V3 composition; Phase 3 must not claim Directory parity through the preview route.';
const GAP_V3_STATE =
  'No Campaign Spec persistence exists. Phase 2 creates none. Phase 5 owns session, event, ' +
  'checkpoint and canonical state storage.';
const GAP_COVERAGE =
  'Target health and audience-coverage analysis have no current route. Phase 7 owns them.';
const GAP_PREFLIGHT =
  'The thirteen deterministic preflight checks are prototype-side. No current route computes ' +
  'them. Phase 9 owns preflight.';

// ────────────────────────────────────────────────────────────── the matrix

type Row = Omit<UiCapabilityEntry, 'stateLabel' | 'menuGroup' | 'routeManifestKeys'>;

/**
 * One row per prototype state, keyed by the manifest `stateId`.
 *
 * Conventions:
 *   - `currentRouteRefs` may only name routes in the Phase 0 manifest.
 *   - A state with no current route records a `gap` instead of inventing one.
 *   - `futureOwner` is a single phase; where the roadmap says "5–6" or "9/11"
 *     the earlier phase owns the enabling work and `futureOwnerNote` records
 *     the split.
 */
const MATRIX: Record<string, Row> = {
  // ── Flow 1–4 · Goal, read-back, sponsor, criteria ────────────────────────
  'outreach-landing': {
    stateId: 'outreach-landing',
    visibleStage: 'Goal',
    requiredData: ['engagement capabilities for the tenant'],
    currentRouteRefs: [R.capabilities],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_6',
    futureOwnerNote: 'Roadmap says Phase 5–6; Phase 5 owns the state, Phase 6 the shell.',
    sensitiveScopes: ['tenant', 'user'],
    fixtureRequirements: ['a tenant with engagement enabled and no in-progress campaign'],
    observabilityFamily: 'outreach_records',
  },
  'read-back-no-client-required': {
    stateId: 'read-back-no-client-required',
    visibleStage: 'Goal',
    requiredData: ['model interpretation of the typed goal'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    futureOwnerNote: 'Roadmap says Phase 5–6.',
    sensitiveScopes: ['tenant', 'client', 'user', 'ethical_wall'],
    fixtureRequirements: ['a goal string that resolves without a client'],
    observabilityFamily: 'outreach_records',
    gap: GAP_V3_STATE,
  },
  'sponsor-ambiguity': {
    stateId: 'sponsor-ambiguity',
    visibleStage: 'Goal',
    requiredData: ['sponsor scope options', 'clients visible to the user'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    futureOwnerNote: 'Roadmap says Phase 5–6.',
    sensitiveScopes: ['tenant', 'client', 'user', 'ethical_wall'],
    fixtureRequirements: ['a user with at least two clients and one coalition'],
    observabilityFamily: 'outreach_records',
    gap: GAP_V3_STATE,
  },
  'target-criteria': {
    stateId: 'target-criteria',
    visibleStage: 'Targets',
    requiredData: ['criteria derived from the goal'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'target', 'user'],
    fixtureRequirements: ['criteria covering jurisdiction, committee and portfolio'],
    observabilityFamily: 'targets',
    gap: GAP_V3_STATE,
  },

  // ── Flow 5–13 · Targets, directory, contacts, audiences, profile ─────────
  'recommended-targets': {
    stateId: 'recommended-targets',
    visibleStage: 'Targets',
    requiredData: ['ranked target recommendations with reasons'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'client', 'target', 'ethical_wall'],
    fixtureRequirements: ['targets with mixed relationship strength and confidence'],
    observabilityFamily: 'targets',
    gap: GAP_DIRECTORY,
  },
  'directory-search': {
    stateId: 'directory-search',
    visibleStage: 'Targets',
    requiredData: ['directory offices and people matching a query'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target'],
    fixtureRequirements: ['a directory office with staff'],
    observabilityFamily: 'targets',
    gap: GAP_DIRECTORY,
  },
  'expanded-office-with-staff': {
    stateId: 'expanded-office-with-staff',
    visibleStage: 'Targets',
    requiredData: ['staff roster for one office'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target'],
    fixtureRequirements: ['an office with at least three staff and one vacancy'],
    observabilityFamily: 'targets',
    gap: GAP_DIRECTORY,
  },
  'client-contacts-several-clients': {
    stateId: 'client-contacts-several-clients',
    visibleStage: 'Targets',
    requiredData: ['contacts grouped by client'],
    currentRouteRefs: [R.contacts],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'client', 'target', 'ethical_wall'],
    fixtureRequirements: ['two clients with contacts and one ethical-wall separation'],
    observabilityFamily: 'targets',
  },
  'saved-audiences': {
    stateId: 'saved-audiences',
    visibleStage: 'Targets',
    requiredData: ['saved audience lists'],
    currentRouteRefs: [R.audiences],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'group', 'user'],
    fixtureRequirements: ['at least one saved audience owned by the test user'],
    observabilityFamily: 'targets',
  },
  'manual-target-entry': {
    stateId: 'manual-target-entry',
    visibleStage: 'Targets',
    requiredData: ['a manually typed name, role, office and address'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target'],
    fixtureRequirements: ['a manual target with an unverified address'],
    observabilityFamily: 'targets',
    gap: GAP_V3_STATE,
  },
  'selected-targets-and-health': {
    stateId: 'selected-targets-and-health',
    visibleStage: 'Targets',
    requiredData: ['selected targets with health indicators'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'client', 'target', 'ethical_wall'],
    fixtureRequirements: ['targets covering verified, missing-email and stale-role health'],
    observabilityFamily: 'targets',
    gap: GAP_COVERAGE,
  },
  'target-profile': {
    stateId: 'target-profile',
    visibleStage: 'Targets',
    requiredData: ['identity, relationship, intelligence and personalization safety'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'client', 'target', 'user', 'ethical_wall'],
    fixtureRequirements: [
      'a profile with verified, needs-confirmation, stale, conflicting and restricted facts',
    ],
    observabilityFamily: 'profiles',
    gap: GAP_DIRECTORY,
  },
  'coverage-gap-review': {
    stateId: 'coverage-gap-review',
    visibleStage: 'Targets',
    requiredData: ['audience coverage analysis against the goal'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'client', 'target', 'group'],
    fixtureRequirements: ['a selection missing majority policy and appropriations coverage'],
    observabilityFamily: 'targets',
    gap: GAP_COVERAGE,
  },

  // ── Flow 14–16 · Delivery, context, strategy ─────────────────────────────
  'delivery-recommendation': {
    stateId: 'delivery-recommendation',
    visibleStage: 'Delivery',
    requiredData: ['delivery pattern options and the recommended one'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_8',
    sensitiveScopes: ['tenant', 'group', 'target'],
    fixtureRequirements: ['a twelve-target campaign where personalized is recommended'],
    observabilityFamily: 'delivery_history',
    gap: GAP_V3_STATE,
  },
  'context-recommendations': {
    stateId: 'context-recommendations',
    visibleStage: 'Context',
    requiredData: ['governed context items by category with scope and exclusions'],
    currentRouteRefs: [R.contextClient, R.contextLibrary],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_8',
    sensitiveScopes: ['tenant', 'client', 'target', 'ethical_wall'],
    fixtureRequirements: [
      'context items in every category plus one excluded for wrong client',
    ],
    observabilityFamily: 'context',
  },
  'strategy-review': {
    stateId: 'strategy-review',
    visibleStage: 'Drafts',
    requiredData: ['assembled campaign plan for review'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_8',
    sensitiveScopes: ['tenant', 'client', 'target', 'group', 'ethical_wall'],
    fixtureRequirements: ['a plan line per send unit with context and target health'],
    observabilityFamily: 'drafts',
    gap: GAP_V3_STATE,
  },

  // ── Flow 17–19 · Samples and drafts ──────────────────────────────────────
  'representative-samples': {
    stateId: 'representative-samples',
    visibleStage: 'Drafts',
    requiredData: ['generated sample drafts'],
    currentRouteRefs: GENERATION_ROUTES,
    capabilityClass: 'external_action_blocked_in_shadow',
    shadowExpectation: '503_external_action_disabled',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target', 'ethical_wall'],
    fixtureRequirements: ['targets spanning relationship, no-relationship and other office'],
    observabilityFamily: 'drafts',
  },
  'draft-summary-12-drafts': {
    stateId: 'draft-summary-12-drafts',
    visibleStage: 'Drafts',
    requiredData: ['draft artifacts and immutable versions with status'],
    currentRouteRefs: [R.draftArtifacts, R.draftVersion, R.jobStatus],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target', 'user'],
    fixtureRequirements: ['twelve drafts with mixed statuses'],
    observabilityFamily: 'drafts',
  },
  'exception-review': {
    stateId: 'exception-review',
    visibleStage: 'Drafts',
    requiredData: ['drafts filtered to the exception set'],
    currentRouteRefs: [R.draftArtifacts, R.draftVersion],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: ['one held, one missing-address and one failed draft'],
    observabilityFamily: 'drafts',
  },

  // ── Flow 20–22 · Preflight and send ──────────────────────────────────────
  'preflight-nothing-eligible-yet': {
    stateId: 'preflight-nothing-eligible-yet',
    visibleStage: 'Send',
    requiredData: ['deterministic preflight checks with nothing eligible'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target', 'user'],
    fixtureRequirements: ['a campaign where no draft is approved'],
    observabilityFamily: 'preflight',
    gap: GAP_PREFLIGHT,
  },
  'preflight-partial-send-ready': {
    stateId: 'preflight-partial-send-ready',
    visibleStage: 'Send',
    requiredData: ['preflight with some eligible and some held-out drafts'],
    currentRouteRefs: SEND_ROUTES,
    capabilityClass: 'external_action_blocked_in_shadow',
    shadowExpectation: '503_external_action_disabled',
    futureOwner: 'phase_11',
    futureOwnerNote: 'Roadmap says Phase 9/11; Phase 9 builds it, Phase 11 canaries it.',
    sensitiveScopes: ['tenant', 'client', 'target', 'group', 'user'],
    fixtureRequirements: ['nine eligible and three held-out drafts'],
    observabilityFamily: 'preflight',
  },
  'post-send-partial-failure': {
    stateId: 'post-send-partial-failure',
    visibleStage: 'Send',
    requiredData: ['send-intent outcomes including a failure'],
    currentRouteRefs: [R.sendIntentRead, R.outreachDetail],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target', 'user'],
    fixtureRequirements: ['a send intent with delivered, bounced and unknown outcomes'],
    observabilityFamily: 'delivery_history',
  },

  // ── New in this version ──────────────────────────────────────────────────
  'bottom-chat-bar-conversation-led-flow': {
    stateId: 'bottom-chat-bar-conversation-led-flow',
    visibleStage: 'any',
    requiredData: [],
    currentRouteRefs: [],
    capabilityClass: 'prototype_only',
    shadowExpectation: 'not_called',
    futureOwner: 'phase_6',
    sensitiveScopes: [],
    fixtureRequirements: [],
    observabilityFamily: 'health',
    gap: 'Visual contract only. No backend capability.',
  },
  'express-path-meri-takes-it-from-here': {
    stateId: 'express-path-meri-takes-it-from-here',
    visibleStage: 'Goal',
    requiredData: ['a proposed setup covering criteria, delivery and sources'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'user'],
    fixtureRequirements: ['a goal that yields a complete proposed setup'],
    observabilityFamily: 'outreach_records',
    gap: GAP_V3_STATE,
  },
  'express-path-already-running': {
    stateId: 'express-path-already-running',
    visibleStage: 'Drafts',
    requiredData: ['a campaign advanced to strategy by the express path'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'client', 'target', 'user'],
    fixtureRequirements: ['a campaign with criteria, delivery and sources preset'],
    observabilityFamily: 'outreach_records',
    gap: GAP_V3_STATE,
  },
  'typed-instruction-pending-proposal': {
    stateId: 'typed-instruction-pending-proposal',
    visibleStage: 'Targets',
    requiredData: ['a parsed instruction with named effects awaiting Apply'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    futureOwnerNote: 'Roadmap says Phase 5–6. The allowlisted command boundary is Phase 5 work.',
    sensitiveScopes: ['tenant', 'target', 'user'],
    fixtureRequirements: ['an instruction naming four high-confidence targets'],
    observabilityFamily: 'targets',
    gap: GAP_V3_STATE,
  },
  'resumed-two-days-later': {
    stateId: 'resumed-two-days-later',
    visibleStage: 'Context',
    requiredData: ['a checkpoint restored with targets, decisions and approvals'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'client', 'target', 'user'],
    fixtureRequirements: ['a campaign checkpoint at least two days old'],
    observabilityFamily: 'outreach_records',
    gap: GAP_V3_STATE,
  },
  'generation-interrupted-at-7-of-12': {
    stateId: 'generation-interrupted-at-7-of-12',
    visibleStage: 'Drafts',
    requiredData: ['job status showing partial completion'],
    currentRouteRefs: [R.jobStatus, R.draftArtifacts],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: ['a generation job stopped after seven of twelve items'],
    observabilityFamily: 'drafts',
  },
  'draft-sources-view-line-provenance': {
    stateId: 'draft-sources-view-line-provenance',
    visibleStage: 'Drafts',
    requiredData: ['per-line provenance for a draft version'],
    currentRouteRefs: [R.draftVersion, R.draftArtifacts],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: ['a draft version with grounded source attribution per line'],
    observabilityFamily: 'drafts',
  },
  'post-send-learning-proposals': {
    stateId: 'post-send-learning-proposals',
    visibleStage: 'Send',
    requiredData: ['post-send outcomes and proposed memory writes'],
    currentRouteRefs: [R.sendIntentRead],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_11',
    futureOwnerNote:
      'The roadmap defers governed memory writes to the separate institutional-memory ' +
      'remediation, outside the numbered phases. No memory write may occur in Phase 2.',
    sensitiveScopes: ['tenant', 'client', 'target', 'user'],
    fixtureRequirements: ['a completed send with at least one learning proposal'],
    observabilityFamily: 'delivery_history',
  },
  'scenario-coalition-to-federal-agency': {
    stateId: 'scenario-coalition-to-federal-agency',
    visibleStage: 'any',
    requiredData: ['a coalition sponsor writing to agency staff'],
    currentRouteRefs: [],
    capabilityClass: 'prototype_only',
    shadowExpectation: 'not_called',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'client', 'group', 'ethical_wall'],
    fixtureRequirements: ['a coalition with member companies and agency targets'],
    observabilityFamily: 'outreach_records',
    gap: 'Fictional scenario dataset. Phase 3 must create an equivalent fixture, not reuse prototype data.',
  },
  'scenario-firm-to-congressional-default': {
    stateId: 'scenario-firm-to-congressional-default',
    visibleStage: 'any',
    requiredData: ['a firm sponsor writing to congressional staff'],
    currentRouteRefs: [],
    capabilityClass: 'prototype_only',
    shadowExpectation: 'not_called',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: ['a firm-sponsored campaign to committee staff'],
    observabilityFamily: 'outreach_records',
    gap: 'Fictional scenario dataset. Phase 3 must create an equivalent fixture, not reuse prototype data.',
  },

  // ── Target and context edge cases ────────────────────────────────────────
  'missing-target-email': {
    stateId: 'missing-target-email',
    visibleStage: 'Targets',
    requiredData: ['a target with no verified address'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target'],
    fixtureRequirements: ['a selected target with no verified address'],
    observabilityFamily: 'targets',
    gap: GAP_COVERAGE,
  },
  'stale-target-role': {
    stateId: 'stale-target-role',
    visibleStage: 'Targets',
    requiredData: ['a target whose role verification is old'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target'],
    fixtureRequirements: ['a target verified more than twelve months ago'],
    observabilityFamily: 'profiles',
    gap: GAP_DIRECTORY,
  },
  'no-prior-relationship': {
    stateId: 'no-prior-relationship',
    visibleStage: 'Targets',
    requiredData: ['a target with no interaction history'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target', 'user'],
    fixtureRequirements: ['a target with an empty relationship history'],
    observabilityFamily: 'profiles',
    gap: GAP_DIRECTORY,
  },
  'excluded-context-wrong-client': {
    stateId: 'excluded-context-wrong-client',
    visibleStage: 'Context',
    requiredData: ['a context item excluded because it belongs to another client'],
    currentRouteRefs: [R.contextClient],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_8',
    sensitiveScopes: ['tenant', 'client', 'ethical_wall'],
    fixtureRequirements: ['two clients whose context must not commingle'],
    observabilityFamily: 'context',
  },
  'target-specific-context': {
    stateId: 'target-specific-context',
    visibleStage: 'Context',
    requiredData: ['a context item scoped to exactly one target'],
    currentRouteRefs: [R.contextClient, R.contextLibrary],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_8',
    sensitiveScopes: ['tenant', 'client', 'target', 'ethical_wall'],
    fixtureRequirements: ['a prior interaction belonging to one target only'],
    observabilityFamily: 'context',
  },
  'held-draft-claim-level-remediation': {
    stateId: 'held-draft-claim-level-remediation',
    visibleStage: 'Drafts',
    requiredData: ['a held draft with the unsupported claim identified'],
    currentRouteRefs: [R.draftVersion, R.draftArtifacts],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: ['a draft held for an unsupported figure'],
    observabilityFamily: 'drafts',
  },
  'dirty-draft-approval-cleared-by-an-edit': {
    stateId: 'dirty-draft-approval-cleared-by-an-edit',
    visibleStage: 'Drafts',
    requiredData: ['a draft whose approval was cleared by a later edit'],
    currentRouteRefs: [R.draftVersion, R.draftArtifacts],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target', 'user'],
    fixtureRequirements: ['an approved draft edited into a new version'],
    observabilityFamily: 'drafts',
  },
  'stale-drafts-upstream-change': {
    stateId: 'stale-drafts-upstream-change',
    visibleStage: 'Drafts',
    requiredData: ['drafts invalidated by an upstream change'],
    currentRouteRefs: [R.draftVersion, R.draftArtifacts],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: ['drafts marked stale after a target-set change'],
    observabilityFamily: 'drafts',
  },
  'audit-trail-unavailable': {
    stateId: 'audit-trail-unavailable',
    visibleStage: 'Drafts',
    requiredData: ['a draft whose grounding audit cannot be read'],
    currentRouteRefs: [R.draftVersion],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: ['a draft version whose audit record is unavailable'],
    observabilityFamily: 'drafts',
  },
  'sponsor-several-clients': {
    stateId: 'sponsor-several-clients',
    visibleStage: 'Goal',
    requiredData: ['a shared position across several clients'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'client', 'group', 'ethical_wall'],
    fixtureRequirements: ['two clients approving a shared position'],
    observabilityFamily: 'outreach_records',
    gap: GAP_V3_STATE,
  },
  'sponsor-coalition': {
    stateId: 'sponsor-coalition',
    visibleStage: 'Goal',
    requiredData: ['a named coalition sponsor'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'client', 'group', 'ethical_wall'],
    fixtureRequirements: ['a coalition whose member context stays with each member'],
    observabilityFamily: 'outreach_records',
    gap: GAP_V3_STATE,
  },
  'sponsor-internal-only-blocks-sending': {
    stateId: 'sponsor-internal-only-blocks-sending',
    visibleStage: 'Send',
    requiredData: ['an internal-only sponsor that blocks external delivery'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'client', 'user', 'group', 'ethical_wall'],
    fixtureRequirements: ['an internal sponsor with only internal recipients'],
    observabilityFamily: 'preflight',
    gap: GAP_V3_STATE,
  },

  // ── Empty ────────────────────────────────────────────────────────────────
  'no-targets-selected': {
    stateId: 'no-targets-selected',
    visibleStage: 'Targets',
    requiredData: ['an empty selection'],
    currentRouteRefs: [],
    capabilityClass: 'prototype_only',
    shadowExpectation: 'not_called',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target'],
    fixtureRequirements: ['a campaign with no targets selected'],
    observabilityFamily: 'targets',
    gap: 'Empty-state rendering only. No backend capability.',
  },
  'no-recommendations-found': {
    stateId: 'no-recommendations-found',
    visibleStage: 'Targets',
    requiredData: ['an empty recommendation result'],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target'],
    fixtureRequirements: ['criteria that match no target'],
    observabilityFamily: 'targets',
    gap: GAP_DIRECTORY,
  },
  'no-saved-audiences': {
    stateId: 'no-saved-audiences',
    visibleStage: 'Targets',
    requiredData: ['an empty saved-audience list'],
    currentRouteRefs: [R.audiences],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'user'],
    fixtureRequirements: ['a tenant with no saved audience'],
    observabilityFamily: 'targets',
  },

  // ── Loading ──────────────────────────────────────────────────────────────
  'meri-interpreting-the-request': {
    stateId: 'meri-interpreting-the-request',
    visibleStage: 'Goal',
    requiredData: [],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant'],
    fixtureRequirements: [],
    observabilityFamily: 'outreach_records',
    gap: GAP_V3_STATE,
  },
  'searching-the-directory': {
    stateId: 'searching-the-directory',
    visibleStage: 'Targets',
    requiredData: [],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant'],
    fixtureRequirements: [],
    observabilityFamily: 'targets',
    gap: GAP_DIRECTORY,
  },
  'loading-a-target-profile': {
    stateId: 'loading-a-target-profile',
    visibleStage: 'Targets',
    requiredData: [],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target'],
    fixtureRequirements: [],
    observabilityFamily: 'profiles',
    gap: GAP_DIRECTORY,
  },
  'generating-samples': {
    stateId: 'generating-samples',
    visibleStage: 'Drafts',
    requiredData: [],
    currentRouteRefs: GENERATION_ROUTES,
    capabilityClass: 'external_action_blocked_in_shadow',
    shadowExpectation: '503_external_action_disabled',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: [],
    observabilityFamily: 'drafts',
  },
  'generating-remaining-drafts': {
    stateId: 'generating-remaining-drafts',
    visibleStage: 'Drafts',
    requiredData: [],
    currentRouteRefs: GENERATION_ROUTES,
    capabilityClass: 'external_action_blocked_in_shadow',
    shadowExpectation: '503_external_action_disabled',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: [],
    observabilityFamily: 'drafts',
  },
  'sending-the-campaign': {
    stateId: 'sending-the-campaign',
    visibleStage: 'Send',
    requiredData: [],
    currentRouteRefs: SEND_ROUTES,
    capabilityClass: 'external_action_blocked_in_shadow',
    shadowExpectation: '503_external_action_disabled',
    futureOwner: 'phase_11',
    futureOwnerNote: 'Roadmap says Phase 9/11.',
    sensitiveScopes: ['tenant', 'client', 'target', 'user'],
    fixtureRequirements: [],
    observabilityFamily: 'delivery_history',
  },

  // ── Error and timeout ────────────────────────────────────────────────────
  'directory-search-failed': {
    stateId: 'directory-search-failed',
    visibleStage: 'Targets',
    requiredData: [],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant'],
    fixtureRequirements: ['a directory backend failure'],
    observabilityFamily: 'targets',
    gap: GAP_DIRECTORY,
  },
  'target-profile-failed-to-load': {
    stateId: 'target-profile-failed-to-load',
    visibleStage: 'Targets',
    requiredData: [],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_7',
    sensitiveScopes: ['tenant', 'target'],
    fixtureRequirements: ['a profile read failure scoped to one target'],
    observabilityFamily: 'profiles',
    gap: GAP_DIRECTORY,
  },
  'one-draft-failed-to-generate': {
    stateId: 'one-draft-failed-to-generate',
    visibleStage: 'Drafts',
    requiredData: ['job item status for the failed draft'],
    currentRouteRefs: [R.jobStatus],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client', 'target'],
    fixtureRequirements: ['a job with one failed item'],
    observabilityFamily: 'drafts',
  },
  'critical-context-failure': {
    stateId: 'critical-context-failure',
    visibleStage: 'Context',
    requiredData: ['a required context item that cannot be loaded'],
    currentRouteRefs: [R.contextClient],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_8',
    sensitiveScopes: ['tenant', 'client', 'ethical_wall'],
    fixtureRequirements: ['a required policy item that fails to load'],
    observabilityFamily: 'context',
  },
  'autosave-failed': {
    stateId: 'autosave-failed',
    visibleStage: 'any',
    requiredData: [],
    currentRouteRefs: [],
    capabilityClass: 'future_phase_not_implemented',
    shadowExpectation: 'not_implemented',
    futureOwner: 'phase_5',
    sensitiveScopes: ['tenant', 'user'],
    fixtureRequirements: ['a campaign save failure'],
    observabilityFamily: 'outreach_records',
    gap: GAP_V3_STATE,
  },
  'generation-taking-longer-than-expected': {
    stateId: 'generation-taking-longer-than-expected',
    visibleStage: 'Drafts',
    requiredData: ['job status past the expected budget'],
    currentRouteRefs: [R.jobStatus],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_9',
    sensitiveScopes: ['tenant', 'client'],
    fixtureRequirements: ['a long-running generation job'],
    observabilityFamily: 'drafts',
  },

  // ── System ───────────────────────────────────────────────────────────────
  'meri-unavailable-options-still-work': {
    stateId: 'meri-unavailable-options-still-work',
    visibleStage: 'any',
    requiredData: ['deterministic controls remain usable without the model'],
    currentRouteRefs: [R.capabilities],
    capabilityClass: 'safe_read',
    shadowExpectation: 'same_as_main',
    futureOwner: 'phase_6',
    sensitiveScopes: ['tenant'],
    fixtureRequirements: ['a tenant with the model provider unavailable'],
    observabilityFamily: 'health',
  },
  'mobile-stacked-layout': {
    stateId: 'mobile-stacked-layout',
    visibleStage: 'any',
    requiredData: [],
    currentRouteRefs: [],
    capabilityClass: 'prototype_only',
    shadowExpectation: 'not_called',
    futureOwner: 'phase_6',
    futureOwnerNote: 'Roadmap says Phase 6–9 as each surface is built.',
    sensitiveScopes: [],
    fixtureRequirements: [],
    observabilityFamily: 'health',
    gap: 'Responsive contract only. No backend capability.',
  },
  'implementation-notes': {
    stateId: 'implementation-notes',
    visibleStage: 'any',
    requiredData: [],
    currentRouteRefs: [],
    capabilityClass: 'prototype_only',
    shadowExpectation: 'not_called',
    futureOwner: 'phase_6',
    sensitiveScopes: [],
    fixtureRequirements: [],
    observabilityFamily: 'health',
    gap: 'Prototype documentation surface. Never shipped.',
  },
};

// ───────────────────────────────────────────────────────────────── verifier

export interface PrototypeManifest {
  prototypeSha256: string;
  [bucket: string]: unknown;
}

export interface CapabilityManifest {
  schemaVersion: number;
  prototypeSha256: string;
  prototypeStateCount: number;
  extractedAt: null;
  phase: number;
  note: string;
  entries: UiCapabilityEntry[];
}

export interface RouteManifest {
  routes: Array<{
    method: string;
    path: string;
    controller: string;
    handler: string;
    classification: string;
  }>;
}

interface PrototypeState {
  id: string;
  label: string;
  menuGroup: string;
}

const STATE_BUCKETS = [
  'primaryFlowStates',
  'edgeStates',
  'loadingStates',
  'errorStates',
  'emptyStates',
  'systemStates',
] as const;

/** Routes carrying Phase 1 runtime-action metadata, keyed by "METHOD path". */
function shadowBlockedRoutes(routes: RouteManifest['routes']): Map<string, string> {
  const policy = ENGAGEMENT_RUNTIME_ROUTE_POLICY as Record<
    string,
    Record<string, { action: string }>
  >;
  const blocked = new Map<string, string>();
  for (const route of routes) {
    const meta = policy[route.controller]?.[route.handler];
    if (meta) blocked.set(`${route.method} ${route.path}`, meta.action);
  }
  return blocked;
}

export function buildCapabilityManifest(
  prototype: PrototypeManifest,
  _routeManifest: RouteManifest,
) {
  const states = STATE_BUCKETS.flatMap((b) => (prototype[b] as PrototypeState[]) ?? []);
  const entries: UiCapabilityEntry[] = states.map((state) => {
    const row = MATRIX[state.id];
    if (!row) {
      throw new Error(`No capability entry for prototype state "${state.id}" (${state.label})`);
    }
    return {
      ...row,
      stateLabel: state.label,
      menuGroup: state.menuGroup,
      routeManifestKeys: [...row.currentRouteRefs].sort(),
    };
  });

  return {
    schemaVersion: 1,
    prototypeSha256: prototype.prototypeSha256,
    prototypeStateCount: states.length,
    extractedAt: null,
    phase: 2,
    note:
      'Phase 2 behaviour and future ownership for every Outreach V3 prototype state. ' +
      'No entry claims V3 functionality is implemented. Phase 2 ships no V3 UI.',
    entries,
  };
}

export function verifyCapabilityManifest(
  manifest: CapabilityManifest,
  prototype: PrototypeManifest,
  routeManifest: RouteManifest,
): string[] {
  const known = new Set(routeManifest.routes.map((r) => `${r.method} ${r.path}`));
  const blocked = shadowBlockedRoutes(routeManifest.routes);
  const states = STATE_BUCKETS.flatMap((b) => (prototype[b] as PrototypeState[]) ?? []);
  const failures: string[] = [];

  // 1. exactly one entry per prototype state
  const byState = new Map<string, UiCapabilityEntry[]>();
  for (const entry of manifest.entries) {
    const list = byState.get(entry.stateId) ?? [];
    list.push(entry);
    byState.set(entry.stateId, list);
  }
  for (const state of states) {
    const found = byState.get(state.id) ?? [];
    if (found.length === 0) failures.push(`state "${state.id}" has no capability entry`);
    if (found.length > 1) failures.push(`state "${state.id}" has ${found.length} entries`);
  }
  const stateIds = new Set(states.map((s) => s.id));
  for (const entry of manifest.entries) {
    if (!stateIds.has(entry.stateId)) {
      failures.push(`entry "${entry.stateId}" does not match any prototype state`);
    }
  }
  if (manifest.prototypeSha256 !== prototype.prototypeSha256) {
    failures.push('capability manifest prototype SHA-256 does not match the prototype contract');
  }

  for (const entry of manifest.entries) {
    const where = `entry "${entry.stateId}"`;

    // 2. every referenced route exists in the Phase 0 route manifest
    for (const ref of entry.currentRouteRefs) {
      if (!known.has(ref)) failures.push(`${where} references unknown route "${ref}"`);
    }

    // 3. every shadow-blocked route carries Phase 1 runtime-action metadata
    if (entry.capabilityClass === 'external_action_blocked_in_shadow') {
      if (entry.currentRouteRefs.length === 0) {
        failures.push(`${where} is shadow-blocked but names no route`);
      }
      for (const ref of entry.currentRouteRefs) {
        if (!blocked.has(ref)) {
          failures.push(`${where} shadow-blocks "${ref}" which has no Phase 1 runtime-action metadata`);
        }
      }
      if (entry.shadowExpectation !== '503_external_action_disabled') {
        failures.push(`${where} is shadow-blocked but expects "${entry.shadowExpectation}"`);
      }
    }

    // 4. no send or generation route may be classified as a safe read or local write
    if (entry.capabilityClass === 'safe_read' || entry.capabilityClass === 'safe_local_write') {
      for (const ref of entry.currentRouteRefs) {
        if (blocked.has(ref)) {
          failures.push(
            `${where} classifies "${ref}" as ${entry.capabilityClass}, but it is a Phase 1 ` +
              `external action (${blocked.get(ref)})`,
          );
        }
      }
      if (entry.shadowExpectation !== 'same_as_main') {
        failures.push(`${where} is a safe read but expects "${entry.shadowExpectation}"`);
      }
    }

    // 5. target-specific states must declare target scope
    if (/target|profile|recommend/.test(entry.stateId) && !entry.sensitiveScopes.includes('target')) {
      failures.push(`${where} is target-specific but does not declare target scope`);
    }

    // 6. multi-client and context states must declare client and ethical-wall scope
    if (/client|context|sponsor|coalition/.test(entry.stateId)) {
      if (!entry.sensitiveScopes.includes('client')) {
        failures.push(`${where} touches client context but does not declare client scope`);
      }
      if (!entry.sensitiveScopes.includes('ethical_wall')) {
        failures.push(`${where} touches client context but does not declare ethical_wall scope`);
      }
    }

    // 7. every state has exactly one future owner
    if (!entry.futureOwner) failures.push(`${where} has no future owner`);

    // 8. nothing claims V3 is implemented, and observability stays in-contract
    if (!VISIBLE_STAGES.has(entry.visibleStage)) {
      failures.push(`${where} has unknown visible stage "${entry.visibleStage}"`);
    }
    if (!OBSERVABILITY_FAMILIES.has(entry.observabilityFamily)) {
      failures.push(`${where} uses unknown observability family "${entry.observabilityFamily}"`);
    }
    if (entry.capabilityClass === 'current_ui_only' && entry.currentRouteRefs.length === 0) {
      failures.push(`${where} claims current UI support but names no route`);
    }
    if (entry.currentRouteRefs.length === 0 && entry.capabilityClass === 'safe_read') {
      failures.push(`${where} claims a safe read but names no route`);
    }
    if (entry.currentRouteRefs.length === 0 && !entry.gap) {
      failures.push(`${where} has no route and no documented gap`);
    }
  }

  return failures;
}
