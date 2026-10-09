import type { ToolExecutionControl } from '@capiro/meriv2-core';

/**
 * Request-local catalog availability (Lane A / A1).
 *
 * The API producer (managed catalog `/api/clio/v3/mcp-tool-schemas`) already
 * returns sanitized, additive availability alongside the admitted schemas. This
 * app-local module is the smallest coherent CONSUMER seam: it carries a bounded,
 * status-only observer on the SAME request-local control object that the
 * assistant already threads through `run` -> `runTurn` -> `fetchToolSchemas`
 * (and the managed owner reauth), records per-source discovery outcomes, and
 * renders truthful, source-specific guidance/limitation text.
 *
 * Boundaries (do not widen):
 *  - Status is never authority. It can only make the answer MORE honest, never
 *    grant a tool, widen a source, or turn a failed current dispatch into a
 *    success.
 *  - No Core `ToolExecutionControl` change, no singleton/ALS/cache/store state.
 *  - No raw provider body/message, actor token, endpoint or private id ever
 *    reaches user-facing text. Only fixed, allowlisted display names and
 *    reasons are rendered.
 */

export type MeriCatalogSourceKey = 'native' | 'managed' | 'analysis';

/**
 * Bounded per-source discovery outcome. Distinguishes a genuinely usable/empty
 * catalog from every failure mode so a caller can never claim unavailable
 * records were consulted.
 */
export type MeriCatalogSourceOutcome =
  | 'usable'
  | 'empty'
  | 'missing_credential'
  | 'auth_denied'
  | 'unavailable'
  | 'malformed'
  | 'metadata_unknown'
  | 'skipped'
  | 'disabled';

export type MeriCatalogAvailabilityState = 'ok' | 'partial' | 'unavailable' | 'no_eligible';

export type MeriCatalogFailureReason =
  | 'unavailable'
  | 'needs_reauth'
  | 'malformed'
  | 'registry_unavailable';

export type MeriCatalogAppId = 'hubspot' | 'airtable' | 'monday' | 'google-drive' | 'krisp';

export interface MeriCatalogAppFailure {
  appId: MeriCatalogAppId;
  /** Fixed, allowlisted display name derived from appId — never the raw name. */
  name: string;
  reason: MeriCatalogFailureReason;
}

export interface MeriCatalogManagedAvailability {
  state: MeriCatalogAvailabilityState;
  complete: boolean;
  registryUnavailable: boolean;
  failures: MeriCatalogAppFailure[];
}

export interface MeriCatalogSourceStatus {
  outcome: MeriCatalogSourceOutcome;
  /** Admitted schema count when known (0 is a real successful-empty). */
  count?: number;
}

export type MeriCatalogNativeReadFailureReason = 'unavailable' | 'failed';

/**
 * A CURRENT native canonical-read failure observed after an initially healthy
 * catalog (or after another successful read). The `capability` is the canonical
 * read identity taken from the registry/capability metadata — never a tool-name
 * prefix guess — and is status-only: it is bounded, deduped and NEVER rendered
 * to the user. It is deliberately separate from the catalog-level `native`
 * outcome so one healthy read (or a healthy initial catalog) can never erase a
 * different failed requested read.
 */
export interface MeriCatalogNativeReadFailure {
  capability: string;
  reason: MeriCatalogNativeReadFailureReason;
}

export interface MeriCatalogAvailabilitySnapshot {
  native?: MeriCatalogSourceStatus;
  managed?: MeriCatalogSourceStatus;
  analysis?: MeriCatalogSourceStatus;
  managedAvailability: MeriCatalogManagedAvailability | null;
  /**
   * App-level failures observed at CURRENT dispatch time (a revocation between
   * the first advertisement and dispatch, or an owner read that failed after an
   * initially healthy catalog). Bounded, deduped by allowlisted appId; absent
   * when no dispatch failure occurred. Status only — never a grant.
   */
  managedDispatchFailures?: MeriCatalogAppFailure[];
  /**
   * Current native canonical-read failures observed at dispatch time (an owner
   * throw/error, a registry-unavailable read, or an unusable/failed read
   * result) recorded from the registry/capability metadata. Deduped by
   * canonical capability, bounded, status-only. Distinct from the catalog-level
   * `native` outcome so a healthy catalog/read never erases a failed read.
   */
  nativeDispatchFailures?: MeriCatalogNativeReadFailure[];
}

