import hashlib
import json
import os
import pathlib
import shutil
import subprocess

packet = pathlib.Path(__file__).resolve().parent
consumer = pathlib.Path('/tmp/capiro-shared-independent-consumer-20261012')
node = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
tsc = '/workspace/capirov2/node_modules/typescript/bin/tsc'
esbuild = '/workspace/capirov2/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild'
env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
rows = []
for name in ['public-consumer.cjs', 'public-consumer.mjs', 'browser-entry.mjs', 'types-positive.ts', 'types-negative-kind.ts', 'types-negative-stage.ts', 'types-negative-platform.ts']:
    shutil.copyfile(packet / name, consumer / name)

def run(name, argv, expected=0):
    result = subprocess.run(argv, cwd=consumer, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    log = packet / (name + '.log')
    log.write_bytes(result.stdout)
    rows.append({'name': name, 'argv': argv, 'cwd': str(consumer), 'environment': env, 'exitCode': result.returncode, 'expectedExitCode': expected, 'log': log.name, 'logSha256': hashlib.sha256(result.stdout).hexdigest()})
    (packet / 'independent-commands.json').write_text(json.dumps(rows, indent=2) + '\n')
    assert result.returncode == expected, (name, result.returncode, result.stdout.decode())
    return result.stdout.decode()

run('public-cjs', [node, '--test', 'public-consumer.cjs'])
run('public-esm', [node, 'public-consumer.mjs'])
for mode, options in [('node', ['--module', 'NodeNext', '--moduleResolution', 'NodeNext']), ('browser', ['--module', 'ESNext', '--moduleResolution', 'Bundler'])]:
    base = [node, tsc, '--strict', '--noEmit', '--target', 'ES2022', '--lib', 'ES2022,DOM', '--skipLibCheck', 'false'] + options
    run('types-' + mode + '-positive', base + ['types-positive.ts'])
    for label, code in [('kind', 'TS2322'), ('stage', 'TS2353'), ('platform', 'TS2322')]:
        output = run('types-' + mode + '-negative-' + label, base + ['types-negative-' + label + '.ts'], 2)
        assert output.count('error TS') == 1 and code in output
run('browser-build', [esbuild, 'browser-entry.mjs', '--bundle', '--platform=browser', '--format=iife', '--global-name=PackedNewsletter', '--target=es2022', '--outfile=browser-bundle.js', '--metafile=browser-metafile.json'])
shutil.copyfile(consumer / 'browser-bundle.js', packet / 'browser-bundle.js')
shutil.copyfile(consumer / 'browser-metafile.json', packet / 'browser-metafile.json')
meta = json.loads((consumer / 'browser-metafile.json').read_text())
expected = {'browser-entry.mjs'} | {'node_modules/@capiro/shared/dist/' + name + '.js' for name in ['newsletter', 'newsletter-render', 'newsletter-fonts', 'newsletter-fonts.catalog', 'newsletter-social-share']}
assert set(meta['inputs']) == expected, sorted(meta['inputs'])
assert all(not edge.get('external') for item in meta['inputs'].values() for edge in item.get('imports', []))
assert not any(item.get('imports') for item in meta['outputs'].values())
print(json.dumps({'commands': len(rows), 'allExpectedStatuses': True, 'privateSourceImports': False, 'browserInputs': sorted(meta['inputs'])}))
