import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {sourceFiles,checkTimeSources,analyzeTimeSource} from '../../../scripts/check-strategy-time-bypasses.mjs';
const require=createRequire(import.meta.url);const ts=require('typescript');
const base='docs/clock-rng-repaired-independent-review-20261012/evidence';
const fixture=path.resolve(base,'strict-runtime-extension-fixture');
const config=ts.readConfigFile(path.join(fixture,'tsconfig.json'),ts.sys.readFile);assert.equal(config.error,undefined);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,fixture);assert.deepEqual(parsed.errors,[]);
const program=ts.createProgram(parsed.fileNames,parsed.options);const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,' '));
const resolution=ts.resolveModuleName('./hidden.cjs',path.join(fixture,'src/main.ts'),parsed.options,ts.sys).resolvedModule;
assert.deepEqual(diagnostics,[]);assert.equal(resolution.extension,'.cts');
const data={version:1,sourceRoots:['src'],requiredFiles:['src/main.ts'],retryDefinition:'src/main.ts',retryConsumers:[{file:'src/main.ts',calls:1,runtime:'this.retryRuntime'}],existingAmbient:[],systemHookValueOwners:[],canonicalDefinitions:[{name:'withContextRetry',file:'src/main.ts'}]};
const sources=sourceFiles(fixture,data.sourceRoots);const failures=checkTimeSources(sources,data);
assert.equal(sources.size,2);assert(failures.some(x=>x.includes('src/hidden.cts')&&x.includes('Date.now')));
const extensionResults=[];
for(const ext of ['ts','cts','mts','tsx']){
 const dir=path.join(fixture,'extensions-'+ext);mkdirSync(dir,{recursive:true});
 for(const name of ['runtime.'+ext,'ambient.d.'+ext,'x.spec.'+ext,'x.test.'+ext])writeFileSync(path.join(dir,name),ext==='tsx'?'export const element=<span>{Date.now()}</span>;':'export function sample(){return Date.now();}');
 const discovered=sourceFiles(fixture,['extensions-'+ext]);assert.equal(discovered.size,1);
 const [file,code]=[...discovered][0];const analyzed=analyzeTimeSource(file,code,{});assert.deepEqual(analyzed.problems,[]);assert(analyzed.events.some(x=>x.endsWith('|Date.now')));
 extensionResults.push({extension:ext,collected:[...discovered.keys()],ambientEvents:analyzed.events,parseDiagnostics:analyzed.problems});
}
const result={source:'aa1ce11fd480cf664f5b3d1902a61751368d238d',tree:'8f97dc2a55aa837115d43f9d2a38a443ee914afb',compilerVersion:ts.version,strictTypeDiagnostics:diagnostics,resolvedModule:resolution,collected:[...sources.keys()],failures,extensionResults,moduleCodeExecuted:false,mutantsExecuted:false,nativeAcceptance:false};
writeFileSync(base+'/strict-extension-review.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
