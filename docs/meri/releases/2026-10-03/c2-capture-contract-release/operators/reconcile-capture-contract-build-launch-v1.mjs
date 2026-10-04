import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const events=aws(['cloudtrail','lookup-events','--lookup-attributes','AttributeKey=EventName,AttributeValue=StartBuild','--start-time','2026-10-03T23:41:00Z']).Events.map(row=>JSON.parse(row.CloudTrailEvent)).filter(e=>e.requestParameters?.sourceVersion==='4f0253874357c272fda1ae2a5271ee4af645f0bc'&&e.userIdentity?.arn==='arn:aws:iam::967807252336:user/capirocli').sort((a,b)=>a.eventTime.localeCompare(b.eventTime));
assert.equal(events.length,2);
const records=[];
for(const [index,service] of ['api','meriv2-orchestrator'].entries()){
  const e=events[index],path=root+'/'+service+'-capture-contract-build-v1';
  const bytes=readFileSync(path+'/launch-intent.json'),intent=JSON.parse(bytes);
  assert.equal(e.requestParameters.projectName,'capiro-build-web-dev');
  assert.equal(e.errorCode,'InvalidInputException');assert.equal(e.errorMessage,'Max buildspec length is 25600');assert.equal(e.responseElements,null);
  assert.ok(Math.abs(Date.parse(intent.recordedAt)-Date.parse(e.eventTime))<10000);
  const record={status:'DEFINITE_SERVICE_REJECTION_NO_BUILD_STARTED',service,sourceSha:intent.sourceSha,eventTime:e.eventTime,eventId:e.eventID,requestId:e.requestID,errorCode:e.errorCode,errorMessage:e.errorMessage,responseElements:null,intentSha256:createHash('sha256').update(bytes).digest('hex'),requestSha256:intent.requestSha256,oldBuildspecSha256:intent.buildspecSha256,scope:'A new bounded build may use the same source after lossless inline buildspec compaction and review. No replay of the rejected request.'};
  writeFileSync(path+'/start-reconciliation.json',JSON.stringify(record,null,2)+'\n',{flag:'wx'});records.push(record);
}
console.log(JSON.stringify(records,null,2));
