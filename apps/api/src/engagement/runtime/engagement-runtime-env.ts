import type {
  CapiroServiceName,
  EngagementBackgroundOwner,
  EngagementBackgroundWorkerRestriction,
  EngagementExternalActionMode,
  EngagementMailHandoffSelection,
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
  backgroundWorkerRestriction?: EngagementBackgroundWorkerRestriction;
  /** Mail-handoff selection; absent or 'off' preserves legacy behavior. */
  mailHandoff?: EngagementMailHandoffSelection;
}

const MAIL_HANDOFF_PHASES = ['off', 'initiation_fenced', 'callback_fenced', 'writers_closed'] as const;

/**
 * Parse the operator mail-handoff selection.
 *
 * Omitted or blank keeps legacy behavior (no selection). A phase must be one of
 * the four known values; the companion generation/fence instant may not appear
 * without a phase, because a companion alone is an ambiguous half-configuration
 * that must fail closed rather than silently leave the fence off. An instant must
 * be a real ISO-8601 value: an unparseable one is rejected, and an omitted one is
 * recorded as unproven (null) rather than substituted with the epoch.
 */
export function parseEngagementMailHandoffSelection(
  raw: Record<string, unknown>,
): EngagementMailHandoffSelection | undefined {
  const rawPhase = raw.ENGAGEMENT_MAIL_HANDOFF_PHASE;
  const rawGeneration = raw.ENGAGEMENT_MAIL_HANDOFF_GENERATION;
  const rawFenceUtc = raw.ENGAGEMENT_MAIL_HANDOFF_FENCE_UTC;
  const phase = rawPhase == null ? '' : String(rawPhase).trim().toLowerCase();
  const generation = rawGeneration == null ? '' : String(rawGeneration).trim();
  const fenceUtcRaw = rawFenceUtc == null ? '' : String(rawFenceUtc).trim();

  if (phase === '') {
    if (generation !== '' || fenceUtcRaw !== '') {
      throw new Error(
        'ENGAGEMENT_MAIL_HANDOFF_GENERATION and ENGAGEMENT_MAIL_HANDOFF_FENCE_UTC require ' +
          'ENGAGEMENT_MAIL_HANDOFF_PHASE; a companion without a phase is a partial ' +
          'configuration and is refused.',
      );
    }
    return undefined;
  }
  if (phase === 'off') {
    if (generation !== '' || fenceUtcRaw !== '') {
      throw new Error(
        'ENGAGEMENT_MAIL_HANDOFF_PHASE=off must not carry a generation or fence instant; ' +
          'an explicit off selection is the legacy behavior with no companion values.',
      );
    }
    // An explicit 'off' is the legacy behavior, not a selection: keep it absent so
    // every consumer's "no selection" path stays the single legacy path.
    return undefined;
  }
  if (!MAIL_HANDOFF_PHASES.includes(phase as (typeof MAIL_HANDOFF_PHASES)[number])) {
    throw new Error(
      `ENGAGEMENT_MAIL_HANDOFF_PHASE must be one of: ${MAIL_HANDOFF_PHASES.join(', ')} ` +
        `(got ${JSON.stringify(String(rawPhase))})`,
    );
  }
  let fenceUtc: string | null = null;
  if (fenceUtcRaw !== '') {
    const parsed = new Date(fenceUtcRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        'ENGAGEMENT_MAIL_HANDOFF_FENCE_UTC must be an ISO-8601 instant ' +
          `(got ${JSON.stringify(String(rawFenceUtc))})`,
      );
    }
    fenceUtc = parsed.toISOString();
  }
  return {
    phase: phase as (typeof MAIL_HANDOFF_PHASES)[number],
    generation: generation === '' ? null : generation,
    fenceUtc,
  };
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
 * Parse the opt-in background-worker restriction.
 *
 * Omitted or blank keeps the legacy generic-ownership behavior, so a
 * hand-edited task definition that blanks the value cannot crash-loop the API
 * over a variable it deliberately does not set. A non-blank value must be the
 * single supported token: anything else fails closed instead of being silently
 * ignored or widened into a worker list.
 */
