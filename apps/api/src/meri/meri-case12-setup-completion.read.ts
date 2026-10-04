import { createHash } from 'node:crypto';
import { readMeriCase12SetupBinding } from '@capiro/meriv2-core';
import { case12SetupHash, readCase12SetupBudget, validateCase12SetupBudgetPlan } from './meri-case12-setup-budget.js';

const TENANT = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const NAMESPACE = 'meri-foundation-20260928';
const HASH = /^[a-f0-9]{64}$/u;
const record = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const need = (v: unknown): void => { if (!v) throw new Error('meri_case12_setup_completion_unproved'); };

// Same normalized recipe/claim hash as evals/meri/live-v1/lib/stable.mjs.
function stableValue(v: any): any {
  if (typeof v === 'string') return v.normalize('NFC').replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/[\t ]+$/u, '')).join('\n').replace(/\n+$/u, '');
  if (Array.isArray(v)) return v.map(stableValue);
  if (record(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, stableValue(v[k])]));
  return v;
}
const stableHash = (v: unknown) => createHash('sha256').update(JSON.stringify(stableValue(v)), 'utf8').digest('hex');

/** Reads the completed durable setup in the caller's current tenant transaction.
 * The caller must separately qualify today's corpus and actor on this transaction.
 * This is provenance/accounting, not a fresh vector scan, quiescence proof, aggregate
 * settlement, provider permission, or capture admission. Expired setups remain readable. */
export async function readCase12SetupCompletionInTx(
  tx: { $queryRawUnsafe(query: string, ...values: unknown[]): Promise<any[]> },
  ctx: { tenantId: string; userId: string; role: string },
  corpus: { tenantId: string; actorUserId: string; clientId: string; fixtureInstanceId: string;
    setupPlanSha256: string; setupClaimSha256: string },
) {
  need(typeof tx?.$queryRawUnsafe === 'function' && ctx?.tenantId === TENANT && ctx.role === 'standard_user' &&
    corpus?.tenantId === ctx.tenantId && corpus.actorUserId === ctx.userId &&
    typeof corpus.setupClaimSha256 === 'string' && HASH.test(corpus.setupClaimSha256));
  const rows = await tx.$queryRawUnsafe('SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid FOR SHARE', TENANT);
  const fixture = rows[0]?.settings?.meriFoundationFixture;
  need(rows.length === 1 && record(fixture) && fixture.fixtureNamespace === NAMESPACE);
  const claim = fixture.case12MemorySetup, stored = fixture.case12SetupProviderBudget;
  need(record(claim) && claim.kind === 'meri-case12-memory-setup-claim' && claim.schemaVersion === 1 &&
    claim.status === 'SETUP_COMPLETE' && claim.liveAcceptance === 'NOT_RUN' &&
    claim.fixtureInstanceId === corpus.fixtureInstanceId && claim.planSha256 === corpus.setupPlanSha256 &&
    stableHash(claim) === corpus.setupClaimSha256 && Array.isArray(claim.progress) && claim.progress.length === 510 &&
    claim.progressSha256 === stableHash(claim.progress) &&
    claim.claimIdentitySha256 === stableHash({planSha256: claim.planSha256, recipeSha256: claim.recipeSha256}));
  need(record(stored) && Object.keys(stored).sort().join('|') === 'plan|state|terminalProofs|version' &&
    stored.version === 1 && Array.isArray(stored.terminalProofs) && stored.terminalProofs.length === 510);
  const plan = validateCase12SetupBudgetPlan(stored.plan), state = readCase12SetupBudget(stored.state, plan);
  need(plan.tenantId === TENANT && plan.proposerUserId === ctx.userId && plan.clientId === corpus.clientId &&
    plan.fixtureInstanceId === claim.fixtureInstanceId && plan.setupPlanSha256 === claim.planSha256 &&
    plan.recipeSha256 === claim.recipeSha256 && plan.orderedDefinitionSha256 === claim.orderedDefinitionSha256 &&
    record(claim.plan) && claim.plan.planSha256 === plan.setupPlanSha256 &&
    stableHash(Object.fromEntries(Object.entries(claim.plan).filter(([k]) => k !== 'planSha256'))) === plan.setupPlanSha256 &&
    state.nextRow === 510 && state.reconciliationRequired === false);
  let chargedCostMicros = 0, chargedTokens = 0, providerAttempts = 0;
  for (let i = 0; i < 510; i++) {
    const row = plan.rows[i]!, child = state.rows[i], step = claim.progress[i], proof = stored.terminalProofs[i], meta = proof?.metadata;
    need(child && child.attempts.length === 2 && child.attempts.every(a => a.status === 'settled') &&
      record(step) && step.index === i && step.phase === 'VERIFIED' && step.logicalId === row.logicalId &&
      step.candidateId === row.candidateId && record(step.binding) && step.bindingSha256 === stableHash(step.binding) &&
      step.binding.candidateId === row.candidateId && step.binding.candidatePayloadSha256 === row.candidatePayloadSha256 &&
      step.binding.tenantId === TENANT && step.binding.clientId === plan.clientId && step.binding.lifecycle === 'approved' &&
      record(proof) && Object.keys(proof).sort().join('|') === 'metadata|proofSha256|row' && proof.row === i &&
      record(meta) && case12SetupHash(meta) === proof.proofSha256 && Buffer.byteLength(JSON.stringify(proof), 'utf8') <= 4096 &&
      meta.kind === 'meri-case12-setup-terminal-row' && meta.version === 1 &&
      meta.fixtureInstanceId === plan.fixtureInstanceId && meta.logicalId === row.logicalId &&
      meta.candidateId === row.candidateId && meta.itemId === step.binding.physicalId &&
      meta.tenantId === TENANT && meta.clientId === plan.clientId && meta.proposerUserId === plan.proposerUserId &&
      meta.reviewerUserId === plan.reviewerUserId && meta.sourceVersion === `candidate:${row.candidateId}` &&
      meta.candidateRowVersion === step.binding.candidateRowVersion && meta.itemRowVersion === step.binding.itemRowVersion &&
      meta.legacyDimensions === 1536 && meta.institutionalDimensions === 1024 &&
      meta.institutionalModel === 'amazon.titan-embed-text-v2:0' &&
      meta.captureAuthority === false && meta.liveAcceptance === 'NOT_RUN');
    chargedCostMicros += child!.chargedCostMicros;
    chargedTokens += child!.chargedTokens;
    providerAttempts += child!.chargedAttempts;
  }
  need(providerAttempts === 1020 && Number.isSafeInteger(chargedTokens) &&
    Number.isSafeInteger(chargedCostMicros) && chargedCostMicros > 0 && chargedCostMicros <= plan.maxCostMicros);
  return Object.freeze({
    kind: 'meri-case12-current-completed-setup' as const,
    binding: readMeriCase12SetupBinding({setupRunId: plan.runId, fixtureInstanceId: plan.fixtureInstanceId,
      setupPlanSha256: plan.setupPlanSha256, setupClaimSha256: corpus.setupClaimSha256, setupLedgerSha256: case12SetupHash(stored)}),
    chargedCostMicros, chargedTokens, providerAttempts, completedRows: 510, pendingProviderAttempts: 0,
    captureAuthority: false as const, liveAcceptance: 'NOT_RUN' as const,
  });
}
