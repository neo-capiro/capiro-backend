import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='C:/dev/main/outputs/meri-c2-20261003';
const request=JSON.parse(readFileSync(root+'/case17-regression-v2-visual-review-request.json','utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(request.captureRunId,'22175a99-1245-4929-9d3c-4e7e0c058374');
assert.equal(sha(readFileSync(root+'/case17-regression-v2-artifacts/case17/evidence.json')),request.evidenceSha256);
for(const s of request.screenshots){
 assert.match(s.ref,/^case17\/(initial|afterReload)\/MEM-PENDING-17-[A-F]\.png$/u);
 const bytes=readFileSync(root+'/case17-regression-v2-artifacts/'+s.ref);
 assert.equal(bytes.length,s.bytes);assert.equal(sha(bytes),s.sha256);
 const other=request.screenshots.find(o=>o.logicalSourceId===s.logicalSourceId&&o.phase!==s.phase);
 assert.equal(s.sha256,other.sha256);
}
const review={schemaVersion:1,kind:'meri-case17-visual-review',caseId:'17',captureRunId:request.captureRunId,
 evidenceSha256:request.evidenceSha256,reviewedAt:new Date().toISOString(),reviewer:'Codex root',
 reference:'Saved afterReload PNGs A through F visually inspected in current chat; each initial PNG is byte-identical to its corresponding reload PNG.',
 rationale:'All six cards show PENDING REVIEW, distinct A-F proposal labels and values, readable Source: model extraction, and a visible Withdraw action. A/B/C target Aster Defense; D targets Bluehaven Robotics; E is Firm memory; F is Personal memory. No clipping hides the scope, value, source kind or action. This validates visible source kind only; it does not establish a human rubric, the original model prompt, or complete distinct-source provenance navigation.',
 screenshotSha256s:request.screenshots.map(s=>s.sha256),allSixCardsVisibleWithCorrectScopeAndProvenance:true,allSixActionsVisibleAfterReload:true,
 humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false};
assert.ok(Date.parse(review.reviewedAt)>=request.completedAt);
writeFileSync(root+'/case17-regression-v2-visual-review.json',JSON.stringify(review,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'SAVED_IMAGES_REVIEWED',uniqueImages:6,hashedImages:12,humanRubric:'NOT_RUN'}));
