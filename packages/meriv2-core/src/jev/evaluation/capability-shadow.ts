import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i, 'expected a SHA-256 digest');
const slugSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const versionSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}\.v[1-9][0-9]{0,3}$/);

const attemptStatus = ['not_attempted', 'attempted', 'dispatched', 'settled', 'cancelled', 'timeout', 'error'] as const;
const sampleCategorySchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const tenantPseudonymVersionSchema = z.string().regex(/^tenant_hmac\.v[1-9][0-9]{0,2}$/);
const evaluationUnitVersionSchema = z.string().regex(/^eval_unit_hmac\.v[1-9][0-9]{0,2}$/);

const membershipAssignmentSchema = z.object({
  turnKeyHash: hashSchema,
  evaluationUnitHash: hashSchema,
  evaluationUnitKeyVersion: evaluationUnitVersionSchema,
  tenantPseudonymHash: hashSchema,
  tenantPseudonymKeyVersion: tenantPseudonymVersionSchema,
  eligibleSelected: z.boolean(),
  eligibilityReason: sampleCategorySchema.nullable(),
  source: z.enum(['live', 'replay']),
  cohort: z.enum(['representative', 'targeted', 'fixture']),
  split: z.enum(['exploratory', 'tuning', 'heldout']),
  surface: sampleCategorySchema,
  domain: sampleCategorySchema,
  taskFamily: sampleCategorySchema,
}).strict().superRefine((assignment, context) => {
  if (assignment.eligibleSelected && assignment.eligibilityReason !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['eligibilityReason'], message: 'eligible selections cannot have an ineligible reason' });
  }
  if (!assignment.eligibleSelected && assignment.eligibilityReason === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['eligibilityReason'], message: 'ineligible selections require a reason code' });
  }
});

export const capabilityShadowMembershipPayloadSchema = z.object({
  version: z.literal('meri_capability_shadow_membership.v1'),
  keyId: slugSchema,
  versions: z.object({
    catalog: versionSchema,
    routingModel: versionSchema,
    question: versionSchema,
    policy: versionSchema,
    selectionPolicy: versionSchema,
  }).strict(),
  registry: z.object({
    surfaces: z.array(sampleCategorySchema).min(1),
    domains: z.array(sampleCategorySchema).min(1),
    taskFamilies: z.array(sampleCategorySchema).min(1),
    routes: z.array(sampleCategorySchema).min(1),
    tools: z.array(sampleCategorySchema).min(1),
    reasonCodes: z.array(sampleCategorySchema).min(1),
  }).strict().superRefine((registry, context) => {
    for (const field of ['surfaces', 'domains', 'taskFamilies', 'routes', 'tools', 'reasonCodes'] as const) {
      if (new Set(registry[field]).size !== registry[field].length) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'allowlist values must be unique' });
      }
    }
  }),
  assignments: z.array(membershipAssignmentSchema).min(1),
}).strict();

