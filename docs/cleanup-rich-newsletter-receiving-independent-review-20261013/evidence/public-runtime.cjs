const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('/workspace/capirov2/apps/api/node_modules/typescript');
const sources=JSON.parse(fs.readFileSync(path.join(__dirname,'FROZEN8F-BINDINGS.json'))).sources;
const cache=new Map();
function text(name){const row=sources.find(row=>row.path===name);if(!row)throw new Error('Unbound source '+name);return fs.readFileSync(path.join(__dirname,row.rawFile),'utf8');}
function load(name){if(cache.has(name))return cache.get(name).exports;
 if(!name.startsWith('packages/shared/src/'))throw new Error('Private/runtime module refused '+name);
 const module={exports:{}};cache.set(name,module);
 const compiled=ts.transpileModule(text(name),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 vm.runInThisContext('(function(exports,module,require){'+compiled+'\n})')(module.exports,module,spec=>{
 if(!spec.startsWith('./'))throw new Error('External runtime import refused '+spec);
 return load(path.posix.normalize(path.posix.join(path.posix.dirname(name),spec.replace(/\.js$/,'.ts'))));});return module.exports;}
function declarations(raw,names){const file=ts.createSourceFile('selected.ts',raw,ts.ScriptTarget.Latest,true);return names.map(name=>{
 const matches=file.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);if(matches.length!==1)throw new Error('Unique source function required '+name);return matches[0].getText(file);}).join('\n');}
function functions(raw,names,injected){const module={exports:{}};const emitted=ts.transpileModule(declarations(raw,names),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInThisContext('(function(exports,module,'+Object.keys(injected).join(',')+'){'+emitted+'\n;'+names.map(name=>'module.exports.'+name+'='+name+';').join('')+'})')(module.exports,module,...Object.values(injected));return module.exports;}
module.exports={api:load('packages/shared/src/newsletter.ts'),load,text,functions,ts};
