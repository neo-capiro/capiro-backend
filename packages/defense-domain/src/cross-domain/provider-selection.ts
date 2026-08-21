/**
 * Phase 8 Session 9 — deterministic cross-domain provider selection.
 *
 * Sessions 2 and 3 left the two Workstream-E cross-domain ports bound to
 * "unconfigured" implementations and said exactly why:
 *
 *   "What is absent in dark posture is the OUTBOUND CREDENTIAL, deliberately —
 *    the HTTP task holds no Bedrock or main-API service credential, and Session 3
 *    authorizes no new one. Session 9 (shadow read) is where these get wired to
 *    real providers."
 *
 * So the missing piece was never business logic — `searchCapabilityLines` and
 * `getNeedsAttention` already implement their full query, ranking and shaping.
 * The missing piece is a provider, and the decision of *whether* one is present.
 *
 * That decision is made here, once, deterministically, and it fails closed:
 *
 *  * a provider is selected ONLY when its configuration is completely present;
 *  * anything missing, malformed or contradictory selects `dark`;
 *  * `dark` reproduces the existing degrade-to-empty behaviour exactly, so an
 *    unconfigured deployment behaves precisely as it does today;
 *  * selection never throws — a config mistake must not take down a read route
 *    that is documented to degrade rather than 500.
 *
 * Every rejection carries a reason, because "the search box returns nothing" and
 * "the embedding provider was misconfigured" look identical from the outside and
 * must not be indistinguishable in the logs.
 */

/** Which implementation backs a cross-domain port. */
export type ProviderMode = 'dark' | 'bedrock_embedding' | 'internal_service_relevance';

export type CrossDomainPortName = 'embedding' | 'client_relevance';

export interface ProviderSelection {
  readonly port: CrossDomainPortName;
  readonly mode: ProviderMode;
  /** `true` only when a real provider is selected. */
  readonly live: boolean;
  /** Why this mode was chosen. Always populated. */
  readonly reason: string;
  /**
   * Configuration actually used, with no secret material. Safe to log and to
   * persist on an audit row.
   */
  readonly resolved: Readonly<Record<string, string | number | boolean | null>>;
}

const DARK_EMBEDDING_REASON =
  'no embedding provider configured; serving the documented empty capability-search result';
const DARK_RELEVANCE_REASON =
  'no client-relevance provider configured; needs-attention serves watch/capability relevance only';

/** Titan v2 is what `apps/api` stores in `context_embeddings.model`. */
export const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';

/** Bounds that keep a misconfiguration from becoming an outage or a bill. */
export const PROVIDER_LIMITS = Object.freeze({
  minTimeoutMs: 100,
  maxTimeoutMs: 30_000,
  defaultTimeoutMs: 5_000,
  minAttempts: 1,
  maxAttempts: 5,
  defaultAttempts: 3,
  /** Upper bound on PE codes in ONE batched relevance call. */
  maxRelevanceBatch: 200,
  defaultRelevanceBatch: 50,
  /** Longest query we will embed. Matches the read service's own 300-char clamp. */
  maxQueryChars: 300,
});

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < min || parsed > max) return null;
  return parsed;
}

