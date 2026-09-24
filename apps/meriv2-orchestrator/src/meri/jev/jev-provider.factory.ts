import { Logger } from '@nestjs/common';
import {
  RecordedDecisionStore,
  createClientFitProvider,
  createJevClient,
  createJevDecisionProvider,
  createLlmSkepticJudge,
  createRecordingDecisionProvider,
  createSkepticDecisionProvider,
  LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION,
  resolveJevConfig,
  resolveJevProviderMode,
  resolveJevTaskRegistration,
  resolveMatchLabelMode,
  type CapabilityRolloutEnvironment,
  type ClientFitProvider,
  type DecisionProvider,
  type JevClient,
  type JevRouting,
  type LlmClient,
  type AssuranceSurface,
} from '@capiro/meriv2-core';

const loggedReasons = new Set<string>();
const loggedRegistryMismatches = new Set<string>();
const nestLogger = new Logger('JevProviderFactory');
// One JSON object per line, the shape the orchestrator's structured logger
// produces: a caller that omits `logger` must never hand the event name and
// its fields to Nest as two arguments, which prints a multi-line `Object:`
// block that `readShadowEvents` and `readCanaryEvents` cannot parse.
const defaultLogger: ChatDecisionProviderLogger = {
  warn: (message, context) => nestLogger.warn(JSON.stringify({ event: message, ...context })),
};

export interface ChatDecisionProviderLogger {
  warn(message: string, context?: Record<string, unknown>): unknown;
}

function logRegistryMismatchOnce(
  logger: ChatDecisionProviderLogger,
  task: 'claim_support' | 'passage_relevance' | 'client_fit',
  configuredModel: string,
  registeredModel: string,
): void {
  if (loggedRegistryMismatches.has(task)) return;
  loggedRegistryMismatches.add(task);
  logger.warn('meri.jev.registry_mismatch', { task, configuredModel, registeredModel });
}

export interface CreateChatDecisionProvidersInput {
  env: CapabilityRolloutEnvironment;
  tenantId: string;
  surface: 'chat';
  llm: LlmClient;
  logger?: ChatDecisionProviderLogger;
  fetchImpl?: typeof fetch;
}

export interface ChatDecisionProviders {
  jev: DecisionProvider | null;
  /** V1 is retained for live repair; v2 is comparison-only and maps absence truthfully. */
  legacy: DecisionProvider;
  legacyBaseline: DecisionProvider;
  routing: JevRouting;
}

export interface CreateClientFitClientInput {
  env: CapabilityRolloutEnvironment;
  tenantId: string;
  surface: AssuranceSurface;
  logger?: ChatDecisionProviderLogger;
  fetchImpl?: typeof fetch;
}

export function createPassageSelectionClient(input: Omit<CreateChatDecisionProvidersInput, 'llm'>): {
  client: JevClient | null;
  model: string;
  reason: string | null;
} {
  const config = resolveJevConfig(input.env);
  const logger = input.logger ?? defaultLogger;
  const registry = resolveJevTaskRegistration('passage_relevance', config);
  const providerMode = resolveJevProviderMode(input.env, input.tenantId, input.surface);
  const reason = !config.available
    ? config.reasons.join(',') || 'config_unavailable'
    : providerMode === 'off'
      ? 'rollout_off'
      : !config.tasks.includes('passage_relevance')
        ? 'task_not_enabled:passage_relevance'
        : !registry.modelMatches
          ? 'registry_model_mismatch'
          : null;
  if (!registry.modelMatches && config.tasks.includes('passage_relevance')) {
    logRegistryMismatchOnce(logger, 'passage_relevance', config.model, registry.registration.modelVersion);
  }
  if (reason) return { client: null, model: config.model, reason };
  return {
    client: createJevClient({
      apiKey: input.env.TYPESAFE_API_KEY!, model: config.model, baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs, maxAttempts: config.maxAttempts,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    }),
    model: config.model,
    reason: null,
  };
}

