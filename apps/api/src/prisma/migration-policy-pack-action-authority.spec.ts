import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase 10 policy authority migration', () => {
  const sql = readFileSync(
    join(process.cwd(), 'prisma/migrations/20260813010000_policy_pack_action_authority/migration.sql'),
    'utf8',
  );

  it('binds proposal, decision, and compliance evidence to exact policy hashes', () => {
    for (const token of [
      'policy_binding',
      'policy_decision_hash',
      'policy_context_hash',
      'decision_hash',
      'context_hash',
      'policy_effective_user_id',
    ]) expect(sql).toContain(token);
  });

  it('adds revise to the append-only lifecycle without activating any pack', () => {
    expect(sql).toContain("'revise'");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+compliance_policy_pack/i);
  });
});
