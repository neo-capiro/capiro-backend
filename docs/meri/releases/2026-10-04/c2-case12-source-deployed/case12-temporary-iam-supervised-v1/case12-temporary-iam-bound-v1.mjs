import assert from 'node:assert/strict';
import {readFileSync,existsSync,openSync,writeFileSync,fsyncSync,closeSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {aws} from '../../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from '../aws-single-attempt.mjs';
import {releaseOperator} from '../../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';

// Root must bind the exact human-reviewed packet before use. No environment/CLI override.
const REVIEWED_PACKET_SHA256='781b944fee40f504c744dda2f609f0f63446b9693dd2cdb661ecde756f749fc2';
const ROOT='C:/dev/main/outputs/meri-c2-20261003';
const REPO='C:/dev/main/meri-c1-20261002';
const OUT=ROOT+'/case12-temporary-iam-supervised-v1/executed-once';
const ARC='docs/meri/releases/2026-10-04/c2-case12-source-release/';
const ROLE='arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ';
const NAME='MeriCase12NativeSetupReads20261004';
const POLICY_SHA='173d4b8f134c2d1fac50b9df7d3db6e4e136f1e965c293a258cee6407da50d3a';
const QUALIFICATION_SHA='b303465cf34f4c42567fb772f3ad21e0457146ae04ca0601c8a22fd72028ef9e';
const PRIOR_SHA='4942f24c68fb402805de768d9c7f6f63a4a09152d0d61571a5e0adc6b9b485d4';
const rawSha=b=>createHash('sha256').update(b).digest('hex');
const durable=(name,value)=>{const fd=openSync(OUT+'/'+name,'wx');try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const parse=p=>JSON.parse(readFileSync(p));
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));

