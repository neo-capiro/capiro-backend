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
