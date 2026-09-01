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

  it('selects only unresolved applyable Advocacy review kinds for the same tenant and client', () => {
    expect(migration).toContain('f.tenant_id = NEW.tenant_id');
    expect(migration).toContain('f.client_id = NEW.client_id');
    expect(migration).toContain("f.status = 'pending'");
    for (const kind of ['advocacy_record', 'advocacy_outcome', 'regulatory_outcome']) {
      expect(migration).toContain(`'${kind}'`);
    }
  });

  it('does not steal pending work from another active run if two run creators race', () => {
    expect(migration).toContain("prior_run.status <> 'running'");
  });

  it('never resurrects a content hash that already has an accepted or rejected decision', () => {
    expect(migration).toContain('terminal.content_hash = pending.content_hash');
    expect(migration).toContain("terminal.status IN ('accepted', 'rejected')");
  });

  it('moves the same newest pending finding row instead of cloning review work', () => {
    expect(migration).toContain('ROW_NUMBER() OVER');
    expect(migration).toContain('PARTITION BY pending.content_hash');
    expect(migration).toContain('ORDER BY pending.created_at DESC, pending.id DESC');
    expect(migration).toContain('SET run_id = NEW.id');
    expect(migration).toContain('eligible.review_rank = 1');
    expect(migration).not.toMatch(/INSERT\s+INTO\s+client_profile_fill_finding/i);
  });

  it('locks pending rows before re-homing so an in-flight review keeps one stable finding id', () => {
    expect(migration).toContain('FOR UPDATE OF f');
    expect(migration).toContain('RETURNING current_review.id');
  });

  it('retires only duplicate or terminal-shadowed historical pending copies', () => {
    expect(migration).toContain("SET status = 'informational'");
    expect(migration).toMatch(/NOT EXISTS\s*\(\s*SELECT 1\s+FROM moved[\s\S]*moved\.id = retire\.id/);
  });

  it('does not rewind source cursors or create canonical Advocacy records', () => {
    expect(migration).not.toContain('client_profile_fill_source_cursor');
    expect(migration).not.toContain('client_advocacy_record');
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
