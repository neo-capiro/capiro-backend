import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCaptureBindingOwner } from '../fixture-provisioning/capture-binding-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { sourceMappingDigest } from '../capture-transport.mjs';
import { sha256Stable as normalizedFixtureHash } from '../lib/stable.mjs';

export const captureRequest = () => ({
  tenantId: AUTHORIZED_TENANTS.T1.id,
  tenantSlug: AUTHORIZED_TENANTS.T1.slug,
  actorUserId: '44444444-4444-4444-8444-444444444444',
  clerkUserId: 'fixture-clerk-user',
  clientId: '11111111-1111-4111-8111-111111111111',
  caseId: '01',
  captureRunId: '88888888-8888-4888-8888-888888888888',
});

export function controlledQualification(request, version = '1') {
  const sourceMap = { 'MA1-v2': { physicalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version } };
  const currentVerify = {
    sourceVersion: version,
    actor: request.actorUserId,
    client: request.clientId,
  };
  return {
    fixtureNamespace: FIXTURE_NAMESPACE,
    fixtureVersion: 'fixture-unit-not-live',
    tenantId: request.tenantId,
    actorUserId: request.actorUserId,
    clientId: request.clientId,
    caseId: '01',
    sourceMap,
    physicalMapSha256: sha256Stable(sourceMap),
    currentVerify,
    currentVerifySha256: sha256Stable(currentVerify),
    fixtureReady: true,
    missing: [],
    seedReceiptId: 'unit-only-seed',
    resetReceiptId: 'unit-only-reset',
  };
}

function setup() {
  const request = captureRequest(),
    events = [];
  const state = {
    settings: {
      unrelated: { keep: ['value', 'e\u0301 \r\n'] },
      meriFoundationFixture: {
        fixtureNamespace: FIXTURE_NAMESPACE,
        unrelatedFixtureSetting: 42,
      },
    },
    rowVersion: '11',
    role: 'standard_user',
    active: true,
    wall: false,
    grants: [],
    sourceVersion: '1',
    writes: 0,
    ready: true,
  };
  const tx = {
    async $queryRawUnsafe(sql, ...args) {
      events.push(sql);
      if (sql.startsWith('SELECT id::text,slug'))
        return [
          {
            id: request.tenantId,
            slug: request.tenantSlug,
            settings: structuredClone(state.settings),
            row_version: state.rowVersion,
          },
        ];
      if (sql.includes('FROM users u'))
        return state.active
          ? [
              {
                id: request.actorUserId,
                clerk_user_id: request.clerkUserId,
                email: `${FIXTURE_NAMESPACE}-pat@example.com`,
                first_name: 'Synthetic',
                last_name: 'Pat',
                role: state.role,
              },
            ]
          : [];
      if (sql.startsWith('SELECT id::text,tenant_id'))
        return [{ id: request.clientId, tenant_id: request.tenantId, memory_wall: state.wall }];
      if (sql.startsWith('SELECT user_id::text')) return state.grants;
      if (sql.startsWith('UPDATE tenants')) {
        assert.equal(args[3], state.rowVersion);
        assert.deepEqual(JSON.parse(args[4]), state.settings);
        state.writes++;
        state.settings.meriFoundationFixture.captureEvidence = JSON.parse(args[0]);
        state.rowVersion = '12';
        return [{ settings: structuredClone(state.settings), row_version: state.rowVersion }];
      }
      throw new Error('unexpected SQL');
    },
  };
  const sourceAuthority = {
    async qualifyInTx(actualTx, ctx) {
      assert.equal(actualTx, tx);
      assert.equal(ctx.userId, request.actorUserId);
      assert.ok(events[0].endsWith('FOR UPDATE'));
      const q = controlledQualification(request, state.sourceVersion);
      return state.ready
        ? q
        : { ...q, fixtureReady: false, missing: ['NEGATIVE_CORPUS_OWNER_MISSING:MA1-v1'] };
    },
  };
  const owner = createCaptureBindingOwner({
    prisma: { withTenantUser: async (_t, _a, work) => work(tx) },
    sourceAuthority,
  });
  return { owner, request, state, events, sourceAuthority };
}

it('compares prior state and current source under one tenant lock, preserving unrelated JSON settings', async () => {
  const { owner, request, state, events } = setup();
  const plan = await owner.inspect(request);
  const bound = await owner.bind({
    ...request,
    ...plan,
    expectedCurrentVerifySha256: plan.currentVerifySha256,
  });
  assert.equal(bound.status, 'BOUND');
  assert.equal(bound.liveAcceptance, 'NOT_RUN');
  assert.equal(state.writes, 1);
  assert.deepEqual(state.settings.unrelated, { keep: ['value', 'e\u0301 \r\n'] });
  assert.equal(state.settings.meriFoundationFixture.unrelatedFixtureSetting, 42);
  assert.equal(bound.binding.captureRunId, request.captureRunId);
  assert.ok(
    events.some((sql) => sql.includes('xmin::text=$4') && sql.includes('settings_jsonb=$5::jsonb')),
  );
});

