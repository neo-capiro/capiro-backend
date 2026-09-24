import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveCycleTemplate } from '../../../../packages/defense-domain/src/budget-lifecycle/templates.js';

import { SourceAdapterRegistry } from './source-adapter.registry.js';

describe('official source adapter accountability', () => {
  it('assigns a business owner role and runtime owner to every adapter used by templates', () => {
    const registry = new SourceAdapterRegistry();
    const adapters = registry.list();
    const ids = new Set(adapters.map((adapter) => adapter.adapterId));
    for (const template of resolveCycleTemplate().entries) {
      assert.ok(ids.has(template.adapterId), `template references unregistered adapter ${template.adapterId}`);
    }
    for (const adapter of adapters) {
      assert.ok(adapter.ownerRole.trim(), `${adapter.adapterId} has no accountable owner role`);
      assert.ok(adapter.runtimeOwner.trim(), `${adapter.adapterId} has no runtime owner`);
    }
  });
});
