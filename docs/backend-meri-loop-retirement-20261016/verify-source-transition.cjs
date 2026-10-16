// One-time exact transition evidence; never an evergreen application gate.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
assert.deepEqual(process.argv.slice(2), ['--run'], 'Use exactly --run');
const root = path.resolve(__dirname, '../..');
const parent = 'f3ede4fe8d88ba686a81c59f71e44319c0f45fd1';
const git = (...args) => execFileSync('git', args, { cwd: root, timeout: 15000, maxBuffer: 2*1024*1024, stdio: ['ignore','pipe','pipe'] });
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const old = file => git('show', parent + ':' + file).toString();
const json = file => JSON.parse(read(file));
const packet = 'docs/backend-meri-loop-retirement-20261016/';
const raw = json(packet + 'evidence/meri-loop-raw-service-implementation.json');
const runtime = json(packet + 'evidence/meri-loop-current-runtime-implementation.json');
const servicePath = 'apps/api/src/meri/meri.service.ts';
const original = old(servicePath), originalLines = original.split('\n');
const removedLines = new Set();
for (const row of raw.removedRegions) {
  const block = originalLines.slice(row.originalFirstLine-1, row.originalLastLine).join('\n') + '\n';
  assert.equal(sha(block), row.sha256, row.name + ' exact source bytes');
  for (let n=row.originalFirstLine; n<=row.originalLastLine; n++) removedLines.add(n);
}
let expected = originalLines.filter((_line,index) => !removedLines.has(index+1)).join('\n');
for (const row of raw.removedImports) {
  assert.equal(expected.split(row.before).length, 2, 'One original import: ' + row.specifier);
  expected = expected.replace(row.before, row.after);
}
assert.equal(expected.split(raw.removedV2Constructor.exactParameter).length, 2);
expected = expected.replace(raw.removedV2Constructor.exactParameter, '');
const breaker = expected.match(/^  \/\/ P2-2:[\s\S]*?^  private readonly toolBreaker[^\n]*\n/m)?.[0];
assert(breaker); assert.equal(sha(breaker), raw.removedToolBreaker.sha256);
expected = expected.replace(breaker, '');
assert.equal(read(servicePath), expected, 'Every other service byte/method must be unchanged');
assert.doesNotMatch(expected, /\b(?:streamMessage|streamMessageViaMeriV2|meriV2Chat|toolBreaker)\b/);
for (const row of raw.applicationFiles) {
  assert.equal(sha(old(row.path)), row.beforeSha256);
  assert.equal(sha(read(row.path)), row.afterSha256);
}
let constructorSites = 0;
for (const file of raw.fixtureSites) {
  const before = old(file.path);
  const calls = [...before.matchAll(/new MeriService\(\n([\s\S]*?)\n\s*\);/g)];
  assert.equal(calls.length, file.constructors.length);
  let next = before;
  for (let index=calls.length-1; index>=0; index--) {
    const call=calls[index], row=file.constructors[index], lines=call[1].split('\n');
    assert.equal(lines[10], row.removedExactArgument, 'Only old V2 dummy slot10 removed');
    lines.splice(10,1);
    next=next.slice(0,call.index)+call[0].replace(call[1],lines.join('\n'))+next.slice(call.index+call[0].length);
    constructorSites++;
  }
  assert.equal(read(file.path),next,'No fixture assertion/collaborator change: '+file.path);
}
assert.equal(constructorSites,5);
const modulePath='apps/api/src/meri/meri.module.ts';
assert.equal(read(modulePath),old(modulePath)
  .replace("import { MeriV2ChatClient } from './meriv2-chat.client.js';\n",'')
  .replace('    MeriV2ChatClient,\n',''));
for(const row of runtime.files) assert.equal(sha(fs.readFileSync(path.join(root,row.path))),row.sha256,'Exact working-byte current runtime input drift: '+row.path);
const proxyPath='apps/api/src/meri/meriv3-runtime.proxy.ts';
const proxy=read(proxyPath), oldProxy=old(proxyPath);
const helperSuffix=source=>source.slice(source.indexOf('function installV3Phase19Adapters('));
assert.equal(helperSuffix(proxy),helperSuffix(oldProxy),'All current V3 adapters/reconciliation unchanged');
const oldRouting=oldProxy.slice(oldProxy.indexOf('  return new Proxy(raw,'),oldProxy.indexOf('\nfunction installRawPhase19Adapters'));
const newRouting=proxy.slice(proxy.indexOf('  return new Proxy(raw,'),proxy.indexOf('\nfunction installV3Phase19Adapters'))
  .replaceAll('MeriStreamArgs',"Parameters<MeriService['streamMessage']>")
  .replace("Parameters<MeriRuntimeService['getArtifactImage']>","Parameters<MeriService['getArtifactImage']>")
  .replace('  }) as MeriRuntimeService;','  });');
