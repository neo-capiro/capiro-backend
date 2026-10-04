import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {taskInput} from '../../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
import {hash,stableHash,PIN,qualifySdk,proposedEnvelope} from './qualifier.mjs';
const root=fileURLToPath(new URL('.',import.meta.url)),parent='C:/dev/main/outputs/meri-c2-20261003',sdkRoot=parent+'/case14-sdk-read-v1';
const read=f=>readFileSync(sdkRoot+'/'+f),json=f=>JSON.parse(read(f));
export const packet={sdkBytes:read('sdk-readback.json'),result:json('result.json'),cleanup:json('cleanup.json'),start:json('task-start.json'),
 registered:json('definition-registered.json'),intent:json('intent.json'),transport:json('readback-transport.json'),definition:json('definition-input.private.json'),
 registration:json('registration-owner.json'),request:json('task-input.private.json'),journalPreserved:json('journal-preserved.json'),
 innerBytes:readFileSync(parent+'/case14-sdk-read-inner-v1.mjs'),outerBytes:readFileSync(parent+'/run-case14-sdk-read-v1.mjs'),
 journalBytes:readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')};
export function normalizeDefinition(v){const input=taskInput(structuredClone(v));input.enableFaultInjection??=false;input.placementConstraints??=[];input.volumes??=[];
 input.tags=(input.tags??[]).sort((a,b)=>a.key.localeCompare(b.key));for(const c of input.containerDefinitions){c.cpu??=0;
 for(const k of ['mountPoints','portMappings','systemControls','volumesFrom'])c[k]??=[];for(const k of ['environment','secrets'])if(c[k])c[k].sort((a,b)=>a.name.localeCompare(b.name));}return input;}
const qualification=qualifySdk(packet,normalizeDefinition),tests=[];
for(const [name,mutate]of [
 ['wrong task cleanup',p=>p.cleanup.taskArn=p.cleanup.taskArn+'x'],['active definition',p=>p.cleanup.status='ACTIVE'],
 ['cleanup error',p=>p.cleanup.cleanupErrors.push({action:'STOP_TASK'})],['incomplete stop',p=>p.cleanup.taskStopped=false],
 ['altered framed bytes',p=>p.result.receipts[1].data=Buffer.from('{}').toString('base64')],
 ['copied receipt extra frame',p=>p.result.receipts.push(p.result.receipts[0])],
 ['provider secret restored',p=>p.definition.containerDefinitions[0].secrets=[{name:'OPENAI_API_KEY',valueFrom:'not-real'}]],
 ['workload role restored',p=>p.definition.taskRoleArn='not-real'],['extra launch',p=>p.request.count=2],
 ['different registered identity',p=>p.registered.taskDefinition+='x'],['different inner source',p=>p.innerBytes=Buffer.from('changed')],
 ['journal drift',p=>p.journalBytes=Buffer.concat([p.journalBytes,Buffer.from('\n')])],['late observations',p=>p.cleanup.at='2026-10-04T05:00:00.000Z'],
 ['registration marker changed',p=>p.registration.registrationMarker='wrong']]){
 const changed={...structuredClone(packet),sdkBytes:Buffer.from(packet.sdkBytes),innerBytes:Buffer.from(packet.innerBytes),outerBytes:Buffer.from(packet.outerBytes),journalBytes:Buffer.from(packet.journalBytes)};
 mutate(changed);assert.throws(()=>qualifySdk(changed,normalizeDefinition));tests.push('reject '+name);
}
const priceBytes=readFileSync(parent+'/case14-embedding-prices-v1.json'),prices=JSON.parse(priceBytes);
const envelope=proposedEnvelope(prices,qualification.sdk,{windowMs:900000,concurrentScheduledProjectionTasks:0});
assert.equal(envelope.provisionalPriceArithmeticMicros,16);assert.equal(envelope.approvalEnvelopeMicros+envelope.recallCeilingMicros,envelope.combinedHoldMicros);
assert.equal(envelope.approvalActualCostMicros,null);assert.equal(envelope.approvalEnvelopeRefundAllowed,false);tests.push('price arithmetic and conservative classification');
assert.throws(()=>proposedEnvelope(prices,qualification.sdk,{windowMs:900001,concurrentScheduledProjectionTasks:0}));tests.push('reject widened window');
assert.throws(()=>proposedEnvelope(prices,qualification.sdk,{windowMs:900000,concurrentScheduledProjectionTasks:1}));tests.push('reject concurrent projection writer');
const changedPrice=structuredClone(prices);changedPrice.aws.products[0].product.attributes.feature='BatchInference';
assert.throws(()=>proposedEnvelope(changedPrice,qualification.sdk,{windowMs:900000,concurrentScheduledProjectionTasks:0}));tests.push('reject batch price substitution');
const repository='C:/dev/main/meri-c1-20261002';
const paths=['apps/api/src/memory/memory.module.ts','apps/api/src/memory/memory-candidate-review.service.ts',
 'apps/api/src/memory/settings-aware-memory-candidate.service.ts','apps/api/src/memory/memory-candidate.service.ts',
 'apps/api/src/memory/memory-canonical-activation.helpers.ts','apps/api/src/memory/governed-memory-ingest.service.ts',
 'apps/api/src/memory/exact-memory-cleanup-outbox.service.ts','apps/api/src/memory/strict-memory-projector.service.ts',
 'apps/api/src/memory/exact-memory-projection-worker.service.ts','apps/api/src/memory/memory-embedding-lifecycle.ts',
 'apps/api/src/embeddings/embedder.ts','apps/api/src/embeddings/titan-embedding.provider.ts','apps/api/src/memory/memory-ingest.service.ts',
 'apps/api/scripts/refresh-memory-graph.ts','apps/api/src/memory/memory-clio-adapter.helpers.ts'];
const sourcePins=paths.map(path=>{const bytes=execFileSync('git',['show',PIN.sourceSha+':'+path],{cwd:repository,maxBuffer:1024*1024});
 assert.equal(hash(readFileSync(repository+'/'+path)),hash(bytes),'SOURCE_DRIFT '+path);return{path,sha256:hash(bytes),gitObject:execFileSync('git',['rev-parse',PIN.sourceSha+':'+path],{cwd:repository,encoding:'utf8'}).trim()};});
const evidenceFiles=['sdk-readback.json','result.json','cleanup.json','task-start.json','definition-registered.json','intent.json','readback-transport.json',
 'definition-input.private.json','registration-owner.json','task-input.private.json','journal-preserved.json','log-transport-pages.json'];
const report={kind:'case14-approval-cost-codex-supervision',version:2,preparedBy:'Codex',observedAt:new Date().toISOString(),sdkQualification:qualification,
 evidenceFiles:evidenceFiles.map(path=>({path:sdkRoot+'/'+path,sha256:hash(read(path))})),sourcePins,priceEvidence:{path:parent+'/case14-embedding-prices-v1.json',sha256:hash(priceBytes),status:'RETAINED_PRICES_ONLY_NO_REFRESH'},
 envelope,tests:{status:'PASS',count:tests.length,checks:tests},liveApproval:'NOT_RUN',liveAdmission:false,journalMutations:0,providerCalls:0,databaseCalls:0,
 prerequisitesNotYetProved:envelope.prerequisites,sourceProofLimitations:['No fresh AWS re-observation by this qualifier','No runtime OpenAI fetch implementation/version or redirect dispatch bound in SDK readback','Proposed serialized-byte token ceiling needs explicit unit-contract review;16micros is provisional arithmetic, not billed actual','Current readonly SDK result does not prove projection completion for the still-pending candidate']};
writeFileSync(root+'qualification.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'PASS_RETAINED_SDK_AND_LOCAL_TESTS',tests:tests.length,reportSha256:hash(readFileSync(root+'qualification.json')),liveAdmission:false}));
