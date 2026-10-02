// Fixed local-only preparation. No AWS, Clerk, browser, DB or model calls.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {BASE,REPO,TESTED_CODE,RELEASE_SOURCE,WEB_SOURCE,need,sha256,stableHash,readJson,
  inspectBuildReadback,assertDocsOnly,loadRelease,inspectCase01Inputs} from './live-operator-gates.mjs';
const readBytesJson=path=>{const bytes=readFileSync(path);return {bytes,value:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u,''))};};
const write=(name,value)=>writeFileSync(join(BASE,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
function cleanMain(){
 const git=(...args)=>execFileSync('git',args,{cwd:REPO,encoding:'utf8',windowsHide:true}).trim();
 need(git('branch','--show-current')==='main'&&git('rev-parse','HEAD')===git('rev-parse','origin/main')&&git('status','--porcelain')==='','CLEAN_CURRENT_MAIN_REQUIRED');
 git('merge-base','--is-ancestor',TESTED_CODE,RELEASE_SOURCE);git('merge-base','--is-ancestor',RELEASE_SOURCE,'HEAD');
 assertDocsOnly(git('diff','--name-only','--no-renames','-z',TESTED_CODE,RELEASE_SOURCE).split('\0'));
 assertDocsOnly(git('diff','--name-only','--no-renames','-z',RELEASE_SOURCE,'HEAD').split('\0'));
 return git('rev-parse','HEAD');
}
async function main(){
 need(process.argv.length===3&&['--seal-release','--seal-case01'].includes(process.argv[2]),'EXACT_COMMAND_REQUIRED');
 const operatorHead=cleanMain();
 if(process.argv[2]==='--seal-release'){
  const reviewed=readBytesJson(join(BASE,'reviewed-build-input.json'));
  need(reviewed.value.sourceSha===RELEASE_SOURCE&&reviewed.value.testedCodeSha===TESTED_CODE,'REVIEWED_SOURCE_CHANGED');
  const pins={schemaVersion:1,kind:'meri-live-repair-operator-pins',target:'https://os.capiro.ai',sourceSha:RELEASE_SOURCE,
   testedCodeSha:TESTED_CODE,webSourceSha:WEB_SOURCE,operatorHeadAtSeal:operatorHead,
   reviewedBuildInputSha256:sha256(reviewed.bytes),buildReadbackSha256:{},
   gatesSha256:sha256(readFileSync(join(BASE,'live-operator-gates.mjs'))),driverSha256:{}};
  for(const service of ['api','meriv2-orchestrator']){
   const proof=readBytesJson(join(BASE,service+'-build-readback.json')),expected=reviewed.value.services[service];
   inspectBuildReadback(proof.value,service,RELEASE_SOURCE,expected.buildspecSha256,expected.executedMarkers);
   pins.buildReadbackSha256[service]=sha256(proof.bytes);
  }
  for(const driver of ['run-case17-authenticated-v4.mjs','run-case01-authenticated-v2.mjs'])
   pins.driverSha256[driver]=sha256(readFileSync(join(BASE,driver)));
  write('live-operator-release-pins.json',pins);
  loadRelease('run-case17-authenticated-v4.mjs');loadRelease('run-case01-authenticated-v2.mjs');
  console.log(JSON.stringify({status:'LOCAL_RELEASE_INPUTS_SEALED',sourceSha:RELEASE_SOURCE,networkCalls:0}));return;
 }
 need(!existsSync(join(BASE,'case01-live-scope.json'))&&!existsSync(join(BASE,'case01-operator-input-pins.json')),'NEW_INPUT_PATHS_REQUIRED');
 const release=loadRelease('run-case01-authenticated-v2.mjs');
 const recovery=readBytesJson(join(BASE,'recovery-execute-execution.json')),budget=readBytesJson(join(BASE,'budget-install-execution.json'));
 const setup=recovery.value.ownerReceipts?.at(-1)?.receipt;
 need(setup?.status==='SETUP_COMPLETE','RECOVERY_OWNER_REQUIRED');
 const manifest=readJson('C:/dev/cap-meri-foundation-evidence/private/meri-foundation-20260928.manifest.json');
 need(manifest.namespace==='meri-foundation-20260928'&&manifest.target==='capiro-dev'&&manifest.status==='ready','MANIFEST_SCOPE');
 const actor=manifest.ids.users.pat,tenant=manifest.ids.tenants.t1,client=manifest.ids.clients.aster;
 need(setup.ctx.userId===actor.userId&&setup.ctx.tenantId===tenant.tenantId&&setup.ctx.role==='standard_user'&&setup.clientId===client.clientId,'ACTUAL_OWNER_IDENTITY');
 const {frozenFixture}=await import('file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/fixture.mjs');
 const lock=readJson(join(REPO,'evals/meri/live-v1/contract-lock.json'));
 const config={schemaVersion:1,provenance:'LIVE_CAPTURE',caseId:'01',target:{apiOrigin:'https://os.capiro.ai',environment:'capiro-dev'},
  captureRunId:setup.captureRunId,conversationId:setup.conversationId,
  limits:{concurrency:1,deadlineMs:900000,maxSpendUsd:3},
  contract:{fixtureSha256:lock.fixtureSha256,contractSourceSha256:lock.contractSourceSha256},
  fixture:{version:frozenFixture.version,namespace:'meri-foundation-20260928',sha256:lock.fixtureSha256,
   mappingSha256:stableHash(setup.sourceMap),seedReceiptId:setup.seedReceiptId,resetReceiptId:setup.resetReceiptId},
  scope:{actors:{PAT:{userId:actor.userId,clerkUserId:actor.clerkUserId,tenantPhysicalId:tenant.tenantId,role:'standard_user'}},
   tenants:{T1:{physicalId:tenant.tenantId,slug:'meri-foundation-20260928-t1'}},
   clients:{ASTER:{physicalId:setup.clientId,tenantPhysicalId:tenant.tenantId}},sources:setup.sourceMap},
  deployment:{apiSha:RELEASE_SOURCE,orchestratorSha:RELEASE_SOURCE,builds:{api:release.builds.api,'meriv2-orchestrator':release.builds['meriv2-orchestrator']}}};
 inspectCase01Inputs({config,recovery:recovery.value,budget:budget.value,release});
 const bytes=Buffer.from(JSON.stringify(config,null,2)+'\n');
 writeFileSync(join(BASE,'case01-live-scope.json'),bytes,{flag:'wx'});
 write('case01-operator-input-pins.json',{schemaVersion:1,kind:'meri-case01-recovered-capture-inputs',sourceSha:RELEASE_SOURCE,
  scopeSha256:sha256(bytes),recoveryExecutionSha256:sha256(recovery.bytes),budgetExecutionSha256:sha256(budget.bytes)});
 console.log(JSON.stringify({status:'LOCAL_CASE01_INPUTS_SEALED',sourceSha:RELEASE_SOURCE,networkCalls:0}));
}
try{await main();}catch(error){console.error(JSON.stringify({status:'BLOCKED',code:error.safeCode||error.name}));process.exitCode=1;}
