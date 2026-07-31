from pathlib import Path

path = Path('apps/workspace/src/generation/context-compiler.canonical-memory.spec.ts')
text = path.read_text(encoding='utf-8')
old = '''    expect(memoryQuery!.values).toContainEqual(
      expect.stringContaining('governed_status AS "governedStatus"'),
    );'''
new = '''    expect(
      memoryQuery!.values.some((value) =>
        sqlText(value).includes('governed_status AS "governedStatus"'),
      ),
    ).toBe(true);'''
count = text.count(old)
if count != 1:
    raise SystemExit(f'expected one exact Workspace SQL assertion, found {count}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('PHASE9_WORKSPACE_SQL_OBJECT_FIX_OK')