export const capabilityShadowMembershipManifestSchema = z.object({
  payload: capabilityShadowMembershipPayloadSchema,
  signatureBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export type CapabilityShadowMembershipPayload = z.infer<typeof capabilityShadowMembershipPayloadSchema>;
export type CapabilityShadowMembershipManifest = z.infer<typeof capabilityShadowMembershipManifestSchema>;

const attemptSchema = z.object({
  status: z.enum(attemptStatus),
  attemptedAt: z.string().datetime({ offset: true }).nullable(),
  dispatchedAt: z.string().datetime({ offset: true }).nullable(),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  durationMs: z.number().finite().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(),
}).strict().superRefine((attempt, context) => {
  const censored = ['cancelled', 'timeout', 'error'].includes(attempt.status);
  if (attempt.status === 'not_attempted') {
    if (attempt.attemptedAt !== null || attempt.dispatchedAt !== null || attempt.finishedAt !== null || attempt.durationMs !== null || attempt.inputTokens !== null || attempt.outputTokens !== null || attempt.costUsd !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'not_attempted records must have null timestamps and measurements' });
    }
    return;
  }
  if (attempt.attemptedAt === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['attemptedAt'], message: 'attempted records require attempt time' });
  if (attempt.status === 'attempted' && (attempt.dispatchedAt !== null || attempt.finishedAt !== null || attempt.durationMs !== null || attempt.costUsd !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'attempted-but-undispatched records cannot have dispatch or terminal measurements' });
  }
  // A local cancellation/timeout/error may finish before provider dispatch.
  // Its duration measures the local attempt, not provider latency or billing.
  // Only settled attempts enter the latency percentile, and an undispatched
  // terminal record still cannot claim provider tokens or cost.
  if (['dispatched', 'settled'].includes(attempt.status) && attempt.dispatchedAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dispatchedAt'], message: 'dispatched and settled records require dispatch time' });
  }
  if (attempt.dispatchedAt === null && (attempt.inputTokens !== null || attempt.outputTokens !== null || attempt.costUsd !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'undispatched records cannot report provider usage or cost' });
  }
  if (attempt.status === 'dispatched' && (attempt.finishedAt !== null || attempt.durationMs !== null || attempt.costUsd !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'dispatched records are in-flight and cannot have terminal measurements' });
  }
  if (['settled', 'cancelled', 'timeout', 'error'].includes(attempt.status)
    && (attempt.finishedAt === null || attempt.durationMs === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'terminal records require finish time and duration' });
  }
  if (attempt.attemptedAt !== null && attempt.dispatchedAt !== null
    && Date.parse(attempt.dispatchedAt) < Date.parse(attempt.attemptedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dispatchedAt'], message: 'dispatch time cannot precede attempt time' });
  }
  if (attempt.finishedAt !== null && (Date.parse(attempt.finishedAt) < Date.parse(attempt.dispatchedAt ?? attempt.attemptedAt ?? '')
    || Date.parse(attempt.finishedAt) < Date.parse(attempt.attemptedAt ?? ''))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['finishedAt'], message: 'finish time cannot precede attempt or dispatch time' });
  }
  if (censored && attempt.costUsd !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['costUsd'], message: 'censored attempts must report unknown cost as null' });
  }
  if (attempt.status === 'settled' && attempt.dispatchedAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dispatchedAt'], message: 'settled records require a dispatched provider request' });
  }
});

/**
 * Content-free, one-record-per-sampled-turn event for capability-routing shadow.
 * The baseline remains the only executor; `candidate` is a proposal and must
 * never be interpreted as an execution receipt.
 */
export const capabilityShadowEventSchema = z.object({
  event: z.literal('meri.capability_shadow.turn'),
  schemaVersion: z.literal(1),
  eventId: hashSchema,
  turnKeyHash: hashSchema,
  evaluationUnitHash: hashSchema,
  evaluationUnitKeyVersion: evaluationUnitVersionSchema,
  tenantPseudonymKeyVersion: tenantPseudonymVersionSchema,
  tenantPseudonymHash: hashSchema,
  occurredAt: z.string().datetime({ offset: true }),
  sample: z.object({
    source: z.enum(['live', 'replay']),
    cohort: z.enum(['representative', 'targeted', 'fixture']),
    split: z.enum(['exploratory', 'tuning', 'heldout']),
    membershipManifestDigest: hashSchema,
    selectionPolicyVersion: versionSchema,
    surface: sampleCategorySchema,
    domain: sampleCategorySchema,
    taskFamily: sampleCategorySchema,
  }).strict(),
  versions: z.object({
    catalog: versionSchema,
    routingModel: versionSchema,
    question: versionSchema,
    policy: versionSchema,
  }).strict(),
  route: z.object({
    eligible: z.boolean(),
    ineligibleReason: sampleCategorySchema.nullable(),
    baseline: sampleCategorySchema.nullable(),
    candidate: sampleCategorySchema.nullable(),
    confidence: z.number().finite().min(0).max(1).nullable(),
    fallbackReason: sampleCategorySchema.nullable(),
  }).strict().superRefine((route, context) => {
    if (route.eligible && route.baseline === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['baseline'], message: 'eligible routes require a baseline' });
    }
    if (route.eligible && (route.candidate === null) !== (route.confidence === null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'candidate route and confidence must be present together' });
    }
    if (route.eligible && route.candidate === null && route.fallbackReason === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['fallbackReason'], message: 'eligible turns without a candidate require an explicit fallback reason' });
    }
    if (route.eligible && route.candidate !== null && route.fallbackReason !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['fallbackReason'], message: 'candidate proposals cannot also report a fallback' });
    }
    if (!route.eligible && (route.candidate !== null || route.confidence !== null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'ineligible turns must not contain a candidate route or confidence' });
    }
    if (route.eligible && route.ineligibleReason !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'eligible turns cannot have an ineligible reason' });
    }
    if (!route.eligible && route.ineligibleReason === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'ineligible turns require a reason code' });
    }
  }),
  tools: z.object({
    required: z.array(sampleCategorySchema),
    candidateExposed: z.array(sampleCategorySchema),
    baselineExposed: z.array(sampleCategorySchema),
    baselineUsed: z.array(sampleCategorySchema),
  }).strict().superRefine((tools, context) => {
    for (const field of ['required', 'candidateExposed', 'baselineExposed', 'baselineUsed'] as const) {
      if (new Set(tools[field]).size !== tools[field].length) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'tool names must be unique' });
      }
    }
    if (tools.baselineUsed.some((tool) => !tools.baselineExposed.includes(tool))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['baselineUsed'], message: 'executed baseline tools must have been exposed' });
    }
  }),
  execution: z.object({
    executor: z.literal('baseline'),
    baseline: attemptSchema,
    jev: attemptSchema,
  }).strict(),
}).strict().superRefine((event, context) => {
  if (event.route.candidate === null && event.tools.candidateExposed.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['tools', 'candidateExposed'], message: 'turns without a candidate proposal cannot claim candidate tool exposure' });
  }
  if (event.route.candidate !== null && event.execution.jev.status !== 'settled') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['route', 'candidate'], message: 'candidate proposals require a settled Jev response' });
  }
  const observedAt = Date.parse(event.occurredAt);
  for (const provider of ['baseline', 'jev'] as const) {
    const attempt = event.execution[provider];
    for (const [field, value] of [['attemptedAt', attempt.attemptedAt], ['dispatchedAt', attempt.dispatchedAt], ['finishedAt', attempt.finishedAt]] as const) {
      if (value !== null && Date.parse(value) > observedAt) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['execution', provider, field], message: 'lifecycle timestamp cannot be after event observation time' });
      }
    }
  }
});

