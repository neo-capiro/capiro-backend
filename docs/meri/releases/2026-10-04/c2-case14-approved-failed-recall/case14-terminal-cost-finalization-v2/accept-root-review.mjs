// LEAD ONLY, local activation of fixed evidence after actual independent review.
// This does not read or mutate the live journal and does not perform an append.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {FINALIZATION as old} from './finalization-pins.mjs';
import {semantic,hash} from './predicate.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
assert.equal(process.argv.length,2,'NO_RUNTIME_INPUTS');assert.equal(old.status,'FROZEN_AWAITING_ROOT_INDEPENDENT_REVIEW');
const reviewPath=root+'/independent-review.json',b=fs.readFileSync(reviewPath),r=JSON.parse(b);
assert.equal(r.status,'PASS');assert.equal(r.action,'COST_ONLY_FIXED_FAILED_CASE14');assert.equal(r.evidencePinsSha256,old.reviewedEvidenceSha256);assert.equal(r.proofSha256,old.proofSha256);assert.equal(r.sourcePinsSha256,semantic(old.sourcePins));assert.equal(r.captureAuthority,false);assert.equal(r.answerGrade,'NOT_EVALUATED');assert.equal(r.approvalBilledActualMicros,null);
for(const p of old.sourcePins){const current=fs.readFileSync(p.path);assert.equal(hash(current),p.sha256);assert.equal(current.length,p.bytes);}
fs.copyFileSync(root+'/finalization-pins.mjs',root+'/finalization-pins.frozen-unreviewed-preserved.mjs',fs.constants.COPYFILE_EXCL);
fs.writeFileSync(root+'/finalization-pins.mjs','export const FINALIZATION = '+JSON.stringify({...old,status:'REVIEWED_FIXED_COST_ONLY_EVIDENCE',review:{path:reviewPath,bytes:b.length,sha256:hash(b),encoding:'json',semanticSha256:semantic(r)}},null,2)+';\n');
console.log(JSON.stringify({status:'REVIEWED_FIXED_COST_ONLY_EVIDENCE',reviewSha256:hash(b),journalRead:false,journalMutations:0}));
