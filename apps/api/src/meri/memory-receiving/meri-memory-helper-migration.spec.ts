import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

/** Source packet only; keep this test with the held 100000 migration, outside
 * the Stage1 integration tree until the DDL's target rehearsal qualifies it. */
describe('held memory helper migration', () => {
  it('alters only the existing Option B token store with bounded locks and no new runtime grant', () => {
    const sql = readFileSync('prisma/migrations/20281018100000_meri_memory_eligibility_helper/migration.sql', 'utf8');
    expect(sql).toMatch(/ALTER TABLE "meri_read_tokens"/);
    expect(sql).toMatch(/UNIQUE INDEX "meri_read_tokens_memory_helper_slot_key"/);
    expect(sql).toMatch(/UNIQUE INDEX "meri_read_tokens_memory_helper_parent_key"/);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s'/);
    expect(sql).toMatch(/SET LOCAL statement_timeout = '30s'/);
    const statements = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(statements).not.toMatch(/\bGRANT\b|\bCREATE TABLE\b|\btool_tokens\s*=|current_admission_v1/i);
  });
});
