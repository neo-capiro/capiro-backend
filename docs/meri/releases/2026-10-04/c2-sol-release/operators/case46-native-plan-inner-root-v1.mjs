import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const require=createRequire('/app/apps/api/package.json');
const hash=b=>createHash('sha256').update(b).digest('hex');
const emit=value=>new Promise((resolve,reject)=>process.stdout.write('C2_CASE46_NATIVE_PLAN '+JSON.stringify(value)+'\n',error=>error?reject(error):resolve()));
let runtime;
try{
 assert.equal(process.env.RELEASE_SHA,'4b228386df0ddd2f34aea8f4bc1fcc1d1a8f985e');
 const bytes=Buffer.from(process.env.C2_CASE46_PLAN_INPUT_B64,'base64');assert.equal(hash(bytes),'a529153816294da5a57d2df5c3e42a39b8254bef51232fb9e6476176ae21f256');const input=JSON.parse(bytes);
 process.env.DATABASE_URL=execFileSync(process.execPath,['./scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const {createCase46SetupDependencies}=require('./dist/meri/meri-case46-setup-dependencies.js');
 const {planCase46Setup}=require('./dist/meri/meri-case46-setup-owner.js');
 runtime=await createCase46SetupDependencies();
 const plan=await planCase46Setup(runtime,input.recipe);
 assert.equal(plan.caseId,'46');assert.equal(plan.chatTurns,0);assert.equal(plan.outputArtifacts,0);assert.equal(plan.liveAcceptance,'NOT_RUN');assert.match(plan.planSha256,/^[a-f0-9]{64}$/);
 const result={kind:'case46-prospective-native-plan',status:'NATIVE_PLAN_CAPTURED',plan,sourceSha:process.env.RELEASE_SHA,inputSha256:hash(bytes),providerCalls:0,businessWrites:0,acceptanceAuthority:false,nativePlanOnly:true,observedAt:new Date().toISOString()};
 const raw=Buffer.from(JSON.stringify(result)+'\n'),encoded=raw.toString('base64'),count=Math.ceil(encoded.length/6000),meta={sha256:hash(raw),bytes:raw.length,chunks:count};assert.ok(raw.length<16384);
 await emit({phase:'BEGIN',...meta});for(let i=0;i<count;i++)await emit({phase:'CHUNK',index:i,data:encoded.slice(i*6000,(i+1)*6000)});await emit({phase:'END',...meta});
}catch(e){const safe=/^meri_case46_[a-z0-9_]+$/.test(e?.message??'')?e.message:'CASE46_PLAN_TRANSPORT_FAILED';await emit({phase:'FAILURE',code:safe,errorClass:e?.name??'Error'});process.exitCode=1;}
finally{if(runtime)await runtime.close();}
