// Local declaration-only tests; neither dispatcher nor remote main is imported or run.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { controlledReadBudgetPlanInput, controlledReadBudgetInstallInput, inspectControlledReadSetupReceipt } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/controlled-read-operator-input.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const candidate=path.join(root,'supervised-candidate');
const out=path.join(root,process.argv[2]);fs.mkdirSync(out);
const host=fs.readFileSync(path.join(candidate,'run-case20-native-budget.mjs'),'utf8');
const innerPath=path.join(candidate,process.argv[3]??'case20-native-budget-inner.mjs');
const inner=fs.readFileSync(innerPath,'utf8');
const hash=b=>createHash('sha256').update(b).digest('hex');
function declarations(source,remote=false){
  return source.slice(0,source.indexOf('\nmain().catch(')).replace(/^#![^\n]*\n/u,'').replace(/^import[^\n]*;\n/gmu,'')
    .replace('path.dirname(fileURLToPath(import.meta.url))',JSON.stringify(candidate));
}
const hostNames=['assert','createHash','randomUUID','existsSync','mkdirSync','openSync','writeFileSync','fsyncSync','closeSync','readFileSync','path','fileURLToPath','pathToFileURL','readFile','execFileSync'];
let overrides=new Map();
const localRead=async file=>overrides.has(file)?overrides.get(file):readFile(file);
const values=[assert,createHash,randomUUID,fs.existsSync,fs.mkdirSync,fs.openSync,fs.writeFileSync,fs.fsyncSync,fs.closeSync,fs.readFileSync,path,fileURLToPath,pathToFileURL,localRead,()=>{throw Error('SUBPROCESS_FORBIDDEN');}];
const api=new Function(...hostNames,declarations(host)+'\nreturn {readSetupReceipt,assertRateBounds,validateInstalled,verifyReceiptBytes,makeWrapper,canonicalFingerprint,verifyPriorPlan};')(...values);
const adapter=new Function('assert','createHash','readFile','spawnSync',declarations(inner)+'\nreturn {validateOwnerInput,validateSuccess,stableHash};')(assert,createHash,()=>{throw Error('REMOTE_READ_FORBIDDEN');},()=>{throw Error('REMOTE_EXECUTION_FORBIDDEN');});
const parent='C:/dev/main/outputs/meri-c2-20261003';
const input=JSON.parse(fs.readFileSync(parent+'/case20-local-preparation-v1/setup-plan-input.json'));
const setup=JSON.parse(fs.readFileSync(parent+'/case20-native-setup-execute-v1/inner-owner-receipt.json'));
const ratesBytes=fs.readFileSync(parent+'/reviewed-rates-c2-v2-20261003.json');
const rates=JSON.parse(ratesBytes),proof=inspectControlledReadSetupReceipt(input,setup);
const packet=JSON.parse(fs.readFileSync(parent+'/capture-contract-release-packet.json'));
const release={packetSha256:api.canonicalFingerprint(packet),services:{api:{image:packet.services.find(s=>s.service==='api').candidate.image}}};
const local={input,setup:{owner:setup,proof},rates};
const plan={status:'READY_FOR_RATE_QUALIFICATION',caseId:'20',captureRunId:input.captureRunId,currentVerifySha256:setup.currentVerifySha256,captureBindingSha256:proof.bindingSha256,priorQualificationSha256:api.canonicalFingerprint(null),tenantRowVersion:'123',liveAcceptance:'NOT_RUN'};
const nativePlanInput=controlledReadBudgetPlanInput(input,setup);
const nativeInstallInput=controlledReadBudgetInstallInput(input,setup,plan,rates);
const q=nativeInstallInput.qualification;
const installed={status:'PROVIDER_QUALIFICATION_INSTALLED',tenantId:input.ctx.tenantId,clientId:input.clientId,captureRunId:input.captureRunId,currentVerifySha256:setup.currentVerifySha256,captureBindingSha256:proof.bindingSha256,qualificationSha256:api.canonicalFingerprint(q),priorQualificationSha256:plan.priorQualificationSha256,tenantRowVersion:'124',maxCostMicros:15000000,rateEvidenceSha256:q.rateEvidenceSha256,rateEvidenceExpiresAt:q.rateEvidenceExpiresAt,liveAcceptance:'NOT_RUN'};
const results=[];
async function test(name,work){try{await work();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',message:e.message});console.log('FAIL '+name+' '+e.message);}}
await test('actual saved setup bytes and materializer join via existing canonical helper',async()=>{const value=await api.readSetupReceipt({input},release,inspectControlledReadSetupReceipt);assert.equal(value.receiptSha256,hash(fs.readFileSync(parent+'/case20-native-setup-execute-v1/inner-owner-receipt.json')));});
await test('setup result reporting or materializer tampering refuses before budget owner',async()=>{const file=parent+'/case20-native-setup-execute-v1/result.json';const value=JSON.parse(fs.readFileSync(file));value.priorBudgetQualification='NOT_PROVED';overrides.set(file,Buffer.from(JSON.stringify(value)));try{await assert.rejects(api.readSetupReceipt({input},release,inspectControlledReadSetupReceipt));}finally{overrides.clear();}});
await test('exact reviewed two rates accepted and altered bytes refused',()=>{api.assertRateBounds(rates,ratesBytes);assert.throws(()=>api.assertRateBounds(rates,Buffer.concat([ratesBytes,Buffer.from(' ')])));});
await test('canonical plan input excludes case/run top-level and adapter accepts',()=>{assert.equal(Object.hasOwn(nativePlanInput,'caseId'),false);adapter.validateOwnerInput(nativePlanInput,input,'plan');});
await test('canonical 15M 500k 32 attempt install input is accepted',()=>{assert.equal(q.maxCostMicros,15000000);assert.equal(q.maxTokens,500000);assert.equal(q.maxAttempts,32);adapter.validateOwnerInput(nativeInstallInput,input,'install');});
for(const [name,mutate] of [['wrong client',v=>v.clientId='alien'],['wrong actor',v=>v.ctx.userId='alien'],['new cap',v=>v.qualification.maxCostMicros++],['extra field',v=>v.extra=true],['wrong current proof',v=>v.expectedCurrentVerifySha256='0'.repeat(64)],['expired rates',v=>v.rateEvidence.expiresAt='2020-01-01T00:00:00Z']])await test('adapter refuses '+name,()=>{const v=structuredClone(nativeInstallInput);mutate(v);assert.throws(()=>adapter.validateOwnerInput(v,input,'install'));});
await test('adapter refuses substituted internally consistent provider prices',()=>{const v=structuredClone(nativeInstallInput);v.rateEvidence.rates[0].inputMicrosPerMillion=1;v.qualification.rates=structuredClone(v.rateEvidence.rates);v.qualification.rateEvidenceSha256=adapter.stableHash(v.rateEvidence);assert.throws(()=>adapter.validateOwnerInput(v,input,'install'));});
await test('native plan receipt matches exact adapter contract',()=>adapter.validateSuccess(plan,'plan',input,nativePlanInput));
await test('native install receipt has no caseId and passes exact adapter and host joins',()=>{assert.equal(Object.hasOwn(installed,'caseId'),false);adapter.validateSuccess(installed,'install',input,nativeInstallInput);api.validateInstalled(installed,local,nativeInstallInput);});
for(const key of ['tenantId','clientId','captureRunId','currentVerifySha256','captureBindingSha256','qualificationSha256','priorQualificationSha256','maxCostMicros','rateEvidenceSha256','rateEvidenceExpiresAt'])await test('installed receipt refuses changed '+key,()=>{const v={...installed,[key]:key==='maxCostMicros'?15000001:'changed'};assert.throws(()=>api.validateInstalled(v,local,nativeInstallInput));});
function frames(owner,mode,ownerInputSha256){const b=Buffer.from(JSON.stringify(owner)),encoded=b.toString('base64');const meta={version:1,kind:'case20-native-budget-json',mode,sourceSha:'4f0253874357c272fda1ae2a5271ee4af645f0bc',inputSha256:'a72c2d69bebb9694edb38bc4131a60a093e6488f8cd3528fafd92db7f84a082d',scriptSha256:hash(inner),ownerInputSha256,captureRunId:input.captureRunId,outputPath:`/dev/shm/case20-native-budget-${mode}-owner.json`,byteLength:b.length,base64Length:encoded.length,chunks:1,sha256:hash(b),childExitCode:0,childSignal:null,ownerOutput:'OWNER_SUCCESS'};return [{phase:'BEGIN',...meta},{phase:'CHUNK',sha256:meta.sha256,index:1,data:encoded},{phase:'END',...meta}];}
for(const mode of ['plan','install'])await test('budget '+mode+' exact input hash is part of byte transport',()=>{const native=mode==='plan'?nativePlanInput:nativeInstallInput;const expected=hash(Buffer.from(JSON.stringify(native)+'\n'));const records=frames(mode==='plan'?plan:installed,mode,expected);const binding={mode,innerScriptSha256:hash(inner),ownerInputSha256:expected,outputPath:`/dev/shm/case20-native-budget-${mode}-owner.json`};assert.equal(api.verifyReceiptBytes(records,binding).successful,true);assert.throws(()=>api.verifyReceiptBytes(records,{...binding,ownerInputSha256:'0'.repeat(64)}));records.push({phase:'FAILURE'});assert.equal(api.verifyReceiptBytes(records,binding).successful,false);});
await test('wrapper stages canonical input hash and no setup executable',()=>{const ownerInputSha256=hash(Buffer.from(JSON.stringify(nativeInstallInput)+'\n'));const wrapper=api.makeWrapper({mode:'install',innerBytes:Buffer.from(inner),inputBytes:Buffer.from('{}'),ownerInput:nativeInstallInput,local:{ownerInputSha256,innerScriptSha256:hash(inner)},outputPath:'/dev/shm/case20-native-budget-install-owner.json'});assert.ok(wrapper.includes('C2_CASE20_OWNER_INPUT_SHA256'));assert.ok(wrapper.includes(ownerInputSha256));assert.ok(!wrapper.includes('case20-native-setup'));});
const planRoot=parent+'/case20-native-budget-plan-v1';
const planBytes=Buffer.from(JSON.stringify(plan)+'\n');
local.outerScriptSha256=hash(host);local.innerScriptSha256=hash(inner);local.ratesSha256=hash(ratesBytes);
local.setup.receiptSha256=hash(fs.readFileSync(parent+'/case20-native-setup-execute-v1/inner-owner-receipt.json'));local.pinnedOperationFiles={};
const planResult={mode:'plan',status:'BUDGET_PLAN_ONLY',exitCode:0,sourceSha:'4f0253874357c272fda1ae2a5271ee4af645f0bc',candidateImage:release.services.api.image,packetSha256:release.packetSha256,outerScriptSha256:hash(host),innerScriptSha256:hash(inner),inputSha256:'a72c2d69bebb9694edb38bc4131a60a093e6488f8cd3528fafd92db7f84a082d',childExitCode:0,taskExitCode:0,cleanup:{taskStopped:true,taskDefinitionInactive:true},evidencePersistenceFailed:false,observations:[],setupReceiptSha256:local.setup.receiptSha256,ratesSha256:local.ratesSha256,ownerReceipt:{path:planRoot+'/inner-owner-receipt.json',sha256:hash(planBytes),bytes:planBytes.length},ownerPlan:{kind:'READY_FOR_RATE_QUALIFICATION',planSha256:api.canonicalFingerprint(plan),taskArn:'UNIT_TASK',taskDefinitionArn:'UNIT_DEFINITION'},taskArn:'UNIT_TASK',taskDefinitionArn:'UNIT_DEFINITION'};
await test('prior successful budget plan uses same actual setup and canonical install input',async()=>{
  overrides.set(planRoot+'/result.json',Buffer.from(JSON.stringify(planResult)));overrides.set(planRoot+'/inner-owner-receipt.json',planBytes);
  try{const v=await api.verifyPriorPlan(local,release,controlledReadBudgetInstallInput);assert.deepEqual(v.ownerInput,nativeInstallInput);assert.equal(Object.keys(local.pinnedOperationFiles).length,2);}finally{overrides.clear();}
});
await test('prior budget plan with changed setup bytes or fatal uncertainty refuses',async()=>{
  for(const mutate of [v=>v.setupReceiptSha256='0'.repeat(64),v=>v.observations=[{fatal:true}]]){
    const v=structuredClone(planResult);mutate(v);overrides.set(planRoot+'/result.json',Buffer.from(JSON.stringify(v)));overrides.set(planRoot+'/inner-owner-receipt.json',planBytes);
    try{await assert.rejects(api.verifyPriorPlan(local,release,controlledReadBudgetInstallInput));}finally{overrides.clear();}
  }
});
const receipt={kind:'LOCAL_ONLY_BUDGET_DELTA_QUALIFICATION',sourceSha256:hash(host),innerSha256:hash(inner),testSha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,results,limits:['Actual saved setup receipt and exact rates were read locally; no actual budget owner plan/install exists in this test.','Canonical helper generates local consistency input from a synthetic budget plan; no authority minted.','Dispatcher/inner main never imported or executed; extracted declarations only, subprocess and remote reads denied.','No cloud, database, authentication, journal, fixture, provider, reservation or capture action.']};
fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({pass:receipt.pass,fail:receipt.fail}));if(receipt.fail)process.exitCode=1;
