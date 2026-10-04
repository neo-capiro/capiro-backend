#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  resolveCase12SetupRecipe, inspectCase12Setup, executeCase12Setup,
  createCase12SetupCurrentScopeInspector,
} from '../../../evals/meri/live-v1/fixture-provisioning/case12-memory-setup.mjs';
import { buildCase12SetupProviderPlan } from '../../../evals/meri/live-v1/fixture-provisioning/case12-setup-budget-plan.mjs';
import { expectedMemoryCandidatePayload } from '../../../evals/meri/live-v1/fixture-provisioning/memory-candidate-owner.mjs';
import { stableJson } from '../../../evals/meri/live-v1/lib/stable.mjs';

const require = createRequire(import.meta.url);
const source = path => require(`../dist/${path}.js`);
const need = ok => { if (!ok) throw Error('CASE12_NATIVE_SETUP_REJECTED'); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const emit = (prefix, value) => new Promise((resolve, reject) => {
  process.stdout.write(prefix + ' ' + JSON.stringify(value) + '\n', error => error ? reject(error) : resolve());
});
let factory;
let terminal;

try {
  // This one-off has no file ingress, injected dependencies, resume or retry mode.
  // The operator pins its complete definition, exact override bytes and one task.
  need(process.argv.length === 3 && process.argv[2] === 'execute');
  const raw = process.env.MERI_CASE12_NATIVE_SETUP_INPUT;
  need(typeof raw === 'string' && Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= 7000);
  const input = JSON.parse(raw);
  need(record(input) && Object.keys(input).sort().join('|') === 'kind|native|providerEnvelope|recipe|version' &&
    input.kind === 'meri-case12-native-setup-input' && input.version === 1);
  const spec = await resolveCase12SetupRecipe(input.recipe);
  const recipe = spec.input, ctx = {...recipe.ctx, clerkUserId: recipe.clerkUserId};
  const {createCase01SetupDependencies} = await import('./meri-case01-setup-dependencies.mjs');
  factory = await createCase01SetupDependencies();
  terminal = await factory.runWithTenant(ctx, async () => {
    // Fresh current inspection is read-only. Its exact hash must join the held
    // operator plan; no caller-supplied plan, corpus or readiness is adopted.
    const inspection = await inspectCase12Setup(factory.deps, recipe);
    need(inspection.status === 'PLAN_ONLY');
    const budget = source('meri/meri-case12-setup-budget');
    const plan = await buildCase12SetupProviderPlan({recipe, setupPlan: inspection.plan,
      envelope: input.providerEnvelope}, {...budget, canonicalProjectionSnapshot: factory.deps.canonicalProjectionSnapshot});
    const {createCase12NativeSetupAdmission} = source('meri/meri-case12-native-setup-admission');
    const native = await createCase12NativeSetupAdmission(raw, plan);
    const {createCase12SetupBudgetOwner} = source('meri/meri-case12-setup-budget-owner');
    const {inspectCase12SetupTerminalRowInTx} = source('memory/case12-setup-terminal.read');
    const scope = await createCase12SetupCurrentScopeInspector(factory.deps, recipe);
    const payloads = spec.definitions.map(({candidate}) => expectedMemoryCandidatePayload(candidate,
      recipe.ctx.userId, stableJson({ownership: candidate.ownership, payload: candidate.payload})));
    const owner = createCase12SetupBudgetOwner({prisma: factory.deps.prisma,
      assertCurrentCase12ScopeInTx: scope.assertInTx,
      consumeNativeSetupAdmissionInTx: native.consumeNativeSetupAdmissionInTx,
      inspectTerminalRowInTx: (tx, currentCtx, row, binding) => inspectCase12SetupTerminalRowInTx(tx,
        currentCtx, {fixtureInstanceId: recipe.fixtureInstanceId, logicalId: row.logicalId,
          candidateId: row.candidate.physicalId, itemId: binding.physicalId, clientId: plan.clientId,
          proposerUserId: recipe.ctx.userId, reviewerUserId: recipe.reviewerUserId,
          expectedCandidateRowVersion: binding.candidateRowVersion,
          expectedItemRowVersion: binding.itemRowVersion, expectedPayload: payloads[row.index],
          admittedAt: plan.admittedAt, deadlineAt: plan.deadlineAt}, factory.deps.memoryAuthorization),
    });
    const result = await executeCase12Setup({...factory.deps, ...owner}, recipe, {
      expectedPlanSha256: inspection.plan.planSha256, setupSpendAuthority: native.admission,
      // Pipe acknowledgement is only local process delivery. The locked setup
      // and provider ledgers remain the durable authority, independent of logs.
      journal: event => emit('MERI_CASE12_SETUP_PROGRESS', event),
    });
    need(result.status === 'SETUP_COMPLETE' && result.reconciliationRequired === false);
    const {readMeriCase12CompletedCorpusInTx} = source('meri/meri-case12-capture-authority');
    const {proof, completion} = await factory.deps.prisma.withTenantUser(ctx.tenantId, ctx.userId,
      tx => readMeriCase12CompletedCorpusInTx(factory.deps.prisma, tx, ctx, plan.clientId));
    need(proof.corpusQualified === true && completion.completedRows === 510 &&
      completion.providerAttempts === 1020 && completion.pendingProviderAttempts === 0 &&
      completion.binding.setupRunId === plan.runId && completion.binding.setupPlanSha256 === plan.setupPlanSha256);
    return {kind: 'meri-case12-native-setup-terminal', version: 1,
      status: 'SETUP_COMPLETE_CURRENT_CORPUS_QUALIFIED', native: native.proof,
      providerPlanSha256: budget.case12SetupHash(plan), case12Setup: completion.binding,
      currentVerifySha256: proof.currentVerifySha256, physicalMapSha256: proof.physicalMapSha256,
      chargedCostMicros: completion.chargedCostMicros, chargedTokens: completion.chargedTokens,
      completedRows: completion.completedRows, providerAttempts: completion.providerAttempts,
      pendingProviderAttempts: completion.pendingProviderAttempts,
      captureAuthority: false, aggregateSettlement: 'NOT_RUN', humanAcceptance: 'NOT_RUN', liveAcceptance: 'NOT_RUN'};
  });
} catch {
  // Do not expose exception text containing database/provider configuration.
  // Any failure after possible dispatch retains the operator's full hold until
  // separate native readback/quiescence proves an allowed settlement.
  process.stderr.write('CASE12_NATIVE_SETUP_FAILED_RECONCILIATION_REQUIRED\n');
  process.exitCode = 1;
} finally {
  try { if (factory) await factory.close(); }
  catch { process.stderr.write('CASE12_NATIVE_SETUP_CLOSE_UNCERTAIN\n'); process.exitCode = 1; }
}
if (terminal && !process.exitCode) {
  const bytes = JSON.stringify(terminal);
  try { await emit('MERI_CASE12_SETUP_TERMINAL', {...terminal,
    terminalSha256: createHash('sha256').update(bytes, 'utf8').digest('hex')}); }
  catch { process.stderr.write('CASE12_NATIVE_SETUP_TERMINAL_ACK_UNCERTAIN\n'); process.exitCode = 1; }
}
