import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {restoreReviewedPeManifest} from '../../../scripts/lib/reviewed-pe-manifest-contract.mjs';

const BASE='b7aa1d6e6b341f833fa08b2add8f40d5fbee8480';
const SOURCE='ce14fb20b60426fe465ae8ad3eb33f2d23cd7bbc';
const show=(ref,file)=>execFileSync('git',['show',ref+':'+file]);
const rows=[];function check(name,fn){fn();rows.push({name,pass:true});}
const root=fs.readFileSync(path.resolve('package.json'));
const api=fs.readFileSync(path.resolve('apps/api/package.json'));
const beforeRoot=show(BASE,'package.json'),beforeApi=show(BASE,'apps/api/package.json');
for(const[kind,bytes,expected]of[['root',root,beforeRoot],['api',api,beforeApi]]){
  check('exact '+kind+' string whole byte reconstruction',()=>assert.deepEqual(Buffer.from(restoreReviewedPeManifest(bytes.toString(),kind)),expected));
  check('exact '+kind+' Buffer whole byte reconstruction',()=>assert.deepEqual(Buffer.from(restoreReviewedPeManifest(bytes,kind)),expected));
  check('unreviewed prior '+kind+' bytes refuse',()=>assert.throws(()=>restoreReviewedPeManifest(expected,kind)));
  check('CRLF '+kind+' bytes refuse',()=>assert.throws(()=>restoreReviewedPeManifest(bytes.toString().replaceAll('\n','\r\n'),kind)));
  check('extra newline '+kind+' bytes refuse',()=>assert.throws(()=>restoreReviewedPeManifest(Buffer.concat([bytes,Buffer.from('\n')]),kind)));
}
const raw=api.toString();
const declaration='    "test:pe-phase-9-migration-discovery": "node --test scripts/lib/pe-phase-9-migration-discovery.spec.mjs scripts/lib/pe-phase-9-owned-postgres.spec.mjs",\n';
const prefix='pnpm run test:pe-phase-9-migration-discovery && ';
assert.equal(raw.split(declaration).length,2);assert.equal(raw.split(prefix).length,2);
for(const[name,change]of[
  ['missing native declaration',s=>s.replace(declaration,'')],
  ['missing native trust prefix',s=>s.replace(prefix,'')],
  ['duplicate native declaration',s=>s.replace(declaration,declaration+declaration)],
  ['duplicate native prefix',s=>s.replace(prefix,prefix+prefix)],
  ['fallthrough semicolon native prefix',s=>s.replace(prefix,'pnpm run test:pe-phase-9-migration-discovery; ')],
  ['native failure suppression',s=>s.replace(prefix,'pnpm run test:pe-phase-9-migration-discovery || true && ')],
  ['native helper omitted',s=>s.replace('node --test scripts/lib/pe-phase-9-migration-discovery.spec.mjs scripts/lib/pe-phase-9-owned-postgres.spec.mjs','node --test scripts/lib/pe-phase-9-migration-discovery.spec.mjs')],
  ['native helper skip switch',s=>s.replace('node --test scripts/lib/pe-phase-9-migration-discovery.spec.mjs','node --test --test-skip-pattern=.* scripts/lib/pe-phase-9-migration-discovery.spec.mjs')],
  ['real docker command substituted',s=>s.replace('node --test scripts/lib/pe-phase-9-migration-discovery.spec.mjs scripts/lib/pe-phase-9-owned-postgres.spec.mjs','docker run postgres')],
  ['one legacy phase nine test dropped',s=>s.replace(' scripts/lib/pe-phase-9-runner.spec.ts','')],
  ['native prefix moved to suffix',s=>s.replace(prefix,'').replace(' && tsx scripts/verify-pe-phase-k.ts',' && tsx scripts/verify-pe-phase-k.ts && pnpm run test:pe-phase-9-migration-discovery')],
])check(name+' refuses',()=>{const changed=change(raw);assert.notEqual(changed,raw);assert.throws(()=>restoreReviewedPeManifest(changed,'api'))});
for(const[kind,bytes]of[['root',root],['api',api]]){
  const original=JSON.parse(bytes);
  for(const[name,change]of[
    ['full acceptance narrowed',v=>{v.scripts['verify:pe-phase-9:full']+=' --backend-only'}],
    ['default mode narrowed',v=>{v.scripts['verify:pe-phase-9']+=' --backend-only'}],
    ['full acceptance removed',v=>{delete v.scripts['verify:pe-phase-9:full']}],
    ['dependency drift',v=>{v.dependencies={...v.dependencies,unreviewed:'1.0.0'}}],
    ['metadata drift',v=>{v.description='unreviewed description'}],
    ['unknown script',v=>{v.scripts['unreviewed']='node unreviewed.mjs'}],
  ])check(kind+' '+name+' refuses',()=>{const v=structuredClone(original);change(v);assert.throws(()=>restoreReviewedPeManifest(JSON.stringify(v,null,2)+'\n',kind))});
  for(const position of [0,Math.floor(bytes.length/2),bytes.length-1])check(kind+' physical byte mutation '+position+' refuses',()=>{
    const changed=Buffer.from(bytes);changed[position]^=1;assert.throws(()=>restoreReviewedPeManifest(changed,kind));
  });
}
check('prior API profile without native changes is now a stale input',()=>assert.throws(()=>restoreReviewedPeManifest(show('457e84e7d50f401985355cf22eedc480fd72ad8b','apps/api/package.json'),'api')));
check('root/API kind mismatch refuses',()=>{assert.throws(()=>restoreReviewedPeManifest(api,'root'));assert.throws(()=>restoreReviewedPeManifest(root,'api'))});
let coercions=0;const object={toString(){coercions++;return'api'}};
for(const kind of [undefined,null,'frontend','__proto__',object,12])check('unknown kind '+rows.length+' refuses',()=>assert.throws(()=>restoreReviewedPeManifest(api,kind)));
for(const value of [object,12,null,undefined,new Uint8Array(api)])check('unreviewed input type '+rows.length+' refuses',()=>assert.throws(()=>restoreReviewedPeManifest(value,'api')));
assert.equal(coercions,0);
fs.writeFileSync(new URL('./manifest-controls.json',import.meta.url),JSON.stringify({source:SOURCE,rows,passed:rows.length,failed:0,coercions,
  scope:'pure exact-byte input controls; readonly four pinned Git blob operands only; no operator/native/Docker/app execution'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:rows.length,failed:0,coercions}));
