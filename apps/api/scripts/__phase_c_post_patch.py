from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
migration_path = (
    ROOT
    / 'apps/api/prisma/migrations/20260728230000_add_tenant_scoped_pe_watch_key/migration.sql'
)
source = migration_path.read_text(encoding='utf-8')

policy_sql = '''

-- The original ProgramElementWatch migration created a tenant_id column but did
-- not enable RLS or install a tenant policy. Phase C establishes the repository's
-- standard fail-closed tenant boundary while introducing the tenant-aware key.
ALTER TABLE "program_element_watch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "program_element_watch" FORCE ROW LEVEL SECURITY;

CREATE POLICY "program_element_watch_isolation" ON "program_element_watch"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
'''

markers = [
    'ALTER TABLE "program_element_watch" ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE "program_element_watch" FORCE ROW LEVEL SECURITY;',
    'CREATE POLICY "program_element_watch_isolation" ON "program_element_watch"',
]
found = [marker in source for marker in markers]
if any(found) and not all(found):
    raise RuntimeError('Phase C PE-watch RLS controls are only partially present')
if not any(found):
    source = source.rstrip() + policy_sql

migration_path.write_text(source.rstrip() + '\n', encoding='utf-8')

# The pre-existing service spec counted every global $queryRaw call as an MV
# lookup even though getProgramElement also queries the catalog-wide current FY.
# Phase C now runs this suite as a release gate. Make the fixture classify the
# query by SQL text so the original bill-count assertions measure what they say.
spec_path = ROOT / 'apps/api/src/program-element/program-element-read.service.spec.ts'
spec = spec_path.read_text(encoding='utf-8')
old = '''    $queryRaw: jest.fn(async () => {
      mock.mvQueryRawCalls += 1;
      return options.mvRows ?? [];
    }),'''
new = '''    $queryRaw: jest.fn(async (query: unknown) => {
      const sql = query as { strings?: readonly string[] };
      const text = [...(sql.strings ?? [])].join('?');
      if (text.includes('FROM program_element_detail_mv')) {
        mock.mvQueryRawCalls += 1;
        return options.mvRows ?? [];
      }
      return [];
    }),'''
count = spec.count(old)
if count != 1:
    raise RuntimeError(f'expected one global-query mock block, found {count}')
spec_path.write_text(spec.replace(old, new, 1), encoding='utf-8')

print('PHASE_C_POST_GENERATION_CONTROLS_APPLIED')
