const ts=require('/workspace/capirov2-sender/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript');
const cp=require('node:child_process'),fs=require('node:fs'),crypto=require('node:crypto');
const repo='/workspace/capirov2-memory-wording',base='4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace';
const files=['apps/api/src/memory/memory-candidate-rules.ts','apps/api/src/meri/meri-tools.service.ts'];
const results=[];
for(const file of files){
 function normalize(text){
  let replacements=0;
  const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const result=ts.transform(sf,[context=>{
   const visit=node=>{
    if(file.includes('candidate-rules') && ts.isObjectLiteralExpression(node)){
     const id=node.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(sf)==='id');
     if(id&&['memory.firm.requires_approval','memory.client.requires_approval'].includes(id.initializer.text)){
      return ts.factory.updateObjectLiteralExpression(node,node.properties.map(p=>{
       if(ts.isPropertyAssignment(p)&&p.name.getText(sf)==='reason'){replacements++;return ts.factory.updatePropertyAssignment(p,p.name,ts.factory.createStringLiteral('APPROVED_WORDING'));}
       return p;
      }));
     }
    }
    if(file.includes('meri-tools')&&ts.isPropertyAssignment(node)&&node.name.getText(sf)==='message'&&node.initializer.getText(sf).includes("I've proposed this as")){
     replacements++;return ts.factory.updatePropertyAssignment(node,node.name,ts.factory.createStringLiteral('APPROVED_WORDING'));
    }
    return ts.visitEachChild(node,visit,context);
   };return node=>ts.visitNode(node,visit);
  }]);
  const output=ts.createPrinter({removeComments:true}).printFile(result.transformed[0]);result.dispose();return {output,replacements};
 }
 const original=normalize(cp.execFileSync('git',['show',base+':'+file],{cwd:repo,encoding:'utf8'}));
 const current=normalize(fs.readFileSync(repo+'/'+file,'utf8'));
 const pass=original.output===current.output&&original.replacements===current.replacements&&current.replacements===(file.includes('candidate-rules')?2:1);
 results.push({file,pass,replacements:current.replacements,normalizedSha256:crypto.createHash('sha256').update(current.output).digest('hex')});
 if(!pass)process.exitCode=1;
}
fs.writeFileSync('/workspace/backend-qualification-20261012/memory-wording/ast-scope.json',JSON.stringify({base,sourceRef:'539f62e7f2a3f87d9f56f1281e6fff717aed0958',method:'Parse complete files, remove comments, replace only the two shared reason initializers and the pending memory message initializer, compare all remaining syntax.',results},null,2)+'\n');
console.log(JSON.stringify(results));
