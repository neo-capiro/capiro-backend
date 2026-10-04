import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='C:/dev/main/outputs/meri-c2-20261003';
const request=JSON.parse(readFileSync(root+'/case17-regression-v4-visual-review-request.json','utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(request.captureRunId,'c27ae741-8e3d-454d-a126-d16273002d04');
assert.equal(request.evidenceSha256,'f3d3a1d4b4aa5442ebb813ca0f6ee6f7215b0fa74ff2d7cdf98352007669c267');
assert.equal(request.screenshots.length,12);
for(const s of request.screenshots){const raw=readFileSync(root+'/case17-regression-v4-artifacts/'+s.ref);assert.equal(sha(raw),s.sha256);assert.equal(raw.length,s.bytes);}
for(const s of request.screenshots.filter(s=>s.phase==='initial'))assert.equal(s.sha256,request.screenshots.find(x=>x.phase==='afterReload'&&x.logicalSourceId===s.logicalSourceId).sha256);
const receipt=JSON.parse(readFileSync(root+'/case17-regression-v4-artifacts/case17/receipt.json'));
assert.equal(receipt.rounds.length,2);
for(const round of receipt.rounds){assert.equal(new Set(round.cards.map(c=>c.recordedSourceProof.sourceId)).size,6);for(const card of round.cards){assert.equal(card.recordedSourceProof.expanded,true);assert.equal(card.recordedSourceProof.sourceType,'meri_synthetic_fixture');}}
const review={schemaVersion:1,kind:'meri-case17-visual-review',caseId:'17',captureRunId:request.captureRunId,evidenceSha256:request.evidenceSha256,reviewedAt:new Date().toISOString(),reviewer:'Codex root',reference:'Root inspected saved afterReload PNGs A through F in this chat. All12 files were independently hash-checked, and each initial PNG is byte-identical to its corresponding reload PNG.',rationale:'All six complete unclipped cards show PENDING REVIEW, distinct A-F labels and values, the expanded Source details control, Source type: Synthetic fixture, a different complete recorded source reference matching its canonical marker, and a visible Withdraw action. A/B/C target Aster Defense, D targets Bluehaven Robotics, E is Firm memory and F is Personal memory. Each reference wraps visibly within the card without clipping. The deterministic native collector and saved checks join exact markers to physical fixture records in both rounds. This proves the read-only source-details/reload slice; original prompt and human rubric remain unrun.',screenshotSha256s:request.screenshots.map(s=>s.sha256),allSixCardsVisibleWithCorrectScopeAndProvenance:true,allSixActionsVisibleAfterReload:true,provenanceFieldScope:'Expanded recorded source type and exact canonical fixture reference, before and after reload; no external navigation claim.',humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false};
writeFileSync(root+'/case17-regression-v4-visual-review.json',JSON.stringify(review,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'SIX_EXPANDED_SAVED_RELOAD_IMAGES_INSPECTED',filesHashed:12,identicalInitialReloadPairs:6,humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false}));
