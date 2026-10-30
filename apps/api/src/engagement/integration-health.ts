import { getMailSyncCoverage } from './mail-sync-coverage.js';
import type { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

export function integrationActions(configured: boolean, subscriptionsConfigured: boolean,
  policy: EngagementRuntimePolicyService) {
  const callbacks = policy.snapshot().callbacksEnabled;
  const availability = (ready: boolean, allowed: boolean, reason: string) => ({
    configured: ready, allowed: ready && allowed, reason: !ready ? reason : !allowed ? 'runtime_held' : null,
  });
  return {
    connect: availability(configured, callbacks && policy.externalActionAllowed('integration_oauth_start') && policy.externalActionAllowed('integration_oauth_callback'), 'oauth_not_configured'),
    sync: availability(configured, policy.externalActionAllowed('integration_sync'), 'oauth_not_configured'),
    disconnect: availability(true, policy.externalActionAllowed('integration_disconnect'), 'unavailable'),
    subscriptions: availability(configured && subscriptionsConfigured, callbacks && policy.externalActionAllowed('integration_subscription'), 'notifications_not_configured'),
  };
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const instant = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const scopes = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length <= 300))].slice(0, 100) : [];

export interface ResourceSyncHealth {
  attemptedAt: string;
  lastSuccessAt: string | null;
  lastCompleteAt: string | null;
  outcome: 'complete' | 'partial' | 'failed';
  hasMore: boolean;
  failed: number;
}
export type IntegrationSyncHealth = Partial<Record<'calendar' | 'mail', ResourceSyncHealth>>;
type BatchStats = { hasMore?: boolean; failed?: number; held?: number };

export async function runSyncResources<Stats extends BatchStats>(
  previous: IntegrationSyncHealth | undefined,
  input: { calendar?: boolean; mail?: boolean },
  calendar: () => Promise<Stats>, mail: () => Promise<Record<string, Stats>>,
) {
  const health = { ...previous };
  const result: { calendar?: Stats; mail?: Record<string, Stats> } = {};
  const errors: unknown[] = [];
  if (input.calendar !== false) {
    const attemptedAt = new Date().toISOString();
    try { result.calendar = await calendar(); } catch (error) { errors.push(error); }
    health.calendar = resourceSyncHealth(health.calendar, result.calendar ? [result.calendar] : undefined, attemptedAt);
  }
  if (input.mail !== false) {
    const attemptedAt = new Date().toISOString();
    try { result.mail = await mail(); } catch (error) { errors.push(error); }
    health.mail = resourceSyncHealth(health.mail, result.mail ? Object.values(result.mail) : undefined, attemptedAt);
  }
  return { result, health, errors };
}

/** A resource batch succeeds independently; no provider error text enters persistent health. */
export function resourceSyncHealth(previous: ResourceSyncHealth | undefined,
  result: { hasMore?: boolean; failed?: number; held?: number }[] | undefined,
  attemptedAt: string): ResourceSyncHealth {
  const failed = result?.reduce((sum, stats) => sum + (stats.failed ?? 0) + (stats.held ?? 0), 0) ?? 0;
  const hasMore = result?.some((stats) => stats.hasMore) ?? true;
  const complete = result !== undefined && !failed && !hasMore;
  return {
    attemptedAt, lastSuccessAt: result === undefined ? previous?.lastSuccessAt ?? null : attemptedAt,
    lastCompleteAt: complete ? attemptedAt : previous?.lastCompleteAt ?? null,
    outcome: result === undefined ? 'failed' : complete ? 'complete' : 'partial', hasMore, failed,
  };
}

/** New observations must not infer a grant from old requested-scope records. */
export function verifiedScopeState(state: unknown, grantedScopes: string[], now = new Date()) {
  return { ...object(state), scopeVerification: { grantedScopes: scopes(grantedScopes), lastVerifiedAt: now.toISOString() } };
}

