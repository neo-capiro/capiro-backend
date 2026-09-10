import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRequestedItems } from './legiwatch-import-apply.mjs';

test('first apply resolves parents before assignments across bounded pages', async () => {
  const items = [
    { id: 'a1', kind: 'assignment', status: 'ready' },
    { id: 'a2', kind: 'assignment', status: 'retry' },
    { id: 'c', kind: 'contact', status: 'ready' },
    { id: 'f', kind: 'folder', status: 'ready' },
  ];
  const applied = [];
  const svc = {
    async reconcile(_ctx, _run, offset) {
      return {
        items: items.slice(offset, offset + 2),
        nextOffset: offset + 2 < items.length ? offset + 2 : null,
      };
    },
    async apply(_ctx, _run, input) {
      for (const id of input.itemIds) {
        const item = items.find((i) => i.id === id);
        if (item.kind === 'assignment') assert.equal(items[3].status, 'applied');
        item.status = 'applied';
        applied.push(id);
      }
    },
  };
  await applyRequestedItems(svc, { tenantId: 'synthetic' }, { id: 'run', mappingHash: 'hash' }, [
    'assignment',
    'folder',
  ]);
  assert.deepEqual(applied, ['f', 'a1', 'a2']);
  assert.equal(items[2].status, 'ready');
  await applyRequestedItems(svc, { tenantId: 'synthetic' }, { id: 'run', mappingHash: 'hash' }, [
    'assignment',
    'folder',
  ]);
  assert.deepEqual(applied, ['f', 'a1', 'a2']);
});
