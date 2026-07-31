from pathlib import Path

path = Path('apps/workspace/src/generation/context-compiler.canonical-memory.spec.ts')
text = path.read_text(encoding='utf-8')

replacements = [
    (
        '''    const sql: string[] = [];
    const executions: Array<{ sql: string; values: unknown[] }> = [];''',
        '''    const sql: string[] = [];
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const executions: Array<{ sql: string; values: unknown[] }> = [];''',
    ),
    (
        '''      $queryRaw: jest.fn(async (arg: unknown, ...values: unknown[]) => {
        const text = sqlText(arg);
        sql.push(text);''',
        '''      $queryRaw: jest.fn(async (arg: unknown, ...values: unknown[]) => {
        const text = sqlText(arg);
        sql.push(text);
        queries.push({ sql: text, values });''',
    ),
    (
        '''    return { service: new WorkspaceContextCompilerService(prisma), sql, executions };''',
        '''    return {
      service: new WorkspaceContextCompilerService(prisma),
      sql,
      queries,
      executions,
    };''',
    ),
    (
        '''    expect(h.sql.find((text) => text.includes('FROM memory_items'))).toContain(
      'governed_status AS "governedStatus"',
    );''',
        '''    const memoryQuery = h.queries.find((entry) => entry.sql.includes('FROM memory_items'));
    expect(memoryQuery).toBeDefined();
    expect(memoryQuery!.values).toContainEqual(
      expect.stringContaining('governed_status AS "governedStatus"'),
    );''',
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected one exact match, found {count}: {old[:120]!r}')
    text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
print('PHASE9_WORKSPACE_HARNESS_FIX_OK')
