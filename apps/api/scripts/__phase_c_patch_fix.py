from pathlib import Path

path = Path(__file__).resolve().with_name('__phase_c_apply_patch.py')
source = path.read_text(encoding='utf-8')

old = r'''replace_once(
    service,
    "        WHERE user_id = ${ctx.userId}::uuid\n"
    "          AND pe_code = ${peCode}\n",
    "        WHERE tenant_id = ${ctx.tenantId}::uuid\n"
    "          AND user_id = ${ctx.userId}::uuid\n"
    "          AND pe_code = ${peCode}\n",
)'''
new = r'''replace_once(
    service,
    "        SELECT id\n"
    "        FROM program_element_watch\n"
    "        WHERE user_id = ${ctx.userId}::uuid\n"
    "          AND pe_code = ${peCode}\n"
    "        LIMIT 1\n",
    "        SELECT id\n"
    "        FROM program_element_watch\n"
    "        WHERE tenant_id = ${ctx.tenantId}::uuid\n"
    "          AND user_id = ${ctx.userId}::uuid\n"
    "          AND pe_code = ${peCode}\n"
    "        LIMIT 1\n",
)'''
if source.count(old) != 1:
    raise RuntimeError(f'expected one ambiguous detail-query patch block, found {source.count(old)}')
source = source.replace(old, new, 1)

# Keep generated TypeScript as normal multiline text. Only the TypeScript string
# passed to Array.join needs a literal backslash-n rather than a real newline.
old_join = "return files.map((path) => readFileSync(path, 'utf8')).join('\\n');"
new_join = "return files.map((path) => readFileSync(path, 'utf8')).join('\\\\n');"
if source.count(old_join) != 1:
    raise RuntimeError(f'expected one migration join expression, found {source.count(old_join)}')
source = source.replace(old_join, new_join, 1)

old_map = r'''  const modeByKey = new Map(\n    preferences.map((pref) => [`${pref.tenantId}:${pref.userId}`, pref.mode] as const),\n  );'''
new_map = r'''  const modeByKey = new Map<string, string>(\n    preferences.map((pref) => [`${pref.tenantId}:${pref.userId}`, pref.mode]),\n  );'''
if source.count(old_map) != 1:
    raise RuntimeError(f'expected one tenant preference map, found {source.count(old_map)}')
source = source.replace(old_map, new_map, 1)

# The original PE-watch table migration never enabled RLS. Phase C is the first
# safe point to establish the repository's standard tenant policy while adding
# the tenant-aware identity key. ALTER ENABLE/FORCE are idempotent. CREATE POLICY
# intentionally fails if an unexpected out-of-band policy with the same name
# exists, forcing review instead of silently replacing a production control.
old_migration_tail = '''CREATE UNIQUE INDEX "program_element_watch_tenant_user_pe_code_key"\n  ON "program_element_watch"("tenant_id", "user_id", "pe_code");\n'''
new_migration_tail = '''CREATE UNIQUE INDEX "program_element_watch_tenant_user_pe_code_key"\n  ON "program_element_watch"("tenant_id", "user_id", "pe_code");\n\nALTER TABLE "program_element_watch" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "program_element_watch" FORCE ROW LEVEL SECURITY;\n\nCREATE POLICY "program_element_watch_isolation" ON "program_element_watch"\n  USING (rls_bypass() OR tenant_id = current_tenant_id())\n  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());\n'''
if source.count(old_migration_tail) != 1:
    raise RuntimeError(
        f'expected one PE-watch migration tail, found {source.count(old_migration_tail)}'
    )
source = source.replace(old_migration_tail, new_migration_tail, 1)

path.write_text(source, encoding='utf-8')
print('PHASE_C_PATCH_ANCHORS_FIXED')
