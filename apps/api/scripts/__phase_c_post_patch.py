from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
path = (
    ROOT
    / 'apps/api/prisma/migrations/20260728230000_add_tenant_scoped_pe_watch_key/migration.sql'
)
source = path.read_text(encoding='utf-8')

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

path.write_text(source.rstrip() + '\n', encoding='utf-8')
print('PHASE_C_RLS_CONTROLS_APPLIED')
