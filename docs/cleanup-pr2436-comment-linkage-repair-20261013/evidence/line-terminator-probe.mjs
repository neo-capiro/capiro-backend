import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateOnboardSpaArtifact,ONBOARD_PUBLIC_ASSETS} from '../../../scripts/lib/onboard-spa-artifact-contract.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const baseline='b5ddf4556b86d0169dd4f77d0b9da971f0c7dc08';
const publicBytes=Object.keys(ONBOARD_PUBLIC_ASSETS).map(p=>[p,execFileSync('git',['show',baseline+':apps/onboard-web/public/'+p])]);
function fixture(code,css='body{color:navy}'){
const files=new Map([['index.html',Buffer.from('<!doctype html><html><head><link rel="stylesheet" href="/assets/main.css"></head><body><script type="module" src="/assets/main.js"></script></body></html>')],['assets/main.js',Buffer.from(code)],['assets/main.css',Buffer.from(css)],...publicBytes]);
const manifest={schemaVersion:1,artifactType:'capiro-onboard-static-spa',source:{repository:'fixtures/review-static-source',commit:'a'.repeat(40)},files:[...files].map(([path,b])=>({path,bytes:b.length,sha256:sha(b)}))};
const manifestBytes=Buffer.from(JSON.stringify(manifest));return[{manifestBytes,files},{manifestSha256:sha(manifestBytes),sourceRepository:manifest.source.repository,sourceCommit:manifest.source.commit}];}
const cases=[
['CRLF line comment control','import//review\r\n"react";',true],
['LS line comment','import//review\u2028"react";',true],
['PS line comment','import//review\u2029"react";',true],
['valid simple control','export const valid=1;',false],
];
const results=cases.map(([name,code,expectedRefusal])=>{let accepted,error;try{validateOnboardSpaArtifact(...fixture(code));accepted=true;}catch(e){accepted=false;error=String(e.message);}return{name,code,expectedRefusal,accepted,error:error??null,pass:accepted!==expectedRefusal};});
console.log(JSON.stringify({source:'eaf96f418bc621f6cc3f6339c094ef4a18b8b9f2',scope:'inert ECMAScript line-comment boundary strings; no code execution',results,pass:results.filter(r=>r.pass).length,red:results.filter(r=>!r.pass).length},null,2));
