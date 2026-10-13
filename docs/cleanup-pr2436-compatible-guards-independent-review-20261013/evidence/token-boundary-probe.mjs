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
['line-comment bare static import','import//review\n"react";',undefined,true],
['line-comment nonstatic dynamic import','import//review\n(variable);',undefined,true],
['line-comment bare export-from','export//review\n{x}//review\nfrom//review\n"react";',undefined,true],
['multiple block comments module','import/**/ /*gap*/ (/**/"react"/**/);',undefined,true],
['line-comment nonstatic newURL','const x=new//review\nURL//review\n(variable,import//review\n.//review\nmeta//review\n.//review\nurl);',undefined,true],
['comment-separated newURL wrong base','const x=new/**/URL/**/("../favicon.svg",otherBase);',undefined,true],
['unsupported unmatched import parenthesis','import/**/(variable',undefined,true],
['unsupported unmatched newURL parenthesis','const x=new/**/URL/**/(variable',undefined,true],
['comment-separated CSS url missing','export const valid=1;','body{background:url/**/("./missing.png")}',true],
['multiple CSS comment import missing','export const valid=1;','@import/**/ /*gap*/"./missing.css";',true],
['quoted remote module with comment text','import/**/"https://example.test/path/*literal*/x.js";',undefined,true],
['escaped module string preserved refusal','import/**/".\\/missing.js";',undefined,true],
['complete line-comment module with relative existing file','import//review\n"./main.js";',undefined,false],
['complete comment-separated newURL reference','const x=new/**/URL/**/(/**/"../favicon.svg"/**/,/**/import/**/./**/meta/**/./**/url/**/);',undefined,false],
['complete comment-separated CSS local reference','export const valid=1;','@import/**/"./main.css";body{background:url/**/("../favicon.svg")}',false],
['quoted CSS HTTPS URL is not comment-stripped','export const valid=1;','body{background:url/**/("https://example.test/path/*literal*/image.png")}',false],
['quoted CSS data URI comment text remains raw','export const valid=1;','body{background:url("data:image/svg+xml;utf8,<svg>/*literal*/</svg>")}',false],
['inert ordinary quoted JS comment text','const marker="/* literal */ // more literal";export const valid=1;',undefined,false],
];
const results=cases.map(([name,code,css,expectedRefusal])=>{let accepted,error;try{validateOnboardSpaArtifact(...fixture(code,css));accepted=true;}catch(e){accepted=false;error=String(e.message);}return{name,code,css:css??null,expectedRefusal,accepted,error:error??null,pass:accepted!==expectedRefusal};});
console.log(JSON.stringify({source:'3769ae8f091289e3a6e14ddcacef6beb9916bc36',scope:'inert recognized token-boundary and quoted-resource strings only; never executed as payloads',results,pass:results.filter(r=>r.pass).length,fail:results.filter(r=>!r.pass).length},null,2));