export type CapabilityShadowEvent = z.infer<typeof capabilityShadowEventSchema>;

export interface VerifiedCapabilityShadowMembership {
  readonly digest: string;
  readonly payload: CapabilityShadowMembershipPayload;
  readonly assignments: ReadonlyMap<string, CapabilityShadowMembershipPayload['assignments'][number]>;
}

// Keep the signed snapshot private: the public typed view is mutable at runtime.
const verifiedMemberships = new WeakMap<object, VerifiedCapabilityShadowMembership>();

export function capabilityShadowMembershipPayloadToCanonicalJson(input: unknown): string {
  const payload = capabilityShadowMembershipPayloadSchema.parse(input);
  const assignments = [...payload.assignments].sort((left, right) => left.turnKeyHash.localeCompare(right.turnKeyHash));
  return JSON.stringify({
    version: payload.version,
    keyId: payload.keyId,
    versions: payload.versions,
    registry: payload.registry,
    assignments: assignments.map((row) => ({
      turnKeyHash: row.turnKeyHash,
      evaluationUnitHash: row.evaluationUnitHash,
      evaluationUnitKeyVersion: row.evaluationUnitKeyVersion,
      tenantPseudonymHash: row.tenantPseudonymHash,
      tenantPseudonymKeyVersion: row.tenantPseudonymKeyVersion,
      eligibleSelected: row.eligibleSelected,
      eligibilityReason: row.eligibilityReason,
      source: row.source,
      cohort: row.cohort,
      split: row.split,
      surface: row.surface,
      domain: row.domain,
      taskFamily: row.taskFamily,
    })),
  });
}

