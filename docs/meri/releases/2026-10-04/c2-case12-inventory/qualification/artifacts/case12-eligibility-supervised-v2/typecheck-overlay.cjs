const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const repo='C:/dev/main/meri-c1-20261002', api=createRequire(repo+'/apps/api/package.json');
const ts=api('typescript');
process.chdir(repo+'/apps/api');
const relative=[
 'apps/api/src/retrieval/adapters/governed-memory-eligibility.helpers.ts',
 'apps/api/src/retrieval/adapters/governed-memory-eligibility.helpers.spec.ts',
 'apps/api/src/retrieval/adapters/case12-memory-eligibility.read.ts',
 'apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts',
];
const norm=p=>path.resolve(p).replaceAll('\\','/').toLowerCase();
const overlay=new Map(relative.map(rel=>[norm(repo+'/'+rel),fs.readFileSync(__dirname+'/scratch/'+rel,'utf8')]));
const configPath=repo+'/apps/api/tsconfig.json';
const config=ts.readConfigFile(configPath,ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configPath));
parsed.options.noEmit=true;parsed.options.incremental=false;
const host=ts.createCompilerHost(parsed.options), originalRead=host.readFile.bind(host),originalExists=host.fileExists.bind(host),originalGet=host.getSourceFile.bind(host);
host.readFile=p=>overlay.get(norm(p))??originalRead(p);
host.fileExists=p=>overlay.has(norm(p))||originalExists(p);
host.getSourceFile=(p,languageVersion,onError,shouldCreateNewSourceFile)=>overlay.has(norm(p))
 ?ts.createSourceFile(p,overlay.get(norm(p)),languageVersion,true)
 :originalGet(p,languageVersion,onError,shouldCreateNewSourceFile);
const program=ts.createProgram([...new Set([...parsed.fileNames,...relative.map(r=>repo+'/'+r)])],parsed.options,host);
const diagnostics=[...(config.error?[config.error]:[]),...parsed.errors,...ts.getPreEmitDiagnostics(program)];
const info={kind:'full-api-typescript-check-with-readonly-four-file-source-overlay',repositoryWrites:0,sourceOverrides:relative.map(rel=>({path:rel,sha256:crypto.createHash('sha256').update(fs.readFileSync(__dirname+'/scratch/'+rel)).digest('hex')})),diagnosticCount:diagnostics.length,filesChecked:program.getSourceFiles().length,
 diagnostics:diagnostics.map(d=>({code:d.code,path:d.file?.fileName,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:undefined,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))};
fs.writeFileSync(__dirname+'/typecheck-overlay-result.json',JSON.stringify(info,null,2)+'\n');
console.log(JSON.stringify(info,null,2));process.exitCode=diagnostics.length?1:0;
