/** Explicit test-only source emitter. No production import, key or HTTP access.
 * Creates a NEW caller-owned output directory; never overwrites or removes one.
 */
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../../..'),api=path.join(root,'apps/api');
const ts=require(require.resolve('typescript',{paths:[api]}));
const sha=value=>createHash('sha256').update(value).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});
const output=process.argv[2];
if(!output||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Supply a new absolute qualification output directory');
if(output===root||!fs.existsSync(path.dirname(output)))throw Error('Output parent must exist outside the source root');
const sourceFiles=['objective-reader-v2-contract','objective-reader-v2-jwt','objective-reader-v2-client'];
const baseline=[
 ['apps/api-strategy/src/meri/objective-canonical-generation.ts','objective-canonical-generation',[["../planner/objective-canonical-application.js","./objective-canonical-application.js"]]],
 ['apps/api-strategy/src/planner/objective-canonical-application.ts','objective-canonical-application',[["@capiro/shared/objective-planner-owner-codec","./objective-planner-owner-codec.js"]]],
 ['packages/shared/src/objective-planner-owner-codec.ts','objective-planner-owner-codec',[]],
 ['packages/shared/src/objective-planner-materialization.ts','objective-planner-materialization',[]],
 ['packages/shared/src/objective-planner-application.ts','objective-planner-application',[]],
];
const entries=sourceFiles.map(name=>[path.join('apps/api/src/auth/workload-authority',name+'.ts'),name,[],true]).concat(baseline);
const prepared=entries.map(([relative,name,rewrites,current])=>{
 const original=current?fs.readFileSync(path.join(root,relative),'utf8'):git('show','HEAD:'+relative);
 let text=original;for(const [from,to] of rewrites){if(!text.includes(from))throw Error('Absent declared rewrite');text=text.split(from).join(to);}
 const emitted=ts.transpileModule(text,{fileName:relative,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,sourceMap:false}}).outputText;
 return {relative,name,rewrites,sourceSha256:sha(original),rewrittenSha256:sha(text),emittedSha256:sha(emitted),emitted};
});
fs.mkdirSync(output);
for(const item of prepared)fs.writeFileSync(path.join(output,item.name+'.js'),item.emitted);
fs.writeFileSync(path.join(output,'package.json'),'{"type":"commonjs","private":true}\n');
fs.mkdirSync(path.join(output,'node_modules'));
const zod=path.dirname(require.resolve('zod/package.json',{paths:[api]}));
fs.symlinkSync(zod,path.join(output,'node_modules/zod'),'junction');
const manifest={sourceHead:git('rev-parse','HEAD').trim(),typescriptVersion:ts.version,format:'CommonJS',target:'ES2022',
 canonicalParsers:{module:'objective-canonical-generation.js',admission:'parseCanonicalGenerationAdmission',binding:'parseAcceptedRunBinding'},
 contractOrigin:'meri-greenfield@b2f0a5d71e1c1b6a6cf79b1e9a496ad663ef641a',schemaSha256:'d461baaaf2300aa7ffd363bc4b58295d22c437360c126884e96433e10ac16ec1',
 files:prepared.map(({emitted,...metadata})=>metadata),dependencies:{zod:JSON.parse(fs.readFileSync(path.join(zod,'package.json'),'utf8')).version}};
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({output,manifestSha256:sha(JSON.stringify(manifest,null,2)+'\n'),files:prepared.length,sourceHead:manifest.sourceHead}));