it('does not activate an incomplete corpus even when caller supplies ready/hash/receipt assertions', async () => {
  const { owner, request, state } = setup();
  state.ready = false;
  const plan = await owner.inspect(request);
  const result = await owner.bind({
    ...request,
    ...plan,
    expectedCurrentVerifySha256: plan.currentVerifySha256,
    fixtureReady: true,
    sourceMap: {},
    seedReceiptId: 'forged',
    resetReceiptId: 'forged',
  });
  assert.equal(result.status, 'NOT_READY');
  assert.equal(state.writes, 0);
  assert.equal(state.settings.meriFoundationFixture.captureEvidence, undefined);
});

for (const field of [
  'expectedTenantRowVersion',
  'expectedPriorBindingSha256',
  'expectedCurrentVerifySha256',
]) {
  it(`rejects stale ${field} before writing`, async () => {
    const { owner, request, state } = setup(),
      plan = await owner.inspect(request);
    const input = { ...request, ...plan, expectedCurrentVerifySha256: plan.currentVerifySha256 };
    input[field] = field === 'expectedTenantRowVersion' ? '10' : 'f'.repeat(64);
    await assert.rejects(owner.bind(input), {
      code:
        field === 'expectedCurrentVerifySha256'
          ? 'CAPTURE_BINDING_SOURCE_CHANGED'
          : 'CAPTURE_BINDING_STALE_PRIOR',
    });
    assert.equal(state.writes, 0);
  });
}

it('rejects source version drift after inspection and rechecks ordinary membership/client wall', async () => {
  const { owner, request, state } = setup(),
    plan = await owner.inspect(request);
  const input = { ...request, ...plan, expectedCurrentVerifySha256: plan.currentVerifySha256 };
  state.sourceVersion = '2';
  await assert.rejects(owner.bind(input), { code: 'CAPTURE_BINDING_SOURCE_CHANGED' });
  state.active = false;
  await assert.rejects(owner.bind(input), { code: 'CAPTURE_BINDING_ACTOR_NOT_CURRENT' });
  state.active = true;
  state.role = 'user_admin';
  await assert.rejects(owner.bind(input), { code: 'CAPTURE_BINDING_ACTOR_NOT_CURRENT' });
  state.role = 'standard_user';
  state.wall = true;
  await assert.rejects(owner.bind(input), { code: 'CAPTURE_BINDING_CLIENT_NOT_CURRENT' });
  assert.equal(state.writes, 0);
});

it('rejects an arbitrary tenant, mismatched Clerk actor, missing CAS or wrong namespace', async () => {
  const { owner, request, state } = setup();
  await assert.rejects(
    owner.inspect({ ...request, tenantId: '99999999-9999-4999-8999-999999999999' }),
    { code: 'CAPTURE_BINDING_SCOPE_INVALID' },
  );
  await assert.rejects(owner.inspect({ ...request, clerkUserId: 'foreign' }), {
    code: 'CAPTURE_BINDING_ACTOR_NOT_CURRENT',
  });
  await assert.rejects(owner.bind(request), { code: 'CAPTURE_BINDING_CAS_REQUIRED' });
  state.settings.meriFoundationFixture.fixtureNamespace = 'foreign';
  await assert.rejects(owner.inspect(request), { code: 'CAPTURE_BINDING_TENANT_OWNER_MISMATCH' });
  assert.equal(state.writes, 0);
});

it('does not substitute a supplied map hash for owner observations', async () => {
  const { owner, request, sourceAuthority, state } = setup();
  sourceAuthority.qualifyInTx = async () => ({
    ...controlledQualification(request),
    physicalMapSha256: 'f'.repeat(64),
  });
  await assert.rejects(owner.inspect(request), { code: 'CAPTURE_BINDING_OWNER_PROOF_INVALID' });
  assert.equal(state.writes, 0);
});

it('uses the existing capture mapping digest without fixture text normalization', async () => {
  const { owner, request, sourceAuthority } = setup();
  const qualified = controlledQualification(request, 'e\u0301 \r\n');
  assert.equal(
    qualified.physicalMapSha256,
    sourceMappingDigest({ scope: { sources: qualified.sourceMap } }),
  );
  assert.notEqual(qualified.physicalMapSha256, normalizedFixtureHash(qualified.sourceMap));
  sourceAuthority.qualifyInTx = async () => qualified;
  assert.equal((await owner.inspect(request)).status, 'READY');
  qualified.physicalMapSha256 = normalizedFixtureHash(qualified.sourceMap);
  await assert.rejects(owner.inspect(request), { code: 'CAPTURE_BINDING_OWNER_PROOF_INVALID' });
});
