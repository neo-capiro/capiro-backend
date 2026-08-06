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
const service = read('src/memory/memory-review-inbox.service.ts');
const controller = read('src/memory/memory-review-inbox.controller.ts');
const compatibility = read('src/reviews/memory-review-compatibility-guard.service.ts');
const genericController = read('src/reviews/reviews.controller.ts');

describe('Memory Review Phase 3 inbox contract', () => {
  it('uses explicit tenant and actor predicates instead of relying on RLS', () => {
    expect(service).toContain('rr.tenant_id = ${ctx.tenantId}::uuid');
    expect(service).toContain('notification.tenant_id = ${ctx.tenantId}::uuid');
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
    expect(genericController).toContain('this.memoryGuard.assertNotMemoryReview');
    expect(genericController).toContain('this.memoryGuard.filterNonMemoryReviews');
  });
});
