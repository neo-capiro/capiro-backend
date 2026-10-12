const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2-sender/apps/api/node_modules/typescript');
const repo = '/workspace/capirov2-review-memory-wording';
const output = '/workspace/backend-qualification-20261012/independent-review/memory-wording';
const base = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace';
const head = '539f62e7f2a3f87d9f56f1281e6fff717aed0958';
const policyReference = 'fd8765ec01d292013758606204f2c9d886cd31c1';
const files = ['apps/api/src/memory/memory-candidate-rules.ts','apps/api/src/meri/meri-tools.service.ts'];
const git = (...args) => cp.execFileSync('git', args, {cwd:repo,encoding:'utf8'});
const read = (ref, path) => git('show',`${ref}:${path}`);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const handoff = fs.readFileSync('/workspace/backend-qualification-20261012/memory-wording/HANDOFF-FROM-COORDINATOR.md','utf8');
const expected = {
 firmReason: handoff.match(/^> (Firm-wide memory remains pending.*)$/m)[1],
 clientReason: handoff.match(/^> (Client-scope memory remains pending.*)$/m)[1],
 firmMessage: handoff.match(/^- Firm: “(.*)”$/m)[1],
 clientMessage: handoff.match(/^- Client: “(.*)”$/m)[1],
};

// Closed two-module sandbox, with no database, fetch, filesystem or external
// require inside either evaluated module. Compare preserved base behavior to head.
function evaluate(ref, path) {
 const code = ts.transpileModule(read(ref,path), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module = {exports:{}};
 new vm.Script(code,{filename:path}).runInNewContext({module,exports:module.exports,require(name) {
  assert.equal(name,'../meri/memory-confidence.helpers.js');
  return evaluate(ref,'apps/api/src/meri/memory-confidence.helpers.ts');
 }},{timeout:1000});
 return module.exports;
}
const oldRules = evaluate(base, files[0]);
const newRules = evaluate(head, files[0]);
let count=0,changed=0,automated=0;
for (const scope of ['personal','firm','client'])
 for (const isAdmin of [true,false])
  for (const sourceKind of [undefined,'explicit_user','model_extraction','learning_signal','workspace_artifact','unknown_future_source'])
   for (const confidence of [undefined,null,0,0.7,1])
    for (const minConfidence of [undefined,0,1]) {
     const input={scope,isAdmin,sourceKind,confidence,minConfidence};
     const before=JSON.parse(JSON.stringify(oldRules.evaluateMemoryCandidate(input)));
     const after=JSON.parse(JSON.stringify(newRules.evaluateMemoryCandidate(input)));
     assert.deepEqual(Object.keys(after).sort(),['outcome','reason','ruleId']);
     assert.equal(after.outcome,before.outcome);assert.equal(after.ruleId,before.ruleId);
     const intended=after.ruleId==='memory.firm.requires_approval' ? expected.firmReason : after.ruleId==='memory.client.requires_approval' ? expected.clientReason : null;
     if (intended) {assert.equal(after.reason,intended);assert.equal(after.outcome,'WARN');changed++;}
     else assert.deepEqual(after,before);
     if (sourceKind==='model_extraction'||sourceKind==='learning_signal') {assert.equal(after.outcome,'WARN');automated++;}
     count++;
    }

// Exact four handoff strings. Then ignore only those two reason initializers and
// the single pending message property while fingerprinting every other AST node.
function fingerprint(text, file, isHead) {
 const root=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 let replacements=0;
 const walk=node=>{
  if (ts.isPropertyAssignment(node)) {
   const name=node.name.getText(root);
   if (file===files[0]&&name==='reason'&&ts.isObjectLiteralExpression(node.parent)) {
    const id=node.parent.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(root)==='id');
    if (id&&['memory.firm.requires_approval','memory.client.requires_approval'].includes(id.initializer.text)) {replacements++;return ['approved-reason',id.initializer.text];}
   }
   if (file===files[1]&&name==='message'&&node.initializer.getText(root).includes("I've proposed this as")) {
    replacements++;
    if (isHead) {
     assert(ts.isConditionalExpression(node.initializer));
     assert.equal(node.initializer.condition.getText(root),"pendingLabel === 'client'");
     assert.equal(node.initializer.whenTrue.text,expected.clientMessage);
     assert.equal(node.initializer.whenFalse.text,expected.firmMessage);
    }
    return ['approved-pending-message'];
   }
  }
  const children=[];ts.forEachChild(node,child=>{children.push(walk(child));});
  return [node.kind,ts.isIdentifier(node)||ts.isStringLiteralLike(node)||ts.isNumericLiteral(node)?node.text:null,children];
 };
 const signature=JSON.stringify(walk(root));
 assert.equal(replacements,file===files[0]?2:1);
 return {signature,replacements};
}
const syntax=files.map(file=>{
 assert.equal(read(policyReference,file),read(base,file),'policy reference drift');
 const before=fingerprint(read(base,file),file,false), after=fingerprint(read(head,file),file,true);
 assert.equal(after.signature,before.signature,'unexpected runtime syntax change');
 return {file,replacements:after.replacements,normalizedAstSha256:sha(after.signature),policyReferenceMatchesBase:true};
});
const changedRuntime=git('diff','--name-only',base,head).trim().split('\n').filter(p=>p.endsWith('.ts')&&!p.endsWith('.spec.ts'));
assert.deepEqual(changedRuntime.sort(),files.slice().sort());
const result={base,head,policyReference,handoffSha256:sha(handoff),decisionsCompared:count,intendedReasonChanges:changed,automatedPendingDecisions:automated,exactFourHandoffStrings:true,syntax,changedRuntime};
fs.writeFileSync(output+'/characterization.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
