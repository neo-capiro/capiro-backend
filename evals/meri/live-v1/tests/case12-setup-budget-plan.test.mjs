import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildCase12SetupProviderPlan, deriveCase12SetupProviderRows } from '../fixture-provisioning/case12-setup-budget-plan.mjs';
import { resolveCase12SetupRecipe } from '../fixture-provisioning/case12-memory-setup.mjs';
import { expectedMemoryCandidatePayload } from '../fixture-provisioning/memory-candidate-owner.mjs';
import { sha256Stable, stableJson } from '../lib/stable.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
require('ts-node').register({
  project: fileURLToPath(new URL('../../../../apps/api/tsconfig.json', import.meta.url)),
  transpileOnly: true,
  experimentalResolver: true,
});
const native = {
  ...require(
    fileURLToPath(
      new URL('../../../../apps/api/src/meri/meri-case12-setup-budget.ts', import.meta.url),
    ),
  ),
  ...require(
    fileURLToPath(
      new URL(
        '../../../../apps/api/src/memory/strict-memory-projector.service.ts',
        import.meta.url,
      ),
    ),
  ),
};
process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'meri-foundation-20260928';
const proposer = '44444444-4444-4444-8444-444444444444';
const reviewer = '66666666-6666-4666-8666-666666666666';
const client = '11111111-1111-4111-8111-111111111111';
const recipe = {
  schemaVersion: 1,
  target: 'capiro-dev',
  caseId: '12',
  fixtureNamespace: 'meri-foundation-20260928',
  fixtureInstanceId: randomUUID(),
  ctx: {
    tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
    tenantSlug: 'meri-foundation-20260928-t1',
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
    ASTER: { tenantId: 'T1', physicalId: client },
    BLUEHAVEN: { tenantId: 'T1', physicalId: '22222222-2222-4222-8222-222222222222' },
    CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
  },
};
const spec = await resolveCase12SetupRecipe(recipe);
const body = {
  kind: 'meri-case12-memory-setup-plan',
  schemaVersion: 1,
  recipeSha256: sha256Stable(spec.input),
  manifestContentSha256: spec.manifest.contentSha256,
  orderedDefinitionSha256: sha256Stable(spec.definitions.map((d) => d.candidate)),
  exactCanonicalDefinitionCount: 510,
  firstLogicalId: 'MA510',
  tenantId: recipe.ctx.tenantId,
  tenantRowVersion: '100',
  priorSettingsSha256: '1'.repeat(64),
  fixtureNamespace: recipe.fixtureNamespace,
  fixtureInstanceId: recipe.fixtureInstanceId,
  actorScope: {
    proposerUserId: proposer,
    proposerRole: 'standard_user',
    clerkUserId: recipe.clerkUserId,
    reviewerUserId: reviewer,
    reviewerRole: 'user_admin',
    clientId: client,
  },
  fixtureReady: false,
  captureAuthority: false,
  liveAcceptance: 'NOT_RUN',
};
const setupPlan = { ...body, planSha256: sha256Stable(body) };
const envelope = {
  runId: randomUUID(),
  aggregateReservationId: randomUUID(),
  sourceSha256: '2'.repeat(64),
  imageSha256: '3'.repeat(64),
  aggregateCheckpointSha256: '4'.repeat(64),
  rateEvidenceSha256: '5'.repeat(64),
  admittedAt: '2026-10-04T10:00:00.000Z',
  deadlineAt: '2026-10-04T10:15:00.000Z',
  ratesExpiresAt: '2026-10-04T11:00:00.000Z',
  // Synthetic test values only; no live price evidence or native admission.
  rates: {
    openai_embeddings: { inputPerM: 0.02, outputPerM: 0 },
    bedrock_embeddings: { inputPerM: 0.02, outputPerM: 0 },
  },
};
const input = { recipe, setupPlan, envelope };
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('all 510 exact fixed rows derive both wire bodies using actual native projection and reducer', async () => {
  const plan = await buildCase12SetupProviderPlan(input, native);
  assert.equal(plan.rows.length, 510);
  assert.equal(plan.maxCostMicros, 167280);
  assert.deepEqual(native.validateCase12SetupBudgetPlan(plan), plan);
  for (let index = 0; index < 510; index++) {
    const { candidate, logicalId } = spec.definitions[index];
    const payload = expectedMemoryCandidatePayload(
      candidate,
      proposer,
      stableJson({ ownership: candidate.ownership, payload: candidate.payload }),
    );
    const expectedText = native.projectionTextForItem({
      title: payload.key,
      sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: payload.value }],
    });
    const bodies = {
      openai_embeddings: JSON.stringify({
        model: 'text-embedding-3-small',
        input: `${payload.key}: ${payload.value}`,
      }),
      bedrock_embeddings: JSON.stringify({
        inputText: expectedText,
        dimensions: 1024,
        normalize: true,
      }),
    };
    assert.equal(plan.rows[index].logicalId, logicalId);
    assert.equal(plan.rows[index].candidateId, candidate.physicalId);
    for (const [kind, value] of Object.entries(bodies))
      assert.deepEqual(plan.rows[index].requests[kind], {
        bodySha256: sha(value),
        inputBytes: Buffer.byteLength(value),
      });
  }
  assert.equal(plan.setupPlanSha256, setupPlan.planSha256);
  assert.equal(native.createCase12SetupBudget(plan).planSha256, native.case12SetupHash(plan));
});

