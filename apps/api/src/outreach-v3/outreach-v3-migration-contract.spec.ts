import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'prisma'))) return cwd;
  return resolve(cwd, 'apps/api');
}

const migration = readFileSync(
  resolve(
    apiRoot(),
    'prisma/migrations/20260908010000_outreach_v3_campaign_state/migration.sql',
  ),
  'utf8',
);

describe('Outreach V3 Phase 2 migration retention contract', () => {
  it('uses trigger enforcement rather than trusting REVOKE for session/proposal deletion', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION reject_outreach_v3_delete()');
    expect(migration).toContain('CREATE TRIGGER "outreach_sessions_delete_protected"');
    expect(migration).toContain('CREATE TRIGGER "outreach_command_proposals_delete_protected"');
    expect(migration).toContain("current_setting('app.allow_audit_purge', true) = 'on'");
    expect(migration).toContain('delete-protected; archive/decide it instead');
  });

  it('keeps immutable versions/events protected independently', () => {
    expect(migration).toContain('CREATE TRIGGER "outreach_state_versions_append_only"');
    expect(migration).toContain('CREATE TRIGGER "outreach_events_append_only"');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION reject_outreach_v3_history_mutation()');
  });

  it('keeps proposal updates on the explicit pending-to-terminal state machine', () => {
    expect(migration).toContain('CREATE TRIGGER "outreach_command_proposals_lifecycle"');
    expect(migration).toContain("IF OLD.status <> 'pending' THEN");
    expect(migration).toContain("NEW.status NOT IN ('applied', 'rejected', 'superseded')");
    expect(migration).toContain('outreach proposal content is immutable');
  });
});