export interface MeriCatalogAvailabilityObserver {
  noteNative(status: MeriCatalogSourceStatus): void;
  noteManaged(status: MeriCatalogSourceStatus): void;
  noteAnalysis(status: MeriCatalogSourceStatus): void;
  noteManagedAvailability(availability: MeriCatalogManagedAvailability | null): void;
  /**
   * Record a CURRENT managed dispatch failure for one allowlisted app. The app
   * identity must come from the actual admitted schema metadata, never a tool
   * name prefix. Status only: it can only make the answer more honest, never
   * grant a read or turn a blocked dispatch into a success.
   */
  noteManagedAppUnavailable(appId: MeriCatalogAppId, reason?: MeriCatalogFailureReason): void;
  /**
   * Record a CURRENT native canonical-read failure for one canonical capability
   * (an owner throw/error, a registry-unavailable read, or an unusable/failed
   * result). The capability identity must come from registry/capability
   * metadata; a tool-name prefix is never authority. Status only: it can only
   * make the answer more honest, never grant a read or turn a failed read into
   * a success. Non-read effects (run_analysis/artifacts/save_memory) are never
   * recorded here.
   */
  noteNativeReadFailure(
    capability: string,
    reason?: MeriCatalogNativeReadFailureReason,
  ): void;
  snapshot(): MeriCatalogAvailabilitySnapshot;
}

/**
 * The app-local control intersection. The observer rides on the EXISTING first
 * control argument, so the retrieval-assistant wrapper (which forwards the same
 * `control` object) loses nothing.
 */
export type MeriCatalogAvailabilityControl = ToolExecutionControl & {
  catalogAvailability?: MeriCatalogAvailabilityObserver;
};

const APP_NAMES: Record<MeriCatalogAppId, string> = {
  hubspot: 'HubSpot',
  airtable: 'Airtable',
  monday: 'monday.com',
  'google-drive': 'Google Drive',
  krisp: 'Krisp',
};

const APP_IDS = new Set<string>(Object.keys(APP_NAMES));
const AVAILABILITY_STATES = new Set<string>(['ok', 'partial', 'unavailable', 'no_eligible']);
const FAILURE_REASONS = new Set<string>([
  'unavailable',
  'needs_reauth',
  'malformed',
  'registry_unavailable',
]);
const OUTCOMES = new Set<string>([
  'usable',
  'empty',
  'missing_credential',
  'auth_denied',
  'unavailable',
  'malformed',
  'metadata_unknown',
  'skipped',
  'disabled',
]);

