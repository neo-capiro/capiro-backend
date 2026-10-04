import assert from 'node:assert/strict';
import {reconcileCase01MemoryCorpusInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs';
import {reconcileCase01MetadataInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-reconciliation.mjs';
import {reconcileSyntheticMemoryCorpus,readSyntheticReadOperatorInput} from '/app/apps/api/scripts/meri-synthetic-read-budget.mjs';
for (const fn of [reconcileCase01MemoryCorpusInTx,reconcileCase01MetadataInTx,reconcileSyntheticMemoryCorpus]) assert.equal(typeof fn,'function');
process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE='meri-foundation-20260928';
process.env.DATABASE_URL='postgresql://invalid/NO_CONNECTION';
const base={target:'capiro-dev',fixtureNamespace:'meri-foundation-20260928',ctx:{role:'standard_user'},clientId:'11111111-1111-4111-8111-111111111111'};
for (const [command,confirmation] of [['preview-corpus-metadata','PREVIEW_EXACT_OWNED_MEMORY_METADATA'],['execute-corpus-metadata','RECONCILE_EXACT_OWNED_MEMORY_METADATA']]) {
  const input={...base,confirmation,...(command.startsWith('execute')?{expectedPlanSha256:'a'.repeat(64)}:{})};
  const args=[command,'--input-env','MERI_SYNTHETIC_READ_BUDGET_INPUT','--out','/tmp/not-written.json'];
  process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT=JSON.stringify(input);
  assert.deepEqual((await readSyntheticReadOperatorInput(args)).input,input);
  process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT=JSON.stringify({...input,fixtureReady:true});
  await assert.rejects(readSyntheticReadOperatorInput(args),/corpus_scope/);
}
console.log('OFFLINE_PACKAGED_C2_RECONCILIATION_PASS');
