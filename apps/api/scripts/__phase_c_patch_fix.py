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

path.write_text(source, encoding='utf-8')
print('PHASE_C_PATCH_ANCHORS_FIXED')
