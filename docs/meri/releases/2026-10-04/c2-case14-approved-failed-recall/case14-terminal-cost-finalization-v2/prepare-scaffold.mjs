import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url)),previous=path.join(root,'../case14-terminal-cost-draft-v1');
const hash=b=>createHash('sha256').update(b).digest('hex');
const {SCOPE,RETAINED_PINS}=await import(new URL('../case14-terminal-cost-draft-v1/fixed.mjs',import.meta.url));
const pins={},provenance=[];fs.mkdirSync(path.join(root,'retained'));
for(const[name,p]of Object.entries(RETAINED_PINS)){
 const b=fs.readFileSync(p.path);if(hash(b)!==p.sha256||b.length!==p.bytes)throw Error('RETAINED_SOURCE_DRIFT');
 const target=path.join(root,'retained',name+path.extname(p.path));fs.writeFileSync(target,b,{flag:'wx'});
 pins[name]={...p,path:target.replaceAll('\\','/'),originalPath:p.path,encoding:name==='approvalBound'?'opaque-text':p.semanticSha256?'json':'raw'};
 provenance.push({name,original:p.path,copy:pins[name].path,bytes:b.length,sha256:hash(b)});
}
fs.writeFileSync(path.join(root,'fixed.mjs'),'export const RETAINED_PINS='+JSON.stringify(pins,null,2)+';\nexport const SCOPE='+JSON.stringify(SCOPE,null,2)+';\n',{flag:'wx'});
fs.copyFileSync(path.join(previous,'authority-draft.mjs'),path.join(root,'predicate.mjs'),fs.constants.COPYFILE_EXCL);
fs.copyFileSync(path.join(previous,'journal25-reconstructed-from-retained.jsonl'),path.join(root,'journal25-reconstructed-from-retained.jsonl'),fs.constants.COPYFILE_EXCL);
fs.mkdirSync(path.join(root,'native'));
for(const name of['windows-artifact-protocol.py','windows-owned-artifacts.py']){
 const src='C:/dev/main/meri-c1-20261002/evals/meri/live-v1/lib/'+name,b=fs.readFileSync(src),target=path.join(root,'native',name);fs.writeFileSync(target,b,{flag:'wx'});provenance.push({original:src,copy:target,sha256:hash(b),bytes:b.length});
}
const originalNative=fs.readFileSync(path.join(previous,'windows-capture-spend.draft.py'),'utf8');
const adaptedNative=originalNative.replace("protocol = runpy.run_path(r'C:/dev/main/meri-c1-20261002/evals/meri/live-v1/lib/windows-artifact-protocol.py')","protocol = runpy.run_path(str(pathlib.Path(__file__).with_name('windows-artifact-protocol.py')))");
if(adaptedNative===originalNative)throw Error('NATIVE_DEPENDENCY_SEAM_MISSING');
fs.writeFileSync(path.join(root,'native/windows-capture-spend.py'),adaptedNative,{flag:'wx'});
fs.copyFileSync('C:/dev/main/meri-c1-20261002/evals/meri/live-v1/tests/fixtures/case01-failed-receipt-authorization.unit.json',path.join(root,'authorization-exact-retained.json'),fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(root,'copy-provenance.json'),JSON.stringify({copiedAt:new Date().toISOString(),kind:'EXACT_LOCAL_COPIES_NO_NEW_LIVE_OBSERVATION',files:provenance},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'DISABLED_SCAFFOLD_PREPARED',retainedCopies:Object.keys(pins).length,nativeDependencies:2}));
