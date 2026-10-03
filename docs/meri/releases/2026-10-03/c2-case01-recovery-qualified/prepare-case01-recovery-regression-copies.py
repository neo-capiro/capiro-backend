from pathlib import Path
import hashlib, json

root = Path('C:/dev/main/outputs/meri-c2-20261003/case01-recovery-regressions-v1')
repo = Path('C:/dev/main/meri-c1-20261002')
live = Path('C:/dev/main/outputs/meri-fresh-20261003')
sha = lambda x: hashlib.sha256(x).hexdigest()
wire = (live/'fresh-spend.jsonl').read_bytes()
auth = (live/'run-authorization.json').read_bytes()
assert sha(wire) == '7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60'
assert sha(auth) == 'e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe'
prefix = b''.join(wire.splitlines(keepends=True)[:20])
assert sha(prefix) == 'abe458973e6998db20586c781ac5a3cbd4ca2fa565425e62722f0eb9c985210b'
root.mkdir(exist_ok=False)
fixture = root/'original20-copy'
fixture.mkdir()
(fixture/'fresh-spend.jsonl').write_bytes(prefix)
(fixture/'run-authorization.json').write_bytes(auth)
testroot = repo/'evals/meri/live-v1/tests'
source = (testroot/'capture-spend-fresh.test.mjs').read_text(encoding='utf8')
source = source.replace("const liveRoot = 'C:/dev/main/outputs/meri-fresh-20261003';", f'const liveRoot = {json.dumps(fixture.as_posix())};')
source = source.replace("const parent = 'C:/dev/main/outputs/meri-c2-20261003/fresh-journal-adapter-v1/local-tests';", f'const parent = {json.dumps((root/"js-native-tests").as_posix())};')
source = source.replace("new URL('../capture-spend-aggregate.mjs', import.meta.url)", f'new URL({json.dumps((repo/"evals/meri/live-v1/capture-spend-aggregate.mjs").as_uri())})')
source = source.replace("new URL('../lib/windows-capture-spend.py', import.meta.url)", f'new URL({json.dumps((repo/"evals/meri/live-v1/lib/windows-capture-spend.py").as_uri())})')
(root/'capture-spend-fresh-copy.test.mjs').write_text(source, encoding='utf8', newline='\n')
source = (testroot/'capture-spend-fresh.unit.py').read_text(encoding='utf8')
source = source.replace("HELPER = pathlib.Path(__file__).resolve().parents[1] / 'lib/windows-capture-spend.py'", f'HELPER = pathlib.Path({json.dumps((repo/"evals/meri/live-v1/lib/windows-capture-spend.py").as_posix())})')
source = source.replace("LIVE = pathlib.Path(GLOBAL['FRESH_ROOT'])", f'LIVE = pathlib.Path({json.dumps(fixture.as_posix())})')
source = source.replace("PARENT = pathlib.Path('C:/dev/main/outputs/meri-c2-20261003/fresh-journal-adapter-v1/local-tests')", f'PARENT = pathlib.Path({json.dumps((root/"py-native-tests").as_posix())})')
(root/'capture-spend-fresh-copy.unit.py').write_text(source, encoding='utf8', newline='\n')
record = dict(status='DISPOSABLE_EXACT_PREFIX_TEST_COPIES', liveJournalSha256=sha(wire),
    prefixSha256=sha(prefix), prefixEvents=20, actualEvents=21,
    modifications=['Only copied test input/output roots and absolute source/helper imports changed.', 'Production helper and aggregate module remain actual current repository source.'],
    sourceTestHashes={n: sha((testroot/n).read_bytes()) for n in ['capture-spend-fresh.test.mjs','capture-spend-fresh.unit.py']})
(root/'preparation.json').write_text(json.dumps(record, indent=2)+'\n', encoding='utf8')
assert (live/'fresh-spend.jsonl').read_bytes() == wire
print(json.dumps(record))
