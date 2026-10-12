const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict'),ts=require('/workspace/capirov2/node_modules/typescript');
const C='1e99f0921b207318c6d2abf03927b5c4daa5768b',Q='7ea444c74a5637577aa0eb3cb99cb420b5f8223e',candidate='a247f7a02a9b94d95e9ee5a516b396202aea994b',path='apps/api/src/engagement/outreach-send-intent.service.ts',out='docs/cleanup-newsletter-two-contract-independent-review-20261012/evidence/';
const text=(pin,p)=>cp.execFileSync('git',['show',`${pin}:${p}`],{encoding:'utf8'}),parse=s=>ts.createSourceFile('source.ts',s,ts.ScriptTarget.Latest,true);
function member(pin,name){const s=text(pin,path),sf=parse(s),cl=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='OutreachSendIntentService'),n=cl.members.find(n=>n.name?.getText(sf)===name);assert(n,name);return{sf,node:n,text:n.getText(sf)};}
function tokens(s){const sc=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,s),r=[];let k;while((k=sc.scan())!==ts.SyntaxKind.EndOfFileToken)r.push([k,sc.getTokenText()]);return r;}
const b=member(C,'deliverClaimed'),a=member(candidate,'deliverClaimed'),q=member(Q,'deliverClaimed');
const hook=a.node.body.statements[0].getText(a.sf);assert.deepEqual(tokens(hook),tokens(b.node.body.statements[0].getText(b.sf)));
assert.deepEqual(tokens(a.node.body.getText(a.sf).replace(hook,'')),tokens(q.node.body.getText(q.sf)));
assert.equal(a.node.body.getText(a.sf).replace(hook,'').replace(/^\{\n[ \t]*\n/,'{\n'),q.node.body.getText(q.sf));
const parameterShape=({sf,node})=>node.parameters.map(p=>({name:p.name.getText(sf),optional:!!p.questionToken,type:ts.isUnionTypeNode(p.type)?p.type.types.map(t=>t.getText(sf)):p.type.getText(sf)}));
assert.deepEqual(parameterShape(a),parameterShape(q));
const create=member(candidate,'createIntent'),oldCreate=member(Q,'createIntent');
const addedRendering= `const body = isWorkspaceNewsletterVersion(v)\n        ? { content: v.body, contentType: 'HTML' as const }\n        : renderOutreachBody(v.body);\n      const rendered = appendOutreachSignature(body, signature.signatureHtml);`;
assert(create.node.body.getText(create.sf).includes(addedRendering));
const addedRenderComment='// Newsletter HTML was built and sanitized by the trusted importer. Generic\n      // edits cannot retain this format. Keep its responsive tables and CSS intact.\n      ';
assert(create.node.body.getText(create.sf).includes(addedRenderComment));
assert(text(C,path).includes(addedRenderComment));
assert.equal(create.node.body.getText(create.sf).replace(addedRenderComment,'').replace(addedRendering,'const rendered = appendOutreachSignature(renderOutreachBody(v.body), signature.signatureHtml);'),oldCreate.node.body.getText(oldCreate.sf));
const modified=['createIntent','deliverClaimed','loadSendableVersions'];
const original=(()=>{const sf=parse(text(Q,path)),cl=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='OutreachSendIntentService');return cl.members.filter(n=>n.name).map(n=>n.name.getText(sf));})();
for(const name of original.filter(n=>!modified.includes(n)))assert.equal(member(candidate,name).text,member(Q,name).text,name);
const classifierSource=text(candidate,path),sf=parse(classifierSource),classifier=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='isWorkspaceNewsletterVersion').getText(sf).replace(/^export /,'');
function make(pin){const statement=member(pin,'deliverClaimed').node.body.statements[0].getText(member(pin,'deliverClaimed').sf);const code=ts.transpileModule('async function sourceGate(ctx,delivery,runtimeAction){'+statement+';return "downstream-boundary-not-executed";}',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;return new Function('assertNewsletterSourceAccess','truncateError',code+'\nreturn sourceGate;');}
const gate=[C,candidate].map(make),results=[];
async function run(i,o={}){const trace=[],h={prisma:{withTenant:async(tenant,fn)=>{trace.push(['scope',tenant]);return fn({newsletterRecipientAccess:{findFirst:async args=>{trace.push(['accessRead',args]);return o.noAccess?null:{id:'access',stageId:'stage'};}},newsletterSubscription:{count:async args=>{trace.push(['subscriptionRead',args]);return o.subscribed===false?1:0;}}});}},finishDelivery:async(...args)=>trace.push(['finish',...args])};const fn=gate[i](async(_p,ctx,id)=>{trace.push(['currentSourceAndMember',ctx,id]);if(o.sourceDenied)throw new Error('refused current source');},m=>m);const value=await fn.call(h,{tenantId:'tenant',userId:'sender'}, {generationKey:o.group?'group:legacy':o.ordinary?'manual:ordinary':'newsletter:access',draftVersionId:'version',id:'delivery',envelope:{to:[{email:'To@Example.test'}],cc:['Cc@Example.test'],bcc:['Bcc@Example.test']}},o.test?'outreach_test_send':'outreach_send');return{trace,value};}
(async()=>{
 for(const [label,o,code]of[['ordinary delivery unchanged',{ordinary:true},null],['dormant group unchanged',{group:true},null],['real individual source and subscription',{},null],['individual test still checks source',{test:true},null],['recipient receipt absent',{noAccess:true},'NEWSLETTER_ACCESS_MISSING'],['source/member revoked',{sourceDenied:true},'NEWSLETTER_SOURCE_UNAVAILABLE'],['recipient to/cc/bcc unsubscribed',{subscribed:false},'NEWSLETTER_UNSUBSCRIBED'],['test ignores subscription only',{test:true,subscribed:false},null]]){
  const before=await run(0,o),after=await run(1,o);assert.deepEqual(after,before,label);
  const finish=after.trace.find(r=>r[0]==='finish');assert.equal(finish?.[3].errorCode??null,code);
  if(!code)assert.equal(after.value,'downstream-boundary-not-executed');else assert.equal(after.value,undefined);
  if(!o.group&&!o.ordinary&&!o.noAccess)assert(after.trace.some(r=>r[0]==='currentSourceAndMember'));
  const sub=after.trace.find(r=>r[0]==='subscriptionRead');if(sub)assert.deepEqual(sub[1].where.email.in,['to@example.test','cc@example.test','bcc@example.test']);
  results.push({label,trace:after.trace,downstreamProviderNotExecuted:true});
 }
 const classifyCode=ts.transpileModule(classifier,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const classify=new Function(classifyCode+'\nreturn isWorkspaceNewsletterVersion;')();
 const valid={contentFormat:'workspace_newsletter',newsletterStageId:'stage',generationStatus:'manually_authored'};
 assert.equal(classify(valid),true);const rejects=[{}, {...valid,contentFormat:'outreach'}, {...valid,newsletterStageId:null},{...valid,newsletterStageId:''},{...valid,generationStatus:'generated'},{...valid,generationStatus:'generation_failed'}];for(const row of rejects)assert.equal(classify(row),false);
 const load=member(candidate,'loadSendableVersions').text,loadC=member(C,'loadSendableVersions').text;
 assert.deepEqual(tokens(load),tokens(loadC));
 const loadAst=member(candidate,'loadSendableVersions');
 const loop=loadAst.node.body.statements.find(ts.isForOfStatement);assert(loop);
 const insertedIfs=loop.statement.statements.filter(n=>ts.isIfStatement(n)&&n.expression.getText(loadAst.sf).startsWith('isWorkspaceNewsletterVersion(v)'));
 assert.equal(insertedIfs.length,2);
 let inverseLoad=load.replace('          contentFormat: true,\n          newsletterStageId: true,\n          generationStatus: true,\n','');
 for(const inserted of insertedIfs){const segment='      '+inserted.getText(loadAst.sf)+'\n';assert(inverseLoad.includes(segment));inverseLoad=inverseLoad.replace(segment,'');}
 const condition='      if (\n        this.externalSendV2Required &&\n        !testMode &&\n        !isPromptSpecV2OrLater(v.promptSpecVersion) &&\n        !isWorkspaceNewsletterVersion(v)\n      ) {';
 assert(inverseLoad.includes(condition));
 inverseLoad=inverseLoad.replace(condition,'      if (this.externalSendV2Required && !testMode && !isPromptSpecV2OrLater(v.promptSpecVersion)) {');
 assert.equal(inverseLoad,member(Q,'loadSendableVersions').text);
 const versionRows=source=>{const ast=parse(source);return ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='isWorkspaceNewsletterVersion')?.getText(ast);};assert.deepEqual(tokens(versionRows(classifierSource)),tokens(versionRows(text(C,path))));
 const result={source:candidate,original:C,ordinaryBaseline:Q,individualLateUseComparisons:results.length,results,trustedClassifierRefusals:rejects.length,validTupleAccepted:true,
  canonicalLateHookExactOriginalC:true,allRemainingDeliveryCodeBytesExactQ:true,otherExistingMembersBytesExactQExceptThreeDeclaredMethods:true,loadSendableVersionsExactOriginalC:true,
  createIntentBodyByteExactQAfterInverseKnownCRendering:true,loadVersionsByteExactQAfterInverseThreeFieldsTwoChecksAndTrustedPromptPredicate:true,
  runtimeOrSqlProviderCalls:0,fullDeliveryOrWorkerExecuted:false,sourceMemberAuthorityPortSynthetic:true,scope:'Original individual newsletter pre-provider boundary only; downstream is a named inert return boundary',nativeAcceptance:false,finalAcceptance:false};
 fs.writeFileSync(out+'fake-sender-boundaries.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({comparisons:results.length,classifierRefusals:rejects.length,remainingDeliveryExactQ:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
