import fs from 'node:fs';
import assert from 'node:assert/strict';
import {NEWSLETTER_ACCEPTED_SOURCE_PROFILE as PROFILE, inspectNewsletterSourceAdmission,
  assertAcceptedNewsletterArtifactSource, readAcceptedFrontendStandaloneArtifact,
  parseFrontendStandaloneInvocation} from '../../../scripts/lib/frontend-standalone-artifact-contract.mjs';
import {parseNewsletterBuildInvocation, createNewsletterArtifactPackagingPlan,
  assembleNewsletterReleaseArtifact} from '../../../scripts/lib/newsletter-artifact-packaging-plan.mjs';

const CURRENT='c8aa693e884de86001d2fc04fbb60d48db09341c';
const TREE='9d11bfbd7121887bc06f5cb793e8a4c4e6e682b4';
const EVIDENCE='46ebdd448ef55e88c7a4083fb4586322757a14f8';
const HISTORICAL='7c87678730538958ace9762f824dc3e588bf445b';
const hash='cf99a4f3a9799f94f80b73ab283d5538c14fb41d9fa403a6af1bd72295c9cf33';
const pins=(commit=CURRENT,arch='amd64')=>({sourceRepository:'neo-capiro/capiro-frontend',sourceCommit:commit,
  manifestSha256:'a'.repeat(64),runtimeTarget:{os:'linux',arch,libc:'musl',nodeMajor:24}});
const options=(commit=CURRENT)=>({standaloneDir:'/synthetic/standalone',publicDir:'/synthetic/public',
  staticDir:'/synthetic/static',manifestPath:'/synthetic/manifest.json',manifestSha256:'a'.repeat(64),
  sourceRepository:'neo-capiro/capiro-frontend',sourceCommit:commit,targetPlatform:'linux/amd64',targetLibc:'musl',
  targetNodeMajor:'24',backendSourceCommit:'b'.repeat(40),outputDir:'/synthetic/output'});
const buildArgs=(mode,commit=CURRENT)=>{const o=options(commit),names=['standalone-dir','public-dir','static-dir','manifest',
  'manifest-sha256','source-repository','source-commit','target-platform','target-libc','target-node-major','backend-source-commit','output-dir'];
  return[mode,...names.flatMap((n,i)=>['--'+n,Object.values(o)[i]])];};
const shippingArgs=commit=>['--artifact-dir','/synthetic/artifact','--manifest-sha256','a'.repeat(64),
  '--source-repository','neo-capiro/capiro-frontend','--source-commit',commit,'--target-platform','linux/amd64',
  '--target-libc','musl','--target-node-major','24'];
const rows=[];
async function check(name,fn){await fn();rows.push({name,pass:true});}
function falseProofs(r){for(const key of ['sourceApprovalProofVerified','independentFrontendQualificationVerified',
  'buildUsedSourceVerified','nativeRuntimeCompatibilityVerified'])assert.equal(r[key],false,key);}

