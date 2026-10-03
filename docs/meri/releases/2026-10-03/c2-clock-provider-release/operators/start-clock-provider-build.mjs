import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {aws, need} from '../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from './aws-single-attempt.mjs';

const sha='5b086a6b47ffce5aa1b93bfe38f9c7b96e297642';
const specs={api:'c92763d03d141e59d18485c4d9f6ac3958392ff18e0bbaf501dd116cc39f4c3c','meriv2-orchestrator':'0b458ceac2cb7d9e3d1b2b14c932629f473682ade5f354ca7de3924e2a4bc6b0'};
const [service,...ids]=process.argv.slice(2);
need(Object.hasOwn(specs,service),'EXACT_SERVICE_REQUIRED');
need(ids.length===2&&new Set(ids).size===2&&ids.every(id=>/^[0-9]+$/.test(id)),'EXACT_TWO_FAILED_ACTION_RUNS_REQUIRED');
const root=`C:/dev/main/outputs/meri-c2-20261003/${service}-clock-build-v2`;
need(!existsSync(root+'/build-input.json')&&!existsSync(root+'/build-start.json'),'PRIOR_INTENT_REQUIRES_RECONCILIATION');
const gh=(args)=>JSON.parse(execFileSync('gh',['api',...args],{encoding:'utf8',windowsHide:true}));
const main=gh(['repos/neo-capiro/capirov2/git/ref/heads/main']);
need(main.object.sha===sha,'REMOTE_MAIN_DRIFT');
const actions=[];
for(const id of ids){
  const run=gh([`repos/neo-capiro/capirov2/actions/runs/${id}`]);
  const jobs=gh([`repos/neo-capiro/capirov2/actions/runs/${id}/jobs`]);
  need(run.head_sha===sha&&run.status==='completed'&&run.conclusion==='startup_failure'&&jobs.total_count===0,'ACTIONS_FAILURE_UNVERIFIED');
  actions.push({id:run.id,url:run.html_url,headSha:run.head_sha,status:run.status,conclusion:run.conclusion,name:run.name,path:run.path,jobs:jobs.total_count});
}
const identity=aws(['sts','get-caller-identity']);
need(identity.Account==='967807252336'&&identity.Arn==='arn:aws:iam::967807252336:user/capirocli','EXACT_CALLER_REQUIRED');
const project=aws(['codebuild','batch-get-projects','--names','capiro-build-web-dev']).projects?.[0];
need(project?.source.type==='GITHUB'&&project.source.location==='https://github.com/neo-capiro/capirov2.git'&&project.environment.type==='ARM_CONTAINER'&&project.environment.privilegedMode===true,'PROJECT_DRIFT');
const buildspec=readFileSync(root+'/buildspec.yml','utf8');
const specHash=createHash('sha256').update(buildspec).digest('hex');
need(specHash===specs[service],'BUILDSPEC_DRIFT');
const request={projectName:project.name,sourceVersion:sha,buildspecOverride:buildspec,environmentVariablesOverride:[{name:'EXPECTED_SHA',value:sha,type:'PLAINTEXT'}],idempotencyToken:randomUUID(),timeoutInMinutesOverride:45};
writeFileSync(root+'/build-input.json',JSON.stringify(request,null,2)+'\n',{flag:'wx'});
writeFileSync(root+'/launch-intent.json',JSON.stringify({recordedAt:new Date().toISOString(),service,sourceSha:sha,buildspecSha256:specHash,actions,callerArn:identity.Arn,requestSha256:createHash('sha256').update(readFileSync(root+'/build-input.json')).digest('hex'),idempotencyToken:request.idempotencyToken,scope:'Immutable ARM image build and ECR publication only; no service/config/database or provider mutation'},null,2)+'\n',{flag:'wx'});
const result=awsSingleAttempt(['codebuild','start-build','--cli-input-json','file://'+root+'/build-input.json']);
need(result.build?.id&&result.build.sourceVersion===sha,'BUILD_START_UNCONFIRMED_RECONCILE_INTENT');
const receipt={service,buildId:result.build.id,sourceSha:sha,status:result.build.buildStatus,buildspecSha256:specHash,actions,actionsLimitation:'Exact-SHA GitHub startup failures have blank names and BuildFailed paths; both have zero jobs',callerArn:identity.Arn,startedAt:new Date().toISOString(),scope:'C2 clock/provider immutable candidate qualification; no service/database/configuration/provider changes'};
writeFileSync(root+'/build-start.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt,null,2));
