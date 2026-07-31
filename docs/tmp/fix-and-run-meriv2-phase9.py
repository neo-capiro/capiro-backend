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
]

for old, new, label in fixes:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'phase9 preflight expected one {label}, found {count}')
    text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
subprocess.run([sys.executable, str(path)], check=True)