export function createClientFitClient(input: CreateClientFitClientInput): {
  client: ClientFitProvider | null;
  model: string;
  reason: string | null;
} {
  const config = resolveJevConfig(input.env);
  const logger = input.logger ?? defaultLogger;
  const registry = resolveJevTaskRegistration('client_fit', config);
  const mode = resolveMatchLabelMode(input.env, input.tenantId, input.surface);
  const reason = !config.available
    ? config.reasons.join(',') || 'config_unavailable'
    : mode === 'off'
      ? 'rollout_off'
      : !config.tasks.includes('client_fit')
        ? 'task_not_enabled:client_fit'
        : !registry.modelMatches
          ? 'registry_model_mismatch'
          : null;
  if (!registry.modelMatches && config.tasks.includes('client_fit')) {
    logRegistryMismatchOnce(logger, 'client_fit', config.model, registry.registration.modelVersion);
  }
  if (reason) return { client: null, model: config.model, reason };
  const transport = createJevClient({
    apiKey: input.env.TYPESAFE_API_KEY!, model: config.model, baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs, maxAttempts: config.maxAttempts,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  return {
    client: createClientFitProvider({
      client: transport, model: config.model,
      scope: { tenantId: input.tenantId, surface: input.surface },
    }),
    model: config.model,
    reason: null,
  };
}

function logUnavailableOnce(logger: ChatDecisionProviderLogger, reason: string): void {
  if (loggedReasons.has(reason)) return;
  loggedReasons.add(reason);
  logger.warn('meri.jev.provider_unavailable', { reason });
}

export function createChatDecisionProviders(
  input: CreateChatDecisionProvidersInput,
): ChatDecisionProviders {
  const config = resolveJevConfig(input.env);
  const logger = input.logger ?? defaultLogger;
  const registry = resolveJevTaskRegistration('claim_support', config);
  const legacyLive = createSkepticDecisionProvider(
    createLlmSkepticJudge(input.llm, { maxTokens: 512 }),
    'request-scoped-llm',
  );
  const legacyBaselineLive = createSkepticDecisionProvider(
    createLlmSkepticJudge(input.llm, { maxTokens: 512 }),
    'request-scoped-llm',
    LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION,
  );
  const recordingPath = input.env.MERI_JEV_RECORDING_PATH?.trim();
  const store = recordingPath ? new RecordedDecisionStore(recordingPath) : null;
  const legacy = store
    ? createRecordingDecisionProvider({
        live: legacyLive,
        store,
        model: 'request-scoped-llm',
        provider: 'legacy-skeptic',
      })
    : legacyLive;
  const legacyBaseline = store
    ? createRecordingDecisionProvider({
        live: legacyBaselineLive,
        store,
        model: 'request-scoped-llm',
        provider: 'legacy-skeptic',
      })
    : legacyBaselineLive;

  const providerMode = resolveJevProviderMode(input.env, input.tenantId, input.surface);
  let unavailableReason: string | null = null;
  if (!config.available) unavailableReason = config.reasons.join(',') || 'config_unavailable';
  else if (providerMode === 'off') unavailableReason = 'rollout_off';
  else if (!['paired', 'jev', 'cascade'].includes(config.routing)) unavailableReason = `routing:${config.routing}`;
  else if (!config.tasks.includes('claim_support')) unavailableReason = 'task_not_enabled:claim_support';
  else if (!registry.modelMatches && config.routing !== 'paired') unavailableReason = 'registry_model_mismatch';

  if (!registry.modelMatches && config.tasks.includes('claim_support')) {
    logRegistryMismatchOnce(logger, 'claim_support', config.model, registry.registration.modelVersion);
  }

  if (unavailableReason) {
    logUnavailableOnce(logger, unavailableReason);
    return { jev: null, legacy, legacyBaseline, routing: config.routing };
  }

  const client = createJevClient({
    apiKey: input.env.TYPESAFE_API_KEY!,
    model: config.model,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const jevLive = createJevDecisionProvider({
    client,
    model: config.model,
    scope: { tenantId: input.tenantId, surface: input.surface },
  });
  const jev = store
    ? createRecordingDecisionProvider({ live: jevLive, store, model: config.model, provider: 'jev' })
    : jevLive;
  return { jev, legacy, legacyBaseline, routing: config.routing };
}

/** Tests only: preserves production once-per-process rate limiting. */
export function resetJevProviderFactoryWarningsForTest(): void {
  loggedReasons.clear();
  loggedRegistryMismatches.clear();
}