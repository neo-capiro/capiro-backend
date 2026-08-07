import type {
  CapiroServiceName,
  EngagementBackgroundOwner,
  EngagementExternalActionMode,
  EngagementProcessMode,
} from './engagement-runtime.types.js';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

export interface EngagementRuntimeEnvironment {
  serviceName: CapiroServiceName;
  processMode: EngagementProcessMode;
  backgroundOwner: EngagementBackgroundOwner;
  externalActions: EngagementExternalActionMode;
  callbacksEnabled: boolean;
  recallWebhookEnabled: boolean;
}

function exactEnum<T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = raw == null || String(raw).trim() === '' ? fallback : String(raw).trim();
  if (!allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
  return value as T;
}

export function parseExactBooleanEnvironment(
  name: string,
  raw: unknown,
  fallback: boolean,
): boolean {
  if (raw == null || String(raw).trim() === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(
    `${name} must be an exact boolean value: true/1/yes/on or false/0/no/off ` +
      `(got ${JSON.stringify(String(raw))})`,
  );
}

/**
 * Boot-time, fail-closed validation for the Engagement runtime controls.
 *
 * The Zod schema still owns the application-wide config object. This preflight
 * exists because a permissive string transform can otherwise turn a typo such
 * as `flase` into false. Both bootstraps call this before Nest constructs any
 * provider, opens a database connection, or starts a worker.
 */
export function resolveEngagementRuntimeEnvironment(
  raw: Record<string, unknown>,
): EngagementRuntimeEnvironment {
  const serviceName = exactEnum(
    'CAPIRO_SERVICE_NAME',
    raw.CAPIRO_SERVICE_NAME,
    ['api', 'engagement-api'] as const,
    'api',
  );
  const processMode = exactEnum(
    'ENGAGEMENT_PROCESS_MODE',
    raw.ENGAGEMENT_PROCESS_MODE,
    ['shadow', 'active'] as const,
    'active',
  );
  const backgroundOwner = exactEnum(
    'ENGAGEMENT_BACKGROUND_OWNER',
    raw.ENGAGEMENT_BACKGROUND_OWNER,
    ['api', 'engagement-api', 'disabled'] as const,
    'api',
  );
  const externalActions = exactEnum(
    'ENGAGEMENT_EXTERNAL_ACTIONS',
    raw.ENGAGEMENT_EXTERNAL_ACTIONS,
    ['disabled', 'test_only', 'enabled'] as const,
    'enabled',
  );
  const callbacksEnabled = parseExactBooleanEnvironment(
    'ENGAGEMENT_CALLBACKS_ENABLED',
    raw.ENGAGEMENT_CALLBACKS_ENABLED,
    true,
  );
  const recallWebhookEnabled = parseExactBooleanEnvironment(
    'ENGAGEMENT_RECALL_WEBHOOK_ENABLED',
    raw.ENGAGEMENT_RECALL_WEBHOOK_ENABLED,
    true,
  );

  const resolved: EngagementRuntimeEnvironment = {
    serviceName,
    processMode,
    backgroundOwner,
    externalActions,
    callbacksEnabled,
    recallWebhookEnabled,
  };

  if (serviceName === 'engagement-api') {
    const violations: string[] = [];
    if (processMode !== 'shadow') violations.push('ENGAGEMENT_PROCESS_MODE=shadow');
    if (backgroundOwner !== 'disabled') violations.push('ENGAGEMENT_BACKGROUND_OWNER=disabled');
    if (externalActions !== 'disabled') violations.push('ENGAGEMENT_EXTERNAL_ACTIONS=disabled');
    if (callbacksEnabled) violations.push('ENGAGEMENT_CALLBACKS_ENABLED=false');
    if (recallWebhookEnabled) violations.push('ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false');
    if (violations.length > 0) {
      throw new Error(
        'Invalid engagement-api shadow posture. Required values: ' + violations.join(', '),
      );
    }
  }

  return resolved;
}

export function assertEngagementRuntimeEnvironment(
  raw: Record<string, unknown>,
): EngagementRuntimeEnvironment {
  return resolveEngagementRuntimeEnvironment(raw);
}
