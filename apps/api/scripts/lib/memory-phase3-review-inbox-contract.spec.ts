import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';

function resolveApiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'prisma/schema.prisma'))) return cwd;
  const monorepoApi = resolve(cwd, 'apps/api');
  if (existsSync(resolve(monorepoApi, 'prisma/schema.prisma'))) return monorepoApi;
  throw new Error(`Could not resolve apps/api from ${cwd}.`);
}

const apiRoot = resolveApiRoot();
const read = (path: string) => readFileSync(resolve(apiRoot, path), 'utf8');
const readWeb = (path: string) =>
  readFileSync(resolve(apiRoot, '../web', path), 'utf8');
const service = read('src/memory/memory-review-inbox.service.ts');
const controller = read('src/memory/memory-review-inbox.controller.ts');
const compatibility = read(
  'src/reviews/memory-review-compatibility-guard.service.ts',
);
const genericController = read('src/reviews/reviews.controller.ts');
const notificationHelpers = read(
  'src/memory/memory-review-notification.helpers.ts',
);
const databaseAcceptance = read(
  'scripts/verify-memory-phase3-review-inbox-database.ts',
);
const closeout = read('scripts/verify-memory-phase3-review-inbox-closeout.ts');
const host = readWeb('src/components/MemoryGovernanceCenterHost.tsx');
const inboxUi = readWeb('src/components/MemoryReviewInbox.tsx');
const settingsPage = readWeb('src/pages/settings/MemorySettingsPage.tsx');

describe('Memory Review Phase 3 inbox contract', () => {
  it('uses explicit tenant and actor predicates instead of relying on RLS', () => {
    expect(service).toContain('rr.tenant_id = ${ctx.tenantId}::uuid');
    expect(service).toContain(
      'notification.tenant_id = ${ctx.tenantId}::uuid',
    );
    expect(service).toContain(
      'notification.recipient_user_id = ${ctx.userId}::uuid',
    );
    expect(service).toContain('tenant_id = ${ctx.tenantId}::uuid');
    expect(service).toContain('recipient_user_id = ${ctx.userId}::uuid');
  });

  it('keeps broad inbox rows body-free and detail protected', () => {
    expect(service).toContain('inboxSelect()');
    expect(service).toContain('inboxSelect(true)');
    expect(controller).toContain("@Get('inbox/candidates/:id')");
    expect(controller).toContain("@Get('inbox/requests/:id')");
  });

  it('uses stable total-order cursor pagination', () => {
    expect(service).toContain('ORDER BY rr.created_at DESC, rr.id DESC');
    expect(service).toContain('(rr.created_at, rr.id) <');
    expect(service).toContain(
      'ORDER BY notification.created_at DESC, notification.id DESC',
    );
  });

  it('rechecks membership, assignment eligibility, and canonical authorization', () => {
    expect(service).toContain("tm.status = 'active'");
    expect(service).toContain('this.authorization.loadCandidateInTx');
    expect(service).toContain('this.authorization.evaluateInTx');
    expect(service).toContain('client.status::text AS "clientStatus"');
    expect(service).toContain('assignedReviewerEligible');
  });

  it('marks only currently authorized recipient notifications as read', () => {
    expect(service).toContain('notificationVisibleInTx');
    expect(service).toContain('visibleIds');
    expect(service).toContain('recipient_user_id = ${ctx.userId}::uuid');
    expect(service).toContain('AND id IN (${Prisma.join');
  });

  it('prevents the generic review API from reading or deciding memory rows', () => {
    expect(compatibility).toContain("surface = 'memory'");
    expect(compatibility).toContain('tenant_id = ${ctx.tenantId}::uuid');
    expect(genericController).toContain(
      'this.memoryGuard.assertNotMemoryReview',
    );
    expect(genericController).toContain(
      'this.memoryGuard.filterNonMemoryReviews',
    );
  });

  it('mounts one canonical inbox instead of the legacy broad body queues', () => {
    expect(host).toContain('MemoryReviewInbox');
    expect(host).not.toContain('MemoryProposalQueue');
    expect(host).not.toContain('MemoryReviewQueue');
    expect(settingsPage).toContain('MemoryGovernanceCenterHost');
    expect(settingsPage).not.toContain('MemoryReviewStatusSummary');
  });

  it('supports every required plain-English workflow and notification action', () => {
    for (const label of [
      'Needs my review',
      'Submitted by me',
      'All pending',
      'Blocked',
      'History',
      'Request changes',
      'Revise and resubmit',
      'Assign reviewer',
      'Review notifications',
      'Mark all read',
    ]) {
      expect(inboxUi).toContain(label);
    }
    expect(inboxUi).toContain('/api/memory/review/inbox/requests/');
    expect(inboxUi).toContain('/api/memory/review/notifications/read-all');
  });

  it('uses the real nested Settings route for email deep links', () => {
    expect(notificationHelpers).toContain('/settings/memory?review=');
    expect(notificationHelpers).not.toContain('/settings?tab=memory-review');
  });

  it('rehearses the real database boundaries before printing the Phase 3 marker', () => {
    expect(databaseAcceptance).toContain('PHASE3_SECRET_BODY_MUST_NOT_ENTER_THE_INBOX_LIST');
    expect(databaseAcceptance).toContain('former reviewer retained detail access');
    expect(databaseAcceptance).toContain('cross-tenant candidate id was readable');
    expect(databaseAcceptance).toContain('another member marked the recipient notification read');
    expect(databaseAcceptance).toContain('generic review compatibility guard accepted a memory row');
    expect(databaseAcceptance).toContain('MEMORY_PHASE3_DATABASE_ACCEPTANCE_COMPLETE');
    expect(closeout).toContain('verify-memory-phase2-notification-closeout.ts');
    expect(closeout).toContain('verify-memory-phase3-review-inbox-database.ts');
    expect(closeout).toContain('MEMORY_PHASE3_REVIEW_INBOX_CLOSEOUT_COMPLETE');
    expect(closeout).not.toContain("process.env.MEMORY_REVIEW_EMAIL_DELIVERY = 'enforce'");
  });
});
