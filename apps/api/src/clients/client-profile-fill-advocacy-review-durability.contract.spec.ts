import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20280101040000_client_profile_fill_advocacy_review_durability/migration.sql',
  ),
  'utf8',
);

describe('Fill with Meri Advocacy review durability migration', () => {
  it('runs only when a new durable workflow-v2 Fill run is created', () => {
    expect(migration).toContain('AFTER INSERT ON client_profile_fill_run');
    expect(migration).toContain('FOR EACH ROW');
    expect(migration).toContain('COALESCE(NEW.workflow_version, 1) < 2');
    expect(migration).toContain('RETURN NEW');
  });

  it('carries only unresolved applyable Advocacy review kinds for the same tenant and client', () => {
    expect(migration).toContain('f.tenant_id = NEW.tenant_id');
    expect(migration).toContain('f.client_id = NEW.client_id');
    expect(migration).toContain("f.status = 'pending'");
    for (const kind of ['advocacy_record', 'advocacy_outcome', 'regulatory_outcome']) {
      expect(migration).toContain(`'${kind}'`);
    }
  });

  it('never resurrects a content hash that already has an accepted or rejected decision', () => {
    expect(migration).toContain('terminal.content_hash = pending.content_hash');
    expect(migration).toContain("terminal.status IN ('accepted', 'rejected')");
  });

  it('deduplicates historical pending copies and remains idempotent for the current run', () => {
    expect(migration).toContain('DISTINCT ON (pending.content_hash)');
    expect(migration).toContain(
      'ORDER BY pending.content_hash, pending.created_at DESC, pending.id DESC',
    );
    expect(migration).toContain('ON CONFLICT (run_id, content_hash) DO NOTHING');
  });

  it('serializes against concurrent review and retires old pending rows only after a current copy exists', () => {
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("SET status = 'informational'");
    expect(migration).toMatch(/EXISTS\s*\(\s*SELECT 1\s+FROM inserted[\s\S]*inserted\.content_hash = old\.content_hash/);
  });

  it('does not rewind source cursors or create canonical Advocacy records', () => {
    expect(migration).not.toContain('client_profile_fill_source_cursor');
    expect(migration).not.toContain('client_advocacy_record');
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
