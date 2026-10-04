import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
const hash=b=>createHash('sha256').update(b).digest('hex');
const emit=v=>new Promise((resolve,reject)=>process.stdout.write('C2_CASE14_NATIVE_PLAN '+JSON.stringify(v)+'\n',e=>e?reject(e):resolve()));
try{
 assert.equal(process.env.RELEASE_SHA,'4f0253874357c272fda1ae2a5271ee4af645f0bc');
 const inputBytes=Buffer.from(process.env.C2_CASE14_PLAN_INPUT_B64,'base64');assert.equal(hash(inputBytes),'6e20d773668705f805945a619c392d48b7fefc4843b91b62adde7e5d470b5ffd');
 const input=JSON.parse(inputBytes);assert.equal(input.recipe.caseId,'14');assert.equal(input.recipe.fixtureInstanceId,'dee4e90e-8e91-4782-9488-10b8e52a2146');
 assert.equal(input.recipe.ctx.role,'standard_user');assert.equal(input.recipe.ctx.userId,'b1f758fc-17bd-40f8-bef2-fa2d2380300f');
 process.env.DATABASE_URL=execFileSync(process.execPath,['./scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const child=spawnSync(process.execPath,['./scripts/meri-pending-memory-setup.mjs','plan','--input-env','MERI_PENDING_MEMORY_SETUP_INPUT','--out','/dev/shm/case14-prospective-plan-v1.jsonl'],{encoding:'utf8',timeout:90000,maxBuffer:256*1024,env:{...process.env,MERI_PENDING_MEMORY_SETUP_INPUT:inputBytes.toString('utf8')}});
 if(child.status!==0){const safe=(child.stderr??'').trim();await emit({phase:'FAILURE',code:/^PENDING_MEMORY_[A-Z_]+$/.test(safe)?safe:'NATIVE_PLAN_CHILD_FAILED',exitCode:child.status});process.exitCode=1;}
 else{
  const lines=readFileSync('/dev/shm/case14-prospective-plan-v1.jsonl','utf8').trim().split('\n');assert.equal(lines.length,1);const plan=JSON.parse(lines[0]);
  assert.equal(plan.kind,'meri-pending-memory-setup-plan');assert.equal(plan.caseId,'14');assert.equal(plan.liveAcceptance,'NOT_RUN');assert.deepEqual(plan.sourceIds,['MEM-PROPOSAL-14']);
  for(const k of ['planSha256','recipeSha256','manifestContentSha256','priorSettingsSha256'])assert.match(plan[k],/^[a-f0-9]{64}$/);
  const value={kind:'case14-prospective-native-plan',status:'NATIVE_PLAN_CAPTURED',plan,sourceSha:process.env.RELEASE_SHA,fixtureInstanceId:input.recipe.fixtureInstanceId,inputSha256:hash(inputBytes),providerCalls:0,businessWrites:0,acceptanceAuthority:false,nativePlanOnly:true,observedAt:new Date().toISOString()};
  const bytes=Buffer.from(JSON.stringify(value)+'\n'),encoded=bytes.toString('base64'),count=Math.ceil(encoded.length/6000),meta={sha256:hash(bytes),bytes:bytes.length,chunks:count};assert.ok(bytes.length<16384);
  await emit({phase:'BEGIN',...meta});for(let i=0;i<count;i++)await emit({phase:'CHUNK',index:i,data:encoded.slice(i*6000,(i+1)*6000)});await emit({phase:'END',...meta});
 }
}catch(e){await emit({phase:'FAILURE',errorClass:e.name,code:'CASE14_PLAN_TRANSPORT_FAILED'});process.exitCode=1;}
