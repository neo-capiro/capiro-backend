import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(
    scriptDirectory,
    '../../prisma/migrations/20260818040000_memory_phase2_notification_outbox/migration.sql',
  ),
  'utf8',
);

describe('memory Phase 2 notification outbox migration', () => {
  it('creates a tenant-isolated, idempotent, body-free outbox', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS memory_review_notification_outbox');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("current_setting('app.current_tenant', true)");
    expect(migration).toContain('memory_review_notification_outbox_idempotency_unique');
    expect(migration).toContain('ON CONFLICT (tenant_id, idempotency_key) DO NOTHING');
    expect(migration).toContain("'requiresCurrentAuthorization', true");
    expect(migration).toContain('authorization_required boolean NOT NULL DEFAULT true');
  });

  it('covers each required workflow transition without copying review bodies or reasons', () => {
    for (const eventType of [
      'review_assigned',
      'review_revision_assigned',
      'review_reassigned',
      'review_changes_requested',
      'review_approved',
      'review_rejected',
    ]) {
      expect(migration).toContain(`'${eventType}'`);
    }

    const payloadBuilder = migration.slice(
      migration.indexOf("jsonb_build_object(\n      'workflow'"),
      migration.indexOf('ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;'),
    );
    for (const forbidden of [
      "'value'",
      "'sections'",
      "'body'",
      "'reason'",
      "'feedbackReason'",
      "'sourceExcerpt'",
      "'source_excerpt'",
    ]) {
      expect(payloadBuilder).not.toContain(forbidden);
    }
  });

  it('uses security invoker functions with a pinned search path', () => {
    expect(migration.match(/SECURITY INVOKER/g)?.length).toBe(2);
    expect(migration.match(/SET search_path = public, pg_temp/g)?.length).toBe(2);
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
  });

  it('backfills only current pending assignments and never synthesizes terminal events', () => {
    const backfill = migration.slice(
      migration.indexOf('-- Backfill only current pending assignments.'),
    );
    expect(backfill).toContain("rr.status = 'pending'");
    expect(backfill).toContain('rr.assigned_to IS NOT NULL');
    expect(backfill).not.toContain("rr.status = 'approved'");
    expect(backfill).not.toContain("rr.status = 'rejected'");
    expect(backfill).not.toContain("rr.status = 'changes_needed'");
  });
});
