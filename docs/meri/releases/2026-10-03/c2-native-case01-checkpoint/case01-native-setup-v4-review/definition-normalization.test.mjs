// Exact retained data is read locally. No dispatcher imports or cloud calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { fingerprint, taskInput } from '../../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
import { withExplicitEcsDefaults, normalizeTaskEnvironment } from '../case01-native-setup-v4-definition.mjs';

const parent = 'C:/dev/main/outputs/meri-c2-20261003';
const previous = parent + '/case01-native-setup-plan-v1';
const read = name => JSON.parse(readFileSync(previous + '/' + name, 'utf8'));
const submitted = read('definition-input.private.json');
const rawReadback = read('definition-readback.private.json');
const registered = { ...rawReadback.taskDefinition, tags: rawReadback.tags };
const desired = withExplicitEcsDefaults(submitted);
const normalized = value => fingerprint(normalizeTaskEnvironment(taskInput(value)));
const compare = (left, right) => assert.equal(normalized(left), normalized(right));

test('exact retained submitted and registered definitions agree after only known normalization', () => {
  if (process.env.CASE01_V4_REPRODUCE_V3 === '1') {
    // Exact v3 expression: intentionally red on the original retained pair.
    assert.equal(fingerprint(taskInput(submitted)), fingerprint(taskInput(registered)));
  } else compare(desired, registered);
});

test('retained failure preceded RunTask input and retained successful deregistration', () => {
  const result = read('result.json');
  assert.equal(result.taskArn, null);
  assert.equal(result.cleanup.taskDefinitionInactive, true);
  assert.equal(existsSync(previous + '/task-input.private.json'), false);
  assert.equal(existsSync(previous + '/task-start-response.json'), false);
  assert.equal(existsSync(previous + '/inner-receipt.jsonl'), false);
});

test('explicit defaults add exactly the seven observed paths and preserve input', () => {
  const before = structuredClone(submitted);
  const added = withExplicitEcsDefaults(submitted);
  const deltas = [];
  function visit(a, b, prefix = '') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const path = prefix ? prefix + '.' + key : key;
      if (!Object.hasOwn(a, key)) deltas.push([path, b[key]]);
      else if (a[key] && b[key] && typeof a[key] === 'object' && typeof b[key] === 'object') visit(a[key], b[key], path);
      else assert.deepEqual(a[key], b[key]);
    }
  }
  visit(submitted, added);
  assert.deepEqual(deltas.sort((a, b) => a[0].localeCompare(b[0])), [
    ['containerDefinitions.0.cpu', 0], ['containerDefinitions.0.mountPoints', []],
    ['containerDefinitions.0.portMappings', []], ['containerDefinitions.0.systemControls', []],
    ['containerDefinitions.0.volumesFrom', []], ['placementConstraints', []], ['volumes', []],
  ]);
  assert.deepEqual(submitted, before);
});

test('normalization sorts environment only and is idempotent without input mutation', () => {
  const before = structuredClone(desired);
  const result = normalizeTaskEnvironment(desired);
  const expected = structuredClone(desired);
  expected.containerDefinitions[0].environment.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  assert.deepEqual(result, expected);
  assert.deepEqual(normalizeTaskEnvironment(result), result);
  assert.deepEqual(desired, before);
});

test('explicit nondefaults and null defaults remain intact', () => {
  const value = structuredClone(desired);
  value.volumes = null; value.placementConstraints = [{ type: 'memberOf', expression: 'attribute:test' }];
  value.containerDefinitions[0].cpu = 13;
  value.containerDefinitions[0].portMappings = [{ containerPort: 1234 }];
  value.containerDefinitions[0].mountPoints = null;
  assert.deepEqual(withExplicitEcsDefaults(value), value);
});