function healthProjection(value: unknown): IntegrationSyncHealth {
  const source = object(value), result: IntegrationSyncHealth = {};
  for (const resource of ['calendar', 'mail'] as const) {
    const row = object(source[resource]);
    const attemptedAt = instant(row.attemptedAt);
    if (!attemptedAt || !['complete', 'partial', 'failed'].includes(String(row.outcome))) continue;
    result[resource] = {
      attemptedAt, lastSuccessAt: instant(row.lastSuccessAt), lastCompleteAt: instant(row.lastCompleteAt),
      outcome: row.outcome as ResourceSyncHealth['outcome'], hasMore: row.hasMore === true,
      failed: typeof row.failed === 'number' && Number.isSafeInteger(row.failed) && row.failed >= 0 ? row.failed : 0,
    };
  }
  return result;
}

interface ConnectionProjectionInput {
  id: string; provider: string; accountEmail: string | null; displayName: string | null;
  status: string; scopes: string[]; lastSyncAt: Date | null; lastError: string | null;
  nextSyncAt?: Date | null; syncState: unknown;
  /** Owner of the connection. `engagement/integrations` is caller-scoped, and the
   *  calendar sync receiver re-checks the owner it is handed (B3). */
  createdByUserId?: string | null;
}

/** Settings consumes a safe view, never provider cursors, OAuth state or signed webhook clientState. */
export function integrationStatusProjection(connection: ConnectionProjectionInput, requestedScopes: string[]) {
  const state = object(connection.syncState), verification = object(state.scopeVerification);
  const lastVerifiedAt = instant(verification.lastVerifiedAt);
  const webhooks = object(state.webhooks);
  const subscriptions = Array.isArray(webhooks.subscriptions) ? webhooks.subscriptions.map(object) : [];
  const coverage = getMailSyncCoverage(connection);
  const health = healthProjection(state.health);
  const resources = subscriptions
    .filter((row) => ['me/events', 'me/messages'].includes(String(row.resource)))
    .map((row) => ({
      resource: String(row.resource), expiresAt: instant(row.expirationDateTime),
      lastRenewedAt: instant(row.lastRenewedAt), needsReauthorization: row.needsReauthorization === true,
    }));
  // The stored webhooks.configured flag is written only by the renewal path itself, so a worker
  // that is not running leaves it stale-true after every subscription has lapsed. Derive readiness
  // from the recorded resources with the same predicate configureSubscriptionsByTenant writes that
  // flag with, so Settings cannot keep claiming realtime is configured past expiry.
  const configured = (['me/events', 'me/messages'] as const).every((resource) =>
    resources.some((item) => item.resource === resource && !item.needsReauthorization &&
      item.expiresAt !== null && Date.parse(item.expiresAt) > Date.now()),
  );
  return {
    id: connection.id, provider: connection.provider, accountEmail: connection.accountEmail,
    displayName: connection.displayName, status: connection.status, scopes: connection.scopes,
    lastSyncAt: connection.lastSyncAt, lastError: connection.lastError,
    nextSyncAt: connection.nextSyncAt ?? null,
    // Caller-scoped list; echoed back so the calendar sync receiver can prove the
    // account it was given belongs to the caller. Its absence made every Sync
    // calendar account fail the receiver's ownership check (B3).
    createdByUserId: connection.createdByUserId ?? null,
    permissions: { requestedScopes, grantedScopes: lastVerifiedAt ? scopes(verification.grantedScopes) : null, lastVerifiedAt },
    health, mailCoverage: coverage,
    subscriptions: {
      configured,
      updatedAt: instant(webhooks.updatedAt), lastNotificationAt: instant(webhooks.lastNotificationAt),
      lastLifecycleEvent: ['missed', 'subscriptionRemoved', 'reauthorizationRequired'].includes(String(webhooks.lastLifecycleEvent)) ? String(webhooks.lastLifecycleEvent) : null,
      resources,
    },
  };
}
