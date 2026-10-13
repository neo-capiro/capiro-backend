const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {api,text,functions}=require('./public-runtime-v2.cjs');
const {createHash}=require('node:crypto');
const hash=functions(text('apps/api/src/engagement/outreach-draft.service.ts'),['contentHashOf'],{createHash}).contentHashOf;
const rawValidation=fs.readFileSync(path.join(__dirname,'baseline-apps__workspace__src__newsletters__newsletter-validation.ts.txt'),'utf8');
class BadRequestException extends Error {}
let unsafeUrlCalls=0;
const validators=functions(rawValidation,['fail','obj','str','num','bool','choice','array','id','url','validateNewsletterConfig','validateNewsletterSurveyDefinition','validateNewsletterSavedSurvey'],{
 BadRequestException,defaultNewsletterConfig:api.defaultNewsletterConfig,newsletterSafeUrl:()=>{unsafeUrlCalls++;throw new Error('Only empty URLs expected in this pure fixture');},
});
const createdAt='2026-10-12T12:34:56.123Z';
const id='a1111111-1111-4111-8111-111111111111',docId='b2222222-2222-4222-8222-222222222222',recordId='c3333333-3333-4333-8333-333333333333',versionId='d4444444-4444-4444-8444-444444444444';
const design=api.createNewsletterLayout();const config=api.defaultNewsletterConfig();
const doc={id:docId,name:'Current producer',revision:1,status:'draft',ownerId:'user_current',updatedAt:createdAt,config,design};
const stage={id,documentId:docId,revision:1,name:doc.name,config,design};
const version={id:versionId,artifactId:docId,outreachRecordId:recordId,version:1,sourceVersionId:null,generationKey:'key',recipientKey:'individual:fixture',audienceKind:'individual',subject:'Subject',body:'<p>Body</p>',contentHash:hash('Subject','<p>Body</p>'),generationStatus:'manually_authored',auditStatus:'passed',approvalStatus:'not_required',auditDecision:null,auditChecks:[],reviewRequestId:null,provider:null,model:null,promptSpecVersion:null,sendable:true,createdAt,recipientEmail:''};
const record={id:recordId,status:'draft',name:doc.name,stage,targets:[],senderConnectionId:null,subject:version.subject,versions:[version],intentId:null,excluded:[],tests:[]};
const rows=[];
function recordCase(name,shouldAccept,result,provenance){rows.push({name,shouldAccept,result,passed:result.ok===shouldAccept,provenance});}
recordCase('actual canonical contentHashOf prefix is accepted',true,api.parseNewsletterOutreachRecord(record),{hash:version.contentHash,producer:'actual unchanged contentHashOf MethodDeclaration',notPrivateBodyExecution:true});
recordCase('unprefixed digest is not the canonical producer field',false,api.parseNewsletterOutreachRecord({...record,versions:[{...version,contentHash:version.contentHash.slice(7)}]}),{bareDigest:version.contentHash.slice(7)});
const v7='e5555555-5555-7555-8555-555555555555';
const normalizedConfig=validators.validateNewsletterConfig({...config,clientId:v7});
const hillday=text('apps/workspace/src/hillday/hillday-source.service.ts');
const regexMatch=hillday.match(/const UUID_RE = (\/.*?\/i);/);if(!regexMatch)throw new Error('Expected actual isUuid regex');
const isUuid=functions(hillday,['isUuid'],{UUID_RE:vmRegex(regexMatch[1])}).isUuid;
function vmRegex(raw){return require('node:vm').runInThisContext(raw);}
recordCase('Workspace config producer and current source lookup accept UUIDv7 syntax',true,api.parseNewsletterCampaign({...doc,config:normalizedConfig}),{normalizedConfigClientId:normalizedConfig.clientId,currentSourceIsUuid:isUuid(v7),source:'validateNewsletterConfig + HillDaySourceService.isUuid/getClient gate',fakeCurrentGrant:true,nativeOrDeployed:false});
for(const [label,savedId,savedAt] of [['date-only nested saved survey',id,'2026-10-12'],['non-RFC nested saved survey identity','00000000-0000-0000-0000-000000000000',createdAt]]){
 const saved=validators.validateNewsletterSavedSurvey({id:savedId,name:'Saved data',revision:1,status:'draft',updatedAt:savedAt,sourceClientIds:[],definition:api.defaultNewsletterSurveyDefinition()});
 const survey=api.createNewsletterBlock('survey');survey.survey.saved=saved;
 const fixture={...doc,design:{...design,sections:[api.createNewsletterSection('Saved',[survey])]}};
 recordCase('actual private normalizer preserves '+label,true,api.parseNewsletterCampaign(fixture),{saved,producer:'actual validateNewsletterSavedSurvey/definition declarations',pureNormalizerOnly:true});
}
const manyConfig=validators.validateNewsletterConfig({...config,recipientIds:Array(10000).fill('n'),excludeRecipientIds:Array(10000).fill('n')});
const items=Array.from({length:100},()=>({...doc,config:manyConfig}));
const listResult=api.parseNewsletterDocumentList({items});
recordCase('actual list/config boundary100x(10000+10000) scalars fits producer contracts',true,listResult.ok?{ok:true,valueSummary:{documents:listResult.value.items.length}}:listResult,{documents:100,recipientIds:10000,excludeRecipientIds:10000,actualConfigNormalizer:true,sourceListLimit100:true,perDocumentUtf8Bytes:Buffer.byteLength(JSON.stringify(items[0]))});
if(unsafeUrlCalls!==0)throw new Error('Unexpected URL helper use');
const receipt={sourceHead:'37d574a35cd6d9aef79239a830b588fe1bd9769f',sourceTree:'ea8adba9e132a9c0d498ff7a49e0249d14b1682c',rows,passed:rows.filter(x=>x.passed).length,failed:rows.filter(x=>!x.passed).length,sqlExecuted:false,externalUrlCalls:unsafeUrlCalls,protectedBodyRead:false};
fs.writeFileSync(path.join(__dirname,'08-producer-boundary-37.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(receipt,null,2));
if(receipt.failed)process.exitCode=1;
