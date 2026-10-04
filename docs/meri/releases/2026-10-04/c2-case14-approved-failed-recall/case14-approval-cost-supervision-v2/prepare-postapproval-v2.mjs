// Codex local-only copy/update; preserves original preparation and all source files.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='C:/dev/main/outputs/meri-c2-20261003',prior=root+'/case14-postapproval-preparation-v1',next=root+'/case14-postapproval-preparation-v2';
const rates=readFileSync(root+'/reviewed-rates-c2-v3-20261004.json');
const sha=x=>createHash('sha256').update(x).digest('hex');
assert.equal(sha(rates),'6a5e22e56f15c576612a0b50f42573e88a8c29a76698d033eb007d20b9b49684');
mkdirSync(next);
function change(text,from,to){assert.ok(text.includes(from),from);return text.replaceAll(from,to);}
let inner=readFileSync(prior+'/case14-postapproval-inner-v1.mjs','utf8');
inner=change(inner,'a1a179383c8451495336169f46025eb8cee8ec95487f1a43017078387b768b11','1c9106e5d98f73b061f0de9918bf33c8fb28b0f0bc5be5ae4bc7d20e0da2a348');
inner=change(inner,'2026-10-04T05:29:01.587Z','2026-10-04T11:09:44.838Z');
inner=change(inner,'assert.ok(Number.isSafeInteger(input.limits.maxCostMicros) && input.limits.maxCostMicros > 0 && input.limits.maxCostMicros <= 15000000);','assert.equal(input.limits.maxCostMicros, 14000000);');
let builder=readFileSync(prior+'/build-case14-postapproval-input-v1.mjs','utf8');
builder=change(builder,'./case14-postapproval-inner-v1.mjs','./case14-postapproval-inner-v2.mjs');
builder=change(builder,'const evidence = currentCase14ApprovalAuthority(approvalOutcome);','assert.equal(maxCostMicros, 14000000);\n  const evidence = currentCase14ApprovalAuthority(approvalOutcome);');
let tests=readFileSync(prior+'/test-case14-postapproval-inner-v1.mjs','utf8');
tests=change(tests,'./case14-postapproval-inner-v1.mjs','./case14-postapproval-inner-v2.mjs');
tests=change(tests,'2026-10-04T04:25:00.000Z','2026-10-04T05:15:00.000Z');
tests=change(tests,"['overspend',x=>x.limits.maxCostMicros=15000001]","['overspend',x=>x.limits.maxCostMicros=14000001],['under-partition',x=>x.limits.maxCostMicros=13999999]");
tests=change(tests,"assert.equal(body.caseId,'14');assert.equal(body.ctx.role,'user_admin');","assert.equal(body.caseId,'14');assert.equal(body.ctx.role,'user_admin');assert.equal(body.qualification.maxCostMicros,14000000);");
for(const[name,bytes]of[['case14-postapproval-inner-v2.mjs',inner],['build-case14-postapproval-input-v2.mjs',builder],['test-case14-postapproval-inner-v2.mjs',tests],['reviewed-rates-retained.json',rates]])writeFileSync(next+'/'+name,bytes,{flag:'wx'});
console.log(JSON.stringify({status:'LOCAL_V2_PREPARED_NOT_RUN',directory:next,rateByteSha256:sha(rates),recallMaxCostMicros:14000000,providerCalls:0,journalMutations:0}));
