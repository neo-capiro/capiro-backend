import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {FINALIZATION} from './finalization-pins.mjs';
import {RETAINED_PINS,SCOPE} from './fixed.mjs';
import {hash,semantic,inspectCase14TerminalCost} from './predicate.mjs';
import * as production from './authority.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const pin=p=>{const b=fs.readFileSync(p);return{path:p,bytes:b.length,sha256:hash(b),encoding:'raw'};};
const sources=['authority.mjs','predicate.mjs','fixed.mjs','bridge.mjs','operator.mjs','dry-run-driver.py','native/windows-capture-spend.py','native/windows-artifact-protocol.py','native/windows-owned-artifacts.py'];
async function isolated(){
 const parent=ROOT+'/isolated-tests';fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(parent+'/cost-');
 fs.mkdirSync(dir+'/native');fs.mkdirSync(dir+'/evidence');fs.mkdirSync(dir+'/originals');
 for(const file of sources)fs.copyFileSync(ROOT+'/'+file,dir+'/'+file);
 for(const file of['journal25-reconstructed-from-retained.jsonl','authorization-exact-retained.json'])fs.copyFileSync(ROOT+'/'+file,dir+'/'+file);
 let n=0;const copyPin=p=>{const i=n++,target=dir+'/evidence/'+i,original=dir+'/originals/'+i,b=fs.readFileSync(p.path);fs.writeFileSync(target,b);fs.writeFileSync(original,b);return{...p,path:target,originalPath:original};};
 const retainedPins=Object.fromEntries(Object.entries(RETAINED_PINS).map(([k,p])=>[k,copyPin(p)]));
 const postPins=Object.fromEntries(Object.entries(FINALIZATION.postPins).map(([k,p])=>[k,copyPin(p)]));
 const supportPins=FINALIZATION.supportPins.map(copyPin);
 fs.writeFileSync(dir+'/fixed.mjs','export const RETAINED_PINS='+JSON.stringify(retainedPins)+';\nexport const SCOPE='+JSON.stringify(SCOPE)+';\n');
 const module=await import(pathToFileURL(dir+'/predicate.mjs'));
 const load=p=>p.encoding==='opaque-text'?fs.readFileSync(p.path,'utf8'):JSON.parse(fs.readFileSync(p.path));
 const retained=Object.fromEntries(Object.entries(retainedPins).filter(([,p])=>p.semanticSha256).map(([k,p])=>[k,load(p)]));
 const post=Object.fromEntries(Object.entries(postPins).map(([k,p])=>[k,load(p)]));
 const proof=module.inspectCase14TerminalCost(retained,post),proofSha256=semantic(proof);
 const nativePath=dir+'/native/windows-capture-spend.py';fs.writeFileSync(nativePath,fs.readFileSync(nativePath,'utf8').replace(FINALIZATION.proofSha256,proofSha256));
 const sourcePins=sources.map(p=>pin(fileURLToPath(pathToFileURL(dir+'/'+p))));
 const reviewedEvidenceSha256=semantic({retainedPins,postPins,supportPins,scope:SCOPE});
 const review={status:'PASS',action:'COST_ONLY_FIXED_FAILED_CASE14',evidencePinsSha256:reviewedEvidenceSha256,proofSha256,sourcePinsSha256:semantic(sourcePins),captureAuthority:false,answerGrade:'NOT_EVALUATED',approvalBilledActualMicros:null,unitTestReviewOnly:true};
 fs.writeFileSync(dir+'/review.json',JSON.stringify(review));
 const reviewPin={...pin(dir+'/review.json'),encoding:'json',semanticSha256:semantic(review)};
 const config={status:'REVIEWED_FIXED_COST_ONLY_EVIDENCE',postPins,supportPins,proofSha256,reviewedEvidenceSha256,sourcePins,review:reviewPin};
 fs.writeFileSync(dir+'/finalization-pins.mjs','export const FINALIZATION='+JSON.stringify(config)+';\n');
 return{dir,retainedPins,postPins,supportPins,config,proof,authority:await import(pathToFileURL(dir+'/authority.mjs'))};
}
test('actual corrected postdeadline produces exact original failure/cost proof',()=>{
 const retained=Object.fromEntries(Object.entries(RETAINED_PINS).filter(([,p])=>p.semanticSha256).map(([k,p])=>[k,p.encoding==='opaque-text'?fs.readFileSync(p.path,'utf8'):JSON.parse(fs.readFileSync(p.path))]));
 const post=JSON.parse(fs.readFileSync(ROOT+'/postdeadline/readback.json'));const p=inspectCase14TerminalCost(retained,post);
 assert.equal(semantic(p),FINALIZATION.proofSha256);assert.equal(p.chargedCostMicros,1569851);assert.equal(p.conservativeApprovalCostMicros,1000000);assert.equal(p.approvalBilledActualMicros,null);assert.equal(p.captureAuthority,false);
});
test('production capability remains disabled without real root review',()=>assert.throws(()=>production.prepareCase14TerminalCostAuthority(),/not frozen/));
test('forged and JSON-cloned capabilities never qualify',async()=>{
 const x=await isolated();assert.throws(()=>x.authority.consumeCase14TerminalCostAuthority({kind:'case14-terminal-recall-cost-with-conservative-approval'}),/opaque/);
 const cap=x.authority.prepareCase14TerminalCostAuthority();assert.throws(()=>x.authority.consumeCase14TerminalCostAuthority(JSON.parse(JSON.stringify(cap))),/opaque/);
 const value=x.authority.consumeCase14TerminalCostAuthority(cap);assert.equal(semantic(value.proof),semantic(x.proof));assert.throws(()=>x.authority.consumeCase14TerminalCostAuthority(cap),/opaque/);
});
test('all copied evidence mutations reject minting',async()=>{
 const x=await isolated();for(const p of[...Object.values(x.retainedPins),...Object.values(x.postPins),...x.supportPins]){const before=fs.readFileSync(p.path);fs.writeFileSync(p.path,'{}\n');assert.throws(()=>x.authority.prepareCase14TerminalCostAuthority());fs.writeFileSync(p.path,before);}
});
test('original retained evidence is re-read before mint and consume',async()=>{
 const x=await isolated(),p=x.retainedPins.savedMessages,cap=x.authority.prepareCase14TerminalCostAuthority();fs.writeFileSync(p.originalPath,'{}\n');
 assert.throws(()=>x.authority.consumeCase14TerminalCostAuthority(cap),/original retained/);assert.throws(()=>x.authority.consumeCase14TerminalCostAuthority(cap),/opaque/);assert.throws(()=>x.authority.prepareCase14TerminalCostAuthority(),/original retained/);
});
test('actual original postdeadline evidence is re-read before consume',async()=>{
 const x=await isolated(),cap=x.authority.prepareCase14TerminalCostAuthority();fs.writeFileSync(x.postPins.conversation.originalPath,'{}\n');assert.throws(()=>x.authority.consumeCase14TerminalCostAuthority(cap),/original retained/);
});
test('all nine source and three native dependency pins fence drift',async()=>{
 const x=await isolated();for(const p of x.config.sourcePins){const before=fs.readFileSync(p.path);fs.appendFileSync(p.path,'\n');assert.throws(()=>x.authority.prepareCase14TerminalCostAuthority(),/file bytes/);fs.writeFileSync(p.path,before);}
});
test('review replacement and consume-time drift reject',async()=>{
 const x=await isolated(),cap=x.authority.prepareCase14TerminalCostAuthority();fs.writeFileSync(x.config.review.path,JSON.stringify({status:'PASS'}));assert.throws(()=>x.authority.consumeCase14TerminalCostAuthority(cap),/file bytes/);
});
test('production append and dry CLI refuse before output intent/live read',()=>{
 for(const arg of['--append-once','--dry-run']){const r=spawnSync(process.execPath,[ROOT+'/operator.mjs',arg],{encoding:'utf8',windowsHide:true,shell:false});assert.notEqual(r.status,0);assert.match(r.stderr,/not frozen\/reviewed/);}
 assert.equal(fs.existsSync(ROOT+'/executed-once'),false);
});
test('one-process authority/bridge/operator dry run appends only disposable NTFS',async()=>{
 const x=await isolated();const r=spawnSync(process.execPath,[x.dir+'/operator.mjs','--dry-run'],{encoding:'utf8',windowsHide:true,shell:false,timeout:20000});assert.equal(r.status,0,r.stderr);
 const value=JSON.parse(r.stdout);assert.equal(value.liveJournalRead,false);assert.equal(value.liveJournalMutated,false);assert.equal(value.exactPrefixPreserved,true);assert.equal(value.staleAndReplayRejected,true);assert.equal(value.snapshot.eventCount,26);assert.equal(value.snapshot.knownSettledCostMicros,15200909);assert.equal(value.snapshot.conservativeApprovalCostMicros,1000000);assert.equal(value.snapshot.remainingReservationMicros,13799091);
 assert.equal(path.resolve(value.root).startsWith(path.resolve(x.dir+'/dry-runs')),true);assert.equal(fs.existsSync(x.dir+'/executed-once'),false);
 fs.writeFileSync(ROOT+'/operator-dry-test-result.json',JSON.stringify({kind:'ISOLATED_TEST_ONLY_REAL_PROOF_IN_SEPARATE_PIN_NAMESPACE',...value},null,2)+'\n');
});
