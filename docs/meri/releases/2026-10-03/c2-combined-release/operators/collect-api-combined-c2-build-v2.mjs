import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
process.env.PYTHONIOENCODING='utf-8';
process.env.PYTHONUTF8='1';
process.env.AWS_CLI_OUTPUT_ENCODING='UTF-8';
const [service]=process.argv.slice(2);
assert.equal(service,'api');
const candidate=JSON.parse(readFileSync('C:/dev/main/outputs/meri-c2-20261003/combined-c2-candidate-v1.json','utf8'));
const sha=candidate.sourceSha;
if(!/^[a-f0-9]{40}$/.test(sha)||candidate.case20CheckpointSha256!=='c9bf23e861e8a41b8b18d2a944e83178b12fdd875bb503becf194b44f3f42a21')throw new Error('CANDIDATE_BINDING_REQUIRED');
const root=`C:/dev/main/outputs/meri-c2-20261003/${service}-combined-c2-build-v2`;
if(existsSync(root+'/build-readback.json')){console.log(readFileSync(root+'/build-readback.json','utf8'));process.exit(0);}
const started=JSON.parse(readFileSync(root+'/build-start.json','utf8'));
assert.equal(started.sourceSha,sha);
assert.equal(started.buildspecSha256,({api:'cf24c5952b4bb2e458935d6678c26982d61677e6537d48798fe92fa4aad60b5f','meriv2-orchestrator':'67617283cc66959285174b78493e95b7d491bbfcb916b8592eb0980fd0aa3e0b','web-vnext':'604d019ef9b54936de5cf7d9a5fb46f878d998b19549b2257de4a842edef9899'})[service]);
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
  const scope=JSON.parse(readFileSync('C:/dev/main/outputs/meri-c2-20261003/combined-c2-build-preparation-v1/build-scope.template.json'));
  const markers=[...scope.services[service].requiredBaselineMarkers,...scope.services[service].requiredAdditionalMarkers];
  assert.equal(b.projectName,'capiro-build-web-dev');assert.equal(b.source.location,'https://github.com/neo-capiro/capirov2.git');
  assert.equal(b.environment.type,'ARM_CONTAINER');assert.equal(b.environment.privilegedMode,true);
  assert.equal(createHash('sha256').update(b.source.buildspec).digest('hex'),started.buildspecSha256);
  assert.deepEqual(b.environment.environmentVariables.filter(x=>x.name==='EXPECTED_SHA'),[{name:'EXPECTED_SHA',value:sha,type:'PLAINTEXT'}]);
  for(const marker of markers)assert.ok(logs.split(/\r?\n/).some(line=>line.trim()===marker),marker);
  if(service==='meriv2-orchestrator'){
    const match=logs.match(/^ORCHESTRATOR_SOURCE_TEST_COUNTS=(\{.*\})$/m);assert.ok(match,'SOURCE_TEST_COUNTS');
    const counts=JSON.parse(match[1]);assert.ok(counts.numPassedTests>=1564);assert.equal(counts.numFailedTests,0);assert.equal(counts.numPendingTests,2);assert.equal(counts.numPassedTestSuites,130);assert.equal(counts.numFailedTestSuites,0);record.tests=counts;
  }
  const details=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids','imageTag='+sha]).imageDetails;
  assert.equal(details.length,1);assert.match(details[0].imageDigest,/^sha256:[a-f0-9]{64}$/);
  record.image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/'+service+'@'+details[0].imageDigest;
  assert.ok(logs.split(/\r?\n/).some(line=>line.trim()==='CANDIDATE_'+({api:'API','meriv2-orchestrator':'ORCHESTRATOR','web-vnext':'WEB'})[service]+'_IMAGE='+record.image),'EXACT_LOG_IMAGE');
  record.imagePublishedAt=details[0].imagePushedAt;record.architecture='arm64';record.runtimeNode=service==='api'?'22.23.3':service==='meriv2-orchestrator'?'20.16.0':'BUILD_LOG';record.passedMarkers=markers;
  record.qualification='IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS';
} catch(error) {
  record.qualification='FAILED';record.failure=String(error.message).slice(0,1600);process.exitCode=1;
}
writeFileSync(root+'/build-readback.json',JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(record,null,2));
if(record.qualification==='FAILED')console.log(logs.split(/\r?\n/).slice(-55).join('\n'));
