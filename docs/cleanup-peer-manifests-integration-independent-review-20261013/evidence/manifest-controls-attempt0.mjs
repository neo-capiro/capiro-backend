import fs from 'node:fs';import assert from 'node:assert/strict';
import {restoreReviewedPeManifest,REVIEWED_PE_MANIFEST_SOURCE} from '../../../scripts/lib/reviewed-pe-manifest-contract.mjs';
const root=new URL('../../../',import.meta.url),rows=[];
function pass(name,fn){fn();rows.push(name);}
for(const[kind,file]of[['root','package.json'],['api','apps/api/package.json']]){
 const bytes=fs.readFileSync(new URL(file,root)),text=bytes.toString(),old=restoreReviewedPeManifest(bytes,kind);
 pass('buffer/string same '+kind,()=>assert.equal(restoreReviewedPeManifest(text,kind),old));
 pass('restoration idempotency refused '+kind,()=>assert.throws(()=>restoreReviewedPeManifest(old,kind),/Unreviewed/));
 for(const [name,mutate]of[
  ['format only',s=>s.replace('  "name"',' "name"')],
  ['CRLF',s=>s.replaceAll('\n','\r\n')],
  ['NUL append',s=>s+'\0'],
  ['new arbitrary alias',s=>s.replace('"scripts": {','"scripts": {"review-escape":"node wrong.mjs",')],
  ['backend skip install',s=>s.replace('verify:pe-phase-9:backend",','verify:pe-phase-9:backend --skip-install",')],
  ['legacy full changed',s=>s.replace('verify:pe-phase-9:full','verify:pe-phase-9:full-review-escape')],
  ['peer alias removed',s=>s.replace(/    "verify:pe-phase-9:backend": [^\n]+\n/,'')],
  ['dependency or metadata replaced',s=>s.replace('"private": true','"private": false')],
 ])pass(name+' '+kind,()=>{const changed=mutate(text);assert.notEqual(changed,text);assert.throws(()=>restoreReviewedPeManifest(changed,kind),/Unreviewed/);});
 pass('wrong kind '+kind,()=>assert.throws(()=>restoreReviewedPeManifest(bytes,kind==='root'?'api':'root'),/Unreviewed/));
}
let calls=0;const coercible={toString(){calls++;throw Error('must not coerce');}};
for(const kind of [coercible,null,'__proto__','constructor',new String('root')])pass('invalid kind '+rows.length,()=>assert.throws(()=>restoreReviewedPeManifest(Buffer.from('{}'),kind),/literal kind/));
for(const value of [coercible,{},[],new Uint8Array(1),null])pass('invalid source '+rows.length,()=>assert.throws(()=>restoreReviewedPeManifest(value,'root'),/literal kind/));
assert.equal(calls,0);
const result={source:'07e92408d9c396de2003259d125f828cc99c7e2c',peer:REVIEWED_PE_MANIFEST_SOURCE,passed:rows.length,rows,coercionCalls:0,scope:'pure supplied bytes only; no application/environment/process effect'};
fs.writeFileSync(new URL('./manifest-controls.json',import.meta.url),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:rows.length,coercionCalls:0}));
