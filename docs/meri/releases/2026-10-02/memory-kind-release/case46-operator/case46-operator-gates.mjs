// Local-only gates. Root must seal readiness from actual setup/release and the existing journal.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectCase46Scope} from 'file:///C:/dev/cap-meri-mail-deadline/evals/meri/live-v1/case46-receipt-joins.mjs';
import {sha256Stable} from 'file:///C:/dev/cap-meri-mail-deadline/evals/meri/live-v1/artifact-collector.mjs';
export const BASE=dirname(fileURLToPath(import.meta.url)), DRIVER='C:/dev/cap-meri-mail-deadline', REPO='C:/dev/cap-meri-outcomes-validation';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const need=(ok,code)=>{if(!ok){const e=new Error(code);e.safeCode=code;throw e;}};
const HASH=/^[a-f0-9]{64}$/u,SHA=/^[a-f0-9]{40}$/u;
const AGGREGATE_BASE='C:/dev/cap-meri-foundation-evidence/oct02-original-aggregate-operator-v5';
const FIRST_RUN='c6ffa5ad-dd9f-4912-bc31-a03231a9b903';
export const read=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/u,''));
export function pinned(file,digest){need(HASH.test(digest??''),'CASE46_PIN_REQUIRED');const b=readFileSync(file);need(sha(b)===digest,'CASE46_FILE_CHANGED');return JSON.parse(b.toString('utf8'));}
export function inspectInputs({ready,config,setup,checkpoint,now=Date.now()}){
 need(ready?.version===1&&ready.kind==='meri-case46-root-ready'&&ready.status==='READY'&&ready.target==='https://os.capiro.ai'&&
  ready.maximumNewTurns===1&&ready.maximumApprovals===1&&ready.fullFile01Acceptance===false&&
  Number.isSafeInteger(ready.observedAt)&&ready.observedAt<=now&&ready.expiresAt>now&&ready.expiresAt-ready.observedAt<=600000,
  'CASE46_FRESH_ROOT_READINESS_REQUIRED');
 const s=inspectCase46Scope(config.scope);
 for(const [key,value] of [['apiSha',s.apiSha],['orchestratorSha',s.orchestratorSha],['webSha',s.webSha]])need(ready[key]===value&&SHA.test(value),'CASE46_RELEASE_IDENTITY');
 need(config.schemaVersion===1&&config.provenance==='LIVE_CAPTURE'&&config.target.apiOrigin===ready.target&&config.target.environment==='capiro-dev','CASE46_CONFIG');
 need(setup?.status==='VERIFIED'&&setup.mode==='case46-setup-execute'&&setup.sourceSha===s.apiSha&&setup.containerExitCode===0,'CASE46_ACTUAL_SETUP_REQUIRED');
 const rows=setup.ownerReceipts;
 need(Array.isArray(rows)&&rows.length===9&&rows.every(r=>r.kind==='meri-case46-setup'&&r.caseId==='46'&&r.captureRunId===s.captureRunId),'CASE46_OWNER_JOURNAL');
 const stages=['CLAIM','INPUT_SOURCE','EMPTY_CONVERSATION','CAPTURE_BINDING'];
 for(let i=0;i<4;i++)need(rows[i*2].stage===stages[i]&&rows[i*2].phase==='INTENT'&&rows[i*2+1].stage===stages[i]&&rows[i*2+1].phase==='VERIFIED','CASE46_OWNER_ORDER');
 need(rows[8].stage==='COMPLETE'&&rows[8].phase==='VERIFIED','CASE46_COMPLETE_REQUIRED');
 const r=rows[8].receipt,b=r?.binding;
 need(r?.version===1&&r.caseId==='46'&&r.fixtureNamespace===s.fixtureNamespace&&r.tenantId===s.tenantId&&r.actorUserId===s.userId&&
  r.clientId===s.clientId&&r.captureRunId===s.captureRunId&&r.conversationId===s.conversationId&&r.chatTurns===0&&r.outputArtifacts===0&&
  HASH.test(r.claimSha256)&&HASH.test(r.planSha256)&&b?.version===1&&b.caseId==='46'&&b.captureRunId===s.captureRunId&&b.conversationId===s.conversationId&&
  b.bindingSha256===s.bindingSha256&&b.currentVerifySha256===s.currentVerifySha256&&b.qualificationSha256===s.qualificationSha256&&b.expiresAt>now,
  'CASE46_SETUP_BINDING');
 need(sha256Stable(rows[7].binding)===sha256Stable(b)&&sha256Stable(rows[3].source)===sha256Stable(r.source),'CASE46_SETUP_JOINS');
 need(checkpoint?.kind==='meri-original-capture-spend-checkpoint'&&checkpoint.version===1&&
  checkpoint.state?.root===resolve(AGGREGATE_BASE,'original-spend-journal')&&checkpoint.state.root===ready.aggregateRoot&&
  checkpoint.snapshot?.activeRun===null&&checkpoint.snapshot.runs?.[`01:${FIRST_RUN}`]?.kind==='settle'&&
  checkpoint.snapshot.remainingReservationMicros>=s.qualification.maxCostMicros,
  'CASE46_EXISTING_AGGREGATE_REQUIRED');
 need(config.deployment.apiSha===s.apiSha&&config.deployment.orchestratorSha===s.orchestratorSha&&
  sha256Stable(config.deployment.builds)===sha256Stable(ready.builds),'CASE46_BUILD_BINDING');
 return {config,checkpoint,ready,setupReceipt:r};
}
export function loadCase46Ready(){
 const bytes=readFileSync(join(BASE,'case46-ready.json')),ready=JSON.parse(bytes.toString('utf8'));
 need(ready?.status==='READY'&&SHA.test(ready.driverSha??''),'CASE46_OPERATOR_UNSEALED');
 for(const name of ['case46-operator-gates.mjs','run-case46-authenticated.mjs'])
  need(sha(readFileSync(join(BASE,name)))===ready.operatorFileSha256?.[name],'CASE46_OPERATOR_CHANGED');
 const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
 need(git(DRIVER,'rev-parse','HEAD')===ready.driverSha&&git(DRIVER,'status','--porcelain')==='','CASE46_CLEAN_DRIVER_REQUIRED');
 need(git(REPO,'branch','--show-current')==='main'&&git(REPO,'status','--porcelain')===''&&git(REPO,'rev-parse','HEAD')===git(REPO,'rev-parse','origin/main'),'CASE46_CLEAN_MAIN_REQUIRED');
 git(REPO,'merge-base','--is-ancestor',ready.apiSha,'HEAD');
 need(git(REPO,'diff','--name-only','--no-renames','-z',ready.apiSha,'HEAD').split('\0').every(p=>!p||p.startsWith('docs/')),'CASE46_RUNTIME_DRIFT');
 const checkpoint=pinned(join(BASE,'case46-aggregate-checkpoint.json'),ready.aggregateCheckpointSha256);
 const owner=read(join(AGGREGATE_BASE,'aggregate-owner-pins.json'));
 need(owner.kind==='meri-original-capture-aggregate-owner-pins'&&owner.firstCaptureRunId===FIRST_RUN,'CASE46_ORIGINAL_SLICE_REQUIRED');
 const initial=pinned(join(AGGREGATE_BASE,'aggregate-initial-checkpoint.json'),owner.checkpointSha256);
 need(checkpoint.state?.ownerSha256===initial.state?.ownerSha256&&
  sha256Stable(checkpoint.state?.directories)===sha256Stable(initial.state?.directories)&&
  sha256Stable(checkpoint.state?.files?.['bundle-owner.json'])===sha256Stable(initial.state?.files?.['bundle-owner.json']), 'CASE46_AGGREGATE_IDENTITY_CHANGED');
 const data=inspectInputs({ready,config:pinned(join(BASE,'case46-config.json'),ready.configSha256),
  setup:pinned(join(BASE,'case46-setup-execution.json'),ready.setupExecutionSha256),
  checkpoint});
 return {...data,readySha256:sha(bytes),operatorHead:git(REPO,'rev-parse','HEAD')};
}
