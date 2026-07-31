from pathlib import Path
import subprocess
import sys

path = Path('docs/tmp/apply-meriv2-phase9.py')
text = path.read_text(encoding='utf-8')

fixes = [
    (
        """    '''      : sourceFailureCount || missingRequiredLayers.length\n        ? 'degraded' ''',\n    '''      : sourceFailureCount || missingRequiredLayers.length || staleCount\n        ? 'degraded' ''',""",
        """    '''      : sourceFailureCount || missingRequiredLayers.length\n        ? 'degraded'\n        : truncated''',\n    '''      : sourceFailureCount || missingRequiredLayers.length || staleCount\n        ? 'degraded'\n        : truncated''',""",
        'health assertion',
    ),
    (
        """    '''  authority?: ContextAuthority | null;\n  clientName?: string | null;''',\n    '''  authority?: ContextAuthority | null;\n  status?: string | null;\n  clientName?: string | null;''',""",
        """    '''  authority?: string | null;\n  clientName?: string | null;''',\n    '''  authority?: string | null;\n  status?: string | null;\n  clientName?: string | null;''',""",
        'Context Inspector item shape',
    ),
    (
        """    '''                  {item.authority ? (\n                    <span>Authority · {authorityLabel(item.authority)}</span>\n                  ) : null}\n                  {item.selection ? <span>{selectionLabel(item.selection)}</span> : null}''',\n    '''                  {item.authority ? (\n                    <span>Authority · {authorityLabel(item.authority)}</span>\n                  ) : null}\n                  {item.status ? (\n                    <span>Lifecycle · {STATUS_LABELS[item.status] ?? 'Unknown'}</span>\n                  ) : null}\n                  {item.selection ? <span>{selectionLabel(item.selection)}</span> : null}''',""",
        """    '''                      {item.authority && (\n                        <span>\n                          Authority · {AUTHORITY_LABELS[item.authority] ?? item.authority}\n                        </span>\n                      )}\n                      {item.selection && (''',\n    '''                      {item.authority && (\n                        <span>\n                          Authority · {AUTHORITY_LABELS[item.authority] ?? item.authority}\n                        </span>\n                      )}\n                      {item.status && (\n                        <span>Lifecycle · {STATUS_LABELS[item.status] ?? 'Unknown'}</span>\n                      )}\n                      {item.selection && (''',""",
        'Context Inspector lifecycle metadata block',
    ),
    (
        """for path in [\n    \"apps/api/src/context/context-compiler-v2.service.spec.ts\",\n    \"apps/meriv2-orchestrator/src/meri/context-compiler-v2.service.spec.ts\",\n]:\n    replace_once(\n        path,\n        '''    clientId: null,\n    status: 'active',\n    sections:''',\n        '''    clientId: null,\n    status: 'active',\n    legacyStatus: 'active',\n    governedStatus: 'active',\n    sections:''',\n    )\n    replace_once(\n        path,\n        '''    expect(select).toContain('memory_class AS \"memoryClass\"');\n    expect(select).toContain('approved_by_user_id AS \"approvedByUserId\"');''',\n        '''    expect(select).toContain('memory_class AS \"memoryClass\"');\n    expect(select).toContain('approved_by_user_id AS \"approvedByUserId\"');\n    expect(select).toContain('status AS \"legacyStatus\"');\n    expect(select).toContain('governed_status AS \"governedStatus\"');''',\n    )""",
        """for path, variable in [\n    (\"apps/api/src/context/context-compiler-v2.service.spec.ts\", \"sql\"),\n    (\"apps/meriv2-orchestrator/src/meri/context-compiler-v2.service.spec.ts\", \"select\"),\n]:\n    replace_once(\n        path,\n        '''    clientId: null,\n    status: 'active',\n    sections:''',\n        '''    clientId: null,\n    status: 'active',\n    legacyStatus: 'active',\n    governedStatus: 'active',\n    sections:''',\n    )\n    replace_once(\n        path,\n        f'''    expect({variable}).toContain('memory_class AS \"memoryClass\"');\n    expect({variable}).toContain('approved_by_user_id AS \"approvedByUserId\"');''',\n        f'''    expect({variable}).toContain('memory_class AS \"memoryClass\"');\n    expect({variable}).toContain('approved_by_user_id AS \"approvedByUserId\"');\n    expect({variable}).toContain('status AS \"legacyStatus\"');\n    expect({variable}).toContain('governed_status AS \"governedStatus\"');''',\n    )""",
        'API/orchestrator SQL assertion loop',
    ),
]

for old, new, label in fixes:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'phase9 preflight expected one {label}, found {count}')
    text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
subprocess.run([sys.executable, str(path)], check=True)