/** Fixed display name for an allowlisted appId; never the raw advertised name. */
export function meriCatalogAppName(appId: MeriCatalogAppId): string {
  return APP_NAMES[appId];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFailure(entry: unknown): MeriCatalogAppFailure | null {
  if (!isRecord(entry)) return null;
  const appId = entry.appId;
  if (typeof appId !== 'string' || !APP_IDS.has(appId)) return null;
  const reason = entry.reason;
  if (typeof reason !== 'string' || !FAILURE_REASONS.has(reason)) return null;
  const typedAppId = appId as MeriCatalogAppId;
  // Derive the display name from the allowlist; never trust a raw `name`/body.
  return { appId: typedAppId, name: APP_NAMES[typedAppId], reason: reason as MeriCatalogFailureReason };
}

/**
 * Rank used ONLY to collapse duplicate app failures to one bounded entry per
 * app, mirroring the API producer's precedence. No raw text is retained.
 */
const FAILURE_RANK: Record<MeriCatalogFailureReason, number> = {
  needs_reauth: 3,
  malformed: 2,
  unavailable: 1,
  registry_unavailable: 0,
};

/**
 * Reject every contradictory state/complete/registryUnavailable/failure
 * combination the actual API can never emit, so a malformed envelope can never
 * be read as a complete/ok/no_eligible catalog. Valid combinations, from the
 * real producer:
 *  - ok           : complete=true,  registryUnavailable=false, no failures
 *  - no_eligible  : complete=true,  registryUnavailable=false, no failures
 *  - partial      : complete=false, registryUnavailable=false, >=1 failure
 *  - unavailable  : complete=false, registryUnavailable=true OR >=1 failure
 */
function availabilityCombinationValid(
  state: MeriCatalogAvailabilityState,
  complete: boolean,
  registryUnavailable: boolean,
  failures: readonly MeriCatalogAppFailure[],
): boolean {
  const hasFailures = failures.length > 0;
  switch (state) {
    case 'ok':
    case 'no_eligible':
      return complete === true && registryUnavailable === false && !hasFailures;
    case 'partial':
      return complete === false && registryUnavailable === false && hasFailures;
    case 'unavailable':
      return complete === false && (registryUnavailable === true || hasFailures);
    default:
      return false;
  }
}

/**
 * Validate the actual managed `availability` envelope. Returns the normalized,
 * allowlisted, deduped availability, or `null` when the shape is
 * missing/malformed/contradictory (the caller distinguishes an absent rolling
 * envelope from a present-but-invalid one, and never claims ok/no_eligible for
 * either). Malformed availability can never become success.
 *
 * The actual contract ALWAYS carries a `failures` array (possibly empty); a
 * missing or non-array `failures` is malformed. Duplicate app entries are
 * collapsed to one bounded entry per allowlisted app.
 */
export function parseManagedCatalogAvailability(value: unknown): MeriCatalogManagedAvailability | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (typeof state !== 'string' || !AVAILABILITY_STATES.has(state)) return null;
  if (typeof value.complete !== 'boolean') return null;
  if (typeof value.registryUnavailable !== 'boolean') return null;
  // Failures array is required by the actual contract.
  if (!Array.isArray(value.failures)) return null;
  const byApp = new Map<MeriCatalogAppId, MeriCatalogAppFailure>();
  for (const entry of value.failures) {
    const failure = normalizeFailure(entry);
    if (!failure) return null; // any malformed failure entry invalidates the envelope
    const existing = byApp.get(failure.appId);
    if (!existing || FAILURE_RANK[failure.reason] > FAILURE_RANK[existing.reason]) {
      byApp.set(failure.appId, failure);
    }
  }
  const failures = [...byApp.values()];
  const typedState = state as MeriCatalogAvailabilityState;
  if (
    !availabilityCombinationValid(typedState, value.complete, value.registryUnavailable, failures)
  ) {
    return null;
  }
  return {
    state: typedState,
    complete: value.complete,
    registryUnavailable: value.registryUnavailable,
    failures,
  };
}

/**
 * Map a VALID managed availability envelope + admitted schema count to the
 * bounded source outcome for the observer:
 *  - ok + schemas        -> usable
 *  - ok + []             -> empty (genuine successful empty)
 *  - no_eligible         -> empty (deliberate nothing-eligible, NOT an outage)
 *  - partial             -> usable (healthy authorized tools retained)
 *  - unavailable         -> unavailable (no healthy tools / registry outage)
 * A malformed envelope never reaches here (it is recorded as `malformed`).
 */
export function managedCatalogOutcomeFor(
  availability: MeriCatalogManagedAvailability,
  schemaCount: number,
): MeriCatalogSourceOutcome {
  switch (availability.state) {
    case 'ok':
      return schemaCount > 0 ? 'usable' : 'empty';
    case 'no_eligible':
      return 'empty';
    case 'partial':
      return 'usable';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'malformed';
  }
}

/** Read the request-local observer off the same control object, if present. */
export function catalogAvailabilityObserverOf(
  control: unknown,
): MeriCatalogAvailabilityObserver | undefined {
  if (!isRecord(control)) return undefined;
  const candidate = (control as unknown as MeriCatalogAvailabilityControl).catalogAvailability;
  return candidate && typeof candidate === 'object' ? candidate : undefined;
}

