// Cached official WASM + generator only, sanitized environment/local outputs; never client/native/DB/CLI execution.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../../..');
assert.deepEqual(Object.keys(process.env).sort(),['PATH','XDG_CACHE_HOME']);
assert.equal(process.env.XDG_CACHE_HOME,path.join(root,'.enginefree/tool-cache'));
const internals='/tmp/capiro-prisma-objective-tools/node_modules/@prisma/internals';
const client='/workspace/capirov2/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client';
const generatorPath=path.join(client,'generator-build/index.js');const generatorSource=fs.readFileSync(generatorPath,'utf8');
assert(generatorSource.includes('copyEngine: !options.noEngine'));assert(generatorSource.includes('if (copyEngine) {'));assert(generatorSource.includes('env2.XDG_CACHE_HOME'));
assert.equal(require(internals+'/package.json').version,'5.22.0');assert.equal(require(client+'/package.json').version,'5.22.0');
const {getConfig,getDMMF,Generator}=require(internals);const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const output=[];
(async()=>{for(const [scope,relative,target]of [['core','apps/api/prisma/schema.prisma','.enginefree/core-client'],['workspace','apps/workspace/prisma/schema.prisma','apps/workspace/generated/prisma-client']]){
 const schemaPath=path.join(root,relative),datamodel=fs.readFileSync(schemaPath,'utf8'),destination=path.join(root,target);
 fs.mkdirSync(destination,{recursive:true});assert.equal(fs.realpathSync(destination),destination);
 const config=await getConfig({datamodel,ignoreEnvVarErrors:true});
 for(const ds of config.datasources)assert(!ds.url?.value,'Refusing an environment-resolved datasource URL');
 const gc=config.generators[0];const dmmf=await getDMMF({datamodel,previewFeatures:gc.previewFeatures});
 gc.output={value:destination,fromEnvVar:null};gc.isCustomOutput=true;
 const generator=new Generator(generatorPath,gc,true);
 try{await generator.init();generator.setOptions({datamodel,datasources:config.datasources,generator:gc,dmmf,otherGenerators:[],schemaPath,version:'605197351a3c8bdd595af2d2a9bc3025bca48ea2',noEngine:true,binaryPaths:{libqueryEngine:{}},envPaths:{rootEnvPath:null,schemaEnvPath:undefined}});await generator.generate();}finally{generator.stop();}
 function files(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(d,e.name)):[path.join(d,e.name)]);}
 const emitted=files(destination).map(p=>({path:path.relative(root,p),bytes:fs.statSync(p).size,sha256:sha(fs.readFileSync(p))}));assert(emitted.some(p=>p.path.endsWith('/index.d.ts')));assert(!emitted.some(p=>/libquery_engine|query-engine|\.node$|\.wasm$/.test(p.path)),'Unexpected native/engine output');
 output.push({scope,schema:relative,schemaSha256:sha(datamodel),modelCount:dmmf.datamodel.models.length,output:target,options:{noEngine:true,binaryPaths:{libqueryEngine:{}},isCustomOutput:true,envPaths:{rootEnvPath:null,schemaEnvPath:null}},emitted});
 }fs.writeFileSync(path.join(__dirname,'enginefree-generation-receipt.json'),JSON.stringify({result:'PASS official cached WASM schema/DMMF and isolated engine-free declaration/JS generation',cachedInternalsVersion:'5.22.0',cachedClientVersion:'5.22.0',generatorPath,generatorSha256:sha(generatorSource),sanitizedEnvironmentKeys:['PATH','XDG_CACHE_HOME'],isolatedCache:path.relative(root,process.env.XDG_CACHE_HOME),output,noNativeDownloadCopyInvoke:true,noInstall:true,noPrismaClientInstantiation:true,noDatabaseOrSQL:true,qualification:'SOURCE only; not native PostgreSQL/RLS/build/deployment acceptance'},null,2)+'\n');console.log('PASS cached official schema/WASM and engine-free clients; isolated outputs and cache, no native/SQL/client execution.');
})().catch(error=>{console.error(error);process.exitCode=1;});
