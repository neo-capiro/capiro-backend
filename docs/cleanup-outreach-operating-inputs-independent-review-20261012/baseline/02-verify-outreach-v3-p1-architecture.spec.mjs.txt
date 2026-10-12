import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_CAPABILITIES,
  validateCapabilityCatalog,
  validateReverseDependencies,
} from './verify-outreach-v3-p1-architecture.mjs';

function catalog() {
  return REQUIRED_CAPABILITIES.map((name) => ({
    name,
    status: ['get_client_context', 'get_recent_activity', 'get_capiro_record'].includes(name)
      ? 'implemented'
      : 'contract_only',
    domainOwner: 'test',
    inputSchema: `${name}.input.v1`,
    outputSchema: `${name}.output.v1`,
    authorizationLayer: 'server',
    provenanceClass: 'structured',
    meriConsumer: true,
    outreachConsumer: true,
  }));
}

test('closed shared capability catalog passes', () => {
  assert.deepEqual(validateCapabilityCatalog(catalog()), []);
});

test('duplicate capability fails', () => {
  const value = catalog();
  value.push({ ...value[0] });
  assert.match(validateCapabilityCatalog(value).join('\n'), /duplicate capability/);
});

test('Meri-specific duplicate implementation fails', () => {
  const value = catalog();
  value[0] = { ...value[0], name: 'meri_search_capiro' };
  assert.match(validateCapabilityCatalog(value).join('\n'), /consumer-prefixed|closed set/);
});

test('reverse dependency missing tenant-neutral target metadata fails', () => {
  const problems = validateReverseDependencies([{ consumerFile: 'x.ts' }]);
  assert.ok(problems.length > 0);
});

test('current catalog permits later entries while retaining authority checks', () => {
  const value = catalog();
  value.push({ ...value[0], name: 'later_shared_capability' });
  assert.deepEqual(validateCapabilityCatalog(value, { allowExtensions: true }), []);
  assert.match(validateCapabilityCatalog(value).join('\n'), /closed set/);
  value.pop();
  value.pop();
  assert.match(validateCapabilityCatalog(value, { allowExtensions: true }).join('\n'), /missing/);
});

test('current catalog extensions cannot bypass duplicate, metadata or consumer checks', () => {
  const value = catalog();
  value.push({
    ...value[0],
    name: 'meri_duplicate',
    authorizationLayer: '',
    outreachConsumer: false,
  });
  value.push({ ...value[0] });
  const problems = validateCapabilityCatalog(value, { allowExtensions: true }).join('\n');
  assert.match(problems, /duplicate capability/);
  assert.match(problems, /consumer-prefixed/);
  assert.match(problems, /missing authorizationLayer/);
  assert.match(problems, /shared by Meri and Outreach/);
});
