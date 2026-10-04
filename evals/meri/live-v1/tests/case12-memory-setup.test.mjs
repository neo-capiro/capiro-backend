import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveCase12SetupRecipe,
  executeCase12Setup,
} from '../fixture-provisioning/case12-memory-setup.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = FIXTURE_NAMESPACE;
const proposer = '44444444-4444-4444-8444-444444444444',
  reviewer = '66666666-6666-4666-8666-666666666666';
export const recipe = () => ({
  schemaVersion: 1,
  target: 'capiro-dev',
  caseId: '12',
  fixtureNamespace: FIXTURE_NAMESPACE,
  fixtureInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ctx: {
    tenantId: AUTHORIZED_TENANTS.T1.id,
    tenantSlug: AUTHORIZED_TENANTS.T1.slug,
    userId: proposer,
    role: 'standard_user',
  },
  clerkUserId: 'user_local_pat',
  reviewerUserId: reviewer,
  actors: {
    PAT: { tenantId: 'T1', physicalId: proposer, clerkUserId: 'user_local_pat' },
    PRIYA: { tenantId: 'T1', physicalId: reviewer, clerkUserId: 'user_local_priya' },
  },
  clients: {
    ASTER: { tenantId: 'T1', physicalId: '11111111-1111-4111-8111-111111111111' },
    BLUEHAVEN: { tenantId: 'T1', physicalId: '22222222-2222-4222-8222-222222222222' },
    CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
  },
});
test('fixed original ordered 510 definitions with private frozen recipe', async () => {
  const input = recipe(),
    resolved = await resolveCase12SetupRecipe(input);
  input.actors.PAT.physicalId = reviewer;
  assert.equal(resolved.definitions.length, 510);
  assert.equal(resolved.definitions[0].logicalId, 'MA510');
  assert.equal(resolved.definitions[509].logicalId, 'MA510-DISTRACTOR-0509');
  assert.equal(resolved.input.ctx.userId, proposer);
  assert.equal(resolved.manifest.actors.PAT.physicalId, proposer);
  assert.equal(resolved.definitions[0].candidate.payload.facts.text, 'autonomous maritime demo');
  assert.throws(() => {
    resolved.definitions[0].candidate.payload.facts.text = 'changed';
  }, TypeError);
});
for (const [label, change] of [
  [
    'missing fresh instance',
    (r) => {
      r.fixtureInstanceId = undefined;
    },
  ],
  [
    'null instance',
    (r) => {
      r.fixtureInstanceId = null;
    },
  ],
  [
    'legacy instance',
    (r) => {
      r.fixtureInstanceId = 'historical-unscoped';
    },
  ],
  [
    'unknown input authority',
    (r) => {
      r.captureAuthority = true;
    },
  ],
  [
    'different case',
    (r) => {
      r.caseId = '14';
    },
  ],
  [
    'variable distractor count',
    (r) => {
      r.distractorCount = 500;
    },
  ],
  [
    'caller source text',
    (r) => {
      r.sourceText = 'other fact';
    },
  ],
  [
    'foreign tenant',
    (r) => {
      r.ctx.tenantId = AUTHORIZED_TENANTS.T2.id;
    },
  ],
  [
    'admin preparer',
    (r) => {
      r.ctx.role = 'user_admin';
    },
  ],
  [
    'same reviewer and proposer',
    (r) => {
      r.reviewerUserId = proposer;
    },
  ],
  [
    'foreign Pat identity',
    (r) => {
      r.actors.PAT.physicalId = reviewer;
    },
  ],
  [
    'conflicting Pat identities',
    (r) => {
      r.actors.PAT.userId = reviewer;
    },
  ],
  [
    'conflicting Priya identities',
    (r) => {
      r.actors.PRIYA.userId = proposer;
    },
  ],
  [
    'foreign Aster tenant',
    (r) => {
      r.clients.ASTER.tenantId = 'T2';
    },
  ],
  [
    'forged Clerk identifier',
    (r) => {
      r.clerkUserId = 'not-clerk';
    },
  ],
  [
    'extra context role authority',
    (r) => {
      r.ctx.admin = true;
    },
  ],
])
  test(`recipe rejects ${label}`, async () => {
    const input = recipe();
    change(input);
    await assert.rejects(() => resolveCase12SetupRecipe(input));
  });
test('missing native spend owner rejects before ANY dependency access or journal/canonical work', async () => {
  let calls = 0;
  const deps = {
    get prisma() {
      calls++;
      throw new Error('NO_READS_EXPECTED');
    },
  };
  await assert.rejects(
    () =>
      executeCase12Setup(deps, recipe(), {
        expectedPlanSha256: 'a'.repeat(64),
        setupSpendAuthority: { ready: true },
        journal: async () => {
          calls++;
        },
      }),
    /CASE12_SETUP_NATIVE_BUDGET_AUTHORITY_MISSING/,
  );
  assert.equal(calls, 0);
});
test('JSON ready flag cannot substitute for native spend owner function', async () => {
  await assert.rejects(
    () => executeCase12Setup({ consumeCase12SetupSpendAuthority: { ready: true } }, recipe()),
    /NATIVE_BUDGET_AUTHORITY_MISSING/,
  );
});
test('missing per-row native scope fails before recipe reads or metadata writes', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      executeCase12Setup(
        {
          consumeCase12SetupSpendAuthority: async () => {
            calls++;
          },
        },
        recipe(),
      ),
    /NATIVE_ROW_BUDGET_SCOPE_MISSING/,
  );
  assert.equal(calls, 0);
});
