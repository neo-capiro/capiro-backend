'use strict';
// Independent finite actual-HTTP cases through the author's frozen host seam.
// No canonical method replacements; mutable SDK facts are fixture inputs only.
const assert = require('node:assert/strict');
const wait = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds));
async function supplementary({check,request,getScenario,prisma,IDS,ROUTES,contextBody,receipts,results}) {
  const start = results.length;
  const body = edits => JSON.stringify({identitySha256:'a'.repeat(64),conversationId:IDS.conversation,clientId:IDS.client,...edits});
  await check('independent identity exact wire and lastSeen activity excludes revision',async()=>{
    const first=(await request('ind-identity-first',ROUTES.identity,'{}')).json();
    await wait(8);
    const second=(await request('ind-identity-second',ROUTES.identity,'{}')).json();
    assert.deepEqual(first.principal,{tenantId:IDS.tenant,actorId:IDS.user});
    assert.equal(second.identityRevision,first.identityRevision);
    assert.ok(second.checkedAtMs>=first.checkedAtMs);
  });
  await check('independent correlation hash echo cannot change context authority facts',async()=>{
    const first=(await request('ind-context-hash-a',ROUTES.context,body({}))).json();
    const second=(await request('ind-context-hash-b',ROUTES.context,body({identitySha256:'b'.repeat(64)}))).json();
    assert.equal(first.contextRevision,second.contextRevision);
    assert.equal(second.identitySha256,'b'.repeat(64));
    assert.equal(second.selectedClientId,IDS.client);
  });
  for(const [name,edits] of [
    ['uppercase hash',{identitySha256:'A'.repeat(64)}],['short hash',{identitySha256:'a'.repeat(63)}],
    ['uppercase client',{clientId:IDS.client.toUpperCase()}],['null client',{clientId:null}],
    ['numeric conversation',{conversationId:1}],['own JSON prototype extra',{__proto__:null,extra:1}],
  ]) await check(`independent context wire refuses ${name}`,()=>request(`ind-wire-${name}`,ROUTES.context,body(edits),{expected:400}));
  await check('independent duplicate last foreign selector does not grant',()=>request('ind-duplicate-last-foreign',ROUTES.context,
    `{"identitySha256":"${'a'.repeat(64)}","conversationId":"${IDS.conversation}","clientId":"${IDS.client}","clientId":"${IDS.foreignClient}"}`,{expected:403}));
  await check('independent raw own prototype key remains a denied HTTP extra',()=>request('ind-raw-prototype',ROUTES.context,
    `{"identitySha256":"${'a'.repeat(64)}","conversationId":"${IDS.conversation}","clientId":"${IDS.client}","__proto__":{"granted":true}}`,{expected:400}));
  await check('independent v7 wellformed absent conversation is authority denial',()=>request('ind-v7-absent',ROUTES.context,
    body({conversationId:'a5000000-0000-7000-8000-000000000099'}),{expected:403}));
  await check('independent conflicting tenant header403 before online session',async()=>{
    await request('ind-foreign-header',ROUTES.identity,'{}',{headers:{'x-capiro-tenant':'http-fixture-b'},expected:403});
    assert.equal(getScenario().sessionReads??0,0);
  });
  await check('independent org claim cannot pivot tenant403',async()=>{
    getScenario().claims={org_id:'fixture_org_b'};
    await request('ind-foreign-org',ROUTES.identity,'{}',{expected:403});
    assert.equal(getScenario().sessionReads??0,0);
  });
  await check('independent explicitly removed membership is not self healed',async()=>{
    await prisma.tenantMembership.update({where:{id:IDS.membership},data:{status:'removed'}});
    await request('ind-removed-before-middleware',ROUTES.identity,'{}',{expected:403});
    const row=await prisma.tenantMembership.findUnique({where:{id:IDS.membership}});
    assert.equal(row.status,'removed');assert.equal(getScenario().sessionReads??0,0);
  });
  await check('independent native session future creation401',async()=>{
    getScenario().createdAt=Date.now()+60_000;
    await request('ind-future-created',ROUTES.identity,'{}',{expected:401});
  });
  await check('independent native abandonment expiry bounds exact identity receipt',async()=>{
    const bound=Date.now()+10_000;getScenario().abandonAt=bound;
    const result=(await request('ind-abandon-bound',ROUTES.identity,'{}')).json();
    assert.equal(result.expiresAtMs,bound);
  });
  await check('independent SDK await crosses native original expiry401',async()=>{
    getScenario().expireAt=Date.now()+80;
    getScenario().duringSession=()=>wait(200);
    await request('ind-expiry-gap',ROUTES.identity,'{}',{expected:401});
  });
  await check('independent changed native session actor across online reads403',async()=>{
    getScenario().actor={sub:'fixture_original_actor'};
    getScenario().duringSession=(_db,n)=>{if(n===2)getScenario().actor={sub:'fixture_changed_actor'};};
    await request('ind-session-actor-changed',ROUTES.context,contextBody(),{expected:403});
  });
  await check('independent conversation deleted during second SDK await403',async()=>{
    getScenario().duringSession=async(db,n)=>{if(n===2)await db.clioConversation.delete({where:{id:IDS.conversation}});};
    await request('ind-conversation-deleted-gap',ROUTES.context,contextBody(),{expected:403});
  });
  await check('independent client archived during second SDK await403',async()=>{
    getScenario().duringSession=async(db,n)=>{if(n===2)await db.client.update({where:{id:IDS.client},data:{status:'archived'}});};
    await request('ind-client-archived-gap',ROUTES.context,contextBody(),{expected:403});
  });
  async function impersonationSetup() {
    await prisma.tenantMembership.update({where:{id:IDS.membership},data:{role:'capiro_admin'}});
    const expiry=Date.now()+20_000;
    await prisma.impersonationSession.create({data:{id:IDS.impersonation,actorUserId:IDS.user,tenantId:IDS.foreignTenant,
      reason:'Synthetic independent authority HTTP fixture',expiresAt:new Date(expiry)}});
    return {expiry,headers:{'x-capiro-impersonate-tenant':'http-fixture-b'}};
  }
  await check('independent active admin impersonation principal and original expiry',async()=>{
    const setup=await impersonationSetup();
    const result=(await request('ind-impersonation-valid',ROUTES.identity,'{}',{headers:setup.headers})).json();
    assert.deepEqual(result.principal,{tenantId:IDS.foreignTenant,actorId:IDS.user});
    assert.equal(result.expiresAtMs,setup.expiry);
  });
  await check('independent impersonation ended during online await403',async()=>{
    const setup=await impersonationSetup();
    getScenario().duringSession=db=>db.impersonationSession.update({where:{id:IDS.impersonation},data:{endedAt:new Date()}});
    await request('ind-impersonation-ended-gap',ROUTES.identity,'{}',{headers:setup.headers,expected:403});
  });
  await check('independent impersonation target inactive during online await403',async()=>{
    const setup=await impersonationSetup();
    getScenario().duringSession=db=>db.tenant.update({where:{id:IDS.foreignTenant},data:{status:'suspended'}});
    await request('ind-impersonation-target-gap',ROUTES.identity,'{}',{headers:setup.headers,expected:403});
  });
  await check('independent impersonation source role revoked during online await403',async()=>{
    const setup=await impersonationSetup();
    getScenario().duringSession=db=>db.tenantMembership.update({where:{id:IDS.membership},data:{role:'standard_user'}});
    await request('ind-impersonation-role-gap',ROUTES.identity,'{}',{headers:setup.headers,expected:403});
  });
  const added=results.slice(start);
  assert.ok(added.length>0);
  return {cases:added.length,passed:added.filter(row=>row.passed).length,failed:added.filter(row=>!row.passed).length,
    actualHttpRequests:receipts.filter(row=>row.case?.startsWith('ind-')).length};
}
module.exports={supplementary};
