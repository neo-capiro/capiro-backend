const assert = require('node:assert/strict');
const owner = require('./dist/meri/meri-case12-capture-remediation.js');
const {currentCaptureAuthorityRows} = require('./dist/meri/meri-server-readonly-capture.js');
const ctx={tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f',tenantSlug:'meri-foundation-20260928-t1',
  userId:'b1f758fc-17bd-40f8-bef2-fa2d2380300f',clerkUserId:'user_3Jw2FvWZkYGKmxWGx13tNJxFD2A',role:'standard_user'};
const clientId='41f9ec63-3963-479f-b747-59a3767ef44b', conversationId='22222222-2222-4222-8222-222222222222';
const run='33333333-3333-4333-8333-333333333333',old='40dd8401-dcfe-46bd-b010-c30e7098297c';
process.env.GIT_SHA='a'.repeat(40);
const fixture={fixtureNamespace:'meri-foundation-20260928',captureEvidence:{caseId:'12',captureRunId:run,
  remediationConversationId:conversationId},case12CaptureRemediation:{kind:'meri-case12-one-time-capture-remediation',
  version:1,oldConversationId:old,newConversationId:conversationId,newCaptureRunId:run,actorUserId:ctx.userId,clientId}};
const tx={tenant:{findUnique:async()=>({id:ctx.tenantId,slug:ctx.tenantSlug,settings:{meriFoundationFixture:fixture}})},
  user:{findUnique:async()=>({id:ctx.userId,clerkUserId:ctx.clerkUserId,email:'pat.synthetic@example.com',firstName:'Pat',lastName:'Synthetic'})},
  tenantMembership:{findFirst:async()=>({id:'active'})},clioConversation:{findFirst:async()=>({clientId,metadata:{},
    client:{id:clientId,tenantId:ctx.tenantId,name:'Aster',memoryWall:true,memoryAccessGrants:[{id:'approved'}]}})}};
const prisma={withTenant:async(_,fn)=>fn(tx)};
(async()=>{
  assert.equal(typeof owner.inspectCase12FailedCaptureRemediationInTx,'function');
  assert.equal(typeof owner.installCase12FailedCaptureRemediationInTx,'function');
  let nativeReads=0;
  await assert.rejects(owner.inspectCase12FailedCaptureRemediationInTx({},{$queryRaw:()=>{nativeReads++;throw Error('unexpected');}},
    {ctx,clientId,oldConversationId:old,newConversationId:old,newCaptureRunId:run,
      expectedCurrentVerifySha256:'5ff329511d93d308aac9fc4ff335788040db8740994906c34a9cb76c15042e3d',
      expectedApiSourceSha:process.env.GIT_SHA}),/historical_identity_replayed/);
  assert.equal(nativeReads,0);
  assert.equal((await currentCaptureAuthorityRows(prisma,ctx,conversationId)).captureBinding.captureRunId,run);
  await assert.rejects(currentCaptureAuthorityRows(prisma,ctx,old));
  delete fixture.case12CaptureRemediation;
  await assert.rejects(currentCaptureAuthorityRows(prisma,ctx,conversationId));
  console.log('OFFLINE_CASE12_REMEDIATION_OWNER_AND_CONVERSATION_FENCE_PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