await check('exact current singleton source tree and qualification receipt binding',()=>{
  assert.equal(PROFILE.activeCommit,CURRENT);assert.equal(PROFILE.acceptedSources.length,1);
  assert.deepEqual(PROFILE.acceptedSources[0],{commit:CURRENT,tree:TREE,qualificationReceipt:{
    repository:'neo-capiro/capiro-frontend',commit:EVIDENCE,
    path:'docs/newsletter-receiving-final-20261013/QUALIFICATION.md',sha256:hash}});
});
await check('reviewed policy and nested evidence are immutable',()=>{
  for(const item of [PROFILE,PROFILE.acceptedSources,PROFILE.acceptedSources[0],
    PROFILE.acceptedSources[0].qualificationReceipt,PROFILE.runtimeProfile,PROFILE.runtimeProfile.architectures])assert(Object.isFrozen(item));
  assert.throws(()=>{PROFILE.activeCommit=HISTORICAL},TypeError);
  assert.throws(()=>PROFILE.acceptedSources.push({}),TypeError);
});
for(const arch of ['amd64','arm64'])await check('current source admitted for declared '+arch+' with all proof gates false',()=>{
  const r=assertAcceptedNewsletterArtifactSource(pins(CURRENT,arch));assert.equal(r.status,'accepted');
  assert.equal(r.sourceAcceptedByReviewedPolicy,true);assert.equal(r.syntheticSourceApprovalModel,false);
  assert.equal(r.assemblyAdmissionAllowed,true);falseProofs(r);
});
await check('current plan declares approval but performs no assembly',()=>{
  const r=createNewsletterArtifactPackagingPlan(options());assert.equal(r.sourceAdmission.status,'accepted');
  assert.equal(r.assemblyPerformed,false);assert.equal(r.sourceOnly,true);falseProofs(r.sourceAdmission);
});
await check('current run syntax admits exact source without touching artifact filesystem',()=>{
  const r=parseNewsletterBuildInvocation(buildArgs('--run'));assert.equal(r.mode,'run');assert.equal(r.options.sourceCommit,CURRENT);
});
for(const commit of [HISTORICAL,'0'.repeat(40),CURRENT.toUpperCase()])await check('stale arbitrary or noncanonical source refuses '+commit,async()=>{
  let calls=0;const port=()=>{calls++;throw Error('should never inspect artifact')};
  assert.throws(()=>assertAcceptedNewsletterArtifactSource(pins(commit)));
  await assert.rejects(readAcceptedFrontendStandaloneArtifact({pins:pins(commit),artifactDir:'/synthetic/artifact',
    ports:{lstat:port,readdir:port,realpath:port,readFile:port,readlink:port}}));
  await assert.rejects(assembleNewsletterReleaseArtifact(options(commit),{io:{lstat:port},fixtureLabel:'refused artifact'}));
  assert.equal(calls,0);
});
for(const [key,value] of [['libc','glibc'],['arch','unknown'],['nodeMajor',22],['os','windows']])await check('runtime mismatch refuses before artifact ports '+key,async()=>{
  const p=pins();p.runtimeTarget[key]=value;let calls=0;const port=()=>{calls++;throw Error('artifact')};
  assert.throws(()=>assertAcceptedNewsletterArtifactSource(p));
  await assert.rejects(readAcceptedFrontendStandaloneArtifact({pins:p,artifactDir:'/synthetic/artifact',ports:{lstat:port}}));
  assert.equal(calls,0);assert.equal(p.runtimeTarget[key],value);
});
await check('foreign repository refuses source admission',()=>{
  const p=pins();p.sourceRepository='foreign/repository';assert.throws(()=>assertAcceptedNewsletterArtifactSource(p));
});
await check('admission reaches only fake canonical artifact validation port for current source',async()=>{
  let calls=0;const stop=new Error('independent fake filesystem stop');
  await assert.rejects(readAcceptedFrontendStandaloneArtifact({pins:pins(),artifactDir:'/synthetic/artifact',
    ports:{lstat:()=>{calls++;throw stop}}}),error=>error===stop);
  assert.equal(calls,1);
});
await check('environment cannot activate stale source or promote any proof',()=>{
  const keys=['NEWSLETTER_ACCEPTED_SOURCE','NEWSLETTER_SOURCE_PROFILE','FRONTEND_ARTIFACT_SOURCE_COMMIT'];
  const prior=keys.map(k=>[k,process.env[k]]);
  try{for(const k of keys)process.env[k]=HISTORICAL;
    assert.throws(()=>assertAcceptedNewsletterArtifactSource(pins(HISTORICAL)));
    const r=assertAcceptedNewsletterArtifactSource(pins());assert.equal(r.status,'accepted');falseProofs(r);
  }finally{for(const[k,v]of prior)if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
for(const flag of ['--source-profile','--source-admission-fixture','--accepted-source'])await check('extra policy CLI operand refuses '+flag,()=>{
  assert.throws(()=>parseFrontendStandaloneInvocation([...shippingArgs(CURRENT),flag,'{}']));
  assert.throws(()=>parseNewsletterBuildInvocation([...buildArgs('--run'),flag,'{}']));
});
await check('unlabelled caller profile cannot masquerade as reviewed data',()=>{
  assert.throws(()=>assertAcceptedNewsletterArtifactSource(pins(HISTORICAL),{sourceAdmissionFixture:PROFILE}));
});
await check('explicit historical source model remains synthetic with no reviewed approval',()=>{
  const profile=structuredClone(PROFILE);profile.activeCommit=HISTORICAL;
  profile.acceptedSources=[{...profile.acceptedSources[0],commit:HISTORICAL}];
  const r=assertAcceptedNewsletterArtifactSource(pins(HISTORICAL),{sourceAdmissionFixture:{
    kind:'newsletter-source-admission-fixture',label:'independent historical inert policy',profile}});
  assert.equal(r.status,'fixture-accepted');assert.equal(r.syntheticSourceApprovalModel,true);
  assert.equal(r.sourceAcceptedByReviewedPolicy,false);falseProofs(r);
});
await check('ignored noncanonical profile option cannot admit historical source',()=>{
  assert.throws(()=>assertAcceptedNewsletterArtifactSource(pins(HISTORICAL),{sourceProfile:{activeCommit:HISTORICAL}}));
});
let callbacks=0;
for(const where of ['fixture','profile'])await check('ordinary accessor fixture refuses without invoking '+where,()=>{
  const fixture={kind:'newsletter-source-admission-fixture',label:'independent accessor',profile:structuredClone(PROFILE)};
  const owner=where==='fixture'?fixture:fixture.profile,key=where==='fixture'?'profile':'activeCommit';
  Object.defineProperty(owner,key,{enumerable:true,get(){callbacks++;throw Error('getter')}});
  assert.throws(()=>assertAcceptedNewsletterArtifactSource(pins(),{sourceAdmissionFixture:fixture}));assert.equal(callbacks,0);
});
await check('strict architecture values remain no-coercion after activation',()=>{
  const values=[{toString(){callbacks++;return'amd64'}},new Proxy({},{get(){callbacks++;throw Error('proxy')}}),Symbol('amd64'),64];
  for(const value of values){const profile=structuredClone(PROFILE);profile.runtimeProfile.architectures[0]=value;
    assert.throws(()=>assertAcceptedNewsletterArtifactSource(pins(CURRENT,'arm64'),{sourceAdmissionFixture:{
      kind:'newsletter-source-admission-fixture',label:'independent malformed runtime',profile}}));}
  assert.equal(callbacks,0);
});
const report={rows,passed:rows.length,failed:0,callbacks,actualArtifactFilesystemCalls:0,
  qualifiedSource:CURRENT,qualificationEvidence:EVIDENCE,scope:'pure policy and supplied fake ports; no actual application/artifact/native execution'};
fs.writeFileSync(new URL('./activation-controls.json',import.meta.url),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:rows.length,failed:0,callbacks}));
