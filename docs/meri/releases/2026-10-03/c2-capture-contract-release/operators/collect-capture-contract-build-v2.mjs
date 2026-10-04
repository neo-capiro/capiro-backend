import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
process.env.PYTHONIOENCODING='utf-8';
process.env.PYTHONUTF8='1';
process.env.AWS_CLI_OUTPUT_ENCODING='UTF-8';
const [service]=process.argv.slice(2);
assert.ok(['api','meriv2-orchestrator'].includes(service));
const candidate=JSON.parse(readFileSync('C:/dev/main/outputs/meri-c2-20261003/capture-contract-candidate.json','utf8'));
const sha=candidate.sourceSha;
if(!/^[a-f0-9]{40}$/.test(sha)||candidate.followupCheckpointSha256!=='b7de9e4633f59a4106e94adfeb775daecb1c0a0bf7d94bf83c56dc7f45cb65b6')throw new Error('CANDIDATE_BINDING_REQUIRED');
const root=`C:/dev/main/outputs/meri-c2-20261003/${service}-capture-contract-build-v2`;
if(existsSync(root+'/build-readback.json')){console.log(readFileSync(root+'/build-readback.json','utf8'));process.exit(0);}
const started=JSON.parse(readFileSync(root+'/build-start.json','utf8'));
assert.equal(started.sourceSha,sha);
assert.equal(started.buildspecSha256,service==='api'?'61cc399b632b885b2c17dfb692a536ba493246465573fb83469669c6267e2811':'eb741a51f6169fdca94e6a3d69ab5bfa18ef0f22098016518e8dc30120aa8a24');
assert.equal(createHash('sha256').update(readFileSync(root+'/buildspec.yml')).digest('hex'),started.buildspecSha256);
const b=aws(['codebuild','batch-get-builds','--ids',started.buildId]).builds?.[0];
assert.equal(b?.id,started.buildId);assert.equal(b.sourceVersion,sha);
if(b.buildStatus==='IN_PROGRESS'){console.log(JSON.stringify({service,status:b.buildStatus,phase:b.currentPhase,elapsedSeconds:Math.round((Date.now()-Date.parse(b.startTime))/1000)}));process.exit(0);}
let next,events=[],pages=0;
while(pages++<40){
  const args=['logs','get-log-events','--log-group-name',b.logs.groupName,'--log-stream-name',b.logs.streamName,'--start-from-head','--limit','10000'];
  if(next)args.push('--next-token',next);
  const r=aws(args);events.push(...r.events);if(r.nextForwardToken===next)break;next=r.nextForwardToken;
}
assert.ok(pages<40);
const logs=events.map(e=>e.message).join('');
writeFileSync(root+'/build.log',logs,{flag:'wx'});
const record={service,status:b.buildStatus,qualification:'PENDING',sourceSha:sha,resolvedSourceSha:b.resolvedSourceVersion,buildId:b.id,startedAt:b.startTime,finishedAt:b.endTime,
  phases:b.phases.map(p=>({phase:p.phaseType,status:p.phaseStatus,durationSeconds:p.durationInSeconds,contexts:p.contexts})),
  buildspecSha256:started.buildspecSha256,buildLogSha256:createHash('sha256').update(logs).digest('hex'),buildLogEvents:events.length,serviceMutations:0,databaseMutations:0,providerCalls:0};
try {
  assert.equal(b.buildStatus,'SUCCEEDED');assert.equal(b.resolvedSourceVersion,sha);
  const markers=service==='api'?['OFFLINE_RUNTIME_IMPORT_PASS','OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS','OFFLINE_CASE01_CONTINUATION_IMPORT_PASS','OFFLINE_CASE01_POSTAPPROVAL_IMPORT_PASS','OFFLINE_CASE01_POSTSEED_IMPORT_PASS','EXACT_452_IMAGE_MIGRATION_HASHES_PASS','MAIL_ACTIVE_OWNER_INDEX_MIGRATION_PACKAGE_PASS','OFFLINE_PACKAGED_C2_MEMORY_PASS','OFFLINE_PACKAGED_C2_RECONCILIATION_PASS','OFFLINE_PACKAGED_C2_TERMINAL_LIFECYCLE_PASS','OFFLINE_PACKAGED_C2_TS_SOURCE_IMPORT_PASS','OFFLINE_PACKAGED_SEMANTIC_CLOCK_API_CORE_PASS','OFFLINE_PACKAGED_CAPTURE_RECEIPT_CONTRACT_PASS','OFFLINE_PACKAGED_CAPTURE_PROVIDER_API_GUARDS_PASS','LOCAL_REPODIGEST_ECR_MATCH_PASS']:
    ['ORCHESTRATOR_CAPTURE_CONTRACT_LOOPBACK_TESTS_PASS','OFFLINE_PACKAGED_ENTRYPOINT_HEALTH_AUTH_PASS','OFFLINE_C1_CLASSIFICATION_REPAIRS_PASS','OFFLINE_PACKAGED_MAIL_DEFAULTS_PASS','OFFLINE_PACKAGED_NO_TOOLS_DIRECTIVE_PASS','OFFLINE_PACKAGED_SEMANTIC_CLOCK_ORCHESTRATOR_PASS','OFFLINE_PACKAGED_CAPTURE_PROVIDER_ORCHESTRATOR_GUARDS_PASS','LOCAL_REPODIGEST_ECR_MATCH_PASS'];
  for(const marker of markers)assert.ok(logs.split(/\r?\n/).some(line=>line.trim()===marker),marker);
  if(service==='meriv2-orchestrator'){
    const match=logs.match(/^ORCHESTRATOR_SOURCE_TEST_COUNTS=(\{.*\})$/m);assert.ok(match,'SOURCE_TEST_COUNTS');
    const counts=JSON.parse(match[1]);assert.ok(counts.numPassedTests>=1564);assert.equal(counts.numFailedTests,0);assert.equal(counts.numPendingTests,2);assert.equal(counts.numPassedTestSuites,130);assert.equal(counts.numFailedTestSuites,0);record.tests=counts;
  }
  const details=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids','imageTag='+sha]).imageDetails;
  assert.equal(details.length,1);assert.match(details[0].imageDigest,/^sha256:[a-f0-9]{64}$/);
  record.image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/'+service+'@'+details[0].imageDigest;
  assert.ok(logs.split(/\r?\n/).some(line=>line.trim()==='CANDIDATE_'+(service==='api'?'API':'ORCHESTRATOR')+'_IMAGE='+record.image),'EXACT_LOG_IMAGE');
  record.imagePublishedAt=details[0].imagePushedAt;record.architecture='arm64';record.runtimeNode=service==='api'?'22.23.3':'20.16.0';record.passedMarkers=markers;
  record.qualification='IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS';
} catch(error) {
  record.qualification='FAILED';record.failure=String(error.message).slice(0,1600);process.exitCode=1;
}
writeFileSync(root+'/build-readback.json',JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(record,null,2));
if(record.qualification==='FAILED')console.log(logs.split(/\r?\n/).slice(-55).join('\n'));
