import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260817233500_context_packet_retrieval_context/migration.sql',
  ),
  'utf8',
);

describe('Phase 17 ContextPacket persistence migration', () => {
  test('is additive on the existing context_packet table', () => {
    expect(migration).toContain('ALTER TABLE "context_packet"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "retrieval_context_jsonb" JSONB');
    expect(migration).toContain("DEFAULT '{}'::jsonb");
    expect(migration).not.toMatch(/DROP\s+/i);
    expect(migration).not.toMatch(/CREATE\s+TABLE/i);
  });
});
