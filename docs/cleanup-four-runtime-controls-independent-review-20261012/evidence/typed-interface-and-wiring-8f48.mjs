import assert from 'node:assert/strict';
import { readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inspectRegistryOwnership } from '../../../scripts/check-registry-ownership.mjs';
const config=JSON.parse(readFileSync('scripts/registry-ownership.json','utf8'));const sources=new Map();
function walk(dir){for(const ent of readdirSync(dir,{withFileTypes:true})){const file=dir+'/'+ent.name;if(ent.isDirectory())walk(file);else if(ent.isFile()&&/\.(?:ts|tsx|mts|cts)$/.test(file)&&!/(?:\.(?:spec|test)\.[cm]?tsx?$|\.d\.[cm]?ts$)/.test(file))sources.set(file,readFileSync(file,'utf8'));}}
for(const root of new Set(config.profiles.flatMap(p=>p.roots)))walk(root);
const baseline=inspectRegistryOwnership(sources,config);assert.equal(baseline.errors.length,0);
const file='apps/api/src/external/tango/tango-rest-page.ts';const old=sources.get(file);
const changed=old.replace("export type RateReadProfile = 'interleaved' | 'captured';", "export type RateReadProfile = 'interleaved' | 'captured' | 'unreviewed';");
assert.notEqual(old,changed);const mutant=new Map(sources);mutant.set(file,changed);
const result=inspectRegistryOwnership(mutant,config);
const require=createRequire(import.meta.url);const runner=require('../../../scripts/cleanup-runtime-equivalence.jest.cjs');
assert.equal(runner.testEnvironment,'node');assert.equal(runner.maxWorkers,1);
assert.equal(runner.setupFiles,undefined);assert.equal(runner.setupFilesAfterEnv,undefined);
const transform=runner.transform['^.+\\.ts$'];assert.equal(transform[1].tsconfig.isolatedModules,true);assert.equal(transform[1].diagnostics,false);
const pkg=JSON.parse(readFileSync('package.json','utf8'));const workflow=readFileSync('.github/workflows/ci-pr.yml','utf8');
const expectedAlias='pnpm --filter @capiro/api exec jest --config ../../scripts/cleanup-runtime-equivalence.jest.cjs --runInBand --runTestsByPath src/external/tango/tango-rest-page.spec.ts src/external/tango/tango-sbir.client.spec.ts src/external/tango/tango-subaward.client.spec.ts';
assert.equal(pkg.scripts['gate:cleanup4:tango-page-leaves'],expectedAlias);
assert.equal(pkg.scripts['gate:cleanup4:duplicate-helpers'],'node scripts/check-duplicate-helpers.mjs && node --test scripts/check-duplicate-helpers.test.mjs');
for(const alias of ['registry-ownership','duplicate-helpers','tango-page-leaves']) {
 const command='        run: pnpm gate:cleanup4:'+alias;
 const where=workflow.indexOf(command);assert(where>=0);assert.equal(workflow.indexOf(command,where+1),-1);
 const start=workflow.lastIndexOf('      - name:',where);const step=workflow.slice(start,where);
 assert(!step.includes('if:')); // Same-change controls run on draft PRs too.
}
const receipt={source:'8f48604aa1cefdb3e420026633ce8e1f2ca95953',baselineFiles:sources.size,
  typedInterfaceMutation:{file,before:"'interleaved' | 'captured'",after:"'interleaved' | 'captured' | 'unreviewed'",rejected:result.errors.length>0,errors:result.errors},
  runnerNoDbSetupOrProviderEnvironment:true,cachedTransformerResolved:true,isolatedRuntimeAndSeparateStrictScope:true,
  exactThreeSuitePackageAlias:true,allThreeControlCiStepsRunOnDraft:true,pnpmOrRunnerTestsExecuted:false,mutantCodeExecuted:false};
writeFileSync(new URL('typed-interface-and-wiring-8f48.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
