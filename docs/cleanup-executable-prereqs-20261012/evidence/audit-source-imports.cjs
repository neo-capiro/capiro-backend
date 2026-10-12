const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),ts=require(path.join(root,'node_modules/typescript'));
const base='f1e83a3f194a8ebd972e370ff6e5b5f559888b29';
const files=cp.execFileSync('git',['diff','--name-only',base,'HEAD'],{cwd:root,encoding:'utf8'}).trim().split('\n');
const imports=[],syntax=[];
for(const rel of files){
 if(!/\.(?:[cm]?js|tsx?)$/.test(rel))continue;
 const abs=path.join(root,rel);if(!fs.existsSync(abs))continue;
 const parsed=ts.createSourceFile(rel,fs.readFileSync(abs,'utf8'),ts.ScriptTarget.Latest,true);
 syntax.push({path:rel,diagnostics:parsed.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' '))});
 function visit(n){let spec=null;
  if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n))spec=n.moduleSpecifier;
  if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword || ts.isIdentifier(n.expression)&&n.expression.text==='require'))spec=n.arguments[0];
  if(spec&&ts.isStringLiteralLike(spec)&&spec.text.startsWith('.')){
   const target=path.resolve(path.dirname(abs),spec.text);const candidates=[target,...['.ts','.tsx','.js','.cjs','.mjs','.json'].map(ext=>target+ext),...['index.ts','index.tsx','index.js','index.mjs'].map(f=>path.join(target,f))];
   if(/\.js$/.test(target))candidates.push(target.slice(0,-3)+'.ts',target.slice(0,-3)+'.tsx');
   const resolved=candidates.find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
   imports.push({path:rel,import:spec.text,resolved:resolved?path.relative(root,resolved):null});
  }
  ts.forEachChild(n,visit);
 }visit(parsed);
}
const missing=imports.filter(v=>!v.resolved);console.log(JSON.stringify({source:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),base,syntax,imports,missing,mode:'TypeScript AST read only; generated build/client operands remain native prerequisites'},null,2));
if(syntax.some(v=>v.diagnostics.length))process.exitCode=1;
