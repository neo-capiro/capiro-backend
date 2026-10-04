import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildCase12SetupProviderPlan, deriveCase12SetupProviderRows } from './scratch/evals/meri/live-v1/fixture-provisioning/case12-setup-budget-plan.mjs';
import { resolveCase12SetupRecipe } from './scratch/evals/meri/live-v1/fixture-provisioning/case12-memory-setup.mjs';
import { expectedMemoryCandidatePayload } from './scratch/evals/meri/live-v1/fixture-provisioning/memory-candidate-owner.mjs';
import { sha256Stable, stableJson } from './scratch/evals/meri/live-v1/lib/stable.mjs';

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildCase12SetupProviderPlan as baseline } from './scratch/evals/meri/live-v1/fixture-provisioning/case12-setup-budget-plan.baseline.mjs';
const require = createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
const native = {
  ...require('C:/dev/main/meri-c1-20261002/apps/api/dist/meri/meri-case12-setup-budget.js'),
  ...require('C:/dev/main/meri-c1-20261002/apps/api/dist/memory/strict-memory-projector.service.js'),
};
const loaded = Object.keys(require.cache).filter(p => p.replaceAll('\\','/').startsWith('C:/dev/main/meri-c1-20261002/') && !p.includes('node_modules'));
const runtimePins = loaded.map(path => ({path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), bytes:readFileSync(path).length}));
writeFileSync(new URL('./runtime-input-manifest.json',import.meta.url),JSON.stringify(runtimePins,null,2)+'\n');
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

test('full builder is byte-exact versus frozen pre-extraction baseline', async () => {
  const old = await baseline(input, native), current = await buildCase12SetupProviderPlan(input, native);
  assert.equal(JSON.stringify(current), JSON.stringify(old));
  const derived = await deriveCase12SetupProviderRows({recipe,setupPlan},native);
  assert.equal(JSON.stringify(derived.rows),JSON.stringify(old.rows));
  assert.equal(sha256Stable(derived.rows),sha256Stable(old.rows));
  assert.deepEqual(Object.keys(derived).sort(), ['version','caseId','fixtureNamespace','fixtureInstanceId','tenantId','proposerUserId','reviewerUserId','clientId','setupPlanSha256','recipeSha256','orderedDefinitionSha256','rows'].sort());
  for (const forbidden of ['aggregateReservationId','aggregateCheckpointSha256','maxCostMicros','runId','admittedAt','deadlineAt','rates','fixtureReady','captureAuthority']) assert.equal(Object.hasOwn(derived,forbidden),false);
});

test('derivation needs only real projection and never calls budget or reservation methods', async () => {
  const derived=await deriveCase12SetupProviderRows({recipe,setupPlan},{canonicalProjectionSnapshot:native.canonicalProjectionSnapshot});
  assert.equal(derived.rows.length,510);
  assert.equal(derived.rows[0].logicalId,'MA510');
  assert.equal(new Set(derived.rows.map(row=>row.candidateId)).size,510);
});

test('clones fixture/plan before asynchronous local reads and returns independent rows', async () => {
  const x=structuredClone(input), pending=deriveCase12SetupProviderRows(x,native);
  x.recipe.ctx.userId=reviewer; x.setupPlan.planSha256='9'.repeat(64);
  const rows=await pending;
  assert.equal(rows.proposerUserId,proposer);
  rows.rows[0].requests.openai_embeddings.bodySha256='0'.repeat(64);
  const again=await deriveCase12SetupProviderRows(input,native);
  assert.notEqual(again.rows[0].requests.openai_embeddings.bodySha256,'0'.repeat(64));
});

test('full builder clones envelope before asynchronous local reads', async () => {
  const x=structuredClone(input), pending=buildCase12SetupProviderPlan(x,native);
  x.envelope.rates.openai_embeddings.inputPerM=100;
  const result=await pending;
  assert.equal(result.rates.openai_embeddings.inputPerM,0.02);
  assert.equal(JSON.stringify(result),JSON.stringify(await baseline(input,native)));
});

for (const [name,mutate] of [
 ['extra recipe source',x=>x.recipe.sourceText='injected'],
 ['wrong actor',x=>x.recipe.ctx.userId=reviewer],
 ['bad plan hash',x=>x.setupPlan.planSha256='0'.repeat(64)],
 ['wrong ordered definitions',x=>{x.setupPlan.orderedDefinitionSha256='9'.repeat(64);const {planSha256,...body}=x.setupPlan;x.setupPlan.planSha256=sha256Stable(body);}],
 ['readiness escalation',x=>{x.setupPlan.fixtureReady=true;const {planSha256,...body}=x.setupPlan;x.setupPlan.planSha256=sha256Stable(body);}],
 ['extra plan field',x=>x.setupPlan.rows=[]],
 ['wrong first logical ID',x=>{x.setupPlan.firstLogicalId='MA509';const {planSha256,...body}=x.setupPlan;x.setupPlan.planSha256=sha256Stable(body);}],
 ['foreign actor scope',x=>{x.setupPlan.actorScope.clientId=reviewer;const {planSha256,...body}=x.setupPlan;x.setupPlan.planSha256=sha256Stable(body);}],
]) test(`original and extraction reject same fixture/plan boundary: ${name}`,async()=>{
 const x=structuredClone(input);mutate(x);
 await assert.rejects(baseline(x,native));
 await assert.rejects(buildCase12SetupProviderPlan(x,native));
 await assert.rejects(deriveCase12SetupProviderRows(x,native));
});

for(const [name,mutate] of [
 ['extra envelope row',x=>x.envelope.rows=[]],
 ['wrong token bound',()=>{}],
 ['excessive price',x=>x.envelope.rates.openai_embeddings.inputPerM=100],
 ['array run',x=>x.envelope.runId=[x.envelope.runId]],
 ['expired window',x=>x.envelope.ratesExpiresAt=x.envelope.admittedAt],
]) test(`original and full builder preserve admission envelope rejection: ${name}`,async()=>{
 const x=structuredClone(input);mutate(x);
 const functions=name==='wrong token bound'?{...native,CASE12_SETUP_MAX_INPUT_TOKENS:8191}:native;
 await assert.rejects(baseline(x,functions)); await assert.rejects(buildCase12SetupProviderPlan(x,functions));
});

test('all actual compiled modules remain byte-identical during qualification',()=>{
 for(const pin of runtimePins) assert.equal(createHash('sha256').update(readFileSync(pin.path)).digest('hex'),pin.sha256,pin.path);
});
