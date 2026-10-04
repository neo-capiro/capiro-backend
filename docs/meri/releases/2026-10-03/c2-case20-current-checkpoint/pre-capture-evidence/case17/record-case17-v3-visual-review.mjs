import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='C:/dev/main/outputs/meri-c2-20261003';
const request=JSON.parse(readFileSync(root+'/case17-regression-v3-visual-review-request.json','utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(request.captureRunId,'83fc19ac-5da2-49e7-b368-bcdb4704c3d5');
assert.equal(request.evidenceSha256,'a67703b8d4f9e6ea6894c32fb2e166866581788c007333e212128a6a722b71ed');
assert.equal(request.screenshots.length,12);
for(const s of request.screenshots){const raw=readFileSync(root+'/case17-regression-v3-artifacts/'+s.ref);assert.equal(sha(raw),s.sha256);assert.equal(raw.length,s.bytes);}
for(const s of request.screenshots.filter(s=>s.phase==='initial'))assert.equal(s.sha256,request.screenshots.find(x=>x.phase==='afterReload'&&x.logicalSourceId===s.logicalSourceId).sha256);
const review={schemaVersion:1,kind:'meri-case17-visual-review',caseId:'17',captureRunId:request.captureRunId,evidenceSha256:request.evidenceSha256,reviewedAt:new Date().toISOString(),reviewer:'Codex root',reference:'Root inspected saved afterReload PNGs A through F in this chat; all12 files were hash-checked and each initial PNG equals its corresponding reload PNG.',rationale:'All six cards show pending review, distinct A-F proposal labels and values, Source: model extraction, and a visible Withdraw action. A/B/C target Aster Defense; D targets Bluehaven Robotics; E is Firm memory; F is Personal memory. Scope, value, source-kind label and action are readable. This checks only the existing source-kind display; the cards have no distinct-source provenance navigation. Original prompt and human rubric remain unrun.',screenshotSha256s:request.screenshots.map(s=>s.sha256),allSixCardsVisibleWithCorrectScopeAndProvenance:true,allSixActionsVisibleAfterReload:true,provenanceFieldScope:'Visible source-kind label only; distinct-source provenance navigation NOT_DEMONSTRATED',humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false};
writeFileSync(root+'/case17-regression-v3-visual-review.json',JSON.stringify(review,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'SIX_SAVED_RELOAD_IMAGES_INSPECTED',filesHashed:12,identicalInitialReloadPairs:6,humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false}));
