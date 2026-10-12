const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=process.cwd(),ev=path.join(root,'docs/cleanup-core-canonical-typechain-probe-20261012/evidence');
const ts=require('/workspace/capirov2/node_modules/typescript');
const entry='apps/api/scripts/verify-pe-phase-a-safety.ts';const seen=new Set(),runtime=[],typeOnly=[];
function visit(file){
 if(seen.has(file))return;seen.add(file);
 const source=fs.readFileSync(path.join(root,file),'utf8');const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 for(const node of ast.statements){
  if(!ts.isImportDeclaration(node))continue;
  const spec=node.moduleSpecifier.text;const item={owner:file,specifier:spec};
  if(node.importClause?.isTypeOnly){typeOnly.push(item);continue;}
  runtime.push(item);
  if(spec.startsWith('.'))visit(path.posix.normalize(path.posix.join(path.posix.dirname(file),spec)).replace(/\.js$/,'.ts'));
  else if(!spec.startsWith('node:'))throw new Error('unreviewed runtime import '+spec);
 }
}
visit(entry);
const identities=[...seen].map(file=>{const b=fs.readFileSync(path.join(root,file));return{path:file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),gitBlob:cp.execFileSync('git',['rev-parse','HEAD:'+file],{encoding:'utf8'}).trim()}});
const prereq='/tmp/capirov2-cleanup-meri-reviewed-runtime-conversion';const prereqHead=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:prereq,encoding:'utf8'}).trim();
const sourceDelta=cp.execFileSync('git',['diff','--name-only','681309d208f2c1c344892f8f446a7fa0b4db0a31',prereqHead,'--','packages/shared','packages/auth','packages/meriv2-core'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean);
const schema=fs.readFileSync(path.join(root,'apps/api/prisma/schema.prisma'),'utf8'),generated=fs.readFileSync('/tmp/capirov2-local-native-prerequisite-20261012/core-client/schema.prisma','utf8');
const sansGenerator=s=>s.replace(/generator client\s*\{[\s\S]*?\}/,'');
const r={runtimeClosureSize:seen.size,runtimeImports:runtime,typeOnlyImportsNotLoaded:typeOnly,identities,manualEffectAudit:'Seven source modules fully read: entry performs five sets of assertions, reads five repository files as UTF8 source and logs success; closure is constants/declarations/pure helpers plus Node hash/path. No app imports/bootstrap/client construction/provider/network/DB/SQL/native generation. Ingestion/audit/entrypoints are read-as-text, not evaluated.',prerequisiteSource:{root:prereq,head:prereqHead,currentPackageSourceDelta:sourceDelta},generatedSchema:{exactEqual:schema===generated,excludingClientGeneratorEqual:sansGenerator(schema)===sansGenerator(generated),generatedClientLoaded:false},scope:'Bounded inspected entry+runtime import closure, not arbitrary-script or native/runtime acceptance'};
if(sourceDelta.length)throw new Error('prebuilt source differs');
if(!r.generatedSchema.excludingClientGeneratorEqual)throw new Error('generated model schema mismatch');
fs.writeFileSync(path.join(ev,'safety-and-prerequisite-audit.json'),JSON.stringify(r,null,2)+'\n');
console.log(JSON.stringify({runtimeClosureSize:seen.size,typeOnlyImports:typeOnly.length,prebuiltSourceDelta:sourceDelta,generatedSchema:r.generatedSchema}));
