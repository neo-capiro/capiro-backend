const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process'),ts=require('/workspace/capirov2/node_modules/typescript');
const C='1e99f0921b207318c6d2abf03927b5c4daa5768b',candidate='a247f7a02a9b94d95e9ee5a516b396202aea994b',file='apps/api/src/workspace-collab/newsletter-account-invitation.service.ts',out='docs/cleanup-newsletter-two-contract-independent-review-20261012/evidence/';
class BadRequestException extends Error{} class NotFoundException extends Error{}
const fixed=1791849600000;class FixedDate extends Date{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}}
function factory(pin){
 const text=cp.execFileSync('git',['show',`${pin}:${file}`],{encoding:'utf8'}),sf=ts.createSourceFile('source.ts',text,ts.ScriptTarget.Latest,true),cls=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='NewsletterAccountInvitationService');
 const names=['state','claim','beginAttempt','dispatch','status','finish','receipt','actor','pending','redirect'];
 const members=names.map(name=>{const n=cls.members.find(n=>n.name?.getText(sf)===name);assert(n,name);return n.getText(sf);});
 const helpers=sf.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='publicReceipt'||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>['admin','messages'].includes(d.name.getText(sf)))).map(n=>n.getText(sf)).join('\n');
 const code=ts.transpileModule(helpers+'\nclass SyntheticExcerpt{\n'+members.join('\n')+'\n}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const banned=[];function scan(n){if(ts.isIdentifier(n)&&['require','fetch','process','setTimeout','setInterval','PrismaClient'].includes(n.text))banned.push(n.text);ts.forEachChild(n,scan);}scan(ts.createSourceFile('compiled.js',code,ts.ScriptTarget.Latest,true));assert.deepEqual(banned,[]);
 return new Function('BadRequestException','NotFoundException','Date','randomUUID','deadline',code+'\nreturn SyntheticExcerpt.prototype;');
}
const make=[C,candidate].map(factory),ctx={tenantId:'tenant',userId:'author-user',clerkUserId:'author'},clean=v=>JSON.parse(JSON.stringify(v));
function harness(i,o={}){
 const trace=[],marker=new Error('fake provider outcome unknown');let receipt=o.prior?{id:'request',tenantId:'tenant',organizationId:'org',accountRole:'member',leaseId:'old-lease',updatedAt:new FixedDate(fixed-180000),...o.prior}:null,authorityCalls=0,lease=0,queue=Promise.resolve();
 const log=(label,args)=>trace.push([label,clean(args)]);
 const prototype=make[i](BadRequestException,NotFoundException,FixedDate,()=>`lease-${++lease}`,async operation=>await operation),h=Object.create(prototype);
 const tx={$queryRaw:async(...args)=>{log('syntheticAdvisoryLock',args);return[{locked:true}];},newsletterAccountInvitation:{
  findFirst:async args=>{log('receiptRead',args);return typeof args.where.id==='object'?(o.overlap?{id:'other',status:'outcome_unknown'}:null):receipt;},
  upsert:async args=>{log('receiptClaim',args);receipt=receipt?{...receipt,...args.update}:{...args.create,updatedAt:new FixedDate(),attemptedAt:null};return{...receipt};},
  updateMany:async args=>{log('receiptCAS',args);const w=args.where;if(!receipt||w.leaseId!==receipt.leaseId||(w.status&&w.status!==receipt.status)||(w.attemptedAt===null&&receipt.attemptedAt)||(o.leaseLost&&w.status==='checking'))return{count:0};Object.assign(receipt,args.data);return{count:1};}
 },auditLog:{create:async args=>log('auditAttempt',args)}};
 h.prisma={withTenant:async(tenant,fn)=>{assert.equal(tenant,'tenant');const next=queue.then(()=>fn(tx));queue=next.catch(()=>{});return next;}};
 h.authority=async(_ctx,id,_tx,lock)=>{authorityCalls++;log('syntheticAuthority',{ctx:_ctx,id,lock:!!lock});if(o.authorityDenied||o.denyFinal&&authorityCalls>=4)throw new NotFoundException('Invitation not found');return{id:'request',documentId:'document',authorId:'author',email:'recipient@example.test',accountRole:o.admin?'admin':'member',organizationId:o.orgChanged?'other-org':'org',authorRole:o.authorNotAdmin?'standard_user':'user_admin',memberUserId:o.admin?'recipient-user':null,memberRole:'standard_user',sourceClientIds:['current','prior'],cancelledAt:o.cancelBeforeAttempt&&authorityCalls>=3?new FixedDate():null,expiresAt:new FixedDate(fixed+60000)};};
 h.config={get:key=>key==='WEB_ORIGIN'?'https://example.invalid':undefined};
 h.provider={
  actor:async(...args)=>{log('fakeProviderActorRead',args);return{data:o.actorNotAdmin?[]:[{role:'org:admin',publicUserData:{userId:'author'}}]};},
  pending:async(...args)=>{log('fakeProviderPendingRead',args);return{data:[],totalCount:0};},
  get:async(...args)=>{log('fakeProviderReceiptRead',args);return null;},
  create:async(...args)=>{log('fakeProviderCreate',args);if(o.createThrows)throw marker;return{id:'provider-request',organizationId:o.wrongProviderOrg?'other':'org',emailAddress:'recipient@example.test',role:args[3]};},
  promote:async(...args)=>{log('fakeProviderPromote',args);if(o.createThrows)throw marker;return{};}
 };
 h.trace=trace;h.record=()=>receipt;return h;
}
const posts=h=>h.trace.filter(r=>['fakeProviderCreate','fakeProviderPromote'].includes(r[0]));
const results=[];
async function compare(label,o,operation,verify){const outputs=[];for(let i=0;i<2;i++){const h=harness(i,o);let value,error;try{value=await operation(h);}catch(e){error=e;}verify(h,value,error);outputs.push({trace:clean(h.trace),receipt:clean(h.record()),value:value===undefined?null:clean(value),error:error?{ctor:error.constructor,message:error.message}:null});}assert.deepEqual(outputs[1],outputs[0],label);results.push({label,posts:outputs[1].trace.filter(r=>['fakeProviderCreate','fakeProviderPromote'].includes(r[0])).length,status:outputs[1].receipt?.status??outputs[1].value?.status,error:outputs[1].error?.message??null,sameHostErrorRealm:true});}
(async()=>{
 for(const [label,o]of[
  ['unknown attempted is terminal',{prior:{status:'outcome_unknown',attemptedAt:new FixedDate()}}],['provider receipt prevents repost',{prior:{status:'invited',providerInvitationId:'provider-request',attemptedAt:null}}],['recent checking keeps current lease',{prior:{status:'checking',updatedAt:new FixedDate(),attemptedAt:null}}],['organization changed after attempt',{orgChanged:true,prior:{status:'outcome_unknown',attemptedAt:new FixedDate()}}],['overlapping email waits',{overlap:true}],['current author lacks admin',{authorNotAdmin:true}],['authority refuses before claim',{authorityDenied:true}],['role revoked at provider actor read',{actorNotAdmin:true}],['cancelled on attempt recheck',{cancelBeforeAttempt:true}],['lost attempt lease',{leaseLost:true}],
 ])await compare(label,o,h=>h.dispatch(ctx,'request'),(h,v,e)=>{assert.equal(posts(h).length,0);if(o.authorityDenied)assert(e instanceof NotFoundException);else assert(!e);});
 await compare('successful create exact server role and immutable request',{},async h=>{const a=await h.dispatch(ctx,'request');const b=await h.dispatch(ctx,'request');return[a,b];},(h,v,e)=>{assert(!e);assert.equal(posts(h).length,1);assert.equal(posts(h)[0][1][3],'org:member');assert.equal(posts(h)[0][1].at(-1),'request');assert(h.trace.some(r=>r[0]==='receiptCAS'&&r[1].where.attemptedAt===null));assert.equal(h.record().attemptKind,'create_invitation');});
 await compare('unknown create outcome never reposts',{createThrows:true},async h=>[await h.dispatch(ctx,'request'),await h.dispatch(ctx,'request')],(h,v,e)=>{assert(!e);assert.equal(posts(h).length,1);assert.equal(h.record().status,'outcome_unknown');assert(h.record().attemptedAt);});
 await compare('mismatching remote receipt remains attempted',{wrongProviderOrg:true},async h=>[await h.dispatch(ctx,'request'),await h.dispatch(ctx,'request')],(h,v,e)=>{assert(!e);assert.equal(posts(h).length,1);assert.equal(h.record().status,'outcome_unknown');});
 await compare('promote unknown never repeats',{admin:true,createThrows:true},async h=>[await h.dispatch(ctx,'request'),await h.dispatch(ctx,'request')],(h,v,e)=>{assert(!e);assert.equal(posts(h).length,1);assert.equal(posts(h)[0][0],'fakeProviderPromote');assert.equal(h.record().attemptKind,'promote_member');assert.equal(h.record().status,'outcome_unknown');});
 await compare('response withheld after final authority revoke',{denyFinal:true},h=>h.dispatch(ctx,'request'),(h,v,e)=>{assert(e instanceof NotFoundException);assert.equal(posts(h).length,1);assert.equal(h.record().status,'invited');});
 await compare('two simultaneous dispatches one fake attempt',{},h=>Promise.all([h.dispatch(ctx,'request'),h.dispatch(ctx,'request')]),(h,v,e)=>{assert(!e);assert.equal(posts(h).length,1);assert.equal(h.record().attemptKind,'create_invitation');});
 await compare('stale unknown status reads but never creates',{prior:{status:'sending',attemptedAt:new FixedDate(fixed-180000),updatedAt:new FixedDate(fixed-180000)}},async h=>[await h.status(ctx,'request'),await h.dispatch(ctx,'request')],(h,v,e)=>{assert(!e);assert.equal(posts(h).length,0);assert(h.trace.some(r=>r[0]==='fakeProviderPendingRead'));assert.equal(h.record().status,'outcome_unknown');assert(h.record().attemptedAt);});
 fs.writeFileSync(out+'fake-account-replay.json',JSON.stringify({source:candidate,original:C,comparisons:results.length,results,actualProviderClientSqlCalls:0,applicationGraphImported:false,
  authorityRowPortSynthetic:true,deadlinePortSyntheticNoTimer:true,uuidPortSynthetic:true,
  scope:'Exact claim/beginAttempt/dispatch/status/receipt fragments with serialized synthetic transaction ports; source authority SQL is preserved but not evaluated',
  nativeMvccProviderReplicaDeadlineAcceptance:false,finalAcceptance:false},null,2)+'\n');console.log(JSON.stringify({comparisons:results.length,source:candidate,actualProviderSqlCalls:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
