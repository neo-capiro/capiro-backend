import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {cleanupCase01MemoryProjectionsInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs';
import {cleanupCase01ProjectionsInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-projection-cleanup.mjs';
import {cleanupSyntheticMemoryProjections,readSyntheticReadOperatorInput} from '/app/apps/api/scripts/meri-synthetic-read-budget.mjs';
const require=createRequire(import.meta.url);
const {embedMemoryItem,memoryEmbeddingEligibilitySql}=require('./dist/memory/memory-embedding-lifecycle.js');
const {completeExactOwnedTerminalCleanupInTx,deleteTerminalMemoryProjectionsInTx}=require('./dist/memory/memory-terminal-cleanup.helpers.js');
for (const fn of [cleanupCase01MemoryProjectionsInTx,cleanupCase01ProjectionsInTx,cleanupSyntheticMemoryProjections,embedMemoryItem,completeExactOwnedTerminalCleanupInTx,deleteTerminalMemoryProjectionsInTx]) assert.equal(typeof fn,'function');
assert.match(memoryEmbeddingEligibilitySql(),/clock_timestamp/);
let preflights=0;
assert.equal(await embedMemoryItem({withSystem:async fn=>fn({$queryRawUnsafe:async()=>{preflights++;return [];}})},
  {tenantId:'11111111-1111-4111-8111-111111111111',sourceId:'22222222-2222-4222-8222-222222222222',text:'Synthetic',bypassRls:true,sourceContent:{title:'Synthetic',sections:[]}},
  {embed:async()=>{throw new Error('Ineligible source must not call provider');},dimensions:2,model:'local'}),'skipped');
assert.equal(preflights,1);
process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE='meri-foundation-20260928';
process.env.DATABASE_URL='postgresql://invalid/NO_CONNECTION';
const base={target:'capiro-dev',fixtureNamespace:'meri-foundation-20260928',ctx:{role:'standard_user'},clientId:'11111111-1111-4111-8111-111111111111'};
for(const [command,confirmation] of [['preview-corpus-projections','PREVIEW_EXACT_OWNED_MEMORY_PROJECTIONS'],['execute-corpus-projections','CLEAN_EXACT_OWNED_MEMORY_PROJECTIONS']]){
  const input={...base,confirmation,...(command.startsWith('execute')?{expectedPlanSha256:'a'.repeat(64)}:{})};
  const args=[command,'--input-env','MERI_SYNTHETIC_READ_BUDGET_INPUT','--out','/tmp/not-written.json'];
  process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT=JSON.stringify(input);
  assert.deepEqual((await readSyntheticReadOperatorInput(args)).input,input);
  process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT=JSON.stringify({...input,ids:['caller-selected']});
  await assert.rejects(readSyntheticReadOperatorInput(args),/corpus_scope/);
}
assert.ok(readFileSync('./scripts/entrypoint-dispatcher.inc','utf8').includes('refresh-memory-graph) shift; exec ./node_modules/.bin/tsx scripts/refresh-memory-graph.ts'));
console.log('OFFLINE_PACKAGED_C2_TERMINAL_LIFECYCLE_PASS');
