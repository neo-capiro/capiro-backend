import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCase14} from './case14-native-read-inner-v1.mjs';
process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE='meri-foundation-20260928';
const goodMember={role:'user_admin',clerkUserId:'user_3Jw2G2jbyyDlrrg6zCNd4gYUDfH'};
const goodOp={slug:'meri-foundation-20260928-t1',present:false,status:null};
function harness({member=goodMember,op=goodOp,owner=null,ownerError,rollbackError,commitInstead=false,enabled=true}={}){
 let rolledBack=0,commits=0,calls=0;
 const tx={$executeRawUnsafe:async()=>1,$queryRawUnsafe:async(sql,...args)=>sql.includes('tenant_memberships')?[member]:[op]};
 const prisma={withTenantUser:async(t,u,fn)=>{try{await fn(tx);commits++;}catch(e){rolledBack++;if(rollbackError)throw new Error('secret SQL password');if(commitInstead){commits++;return;}throw e;}}};
 const ports={reviewEnabled:()=>enabled,runScoped:(t,fn)=>fn(),readOwner:async(...args)=>{calls++;assert.equal(args.length,3);if(ownerError)throw new Error(ownerError);return owner;}};
 return {run:()=>inspectCase14(prisma,{},ports),counts:()=>({rolledBack,commits,calls})};
}
test('absence requires precise missing key, checked membership and rollback',async()=>{const h=harness();const r=await h.run();assert.equal(r.status,'CANONICAL_OWNER_ABSENT');assert.equal(r.transactionRolledBack,true);assert.deepEqual(h.counts(),{rolledBack:1,commits:0,calls:1});});
test('claimed is reconciliation, never absent',async()=>{const r=await harness({op:{...goodOp,present:true,status:'CLAIMED'}}).run();assert.equal(r.status,'CANONICAL_OPERATION_REQUIRES_RECONCILIATION');});
test('completed/null is unresolved, never absent',async()=>{const r=await harness({op:{...goodOp,present:true,status:'SETUP_COMPLETE'}}).run();assert.equal(r.status,'CANONICAL_OWNER_INVALID_OR_UNRESOLVED');});
for(const state of ['pending','approved'])test(state+' owner output omits content and unknown nested fields',async()=>{
 const owner={caseId:'14',tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f',clientId:'41f9ec63-3963-479f-b747-59a3767ef44b',reviewerUserId:'fb218bf5-2674-4ced-bca3-7a5d0c01592f',proposerUserId:'b1f758fc-17bd-40f8-bef2-fa2d2380300f',state,text:'SECRET_BODY',settings:{password:'SECRET_BODY'},item:state==='approved'?{id:'item',text:'SECRET_BODY'}:null,decision:state==='approved'?{transitionAuditId:'audit',text:'SECRET_BODY'}:null};
 const h=harness({op:{...goodOp,present:true,status:'SETUP_COMPLETE'},owner});const r=await h.run();assert.equal(r.status,'CANONICAL_OWNER_'+state.toUpperCase());assert.equal(JSON.stringify(r).includes('SECRET_BODY'),false);assert.equal(h.counts().commits,0);
});
test('wrong current member rejects before invoking canonical owner',async()=>{const h=harness({member:{...goodMember,role:'standard_user'}});await assert.rejects(h.run());assert.equal(h.counts().calls,0);assert.equal(h.counts().commits,0);});
test('owner exception is redacted and transaction rolls back',async()=>{const h=harness({ownerError:'secret password SQL'});const r=await h.run();assert.equal(r.status,'CANONICAL_OWNER_INVALID_OR_UNRESOLVED');assert.equal(r.code,'CANONICAL_OWNER_READ_FAILED');assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(h.counts().rolledBack,1);});
test('rollback failure cannot emit success',async()=>{await assert.rejects(harness({rollbackError:true}).run());});
test('swallowed sentinel cannot emit success',async()=>{await assert.rejects(harness({commitInstead:true}).run());});
test('disabled current review switch rejects before read',async()=>{const h=harness({enabled:false});await assert.rejects(h.run());assert.equal(h.counts().calls,0);});
