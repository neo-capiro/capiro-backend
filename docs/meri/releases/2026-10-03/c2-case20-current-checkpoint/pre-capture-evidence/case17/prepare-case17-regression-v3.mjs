// Local-only refresh of the existing read-only collector; no auth or cloud calls.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sha256Stable } from '../../meri-c1-20261002/evals/meri/live-v1/lib/stable.mjs';
const repo='C:/dev/main/meri-c1-20261002', root='C:/dev/main/outputs/meri-c2-20261003';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const save=(name,value)=>writeFileSync(root+'/'+name,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const prepared=read('case17-regression-v2-prepared.json'), prior=read('case17-regression-v2-result.json');
assert.equal(sha(readFileSync(root+'/case17-regression-v2-prepared.json')),'118a55f5005c07a9dfc535887afb210d965d5e283e72b9cd785368436e854fca');
assert.equal(prior.status,'UI_SLICE_PASS'); assert.equal(prior.sessionRevoked,true);
assert.equal(sha256Stable(prepared.config.recipe),'853dbf7f1e839639658e6cb9e2575fd4ef31fccf9d67b339d8ae4894537807d6');
const apiSource='4f0253874357c272fda1ae2a5271ee4af645f0bc';
const served=read('capture-contract-served-readback.json'), build=read('api-capture-contract-build-v2/build-readback.json');
assert.equal(served.status,'EXACT_RELEASE_AND_ORDINARY_IDENTITY_VERIFIED');
assert.equal(served.ordinaryIdentity.apiSourceSha,apiSource);
assert.equal(build.status,'SUCCEEDED'); assert.equal(build.sourceSha,apiSource);
assert.equal(build.buildId,'capiro-build-web-dev:5ca674e3-f986-46fa-bb05-2ca8e14d1d67');
assert.equal(build.buildspecSha256,'61cc399b632b885b2c17dfb692a536ba493246465573fb83469669c6267e2811');
prepared.at=new Date().toISOString();
prepared.sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
prepared.config.captureRunId=randomUUID();
prepared.config.deployment.apiSha=apiSource;
prepared.config.deployment.builds.api={service:'api',sourceSha:apiSource,
  imageDigest:'sha256:23f529da3c1c00d401968811575dc075bced6c60669baa9a09e9c23575c9c452',
  buildId:build.buildId,buildspecSha256:build.buildspecSha256};
assert.equal(served.services.find(s=>s.service==='api').baseline.imageDigest,prepared.config.deployment.builds.api.imageDigest);
assert.equal(served.services.find(s=>s.service==='web-vnext').baseline.imageDigest,prepared.config.deployment.builds['web-vnext'].imageDigest);
prepared.previousAttempt={path:'case17-regression-v2-result.json',sha256:sha(readFileSync(root+'/case17-regression-v2-result.json')),status:prior.status};
prepared.sourceFiles=prepared.sourceFiles.map(file=>{
 const bytes=readFileSync(repo+'/'+file.path), committed=execFileSync('git',['show',apiSource+':'+file.path],{cwd:repo,windowsHide:true});
 assert.equal(sha(bytes),sha(committed)); return {...file,sha256:sha(bytes)};
});
const uiPath='apps/web/src/vnext/meri/MeriMemoryTab.tsx';
const servedUi=execFileSync('git',['show',prepared.config.deployment.webSha+':'+uiPath],{cwd:repo,windowsHide:true});
assert.equal(sha(servedUi),sha(readFileSync(repo+'/'+uiPath)));
prepared.provenanceNavigation={status:'UNAVAILABLE_IN_SERVED_UI_SOURCE',sourcePath:uiPath,sourceSha256:sha(servedUi),
  reason:'Owned proposal cards expose plain source-kind text and Withdraw; no source-navigation link or control. Existing collector observes the cards without inventing a navigation target.',
  canonicalSourceBinding:'Distinct ownership markers are checked by existing current-owner joins; this is not distinct-source UI navigation.'};
prepared.servedReadbackSha256=sha(readFileSync(root+'/capture-contract-served-readback.json'));
let driver=readFileSync(root+'/run-case17-regression-v2.mjs','utf8')
 .replaceAll('case17-regression-v2','case17-regression-v3').replaceAll('case17-v2-owned-session','case17-v3-owned-session');
const oldLine="originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false,fullFile01Acceptance:false};";
assert.equal(driver.split(oldLine).length,2);
driver=driver.replace(oldLine,"originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false,fullFile01Acceptance:false,provenanceNavigation:input.provenanceNavigation};");
save('case17-regression-v3-prepared.json',prepared);
writeFileSync(root+'/run-case17-regression-v3.mjs',driver,{flag:'wx'});
save('case17-regression-v3-local-review.json',{status:'READY_FOR_ROOT_SOURCE_REVIEW_NOT_EXECUTED',
 sourceSha:prepared.sourceSha,apiSource,webSource:prepared.config.deployment.webSha,
 recipeSha256:sha256Stable(prepared.config.recipe),captureRunId:prepared.config.captureRunId,
 preparedSha256:sha(readFileSync(root+'/case17-regression-v3-prepared.json')),driverSha256:sha(Buffer.from(driver)),
 changes:['Output prefix and fresh run ID only; original fixture/actor unchanged','API immutable build pins refreshed from verified release; Web unchanged','Recorded unavailable source navigation without changing collector or guards'],
 collectorChanges:0,sourceFiles:prepared.sourceFiles.length,applicationWrites:0,providerCalls:0,
 originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false,
 provenanceNavigation:prepared.provenanceNavigation});
console.log(JSON.stringify({status:'LOCAL_V3_PREPARED_NOT_EXECUTED',captureRunId:prepared.config.captureRunId,sourceFiles:prepared.sourceFiles.length,driverSha256:sha(Buffer.from(driver))}));
