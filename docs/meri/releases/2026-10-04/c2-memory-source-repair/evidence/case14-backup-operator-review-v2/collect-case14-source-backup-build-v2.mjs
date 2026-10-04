import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
process.env.PYTHONIOENCODING='utf-8';process.env.PYTHONUTF8='1';process.env.AWS_CLI_OUTPUT_ENCODING='UTF-8';
const parent='C:/dev/main/outputs/meri-c2-20261003',hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const [service,...extra]=process.argv.slice(2);assert.ok(['api','meriv2-orchestrator'].includes(service)&&!extra.length);
const candidate=read(parent+'/case14-memory-source-candidate-v1.json'), sha=candidate.sourceSha;
assert.match(sha,/^[a-f0-9]{40}$/);
assert.equal(hash(readFileSync(parent+'/case14-memory-source-qualification-v1.json')),candidate.sourceCheckpointSha256);
const root=parent+'/'+service+'-case14-source-build-v1';
const started=read(root+'/build-start.json');assert.equal(started.sourceSha,sha);
assert.equal(started.candidateSha256,hash(readFileSync(parent+'/case14-memory-source-candidate-v1.json')));
const preparation=parent+'/case14-backup-build-preparation-v2';
assert.equal(hash(readFileSync(preparation+'/template-checks.json')),candidate.templateChecksSha256);
const spec=read(preparation+'/template-checks.json').services[service];
assert.equal(started.buildspecSha256,spec.sha256);assert.equal(hash(readFileSync(root+'/buildspec.json')),spec.sha256);
if(existsSync(root+'/build-readback.json')){
  const cached=read(root+'/build-readback.json');
  assert.equal(cached.service,service);assert.equal(cached.sourceSha,sha);assert.equal(cached.buildId,started.buildId);
  assert.equal(cached.candidateSha256,started.candidateSha256);assert.equal(cached.checkpointSha256,candidate.sourceCheckpointSha256);
  assert.equal(cached.buildspecSha256,spec.sha256);assert.equal(cached.buildLogSha256,hash(readFileSync(root+'/build.log')));
  assert.ok(['IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS','FAILED'].includes(cached.qualification));
  if(cached.qualification==='IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS'){
    assert.equal(cached.status,'SUCCEEDED');assert.equal(cached.resolvedSourceSha,sha);
    assert.deepEqual(cached.passedMarkers,spec.requiredMarkers);
    const lines=readFileSync(root+'/build.log','utf8').split(/\r?\n/).map(line=>line.trim());
    for(const marker of spec.requiredMarkers)assert.ok(lines.includes(marker));
    assert.match(cached.image,new RegExp('^967807252336\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/capiro/dev/'+service+'@sha256:[a-f0-9]{64}$'));
    assert.ok(lines.includes('CANDIDATE_'+(service==='api'?'API':'ORCHESTRATOR')+'_IMAGE='+cached.image));
    if(service==='meriv2-orchestrator'){
      assert.ok(cached.tests.numPassedTests>=1570);assert.equal(cached.tests.numFailedTests,0);assert.equal(cached.tests.numPendingTests,2);assert.equal(cached.tests.numPassedTestSuites,130);assert.equal(cached.tests.numFailedTestSuites,0);
      const countLine=lines.find(line=>line.startsWith('ORCHESTRATOR_SOURCE_TEST_COUNTS='));assert.ok(countLine);
      assert.deepEqual(JSON.parse(countLine.split('=',2)[1]),cached.tests);
    }
  }
  console.log(JSON.stringify(cached));process.exit(cached.qualification==='FAILED'?1:0);
}
const b=aws(['codebuild','batch-get-builds','--ids',started.buildId]).builds?.[0];
assert.equal(b?.id,started.buildId);assert.equal(b.sourceVersion,sha);
if(b.buildStatus==='IN_PROGRESS'){console.log(JSON.stringify({service,status:b.buildStatus,phase:b.currentPhase,elapsedSeconds:Math.round((Date.now()-Date.parse(b.startTime))/1000)}));process.exit(0);}
let next,events=[],pages=0;
while(pages++<40){
  const args=['logs','get-log-events','--log-group-name',b.logs.groupName,'--log-stream-name',b.logs.streamName,'--start-from-head','--limit','10000'];if(next)args.push('--next-token',next);
  const response=aws(args);events.push(...response.events);if(response.nextForwardToken===next)break;next=response.nextForwardToken;
}
assert.ok(pages<40);const logs=events.map(e=>e.message).join('');
writeFileSync(root+'/build.log',logs,{flag:'wx'});
const record={service,status:b.buildStatus,qualification:'PENDING',sourceSha:sha,resolvedSourceSha:b.resolvedSourceVersion,buildId:b.id,startedAt:b.startTime,finishedAt:b.endTime,phases:b.phases.map(p=>({phase:p.phaseType,status:p.phaseStatus,durationSeconds:p.durationInSeconds,contexts:p.contexts})),buildspecSha256:spec.sha256,candidateSha256:started.candidateSha256,checkpointSha256:candidate.sourceCheckpointSha256,buildLogSha256:hash(logs),buildLogEvents:events.length,serviceMutations:0,databaseMutations:0,providerCalls:0};
try {
  assert.equal(b.buildStatus,'SUCCEEDED');assert.equal(b.resolvedSourceVersion,sha);
  assert.equal(b.projectName,'capiro-build-web-dev');assert.equal(b.source.location,'https://github.com/neo-capiro/capirov2.git');assert.equal(b.environment.type,'ARM_CONTAINER');assert.equal(b.environment.privilegedMode,true);
  assert.equal(hash(b.source.buildspec),spec.sha256);
  assert.deepEqual(b.environment.environmentVariables.filter(v=>v.name==='EXPECTED_SHA'),[{name:'EXPECTED_SHA',value:sha,type:'PLAINTEXT'}]);
  for(const marker of spec.requiredMarkers)assert.ok(logs.split(/\r?\n/).some(line=>line.trim()===marker),marker);
  if(service==='meriv2-orchestrator'){
    const match=logs.match(/^ORCHESTRATOR_SOURCE_TEST_COUNTS=(\{.*\})$/m);assert.ok(match);
    const counts=JSON.parse(match[1]);assert.ok(counts.numPassedTests>=1570);assert.equal(counts.numFailedTests,0);assert.equal(counts.numPendingTests,2);assert.equal(counts.numPassedTestSuites,130);assert.equal(counts.numFailedTestSuites,0);record.tests=counts;
  }
  const details=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids','imageTag='+sha]).imageDetails;
  assert.equal(details.length,1);assert.match(details[0].imageDigest,/^sha256:[a-f0-9]{64}$/);
  record.image='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/'+service+'@'+details[0].imageDigest;
  const label=service==='api'?'API':'ORCHESTRATOR';assert.ok(logs.split(/\r?\n/).some(line=>line.trim()==='CANDIDATE_'+label+'_IMAGE='+record.image));
  record.imagePublishedAt=details[0].imagePushedAt;record.architecture='arm64';record.runtimeNode=service==='api'?'22.23.3':'20.16.0';record.passedMarkers=spec.requiredMarkers;record.qualification='IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS';
} catch(error) {record.qualification='FAILED';record.failure=String(error.message).slice(0,1600);process.exitCode=1;}
writeFileSync(root+'/build-readback.json',JSON.stringify(record,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(record));
if(record.qualification==='FAILED')console.log(logs.split(/\r?\n/).slice(-45).join('\n'));
