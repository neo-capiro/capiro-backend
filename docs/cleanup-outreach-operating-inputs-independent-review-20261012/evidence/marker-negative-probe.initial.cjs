const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');const ts=require('/workspace/capirov2/node_modules/typescript');
const root=process.cwd(),ev=path.join(root,'docs/cleanup-outreach-operating-inputs-independent-review-20261012/evidence');
const source=fs.readFileSync(path.join(root,'scripts/verify-outreach-v3-p1-architecture.mjs'),'utf8'),document=fs.readFileSync(path.join(root,'docs/contracts/outreach-v3-verification-inputs-v1.md'),'utf8');
const ast=ts.createSourceFile('verifier.mjs',source,ts.ScriptTarget.Latest,true),node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='validateVerificationInputsDocument');
if(!node)throw new Error('missing pure validator');const fn=vm.runInNewContext(node.getText(ast).replace(/^export /,'')+'\nvalidateVerificationInputsDocument',{createHash});
const rows=[];function probe(name,text,expected){const problems=Array.from(fn(text));const valid=problems.length===0;rows.push({name,expectedValid:expected,actualValid:valid,pass:valid===expected,problems});}
probe('valid original owned input',document,true);
for(const id of ['outreach-v3-phase1-foundations','outreach-v3-phase2-readiness']){
 const token=`<!-- ${id}:begin -->`,end=`<!-- ${id}:end -->`;
 probe(id+': missing begin',document.replace(token+'\n',''),false);
 probe(id+': missing end',document.replace(end,''),false);
 probe(id+': canonical duplicate begin withLF',document+token+'\n',false);
 probe(id+': duplicate exact begin token atEOF withoutLF',document+token,false);
 probe(id+': duplicate exact begin token withCRLF',document+token+'\r\n',false);
 probe(id+': duplicate exact begin token withspaceLF',document+token+' \n',false);
 probe(id+': canonical duplicate end',document+end,false);
}
const result={sourceSha256:createHash('sha256').update(source).digest('hex'),documentSha256:createHash('sha256').update(document).digest('hex'),scope:'Only exact pure validator function with Node crypto; no verifier import/Git/app/process/provider/DB execution',rows,passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass).length};
fs.writeFileSync(path.join(ev,'04-marker-negative-probe.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,failed:result.failed,failures:rows.filter(r=>!r.pass).map(r=>r.name)}));process.exitCode=result.failed?1:0;
