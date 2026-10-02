/** Reuse exactly registered API489. Import/tests never call AWS. No registration path. */
import { readFile, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { releaseOperator, persistReceipt } from 'file:///C:/dev/cap-meri-migration-history-guard/scripts/meri-release.mjs';
import { governanceTask } from 'file:///C:/dev/cap-meri-migration-history-guard/scripts/meri-synthetic-governance.mjs';
import { taskInput, fingerprint, assertBaseline, serviceFingerprint, serviceConfigFingerprint } from 'file:///C:/dev/cap-meri-migration-history-guard/scripts/lib/meri-release-policy.mjs';
import { resolveAwsCli } from 'file:///C:/dev/cap-meri-migration-history-guard/scripts/lib/resolve-aws-cli.mjs';

const ROOT = 'C:/dev/cap-meri-foundation-evidence/oct02-case01-release/';
const REPO = 'C:/dev/cap-meri-migration-history-guard';
const SOURCE = 'c11c83fe1759183254b24d11a9087ccc89595a73';
const ORIGINAL_PLAN = 'df9ecf9666ae2a540409435597eecb8182192c2fdf60b3f895b6f67be0f36c81';
const ORIGINAL_RECEIPT = '6e2dcafc6357b4fefb46910a65c3005566e4a6169efd6bd81c06214f883493a7';
const CALLER = 'arn:aws:iam::967807252336:user/hermes-cli';
const BASELINE = 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:488';
const CANDIDATE = 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:489';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error('GOVERNANCE_RECOVERY_' + code); };

export function definitionProjection(td) {
  const copy = taskInput(td);
  for (const container of copy.containerDefinitions) {
    if (container.environment === undefined) continue;
    need(Array.isArray(container.environment), 'ENVIRONMENT_INVALID');
    const names = new Set();
    for (const entry of container.environment) {
      need(entry && typeof entry.name === 'string' && entry.name.length > 0 && typeof entry.value === 'string' && !names.has(entry.name), 'ENVIRONMENT_INVALID');
      names.add(entry.name);
    }
    container.environment.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  return copy;
}

export function createRecovery({ aws, originals, currentMain, selfHash, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const release = releaseOperator({aws, now, sleep});
  const call = (...command) => aws(command);
  async function identity() {
    const value = await call('sts','get-caller-identity');
    need(value.Account === '967807252336' && value.Arn === CALLER, 'CALLER_CHANGED');
  }
  async function service() {
    const value = await call('ecs','describe-services','--cluster','capiro-dev','--services','capiro-dev-api');
    need(!value.failures?.length && value.services?.length === 1, 'SERVICE_AMBIGUOUS');
    return value.services[0];
  }
  async function definition() {
    const value = await call('ecs','describe-task-definition','--task-definition',CANDIDATE,'--include','TAGS');
    need(value.taskDefinition?.taskDefinitionArn === CANDIDATE && value.taskDefinition.status === 'ACTIVE', 'CANDIDATE_UNAVAILABLE');
    return {...value.taskDefinition,tags:value.tags ?? []};
  }
  async function inspect() {
    const operatorHead = await currentMain();
    const {plan:m,receipt:r} = await originals();
    need(m.operatorSourceSha === SOURCE && m.baseline?.taskDefinitionArn === BASELINE && m.changed === true &&
      r.kind === 'meri-fixed-synthetic-governance-receipt' && r.version === 1 && r.manifestHash === fingerprint(m) &&
      r.status === 'register-outcome-unknown' && r.rollback === false && r.candidateTaskDefinition === CANDIDATE && !r.deploymentId, 'ORIGINAL_FAILURE_BINDING');
    await identity();
    const qualified = await release.prepare(m.qualification);
    assertBaseline(m.baseline, qualified.baseline);
    const live = await release.snapshot('api');
    assertBaseline(m.baseline, live.baseline);
    const expected = governanceTask(live.task,m.qualification,now()).proposed;
    need(fingerprint(expected) === m.candidateTaskHash, 'ORIGINAL_TRANSFORM_CHANGED');
    const actual = await definition();
    const normalizedHash = fingerprint(definitionProjection(expected));
    need(fingerprint(definitionProjection(actual)) === normalizedHash, 'CANDIDATE_SEMANTIC_DRIFT');
    return {m,operatorHead,normalizedHash,registeredRawHash:fingerprint(taskInput(actual))};
  }
  return {
    async prepare() {
      const value = await inspect();
      return {kind:'meri-governance-489-recovery-plan',version:1,createdAt:now(),expiresAt:Math.min(now()+1800000,Date.parse(value.m.qualification.expiresAt)),
        operatorHead:value.operatorHead,sourceSha:SOURCE,operatorSha256:await selfHash(),originalPlanSha256:ORIGINAL_PLAN,originalReceiptSha256:ORIGINAL_RECEIPT,
        originalManifestHash:fingerprint(value.m),candidateTaskDefinition:CANDIDATE,baselineTaskDefinition:BASELINE,normalizedCandidateHash:value.normalizedHash,
        registeredRawHash:value.registeredRawHash,liveAcceptance:'NOT_RUN'};
    },
    async run(plan, approvedHash, record) {
      need(typeof record === 'function' && approvedHash === fingerprint(plan) && plan.kind === 'meri-governance-489-recovery-plan' && plan.version === 1 &&
        plan.createdAt <= now() && now() <= plan.expiresAt && plan.expiresAt-plan.createdAt <= 1800000 &&
        plan.sourceSha === SOURCE && plan.operatorSha256 === await selfHash() && plan.originalPlanSha256 === ORIGINAL_PLAN && plan.originalReceiptSha256 === ORIGINAL_RECEIPT &&
        plan.candidateTaskDefinition === CANDIDATE && plan.baselineTaskDefinition === BASELINE, 'PLAN_CHANGED_OR_EXPIRED');
      const value = await inspect(), {m} = value;
      need(value.operatorHead === plan.operatorHead && value.normalizedHash === plan.normalizedCandidateHash && value.registeredRawHash === plan.registeredRawHash && fingerprint(m) === plan.originalManifestHash, 'FRESH_PROOF_CHANGED');
      const receipt = {kind:'meri-governance-489-recovery-receipt',version:1,planHash:approvedHash,status:'READY',candidateTaskDefinition:CANDIDATE,
        originalPlanSha256:ORIGINAL_PLAN,originalReceiptSha256:ORIGINAL_RECEIPT,operatorHead:plan.operatorHead,liveAcceptance:'NOT_RUN',updateSubmissions:0};
      await record(receipt);
      try {
        need(await currentMain() === plan.operatorHead, 'OPERATOR_MAIN_CHANGED');
        await identity();
        receipt.status='UPDATE_INTENT'; await record(receipt);
        const before = await service();
        need(before.taskDefinition === BASELINE && serviceFingerprint(before) === m.baseline.serviceHash && serviceConfigFingerprint(before) === m.baseline.configHash, 'IMMEDIATE_BASELINE_DRIFT');
        receipt.updateSubmissions=1;
        const result = await call('ecs','update-service','--cluster','capiro-dev','--service','capiro-dev-api','--task-definition',CANDIDATE);
        const primary = result.service?.deployments?.find(d=>d.status==='PRIMARY');
        need(result.service?.taskDefinition === CANDIDATE && primary?.taskDefinition === CANDIDATE && primary.id && serviceConfigFingerprint(result.service) === m.baseline.configHash, 'UPDATE_ACK_UNKNOWN');
        receipt.deploymentId=primary.id; receipt.status='UPDATE_ACKNOWLEDGED'; await record(receipt);
        const deadline=now()+1500000;
        for(let attempt=0;attempt<100 && now()<deadline;attempt++){
          const current=await service();
          need(current.taskDefinition === CANDIDATE && current.deployments?.find(d=>d.status==='PRIMARY')?.id === receipt.deploymentId && serviceConfigFingerprint(current) === m.baseline.configHash, 'CONCURRENT_DEPLOYMENT_OR_CONFIG');
          need(!current.deployments.some(d=>d.rolloutState==='FAILED'), 'ROLLOUT_FAILED');
          if(current.deployments.length===1 && current.deployments[0].rolloutState==='COMPLETED'){
            const live=await release.snapshot('api'); // actual tasks, pinned image and ALB health
            need(live.service.taskDefinition===CANDIDATE && live.service.deployments[0]?.id===receipt.deploymentId && live.baseline.configHash===m.baseline.configHash &&
              live.baseline.imageDigest===m.baseline.imageDigest && fingerprint(definitionProjection(live.task))===plan.normalizedCandidateHash, 'FINAL_RUNTIME_DRIFT');
            need(serviceFingerprint(await service())===serviceFingerprint(live.service),'FINAL_SERVICE_DRIFT');
            receipt.status='ecs-healthy'; receipt.verifiedAt=new Date(now()).toISOString(); await record(receipt); return receipt;
          }
          await sleep(15000);
        }
        need(false,'WAIT_TIMEOUT_RECONCILE_NO_RETRY');
      }catch(error){
        receipt.status='RECONCILIATION_REQUIRED';
        receipt.code=/^GOVERNANCE_RECOVERY_[A-Z_]+$/u.test(error?.message??'')?error.message:'GOVERNANCE_RECOVERY_OUTCOME_UNCERTAIN';
        await record(receipt); throw error;
      }
    },
  };
}

async function cli() {
  const execute=promisify(execFile);
  const selfHash=async()=>sha(await readFile(fileURLToPath(import.meta.url)));
  const git=async(...args)=>(await execute('git',['-C',REPO,...args],{windowsHide:true})).stdout;
  const currentMain=async()=>{
    const head=(await git('rev-parse','HEAD')).trim();
    need(head===(await git('rev-parse','origin/main')).trim() && !(await git('status','--porcelain=v1','--untracked-files=all')).trim() &&
      /^https:\/\/github.com\/neo-capiro\/capirov2(?:\.git)?$/u.test((await git('remote','get-url','origin')).trim()),'CLEAN_MAIN_REQUIRED');
    need((await git('merge-base',SOURCE,head)).trim()===SOURCE,'SOURCE_NOT_ANCESTOR');
    need((await git('diff','--name-only','--no-renames','-z',SOURCE,head)).split('\0').every(path=>!path||path.startsWith('docs/')),'SOURCE_CODE_DRIFT');
    return head;
  };
  const originals=async()=>{
    const p=await readFile(ROOT+'synthetic-governance-plan.json'),r=await readFile(ROOT+'synthetic-governance-execution.json');
    need(sha(p)===ORIGINAL_PLAN && sha(r)===ORIGINAL_RECEIPT,'ORIGINAL_BYTES_CHANGED');
    return {plan:JSON.parse(p),receipt:JSON.parse(r)};
  };
  let writes=0;
  const aws=async command=>{
    const key=command[0]+'/'+command[1];
    const reads=['sts/get-caller-identity','ecs/describe-services','ecs/describe-task-definition','ecs/list-tasks','ecs/describe-tasks','ecr/describe-images','elbv2/describe-target-groups','elbv2/describe-target-health'];
    if(key==='ecs/update-service') need(process.argv[2]==='run' && ++writes===1 && JSON.stringify(command)===JSON.stringify(['ecs','update-service','--cluster','capiro-dev','--service','capiro-dev-api','--task-definition',CANDIDATE]),'SINGLE_EXACT_UPDATE_REQUIRED');
    else need(reads.includes(key),'OPERATION_FORBIDDEN');
    const {stdout}=await execute(resolveAwsCli(),[...command,'--profile','default','--region','us-east-1','--output','json','--no-cli-pager'],{windowsHide:true,timeout:60000,maxBuffer:16*1024*1024});
    return JSON.parse(stdout);
  };
  const exclusive=async(file,value)=>{const handle=await open(ROOT+file,'wx');try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}};
  const operator=createRecovery({aws,originals,currentMain,selfHash});
  if(process.argv.length===3 && process.argv[2]==='prepare'){
    const plan=await operator.prepare(); await exclusive('synthetic-governance-recovery-plan.json',plan);
    console.log(JSON.stringify({status:'PREPARED',planHash:fingerprint(plan)})); return;
  }
  need(process.argv.length===5 && process.argv[2]==='run' && /^[a-f0-9]{64}$/u.test(process.argv[3]) && process.argv[4]==='UPDATE_EXISTING_API489_ONCE','ARGUMENTS');
  const plan=JSON.parse(await readFile(ROOT+'synthetic-governance-recovery-plan.json','utf8'));
  await exclusive('synthetic-governance-recovery.lock',{planHash:process.argv[3],status:'CLAIMED'});
  await exclusive('synthetic-governance-recovery-execution.json',{planHash:process.argv[3],status:'CLAIMED'});
  const result=await operator.run(plan,process.argv[3],value=>persistReceipt(ROOT+'synthetic-governance-recovery-execution.json',value));
  console.log(JSON.stringify({status:result.status,deploymentId:result.deploymentId,updateSubmissions:result.updateSubmissions}));
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) cli().catch(()=>{console.error('GOVERNANCE_RECOVERY_BLOCKED_RECONCILE_RECEIPT');process.exitCode=1;});