/** Construct a request-local status observer, constructed INSIDE each run. */
export function createMeriCatalogAvailabilityObserver(): MeriCatalogAvailabilityObserver {
  let native: MeriCatalogSourceStatus | undefined;
  let managed: MeriCatalogSourceStatus | undefined;
  let analysis: MeriCatalogSourceStatus | undefined;
  let managedAvailability: MeriCatalogManagedAvailability | null = null;
  const dispatchFailures = new Map<MeriCatalogAppId, MeriCatalogFailureReason>();
  const nativeReadFailures = new Map<string, MeriCatalogNativeReadFailureReason>();
  const sanitize = (status: MeriCatalogSourceStatus): MeriCatalogSourceStatus => ({
    outcome: OUTCOMES.has(status.outcome) ? status.outcome : 'malformed',
    ...(typeof status.count === 'number' && Number.isFinite(status.count)
      ? { count: status.count }
      : {}),
  });
  return {
    noteNative(status) {
      native = sanitize(status);
    },
    noteManaged(status) {
      managed = sanitize(status);
    },
    noteAnalysis(status) {
      analysis = sanitize(status);
    },
    noteManagedAvailability(availability) {
      managedAvailability = availability;
    },
    noteManagedAppUnavailable(appId, reason = 'unavailable') {
      if (!APP_IDS.has(appId) || !FAILURE_REASONS.has(reason)) return;
      const existing = dispatchFailures.get(appId);
      if (!existing || FAILURE_RANK[reason] > FAILURE_RANK[existing]) {
        dispatchFailures.set(appId, reason);
      }
    },
    noteNativeReadFailure(capability, reason = 'unavailable') {
      // The capability identity comes from the registry/capability metadata;
      // reject anything that is not a bounded canonical identifier and never
      // let a broader reason downgrade an already-recorded one.
      if (typeof capability !== 'string') return;
      const trimmed = capability.trim().slice(0, 120);
      if (!trimmed) return;
      const normalized: MeriCatalogNativeReadFailureReason =
        reason === 'failed' ? 'failed' : 'unavailable';
      const existing = nativeReadFailures.get(trimmed);
      if (!existing || (normalized === 'failed' && existing === 'unavailable')) {
        nativeReadFailures.set(trimmed, normalized);
      }
    },
    snapshot() {
      const failures = [...dispatchFailures].map(([appId, reason]) => ({
        appId,
        name: APP_NAMES[appId],
        reason,
      }));
      const nativeFailures = [...nativeReadFailures].map(([capability, reason]) => ({
        capability,
        reason,
      }));
      return {
        native,
        managed,
        analysis,
        managedAvailability,
        ...(failures.length ? { managedDispatchFailures: failures } : {}),
        ...(nativeFailures.length ? { nativeDispatchFailures: nativeFailures } : {}),
      };
    },
  };
}

/**
 * Narrow relevance. A source is relevant only when the user's request explicitly
 * names it (managed apps) or targets Capiro-owned record evidence; never broad
 * keyword inference that would mark unrelated answers incomplete.
 */
export interface MeriCatalogAvailabilityRelevance {
  requestedApps: MeriCatalogAppId[];
  nativeRequested: boolean;
}

/**
 * Minimal app-local optional inputs derived by the caller from the ACTUAL turn
 * (the real retrieval intent, the real evidence plan and the actual
 * selected/attempted canonical reads). This is deliberately NOT a new Core/B
 * coverage contract and NOT a hidden roster: the caller only reports signals it
 * already has. An authenticated clientId by itself is NEVER a signal — a
 * creative question with a client selected is not a request for private
 * records.
 */
export interface MeriCatalogAvailabilityRelevanceSignals {
  /** The actual evidence plan requires a Capiro client-record read this turn. */
  planRequiresClientRecords?: boolean;
  /** The actual retrieval intent is a client-scoped record query, not a bare lookup. */
  intentRequiresClientRecords?: boolean;
  /**
   * Canonical native read capabilities ACTUALLY selected/attempted this turn
   * (actual dispatch metadata: the capability identity, never a tool-name
   * prefix guess).
   */
  attemptedReads?: readonly string[];
}

const APP_REQUEST_PATTERNS: Array<{ appId: MeriCatalogAppId; pattern: RegExp }> = [
  { appId: 'hubspot', pattern: /\bhubspot\b/i },
  { appId: 'airtable', pattern: /\bairtable\b/i },
  // Only the product name counts; a plain weekday ("prepare for Monday") is not
  // a request for monday.com data.
  { appId: 'monday', pattern: /\bmonday\.com\b/i },
  { appId: 'google-drive', pattern: /\bgoogle[\s-]?drive\b|\bgdrive\b/i },
  { appId: 'krisp', pattern: /\bkrisp\b/i },
];

/**
 * Deliberately narrow: a proper name alone ("write a poem about Capiro") or a
 * date alone is NOT a request for private records. Only explicit Capiro-record
 * phrasing counts.
 */
const NATIVE_REQUEST_PATTERN =
  /\bour (?:client )?records\b|\bclient records?\b|\bclient documents?\b|\binstitutional knowledge\b|\bcapiro (?:client|clients|records?|documents?|files?|institutional)\b/i;

/**
 * The canonical Capiro client-record capabilities the evidence plan actually
 * uses for a client's records/context. Kept intentionally minimal (not a broad
 * roster): an attempted read of one of these is proof the turn targeted client
 * records even when the request never says "client records".
 */
