import { integrationActions, integrationStatusProjection, resourceSyncHealth, runSyncResources, verifiedScopeState } from './integration-health.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

const at = '2026-10-24T12:00:00.000Z';
const stats = { failed: 0, hasMore: false };

test.each(['api', 'engagement-api'] as const)(
  'projects integrations-only capability holds in %s',
  (serviceName) => {
    for (const callbacksEnabled of [false, true]) {
      const policy = new EngagementRuntimePolicyService({
        serviceName,
        processMode: 'shadow',
        backgroundOwner: 'disabled',
        externalActions: 'integrations_only',
        callbacksEnabled,
        recallWebhookEnabled: false,
      });
      const actions = integrationActions(true, true, policy);
      expect(actions.sync.allowed).toBe(true);
      expect(actions.connect.allowed).toBe(callbacksEnabled);
      expect(actions.subscriptions.allowed).toBe(callbacksEnabled);
      expect(actions.disconnect).toMatchObject({ allowed: false, reason: 'runtime_held' });
      expect(integrationActions(false, false, policy).sync).toMatchObject({
        allowed: false,
        reason: 'oauth_not_configured',
      });
      expect(integrationActions(true, false, policy).subscriptions).toMatchObject({
        allowed: false,
        reason: 'notifications_not_configured',
      });
    }
  },
);

test('configured OAuth does not bypass shadow runtime or missing notification configuration', () => {
  const policy = { snapshot: () => ({ callbacksEnabled: true }), externalActionAllowed: () => false };
  expect(integrationActions(true, true, policy as never).sync).toMatchObject({ configured: true, allowed: false, reason: 'runtime_held' });
  policy.externalActionAllowed = () => true;
  expect(integrationActions(true, false, policy as never).subscriptions).toMatchObject({ allowed: false, reason: 'notifications_not_configured' });
  expect(integrationActions(false, false, policy as never).disconnect.allowed).toBe(true);
});

test('calendar failure does not erase a successful mail resource result', async () => {
  const run = await runSyncResources(undefined, {}, async () => { throw new Error('private'); }, async () => ({ inbox: stats }));
  expect(run.health.calendar?.outcome).toBe('failed');
  expect(run.health.mail?.outcome).toBe('complete');
  expect(run.result.mail).toEqual({ inbox: stats });
  expect(JSON.stringify(run.health)).not.toContain('private');
});

test('mail failure preserves its prior complete batch and calendar progress', async () => {
  const prior = resourceSyncHealth(undefined, [stats], at);
  const run = await runSyncResources({ mail: prior }, {}, async () => stats, async () => { throw new Error('private'); });
  expect(run.health.calendar?.outcome).toBe('complete');
  expect(run.health.mail).toMatchObject({ outcome: 'failed', lastCompleteAt: at, lastSuccessAt: at, hasMore: true });
});

test('pending pages, failed records and held records never advance completion', () => {
  const prior = resourceSyncHealth(undefined, [stats], at);
  for (const partial of [{ hasMore: true }, { failed: 1 }, { held: 1 }])
    expect(resourceSyncHealth(prior, [partial], '2026-10-24T13:00:00.000Z')).toMatchObject({ outcome: 'partial', lastCompleteAt: at });
});

test('unrequested resources are not attempted or relabeled', async () => {
  const prior = resourceSyncHealth(undefined, [stats], at);
  const mail = jest.fn();
  const run = await runSyncResources({ mail: prior }, { mail: false }, async () => stats, mail);
  expect(mail).not.toHaveBeenCalled();
  expect(run.health.mail).toEqual(prior);
});

const row = {
  id: 'synthetic-connection', provider: 'microsoft_365', accountEmail: 'fixture@example.test', displayName: null,
  status: 'connected', scopes: ['requested.only'], lastSyncAt: new Date(at), lastError: null,
  syncState: {},
};

test('historical scope records cannot be advertised as verified grants', () => {
  expect(integrationStatusProjection(row, ['Mail.Read']).permissions).toEqual({
    requestedScopes: ['Mail.Read'], grantedScopes: null, lastVerifiedAt: null,
  });
});

test('scope projection uses actual returned grants and omits private provider state', () => {
  const syncState = verifiedScopeState({
    oauth: { nonce: 'private-nonce' }, mail: { cursor: 'private-cursor' },
    webhooks: { configured: true, subscriptions: [{ id: 'private-id', clientState: 'private-signed-state', resource: 'me/messages', expirationDateTime: at }] },
  }, ['Mail.Read'], new Date(at));
  const projected = integrationStatusProjection({ ...row, syncState }, ['Mail.Read', 'Mail.Send']);
  expect(projected.permissions).toEqual({ requestedScopes: ['Mail.Read', 'Mail.Send'], grantedScopes: ['Mail.Read'], lastVerifiedAt: at });
  expect(projected.subscriptions.resources).toEqual([{ resource: 'me/messages', expiresAt: at, lastRenewedAt: null, needsReauthorization: false }]);
  expect(JSON.stringify(projected)).not.toContain('private-');
  expect(projected).not.toHaveProperty('syncState');
});

test('a last connection sync cannot stand in for mail freshness', () => {
  const projected = integrationStatusProjection(row, []);
  expect(projected.mailCoverage.lastMailSyncAt).toBeNull();
  expect(projected.mailCoverage.sourceStatus).not.toBe('healthy');
});

test('retained resource health cannot override an unavailable mailbox', () => {
  for (const status of ['needs_configuration', 'disabled', 'error']) {
    for (const outcome of ['failed', 'partial']) {
      const projected = integrationStatusProjection({ ...row, status, syncState: {
        health: { mail: { attemptedAt: at, outcome, hasMore: true, failed: 1 } },
      } }, []);
      expect(projected.mailCoverage).toMatchObject({ sourceStatus: 'unavailable', reason: 'mailbox_not_connected' });
    }
  }
});

test('held records degrade connected coverage even after a completed baseline', () => {
  const now = new Date().toISOString();
  const projected = integrationStatusProjection({ ...row, provider: 'google_workspace', syncState: {
    mail: { captureVersion: 1, updatedAt: now, historyId: 'synthetic-history', labels: { ALL: { backfillDone: true } } },
    health: { mail: resourceSyncHealth(undefined, [{ held: 1 }], now) },
  } }, []);
  expect(projected.mailCoverage).toMatchObject({ sourceStatus: 'degraded', reason: 'mail_sync_incomplete', backfillComplete: true });
});