export function validateBoundary(packet,approval,qualification,prior,policy,mode,now,expectedPacket){
  assert.ok(['apply','remove'].includes(mode));assert.match(expectedPacket??'',/^[a-f0-9]{64}$/u);
  assert.equal(fingerprint(packet),expectedPacket);assert.equal(packet.kind,'C2 Case12 source release and separate temporary IAM review packet');assert.equal(packet.version,1);
  assert.equal(packet.qualificationSha256,fingerprint(qualification));assert.equal(packet.qualificationBytesSha256,QUALIFICATION_SHA);
  assert.equal(qualification.sourceSha,'e60f37189f8c9b68ab7d5ef66e515ed3be4ec3c1');assert.equal(qualification.iamProposal.applied,false);assert.equal(qualification.iamProposal.approval,null);
  assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_CASE12_RELEASE_AND_TEMPORARY_IAM');assert.equal(approval.packetSha256,expectedPacket);assert.equal(typeof approval.reviewer,'string');assert.ok(approval.reviewer.trim());
  assert.ok(iso(packet.preparedAt)&&iso(packet.expiresAt)&&iso(approval.approvedAt));assert.ok(Date.parse(packet.preparedAt)<=Date.parse(approval.approvedAt)&&Date.parse(approval.approvedAt)<=Date.parse(packet.expiresAt)&&Date.parse(approval.approvedAt)<=now);
  const iam=packet.temporaryIam;
  assert.equal(iam.roleArn,ROLE);assert.equal(iam.policyName,NAME);assert.equal(iam.policySha256,POLICY_SHA);assert.equal(iam.expiresAt,qualification.iamProposal.expiresAt);
  assert.equal(qualification.iamProposal.roleArn,ROLE);assert.equal(qualification.iamProposal.policyName,NAME);assert.equal(qualification.iamProposal.policySha256,POLICY_SHA);
  assert.deepEqual(iam.policyDocument,policy);assert.deepEqual(approval.temporaryIam,{roleArn:ROLE,policyName:NAME,policySha256:POLICY_SHA,expiresAt:iam.expiresAt});
  assert.equal(prior.roleArn,ROLE);assert.equal(prior.inlinePolicies.length,11);assert.equal(new Set(prior.inlinePolicies.map(p=>p.name)).size,11);assert.ok(!prior.inlinePolicies.some(p=>p.name===NAME));assert.deepEqual(prior.attachedPolicies,[]);
  assert.equal(iam.originalInlinePolicyCount,11);assert.deepEqual(iam.originalAttachedPolicies,[]);
  assert.ok(iso(iam.expiresAt));if(mode==='apply'){assert.ok(now<Date.parse(packet.expiresAt),'APPROVAL_PACKET_EXPIRED');assert.ok(now<Date.parse(iam.expiresAt),'IAM_PERMISSION_WINDOW_EXPIRED');}
  assert.equal(policy.Version,'2012-10-17');assert.equal(policy.Statement.length,2);
  assert.deepEqual(policy.Statement.map(s=>s.Action),['ecs:DescribeTasks','ecs:DescribeTaskDefinition']);
  assert.ok(policy.Statement.every(s=>s.Effect==='Allow'&&s.Condition.DateLessThan['aws:CurrentTime']===iam.expiresAt));
  assert.deepEqual(packet.services.map(s=>s.service),['api','meriv2-orchestrator']);
  for(const s of packet.services){assert.equal(s.candidate.sourceSha,qualification.sourceSha);assert.equal(s.candidate.image,qualification.candidates[s.service].image);}
  return {roleName:ROLE.split('/').at(-1),policyFingerprint:fingerprint(policy),packetFingerprint:expectedPacket};
}
function load(mode){
  assert.match(REVIEWED_PACKET_SHA256??'',/^[a-f0-9]{64}$/u,'EXACT_HUMAN_REVIEWED_PACKET_NOT_BOUND');
  const packet=parse(ROOT+'/case12-source-release-packet-v1.json'),approval=parse(ROOT+'/case12-release-human-approval.json');
  assert.match(packet.evidenceCommit??'',/^[a-f0-9]{40}$/u);
  const versioned=name=>execFileSync('git',['show',packet.evidenceCommit+':'+ARC+name],{cwd:REPO,windowsHide:true,maxBuffer:4*1024*1024});
  const qbytes=versioned('release-qualification.json'),pbytes=versioned('case12-native-iam-preflight-v1.json'),policyBytes=versioned('case12-native-iam-policy-candidate-v1.json');
  assert.equal(rawSha(qbytes),QUALIFICATION_SHA);assert.equal(rawSha(pbytes),PRIOR_SHA);assert.equal(rawSha(policyBytes),POLICY_SHA);
  const qualification=JSON.parse(qbytes),prior=JSON.parse(pbytes),policy=JSON.parse(policyBytes);
  const checked=validateBoundary(packet,approval,qualification,prior,policy,mode,Date.now(),REVIEWED_PACKET_SHA256);
  return {packet,approval,qualification,prior,policy,checked};
}
export function inspectRoleReadback(names,attached,policies,prior,temporary,expectedPolicyFingerprint){
  assert.ok(!names.IsTruncated&&!names.Marker&&!names.NextToken);assert.ok(!attached.IsTruncated&&!attached.Marker&&!attached.NextToken);
  assert.deepEqual(attached.AttachedPolicies,[]);assert.ok(Array.isArray(names.PolicyNames));assert.equal(new Set(names.PolicyNames).size,names.PolicyNames.length);
  const expected=prior.inlinePolicies.map(p=>p.name).concat(temporary?[NAME]:[]).sort();assert.deepEqual([...names.PolicyNames].sort(),expected);
  for(const p of prior.inlinePolicies){assert.ok(policies[p.name]);assert.equal(fingerprint(policies[p.name]),p.policySha256);}
  if(temporary)assert.equal(fingerprint(policies[NAME]),expectedPolicyFingerprint);
  return {originalInlinePolicyCount:11,attachedPolicyCount:0,temporaryPresent:temporary,originalsUnchanged:true};
}
export async function runTemporaryIam(mode){
  assert.equal(arguments.length,1);const b=load(mode);
  if(mode==='apply')mkdirSync(OUT);else assert.ok(existsSync(OUT+'/apply-intent.json'),'OWN_APPLY_INTENT_REQUIRED');
  let serial=0;const phase=mode+'-'+Date.now();
  const read=args=>{const value=aws(args);durable(phase+'-read-'+String(++serial).padStart(3,'0')+'.private.json',{at:new Date().toISOString(),args,value});return value;};
  const who=read(['sts','get-caller-identity']);assert.equal(who.Account,'967807252336');assert.equal(who.Arn,'arn:aws:iam::967807252336:user/capirocli');
  const role=()=>{
    const names=read(['iam','list-role-policies','--role-name',b.checked.roleName,'--no-paginate']);assert.ok(Array.isArray(names.PolicyNames));assert.ok(!names.IsTruncated&&!names.Marker&&!names.NextToken);assert.ok(names.PolicyNames.length<=12);
    const attached=read(['iam','list-attached-role-policies','--role-name',b.checked.roleName,'--no-paginate']);
    const policies={};for(const name of names.PolicyNames){assert.ok(b.prior.inlinePolicies.some(p=>p.name===name)||name===NAME);const r=read(['iam','get-role-policy','--role-name',b.checked.roleName,'--policy-name',name]);assert.equal(r.RoleName,b.checked.roleName);assert.equal(r.PolicyName,name);policies[name]=r.PolicyDocument;}
    const present=names.PolicyNames.includes(NAME);return inspectRoleReadback(names,attached,policies,b.prior,present,b.checked.policyFingerprint);
  };
  const before=role();
  if(mode==='apply'){
    assert.equal(before.temporaryPresent,false,'NAMED_POLICY_ALREADY_EXISTS');
    const release=releaseOperator({aws:read});
    for(const expected of b.packet.services){
      const live=await release.snapshot(expected.service);
      assert.equal(live.baseline.imageDigest,expected.candidate.image.split('@')[1]);assert.equal(live.baseline.configHash,expected.baseline.configHash);assert.equal(live.baseline.desiredCount,expected.baseline.desiredCount);
      assert.equal(fingerprint(taskInput(live.task)),expected.candidateTaskSha256);
      const c=live.task.containerDefinitions.find(c=>c.name===expected.service);assert.equal(c.image,expected.candidate.image);assert.equal(c.environment.find(e=>e.name==='RELEASE_SHA')?.value,expected.candidate.sourceSha);
      if(expected.service==='api')assert.equal(live.task.taskRoleArn,ROLE);
      durable('promoted-'+expected.service+'-snapshot.private.json',live);
    }
    // Re-read the fixed binding and originals immediately before the sole mutation.
    const current=load('apply');assert.deepEqual(current,b);assert.equal(role().temporaryPresent,false);
    validateBoundary(b.packet,b.approval,b.qualification,b.prior,b.policy,'apply',Date.now(),REVIEWED_PACKET_SHA256);
    const policyJson=JSON.stringify(b.policy);assert.ok(2*policyJson.length+4096<32767,'WINDOWS_COMMAND_BOUND');
    const intent={at:new Date().toISOString(),packetSha256:b.checked.packetFingerprint,approvalSha256:fingerprint(b.approval),roleArn:ROLE,policyName:NAME,policyBytesSha256:POLICY_SHA,policyFingerprint:b.checked.policyFingerprint,expiresAt:b.packet.temporaryIam.expiresAt,originalsSha256:fingerprint(b.prior),singleAttempt:true};
    durable('apply-intent.json',intent);
    let acknowledgement='JSON_RESPONSE';try{awsSingleAttempt(['iam','put-role-policy','--role-name',b.checked.roleName,'--policy-name',NAME,'--policy-document',policyJson]);}catch{acknowledgement='UNKNOWN_ACK_REQUIRES_READBACK';}
    durable('apply-dispatch.json',{at:new Date().toISOString(),acknowledgement,retryAllowed:false,note:'Existing single-attempt wrapper parses JSON; ordinary IAM empty output is also an unknown acknowledgement.'});
    let after;try{after=role();}catch(error){durable('apply-unresolved.json',{at:new Date().toISOString(),status:'RECONCILIATION_REQUIRED_NO_RETRY',errorClass:error?.name??'Error'});throw error;}
    assert.equal(after.temporaryPresent,true,'PUT_OUTCOME_UNRESOLVED_NO_RETRY');durable('apply-readback.json',{at:new Date().toISOString(),status:'EXACT_POLICY_PRESENT_ORIGINALS_UNCHANGED',acknowledgement,...after,packetSha256:b.checked.packetFingerprint,actualHelperAccess:'NOT_PROVEN'});
  }else{
    const intent=parse(OUT+'/apply-intent.json');assert.equal(intent.packetSha256,b.checked.packetFingerprint);assert.equal(intent.approvalSha256,fingerprint(b.approval));assert.equal(intent.roleArn,ROLE);assert.equal(intent.policyName,NAME);assert.equal(intent.policyBytesSha256,POLICY_SHA);assert.equal(intent.policyFingerprint,b.checked.policyFingerprint);assert.equal(intent.originalsSha256,fingerprint(b.prior));
    if(!before.temporaryPresent){durable(phase+'-remove-readback.json',{at:new Date().toISOString(),status:'NAMED_POLICY_ABSENT_ORIGINALS_UNCHANGED',...before,mutationPerformed:false});return;}
    // A prior delete acknowledgement failure permits reads only, never another delete.
    assert.ok(!existsSync(OUT+'/remove-intent.json'),'REMOVE_OUTCOME_REQUIRES_READ_ONLY_RECONCILIATION_NO_RETRY');
    durable('remove-intent.json',{at:new Date().toISOString(),packetSha256:b.checked.packetFingerprint,roleArn:ROLE,policyName:NAME,policyFingerprint:b.checked.policyFingerprint,applyIntentSha256:fingerprint(intent),singleAttempt:true,allowedAfterExpiry:true});
    let acknowledgement='JSON_RESPONSE';try{awsSingleAttempt(['iam','delete-role-policy','--role-name',b.checked.roleName,'--policy-name',NAME]);}catch{acknowledgement='UNKNOWN_ACK_REQUIRES_READBACK';}
    durable('remove-dispatch.json',{at:new Date().toISOString(),acknowledgement,retryAllowed:false});
    let after;try{after=role();}catch(error){durable('remove-unresolved.json',{at:new Date().toISOString(),status:'RECONCILIATION_REQUIRED_NO_RETRY',errorClass:error?.name??'Error'});throw error;}
    assert.equal(after.temporaryPresent,false,'DELETE_OUTCOME_UNRESOLVED_NO_RETRY');durable('remove-readback.json',{at:new Date().toISOString(),status:'NAMED_POLICY_ABSENT_ORIGINALS_UNCHANGED',acknowledgement,...after});
  }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){assert.equal(process.argv.length,3);await runTemporaryIam(process.argv[2]);}
