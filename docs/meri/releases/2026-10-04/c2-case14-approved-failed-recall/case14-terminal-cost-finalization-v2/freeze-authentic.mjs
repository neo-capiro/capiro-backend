// Offline preparation only; status stays disabled until root records exact review.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {RETAINED_PINS,SCOPE} from './fixed.mjs';
import {inspectCase14TerminalCost,semantic,hash} from './predicate.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),base='C:/dev/main/outputs/meri-c2-20261003',original=base+'/case14-terminal-postdeadline-v1';
const read=p=>JSON.parse(fs.readFileSync(p));
const raw=fs.readFileSync(original+'/readback.json');if(hash(raw)!=='6bf04ccb58fe4410bff0f665c635cc230148ab7ae7ea6509ccc5c6493a40c7c1')throw Error('AUTHENTIC_POSTDEADLINE_READBACK_DRIFT');
const post=JSON.parse(raw),retained={};for(const[name,p]of Object.entries(RETAINED_PINS)){const b=fs.readFileSync(p.path),o=fs.readFileSync(p.originalPath);if(hash(b)!==p.sha256||!b.equals(o))throw Error('RETAINED_COPY_DRIFT');if(p.semanticSha256)retained[name]=p.encoding==='opaque-text'?b.toString('utf8'):JSON.parse(b);}
const proof=inspectCase14TerminalCost(retained,post),proofSha256=semantic(proof);
fs.mkdirSync(root+'/postdeadline');
const pinCopy=(name,originalPath)=>{const b=fs.readFileSync(originalPath),target=root+'/postdeadline/'+name;fs.writeFileSync(target,b,{flag:'wx'});return{path:target,originalPath,bytes:b.length,sha256:hash(b),encoding:name.endsWith('.json')?'json':'raw',...(name.endsWith('.json')?{semanticSha256:semantic(JSON.parse(b))}:{})};};
const postPins={};for(const[name,file]of Object.entries({summary:'summary.json',me:'me.json',conversation:'conversation.json',cleanup:'session-cleanup.json'})){if(!isDeepStrictEqual(read(original+'/'+file),post[name]))throw Error('POSTDEADLINE_INDIVIDUAL_JOIN');postPins[name]=pinCopy(file,original+'/'+file);}
const supportPins=[pinCopy('readback.json',original+'/readback.json'),pinCopy('reader.mjs',base+'/read-case14-terminal-postdeadline-v1.mjs'),pinCopy('journal-preserved.json',original+'/journal-preserved.json')];
fs.writeFileSync(root+'/proof.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
const native=root+'/native/windows-capture-spend.py',previous=fs.readFileSync(native,'utf8');if(!previous.includes('CASE14_TERMINAL_PROOF_SHA256 = None'))throw Error('NATIVE_ALREADY_FROZEN');fs.writeFileSync(native,previous.replace('CASE14_TERMINAL_PROOF_SHA256 = None',"CASE14_TERMINAL_PROOF_SHA256 = '"+proofSha256+"'"));
const files=['authority.mjs','predicate.mjs','fixed.mjs','bridge.mjs','operator.mjs','dry-run-driver.py','native/windows-capture-spend.py','native/windows-artifact-protocol.py','native/windows-owned-artifacts.py'];
const sourcePins=files.map(p=>{const exact=fileURLToPath(new URL(p,import.meta.url)),b=fs.readFileSync(exact);return{path:exact,bytes:b.length,sha256:hash(b),encoding:'raw'};});
const reviewedEvidenceSha256=semantic({retainedPins:RETAINED_PINS,postPins,supportPins,scope:SCOPE});
const config={status:'FROZEN_AWAITING_ROOT_INDEPENDENT_REVIEW',postPins,supportPins,proofSha256,reviewedEvidenceSha256,sourcePins,review:null};
fs.copyFileSync(root+'/finalization-pins.mjs',root+'/finalization-pins.disabled-preserved.mjs',fs.constants.COPYFILE_EXCL);
fs.writeFileSync(root+'/finalization-pins.mjs','export const FINALIZATION = '+JSON.stringify(config,null,2)+';\n');
fs.writeFileSync(root+'/review-request.json',JSON.stringify({status:'REVIEW_REQUIRED',action:'COST_ONLY_FIXED_FAILED_CASE14',evidencePinsSha256:reviewedEvidenceSha256,proofSha256,sourcePinsSha256:semantic(sourcePins),captureAuthority:false,answerGrade:'NOT_EVALUATED',approvalBilledActualMicros:null,proof,sourcePins},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:config.status,proofSha256,reviewedEvidenceSha256,sourcePinsSha256:semantic(sourcePins),postdeadlineReadbackSha256:hash(raw)}));
