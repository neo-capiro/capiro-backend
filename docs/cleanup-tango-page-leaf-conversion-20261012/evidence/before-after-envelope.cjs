// Actual parsing/catch fragments only. No constructors, fetch, timers or modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const packet = 'docs/cleanup-tango-page-leaf-conversion-20261012/evidence/';
const oldPacket = 'docs/cleanup-next-tango-audit-independent-review-20261012/evidence/';
const golden = JSON.parse(fs.readFileSync(oldPacket+'error-realm-challenge-with-full-profiles.json','utf8'));
const inputHarness = fs.readFileSync('docs/cleanup-next-tango-seam-audit-20261012/evidence/original-envelope-profiles.mjs','utf8');
const ast = ts.createSourceFile('original-harness.mjs',inputHarness,ts.ScriptTarget.Latest,true);
const inputDeclaration = ast.statements.filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(d=>d.name.getText(ast)==='inputs');
const inputs = new Function('return ('+inputDeclaration.initializer.getText(ast)+');')();
const errorText = fs.readFileSync('apps/api/src/external/tango/tango.errors.ts','utf8');
const errorAst = ts.createSourceFile('errors.ts',errorText,ts.ScriptTarget.Latest,true);
const notConfigured = errorAst.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='TangoNotConfiguredError').getText(errorAst);
const helperText = fs.readFileSync('apps/api/src/external/tango/tango-rest-page.ts','utf8');
const helperAst = ts.createSourceFile('helper.ts',helperText,ts.ScriptTarget.Latest,true);
const candidateHelpers = helperAst.statements.filter(ts.isFunctionDeclaration).map(n=>n.getText(helperAst)).join('\n');
function decoder(text,name,after) {
  const source=ts.createSourceFile(name+'.ts',text,ts.ScriptTarget.Latest,true);
  const client=source.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===`Tango${name[0].toUpperCase()+name.slice(1)}Client`);
  const method=client.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(source)===(name==='subaward'?'listSubawards':'list'));
  const guarded=method.body.statements.find(ts.isTryStatement);
  const start=guarded.tryBlock.statements.findIndex(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(source)==='parsed'));
  assert(start>0);
  const parser=guarded.tryBlock.statements.slice(start).map(n=>n.getText(source)).join('\n');
  const classes=source.statements.filter(n=>ts.isClassDeclaration(n)&&n!==client).map(n=>n.getText(source)).join('\n');
  const helpers=after?candidateHelpers:source.statements.filter(ts.isFunctionDeclaration).map(n=>n.getText(source)).join('\n');
  const fragment=`${notConfigured}\n${classes}\n${helpers}\nexport function decode(rawText:string,response:any){const label='fixture';try{${parser}}${guarded.catchClause.getText(source)}}`;
  const code=ts.transpileModule(fragment,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  assert(!/\b(?:fetch|fetchImpl|setTimeout|clearTimeout|AbortController|process|require)\b/.test(code));
  return {parserSha256:crypto.createHash('sha256').update(parser).digest('hex'),run(factory){
    const input=factory();const exports={};
    new Function('exports','JSON','URL','Number','Math','Error',code)(exports,{parse:()=>input},URL,Number,Math,Error);
    let result;
    try{result={returned:exports.decode.call({baseUrl:'https://tango.makegov.com',timeoutMs:30000},'synthetic',{status:200,headers:new Headers()})};}
    catch(error){result={threw:{name:error.name,status:error.status,message:error.message,rate:error.rate}};}
    return JSON.parse(JSON.stringify({result,getterReads:input?.reads}));
  }};
}
const results=[];
for(const name of ['dibbs','sbir','subaward']) {
  const before=decoder(fs.readFileSync(packet+`originals/tango-${name}.client.ts.txt`,'utf8'),name,false);
  const after=decoder(fs.readFileSync(`apps/api/src/external/tango/tango-${name}.client.ts`,'utf8'),name,true);
  for(const [label,factory] of inputs) {
    const old=before.run(factory);const current=after.run(factory);
    const reviewed=golden.coherentOriginalResults.find(r=>r.client===name&&r.label===label);
    assert.equal(before.parserSha256,reviewed.parserSha256);
    assert.deepEqual(old,JSON.parse(JSON.stringify({result:reviewed.result,getterReads:reviewed.getterReads})), 'unchanged reviewed coherent original');
    assert.deepEqual(current,old,'before/after exact error message and effects: '+name+'/'+label);
    results.push({client:name,label,before:old,after:current,equal:true});
  }
}
assert.equal(results.length,54);
const receipt={source:'802bbd0b2c510a44e46a9952d8127e7edc55aaaa',cases:18,clients:3,beforeExecutions:54,afterExecutions:54,results,
  coherentHostErrorRealm:true,errorMessagesNormalized:false,all54ReviewedGoldenResultsExact:true,priorFourVmMessageDifferencesRemainQualified:true,
  scope:'Only actual original/candidate success-parser and catch fragments with frozen factory literals; no constructor/fetch/timer/module/provider/database execution'};
fs.writeFileSync(packet+'before-after-envelope.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({beforeExecutions:54,afterExecutions:54,coherentHostErrorRealm:true,errorMessagesNormalized:false,allGoldenResultsExact:true}));