export function verifyCapabilityShadowMembershipManifest(
  input: unknown,
  publicKeyPem: string,
  trustedPublicKeySha256: string,
): VerifiedCapabilityShadowMembership {
  const checked = capabilityShadowMembershipManifestSchema.parse(input);
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('membership key must be Ed25519');
  const actualFingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  if (!hashSchema.safeParse(trustedPublicKeySha256).success || actualFingerprint !== trustedPublicKeySha256.toLowerCase()) {
    throw new Error('membership signing key fingerprint is not trusted');
  }
  const canonical = capabilityShadowMembershipPayloadToCanonicalJson(checked.payload);
  const assignments = [...checked.payload.assignments];
  const turnKeys = new Set<string>();
  const evaluationUnits = new Set<string>();
  const allow = checked.payload.registry;
  for (const row of assignments) {
    if (turnKeys.has(row.turnKeyHash)) throw new Error(`membership contains duplicate turn key ${row.turnKeyHash}`);
    turnKeys.add(row.turnKeyHash);
    if (evaluationUnits.has(row.evaluationUnitHash)) throw new Error('membership contains duplicate evaluation unit');
    evaluationUnits.add(row.evaluationUnitHash);
    if (!allow.surfaces.includes(row.surface) || !allow.domains.includes(row.domain) || !allow.taskFamilies.includes(row.taskFamily)) {
      throw new Error('membership assignment contains a category outside its signed allowlist');
    }
    if (row.eligibilityReason !== null && !allow.reasonCodes.includes(row.eligibilityReason)) {
      throw new Error('membership assignment contains an eligibility reason outside its signed allowlist');
    }
  }
  const signature = Buffer.from(checked.signatureBase64, 'base64');
  if (signature.length !== 64 || !verify(null, Buffer.from(canonical, 'utf8'), publicKey, signature)) {
    throw new Error('membership manifest signature is invalid');
  }
  const verified: VerifiedCapabilityShadowMembership = {
    digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    payload: checked.payload,
    assignments: new Map(assignments.map((row) => [row.turnKeyHash, row])),
  };
  const lockedPayload = capabilityShadowMembershipPayloadSchema.parse(checked.payload);
  verifiedMemberships.set(verified, {
    digest: verified.digest,
    payload: lockedPayload,
    assignments: new Map(lockedPayload.assignments.map((row) => [row.turnKeyHash, row])),
  });
  return verified;
}

/**
 * Read only the private verified copy, never the mutable public typed view.
 * This is a structural assignment lookup for a dormant producer boundary; it
 * does not prove that a runtime turn or its timestamps actually occurred.
 */
export function resolveLockedCapabilityShadowAssignment(
  membership: VerifiedCapabilityShadowMembership,
  turnKeyHash: string,
): {
  digest: string;
  versions: CapabilityShadowMembershipPayload['versions'];
  assignment: CapabilityShadowMembershipPayload['assignments'][number];
} {
  const locked = verifiedMemberships.get(membership);
  if (!locked) throw new Error('a cryptographically verified membership manifest is required');
  const assignment = locked.assignments.get(turnKeyHash);
  if (!assignment) throw new Error('turn key is absent from locked membership');
  return {
    digest: locked.digest,
    versions: { ...locked.payload.versions },
    assignment: { ...assignment },
  };
}

/** Reuse the report's complete membership/allowlist checks before signing. */
export function assertCapabilityShadowEventMatchesLockedMembership(
  inputEvent: CapabilityShadowEvent,
  membership: VerifiedCapabilityShadowMembership,
): void {
  const locked = verifiedMemberships.get(membership);
  if (!locked) throw new Error('a cryptographically verified membership manifest is required');
  preflightEvents([inputEvent], locked);
}

