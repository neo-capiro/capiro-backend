// Local-only current deployment/collector binding; no seed, auth or provider calls.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {sha256Stable} from '../../meri-c1-20261002/evals/meri/live-v1/lib/stable.mjs';
const repo='C:/dev/main/meri-c1-20261002',root='C:/dev/main/outputs/meri-c2-20261003',source='c0f393f863bf73bd4e65e7a94e17c073e7be021e';
const sha=b=>createHash('sha256').update(b).digest('hex'),read=n=>JSON.parse(readFileSync(root+'/'+n));
const save=(n,v)=>writeFileSync(root+'/'+n,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const prepared=read('case17-regression-v3-prepared.json'),prior=read('case17-regression-v3-result.json');
assert.equal(prior.status,'UI_SLICE_PASS');assert.equal(prior.sessionRevoked,true);
assert.equal(sha256Stable(prepared.config.recipe),'853dbf7f1e839639658e6cb9e2575fd4ef31fccf9d67b339d8ae4894537807d6');
const served=read('combined-c2-served-readback-v1.json');assert.equal(served.status,'EXACT_RELEASE_AND_ORDINARY_IDENTITY_VERIFIED');assert.equal(served.ordinaryIdentity.apiSourceSha,source);
const retired=read('combined-c2-retired-tasks-v1.json');assert.equal(retired.status,'EXACT_PREVIOUS_SERVICE_TASKS_STOPPED');assert.equal(retired.servedReadbackSha256,sha(readFileSync(root+'/combined-c2-served-readback-v1.json')));
const localQualification=read('case17-served-provenance-qualification-v1/checkpoint.json');assert.equal(localQualification.status,'PASS');
for(const file of localQualification.sourceFiles)assert.equal(sha(readFileSync(repo+'/'+file.path)),file.sha256);
assert.equal(sha(readFileSync(root+'/case17-served-provenance-qualification-v1/tests.log')),localQualification.testLogSha256);
const operatorSource=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
prepared.at=new Date().toISOString();prepared.sourceSha=operatorSource;prepared.config.captureRunId=randomUUID();
for(const service of ['api','web-vnext']){
 const b=read(service+'-combined-c2-build-v'+(service==='api'?'2':'1')+'/build-readback.json');assert.equal(b.status,'SUCCEEDED');assert.equal(b.qualification,'IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS');assert.equal(b.sourceSha,source);
 const digest=b.image.split('@')[1];assert.equal(served.services.find(s=>s.service===service).baseline.imageDigest,digest);
 prepared.config.deployment[service==='api'?'apiSha':'webSha']=source;
 prepared.config.deployment.builds[service]={service,sourceSha:source,imageDigest:digest,buildId:b.buildId,buildspecSha256:b.buildspecSha256};
}
prepared.previousAttempt={path:'case17-regression-v3-result.json',sha256:sha(readFileSync(root+'/case17-regression-v3-result.json')),status:prior.status,scope:'Prior source-kind-only UI slice; does not prove new expandable source details.'};
const allowedLocalChanges=new Set(['evals/meri/live-v1/case17-memory-ui.mjs','evals/meri/live-v1/case17-saved-checks.mjs']);
prepared.sourceFiles=prepared.sourceFiles.map(f=>{const b=readFileSync(repo+'/'+f.path),committed=execFileSync('git',['show',operatorSource+':'+f.path],{cwd:repo,windowsHide:true});assert.equal(sha(b),sha(committed));if(!allowedLocalChanges.has(f.path))assert.equal(sha(b),sha(execFileSync('git',['show',source+':'+f.path],{cwd:repo,windowsHide:true})));return {...f,sha256:sha(b)};});
const uiPath='apps/web/src/vnext/meri/MeriMemoryTab.tsx',apiPath='apps/api/src/memory/governed-memory-candidate.service.ts';
for(const path of [uiPath,apiPath])assert.equal(sha(readFileSync(repo+'/'+path)),sha(execFileSync('git',['show',source+':'+path],{cwd:repo,windowsHide:true})));
prepared.provenanceNavigation={status:'SOURCE_DISCLOSURE_QUALIFIED_AWAITING_SERVED_CAPTURE',sourcePath:uiPath,sourceSha256:sha(readFileSync(repo+'/'+uiPath)),reason:'Existing Source details disclosure shows bounded recorded type and exact reference; no external navigation authority.',canonicalSourceBinding:'Each of six references must match its canonical fixture ownership marker and remain visible after reload.',operatorSourceSha:operatorSource};
prepared.servedReadbackSha256=sha(readFileSync(root+'/combined-c2-served-readback-v1.json'));
const driver=readFileSync(root+'/run-case17-regression-v3.mjs','utf8').replaceAll('case17-regression-v3','case17-regression-v4').replaceAll('case17-v3-owned-session','case17-v4-owned-session');
save('case17-regression-v4-prepared.json',prepared);writeFileSync(root+'/run-case17-regression-v4.mjs',driver,{flag:'wx'});
save('case17-regression-v4-local-review.json',{status:'PREPARED_NOT_EXECUTED',operatorSourceSha:operatorSource,apiSourceSha:source,webSourceSha:source,captureRunId:prepared.config.captureRunId,recipeSha256:sha256Stable(prepared.config.recipe),preparedSha256:sha(readFileSync(root+'/case17-regression-v4-prepared.json')),driverSha256:sha(Buffer.from(driver)),applicationWrites:0,providerCalls:0,originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false});
console.log(JSON.stringify({status:'LOCAL_V4_PREPARED_NOT_EXECUTED',captureRunId:prepared.config.captureRunId,operatorSourceSha:operatorSource,sourceFiles:prepared.sourceFiles.length}));
