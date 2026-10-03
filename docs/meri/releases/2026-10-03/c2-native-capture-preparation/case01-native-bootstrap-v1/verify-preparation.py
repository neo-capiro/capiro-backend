from pathlib import Path
import ast
import difflib
import hashlib
import json

root = Path(__file__).parent
generator = (root / 'prepare.py').read_text(encoding='utf-8')
ast.parse(generator)
# Evaluate only the offline string-composition prefix; no generated runner import.
prefix = generator.split('destination = out /', 1)[0]
scope = {'__file__': str(root / 'prepare.py')}
exec(compile(prefix, str(root / 'prepare.py'), 'exec'), scope)
actual = (root / 'run-case01-native.mjs').read_bytes()
expected = scope['script'].encode('utf-8')
assert actual == expected, 'Generated runner differs from the frozen preparation recipe'
diff = ''.join(difflib.unified_diff(scope['original'].splitlines(True), scope['script'].splitlines(True),
    fromfile='source/evals/meri/live-v1/run-controlled-read.mjs', tofile='prepared/run-case01-native.mjs'))
(root / 'adaptation.diff').write_text(diff, encoding='utf-8', newline='\n')
print(json.dumps({'status': 'EXACT_OFFLINE_REPRODUCTION_PASS', 'runnerBytes': len(actual),
  'runnerLines': len(scope['script'].splitlines()), 'sha256': hashlib.sha256(actual).hexdigest(),
  'runnerImported': False, 'runtimeOrOwnerCalls': 0}))
