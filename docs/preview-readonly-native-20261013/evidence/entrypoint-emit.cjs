'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const cp=require('node:child_process');
const root=path.resolve(__dirname,'../../..');const ts=require('/workspace/capirov2/node_modules/typescript');
const build=path.join(root,'apps/api/tsconfig.build.json');
const read=ts.readConfigFile(build,ts.sys.readFile);if(read.error)throw Error('Production config unreadable');
const parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,path.dirname(build));
const entry=path.join(root,'apps/api/src/preview-readonly/preview-main.ts');
const program=ts.createProgram([entry],{...parsed.options,incremental:false});
const diagnostics=ts.getPreEmitDiagnostics(program);if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));process.exitCode=1;return;}
const emitted=[];const result=program.emit(undefined,(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);emitted.push(file);});
if(result.emitSkipped)throw Error('Emit skipped');
const actual=path.join(root,'apps/api/dist/preview-readonly/preview-main.js');if(!emitted.includes(actual)||!fs.existsSync(actual))throw Error('Actual entrypoint path absent');
const wrong=path.join(root,'apps/api/dist/src/preview-readonly/preview-main.js');if(fs.existsSync(wrong))throw Error('Wrong extra-src path exists');
const source=cp.execFileSync('git',['show','111f269d749cae0249c2141779bd6d7deb93f45c:apps/api/src/preview-readonly/preview-main.ts']);if(!source.equals(fs.readFileSync(entry)))throw Error('Source mismatch');
fs.writeFileSync(path.join(__dirname,'entrypoint-emit-results.json'),JSON.stringify({source_head:'111f269d749cae0249c2141779bd6d7deb93f45c',compiler_config:'apps/api/tsconfig.build.json',root_selection:'only exact preview-main.ts and resolved canonical dependencies',production_compiler_options_preserved:true,rootDir:parsed.options.rootDir,outDir:parsed.options.outDir,diagnostics:0,emitted_files:emitted.length,relative_emitted_entrypoint:path.relative(root,actual),image_entrypoint:'/app/apps/api/dist/preview-readonly/preview-main.js',extra_src_path_absent:true,emitted_sha256:crypto.createHash('sha256').update(fs.readFileSync(actual)).digest('hex'),whole_api_build_or_image_qualified:false},null,2)+'\n');
console.log(JSON.stringify({emitted_entrypoint:path.relative(root,actual),diagnostics:0,emitted_files:emitted.length}));