export function parseEngagementBackgroundWorkerRestriction(
  raw: unknown,
): EngagementBackgroundWorkerRestriction | undefined {
  const value = raw == null ? '' : String(raw).trim().toLowerCase();
  if (value === '') return undefined;
  if (value !== 'integration_sync_scheduler') {
    throw new Error(
      'ENGAGEMENT_BACKGROUND_WORKER_RESTRICTION must be omitted or exactly ' +
        `'integration_sync_scheduler' (got ${JSON.stringify(String(raw))})`,
    );
  }
  return value;
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
 * Existing shadow/active postures remain unchanged. The integrations_only
 * action mode adds a bounded Mail posture with no background or Recall ownership
 * by default; callbacks can be enabled explicitly for isolated test
 * OAuth/subscriptions. One named exception is admitted: serviceName=api with an
 * explicitly set ENGAGEMENT_BACKGROUND_OWNER=api may run only the existing
 * engagement-sync-scheduler under the runtime policy.
 *
 * One further opt-in control narrows an otherwise generic owner:
 * ENGAGEMENT_BACKGROUND_WORKER_RESTRICTION=integration_sync_scheduler admits
 * only the existing engagement-sync-scheduler worker, and only on the
 * api/active/api/enabled/callbacks=true/Recall=false tuple. Omitted keeps the
 * legacy generic ownership behavior unchanged.
 * integrations_and_notetaker separately enables existing Recall capture and
 * debrief generation, with an explicit API owner and both callback gates on.
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
    ['disabled', 'test_only', 'enabled', 'integrations_only', 'integrations_and_notetaker'] as const,
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
  const backgroundWorkerRestriction = parseEngagementBackgroundWorkerRestriction(
    raw.ENGAGEMENT_BACKGROUND_WORKER_RESTRICTION,
  );
  const mailHandoff = parseEngagementMailHandoffSelection(raw);

  const resolved: EngagementRuntimeEnvironment = {
    serviceName,
    processMode,
    backgroundOwner,
    externalActions,
    callbacksEnabled,
    recallWebhookEnabled,
    backgroundWorkerRestriction,
    mailHandoff,
  };

  // The restriction narrows the worker surface, so it is valid only for the
  // intended main-API tuple. An explicit selection outside that tuple fails
  // closed rather than quietly changing which workers run.
  if (backgroundWorkerRestriction) {
    const compatible =
      serviceName === 'api' &&
      processMode === 'active' &&
      backgroundOwner === 'api' &&
      externalActions === 'enabled' &&
      callbacksEnabled &&
      !recallWebhookEnabled;
    if (!compatible) {
      throw new Error(
        'ENGAGEMENT_BACKGROUND_WORKER_RESTRICTION=integration_sync_scheduler requires ' +
          'CAPIRO_SERVICE_NAME=api, ENGAGEMENT_PROCESS_MODE=active, ' +
          'ENGAGEMENT_BACKGROUND_OWNER=api, ENGAGEMENT_EXTERNAL_ACTIONS=enabled, ' +
          'ENGAGEMENT_CALLBACKS_ENABLED=true and ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false.',
      );
    }
  }

  if (externalActions === 'integrations_and_notetaker') {
    const explicit = ['CAPIRO_SERVICE_NAME', 'ENGAGEMENT_PROCESS_MODE', 'ENGAGEMENT_BACKGROUND_OWNER',
      'ENGAGEMENT_CALLBACKS_ENABLED', 'ENGAGEMENT_RECALL_WEBHOOK_ENABLED']
      .every((key) => raw[key] != null && String(raw[key]).trim() !== '');
    if (!explicit || serviceName !== 'api' || processMode !== 'shadow' ||
      backgroundOwner !== 'api' || !callbacksEnabled || !recallWebhookEnabled) {
      throw new Error(
        'ENGAGEMENT_EXTERNAL_ACTIONS=integrations_and_notetaker requires explicit ' +
          'CAPIRO_SERVICE_NAME=api, ENGAGEMENT_PROCESS_MODE=shadow, ENGAGEMENT_BACKGROUND_OWNER=api, ' +
          'ENGAGEMENT_CALLBACKS_ENABLED=true and ENGAGEMENT_RECALL_WEBHOOK_ENABLED=true.',
      );
    }
    return resolved;
  }

  if (externalActions === 'integrations_only') {
    if (
      raw.ENGAGEMENT_CALLBACKS_ENABLED == null ||
      String(raw.ENGAGEMENT_CALLBACKS_ENABLED).trim() === ''
    ) {
      throw new Error(
        'ENGAGEMENT_EXTERNAL_ACTIONS=integrations_only requires an explicit ' +
          'ENGAGEMENT_CALLBACKS_ENABLED=true or false; the live callback default must not arm it.',
      );
    }
    // The disabled owner remains the default bounded posture. The single
    // admitted exception is an explicitly owned API sync posture: the main API
    // service with ENGAGEMENT_BACKGROUND_OWNER set explicitly to 'api'. An
    // omitted or blank owner resolves to the live 'api' default and must not
    // arm that exception.
    const ownerWasExplicit =
      raw.ENGAGEMENT_BACKGROUND_OWNER != null &&
      String(raw.ENGAGEMENT_BACKGROUND_OWNER).trim() !== '';
    const explicitApiOwner = serviceName === 'api' && ownerWasExplicit && backgroundOwner === 'api';
    if (
      processMode !== 'shadow' ||
      (backgroundOwner !== 'disabled' && !explicitApiOwner) ||
      recallWebhookEnabled
    ) {
      throw new Error(
        'ENGAGEMENT_EXTERNAL_ACTIONS=integrations_only requires ' +
          'ENGAGEMENT_PROCESS_MODE=shadow, ENGAGEMENT_BACKGROUND_OWNER=disabled ' +
          "(or an explicit 'api' for CAPIRO_SERVICE_NAME=api) and " +
          'ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false. Callbacks remain explicitly configured.',
      );
    }
    return resolved;
  }

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