assert.equal(newRouting,oldRouting,'Current route/gate/progress bodies unchanged after type-only inverse');
const clientPath='apps/api/src/meri/meriv3-chat.client.ts';
assert.equal(read(clientPath),old(clientPath).replace("from './meriv2-chat.client.js'","from './meri-chat-ai.types.js'"));
const iface=source=>source.match(/export interface ResolvedAiForChatHeader \{[\s\S]*?\n\}/)?.[0];
assert.equal(iface(read('apps/api/src/meri/meri-chat-ai.types.ts')),iface(old('apps/api/src/meri/meriv2-chat.client.ts')));
const controllerPath='apps/api/src/meri/meri.controller.ts';
const noComments=source=>source.replace(/^\s*\/\/[^\n]*\n/gm,'');
const restoredController=read(controllerPath).replace('  Inject,\n','')
  .replace("import type { MeriRuntimeService } from './meri-runtime.contract.js';\n",'')
  .replace('@Inject(MeriService) private readonly service: MeriRuntimeService,','private readonly service: MeriService,');
assert.equal(noComments(restoredController),noComments(old(controllerPath)),'Controller routes/auth/header extraction unchanged');
const lifecyclePath='apps/api/src/meri/meri-turn-lifecycle.phase4.spec.ts';
const oldLifecycle=old(lifecyclePath);
// Lines63-100 own the complete describe; separator101 belongs between suites.
const archiveBody=oldLifecycle.split('\n').slice(62,100).join('\n')+'\n';
assert.equal(sha(archiveBody),'07ae19acb94399f7c2bf847429a0f604e0c08010e1d2b99e769eda5c3e371bd4');
assert.equal(read(lifecyclePath),oldLifecycle.slice(0,oldLifecycle.indexOf('function harness()'))+
  archiveBody,'All three archive bodies unchanged');
const retired=['meriv2-chat.client.ts','meriv2-chat.client.spec.ts','meriv2-routing.helpers.ts',
  'meriv2-routing.helpers.spec.ts','meriv2-routing.matrix.spec.ts','meri-research-portfolio-tool-scope.ts','ResearchPortfolioMeriTurnBinding.spec.ts'];
const sourceInputs=json('tests/support/legacy-meri/SOURCE-INPUTS.json');
for(const file of retired){
  const filePath='apps/api/src/meri/'+file;
  assert(!fs.existsSync(path.join(root,filePath)),'Retired path still present');
  const row=sourceInputs.requiredFiles.find(row=>row.path===filePath); assert(row,'Missing replay operand');
  const bytes=git('show',parent+':'+filePath); assert.equal(sha(bytes),row.sha256);
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),row.gitBlobSha1);
}
const consumerArgv=['-c','grep.threads=1','grep','-n','-E',
  "from ['\"][^'\"]*(meriv2-chat.client|meriv2-routing.helpers|meri-research-portfolio-tool-scope)|MeriService\\[.streamMessage|installRawPhase19Adapters\\(",
  'HEAD','--','apps','packages','scripts','infra','tests',':!tests/support/legacy-meri',':!scripts/ci/meri-loop-current-runtime.contract.spec.mjs'];
const scoped=spawnSync('git',consumerArgv,
  {cwd:root,timeout:15000,encoding:'utf8',maxBuffer:512*1024,windowsHide:true});
assert.equal(scoped.status,1,'No current import or callable adapter consumer; exit1 means no matches');
assert.equal(scoped.stdout,''); assert.equal(scoped.stderr,'');
const checkpoint=git('rev-parse','HEAD').toString().trim();
const applicationPaths=git('diff','--no-renames','--name-only',parent,checkpoint,'--','apps','packages')
  .toString().trim().split('\n').filter(Boolean).sort();
const expectedApplications=[...raw.applicationFiles.map(row=>row.path),...runtime.files.filter(row=>row.path.startsWith('apps/')).map(row=>row.path),
  lifecyclePath,...retired.map(file=>'apps/api/src/meri/'+file),
  'apps/meriv2-orchestrator/src/meri/research-portfolio-current-turn-dispatch.spec.ts'].sort();
