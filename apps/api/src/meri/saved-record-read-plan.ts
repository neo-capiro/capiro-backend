import { BadRequestException } from '@nestjs/common';

/** Preparation only. The eventual caller must use the existing authenticated
 * HTTP boundary; invoking controller/service methods directly skips guards.
 * No private SQL registry, tenant argument, credential or transport is added. */
export const SAVED_RECORD_READ_SOURCES = Object.freeze({
  billing_state: {
    path: '/api/billing/state',
    guards: ['TenantContext'],
    fields: [
      'billingEnabled',
      'status',
      'slots',
      'usedSlots',
      'trialEndsAt',
      'onboardingFlowVersion',
      'locked',
    ],
    limitation:
      'Minimal posture only; no prices, costs or payment details. Counts retain the existing billing owner definition.',
  },
  billing_summary: {
    path: '/api/billing/summary',
    guards: ['TenantContext', 'RolesGuard:user_admin', 'BillingAdminGuard'],
    fields: [
      'billingEnabled',
      'status',
      'slots',
      'usedSlots',
      'pricePerSlotUsd',
      'llmAllowanceUsd',
      'llmUsedUsd',
      'llmOverageUsd',
      'llmWarn',
      'llmHardCapUsd',
      'currentPeriodEnd',
      'hasSubscription',
    ],
    limitation:
      'Current billing administrator only. Existing computed USD numbers are not exact-decimal SQL output; no invoice, card, Stripe ID or payment-method inventory.',
  },
  usage_summary: {
    path: '/api/ai-usage/summary',
    guards: ['TenantContext', 'RolesGuard:user_admin'],
    fields: [
      'from',
      'to',
      'eventCount',
      'totalCostUsd',
      'totalInputTokens',
      'totalOutputTokens',
      'tenantKeyEventCount',
      'byWorkflow',
      'byModel',
      'byDay',
    ],
    limitation:
      'The existing usage owner bounds the date range and computes numeric totals. No cross-tenant admin view or credential endpoint.',
  },
  usage_events: {
    path: '/api/ai-usage/events',
    guards: ['TenantContext', 'RolesGuard:user_admin'],
    fields: [
      'id',
      'tenantId',
      'userId',
      'workflow',
      'provider',
      'model',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheCreationTokens',
      'costUsd',
      'usedTenantKey',
      'promptSpecVersion',
      'createdAt',
    ],
    limitation:
      'Most recent events only, at most 100; no exhaustive cursor or full audit history is implied.',
  },
  tenant_contact: {
    path: '/api/tenant-admin/contact-info',
    guards: ['TenantContext', 'RolesGuard:standard_user'],
    fields: [
      'name',
      'phone',
      'email',
      'mailingStreet1',
      'mailingStreet2',
      'mailingCity',
      'mailingStateZip',
      'permanentStreet1',
      'permanentStreet2',
      'permanentCity',
      'permanentStateZip',
    ],
    limitation:
      'Existing contact-info GET allows standard users and returns its saved contactInfo object. Listed fields are the canonical write DTO; legacy extra keys are not validated by that reader. No arbitrary tenant settings, identity-directory, audit-log or integration-credential access.',
  },
  legiwatch_saved_items: {
    path: '/api/legiwatch/live-hearings/saved-items',
    guards: ['TenantContext', 'RolesGuard:standard_user'],
    fields: [
      'id',
      'kind',
      'hearingId',
      'segmentId',
      'insightId',
      'clientId',
      'note',
      'createdAt',
      'detailPath',
    ],
    limitation:
      'Caller-owned saved hearing references and full saved notes, not transcript/intelligence contents. Existing numbered paging is not a stable snapshot. Client references do not grant client access.',
  },
  legiwatch_notification_preferences: {
    path: '/api/legiwatch/live-hearings/notification-preferences',
    guards: ['TenantContext', 'RolesGuard:standard_user'],
    fields: ['committeeEmailEnabled', 'emailAddress'],
    limitation:
      'Current caller preference and current account email only; no preference change, opt-in or email send.',
  },
} as const);

export type SavedRecordReadKind = keyof typeof SAVED_RECORD_READ_SOURCES;
type Query = Record<string, string | number>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys: Record<SavedRecordReadKind, readonly string[]> = {
  billing_state: [],
  billing_summary: [],
  tenant_contact: [],
  usage_summary: ['from', 'to'],
  usage_events: ['limit'],
  legiwatch_saved_items: ['hearingId', 'clientId', 'page', 'pageSize'],
  legiwatch_notification_preferences: [],
};

/** Only known source inputs are compiled. Caller identity and authority always
 * remain in the trusted authenticated transport, never in the request model. */
export function prepareSavedRecordRead(kind: SavedRecordReadKind, input: Query = {}) {
  if (
    !Object.hasOwn(SAVED_RECORD_READ_SOURCES, kind) ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys[kind].includes(key))
  )
    throw new BadRequestException('Choose a supported saved-record read and filters.');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (['limit', 'page', 'pageSize'].includes(key)) {
      const max = key === 'page' ? 100_000 : 100;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
        throw new BadRequestException('Choose a valid page or limit.');
    } else if (key === 'clientId') {
      if (typeof value !== 'string' || !UUID.test(value))
        throw new BadRequestException('Choose a canonical client ID.');
    } else if (key === 'hearingId') {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > 200 ||
        /[\u0000-\u001f]/.test(value)
      )
        throw new BadRequestException('Choose a saved hearing ID.');
    } else if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw new BadRequestException('Choose an ISO UTC date-time.');
    }
    query.set(key, String(value));
  }
  const source = SAVED_RECORD_READ_SOURCES[kind];
  return Object.freeze({
    kind,
    method: 'GET' as const,
    service: 'core' as const,
    path: source.path + (query.size ? `?${query.toString()}` : ''),
    requiredRuntimeGuards: source.guards,
    coverage: { basis: 'existing_authenticated_owner' as const, limitation: source.limitation },
    // No claim that a route plan itself grants authority or has read any data.
    execution: 'unwired' as const,
  });
}
