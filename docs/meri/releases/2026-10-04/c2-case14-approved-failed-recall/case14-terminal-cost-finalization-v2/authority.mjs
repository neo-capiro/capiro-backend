import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {RETAINED_PINS,SCOPE} from './fixed.mjs';
import {FINALIZATION} from './finalization-pins.mjs';
import {inspectCase14TerminalCost,hash,semantic} from './predicate.mjs';
const authorities=new WeakMap();
const need=(v,label)=>{if(!v)throw Error('CASE14_FIXED_COST_AUTHORITY_REJECTED:'+label);};
function readPinned(pin){
 need(pin&&typeof pin.path==='string'&&Number.isSafeInteger(pin.bytes)&&/^[a-f0-9]{64}$/.test(pin.sha256),'pin');
 const b=readFileSync(pin.path);need(b.length===pin.bytes&&hash(b)===pin.sha256,'file bytes');
 if(pin.originalPath){const original=readFileSync(pin.originalPath);need(original.length===pin.bytes&&hash(original)===pin.sha256&&original.equals(b),'original retained evidence');}
 if(pin.encoding==='raw'||!pin.semanticSha256)return b;
 const value=pin.encoding==='opaque-text'?b.toString('utf8'):JSON.parse(b);
 need(semantic(value)===pin.semanticSha256,'semantic bytes');return value;
}
function load(){
 need(FINALIZATION.status==='REVIEWED_FIXED_COST_ONLY_EVIDENCE','not frozen/reviewed');
 need(FINALIZATION.postPins&&Object.keys(FINALIZATION.postPins).sort().join(',')==='cleanup,conversation,me,summary','post file set');
 const retained={},post={};
 for(const[name,pin]of Object.entries(RETAINED_PINS)){const value=readPinned(pin);if(pin.semanticSha256)retained[name]=value;}
 for(const[name,pin]of Object.entries(FINALIZATION.postPins)){need(pin.encoding==='json','post encoding');post[name]=readPinned(pin);}
 need(Array.isArray(FINALIZATION.supportPins)&&FINALIZATION.supportPins.length===3,'support evidence set');
 for(const pin of FINALIZATION.supportPins)readPinned(pin);
 const evidenceSha256=semantic({retainedPins:RETAINED_PINS,postPins:FINALIZATION.postPins,supportPins:FINALIZATION.supportPins,scope:SCOPE});
 need(evidenceSha256===FINALIZATION.reviewedEvidenceSha256,'fixed evidence inventory');
 need(Array.isArray(FINALIZATION.sourcePins)&&FINALIZATION.sourcePins.length===9,'closed source set');
 const required=['authority.mjs','predicate.mjs','fixed.mjs','bridge.mjs','operator.mjs','dry-run-driver.py','native/windows-capture-spend.py','native/windows-artifact-protocol.py','native/windows-owned-artifacts.py'];
 for(const relative of required){const exact=fileURLToPath(new URL(relative,import.meta.url));const p=FINALIZATION.sourcePins.filter(x=>x.path===exact);need(p.length===1,'source path');readPinned(p[0]);}
 const review=readPinned(FINALIZATION.review);
 need(review.status==='PASS'&&review.action==='COST_ONLY_FIXED_FAILED_CASE14'&&review.evidencePinsSha256===evidenceSha256&&review.proofSha256===FINALIZATION.proofSha256&&review.sourcePinsSha256===semantic(FINALIZATION.sourcePins),'independent review');
 need(review.captureAuthority===false&&review.answerGrade==='NOT_EVALUATED'&&review.approvalBilledActualMicros===null,'review boundary');
 const proof=inspectCase14TerminalCost(retained,post);
 need(semantic(proof)===FINALIZATION.proofSha256,'exact reviewed proof');
 return{proof,checkpoint:retained.checkpoint,reviewSha256:FINALIZATION.review.sha256,evidencePinsSha256:evidenceSha256,sourcePins:structuredClone(FINALIZATION.sourcePins)};
}
/** Loads only fixed retained files; no network, source imports, or journal I/O. */
export function prepareCase14TerminalCostAuthority(){
 const value=load(),capability=Object.freeze({kind:'case14-terminal-recall-cost-with-conservative-approval'});
 authorities.set(capability,value);return capability;
}
/** One-use; consume-time source/evidence/review re-read fences intervening drift. */
export function consumeCase14TerminalCostAuthority(capability){
 const value=authorities.get(capability);need(value,'opaque capability');authorities.delete(capability);
 const current=load();need(isDeepStrictEqual(current,value),'consume-time revalidation');return structuredClone(value);
}
export function inspectFixedPreparationStatus(){return{status:FINALIZATION.status,liveAuthorityEnabled:FINALIZATION.status==='REVIEWED_FIXED_COST_ONLY_EVIDENCE',journalRead:false,providerCalls:0};}
