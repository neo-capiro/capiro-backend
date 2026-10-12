import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectHelperInventory } from './check-duplicate-helpers.mjs';

function fixture() {
  return {
    config: {
      profiles: [
        {
          id: 'reviewed',
          symbols: [
            { name: 'pageOf', kind: 'function' },
            { name: 'PRODUCTS', kind: 'variable' },
          ],
        },
      ],
    },
    inventory: '# Reviewed source helpers\nreviewed\tpageOf\n',
  };
}

test('binds every owned function once while excluding metadata values', () => {
  const { config, inventory } = fixture();
  assert.deepEqual(inspectHelperInventory(config, inventory), { errors: [], helpers: 1 });
});

for (const [label, change] of [
  ['missing row', (value) => (value.inventory = '# no helpers\n')],
  ['duplicate row', (value) => (value.inventory += 'reviewed\tpageOf\n')],
  ['renamed row', (value) => (value.inventory = 'reviewed\tother\n')],
  ['wrong owner', (value) => (value.inventory = 'other\tpageOf\n')],
  ['variable presented as helper', (value) => (value.inventory += 'reviewed\tPRODUCTS\n')],
  ['extra columns', (value) => (value.inventory += 'reviewed\tpageOf\textra\n')],
  ['space separated row', (value) => (value.inventory = 'reviewed pageOf\n')],
  [
    'duplicate owned function',
    (value) => value.config.profiles[0].symbols.push(value.config.profiles[0].symbols[0]),
  ],
  [
    'new function without inventory',
    (value) => value.config.profiles[0].symbols.push({ name: 'other', kind: 'function' }),
  ],
  ['empty ownership', (value) => (value.config.profiles = [])],
  ['invalid profile', (value) => (value.config.profiles = [null])],
  ['invalid symbols', (value) => (value.config.profiles[0].symbols = {})],
  ['invalid inventory type', (value) => (value.inventory = [])],
  ['invalid configuration', (value) => (value.config = null)],
])
  test(`refuses ${label}`, () => {
    const value = fixture();
    change(value);
    assert.ok(inspectHelperInventory(value.config, value.inventory).errors.length > 0);
  });

test('retains CRLF and comment support without accepting data with whitespace', () => {
  const value = fixture();
  assert.deepEqual(
    inspectHelperInventory(value.config, value.inventory.replaceAll('\n', '\r\n')).errors,
    [],
  );
  assert.ok(inspectHelperInventory(value.config, ' reviewed\tpageOf\n').errors.length > 0);
});
