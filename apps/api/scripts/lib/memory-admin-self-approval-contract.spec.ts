import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'prisma/schema.prisma'))) return cwd;
  const candidate = resolve(cwd, 'apps/api');
  if (existsSync(resolve(candidate, 'prisma/schema.prisma'))) return candidate;
  throw new Error(`Could not resolve apps/api from ${cwd}.`);
}

const root = apiRoot();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read(
  'prisma/migrations/20260818050000_memory_admin_self_approval_policy/migration.sql',
);
const policy = read('src/memory/memory-review-admin-policy.ts');
const authorization = read('src/memory/memory-authorization.helpers.ts');
const authorizationService = read('src/memory/memory-authorization.service.ts');
const workflow = read('src/memory/memory-review-workflow.service.ts');
const candidate = read('src/memory/memory-candidate.service.ts');
const immutable = read('src/memory/immutable-memory-version.service.ts');
const adminInbox = read('src/memory/memory-review-admin-inbox.service.ts');
const moduleSource = read('src/memory/memory.module.ts');
const editor = readFileSync(resolve(root, '../web/src/components/MemoryFileEditor.tsx'), 'utf8');
const pendingPanel = readFileSync(
  resolve(root, '../web/src/components/PendingMemoryReviewPanel.tsx'),
  'utf8',
);

describe('memory administrator self-approval policy contract', () => {
  it('permits only capability-bearing active tenant administrators at the database boundary', () => {
    expect(migration).toContain("tm.status = 'active'::membership_status");
    expect(migration).toContain("'user_admin'::tenant_role");
    expect(migration).toContain("'capiro_admin'::tenant_role");
    expect(migration).toContain("current_setting('app.memory_admin_review_decision', true)");
    expect(migration).toContain('actor_is_active_admin AND admin_decision_capability');
    expect(migration).toContain('MEMORY_REVIEW_SELF_DECISION_DENIED');
    expect(migration).toContain('MEMORY_REVIEW_ASSIGNED_REVIEWER_REQUIRED');
  });

  it('sets the transaction-local capability only after canonical admin authorization', () => {
    expect(authorizationService).toContain('decision.allowed');
    expect(authorizationService).toContain('options.emitDenialMetrics !== false');
    expect(authorizationService).toContain('isMemoryReviewAdminRole(effectiveRole)');
    expect(authorizationService).toContain(
      "set_config('app.memory_admin_review_decision', 'on', true)",
    );
  });

  it('keeps walls and client status in canonical authorization while exempting admins from self-review denial', () => {
    expect(policy).toContain("role === 'user_admin' || role === 'capiro_admin'");
    expect(authorization).toContain('if (isMemoryReviewAdminRole(effectiveRole)) return false');
    expect(authorization).toContain("reason: 'ethical_wall'");
    expect(authorization).toContain("reason: 'archived_client'");
    expect(authorization).toContain("reason: 'self_review'");
  });

  it('makes assignment optional for admins but preserves it for standard reviewers', () => {
    expect(workflow).toContain('if (!isMemoryReviewAdminRole(ctx.role))');
    expect(workflow).toContain('workflow.assignedTo !== ctx.userId');
    expect(workflow).toContain('A non-admin proposer cannot decide');
    expect(candidate).toContain('isMemoryReviewAdminRole(actorContext?.role)');
    expect(immutable).toContain('!isMemoryReviewAdminRole(ctx.role)');
  });

  it('expands only the admin inbox path and leaves the base service as the security boundary', () => {
    expect(adminInbox).toContain('extends MemoryReviewInboxService');
    expect(adminInbox).toContain('if (!isMemoryReviewAdminRole(ctx.role)) return super.list');
    expect(adminInbox).toContain("requestedView === 'needs_my_review' ? 'all_pending'");
    expect(adminInbox).toContain("this.allowed(ctx, item.candidateId, 'approve')");
    expect(moduleSource).toContain(
      '{ provide: MemoryReviewInboxService, useExisting: MemoryReviewAdminInboxService }',
    );
  });

  it('removes the independent-approver claim from active shared-save copy', () => {
    expect(editor).toContain('Submitted for approval');
    expect(editor).not.toContain('Submitted for independent review');
    expect(pendingPanel).toContain('Waiting for approval');
    expect(pendingPanel).not.toContain('independent reviewer');
  });
});
