import type { AssuranceSurface } from '../assurance/risk-gate';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
} from '../rollout/capability-rollout';

export const JEV_PROVIDER_CAPABILITY = 'JEV_PROVIDER' as const;
export const DEFAULT_JEV_MODEL = 'jev-1.13.0';
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';
export const JEV_TASKS = [
  'claim_support',
  'citation_support',
  'passage_relevance',
  'conflict_detection',
  'client_fit',
  'status_selection',
  'program_identity',
  'mention_scope',
  'evidence_selection',
  'bd_entity',
  'bd_signal',
  'bd_claim',
  'capability_routing',
] as const;
export type JevTask = (typeof JEV_TASKS)[number];
export type JevRouting = 'llm' | 'jev' | 'paired' | 'cascade';

export interface JevConfig {
  available: boolean;
  reasons: string[];
  apiKeyPresent: boolean;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxAttempts: number;
  routing: JevRouting;
  tasks: JevTask[];
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function resolveJevConfig(env: CapabilityRolloutEnvironment): JevConfig {
  const reasons: string[] = [];
  const apiKeyPresent = Boolean(env.TYPESAFE_API_KEY?.trim());
  if (!apiKeyPresent) reasons.push('missing_api_key');

  const model = env.MERI_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
  if (!/^jev-\d+\.\d+\.\d+$/.test(model)) reasons.push('moving_alias_or_invalid_model');

  const routingRaw = env.MERI_CHAT_EVIDENCE_JUDGE?.trim().toLowerCase() || 'llm';
  const routing: JevRouting = ['llm', 'jev', 'paired', 'cascade'].includes(routingRaw)
    ? (routingRaw as JevRouting)
    : 'llm';
  if (routingRaw !== routing) reasons.push('invalid_routing');

  const knownTasks = new Set<string>(JEV_TASKS);
  const tokens = String(env.MERI_JEV_TASKS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const tasks = [...new Set(tokens.filter((token): token is JevTask => knownTasks.has(token)))];
  for (const token of tokens.filter((value) => !knownTasks.has(value))) {
    reasons.push(`unknown_task:${token}`);
  }

  return {
    available: apiKeyPresent && reasons.length === 0,
    reasons,
    apiKeyPresent,
    model,
    baseUrl: DEFAULT_JEV_BASE_URL,
    timeoutMs: boundedInteger(env.MERI_JEV_TIMEOUT_MS, 8_000, 500, 30_000),
    maxAttempts: boundedInteger(env.MERI_JEV_MAX_ATTEMPTS, 2, 1, 3),
    routing,
    tasks,
  };
}

export function resolveJevProviderMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({
    capability: JEV_PROVIDER_CAPABILITY,
    env,
    tenantId,
    surface,
  }).mode;
}

interface JevConfigLogger {
  warn(message: string, context?: Record<string, unknown>): unknown;
}

export function logJevConfigIssues(
  logger: JevConfigLogger,
  env: CapabilityRolloutEnvironment,
): void {
  const config = resolveJevConfig(env);
  const rollout = validateCapabilityRolloutConfig({ capability: JEV_PROVIDER_CAPABILITY, env });
  const issues = [...config.reasons, ...rollout.issues];
  if (issues.length) logger.warn('meri.jev.invalid_config', { issues });
}
