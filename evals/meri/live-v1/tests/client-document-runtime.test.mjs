import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertClientDocumentRuntimeConfig,
  documentAssetRoot,
} from '../fixture-provisioning/client-document-runtime.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';

const config = {
  target: 'capiro-dev',
  fixtureNamespace: FIXTURE_NAMESPACE,
  availableOwners: ['engagement_attachment'],
  tenants: {
    T1: AUTHORIZED_TENANTS.T1,
    T2: AUTHORIZED_TENANTS.T2,
  },
};

const env = {
  MERI_SYNTHETIC_FIXTURE_NAMESPACE: FIXTURE_NAMESPACE,
  DATABASE_URL: 'postgresql://fixture-test.invalid/db',
  ASSETS_BUCKET: 'fixture-test-bucket',
};

test('document runtime accepts only the exact synthetic target, tenants, and owner', () => {
  assertClientDocumentRuntimeConfig({ config, env });
  for (const changed of [
    { ...config, target: 'production' },
    { ...config, fixtureNamespace: 'other' },
    { ...config, availableOwners: ['memory_candidate'] },
    { ...config, availableOwners: ['engagement_attachment', 'memory_candidate'] },
    { ...config, tenants: { ...config.tenants, T1: { ...config.tenants.T1, slug: 'other' } } },
  ]) {
    assert.throws(() => assertClientDocumentRuntimeConfig({ config: changed, env }));
  }
});

test('document runtime requires the explicit namespace, application database, and bucket', () => {
  for (const missing of [
    { ...env, MERI_SYNTHETIC_FIXTURE_NAMESPACE: undefined },
    { ...env, DATABASE_URL: undefined },
    { ...env, ASSETS_BUCKET: undefined },
  ]) {
    assert.throws(() => assertClientDocumentRuntimeConfig({ config, env: missing }));
  }
});

test('document runtime resolves frozen source assets under live-v1/source-binaries', () => {
  const assetRoot = fileURLToPath(documentAssetRoot());
  assert.equal(basename(assetRoot), 'source-binaries');
  assert.equal(basename(dirname(assetRoot)), 'live-v1');
});
