import { createHash } from 'node:crypto';
import { resolveCase12SetupRecipe } from './case12-memory-setup.mjs';
import { expectedMemoryCandidatePayload } from './memory-candidate-owner.mjs';
import { sha256Stable, stableJson } from '../lib/stable.mjs';

const need = (ok) => {
  if (!ok) throw new Error('CASE12_SETUP_PROVIDER_PLAN_REJECTED');
};
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value) => (record(value) ? Object.keys(value).sort().join('|') : '');
const hashBytes = (body) => createHash('sha256').update(body, 'utf8').digest('hex');

/** Derive fixed request identities from verified local fixture assets and a
 * native read-only setup plan. This returns data only: no reservation, price,
 * deadline, readiness or capture authority is created. */
export async function deriveCase12SetupProviderRows({ recipe, setupPlan }, native) {
  need(typeof native?.canonicalProjectionSnapshot === 'function');
  const input = structuredClone({ recipe, setupPlan });
  const spec = await resolveCase12SetupRecipe(input.recipe);
  const plan = input.setupPlan;
  need(
    keys(plan) ===
      'actorScope|captureAuthority|exactCanonicalDefinitionCount|firstLogicalId|fixtureInstanceId|fixtureNamespace|fixtureReady|kind|liveAcceptance|manifestContentSha256|orderedDefinitionSha256|planSha256|priorSettingsSha256|recipeSha256|schemaVersion|tenantId|tenantRowVersion',
  );
  const { planSha256, ...planBody } = plan;
  need(
    typeof planSha256 === 'string' &&
      planSha256 === sha256Stable(planBody) &&
      plan.kind === 'meri-case12-memory-setup-plan' &&
      plan.schemaVersion === 1 &&
      plan.recipeSha256 === sha256Stable(spec.input) &&
      plan.manifestContentSha256 === spec.manifest.contentSha256 &&
      plan.orderedDefinitionSha256 === sha256Stable(spec.definitions.map((d) => d.candidate)) &&
      plan.exactCanonicalDefinitionCount === 510 &&
      plan.firstLogicalId === 'MA510' &&
      plan.tenantId === spec.input.ctx.tenantId &&
      plan.fixtureInstanceId === spec.input.fixtureInstanceId &&
      plan.fixtureNamespace === spec.input.fixtureNamespace &&
      plan.fixtureReady === false &&
      plan.captureAuthority === false &&
      plan.liveAcceptance === 'NOT_RUN' &&
      typeof plan.priorSettingsSha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(plan.priorSettingsSha256) &&
      typeof plan.tenantRowVersion === 'string' &&
      /^[0-9]+$/u.test(plan.tenantRowVersion) &&
      sha256Stable(plan.actorScope) ===
        sha256Stable({
          proposerUserId: spec.input.ctx.userId,
          proposerRole: 'standard_user',
          clerkUserId: spec.input.clerkUserId,
          reviewerUserId: spec.input.reviewerUserId,
          reviewerRole: 'user_admin',
          clientId: spec.manifest.clients.ASTER.physicalId,
        }),
  );
  const rows = spec.definitions.map(({ candidate, logicalId }) => {
    const payload = expectedMemoryCandidatePayload(
      candidate,
      spec.input.ctx.userId,
      stableJson({ ownership: candidate.ownership, payload: candidate.payload }),
    );
    // Canonical approval allocates the item ID later. Projection text is based
    // only on title/sections; no proposed UUID is claimed as that future item.
    const projection = native.canonicalProjectionSnapshot({
      id: candidate.physicalId,
      clientId: payload.clientId,
      ownerUserId: null,
      title: payload.key,
      sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: payload.value }],
    });
    need(projection.embeddingRequired === true && typeof projection.text === 'string');
    const bodies = {
      openai_embeddings: JSON.stringify({
        model: 'text-embedding-3-small',
        input: `${payload.key}: ${payload.value}`,
      }),
      bedrock_embeddings: JSON.stringify({
        inputText: projection.text,
        dimensions: 1024,
        normalize: true,
      }),
    };
    return {
      candidateId: candidate.physicalId,
      logicalId,
      candidatePayloadSha256: candidate.payloadSha256,
      requests: Object.fromEntries(
        Object.entries(bodies).map(([kind, body]) => [
          kind,
          { bodySha256: hashBytes(body), inputBytes: Buffer.byteLength(body, 'utf8') },
        ]),
      ),
    };
  });
  return {
    version: 1,
    caseId: '12',
    fixtureNamespace: spec.input.fixtureNamespace,
    fixtureInstanceId: spec.input.fixtureInstanceId,
    tenantId: spec.input.ctx.tenantId,
    proposerUserId: spec.input.ctx.userId,
    reviewerUserId: spec.input.reviewerUserId,
    clientId: spec.manifest.clients.ASTER.physicalId,
    setupPlanSha256: planSha256,
    recipeSha256: plan.recipeSha256,
    orderedDefinitionSha256: plan.orderedDefinitionSha256,
    rows,
  };
}

/** Deterministic planning with verified local fixture asset reads. This performs
 * no database calls, writes, reservations or provider calls. Native admission must own the
 * envelope, bind its journal hold and supply the actual compiled native functions.
 * Neither the returned JSON nor injected planning functions mint authority. */
export async function buildCase12SetupProviderPlan({ recipe, setupPlan, envelope }, native) {
  need(
    typeof native?.canonicalProjectionSnapshot === 'function' &&
      typeof native.validateCase12SetupBudgetPlan === 'function' &&
      typeof native.case12SetupCost === 'function' &&
      native.CASE12_SETUP_MAX_INPUT_TOKENS === 8192,
  );
  need(
    keys(envelope) ===
      'admittedAt|aggregateCheckpointSha256|aggregateReservationId|deadlineAt|imageSha256|rateEvidenceSha256|rates|ratesExpiresAt|runId|sourceSha256',
  );
  const input = structuredClone({ recipe, setupPlan, envelope });
  const derived = await deriveCase12SetupProviderRows(input, native);
  const { rows, ...identity } = derived;
  need(keys(input.envelope.rates) === 'bedrock_embeddings|openai_embeddings');
  const maxCostMicros =
    rows.length *
    ['openai_embeddings', 'bedrock_embeddings'].reduce(
      (total, kind) => total + native.case12SetupCost(input.envelope.rates[kind]?.inputPerM, 8192),
      0,
    );
  return native.validateCase12SetupBudgetPlan({
    ...identity,
    ...input.envelope,
    maxCostMicros,
    rows,
  });
}