export interface CapabilityShadowReport {
  reportVersion: 'meri_capability_shadow_report_v1';
  split: CapabilityShadowEvent['sample']['split'] | 'all';
  inputDigest: string;
  membershipDigest: string;
  counts: {
    events: number;
    live: number;
    replay: number;
    eligible: number;
    ineligible: number;
    candidateProposals: number;
    eligibleFallbacks: number;
    routeAgreement: number;
    candidateBaselineRouteAgreement: number | null;
    duplicateEvents: number;
    missingManifestEvents: number;
    distinctTenantPseudonyms: number;
  };
  operations: {
    jevByLifecycle: Record<typeof attemptStatus[number], number>;
    baselineByLifecycle: Record<typeof attemptStatus[number], number>;
    jevSettledTurns: number;
    baselineSettledTurns: number;
    jevAttemptedTurns: number;
    baselineAttemptedTurns: number;
    jevDispatchedTurns: number;
    baselineDispatchedTurns: number;
    baselineDurationP95Ms: number | null;
    jevDurationP95Ms: number | null;
    baselineCostUsdKnownSubtotal: number | null;
    jevCostUsdKnownSubtotal: number | null;
    baselineUnknownAttemptCosts: number;
    jevUnknownAttemptCosts: number;
    baselineCostsFullyKnown: boolean;
    jevCostsFullyKnown: boolean;
    baselineInputTokensKnownSubtotal: number;
    jevInputTokensKnownSubtotal: number;
    baselineOutputTokensKnownSubtotal: number;
    jevOutputTokensKnownSubtotal: number;
    baselineUnknownInputTokenAttempts: number;
    jevUnknownInputTokenAttempts: number;
    baselineUnknownOutputTokenAttempts: number;
    jevUnknownOutputTokenAttempts: number;
  };
  toolCoverage: {
    requiredToolCount: number;
    requiredToolTurnCount: number;
    candidateExposedRequiredCount: number;
    baselineExposedRequiredCount: number;
    baselineUsedRequiredCount: number;
    candidatePotentialCoverage: number | null;
    baselineExposureCoverage: number | null;
    baselineUseCoverage: number | null;
    missingCandidateTools: string[];
    missingBaselineTools: string[];
  };
  sampleFloor: {
    requiredRepresentativeLiveTurns: 500;
    eligibleSelected: number;
    attempted: number;
    dispatched: number;
    settled: number;
    structurallyReady: boolean;
    liveEvidenceVerified: false;
    qualified: false;
  };
  byFamily: Record<string, { selected: number; observed: number; settled: number; candidateProposals: number; eligibleFallbacks: number; routeAgreement: number | null; candidatePotentialCoverage: number | null }>;
  byTenant: Record<string, { selected: number; observed: number; eligibleSelected: number; attempted: number; dispatched: number; settled: number }>;
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Verify all rows against the locked membership before any split selection. */
function preflightEvents(
  inputEvents: readonly CapabilityShadowEvent[],
  membership: VerifiedCapabilityShadowMembership,
): CapabilityShadowEvent[] {
  const eventIds = new Set<string>();
  const turnKeys = new Set<string>();
  const evaluationUnits = new Set<string>();
  const checkedEvents: CapabilityShadowEvent[] = [];
  for (const inputEvent of inputEvents) {
    const event = capabilityShadowEventSchema.parse(inputEvent);
    if (eventIds.has(event.eventId) || turnKeys.has(event.turnKeyHash)) throw new Error('duplicate event/turn key across input splits');
    eventIds.add(event.eventId);
    turnKeys.add(event.turnKeyHash);
    const assignment = membership.assignments.get(event.turnKeyHash);
    if (!assignment) throw new Error(`event turn key is absent from locked membership: ${event.turnKeyHash}`);
    if (evaluationUnits.has(event.evaluationUnitHash)) throw new Error('duplicate evaluation unit across input events');
    evaluationUnits.add(event.evaluationUnitHash);
    if (event.sample.membershipManifestDigest !== membership.digest) throw new Error('event membership digest does not match verified manifest');
    const registry = membership.payload.registry;
    if ((event.route.baseline !== null && !registry.routes.includes(event.route.baseline))
      || (event.route.candidate !== null && !registry.routes.includes(event.route.candidate))
      || (event.route.ineligibleReason !== null && !registry.reasonCodes.includes(event.route.ineligibleReason))
      || (event.route.fallbackReason !== null && !registry.reasonCodes.includes(event.route.fallbackReason))
      || [...event.tools.required, ...event.tools.candidateExposed, ...event.tools.baselineExposed, ...event.tools.baselineUsed].some((tool) => !registry.tools.includes(tool))) {
      throw new Error('event contains a route, reason, or tool outside the signed allowlist');
    }
    if (event.versions.catalog !== membership.payload.versions.catalog
      || event.versions.routingModel !== membership.payload.versions.routingModel
      || event.versions.question !== membership.payload.versions.question
      || event.versions.policy !== membership.payload.versions.policy
      || event.sample.selectionPolicyVersion !== membership.payload.versions.selectionPolicy) {
      throw new Error('event version set does not match locked membership policy');
    }
    if (event.evaluationUnitHash !== assignment.evaluationUnitHash
      || event.evaluationUnitKeyVersion !== assignment.evaluationUnitKeyVersion
      || event.tenantPseudonymHash !== assignment.tenantPseudonymHash
      || event.tenantPseudonymKeyVersion !== assignment.tenantPseudonymKeyVersion
      || event.sample.source !== assignment.source
      || event.sample.cohort !== assignment.cohort
      || event.sample.split !== assignment.split
      || event.sample.surface !== assignment.surface
      || event.sample.domain !== assignment.domain
      || event.sample.taskFamily !== assignment.taskFamily
      || event.route.eligible !== assignment.eligibleSelected
      || event.route.ineligibleReason !== assignment.eligibilityReason) {
      throw new Error(`event does not match locked membership assignment: ${event.turnKeyHash}`);
    }
    checkedEvents.push(event);
  }
  return checkedEvents;
}

function lifecycleCounts(events: readonly CapabilityShadowEvent[], provider: 'baseline' | 'jev'): Record<typeof attemptStatus[number], number> {
  return Object.fromEntries(attemptStatus.map((status) => [status, events.filter((event) => event.execution[provider].status === status).length])) as Record<typeof attemptStatus[number], number>;
}

function costSummary(events: readonly CapabilityShadowEvent[], provider: 'baseline' | 'jev') {
  const attempts = events.map((event) => event.execution[provider]).filter((attempt) => attempt.dispatchedAt !== null);
  const known = attempts.filter((attempt) => attempt.costUsd !== null);
  const unknown = attempts.length - known.length;
  return {
    knownSubtotal: known.length ? known.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0) : null,
    unknown,
    fullyKnown: attempts.length > 0 && unknown === 0,
  };
}

