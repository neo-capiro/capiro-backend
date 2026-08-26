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
 * The literal, unguessable value `ENGAGEMENT_API_PROMOTION_TOKEN` must equal
 * before an `engagement-api` process is allowed to leave shadow posture.
 *
 * This is deliberately NOT a boolean flag. A single `ENGAGEMENT_PROCESS_MODE=
 * active` typo or copy-paste from another service's task definition must not
 * be enough to arm external actions, background workers, callbacks and Recall
 * webhooks on a process that, until this promotion, could not send a single
 * external message. Requiring this exact string is a second, independent
 * signature of intent alongside the five posture fields themselves — a
 * config-file mistake that gets every posture field right by accident still
 * cannot arm the service, because it also has to reproduce this exact string.
 */
export const ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT =
  'i-understand-this-arms-engagement-api-for-external-actions';

/**
 * Boot-time, fail-closed validation for the Engagement runtime controls.
 *
 * The Zod schema still owns the application-wide config object. This preflight
 * exists because a permissive string transform can otherwise turn a typo such
 * as `flase` into false. Both bootstraps call this before Nest constructs any
 * provider, opens a database connection, or starts a worker.
 *
 * Two valid postures for `engagement-api`, never a partial mix of the two:
 *
 *   SHADOW (default): every one of processMode/backgroundOwner/
 *   externalActions/callbacksEnabled/recallWebhookEnabled is at its inert
 *   value. This is the only posture that requires no acknowledgement token —
 *   it is what a freshly-registered task definition gets if nobody sets
 *   anything.
 *
 *   ACTIVE (promoted): processMode=active, backgroundOwner=engagement-api,
 *   externalActions=enabled, callbacksEnabled=true, recallWebhookEnabled=true
 *   — ALL FIVE together, plus ENGAGEMENT_API_PROMOTION_TOKEN matching the
 *   acknowledgement string above. There is no state where some fields are
 *   armed and others are not; resolveEngagementRuntimeEnvironment rejects any
 *   partial combination just as it always rejected an armed field under the
 *   old shadow-only contract.
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
    const isShadow =
      processMode === 'shadow' &&
      backgroundOwner === 'disabled' &&
      externalActions === 'disabled' &&
      !callbacksEnabled &&
      !recallWebhookEnabled;
    const isActive =
      processMode === 'active' &&
      backgroundOwner === 'engagement-api' &&
      externalActions === 'enabled' &&
      callbacksEnabled &&
      recallWebhookEnabled;

    if (!isShadow && !isActive) {
      const violations: string[] = [];
      if (processMode !== 'shadow' && processMode !== 'active') {
        violations.push(`ENGAGEMENT_PROCESS_MODE has an unrecognized value '${processMode}'`);
      }
      violations.push(
        'the five posture fields (ENGAGEMENT_PROCESS_MODE, ENGAGEMENT_BACKGROUND_OWNER, ' +
          'ENGAGEMENT_EXTERNAL_ACTIONS, ENGAGEMENT_CALLBACKS_ENABLED, ' +
          'ENGAGEMENT_RECALL_WEBHOOK_ENABLED) must ALL be at their shadow value or ALL be at ' +
          `their active value — got a partial mix ` +
          `(processMode=${processMode}, backgroundOwner=${backgroundOwner}, ` +
          `externalActions=${externalActions}, callbacksEnabled=${callbacksEnabled}, ` +
          `recallWebhookEnabled=${recallWebhookEnabled})`,
      );
      throw new Error('Invalid engagement-api shadow posture. Required values: ' + violations.join(', '));
    }

    if (isActive) {
      const token = raw.ENGAGEMENT_API_PROMOTION_TOKEN;
      if (String(token ?? '') !== ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT) {
        throw new Error(
          'engagement-api is configured for the ACTIVE posture (every shadow control armed) but ' +
            'ENGAGEMENT_API_PROMOTION_TOKEN does not match the required acknowledgement string. ' +
            'This second signature exists so that arming external actions, background workers, ' +
            'callbacks and Recall webhooks on this service can never happen from getting five ' +
            'independent env vars right by accident. Set ENGAGEMENT_API_PROMOTION_TOKEN to the ' +
            'exact value in ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT if this promotion is deliberate ' +
            'and has been through the same review a shadow-boundary change would get.',
        );
      }
    }
  }

  return resolved;
}

export function assertEngagementRuntimeEnvironment(
  raw: Record<string, unknown>,
): EngagementRuntimeEnvironment {
  return resolveEngagementRuntimeEnvironment(raw);
}