const NATIVE_CLIENT_RECORD_CAPABILITIES: ReadonlySet<string> = new Set([
  'read_client_documents',
  'get_client_context',
]);

export function deriveCatalogAvailabilityRelevance(
  request: string,
  signals?: MeriCatalogAvailabilityRelevanceSignals,
): MeriCatalogAvailabilityRelevance {
  const text = typeof request === 'string' ? request : '';
  const requestedApps = APP_REQUEST_PATTERNS.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.appId,
  );
  const attemptedClientRecord = (signals?.attemptedReads ?? []).some((name) =>
    NATIVE_CLIENT_RECORD_CAPABILITIES.has(name),
  );
  const nativeRequested =
    NATIVE_REQUEST_PATTERN.test(text) ||
    signals?.planRequiresClientRecords === true ||
    signals?.intentRequiresClientRecords === true ||
    attemptedClientRecord;
  return { requestedApps, nativeRequested };
}

const MANAGED_HARD_FAILURES: ReadonlySet<MeriCatalogSourceOutcome> = new Set([
  'missing_credential',
  'auth_denied',
  'unavailable',
  'malformed',
]);
const NATIVE_HARD_FAILURES: ReadonlySet<MeriCatalogSourceOutcome> = new Set([
  'missing_credential',
  'auth_denied',
  'unavailable',
  'malformed',
]);

/**
 * The specific managed apps that are unavailable for a relevant request. An app
 * is unavailable when a whole managed-source outage occurred, the envelope
 * flags it in `failures`, or a CURRENT dispatch failure was recorded for it
 * (revocation/owner read failure). A requested app is one the request NAMED or
 * one the turn actually ATTEMPTED; an unrelated failed app never marks a
 * requested healthy/empty app unavailable.
 *
 * A deliberate `no_eligible` catalog is intentionally NOT treated as an outage.
 */
export function relevantUnavailableManagedApps(
  snapshot: MeriCatalogAvailabilitySnapshot,
  relevance: MeriCatalogAvailabilityRelevance,
): MeriCatalogAppId[] {
  const managed = snapshot.managed;
  const availability = snapshot.managedAvailability;
  // A whole managed-source outage is EITHER the registry snapshot itself being
  // unreadable (a valid envelope with registryUnavailable=true) OR a
  // source-level transport/auth/credential/malformed failure when NO valid
  // envelope exists at all. A per-app failure envelope (partial, or an
  // `unavailable` state with registryUnavailable=false) is NOT a whole-source
  // outage: only the apps the producer actually NAMED in `failures` (or that a
  // current dispatch failure named) are unavailable, so an unrelated failed app
  // never marks a requested healthy/empty app unavailable.
  const sourceWideOutage = availability
    ? availability.registryUnavailable === true
    : Boolean(managed && MANAGED_HARD_FAILURES.has(managed.outcome));
  const failureById = new Map<MeriCatalogAppId, MeriCatalogFailureReason>();
  for (const failure of availability?.failures ?? []) failureById.set(failure.appId, failure.reason);
  const dispatchFailures = snapshot.managedDispatchFailures ?? [];
  // CURRENT dispatch failures are per-app and named even when the source-level
  // catalog looked healthy at discovery.
  for (const failure of dispatchFailures) {
    if (!failureById.has(failure.appId)) failureById.set(failure.appId, failure.reason);
  }
  // A requested app is one the request NAMED, or one the turn ACTUALLY ATTEMPTED
  // (a current dispatch failure is real evidence the app was needed even when
  // the request never named it).
  const candidates = new Set<MeriCatalogAppId>([
    ...relevance.requestedApps,
    ...dispatchFailures.map((failure) => failure.appId),
  ]);
  const out: MeriCatalogAppId[] = [];
  for (const appId of candidates) {
    if (sourceWideOutage || failureById.has(appId)) out.push(appId);
  }
  return [...new Set(out)];
}

/**
 * Whether native Capiro record evidence was requested but could not be fetched.
 * A source-level catalog failure OR a CURRENT native canonical-read failure
 * (owner throw/unusable result, recorded from registry/capability metadata)
 * makes the requested records unavailable. This stays separate from the
 * catalog-level `native` outcome so one healthy read (or a healthy initial
 * catalog) can never erase a different failed requested read.
 */
export function nativeRecordsUnavailable(
  snapshot: MeriCatalogAvailabilitySnapshot,
  relevance: MeriCatalogAvailabilityRelevance,
): boolean {
  if (!relevance.nativeRequested) return false;
  if ((snapshot.nativeDispatchFailures ?? []).length > 0) return true;
  const native = snapshot.native;
  return Boolean(native && NATIVE_HARD_FAILURES.has(native.outcome));
}