function httpsOrigin(raw: string | undefined): string | null {
  if (!raw || raw.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  // Plaintext service-to-service traffic is never acceptable, and a path or
  // query on a base URL is a configuration mistake we refuse rather than join.
  if (parsed.protocol !== 'https:') return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  return parsed.origin;
}

function dark(port: CrossDomainPortName, reason: string): ProviderSelection {
  return Object.freeze({
    port,
    mode: 'dark' as const,
    live: false,
    reason,
    resolved: Object.freeze({}),
  });
}

/**
 * Select the embedding provider.
 *
 * `DEFENSE_EMBEDDING_PROVIDER` is the explicit switch. It is required: a
 * credential appearing in the environment must never be enough to turn a dark
 * deployment live by accident.
 */
export function selectEmbeddingProvider(env: NodeJS.ProcessEnv): ProviderSelection {
  const requested = (env.DEFENSE_EMBEDDING_PROVIDER ?? '').trim().toLowerCase();

  if (requested === '' || requested === 'dark' || requested === 'none') {
    return dark('embedding', DARK_EMBEDDING_REASON);
  }

  if (requested !== 'bedrock') {
    return dark(
      'embedding',
      `unknown DEFENSE_EMBEDDING_PROVIDER "${requested}"; refusing to guess and staying dark`,
    );
  }

  const region = (env.DEFENSE_EMBEDDING_REGION ?? '').trim();
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    return dark('embedding', 'DEFENSE_EMBEDDING_REGION is missing or not an AWS region');
  }

  // The model id is part of the stored-vector contract: every vector read filters
  // on `context_embeddings.model`, so a mismatch silently returns zero rows.
  const model = (env.DEFENSE_EMBEDDING_MODEL ?? env.EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDING_MODEL).trim();
  if (model === '') {
    return dark('embedding', 'embedding model id resolved empty');
  }

  const timeoutMs = boundedInteger(
    env.DEFENSE_EMBEDDING_TIMEOUT_MS,
    PROVIDER_LIMITS.defaultTimeoutMs,
    PROVIDER_LIMITS.minTimeoutMs,
    PROVIDER_LIMITS.maxTimeoutMs,
  );
  if (timeoutMs === null) {
    return dark(
      'embedding',
      `DEFENSE_EMBEDDING_TIMEOUT_MS must be an integer in [${PROVIDER_LIMITS.minTimeoutMs}, ${PROVIDER_LIMITS.maxTimeoutMs}]`,
    );
  }

  const maxAttempts = boundedInteger(
    env.DEFENSE_EMBEDDING_MAX_ATTEMPTS,
    PROVIDER_LIMITS.defaultAttempts,
    PROVIDER_LIMITS.minAttempts,
    PROVIDER_LIMITS.maxAttempts,
  );
  if (maxAttempts === null) {
    return dark(
      'embedding',
      `DEFENSE_EMBEDDING_MAX_ATTEMPTS must be an integer in [${PROVIDER_LIMITS.minAttempts}, ${PROVIDER_LIMITS.maxAttempts}]`,
    );
  }

  return Object.freeze({
    port: 'embedding' as const,
    mode: 'bedrock_embedding' as const,
    live: true,
    reason: `bedrock embedding provider configured for ${model} in ${region}`,
    resolved: Object.freeze({ region, model, timeoutMs, maxAttempts }),
  });
}

/**
 * Select the client-relevance provider.
 *
 * The transport is the main API's existing internal-service channel — the same
 * static shared secret six other `internal/*` controllers already use. Session 9
 * introduces no new credential CLASS, and the secret is required here for the
 * same reason the guard on the other side is fail-closed: without it the route is
 * unconditionally denied, so calling it would be pointless.
 */
