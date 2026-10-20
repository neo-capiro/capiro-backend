const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const crypto=require('node:crypto');const ts=require('typescript');
const root=path.resolve(__dirname,'../..');const configPath=path.join(root,'apps/api/tsconfig.build.json');
const raw=ts.readConfigFile(configPath,ts.sys.readFile);if(raw.error)throw new Error('Canonical API config read failed');
const config=ts.parseJsonConfigFileContent(raw.config,ts.sys,path.dirname(configPath));if(config.errors.length)throw new Error('Canonical API config parsing failed');
const files=['alert-memo.service.ts','district-brief.service.ts','memo-sections.ts'];const artifacts=[];const classProof=[];
const out=path.join(root,'.qualification-cache/memo-emit');fs.mkdirSync(out,{recursive:true});
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
for(const name of files){
 const relative='apps/api/src/intelligence/alert-memo/'+name;const source=fs.readFileSync(path.join(root,relative),'utf8');
 const emit=ts.transpileModule(source,{compilerOptions:config.options,fileName:path.join(root,relative),reportDiagnostics:true});
 const errors=(emit.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);if(errors.length)throw new Error('Canonical-option transpilation failed: '+name);
 const js=path.join(out,name.replace(/\.ts$/,'.js'));fs.writeFileSync(js,emit.outputText);
 const check=cp.spawnSync(process.execPath,['--check',js],{encoding:'utf8',env:process.env});if(check.status!==0)throw new Error('Emitted syntax failed: '+name);
 artifacts.push({source:relative,source_sha256:sha(source),emitted_bytes:Buffer.byteLength(emit.outputText),emitted_sha256:sha(emit.outputText)});
 if(name!=='memo-sections.ts'){
  const old=cp.execFileSync('git',['show','b417a2610f5224c2a3e85c6a1ebba1a8102233c1:'+relative],{cwd:root}).toString();
  const extract=text=>ts.createSourceFile(relative,text,ts.ScriptTarget.Latest,true).statements.filter(ts.isClassDeclaration).map(c=>c.getText()).join('\n');
  if(extract(old)!==extract(source))throw new Error('Existing caller class changed');
  classProof.push({path:relative,class_sha256:sha(extract(source)),original_class_byte_exact:true});
 }
}
fs.writeFileSync(path.join(__dirname,'evidence/memo-emitted-artifacts.json'),JSON.stringify({source_head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),compiler:ts.version,canonical_config:'apps/api/tsconfig.build.json',canonical_options_sha256:sha(JSON.stringify(config.options)),syntax_checks:3,artifacts,classProof,transpile_only:true,full_api_type_nest_build_or_bootstrap_qualified:false},null,2)+'\n');
console.log(JSON.stringify({syntax_checks:3,classes_byte_exact:2,result:'PASS'}));