/**
 * Bounded provider guidance. Empty string when nothing relevant is unavailable
 * (deliberate disabled/skipped/no_eligible and unrelated failures never produce
 * a blanket limitation). Fixed, source-specific wording only.
 */
export function meriCatalogAvailabilityInstruction(
  snapshot: MeriCatalogAvailabilitySnapshot,
  relevance: MeriCatalogAvailabilityRelevance,
): string {
  const apps = relevantUnavailableManagedApps(snapshot, relevance);
  const nativeDown = nativeRecordsUnavailable(snapshot, relevance);
  if (!apps.length && !nativeDown) return '';
  const lines = [
    '# Source availability for this request',
    'Some sources this request needs could not be reached this turn. You must not imply that their records were consulted, and you must not invent records, citations, or completeness for them.',
  ];
  if (apps.length) {
    const names = apps.map((appId) => meriCatalogAppName(appId)).join(', ');
    lines.push(
      `Unavailable connected app${apps.length > 1 ? 's' : ''}: ${names}. Do not present their data as retrieved; if a description is called for, state plainly that ${names} could not be checked this turn.`,
    );
  }
  if (nativeDown) {
    const catalogFailed = Boolean(
      snapshot.native && NATIVE_HARD_FAILURES.has(snapshot.native.outcome),
    );
    lines.push(
      catalogFailed
        ? 'Capiro client-record sources could not be listed this turn. Do not present Capiro records as retrieved; if a description is called for, state plainly that those records could not be checked.'
        : 'A Capiro client-record read this request needed failed this turn. Do not present that record as retrieved; if a description is called for, state plainly that the read could not be completed. Authorized records already provided in context are unaffected.',
    );
  }
  lines.push('Unrelated sources remain valid and must not be described as unavailable.');
  return lines.join('\n');
}

const RELEASE_MARKER_PREFIX = 'Source note:';

export interface MeriCatalogAvailabilityReleaseOptions {
  /**
   * A genuine authorized seed/context packet (authenticated governed evidence)
   * is present and was used this turn. A later catalog/read outage does not
   * erase those records, so the limitation must phrase the failed check as an
   * ADDITIONAL live check rather than claiming records "were not consulted".
   */
  seededEvidencePresent?: boolean;
}

/**
 * Final-release limitation. Emitted only when a relevant source was unavailable.
 * The provider is not trusted to obey the instruction, so this is applied to the
 * released/reply text even when the provider overclaims. Deliberate disabled/
 * skipped/no_eligible and unrelated failures never doom every answer.
 */
export function meriCatalogAvailabilityReleaseNote(
  snapshot: MeriCatalogAvailabilitySnapshot,
  relevance: MeriCatalogAvailabilityRelevance,
  options?: MeriCatalogAvailabilityReleaseOptions,
): string {
  const apps = relevantUnavailableManagedApps(snapshot, relevance);
  const nativeDown = nativeRecordsUnavailable(snapshot, relevance);
  if (!apps.length && !nativeDown) return '';
  const parts: string[] = [];
  if (apps.length) {
    const names = apps.map((appId) => meriCatalogAppName(appId)).join(', ');
    parts.push(`${names} could not be reached this turn, so their records were not consulted.`);
  }
  if (nativeDown) {
    const catalogFailed = Boolean(
      snapshot.native && NATIVE_HARD_FAILURES.has(snapshot.native.outcome),
    );
    if (options?.seededEvidencePresent) {
      // The authorized records already in context were used; only the
      // ADDITIONAL live retrieval could not complete.
      parts.push(
        'An additional live Capiro client-record check could not be completed this turn; the authorized Capiro context already provided was used and is unaffected.',
      );
    } else if (catalogFailed) {
      parts.push(
        'Capiro client records could not be listed this turn, so they were not consulted.',
      );
    } else {
      parts.push(
        'A Capiro client-record read this request needed failed this turn, so that record was not consulted.',
      );
    }
  }
  if (!parts.length) return '';
  return `${RELEASE_MARKER_PREFIX} ${parts.join(' ')}`;
}

export function alreadyDisclosesCatalogAvailability(reply: string): boolean {
  return typeof reply === 'string' && reply.includes(RELEASE_MARKER_PREFIX);
}