export function selectClientRelevanceProvider(env: NodeJS.ProcessEnv): ProviderSelection {
  const requested = (env.DEFENSE_CLIENT_RELEVANCE_PROVIDER ?? '').trim().toLowerCase();

  if (requested === '' || requested === 'dark' || requested === 'none') {
    return dark('client_relevance', DARK_RELEVANCE_REASON);
  }

  if (requested !== 'internal_service') {
    return dark(
      'client_relevance',
      `unknown DEFENSE_CLIENT_RELEVANCE_PROVIDER "${requested}"; refusing to guess and staying dark`,
    );
  }

  const baseUrl = httpsOrigin(env.DEFENSE_MAIN_API_BASE_URL);
  if (baseUrl === null) {
    return dark(
      'client_relevance',
      'DEFENSE_MAIN_API_BASE_URL must be an https origin with no path, query or fragment',
    );
  }

  // Presence only. The value is never read into a selection, logged or persisted.
  if (!(env.DEFENSE_MAIN_API_INTERNAL_SECRET ?? '').trim()) {
    return dark('client_relevance', 'DEFENSE_MAIN_API_INTERNAL_SECRET is not configured');
  }

  const timeoutMs = boundedInteger(
    env.DEFENSE_CLIENT_RELEVANCE_TIMEOUT_MS,
    PROVIDER_LIMITS.defaultTimeoutMs,
    PROVIDER_LIMITS.minTimeoutMs,
    PROVIDER_LIMITS.maxTimeoutMs,
  );
  if (timeoutMs === null) {
    return dark(
      'client_relevance',
      `DEFENSE_CLIENT_RELEVANCE_TIMEOUT_MS must be an integer in [${PROVIDER_LIMITS.minTimeoutMs}, ${PROVIDER_LIMITS.maxTimeoutMs}]`,
    );
  }

  const maxAttempts = boundedInteger(
    env.DEFENSE_CLIENT_RELEVANCE_MAX_ATTEMPTS,
    PROVIDER_LIMITS.defaultAttempts,
    PROVIDER_LIMITS.minAttempts,
    PROVIDER_LIMITS.maxAttempts,
  );
  if (maxAttempts === null) {
    return dark(
      'client_relevance',
      `DEFENSE_CLIENT_RELEVANCE_MAX_ATTEMPTS must be an integer in [${PROVIDER_LIMITS.minAttempts}, ${PROVIDER_LIMITS.maxAttempts}]`,
    );
  }

  const maxBatch = boundedInteger(
    env.DEFENSE_CLIENT_RELEVANCE_MAX_BATCH,
    PROVIDER_LIMITS.defaultRelevanceBatch,
    1,
    PROVIDER_LIMITS.maxRelevanceBatch,
  );
  if (maxBatch === null) {
    return dark(
      'client_relevance',
      `DEFENSE_CLIENT_RELEVANCE_MAX_BATCH must be an integer in [1, ${PROVIDER_LIMITS.maxRelevanceBatch}]`,
    );
  }

  return Object.freeze({
    port: 'client_relevance' as const,
    mode: 'internal_service_relevance' as const,
    live: true,
    reason: `internal-service relevance provider configured against ${baseUrl}`,
    resolved: Object.freeze({ baseUrl, timeoutMs, maxAttempts, maxBatch }),
  });
}

/**
 * Both selections at once, for a startup log line and for `/readyz` reporting.
 *
 * Deliberately does not fail when a provider is dark: dark is a valid, and today
 * the default, posture.
 */
export function selectCrossDomainProviders(env: NodeJS.ProcessEnv): {
  readonly embedding: ProviderSelection;
  readonly clientRelevance: ProviderSelection;
  readonly anyLive: boolean;
} {
  const embedding = selectEmbeddingProvider(env);
  const clientRelevance = selectClientRelevanceProvider(env);
  return Object.freeze({
    embedding,
    clientRelevance,
    anyLive: embedding.live || clientRelevance.live,
  });
}

export class ForbiddenProviderConfigError extends Error {
  constructor(readonly key: string) {
    super(
      `${key} must not be present on the defense HTTP serve task; Session 9 wires no ` +
        'promoter, snapshot-activation, GPU or parser-model credential.',
    );
    this.name = 'ForbiddenProviderConfigError';
  }
}

/**
 * Credential classes Session 9 must never introduce.
 *
 * Session 3 froze the serve task's environment against promoter,
 * snapshot-activation, NVIDIA, SageMaker-model-admin and parser-model
 * credentials. Session 9 adds an embedding and an internal-service credential —
 * neither of which is in that set — and this assertion exists so a later change
 * cannot quietly smuggle one in under a provider-shaped name.
 */
const FORBIDDEN_PROVIDER_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^DEFENSE_PROMOTER_/,
  /^DEFENSE_SNAPSHOT_ACTIVATION_/,
  /^NVIDIA_/,
  /^SAGEMAKER_MODEL_ADMIN_/,
  /^DEFENSE_PARSER_MODEL_/,
  /GPU_[A-Z_]*CREDENTIAL/,
]);

export function assertNoForbiddenProviderConfig(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_PROVIDER_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new ForbiddenProviderConfigError(key);
    }
  }
}
