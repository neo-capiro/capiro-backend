const assert = require('node:assert/strict'), fs = require('node:fs'), cp = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript');
const C = '1e99f0921b207318c6d2abf03927b5c4daa5768b', candidate = 'a247f7a02a9b94d95e9ee5a516b396202aea994b';
const out = 'docs/cleanup-newsletter-two-contract-independent-review-20261012/evidence/';
const source = (pin, file) => cp.execFileSync('git', ['show', `${pin}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const parse = text => ts.createSourceFile('excerpt.ts', text, ts.ScriptTarget.Latest, true);
function top(pin, file, names) {
  const text = source(pin, file), ast = parse(text), found = [];
  for (const n of ast.statements) {
    if (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) found.push(n.getText(ast).replace(/^export /, ''));
    if (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))) found.push(n.getText(ast));
  }
  assert.equal(found.length, names.length); return found.join('\n');
}
class NotFoundException extends Error {} class BadRequestException extends Error {} class ConflictException extends Error {} class ForbiddenException extends Error {}
const fixed = 1791849600000;
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }
const common = pin => [
  top(pin, 'packages/shared/src/newsletter.ts', ['visitNewsletterBlocks', 'findNewsletterBlock', 'newsletterSourceClients']),
  top(pin, 'packages/shared/src/newsletter-render.ts', ['newsletterEscape']),
  top(pin, 'apps/workspace/src/hillday/hillday-source.service.ts', ['UUID_RE', 'isUuid']),
].join('\n');
function excerpt(pin, file, owner, names, extras = '') {
  const ast = parse(source(pin, file)), cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === owner); assert(cls);
  const methods = names.map(name => { const node = cls.members.find(n => n.name?.getText(ast) === name); assert(node, name); return node.getText(ast); });
  const text = common(pin) + '\n' + extras + '\nclass SyntheticExcerpt {\n' + methods.join('\n') + '\n}';
  const code = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const invalid = []; function scan(n) { if (ts.isIdentifier(n) && ['require', 'fetch', 'process', 'setTimeout', 'setInterval', 'PrismaClient', 'SESv2Client'].includes(n.text)) invalid.push(n.text); ts.forEachChild(n, scan); } scan(parse(code)); assert.deepEqual(invalid, []);
  return new Function('NotFoundException', 'BadRequestException', 'ConflictException', 'ForbiddenException', 'Date', code + '\nreturn SyntheticExcerpt.prototype;')(NotFoundException, BadRequestException, ConflictException, ForbiddenException, FixedDate);
}
const workspaceFile = 'apps/workspace/src/newsletters/newsletter.service.ts';
const workspaceNames = ['scope','documentWriteScope','assertClient','assertDesignClients','notify','reviewRow','activateInvitations','row','view','get','stage','publicAsset'];
const ws = [C,candidate].map(pin => excerpt(pin, workspaceFile, 'NewsletterService', workspaceNames, 'const json = (value: unknown) => JSON.parse(JSON.stringify(value));'));
const coreFile = 'apps/api/src/engagement/newsletter-outreach.service.ts';
const core = [C,candidate].map(pin => excerpt(pin, coreFile, 'NewsletterOutreachService', ['publicAccess','publicArchive','preferences','survey','stage','sendCurrent'], top(pin,coreFile,['uuid','newsletterPublicPage'])));
const normalize = [C,candidate].map(pin => {
  const code = ts.transpileModule(top(pin,coreFile,['email','normalizeNewsletterDestinations']), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return new Function('BadRequestException', code + '\nreturn normalizeNewsletterDestinations;')(BadRequestException);
});
const id = '22222222-2222-4222-8222-222222222222', tenant = '11111111-1111-4111-8111-111111111111';
const ctx = {tenantId:tenant,clerkUserId:'recipient',userId:'member-user'};
const design = {sourceClientIds:['client'],sections:[]}, config = {clientId:'client'};
const clean = v => JSON.parse(JSON.stringify(v));
const results = [];
async function compare(label, create, operation, expected) {
  const outputs = [];
  for (let i=0;i<2;i++) {
    const h=create(i); let value, error;
    try {value=await operation(h);} catch(e){error=e;}
    outputs.push({trace:clean(h.trace),value:value===undefined?null:clean(value),error:error?{constructor:error.constructor,name:error.constructor.name,message:error.message}:null});
    expected({h,value,error});
  }
  assert.deepEqual(outputs[1],outputs[0],label);
  results.push({label,trace:outputs[1].trace,error:outputs[1].error?{name:outputs[1].error.name,message:outputs[1].error.message}:null,sameHostErrorRealm:true});
}
function workspace(i,o={}) {
  const trace=[], grants=new Map(), doc={id,tenantId:tenant,ownerId:'author',name:'newsletter',revision:3,status:'draft',updatedAt:new FixedDate(),design,config};
  if(o.existingGrant)grants.set('recipient',{role:'viewer'});
  const invitation={id:'invite',documentId:id,authorId:o.wrongAuthor?'other':'author',email:'recipient@example.test',role:'editor',accountRole:o.admin?'admin':'member',sourceClientIds:['prior-client'],expiresAt:new FixedDate(fixed+1000)};
  const log=(label,args)=>trace.push([label,clean(args)]);
  const fake = {
    wsNewsletterDocument:{findFirst:async args=>{log('documentRead',args);return o.noDocument?null:doc;},updateMany:async args=>{log('documentCAS',args);return {count:o.raced?0:1};}},
    wsNewsletterReviewer:{findFirst:async args=>{log('grantRead',args);return grants.get('recipient')??null;},createMany:async args=>{log('grantWrite',args);assert.equal(args.skipDuplicates,true);if(o.separateRole)grants.set('recipient',{role:'viewer'});else grants.set('recipient',{role:args.data[0].role});}},
    wsNewsletterInvitation:{findMany:async args=>{log('pendingRead',args);assert.equal(args.where.activatedAt,null);assert.equal(args.where.cancelledAt,null);assert(args.where.expiresAt.gt instanceof FixedDate);return o.noPending?[]:[invitation];},findFirst:async args=>{log('liveInviteRead',args);return o.cancelledLive||o.expiredLive?null:invitation;},update:async args=>{log('inviteWrite',args);}},
    wsNewsletterStage:{upsert:async args=>{log('stageWrite',args);assert.deepEqual(args.update,{});return{id:'stage',name:'newsletter',createdAt:new FixedDate()};}},
    $queryRaw:async (...args)=>{log('syntheticLock',args);return o.lockMissing?[]:[{id}];},
    $transaction:async fn=>{trace.push(['fakeTransaction']);return fn(fake);},
    wsNewsletterAsset:{findUnique:async args=>{log('assetRead',args);return{file:Buffer.from('retained'),mimeType:'image/png'};}}
  };
  const h=Object.create(ws[i]);h.trace=trace;h.prisma=fake;h.notifications={create:async args=>{log('notify',args);if(o.notifyFail)throw new Error('notification fake refusal');}};h.logger={warn:message=>trace.push(['warn',message])};
  h.source={newsletterMember:async(_tenant,user)=>{trace.push(['memberRead',user]);if(user==='author')return o.noAuthor?null:{clerkUserId:'author',email:'author@example.test',role:'user_admin'};return o.noMember?null:{clerkUserId:'recipient',email:o.noEmail?null:'recipient@example.test',role:'standard_user'};},newsletterMemberByEmail:async(_tenant,email)=>{trace.push(['memberByEmail',email]);return o.recipientMissing?null:{clerkUserId:'recipient',role:'standard_user'};},resolveUserId:async user=>{trace.push(['resolveUser',user]);return user;},getClient:async(_tenant,user,client)=>{trace.push(['sourceWall',user,client]);return{wallAllowed:!o.wallDenied};}};
  h.checks=()=>[];h.preview=async()=>{trace.push(['syntheticPreview']);return{html:'<p>fake preview</p>',plainText:'fake preview'};};
  return h;
}
function publicHarness(i,o={}) {
  const trace=[], row={id:'access',tenantId:tenant,userId:'sender',email:'recipient@example.test',draftVersionId:o.noVersion?null:'version',stageId:'stage',html:'retained archive',surveyAnswers:{prior:'kept'}};
  const tag=async()=>{trace.push(['surveyStageRead']);return[{design:{sections:[{blocks:[{id:'survey',kind:'survey',question:'Question',options:['yes'],columns:[]}]}]}}];};
  const fake={newsletterRecipientAccess:{findUnique:async args=>{trace.push(['tokenRead',args]);return o.noAccess?null:row;},update:async args=>{trace.push(['surveyWrite',args]);}},outreachDelivery:{count:async args=>{trace.push(['deliveryEligibility',args]);assert.deepEqual(args.where.status.in,['pending','sending','sent','unknown']);assert.equal(args.where.sendIntent.testMode,false);return o.unpublished?0:1;}},newsletterSubscription:{upsert:async args=>{trace.push(['suppressionWrite',args]);assert.deepEqual(args.where.tenantId_userId_email,{tenantId:tenant,userId:'sender',email:'recipient@example.test'});}},$queryRaw:tag};
  const h=Object.create(core[i]);h.trace=trace;h.prisma={withSystem:async fn=>fn(fake),withTenant:async(t,fn)=>{trace.push(['tenantScope',t]);assert.equal(t,tenant);return fn(fake);}};return h;
}
const writes = h => h.trace.filter(row=>['grantWrite','inviteWrite','notify','stageWrite','suppressionWrite','surveyWrite'].includes(row[0]));
(async()=>{
  for(const [label,o,wantError,wantWrites]of[
    ['existing reviewer',{existingGrant:true},false,0],['pending matching invitation',{},false,3],['recipient removed',{noMember:true},true,0],['recipient lacks email',{noEmail:true},true,0],['no pending invitation',{noPending:true},true,0],['author removed',{noAuthor:true},true,0],['wrong original author',{wrongAuthor:true},true,0],['admin role mismatch',{admin:true},true,0],['recipient email lookup absent',{recipientMissing:true},true,0],['source wall revoked',{wallDenied:true},true,0],['cancelled at live read',{cancelledLive:true},true,0],['expired at live read',{expiredLive:true},true,0],['document lock missing',{lockMissing:true},true,0],['separately granted role wins',{separateRole:true},false,2],['notification refuses after commit',{notifyFail:true},false,3],['document absent',{noDocument:true},true,0],
  ]) await compare('reviewRow '+label,i=>workspace(i,o),h=>h.reviewRow(ctx,id),({h,error})=>{assert.equal(!!error,wantError);assert.equal(writes(h).length,wantWrites);if(o.separateRole)assert(h.trace.some(row=>row[0]==='inviteWrite'&&row[1].data.cancelledAt));if(o.notifyFail)assert(h.trace.some(row=>row[0]==='warn'));});
  for(const o of [{existingGrant:true},{existingGrant:true,raced:true}])await compare('viewer cannot stage '+JSON.stringify(o),i=>workspace(i,o),h=>h.stage(ctx,id,3),({h,error})=>{assert(error instanceof NotFoundException);assert.equal(writes(h).length,0);});
  for(const o of [{},{raced:true}])await compare('editor exact revision CAS '+JSON.stringify(o),i=>workspace(i,o),h=>h.stage(ctx,id,3),({h,error})=>{assert.equal(!!error,!!o.raced);const claim=h.trace.find(row=>row[0]==='documentCAS');assert.equal(claim[1].where.revision,3);assert.equal(claim[1].where.reviewers.some.role,'editor');assert.equal(h.trace.filter(row=>row[0]==='stageWrite').length,o.raced?0:1);});
  await compare('stale stage revision',i=>workspace(i),h=>h.stage(ctx,id,2),({h,error})=>{assert(error instanceof ConflictException);assert(!h.trace.some(row=>row[0]==='documentCAS'));});
  const token='a'.repeat(64);
  for(const o of [{},{noAccess:true},{noVersion:true},{unpublished:true}])await compare('archive eligibility '+JSON.stringify(o),i=>publicHarness(i,o),h=>h.publicArchive(token),({h,error})=>{assert.equal(!!error,!!(o.noAccess||o.noVersion||o.unpublished));assert.equal(writes(h).length,0);});
  await compare('malformed public token',i=>publicHarness(i),h=>h.publicArchive('not-token'),({h,error})=>{assert(error instanceof NotFoundException);assert.equal(h.trace.length,0);});
  for(const submit of [false,true])await compare('preferences confirmed '+submit,i=>publicHarness(i),h=>h.preferences(token,submit),({h,error})=>{assert(!error);assert.equal(writes(h).length,submit?1:0);});
  for(const submit of [false,true])await compare('survey confirmed '+submit,i=>publicHarness(i),h=>h.survey(token,'survey','yes',submit),({h,error})=>{assert(!error);assert.equal(writes(h).length,submit?1:0);});
  await compare('survey invalid choice',i=>publicHarness(i),h=>h.survey(token,'survey','bad',true),({h,error})=>{assert(error instanceof NotFoundException);assert.equal(writes(h).length,0);});
  const groupCases=[[{email:'one@example.test',groupMembers:[{email:'two@example.test'}]}],[{email:'one@example.test',groupMembers:[]}],[{email:'one@example.test',groupMembers:[]},{email:'two@example.test',groupMembers:[]}]];
  for(const rows of groupCases){const outputs=normalize.map(fn=>{try{return{value:fn(rows)}}catch(e){return{error:e.constructor,message:e.message}}});assert.deepEqual(outputs[1],outputs[0]);results.push({label:'original group refusal/empty array behavior',sameHostErrorRealm:true,error:outputs[1].message??null});}
  function sendFixture(i,o={}){
    const trace=[],h=Object.create(core[i]);h.trace=trace;
    h.runtime={assertExternalAction:(...args)=>{trace.push(['runtimeAction',args]);if(o.runtimeDenied)throw new ForbiddenException('refusing fake runtime');}};
    h.record=async(...args)=>{trace.push(['currentRecordAndSourceAuthority',args]);if(o.authorityDenied)throw new NotFoundException('refusing fake record/source authority');return{row:{metadata:{newsletterVersionIds:['version1','version2'],newsletterSenderId:'sender'}},stage:{id:'stage'}};};
    const prior=o.prior?{id:'intent',outreachRecordId:'record',senderConnectionId:o.wrongSender?'other':'sender',testMode:!!o.wrongMode,deliveries:[{draftVersionId:o.wrongVersion?'other':'version1'},{draftVersionId:'version2'}]}:null;
    h.prisma={withTenant:async(_tenant,fn)=>fn({outreachSendIntent:{findFirst:async args=>{trace.push(['receiptRead',args]);return prior;}}})};
    h.sendIntents={createIntent:async(...args)=>{trace.push(['fakeIntentCreate',args]);return{intentId:'new-intent'};}};
    h.engagement={updateOutreachRecord:async(...args)=>trace.push(['fakeLegacyMetadataWrite',args])};
    return h;
  }
  for(const [label,o,versions,wantError,wantCreates]of[
    ['exact durable replay',{prior:true},['version2','version1'],false,0],['same key wrong sender',{prior:true,wrongSender:true},['version1','version2'],true,0],['same key wrong mode',{prior:true,wrongMode:true},['version1','version2'],true,0],['same key wrong content',{prior:true,wrongVersion:true},['version1','version2'],true,0],['new partial selection',{},['version1'],true,0],['new superseded selection',{},['old','version2'],true,0],['new repeated version',{},['version1','version1'],true,0],['runtime refuses before receipt',{prior:true,runtimeDenied:true},['version1','version2'],true,0],['current authority refuses replay',{prior:true,authorityDenied:true},['version1','version2'],true,0],['new exact prepared selection',{},['version1','version2'],false,1],
  ])await compare('rich send '+label,i=>sendFixture(i,o),h=>h.sendCurrent(ctx,'record',{requestKey:'saved-request',senderConnectionId:'sender',versionIds:versions},false),({h,error})=>{assert.equal(!!error,wantError);assert.equal(h.trace.filter(r=>r[0]==='fakeIntentCreate').length,wantCreates);assert.equal(h.trace[0][0],'runtimeAction');if(o.runtimeDenied||o.authorityDenied)assert(!h.trace.some(r=>r[0]==='receiptRead'));});
  const result={source:candidate,original:C,comparisons:results.length,results,syntheticPortsOnly:true,sameHostErrorRealm:true,actualRouteGetOrApplicationGraphImported:false,sqlNativeProviderClientCalls:0,
    limits:['Synthetic lock/query traces do not prove database predicates, RLS/MVCC or constraints','Preview is synthetic; exact parser dependency remains unavailable','No real rendering, provider, SDK, worker or client construction','Original notification failures are fail-soft after grant commit; GET activation writes are explicit','Multiple empty group arrays retain original duplicate-key behavior'],finalAcceptance:false};
  fs.writeFileSync(out+'fake-authority-review.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({comparisons:results.length,source:candidate,actualRouteOrSqlProviderCalls:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
