import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const root = 'C:/dev/main/meri-c1-20261002';
const script = root + '/apps/api/scripts/meri-case12-setup-native.mjs';
const guard = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier, context, next) {
  if (specifier.includes('meri-case01-setup-dependencies') || specifier.includes('/dist/')) {
    process.stdout.write('FACTORY_OR_COMPILED_NATIVE_IMPORT_ATTEMPTED\\n');
    throw Error('INGRESS_BOUNDARY_TEST');
  }
  return next(specifier, context);
}});`;
for (const [name, args, value] of [
  ['missing execute', [], undefined],
  ['extra command arguments', ['execute', '--resume'], '{}'],
  ['missing input environment', ['execute'], undefined],
  ['invalid JSON', ['execute'], '{'],
  ['oversized input', ['execute'], ' '.repeat(7001)],
  ['array envelope', ['execute'], '[]'],
  ['serialized authority or caller plan', ['execute'], JSON.stringify({kind:'meri-case12-native-setup-input', version:1, recipe:{}, providerEnvelope:{},native:{}, setupPlan:{ready:true}})],
  ['invalid recipe', ['execute'], JSON.stringify({kind:'meri-case12-native-setup-input', version:1, recipe:{},providerEnvelope:{},native:{}})],
]) test(name + ' fails before importing factory or compiled native modules', () => {
  const env = {...process.env};
  delete env.DATABASE_URL;
  if (value === undefined) delete env.MERI_CASE12_NATIVE_SETUP_INPUT;
  else env.MERI_CASE12_NATIVE_SETUP_INPUT = value;
  const child = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(guard), script, ...args],
    {cwd:root, env, encoding:'utf8', timeout:10000, windowsHide:true});
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'CASE12_NATIVE_SETUP_FAILED_RECONCILIATION_REQUIRED\n');
});
