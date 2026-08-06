import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '../..');
const read = (path: string) => readFileSync(resolve(apiRoot, path), 'utf8');
const migration = read(
  'prisma/migrations/20260818040200_memory_phase2_notification_dispatcher/migration.sql',
);
const dispatcher = read('src/memory/memory-review-notification-dispatcher.service.ts');
const email = read('src/memory/memory-review-notification-email.service.ts');
const helpers = read('src/memory/memory-review-notification.helpers.ts');
const moduleSource = read('src/memory/memory.module.ts');
const command = read('scripts/dispatch-memory-review-notifications.ts');

describe('memory Phase 2 notification dispatcher contract', () => {
  it('claims work concurrently with bounded leases and retries', () => {
    expect(dispatcher).toContain('FOR UPDATE SKIP LOCKED');
    expect(dispatcher).toContain("leased_until = now() + interval '5 minutes'");
    expect(dispatcher).toContain('const MAX_ATTEMPTS = 8');
    expect(dispatcher).toContain('attempts < ${MAX_ATTEMPTS}');
    expect(dispatcher).toContain('Math.min(60, 2 ** Math.min(row.attempts, 6))');
    expect(dispatcher).toContain("throw new Error('MEMORY_REVIEW_NOTIFICATION_LEASE_LOST')");
  });

  it('re-authorizes every recipient under the exact tenant feature scope', () => {
    expect(dispatcher).toContain('runWithMemoryGovernanceTenant(row.tenantId');
    expect(dispatcher).toContain('memoryReviewSurfaceEnabled()');
    expect(dispatcher).toContain('withTenantUser(');
    expect(dispatcher).toContain("tm.status = 'active'");
    expect(dispatcher).toContain('memoryReviewNotificationMatchesWorkflow');
    expect(dispatcher).toContain('this.authorization.loadCandidateInTx');
    expect(dispatcher).toContain("subject.clientStatus !== 'active'");
    expect(dispatcher).toContain('this.authorization.evaluateInTx');
    expect(dispatcher).toContain('memoryReviewNotificationOperation(eventType)');
  });

  it('creates a recipient-only, tenant-bound in-app projection', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS memory_review_in_app_notification');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("current_setting('app.current_tenant', true)");
    expect(migration).toContain("current_setting('app.current_user', true)");
    expect(migration).toContain('memory_review_in_app_notification_idempotency_unique');
    expect(migration).toContain('memory_review_in_app_notification_review_fk');
    expect(migration).toContain('memory_review_in_app_notification_candidate_fk');
    expect(migration).toMatch(
      /memory_review_notification_outbox_recipient_fk[\s\S]{0,240}ON DELETE RESTRICT/,
    );
    expect(migration).toMatch(
      /memory_review_in_app_notification_recipient_fk[\s\S]{0,240}ON DELETE RESTRICT/,
    );
    expect(dispatcher).toContain('ON CONFLICT (');
    expect(dispatcher).toContain('DO NOTHING');
  });

  it('keeps delivery bodies and reviewer feedback out of both channels', () => {
    const inAppInsert = dispatcher.slice(
      dispatcher.indexOf('INSERT INTO memory_review_in_app_notification'),
      dispatcher.indexOf('const uncertainPriorEmailAttempt'),
    );
    const renderFunction = helpers.slice(
      helpers.indexOf('export function renderMemoryReviewNotificationEmail'),
      helpers.indexOf('export function normalizeNotificationTitle'),
    );
    for (const forbidden of [
      'sourceExcerpt',
      'source_excerpt',
      'feedbackReason',
      "'sections'",
      "'value'",
      "'body'",
      "'reason'",
    ]) {
      expect(inAppInsert).not.toContain(forbidden);
      expect(renderFunction).not.toContain(forbidden);
    }
    expect(migration).toContain("'feedbackReason'");
    expect(migration).toContain("'sourceExcerpt'");
  });

  it('uses default-off at-most-once email delivery and preserves prior outcomes', () => {
    expect(helpers).toContain("raw?.trim().toLowerCase() === 'enforce'");
    expect(email).toContain('MEMORY_REVIEW_EMAIL_DELIVERY');
    expect(dispatcher).toContain("row.emailStatus === 'sending'");
    expect(dispatcher).toContain("SET email_status = 'sending'");
    expect(dispatcher).toContain('completedEmailStatus(row.emailStatus)');
    expect(dispatcher).toContain('outbox.provider_message_id AS "providerMessageId"');
    expect(dispatcher).not.toContain('reason: authorized');
    expect(email).not.toContain('input.reason');
  });

  it('wires the dispatcher without scheduling or enabling it', () => {
    expect(moduleSource).toContain('MemoryReviewNotificationDispatcherService');
    expect(moduleSource).toContain('MemoryReviewNotificationEmailService');
    expect(command).toContain('dispatchBatch(limit)');
    expect(command).toContain('MEMORY_REVIEW_NOTIFICATION_DISPATCH');
    expect(command).not.toContain("process.env.MEMORY_CLIENT_REVIEW =");
    expect(command).not.toContain("process.env.MEMORY_REVIEW_EMAIL_DELIVERY =");
  });

  it('reports every successful in-app delivery independently of email outcome', () => {
    expect(dispatcher).toContain('summary.delivered += 1');
    expect(dispatcher).toContain('summary[outcome] += 1');
  });
});