test('plan output does not retain mutable input references', async () => {
  const copy = structuredClone(input),
    plan = await buildCase12SetupProviderPlan(copy, native);
  copy.envelope.rates.openai_embeddings.inputPerM = 99;
  assert.equal(plan.rates.openai_embeddings.inputPerM, 0.02);
});

for (const [name, mutate] of [
  ['unhashed setup change', (x) => (x.setupPlan.tenantRowVersion = '101')],
  [
    'wrong current definitions',
    (x) => {
      x.setupPlan.orderedDefinitionSha256 = '9'.repeat(64);
      const { planSha256, ...b } = x.setupPlan;
      x.setupPlan.planSha256 = sha256Stable(b);
    },
  ],
  ['caller-supplied body', (x) => (x.envelope.rows = [])],
  ['caller-supplied ceiling', (x) => (x.envelope.maxCostMicros = 1)],
  [
    'changed model price exceeds case ceiling',
    (x) => (x.envelope.rates.openai_embeddings.inputPerM = 100),
  ],
  ['array run ID', (x) => (x.envelope.runId = [x.envelope.runId])],
  ['expired plan window', (x) => (x.envelope.ratesExpiresAt = x.envelope.admittedAt)],
  ['source text injection', (x) => (x.recipe.sourceText = 'replacement')],
  ['different actor', (x) => (x.recipe.ctx.userId = reviewer)],
])
  test(`rejects ${name}`, async () => {
    const copy = structuredClone(input);
    mutate(copy);
    await assert.rejects(buildCase12SetupProviderPlan(copy, native));
  });

test('missing native planning functions cannot silently substitute a wire plan', async () => {
  await assert.rejects(buildCase12SetupProviderPlan(input, {}));
});


test('derived request identities require no envelope and join the full plan exactly', async () => {
  const derived = await deriveCase12SetupProviderRows({ recipe, setupPlan }, native);
  const full = await buildCase12SetupProviderPlan(input, native);
  const { rows, ...identity } = derived;
  assert.equal(JSON.stringify(rows), JSON.stringify(full.rows));
  assert.deepEqual(Object.keys(identity).sort(), ['version', 'caseId', 'fixtureNamespace', 'fixtureInstanceId', 'tenantId', 'proposerUserId', 'reviewerUserId', 'clientId', 'setupPlanSha256', 'recipeSha256', 'orderedDefinitionSha256'].sort());
  for (const [key, value] of Object.entries(identity)) assert.equal(full[key], value);
  for (const field of ['aggregateReservationId', 'aggregateCheckpointSha256', 'maxCostMicros', 'runId', 'admittedAt', 'deadlineAt', 'rates', 'fixtureReady', 'captureAuthority']) assert.equal(Object.hasOwn(derived, field), false);
});

test('derivation clones recipe and plan before asynchronous asset reads', async () => {
  const copy = structuredClone(input);
  const pending = deriveCase12SetupProviderRows(copy, native);
  copy.recipe.ctx.userId = reviewer;
  copy.setupPlan.planSha256 = '0'.repeat(64);
  const result = await pending;
  assert.equal(result.proposerUserId, proposer);
  assert.equal(result.setupPlanSha256, setupPlan.planSha256);
  result.rows[0].requests.openai_embeddings.bodySha256 = '0'.repeat(64);
  const fresh = await deriveCase12SetupProviderRows(input, native);
  assert.notEqual(fresh.rows[0].requests.openai_embeddings.bodySha256, '0'.repeat(64));
});

test('full builder clones the budget envelope before asynchronous asset reads', async () => {
  const copy = structuredClone(input);
  const pending = buildCase12SetupProviderPlan(copy, native);
  copy.envelope.rates.openai_embeddings.inputPerM = 100;
  const result = await pending;
  assert.equal(result.rates.openai_embeddings.inputPerM, 0.02);
  assert.equal(result.maxCostMicros, 167280);
});

test('Unicode projection material hashes exact UTF-8 bytes rather than string length', async () => {
  // Deliberately perturbed projection input tests serialization only. This is
  // not a current canonical fixture proof or a live body-plan authority.
  const observed = [];
  const unicodeNative = {
    canonicalProjectionSnapshot(item) {
      const projected = native.canonicalProjectionSnapshot({
        ...item,
        sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: 'café — 東京 🧭' }],
      });
      observed.push(projected.text);
      return projected;
    },
  };
  const result = await deriveCase12SetupProviderRows({ recipe, setupPlan }, unicodeNative);
  assert.equal(observed.length, 510);
  for (let index = 0; index < 510; index++) {
    const wire = JSON.stringify({ inputText: observed[index], dimensions: 1024, normalize: true });
    assert.ok(Buffer.byteLength(wire, 'utf8') > wire.length);
    assert.deepEqual(result.rows[index].requests.bedrock_embeddings, { bodySha256: sha(wire), inputBytes: Buffer.byteLength(wire, 'utf8') });
  }
});

test('derivation rejects changed current definition joins and source-text injection', async () => {
  const wrong = structuredClone(input);
  wrong.setupPlan.orderedDefinitionSha256 = '9'.repeat(64);
  const { planSha256, ...body } = wrong.setupPlan;
  wrong.setupPlan.planSha256 = sha256Stable(body);
  await assert.rejects(deriveCase12SetupProviderRows(wrong, native));
  const injected = structuredClone(input);
  injected.recipe.sourceText = 'replacement';
  await assert.rejects(deriveCase12SetupProviderRows(injected, native));
  await assert.rejects(deriveCase12SetupProviderRows(input, {}));
});
