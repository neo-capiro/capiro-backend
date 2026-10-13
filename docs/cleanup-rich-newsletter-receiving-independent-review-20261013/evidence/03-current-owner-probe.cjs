const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {api,text,functions,ts}=require('./public-runtime.cjs');
const rawValidation=fs.readFileSync(path.join(__dirname,'baseline-apps__workspace__src__newsletters__newsletter-validation.ts.txt'),'utf8');
const workspaceRaw=fs.readFileSync(path.join(__dirname,'baseline-apps__workspace__src__newsletters__newsletter.service.ts.txt'),'utf8');
const hillday=text('apps/workspace/src/hillday/hillday-source.service.ts');
class BadRequestException extends Error{}class NotFoundException extends Error{}class ConflictException extends Error{}
let htmlCalls=0,fontCalls=0,urlCalls=0;
const selected=functions(rawValidation,['fail','obj','str','num','bool','choice','array','id','url','validateNewsletterStyle','validateNewsletterDesign','validateNewsletterConfig','validateNewsletterSurveyDefinition','validateNewsletterSavedSurvey'],{
 ...api,BadRequestException,sanitizeNewsletterHtml:html=>{htmlCalls++;if(html!=='')throw new Error('Only empty fixture HTML allowed');return html;},validateNewsletterFonts:()=>{fontCalls++;throw new Error('No fixture fonts allowed');},newsletterSafeUrl:()=>{urlCalls++;throw new Error('Only empty fixture URLs allowed');},
});
function methods(raw,className,names){const file=ts.createSourceFile('methods.ts',raw,ts.ScriptTarget.Latest,true);const owner=file.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text===className);return names.map(name=>{const matches=owner?.members.filter(node=>ts.isMethodDeclaration(node)&&node.name.getText(file)===name);if(matches?.length!==1)throw new Error('Unique method '+name+' required');return matches[0].getText(file);}).join('\n');}
function compile(raw,injected){const emitted=ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;const module={exports:{}};vm.runInThisContext('(function(module,'+Object.keys(injected).join(',')+'){'+emitted+'\n})')(module,...Object.values(injected));return module.exports;}
const uuidLiteral=hillday.match(/const UUID_RE = (\/.*?\/i);/)[1];
const isUuid=functions(hillday,['isUuid'],{UUID_RE:vm.runInThisContext(uuidLiteral)}).isUuid;
const Source=compile('class Source { constructor(prisma){this.prisma=prisma;} '+methods(hillday,'HillDaySourceService',['withTenant','resolveUserId','getClient'])+' } module.exports=Source;',{isUuid});
const nameText=functions(workspaceRaw,['text'],{BadRequestException}).text;
const Newsletter=compile('class Newsletter { constructor(prisma,source,current){this.prisma=prisma;this.source=source;this.current=current;} async reviewRow(ctx,id){if(ctx.tenantId!==this.current.tenantId||ctx.clerkUserId!==this.current.ownerId||id!==this.current.id)throw new NotFoundException("fake current authority refused");return {row:this.current,role:"owner"};} '+methods(workspaceRaw,'NewsletterService',['scope','row','documentWriteScope','view','assertClient','assertDesignClients','get','save'])+' } module.exports=Newsletter;',{...selected,json:value=>JSON.parse(JSON.stringify(value)),text:nameText,newsletterSourceClients:api.newsletterSourceClients,NotFoundException,ConflictException});
const ctx={tenantId:'a1111111-1111-4111-8111-111111111111',clerkUserId:'user_current'};
const user='f6666666-6666-4666-8666-666666666666',docId='b2222222-2222-4222-8222-222222222222',v7='e5555555-5555-7555-8555-555555555555';
function clone(v){return JSON.parse(JSON.stringify(v));}
async function producer(previousConfig,previousDesign,nextConfig,nextDesign){
 const queries=[];const allowed=new Set(api.newsletterSourceClients(previousDesign,previousConfig.clientId).concat(api.newsletterSourceClients(nextDesign,nextConfig.clientId)));
 const tx={ $executeRaw:async(parts,...values)=>{queries.push({kind:'guc',text:parts.join('?'),values});if(values[0]!==ctx.tenantId)throw new Error('Fake tenant mismatch');return 1;},$queryRaw:async(parts,...values)=>{
  const sql=parts.join('?');queries.push({kind:'client',text:sql,values});if(!sql.includes('FROM clients')||values[1]!==ctx.tenantId||!allowed.has(values[2]))throw new Error('Fake current source denied');return [{id:values[2],wallAllowed:true}];
 }};
 const source=new Source({withSystem:async fn=>fn({$queryRaw:async(parts,...values)=>{queries.push({kind:'identity',text:parts.join('?'),values});if(values[0]!==ctx.clerkUserId)throw new Error('Fake Clerk mismatch');return[{id:user}];}}),$transaction:async(fn,options)=>{if(options.maxWait!==8000||options.timeout!==30000)throw new Error('Source timeout contract changed');return fn(tx);}});
 const current={id:docId,tenantId:ctx.tenantId,ownerId:ctx.clerkUserId,name:'Current producer',revision:1,status:'draft',updatedAt:new Date('2026-10-12T12:34:56.123Z'),config:previousConfig,design:previousDesign};
 let writes=0;
 const service=new Newsletter({wsNewsletterDocument:{updateMany:async args=>{if(JSON.stringify(args.where)!==JSON.stringify({id:docId,tenantId:ctx.tenantId,ownerId:ctx.clerkUserId,revision:1}))throw new Error('Fake CAS/scope mismatch '+JSON.stringify(args.where));writes++;Object.assign(current,args.data,{revision:2});return{count:1};}}},source,current);
 const value=await service.save(ctx,docId,{revision:1,name:'Current producer',config:nextConfig,design:nextDesign});
 return {value,writes,queries,sourceQueriesFake:true};
}
(async()=>{
 const rows=[];
 const baseConfig=api.defaultNewsletterConfig();const baseDesign=api.createNewsletterLayout();
 for(const mode of ['previous-primary-v7-provenance','over100-postvalidation-union']){
  const previous=clone(baseDesign),next=clone(baseDesign);const previousConfig=clone(baseConfig);const nextConfig=clone(baseConfig);
  if(mode==='previous-primary-v7-provenance')previousConfig.clientId=v7;
  else {previous.sourceClientIds=Array.from({length:100},(_,i)=>'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'));next.sections[0].sourceClientIds=['ffffffff-ffff-4fff-8fff-ffffffffffff'];}
  const actual=await producer(previousConfig,previous,nextConfig,next);
  const result=api.parseNewsletterCampaign(actual.value);
  rows.push({name:'actual save/get '+mode,shouldAccept:true,result:result.ok?{ok:true}:result,passed:result.ok,producerRootSources:actual.value.design.sourceClientIds,producerConfigClient:actual.value.config.clientId,writes:actual.writes,currentSourceFakeQueryCount:actual.queries.length,queryIdentityAndTenantChecked:true,actualFunctions:'NewsletterService.save/get/view/assertClient + HillDaySourceService.getClient/withTenant/resolveUserId + private config/design validation',native:false});
 }
 const doc={id:docId,name:'Current producer',revision:1,status:'draft',ownerId:'user_current',updatedAt:'2026-10-12T12:34:56.123Z',config:baseConfig,design:baseDesign};
 rows.push({name:'Workspace document owner permits resource UUIDv7',shouldAccept:true,result:api.parseNewsletterCampaign({...doc,id:v7}),producerGateIsUuid:isUuid(v7),passed:api.parseNewsletterCampaign({...doc,id:v7}).ok,native:false});
 for(const value of ['2026-02-30T12:00:00.000Z','2026-10-12T24:00:00.000Z']){const result=api.parseNewsletterCampaign({...doc,updatedAt:value});rows.push({name:'canonical row Date.toISOString cannot emit '+value,shouldAccept:false,result:result.ok?{ok:true}:result,passed:!result.ok,normalizedByDate:new Date(value).toISOString()});}
 const receipt={sourceHead:'8f19f4d7c77c621f8ea3a2d1c3d9b551e0d60414',rows,passed:rows.filter(x=>x.passed).length,failed:rows.filter(x=>!x.passed).length,sqlExecuted:false,protectedBodyRead:false,nonemptyUrlPortCalls:urlCalls,fontPortCalls:fontCalls,emptyHtmlIdentityPortCalls:htmlCalls};
 fs.writeFileSync(path.join(__dirname,'03-current-owner-probe.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(receipt,null,2));if(receipt.failed)process.exitCode=1;
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
