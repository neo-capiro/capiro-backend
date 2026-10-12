// Source-fragment tests only. No production import, constructor, GET, SQL, client or provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const fragments = [];
const clean = x => JSON.parse(JSON.stringify(x));
class NotFoundException extends Error {}
class BadRequestException extends Error {}
function ast(path) { return ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true); }
function fragment(path, names, className, globals = {}) {
  const sf = ast(path);
  let nodes;
  if (className) {
    const cls = sf.statements.find(x => ts.isClassDeclaration(x) && x.name?.text === className);
    assert(cls);
    nodes = names.map(name => cls.members.find(x => ts.isMethodDeclaration(x) && x.name?.getText(sf) === name));
  } else nodes = names.map(name => sf.statements.find(x => ts.isFunctionDeclaration(x) && x.name?.text === name));
  assert(nodes.every(Boolean));
  const text = nodes.map(x => x.getText(sf));
  text.forEach((source, i) => fragments.push({path, name:names[i], sha256:crypto.createHash('sha256').update(source).digest('hex')}));
  const source = className
    ? `class Inert { ${text.join('\n')} }; globalThis.result = Inert.prototype;`
    : text.map(x => x.replace(/^export\s+/, '')).join('\n') + `\nglobalThis.result = {${names.join(',')}};`;
  const js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS}}).outputText;
  assert(!/\brequire\s*\(|\bimport\s*\(|\bfetch\s*\(/.test(js));
  return vm.runInNewContext(js + '\nresult;', {NotFoundException, BadRequestException, ...globals}, {timeout:1000});
}
const path = 'apps/workspace/src/generation/ai-credential.service.ts';
const cred = fragment(path, ['resolveAnthropic','tryTenantCredential','resolveNewsletterImage','resolveNewsletterAltText','tryNewsletterTenantCredential'], 'AiCredentialService', {
  decryptSecret:(key, parts) => { assert.equal(key, 'inert-encryption-key'); assert.equal(parts.ciphertext, 'inert-cipher'); return 'inert-credential-result'; },
  upgradeTextModel:x=>x,
});
function credentialFixture({rows=[], fail=false, encryption=true, global=true}={}) {
  const trace=[];
  const o = Object.assign(Object.create(cred), {encryptionKey:encryption?'inert-encryption-key':undefined,
    globalOpenai:global?'inert-global':undefined, globalAnthropic:global?'inert-anthropic':undefined,
    newsletterImageModel:'inert-image-model',newsletterAltTextModel:'inert-alt-model',workspaceModel:'inert-text-model',
    logger:{warn:()=>trace.push('warn')}, prisma:{$queryRaw:async(strings,...values)=>{trace.push({sql:strings.join('?'),values});if(fail)throw Error('inert database unavailable');return rows;}}});
  return {o,trace};
}
const tenant='00000000-0000-4000-8000-000000000001';
for (const encryption of [false,true]) for (const global of [false,true]) test(`image facade missing tenant row encryption=${encryption} global=${global}`,async()=>{
  const {o,trace}=credentialFixture({encryption,global}); const result=await o.resolveNewsletterImage(tenant);
  assert.equal(result?.provider??null,global?'openai':null);assert.equal(trace.length,encryption?1:0);
  if(encryption){assert.deepEqual(trace[0].values,[tenant,'openai']);assert.match(trace[0].sql,/status = 'active'/);assert.match(trace[0].sql,/tenant_id = \?::uuid/);}
});
test('image facade tenant row uses same tenant scope and image model, never text override',async()=>{
  const {o,trace}=credentialFixture({rows:[{key_ciphertext:'inert-cipher',key_iv:'iv',key_auth_tag:'tag',model_override:'unrelated-text-override'}]});
  assert.deepEqual(clean(await o.resolveNewsletterImage(tenant)),{provider:'openai',secret:'inert-credential-result',model:'inert-image-model',usedTenantKey:true});
  assert.deepEqual(trace[0].values,[tenant,'openai']);
});
for(const global of [false,true])test(`image facade query failure falls back under original semantics global=${global}`,async()=>{
  const {o,trace}=credentialFixture({fail:true,global});assert.equal((await o.resolveNewsletterImage(tenant))?.usedTenantKey??null,global?false:null);assert.equal(trace[1],'warn');
});
test('alt facade fixes alt model after image tenant selection',async()=>{
  const {o}=credentialFixture({rows:[{key_ciphertext:'inert-cipher',key_iv:'iv',key_auth_tag:'tag',model_override:null}]});
  const out=await o.resolveNewsletterAltText(tenant);assert.equal(out.provider,'openai');assert.equal(out.model,'inert-alt-model');assert.equal(out.usedTenantKey,true);
});
test('existing Anthropic private query still uses literal fixed provider',async()=>{
  const {o,trace}=credentialFixture();assert.equal((await o.resolveAnthropic(tenant)).provider,'anthropic');assert.deepEqual(trace[0].values,[tenant]);assert.match(trace[0].sql,/provider = 'anthropic'/);assert(!trace[0].sql.includes('openai'));
});

const memberMethods=fragment('apps/workspace/src/hillday/hillday-source.service.ts',['newsletterMembers','newsletterMember','newsletterMemberByEmail'],'HillDaySourceService');
for(const [name,args,needle]of [['newsletterMembers',[tenant],/ORDER BY name LIMIT 500/],['newsletterMember',[tenant,'clerk-inert'],/u.clerk_user_id = \?/],['newsletterMemberByEmail',[tenant,'inert@example.invalid'],/lower\(u.email::text\) = \?/]])test(`existing member facade ${name} preserves active tenant scoped SQL envelope`,async()=>{
  const trace=[];const row={clerkUserId:'clerk-inert',name:'Synthetic',email:'inert@example.invalid'};
  const o=Object.assign(Object.create(memberMethods),{withTenant:async(id,fn)=>{assert.equal(id,tenant);return fn({$queryRaw:async(strings,...values)=>{trace.push({sql:strings.join('?'),values});return[row];}});}});
  assert.deepEqual(clean(await o[name](...args)),name==='newsletterMembers'?[row]:row);assert.match(trace[0].sql,/m.status = 'active'/);assert.match(trace[0].sql,/m.tenant_id = \?::uuid/);assert.match(trace[0].sql,needle);assert.deepEqual(trace[0].values,args);
});
for(const name of ['newsletterMember','newsletterMemberByEmail'])test(`${name} absent result is null`,async()=>{
  const o=Object.assign(Object.create(memberMethods),{withTenant:async(id,fn)=>fn({$queryRaw:async()=>[]})});assert.equal(await o[name](tenant,'absent'),null);
});

const notificationMethods=fragment('apps/workspace/src/notifications/notifications.service.ts',['create','list','markRead','markAllRead'],'NotificationsService',{
  prospectNotificationVisible:async(prisma,t,r,n)=>{prisma.visibility.push({tenant:t,recipient:r,id:n.id});return n.visible!==false;},
});
for(const kind of ['collab_invite','collab_accepted','collab_declined','newsletter_review','newsletter_comment'])test(`notification create preserves producer kind ${kind} and exact nullable identity`,async()=>{
  const writes=[];const o=Object.assign(Object.create(notificationMethods),{prisma:{wsNotification:{create:async x=>{writes.push(x);return x.data;}}}});
  const out=await o.create({tenantId:tenant,recipientId:'clerk-inert',kind,message:'Synthetic',...(kind.startsWith('newsletter_')?{newsletterId:'newsletter-id'}:{})});
  assert.equal(out.newsletterId,kind.startsWith('newsletter_')?'newsletter-id':null);assert.equal(out.draftId,null);assert.equal(out.collaboratorId,null);assert.equal(out.actionable,false);assert.equal(writes.length,1);
});
test('notification list checks visibility for both returned items and unread candidates',async()=>{
  const rows=[{id:'allowed',visible:true},{id:'denied',visible:false}];const p={visibility:[],wsNotification:{findMany:async()=>rows}};const o=Object.assign(Object.create(notificationMethods),{prisma:p});
  assert.deepEqual(clean(await o.list(tenant,'clerk-inert')),{items:[rows[0]],unread:1});assert.equal(p.visibility.length,4);assert(p.visibility.every(x=>x.tenant===tenant&&x.recipient==='clerk-inert'));
});
for(const found of [false,true])test(`notification markRead refuses absence/current denial before write found=${found}`,async()=>{
  let writes=0;const p={visibility:[],wsNotification:{findFirst:async()=>found?{id:'denied',visible:false}:null,update:async()=>{writes++;throw Error('must not write');}}};
  const o=Object.assign(Object.create(notificationMethods),{prisma:p});await assert.rejects(o.markRead(tenant,'clerk-inert','id'),NotFoundException);assert.equal(writes,0);
});
test('notification markRead preserves post-write recheck and revocation refusal',async()=>{
  let writes=0;const p={visibility:[],wsNotification:{findFirst:async()=>({id:'id',visible:true}),update:async()=>{writes++;return{id:'id',visible:false};}}};const o=Object.assign(Object.create(notificationMethods),{prisma:p});
  await assert.rejects(o.markRead(tenant,'clerk-inert','id'),NotFoundException);assert.equal(writes,1);assert.equal(p.visibility.length,2);
});
test('notification markAllRead updates only scoped visible IDs',async()=>{
  let write;const p={visibility:[],wsNotification:{findMany:async()=>[{id:'yes',visible:true},{id:'no',visible:false}],updateMany:async x=>{write=x;return{count:1};}}};const o=Object.assign(Object.create(notificationMethods),{prisma:p});
  assert.deepEqual(clean(await o.markAllRead(tenant,'clerk-inert')),{updated:1});assert.deepEqual(clean(write.where),{tenantId:tenant,recipientId:'clerk-inert',read:false,id:{in:['yes']}});
});

const newsletterPure=fragment('packages/shared/src/newsletter.ts',['visitNewsletterBlocks','newsletterSourceClients']);
const newsletterMethods=fragment('apps/workspace/src/newsletters/newsletter.service.ts',['reviewRow','activateInvitations','notify'],'NewsletterService',{
  isUuid:x=>/^[0-9a-f-]{36}$/i.test(x),newsletterSourceClients:newsletterPure.newsletterSourceClients,
});
const documentId='00000000-0000-4000-8000-000000000002';
function reviewFixture(options={}) {
  const trace=[];let grant=options.existingGrant?{role:options.existingGrant}:null;
  const row={id:documentId,ownerId:'owner',design:{sourceClientIds:['root-client'],sections:[{sourceClientIds:['section-client'],blocks:[{columns:[],survey:{saved:{sourceClientIds:['survey-client']}}}]}]},config:{clientId:'campaign-client'}};
  const invitation={id:'invitation',authorId:options.wrongAuthor?'other':'owner',email:'reviewer@example.invalid',role:'editor',accountRole:options.admin?'admin':'member',sourceClientIds:['invitation-client']};
  const member={clerkUserId:'reviewer',email:'reviewer@example.invalid',role:options.memberRole||'member'};
  const tx={$queryRaw:async()=>{trace.push('lock');return options.noLock?[]:[{id:documentId}];},
    wsNewsletterInvitation:{findFirst:async()=>options.noLive?null:invitation,update:async x=>trace.push({invitationUpdate:clean(x)})},
    wsNewsletterReviewer:{createMany:async x=>{trace.push({grantWrite:clean(x)});if(!grant)grant={role:options.competingRole||x.data[0].role};},findFirst:async()=>grant}};
  const p={wsNewsletterDocument:{findFirst:async()=>options.noDocument?null:row},wsNewsletterReviewer:{findFirst:async()=>grant},
    wsNewsletterInvitation:{findMany:async x=>{trace.push({pendingQuery:clean(x)});return options.noPending?[]:[invitation];}},
    $transaction:async fn=>{trace.push('tx-begin');const out=await fn(tx);trace.push('tx-commit');return out;}};
  const o=Object.assign(Object.create(newsletterMethods),{prisma:p,source:{newsletterMember:async(t,u)=>{assert.equal(t,tenant);return u==='owner'?(options.noAuthor?null:{clerkUserId:'owner',email:'owner@example.invalid'}):(options.noMember?null:member);},newsletterMemberByEmail:async()=>options.noRecipient?null:member},
    assertDesignClients:async()=>{trace.push('design-check');if(options.designDenied)throw new NotFoundException('wall');},
    assertClient:async(ctx,id)=>{trace.push({wallUser:ctx.clerkUserId,client:id});if(options.wallDenied)throw new NotFoundException('wall');if(options.infrastructureError)throw options.infrastructureError;},
    notifications:{create:async x=>{trace.push({notify:clean(x)});if(options.notifyError)throw Error('synthetic notification failure');}},logger:{warn:()=>trace.push('notification-warning')}});
  return{o,trace,row,ctx:{tenantId:tenant,clerkUserId:options.owner?'owner':'reviewer'}};
}
test('reviewRow existing grant avoids activation writes while current member/design checks remain',async()=>{
  const{o,trace,ctx}=reviewFixture({existingGrant:'viewer'});assert.equal((await o.reviewRow(ctx,documentId)).role,'viewer');assert.deepEqual(trace,['design-check']);
});
test('owner reviewRow does not manufacture a reviewer grant',async()=>{
  const{o,trace,ctx}=reviewFixture({owner:true});assert.equal((await o.reviewRow(ctx,documentId)).role,'owner');assert.deepEqual(trace,['design-check']);
});
test('reviewRow activation traces committed reviewer grant before in-app notification and design check',async()=>{
  const{o,trace,ctx}=reviewFixture();assert.equal((await o.reviewRow(ctx,documentId)).role,'editor');
  const write=trace.find(x=>x.grantWrite).grantWrite;assert.equal(write.skipDuplicates,true);assert.equal(write.data[0].userId,'reviewer');
  assert(trace.indexOf('tx-commit')<trace.findIndex(x=>x.notify));assert(trace.findIndex(x=>x.notify)<trace.indexOf('design-check'));
  assert.deepEqual([...new Set(trace.filter(x=>x.wallUser).map(x=>x.client))].sort(),['campaign-client','invitation-client','root-client','section-client','survey-client']);
  for(const client of ['campaign-client','invitation-client','root-client','section-client','survey-client'])assert.deepEqual(trace.filter(x=>x.client===client).map(x=>x.wallUser),['owner','reviewer']);
});
for(const key of ['noPending','noAuthor','noRecipient','wrongAuthor','admin','wallDenied','noMember','noLive','noLock'])test(`activation refusal ${key} leaves no grant or notification`,async()=>{
  const{o,trace,ctx,row}=reviewFixture({[key]:true});await o.activateInvitations(ctx,row);assert.equal(trace.filter(x=>x.grantWrite||x.notify).length,0);
});
test('activation preserves explicit existing role and cancels incompatible pending role',async()=>{
  const{o,trace,ctx,row}=reviewFixture({competingRole:'viewer'});await o.activateInvitations(ctx,row);assert(trace.find(x=>x.invitationUpdate).invitationUpdate.data.cancelledAt);assert.equal(trace.filter(x=>x.notify).length,0);
});
test('review activation notification failure is swallowed after committed grant',async()=>{
  const{o,trace,ctx}=reviewFixture({notifyError:true});assert.equal((await o.reviewRow(ctx,documentId)).role,'editor');assert(trace.includes('tx-commit'));assert(trace.includes('notification-warning'));
});
test('activation infrastructure error propagates without mapping to unavailable or writing',async()=>{
  const error=Error('synthetic infrastructure');const{o,trace,ctx,row}=reviewFixture({infrastructureError:error});await assert.rejects(o.activateInvitations(ctx,row),x=>x===error);assert(!trace.includes('tx-begin'));
});
test('reviewRow current design denial remains after original activation side effects',async()=>{
  const{o,trace,ctx}=reviewFixture({designDenied:true});await assert.rejects(o.reviewRow(ctx,documentId),NotFoundException);assert(trace.includes('tx-commit'));assert(trace.some(x=>x.notify));
});
for(const id of ['not-a-uuid',documentId])test(`reviewRow invalid/missing document ${id}`,async()=>{
  const{o,trace,ctx}=reviewFixture({noDocument:true});await assert.rejects(o.reviewRow(ctx,id),NotFoundException);assert.equal(trace.length,0);
});

const importer=fragment('apps/api/src/engagement/outreach-draft.service.ts',['importNewsletterVersion'],'OutreachDraftService',{VERSION_SELECT:{id:true},contentHashOf:(subject,body)=>`sha256:${crypto.createHash('sha256').update(`${subject}\n${body}`,'utf8').digest('hex')}`});
for(const available of [false,true])test(`trusted rich importer retains distinct stage identity available=${available}`,async()=>{
  const trace=[];let data;const tx={$queryRaw:async(strings,...values)=>{trace.push({sql:strings.join('?'),values});return available?[{id:'stage-id'}]:[];},outreachDraftVersion:{create:async x=>{data=x.data;trace.push('create');return{id:'draft-version'};}}};
  const o=Object.assign(Object.create(importer),{prisma:{withTenant:async(t,fn)=>{assert.equal(t,tenant);const out=await fn(tx);trace.push('commit');return out;}},assertRecordOwned:async()=>trace.push('record-owner'),findOrCreateArtifactId:async()=>{trace.push('artifact');return'artifact-id';},lockAndBumpArtifact:async()=>{trace.push('artifact-lock');return 7;},auditAndReload:async(c,x)=>{trace.push('audit');return x;}});
  const ctx={tenantId:tenant,clerkUserId:'owner',userId:'core-user'};const input={outreachRecordId:'record',newsletterStageId:'stage-id',subject:'Synthetic',body:'<p>inert</p>'};
  if(!available){await assert.rejects(o.importNewsletterVersion(ctx,input),NotFoundException);assert.equal(trace.filter(x=>typeof x==='string'&&['artifact','create','commit','audit'].includes(x)).length,0);}else{await o.importNewsletterVersion(ctx,input);assert.equal(data.contentFormat,'workspace_newsletter');assert.equal(data.newsletterStageId,'stage-id');assert.equal(data.generationStatus,'manually_authored');assert.equal(data.createdByUserId,'core-user');assert.equal(data.version,7);assert(trace.indexOf('commit')<trace.indexOf('audit'));}
  assert.deepEqual(trace[1].values,['stage-id',tenant,'owner']);assert.match(trace[1].sql,/ws_newsletter_stage/);assert(!trace[1].sql.includes('ws_doc_version'));
});
const sourceAccess=fragment('apps/api/src/engagement/newsletter-source-access.ts',['assertNewsletterSourceAccess'],undefined,{newsletterSourceClients:newsletterPure.newsletterSourceClients});
for(const gate of ['allowed','missing-stage','wall-denied'])test(`late rich source authority ${gate} remains tenant/member/client bounded`,async()=>{
  const trace=[];const stage={design:{sourceClientIds:['c1'],sections:[]},config:{clientId:'c2'}};const p={withTenant:async(t,fn)=>{assert.equal(t,tenant);return fn({$queryRaw:async(strings,...values)=>{trace.push({sql:strings.join('?'),values});return trace.length===1?(gate==='missing-stage'?[]:[stage]):[{allowed:gate!=='wall-denied'}];}});}};
  const ctx={tenantId:tenant,userId:'core-user'};
  if(gate==='allowed')await sourceAccess.assertNewsletterSourceAccess(p,ctx,'stage-id');else await assert.rejects(sourceAccess.assertNewsletterSourceAccess(p,ctx,'stage-id'),NotFoundException);
  assert.deepEqual(trace[0].values,['stage-id',tenant,'core-user']);assert.match(trace[0].sql,/m.status = 'active'/);if(gate==='missing-stage')assert.equal(trace.length,1);
});
const pure=fragment('apps/api/src/engagement/newsletter-outreach.service.ts',['normalizeNewsletterDestinations'],undefined,{email:/^[^\s@]+@[^\s@]+\.[^\s@]+$/});
test('rich normalizer refuses every nonempty group before any downstream side effect',()=>assert.throws(()=>pure.normalizeNewsletterDestinations([{email:'a@example.invalid',groupMembers:[{email:'b@example.invalid'}]}]),BadRequestException));
test('rich normalizer drops empty group property while retaining original duplicate-key baseline',()=>{
  const one=pure.normalizeNewsletterDestinations([{email:'a@example.invalid',groupMembers:[]}]);assert(!Object.hasOwn(one[0],'groupMembers'));
  assert.throws(()=>pure.normalizeNewsletterDestinations([{email:'a@example.invalid',groupMembers:[]},{email:'b@example.invalid',groupMembers:[]}]),/duplicate destinations/);
});
const classifier=fragment('apps/api/src/engagement/outreach-send-intent.service.ts',['isWorkspaceNewsletterVersion']);
for(const contentFormat of ['workspace_newsletter','outreach',undefined])for(const newsletterStageId of ['stage-id',null])for(const generationStatus of ['manually_authored','generated',undefined])test(`tuple classifier ${contentFormat}/${newsletterStageId}/${generationStatus}`,()=>{
  assert.equal(classifier.isWorkspaceNewsletterVersion({contentFormat,newsletterStageId,generationStatus}),contentFormat==='workspace_newsletter'&&Boolean(newsletterStageId)&&generationStatus==='manually_authored');
});
process.on('exit',()=>fs.writeFileSync('docs/cleanup-newsletter-two-contract-source-preservation-20261012/evidence/owner-fragment-hashes.json',JSON.stringify({sourceHead:'a247f7a02a9b94d95e9ee5a516b396202aea994b',sourceTree:'b87c85a0fc0ae57f876b86a8018a953adbddb71c',scope:'inert selected source fragments; no actual production imports/constructors/GET/SQL/providers',fragments},null,2)+'\n'));