const changes = {
  'image': v => { v.containerDefinitions[0].image += '-changed'; },
  'command bytes': v => { v.containerDefinitions[0].command[0] += '\n// changed'; },
  'entryPoint order': v => { v.containerDefinitions[0].entryPoint.reverse(); },
  'execution role': v => { v.executionRoleArn += '-changed'; },
  'new task role': v => { v.taskRoleArn = 'arn:aws:iam::967807252336:role/unapproved'; },
  'task cpu capacity': v => { v.cpu = String(Number(v.cpu) * 2); },
  'task memory capacity': v => { v.memory = String(Number(v.memory) * 2); },
  'container cpu default': v => { v.containerDefinitions[0].cpu = 1; },
  'port mapping': v => { v.containerDefinitions[0].portMappings.push({ containerPort: 1234 }); },
  'mount point': v => { v.containerDefinitions[0].mountPoints.push({ containerPath: '/unexpected', sourceVolume: 'new' }); },
  'volume': v => { v.volumes.push({ name: 'new' }); },
  'volumesFrom': v => { v.containerDefinitions[0].volumesFrom.push({ sourceContainer: 'new' }); },
  'system control': v => { v.containerDefinitions[0].systemControls.push({ namespace: 'net.ipv4.ip_forward', value: '1' }); },
  'placement constraint': v => { v.placementConstraints.push({ type: 'memberOf', expression: 'attribute:new' }); },
  'secret reference': v => { v.containerDefinitions[0].secrets[0].valueFrom += '-changed'; },
  'extra secret': v => { v.containerDefinitions[0].secrets.push({ name: 'EXTRA', valueFrom: 'unapproved' }); },
  'secret order': v => { v.containerDefinitions[0].secrets.reverse(); },
  'environment value': v => { v.containerDefinitions[0].environment[0].value += '-changed'; },
  'missing environment entry': v => { v.containerDefinitions[0].environment.pop(); },
  'extra environment entry': v => { v.containerDefinitions[0].environment.push({ name: 'EXTRA', value: 'unapproved' }); },
  'extra environment row field': v => { v.containerDefinitions[0].environment[0].extra = 'unapproved'; },
  'missing default field': v => { delete v.containerDefinitions[0].cpu; },
  'explicit null default': v => { v.containerDefinitions[0].cpu = null; },
  'unknown container field': v => { v.containerDefinitions[0].unapproved = true; },
  'unknown task field': v => { v.unapproved = true; },
  'network mode': v => { v.networkMode = 'host'; },
};
for (const [name, mutate] of Object.entries(changes)) {
  test('rejects ' + name, () => {
    const changed = structuredClone(registered);
    mutate(changed);
    assert.throws(() => compare(desired, changed));
  });
}
for (const side of ['desired', 'registered']) {
  test('rejects duplicate environment names in ' + side + ' even with identical value', () => {
    const left = structuredClone(desired), right = structuredClone(registered);
    const target = side === 'desired' ? left : right;
    target.containerDefinitions[0].environment.push({ ...target.containerDefinitions[0].environment[0] });
    assert.throws(() => compare(left, right), /Duplicate environment name/);
  });
}
for (const [name, mutate] of Object.entries({
  'missing array': v => { delete v.containerDefinitions[0].environment; },
  'null array': v => { v.containerDefinitions[0].environment = null; },
  'missing value': v => { delete v.containerDefinitions[0].environment[0].value; },
  'nonstring value': v => { v.containerDefinitions[0].environment[0].value = 1; },
  'empty name': v => { v.containerDefinitions[0].environment[0].name = ''; },
})) {
  test('rejects malformed environment ' + name, () => {
    const changed = structuredClone(registered); mutate(changed);
    assert.throws(() => compare(desired, changed));
  });
}

test('v4 uses new directories and exact normalization at the pre-RunTask assertion', () => {
  const text = readFileSync(parent + '/run-case01-native-setup-v4.mjs', 'utf8');
  assert.ok(text.includes("const root=parent+'/case01-native-setup-'+mode+'-v2';"));
  assert.ok(text.includes("const prior=read(parent+'/case01-native-setup-plan-v2/result.json');"));
  assert.ok(!text.includes("const prior=read(parent+'/case01-native-setup-plan-v1/result.json');"));
  assert.ok(text.includes('const definition=normalizeTaskEnvironment(withExplicitEcsDefaults(JSON.parse(templateBytes)));'));
  assert.ok(text.includes('const registeredHash=fingerprint(normalizeTaskEnvironment(taskInput({...registered.taskDefinition,tags:registered.tags})));'));
  assert.ok(text.includes("assert.equal(registeredHash,fingerprint(normalizeTaskEnvironment(taskInput(definition))),'Registered task input drift');"));
  assert.ok(text.indexOf("'Registered task input drift'") < text.indexOf('runDispatched=true;'));
});

test('multi-element command and container order remain meaningful', () => {
  const value = structuredClone(desired);
  value.containerDefinitions[0].command = ['first', 'second'];
  value.containerDefinitions.push({ ...structuredClone(value.containerDefinitions[0]), name: 'second' });
  const reorderedCommand = structuredClone(value);
  reorderedCommand.containerDefinitions[0].command.reverse();
  assert.throws(() => compare(value, reorderedCommand));
  const reorderedContainers = structuredClone(value);
  reorderedContainers.containerDefinitions.reverse();
  assert.throws(() => compare(value, reorderedContainers));
});

test('reconciliation guard binds prior failure bytes before any cloud action', () => {
  const text = readFileSync(parent + '/run-case01-native-setup-v4.mjs', 'utf8');
  const guard = text.indexOf("assert.equal(reconciliation.status,'RECONCILED_PRE_RUN_TASK_FAILURE');");
  assert.ok(guard > 0 && guard < text.indexOf("aws(['sts','get-caller-identity'])"));
  assert.ok(text.includes("assert.equal(reconciliationSha256,'b59923080aace193f676921ff8a449ff62b7e527fda80135ec2080255727e232');"));
  assert.ok(text.includes("assert.equal(existsSync(parent+'/case01-native-setup-plan-v1/task-input.private.json'),false);"));
});
