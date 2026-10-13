import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const here = new URL('.',import.meta.url);
const after = await import(new URL('./after/scripts/lib/newsletter-declared-edge-contract.mjs',here));
const before = await import(new URL('./before/scripts/lib/newsletter-declared-edge-contract.mjs',here));
const sources = new Map(after.DECLARED_NEWSLETTER_EDGE_PINS.sources.map(p=>[p.path,fs.readFileSync(new URL('./after/'+p.path,here))]));
const options={sources,appHost:'app.capiro.ai',rootDomain:'capiro.ai',wildcardHost:'*.app.capiro.ai'};
const ac=after.projectDeclaredNewsletterEdge(options),bc=before.projectDeclaredNewsletterEdge(options);
assert.equal(JSON.stringify(ac),JSON.stringify(bc));
const base='/api/engagement/newsletter-public/'+'a'.repeat(64);
const rows=[];
function row(name,request,fn,expect){ rows.push(Object.freeze({name,request:Object.freeze(request),fn,expect})); }
for(const proto of ['ordinary','null']) for(const [one,two] of [['__proto__','__PROTO__'],['constructor','Constructor'],['toString','TOSTRING'],['hasOwnProperty','HASOWNPROPERTY'],['X-Extra','x-extra']]) {
 const h=Object.fromEntries([[one,'one'],[two,'two'],['X-Capiro-Engagement-Preview','v3']]);
 const headers=Object.freeze(proto==='null'?Object.assign(Object.create(null),h):h);
 for(const fn of ['selectDeclaredNewsletterTarget','matchesDeclaredNewsletterManualPreview'])row('duplicate '+proto+' '+one+' '+fn,{host:'app.capiro.ai',path:base+'/archive',headers},fn,'REFUSE');
}
for(const proto of ['ordinary','null'])for(const name of ['__proto__','__PROTO__','constructor','toString','hasOwnProperty']){
 const make=entries=>Object.freeze(proto==='null'?Object.assign(Object.create(null),Object.fromEntries(entries)):Object.fromEntries(entries));
 const headers=make([[name,'payload'],['X-Capiro-Engagement-Preview','v3']]);
 for(const [host,path,target]of [['app.capiro.ai',base+'/archive','api'],['app.capiro.ai','/newsletter/capitol.png','web'],['app.capiro.ai','/workspace-api/newsletters/assets/file/'+'a'.repeat(64),'workspace'],['capiro.ai','/newsletter/capitol.png','marketing']])row('single '+proto+' '+name+' '+target,{host,path,headers},'selectDeclaredNewsletterTarget',target);
 row('single exact preview '+proto+' '+name,{host:'app.capiro.ai',path:base+'/archive',headers},'matchesDeclaredNewsletterManualPreview',true);
 row('single alone '+proto+' '+name,{host:'app.capiro.ai',path:base+'/archive',headers:make([[name,'v3']])},'matchesDeclaredNewsletterManualPreview',false);
}
for(const headers of [Object.freeze({'bad name':'v3'}),Object.freeze({'bad':'newline\nvalue'}),Object.freeze({'bad':false}),Object.freeze(['v3']),Object.freeze({'x-capiro-engagement-preview':'v3','X-Capiro-Engagement-Preview':'v3'})])for(const fn of ['selectDeclaredNewsletterTarget','matchesDeclaredNewsletterManualPreview'])row('malformed '+rows.length,{host:'app.capiro.ai',path:base+'/archive',headers},fn,'REFUSE');
Object.freeze(rows);
const result={source:'bdcb6b4e02b6394fd24dbb709e17648d77caa88c',projectionBeforeAfterExact:true,rows:rows.length,positiveRows:rows.filter(r=>r.expect!=='REFUSE').length};
for(const[label,api,contract]of[['before',before,bc],['after',after,ac]]){
 const outcomes=rows.map(r=>{let value,refused=false,error;try{value=api[r.fn](contract,r.request);}catch(e){refused=true;error=e.message;}return{name:r.name,passed:r.expect==='REFUSE'?refused:!refused&&value===r.expect,refused,value,error};});
 result[label]={passed:outcomes.filter(r=>r.passed).length,failed:outcomes.filter(r=>!r.passed).length,outcomes};
}
assert.equal(result.before.failed,4);assert.equal(result.after.failed,0);
const supplementary=[];
function check(name,fn){fn();supplementary.push(name);}
for(const object of [ac,after.runtimeAcceptanceRequirements])for(const key of ['realLiveVerified','fullyQualified','deployedServingVerified','nativeServingVerified','uiVerified'])check('false '+(object===ac?'contract':'requirements')+' '+key,()=>assert.equal(object[key],false));
check('preview not authorization',()=>assert.equal(ac.manualPreview.headerIsAuthorization,false));
check('preview undeployed',()=>assert.equal(ac.manualPreview.deployedRuleVerified,false));
check('requirements backendHEAD false',()=>assert.equal(after.runtimeAcceptanceRequirements.backendHeadVerified,false));
check('source provenance frozen',()=>{assert(Object.isFrozen(ac.provenance.sources));assert.throws(()=>ac.provenance.sources[0].sha256='0'.repeat(64),TypeError);});
for(const fn of ['selectDeclaredNewsletterTarget','matchesDeclaredNewsletterManualPreview'])check('forged contract '+fn,()=>assert.throws(()=>after[fn]({...ac},{host:'app.capiro.ai',path:base+'/archive'}),/projected contract instance/));
for(const pin of after.DECLARED_NEWSLETTER_EDGE_PINS.sources)check('drift '+pin.path,()=>{const m=new Map(sources);m.set(pin.path,Buffer.concat([m.get(pin.path),Buffer.from('\n')]));assert.throws(()=>after.projectDeclaredNewsletterEdge({...options,sources:m}),/source pin mismatch/);});
check('map missing',()=>assert.throws(()=>after.projectDeclaredNewsletterEdge({...options,sources:new Map()}),/source Map/));
check('map extra',()=>assert.throws(()=>after.projectDeclaredNewsletterEdge({...options,sources:new Map([...sources,['fake',Buffer.from('')]])}),/source Map/));
check('uppercase request host preserved',()=>assert.equal(after.selectDeclaredNewsletterTarget(ac,{host:'APP.CAPIRO.AI',path:'/newsletter/capitol.png'}),'web'));
check('origin exact one slash',()=>assert.equal(after.resolveNewsletterPublicationOrigins({webPublicUrl:'https://web.example//'}).assetOrigin,'https://web.example/'));
result.supplementary={passed:supplementary.length,names:supplementary};
result.allRequestRowsFrozen=true;result.liveOrNativeAcceptance=false;
fs.writeFileSync(new URL('./header-controls.json',here),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({rows:result.rows,before:result.before.passed+'/'+result.rows,beforeEscapes:result.before.failed,after:result.after.passed+'/'+result.rows,positiveRows:result.positiveRows,supplementary:result.supplementary.passed,projectionBeforeAfterExact:true}));