function settledPercentile(events: readonly CapabilityShadowEvent[], provider: 'baseline' | 'jev'): number | null {
  return percentile95(events.filter((event) => event.execution[provider].status === 'settled')
    .map((event) => event.execution[provider].durationMs).filter((value): value is number => value !== null));
}

/**
 * Offline structural audit only. A signed locked membership manifest is
 * mandatory, and sample sufficiency does not verify that a live producer ran.
 */
export function buildCapabilityShadowReport(
  inputEvents: readonly CapabilityShadowEvent[],
  membership: VerifiedCapabilityShadowMembership,
  split: CapabilityShadowEvent['sample']['split'] | 'all' = 'all',
): CapabilityShadowReport {
  const lockedMembership = verifiedMemberships.get(membership);
  if (!lockedMembership) throw new Error('a cryptographically verified membership manifest is required');
  const checkedEvents = preflightEvents(inputEvents, lockedMembership);
  for (const field of ['catalog', 'routingModel', 'question', 'policy'] as const) {
    const values = [...new Set(checkedEvents.map((event) => event.versions[field]))];
    if (values.length > 1) throw new Error(`report cannot mix ${field} versions [${values.sort().join(', ')}]`);
  }
  const assignments = lockedMembership.payload.assignments.filter((row) => split === 'all' || row.split === split);
  const includedSplits = [...new Set(assignments.map((row) => row.split))];
  if (split === 'all' && includedSplits.length > 1) throw new Error('select one locked split per report; tuning and heldout cannot be combined');
  const selectedTurnKeys = new Set(assignments.map((row) => row.turnKeyHash));
  const events = checkedEvents.filter((event) => selectedTurnKeys.has(event.turnKeyHash));
  const eventByTurn = new Map(events.map((event) => [event.turnKeyHash, event]));
  const missingManifestEvents = assignments.filter((row) => !eventByTurn.has(row.turnKeyHash)).length;
  const representativeEligible = assignments.filter((row) => row.source === 'live' && row.cohort === 'representative' && row.eligibleSelected);
  const representativeEligibleUniqueUnits = new Set(representativeEligible.map((row) => row.evaluationUnitHash)).size;
  const representativeEligibleEvents = representativeEligible.map((row) => eventByTurn.get(row.turnKeyHash)).filter((event): event is CapabilityShadowEvent => Boolean(event));
  const jevAttempted = new Set(representativeEligibleEvents.filter((event) => event.execution.jev.attemptedAt !== null).map((event) => event.evaluationUnitHash)).size;
  const jevDispatched = new Set(representativeEligibleEvents.filter((event) => event.execution.jev.dispatchedAt !== null).map((event) => event.evaluationUnitHash)).size;
  const jevSettled = new Set(representativeEligibleEvents.filter((event) => event.execution.jev.status === 'settled').map((event) => event.evaluationUnitHash)).size;
  const eligible = events.filter((event) => event.route.eligible);
  const candidateProposals = eligible.filter((event) => event.route.candidate !== null);
  const requiredTools = new Set(events.flatMap((event) => event.tools.required));
  const requiredPairs = events.flatMap((event) => event.tools.required.map((tool) => ({ event, tool })));
  const candidatePairCount = requiredPairs.filter(({ event, tool }) => event.tools.candidateExposed.includes(tool)).length;
  const baselinePairCount = requiredPairs.filter(({ event, tool }) => event.tools.baselineExposed.includes(tool)).length;
  const usedPairCount = requiredPairs.filter(({ event, tool }) => event.tools.baselineUsed.includes(tool)).length;
  const missingInAnyTurn = (field: 'candidateExposed' | 'baselineExposed') => [...new Set(requiredPairs
    .filter(({ event, tool }) => !event.tools[field].includes(tool)).map(({ tool }) => tool))].sort();
  const familyNames = [...new Set(assignments.map((row) => row.taskFamily))].sort();
  const byFamily = Object.fromEntries(familyNames.map((family) => {
    const familyAssignments = assignments.filter((row) => row.taskFamily === family);
    const rows = events.filter((event) => event.sample.taskFamily === family);
    const eligibleRows = rows.filter((event) => event.route.eligible);
    const routeRows = eligibleRows.filter((event) => event.route.candidate !== null);
    const familyPairs = rows.flatMap((event) => event.tools.required.map((tool) => ({ event, tool })));
    const familyCovered = familyPairs.filter(({ event, tool }) => event.tools.candidateExposed.includes(tool)).length;
    return [family, {
      selected: familyAssignments.filter((row) => row.eligibleSelected).length,
      observed: rows.length,
      settled: rows.filter((event) => event.execution.jev.status === 'settled').length,
      candidateProposals: routeRows.length,
      eligibleFallbacks: eligibleRows.length - routeRows.length,
      routeAgreement: rate(routeRows.filter((event) => event.route.baseline === event.route.candidate).length, routeRows.length),
      candidatePotentialCoverage: rate(familyCovered, familyPairs.length),
    }];
  }));
  const tenantPseudonyms = [...new Set(assignments.map((row) => row.tenantPseudonymHash))].sort();
  const byTenant = Object.fromEntries(tenantPseudonyms.map((pseudonym) => {
    const tenantAssignments = assignments.filter((row) => row.tenantPseudonymHash === pseudonym);
    const tenantEvents = events.filter((event) => event.tenantPseudonymHash === pseudonym);
    return [pseudonym, {
      selected: tenantAssignments.length,
      observed: tenantEvents.length,
      eligibleSelected: tenantAssignments.filter((row) => row.eligibleSelected).length,
      attempted: tenantEvents.filter((event) => event.execution.jev.attemptedAt !== null).length,
      dispatched: tenantEvents.filter((event) => event.execution.jev.dispatchedAt !== null).length,
      settled: tenantEvents.filter((event) => event.execution.jev.status === 'settled').length,
    }];
  }));
  const candidateRouteAgreements = candidateProposals.filter((event) => event.route.baseline === event.route.candidate).length;
  const jevCost = costSummary(events, 'jev');
  const baselineCost = costSummary(events, 'baseline');
  const tokenSubtotal = (provider: 'baseline' | 'jev', token: 'inputTokens' | 'outputTokens') => events
    .reduce((sum, event) => sum + (event.execution[provider][token] ?? 0), 0);
  const unknownTokenAttempts = (provider: 'baseline' | 'jev', token: 'inputTokens' | 'outputTokens') => events
    .filter((event) => event.execution[provider].dispatchedAt !== null && event.execution[provider][token] === null).length;
  return {
    reportVersion: 'meri_capability_shadow_report_v1',
    split,
    inputDigest: createHash('sha256').update(JSON.stringify(events), 'utf8').digest('hex'),
    membershipDigest: lockedMembership.digest,
    counts: {
      events: events.length,
      live: events.filter((event) => event.sample.source === 'live').length,
      replay: events.filter((event) => event.sample.source === 'replay').length,
      eligible: assignments.filter((row) => row.eligibleSelected).length,
      ineligible: assignments.filter((row) => !row.eligibleSelected).length,
      candidateProposals: candidateProposals.length,
      eligibleFallbacks: eligible.length - candidateProposals.length,
      routeAgreement: candidateRouteAgreements,
      candidateBaselineRouteAgreement: rate(candidateRouteAgreements, candidateProposals.length),
      duplicateEvents: 0,
      missingManifestEvents,
      distinctTenantPseudonyms: tenantPseudonyms.length,
    },
    operations: {
      jevByLifecycle: lifecycleCounts(events, 'jev'),
      baselineByLifecycle: lifecycleCounts(events, 'baseline'),
      jevSettledTurns: events.filter((event) => event.execution.jev.status === 'settled').length,
      baselineSettledTurns: events.filter((event) => event.execution.baseline.status === 'settled').length,
      jevAttemptedTurns: events.filter((event) => event.execution.jev.attemptedAt !== null).length,
      baselineAttemptedTurns: events.filter((event) => event.execution.baseline.attemptedAt !== null).length,
      jevDispatchedTurns: events.filter((event) => event.execution.jev.dispatchedAt !== null).length,
      baselineDispatchedTurns: events.filter((event) => event.execution.baseline.dispatchedAt !== null).length,
      baselineDurationP95Ms: settledPercentile(events, 'baseline'),
      jevDurationP95Ms: settledPercentile(events, 'jev'),
      baselineCostUsdKnownSubtotal: baselineCost.knownSubtotal,
      jevCostUsdKnownSubtotal: jevCost.knownSubtotal,
      baselineUnknownAttemptCosts: baselineCost.unknown,
      jevUnknownAttemptCosts: jevCost.unknown,
      baselineCostsFullyKnown: baselineCost.fullyKnown,
      jevCostsFullyKnown: jevCost.fullyKnown,
      baselineInputTokensKnownSubtotal: tokenSubtotal('baseline', 'inputTokens'),
      jevInputTokensKnownSubtotal: tokenSubtotal('jev', 'inputTokens'),
      baselineOutputTokensKnownSubtotal: tokenSubtotal('baseline', 'outputTokens'),
      jevOutputTokensKnownSubtotal: tokenSubtotal('jev', 'outputTokens'),
      baselineUnknownInputTokenAttempts: unknownTokenAttempts('baseline', 'inputTokens'),
      jevUnknownInputTokenAttempts: unknownTokenAttempts('jev', 'inputTokens'),
      baselineUnknownOutputTokenAttempts: unknownTokenAttempts('baseline', 'outputTokens'),
      jevUnknownOutputTokenAttempts: unknownTokenAttempts('jev', 'outputTokens'),
    },
    toolCoverage: {
      requiredToolCount: requiredTools.size,
      requiredToolTurnCount: requiredPairs.length,
      candidateExposedRequiredCount: candidatePairCount,
      baselineExposedRequiredCount: baselinePairCount,
      baselineUsedRequiredCount: usedPairCount,
      candidatePotentialCoverage: rate(candidatePairCount, requiredPairs.length),
      baselineExposureCoverage: rate(baselinePairCount, requiredPairs.length),
      baselineUseCoverage: rate(usedPairCount, requiredPairs.length),
      missingCandidateTools: missingInAnyTurn('candidateExposed'),
      missingBaselineTools: missingInAnyTurn('baselineExposed'),
    },
    sampleFloor: {
      requiredRepresentativeLiveTurns: 500,
      eligibleSelected: representativeEligibleUniqueUnits,
      attempted: jevAttempted,
      dispatched: jevDispatched,
      settled: jevSettled,
      structurallyReady: representativeEligibleUniqueUnits >= 500 && jevAttempted >= 500 && jevDispatched >= 500 && jevSettled >= 500 && missingManifestEvents === 0,
      liveEvidenceVerified: false,
      qualified: false,
    },
    byFamily,
    byTenant,
  };
}

export function parseCapabilityShadowEvents(lines: readonly string[]): { events: CapabilityShadowEvent[]; rejected: number; unrelated: number } {
  const events: CapabilityShadowEvent[] = [];
  let rejected = 0;
  let unrelated = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { rejected += 1; continue; }
    const parsed = capabilityShadowEventSchema.safeParse(value);
    if (parsed.success) events.push(parsed.data);
    else if (value && typeof value === 'object' && (value as Record<string, unknown>).event === 'meri.capability_shadow.turn') rejected += 1;
    else unrelated += 1;
  }
  return { events, rejected, unrelated };
}
