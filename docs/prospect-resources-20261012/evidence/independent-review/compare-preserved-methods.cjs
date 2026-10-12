const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const ts = require('/workspace/capirov2-prospect-resources/apps/api/node_modules/typescript');
const repo = '/workspace/backend-qualification-20261012/independent-review/prospect-resource-design/source-056bae1';
const path = 'apps/api/src/engagement/engagement.service.ts';
const names = ['sendSingleMail', 'eraseAttachmentAsSystem', 'reconcileFailedAttachmentDeletes'];
function load(ref) {
 const raw = cp.execFileSync('git',['show',ref+':'+path],{cwd:repo,encoding:'utf8'});
 const tree = ts.createSourceFile(path,raw,ts.ScriptTarget.Latest,true);
 const found = {};
 function visit(node) {
  if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(tree))) found[node.name.getText(tree)] = node.getText(tree);
  ts.forEachChild(node,visit);
 }
 visit(tree); return found;
}
const base = load('b1ac2649e134af560d41bee790cacbd61de01c9b');
const candidate = load('e7dd54326b8c2eb147845670e23f8760c0c6ce5d');
const result = names.map(name=>({name,byteIdentical:base[name]===candidate[name],sha256:crypto.createHash('sha256').update(candidate[name]).digest('hex')}));
fs.writeFileSync(repo+'/../preserved-methods.json',JSON.stringify(result,null,2)+'\n');
if(result.some(x=>!x.byteIdentical))process.exit(1);
console.log(JSON.stringify(result));
