import fs from 'node:fs';
import assert from 'node:assert/strict';
import {assembleNewsletterReleaseArtifact,createNewsletterArtifactPackagingPlan,parseNewsletterBuildInvocation,NEWSLETTER_FRONTEND_ARTIFACT_PROFILE as PROFILE} from '../../../scripts/lib/newsletter-artifact-packaging-plan.mjs';
const options={standaloneDir:'/synthetic/standalone',publicDir:'/synthetic/public',staticDir:'/synthetic/static',manifestPath:'/synthetic/producer.json',manifestSha256:'a'.repeat(64),sourceRepository:PROFILE.repository,sourceCommit:PROFILE.commit,targetPlatform:'linux/amd64',targetLibc:'musl',targetNodeMajor:'24',backendSourceCommit:'b'.repeat(40),outputDir:'/synthetic/output'};
const rows=[];
async function beforePorts(name,input,ports){let count=0,error;try{await assembleNewsletterReleaseArtifact(input,{io:{lstat:async()=>{count++;throw Error('CONTROLLED_INERT_STOP')}},...ports});}catch(e){error=e.message;}assert.equal(count,0,name);rows.push({name,count,error});}
for(const [name,extra]of [['unknown option',{unexpected:true}],['wrong repo',{sourceRepository:'other/repo'}],['wrong source',{sourceCommit:'c'.repeat(40)}],['wrong Node',{targetNodeMajor:'22'}],['wrong libc',{targetLibc:'glibc'}],['wrong architecture',{targetPlatform:'linux/x64'}],['invalid manifest checksum',{manifestSha256:'not-sha'}],['invalid backend identity',{backendSourceCommit:'not-git'}],['output same input',{outputDir:options.staticDir}],['output ancestor',{outputDir:'/synthetic'}],['output below input',{outputDir:options.publicDir+'/child'}]])await beforePorts(name,{...options,...extra},{fixtureLabel:'independent inert input refusal'});
for(const [name,ports]of [['unlabelled io',{}],['invalid label',{fixtureLabel:'bad\nlabel'}],['empty label',{fixtureLabel:''}],['nonfunction identity',{newsletterIdentity:42,fixtureLabel:'inert'}]])await beforePorts(name,options,ports);
for(const [name,bad]of [['negative',-1],['fractional',0.5],['exceeds request',65537],['not number','2']]){
 let closes=0,reads=0,wholeReads=0,error;
 const io={lstat:async p=>({size:2,isDirectory:()=>p!==options.manifestPath,isSymbolicLink:()=>false,isFile:()=>p===options.manifestPath}),realpath:async p=>p,open:async()=>({read:async()=>{reads++;return{bytesRead:bad}},readFile:async()=>{wholeReads++;throw Error('unbounded')},close:async()=>{closes++}})};
 try{await assembleNewsletterReleaseArtifact(options,{io,fixtureLabel:'independent malformed fd return'});}catch(e){error=e.message;}
 assert.match(error,/bounded snapshot read/);assert.equal(wholeReads,0);assert.equal(reads,1);assert.equal(closes,1);rows.push({name:'fd '+name,reads,closes,wholeReads,error});
}
for(const platform of ['linux/amd64','linux/arm64']){
 const plan=createNewsletterArtifactPackagingPlan({...options,targetPlatform:platform});
 assert(Object.isFrozen(plan));assert.equal(plan.runtimeTarget.arch,platform.split('/')[1]);
 for(const flag of ['assemblyPerformed','buildUsedSourceVerified','nativeRuntimeCompatibilityVerified','localServingVerified','uiAcceptanceVerified','shippingAuthorized'])assert.equal(plan[flag],false);
 rows.push({name:'pure plan '+platform,allAcceptanceFlagsFalse:true});
}
for(const args of [[],['--run'],['--plan'],['--help','--run']]){assert.throws(()=>parseNewsletterBuildInvocation(args));rows.push({name:'invalid argv '+JSON.stringify(args)});}
const result={source:'7ee13b8d26888a33377a29cf00637ca64b20bded',passed:rows.length,rows,scope:'inert callbacks and pure plan/argv only; no filesystem or payload effect'};
fs.writeFileSync(new URL('./boundary-controls.json',import.meta.url),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:rows.length,scope:result.scope}));
