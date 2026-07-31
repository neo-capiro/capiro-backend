from pathlib import Path
import subprocess
import sys

path = Path('docs/tmp/apply-meriv2-phase9.py')
text = path.read_text(encoding='utf-8')
old = """    '''      : sourceFailureCount || missingRequiredLayers.length\n        ? 'degraded' ''',\n    '''      : sourceFailureCount || missingRequiredLayers.length || staleCount\n        ? 'degraded' ''',"""
new = """    '''      : sourceFailureCount || missingRequiredLayers.length\n        ? 'degraded'\n        : truncated''',\n    '''      : sourceFailureCount || missingRequiredLayers.length || staleCount\n        ? 'degraded'\n        : truncated''',"""
if text.count(old) != 1:
    raise SystemExit(f'phase9 preflight expected one health assertion, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
subprocess.run([sys.executable, str(path)], check=True)
