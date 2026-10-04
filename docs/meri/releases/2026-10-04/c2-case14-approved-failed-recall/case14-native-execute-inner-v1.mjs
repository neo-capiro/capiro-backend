import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
const hash=b=>createHash('sha256').update(b).digest('hex');
const emit=v=>new Promise((resolve,reject)=>process.stdout.write('C2_CASE14_NATIVE_EXECUTE '+JSON.stringify(v)+'\n',e=>e?reject(e):resolve()));
try{
 assert.equal(process.env.RELEASE_SHA,'c0f393f863bf73bd4e65e7a94e17c073e7be021e');
 const bytes=Buffer.from(process.env.C2_CASE14_EXECUTE_INPUT_B64,'base64');assert.equal(hash(bytes),process.env.C2_CASE14_EXECUTE_INPUT_SHA256);
 const input=JSON.parse(bytes);assert.deepEqual(Object.keys(input).sort(),['expectedPlanSha256','recipe']);
 assert.equal(input.expectedPlanSha256,'42ed4d5a6466c9834a9d578092b98f07039808cf424a6a77095aca22202c21f2');
 assert.equal(input.recipe.caseId,'14');assert.equal(input.recipe.fixtureInstanceId,'dee4e90e-8e91-4782-9488-10b8e52a2146');
 assert.equal(input.recipe.ctx.role,'standard_user');assert.equal(input.recipe.ctx.userId,'b1f758fc-17bd-40f8-bef2-fa2d2380300f');
 process.env.DATABASE_URL=execFileSync(process.execPath,['./scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const invoke=(command,path,body)=>spawnSync(process.execPath,['./scripts/meri-pending-memory-setup.mjs',command,'--input-env','MERI_PENDING_MEMORY_SETUP_INPUT','--out',path],{encoding:'utf8',timeout:90000,maxBuffer:256*1024,env:{...process.env,MERI_PENDING_MEMORY_SETUP_INPUT:JSON.stringify(body)}});
 const child=invoke('execute','/dev/shm/case14-native-execute-v1.jsonl',input);
 if(child.status!==0){const safe=(child.stderr??'').trim();await emit({phase:'FAILURE',code:/^PENDING_MEMORY_[A-Z_]+$/.test(safe)?safe:'NATIVE_EXECUTE_CHILD_FAILED',exitCode:child.status,effectStatus:'RECONCILE_NATIVE_OWNER_BEFORE_ANY_RETRY'});process.exitCode=1;}
 else{
  const journal=readFileSync('/dev/shm/case14-native-execute-v1.jsonl','utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.length,4);assert.deepEqual(journal.map(r=>[r.stage,r.phase]),[['CLAIM','VERIFIED'],['CREATE_PENDING','INTENT'],['CREATE_PENDING','ACKNOWLEDGED'],['COMPLETE','VERIFIED']]);
  const receipt=journal[3].receipt;assert.equal(receipt.status,'SETUP_COMPLETE');assert.equal(receipt.kind,'meri-pending-memory-setup-receipt');
  assert.equal(receipt.caseId,'14');assert.equal(receipt.fixtureInstanceId,input.recipe.fixtureInstanceId);assert.equal(receipt.records.length,1);
  const record=receipt.records[0];assert.equal(record.logicalSourceId,'MEM-PROPOSAL-14');assert.equal(record.physicalId,'6f4545a1-dcd5-5eba-8606-db2043b238ac');
  assert.equal(record.status,'pending');assert.equal(record.scope,'client');assert.equal(record.proposerUserId,input.recipe.ctx.userId);assert.equal(receipt.synthesisSubmissionCount,0);assert.equal(receipt.liveAcceptance,'NOT_RUN');
  const read=invoke('read','/dev/shm/case14-native-execute-read-v1.jsonl',{recipe:input.recipe});
  assert.equal(read.status,0,'Native current owner read failed');
  const lines=readFileSync('/dev/shm/case14-native-execute-read-v1.jsonl','utf8').trim().split('\n');assert.equal(lines.length,1);const owner=JSON.parse(lines[0]);
  assert.equal(owner.kind,'meri-pending-memory-current-readback');assert.equal(owner.setupReceiptSha256,receipt.receiptSha256);assert.deepEqual(owner.records,receipt.records);
  const value={kind:'case14-native-pending-setup',status:'ONE_PENDING_CANDIDATE_CREATED_AND_READ_BACK',sourceSha:process.env.RELEASE_SHA,fixtureInstanceId:input.recipe.fixtureInstanceId,inputSha256:hash(bytes),expectedPlanSha256:input.expectedPlanSha256,journal,receipt,currentOwner:owner,providerCalls:0,candidateCreations:1,reviewDecisions:0,recallSubmissions:0,acceptanceAuthority:false,observedAt:new Date().toISOString()};
  const wire=Buffer.from(JSON.stringify(value)+'\n'),encoded=wire.toString('base64'),count=Math.ceil(encoded.length/6000),meta={sha256:hash(wire),bytes:wire.length,chunks:count};assert.ok(wire.length<32768);
  await emit({phase:'BEGIN',...meta});for(let i=0;i<count;i++)await emit({phase:'CHUNK',index:i,data:encoded.slice(i*6000,(i+1)*6000)});await emit({phase:'END',...meta});
 }
}catch(e){await emit({phase:'FAILURE',errorClass:e.name,code:'CASE14_EXECUTE_TRANSPORT_FAILED',effectStatus:'RECONCILE_NATIVE_OWNER_BEFORE_ANY_RETRY'});process.exitCode=1;}