assert.deepEqual(applicationPaths,expectedApplications,'No unallocated application path');
const protectedPaths=['apps/api/prisma','packages','apps/defense-api','apps/intel-api','apps/api-strategy',
  'apps/onboard-api','apps/onboard-web','apps/e2e','apps/api/src/auth','apps/api/src/tenant','apps/api/src/memory',
  'apps/api/src/research-portfolios','apps/api/src/business-development','apps/api/src/clients/objectives',
  'apps/api/src/engagement','apps/api/src/app.module.ts','apps/api/src/meri/meri-tools.service.ts',
  'apps/api/src/meri/meri-federal-legislation-tools.ts','apps/api/src/meri/meri-tool-input.helpers.ts',
  'apps/api/src/meri/meri-rp-tool-transport.ts','apps/api/src/meri/governed-meri-tools.proxy.ts',
  'apps/api/src/meri/meri-research.service.ts','apps/api/src/meri/meriv3-proxy.service.ts',
  'apps/api/src/meri/meriv3-chat.client.spec.ts','apps/api/src/meri/meriv3-proxy.service.spec.ts',
  'apps/meriv2-orchestrator/src/meri/api-tool-executor.repo.ts','apps/meriv2-orchestrator/src/meri/current-turn-tool-scope.ts',
  'apps/meriv2-orchestrator/src/meri/rp-tool-transport.ts','apps/meriv2-orchestrator/src/request',
  'apps/meriv2-orchestrator/src/meri/meriv3/meriv3.controller.ts',
  'package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.github',
  'docs/backend-cleanup-20261016','docs/backend-cleanup-frontend-20261016','docs/backend-runtime-cleanup-20261016','docs/backend-meri-domain-cleanup-20261016'];
const protectedIdentities=protectedPaths.map(file=>{
  const before=git('ls-tree',parent,'--',file).toString().trim();
  assert.equal(git('ls-tree',checkpoint,'--',file).toString().trim(),before,'Protected source drift: '+file);
  return{path:file,entry:before||'absent at both pins'};
});
assert.equal(git('rev-parse','cleanup/backend-meri-domain-20261016').toString().trim(),parent);
const counted=json(packet+'CODE-COUNTS.json');
assert.equal(counted.parent,parent);
assert.equal(git('diff',counted.sourceHead,checkpoint,'--','apps','packages','scripts','tests','infra','evals','docker').length,0,
  'Counted source changed after checkpoint');
const tested=json(packet+'TESTED-INPUTS.json').inputs.map(row=>{
  assert.equal(sha(fs.readFileSync(path.join(root,row.path))),row.workingBytesSHA256,'Tested input drift: '+row.path);
  return row;
});
const capturedGitBytes=git('ls-tree','-r',checkpoint,'--',packet+'evidence').toString().trim().split('\n').filter(Boolean).map(line=>{
  const entry=/^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(line); assert(entry,'Regular evidence blob required');
  const bytes=fs.readFileSync(path.join(root,entry[2]));
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),entry[1],
    'Captured raw working bytes differ from Git: '+entry[2]);
  return{path:entry[2],gitBlob:entry[1],bytes:bytes.length,sha256:sha(bytes)};
});
const report={parent,sourceCheckpoint:checkpoint,rawOwnedRegions:raw.removedRegions,removedRawPhysicalLines:2287,
  rawServiceOtherBytesUnchanged:true,constructorSites,otherConstructorAndNativeFixtureBytesUnchanged:true,
  currentV3AdaptersAndRoutingUnchanged:true,controllerBehaviorUnchanged:true,headerShapeUnchanged:true,
  currentArchiveCasesPreserved:3,currentRpMappedIdentities:22,retiredPaths:retired,
  consumerPass:{argv:consumerArgv,exit:scoped.status,meaning:'no matches',stdout:scoped.stdout,stderr:scoped.stderr},
  applicationPaths,protectedIdentities,testedInputIdentities:tested,capturedGitBytes,countedSourceHead:counted.sourceHead,sealedPR34RefUnchanged:true,
  scope:'One-time source transition only; not native DI/typing/auth/admission/grant/provider/DB/build/image/live acceptance'};
fs.writeFileSync(path.join(__dirname,'SOURCE-TRANSITION-PROOF.json'),JSON.stringify(report,null,2)+'\n');
console.log('MERI_LOOP_SOURCE_TRANSITION_OK '+JSON.stringify({sourceCheckpoint:checkpoint,rawRegions:2,rawPhysicalLines:2287,
  constructorSites,currentArchiveCases:3,currentRpMappedIdentities:22,protectedIdentities:protectedIdentities.length,scope:report.scope}));
