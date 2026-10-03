from pathlib import Path
import hashlib
import json
import runpy

root = Path('C:/dev/main/outputs/meri-c2-20261003')
out = root / 'case01-native-bootstrap-v2'
prepared = runpy.run_path(str(root / 'prepare-case01-native-bootstrap-v2.py'))['render']()
for name, data in prepared.items():
    assert (out / name).read_bytes() == data, name
assert (out / 'offline-reproduction.log').read_text(encoding='utf-8').startswith('PASS: all six prepared files')
syntax = (out / 'syntax-check.log').read_text(encoding='utf-8')
assert syntax.count(': exit=0') == 3 and syntax.count(': exit=') == 3
test_log = (out / 'pure-guard-tests.log').read_text(encoding='utf-8')
# Node 24 chose the spec reporter. Preserve that successful native test log.
# The first wrapper failed only because it expected TAP summary spelling.
for expected in ['\u2139 tests 13', '\u2139 pass 13', '\u2139 fail 0']:
    assert expected in test_log, expected
failure = {
    'status': 'VALIDATION_WRAPPER_ASSERTION_FAILED_AFTER_TEST_SUCCESS',
    'script': '../validate-case01-native-bootstrap-v2.py',
    'scriptSha256': hashlib.sha256((root / 'validate-case01-native-bootstrap-v2.py').read_bytes()).hexdigest(),
    'reason': 'Node 24 used the spec reporter; the wrapper expected TAP summary labels.',
    'actualTests': {'exitCode': 0, 'passed': 13, 'failed': 0},
    'testLog': 'pure-guard-tests.log',
    'resolution': 'Validate the retained actual spec output; do not rerun tests or modify the operator.',
}
with (out / 'initial-validation-wrapper-failure.json').open('x', encoding='utf-8', newline='\n') as stream:
    json.dump(failure, stream, indent=2)
    stream.write('\n')

original_validator = (root / 'validate-case01-native-bootstrap-v2.py').read_text(encoding='utf-8')
# Reuse the reviewed hash/checkpoint tail. It only verifies bytes and saves a new
# checkpoint; the completed syntax/test execution prefix is not run a second time.
prefix = original_validator.split('prepared = runpy.run_path', 1)[0]
tail = 'prior = ROOT /' + original_validator.split('prior = ROOT /', 1)[1]
tail = tail.replace("ROOT / 'prepare-case01-native-bootstrap-v2.py', Path(__file__)",
                    "ROOT / 'prepare-case01-native-bootstrap-v2.py', ROOT / 'validate-case01-native-bootstrap-v2.py', Path(__file__)")
namespace = {'__file__': str(Path(__file__)), 'prepared': prepared}
exec(compile(prefix + tail, str(Path(__file__)), 'exec'), namespace)
