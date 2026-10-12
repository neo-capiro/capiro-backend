const fs=require('fs'),path=require('path');
const {getConfig,getDMMF,Generator}=require('/tmp/capiro-prisma-tools/node_modules/@prisma/internals');
(async()=>{
 const schemaPath='/workspace/capirov2-prospect-resources/apps/workspace/prisma/schema.prisma';
 const datamodel=fs.readFileSync(schemaPath,'utf8');
 const config=await getConfig({datamodel,ignoreEnvVarErrors:true});
 const dmmf=await getDMMF({datamodel,previewFeatures:config.generators[0].previewFeatures});
 const client=fs.realpathSync('/workspace/capirov2-prospect-resources/apps/api/node_modules/@prisma/client');
 const generatorConfig=config.generators[0];
 generatorConfig.output={value:'/workspace/capirov2-prospect-resources/apps/workspace/generated/prisma-client',fromEnvVar:null};
 generatorConfig.isCustomOutput=true;
 const generator=new Generator(path.join(client,'generator-build/index.js'),generatorConfig,true);
 try {
  await generator.init();
  generator.setOptions({datamodel,datasources:config.datasources,generator:generatorConfig,dmmf,otherGenerators:[],schemaPath,version:'605197351a3c8bdd595af2d2a9bc3025bca48ea2',noEngine:true,binaryPaths:{libqueryEngine:{}},envPaths:{rootEnvPath:null,schemaEnvPath:undefined}});
  await generator.generate();
  if(!fs.existsSync(path.join(generatorConfig.output.value,'index.d.ts'))) throw Error('Generated client missing');
  console.log('PASS: Prisma 5.22.0 official WASM DMMF + client generator, noEngine:true; no native engine or database used. Output: '+generatorConfig.output.value);
 }finally {generator.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
