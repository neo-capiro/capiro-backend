import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase 10 policy-pack lifecycle concurrency migration', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260813020000_policy_pack_lifecycle_concurrency/migration.sql',
    ),
    'utf8',
  );

  it('enforces transition order and append-only reviewer identities in Postgres', () => {
    expect(sql).toContain('enforce_policy_pack_lifecycle_concurrency');
    expect(sql).toContain('policy_pack_first_reviewer_immutable');
    expect(sql).toContain('policy_pack_second_reviewer_immutable');
    expect(sql).toContain('policy_pack_owner_cannot_review');
    expect(sql).toContain('policy_pack_second_reviewer_not_independent');
    expect(sql).toContain('policy_pack_illegal_lifecycle_transition');
    expect(sql).toContain('policy_pack_stale_or_noop_transition');
    expect(sql).toContain('BEFORE UPDATE ON compliance_policy_pack');
  });

  it('freezes decision-bearing material after review starts but preserves rollback transitions', () => {
    expect(sql).toContain('policy_pack_reviewed_material_immutable');
    expect(sql).toContain("OLD.status = 'published' AND NEW.status = 'retired'");
    expect(sql).toContain("OLD.status = 'retired' AND NEW.status = 'published'");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+compliance_policy_pack/i);
    expect(sql).not.toMatch(/UPDATE\s+compliance_policy_pack\s+SET/i);
  });
});
