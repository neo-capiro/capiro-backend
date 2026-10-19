'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const repository=path.resolve(process.argv[2]),toolsRoot=path.resolve(process.argv[3]);
const files=[
'scripts/qualification/runtime-production-closure.test.cjs',
'apps/api/scripts/qualification/runtime-closure-contract.test.cjs',
'apps/api/scripts/qualification/prisma-musl-target.test.cjs',
'apps/api/scripts/qualification/runtime-closure-integration.test.cjs',
'apps/api/scripts/qualification/platform-metadata.test.cjs',
'apps/api/scripts/qualification/dependency-relations.test.cjs',
'apps/api/scripts/qualification/derived-owner-repair.test.cjs',
'apps/api/scripts/qualification/alpine-runtime-probe.test.cjs',
'apps/api/scripts/qualification/alpine-amd64-qualification.test.cjs',
];
const env={};
for(const name of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','PATHEXT','SystemDrive','ComSpec','COMSPEC','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS']) if(process.env[name]!==undefined)env[name]=process.env[name];
const scratch=path.join(toolsRoot,'test-temp');fs.mkdirSync(scratch,{recursive:true});
Object.assign(env,{TEMP:scratch,TMP:scratch,CACHE_DIR:path.join(toolsRoot,'engine-cache'),CHECKPOINT_DISABLE:'1',PRISMA_HIDE_UPDATE_MESSAGE:'1',PRISMA_SKIP_POSTINSTALL_GENERATE:'1',CAPIRO_QUALIFICATION_PRISMA_CLI:path.join(toolsRoot,'node_modules/prisma/build/index.js')});
const result=cp.spawnSync(process.execPath,['--test',...files],{cwd:repository,env,encoding:'utf8',timeout:60000,maxBuffer:10*1024*1024});
function redact(text){for(const [original,label] of [[repository,'<source>'],[toolsRoot,'<tools>'],[__dirname,'<evidence>']]) for(const value of [original,original.replaceAll('\\','/'),original.replaceAll('\\','\\\\')])text=text.split(value).join(label);return text;}
const log=redact((result.stdout||'')+(result.stderr||''));
fs.writeFileSync(path.join(__dirname,'focused-tests.tap'),log);
const summary={command:'node --test '+files.join(' '),nodeVersion:process.version,environment:{sanitized:true,CAPIRO_QUALIFICATION_ARCH:'unset',CAPIRO_QUALIFICATION_PRISMA_CLI:'<tools>/node_modules/prisma/build/index.js',CACHE_DIR:'<tools>/engine-cache',TEMP:'<tools>/test-temp',CHECKPOINT_DISABLE:'1',PRISMA_HIDE_UPDATE_MESSAGE:'1'},exitCode:result.status,signal:result.signal,error:result.error?.message||null,total:Number(/^# tests (\d+)/m.exec(log)?.[1]||0),passed:Number(/^# pass (\d+)/m.exec(log)?.[1]||0),failed:Number(/^# fail (\d+)/m.exec(log)?.[1]||0),skipped:Number(/^# skipped (\d+)/m.exec(log)?.[1]||0),log:'focused-tests.tap',scope:'Source qualification helpers, schema formatter and synthetic native-owner fixtures; not real image/native ABI qualification.'};
fs.writeFileSync(path.join(__dirname,'focused-tests.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
if(result.status!==0){console.log(log.split('\n').filter((line,index,all)=>line.startsWith('not ok ')||line.includes('error:')||line.includes('failureType:')).join('\n'));process.exitCode=1;}
