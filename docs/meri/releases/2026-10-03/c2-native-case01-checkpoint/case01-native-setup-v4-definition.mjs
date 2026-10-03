// Pure, narrowly scoped comparison for the pinned case01 setup task definition.
import assert from 'node:assert/strict';

export function withExplicitEcsDefaults(input) {
  const output = structuredClone(input);
  assert.ok(Array.isArray(output.containerDefinitions));
  for (const key of ['volumes', 'placementConstraints']) {
    if (!Object.hasOwn(output, key)) output[key] = [];
  }
  for (const container of output.containerDefinitions) {
    if (!Object.hasOwn(container, 'cpu')) container.cpu = 0;
    for (const key of ['portMappings', 'mountPoints', 'volumesFrom', 'systemControls']) {
      if (!Object.hasOwn(container, key)) container[key] = [];
    }
  }
  return output;
}

// Only environment entry order is nonsemantic. Preserve every field and all
// other array orders, including command, entryPoint, secrets and container order.
export function normalizeTaskEnvironment(input) {
  const output = structuredClone(input);
  assert.ok(Array.isArray(output.containerDefinitions));
  for (const container of output.containerDefinitions) {
    assert.ok(Array.isArray(container.environment), 'Environment array missing');
    const names = new Set();
    for (const entry of container.environment) {
      assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry));
      assert.equal(typeof entry.name, 'string');
      assert.ok(entry.name.length > 0, 'Environment name missing');
      assert.equal(typeof entry.value, 'string', 'Environment value missing');
      assert.ok(!names.has(entry.name), 'Duplicate environment name');
      names.add(entry.name);
    }
    container.environment.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return output;
}
