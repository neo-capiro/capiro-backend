import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateQualification} from 'file:///C:/dev/cap-meri-outcomes-validation/scripts/lib/meri-release-policy.mjs';
const service=process.argv[2];
assert.ok(['api','meriv2-orchestrator'].includes(service));
const root='C:/dev/cap-meri-foundation-evidence/oct02-live-repair-release';
const repo='C:/dev/cap-meri-outcomes-validation';
const relative='docs/meri/releases/2026-10-02/live-repair-release/';
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const git=(...args)=>execFileSync('git',args,{cwd:repo,windowsHide:true});
const input=await read(`${root}/reviewed-build-input.json`);
const head=git('rev-parse','HEAD').toString().trim();
assert.equal(head,git('rev-parse','origin/main').toString().trim());
assert.equal(git('status','--porcelain').toString().trim(),'');
git('merge-base','--is-ancestor',input.sourceSha,head);
assert.ok(git('diff','--name-only',input.testedCodeSha,head).toString().split('\n').every(p=>!p||p.startsWith('docs/')));
const qualification=await read(`${repo}/${relative}qualification.json`);
assert.equal(qualification.sourceSha,input.testedCodeSha);
assert.equal(qualification.exitCode,0);assert.equal(qualification.schemaChange,false);
assert.ok(qualification.results.length===7&&qualification.results.every(c=>c.exitCode===0));
assert.equal(qualification.nodePassed,181);assert.equal(qualification.nodeSkipped,0);assert.equal(qualification.apiPassed,40);assert.equal(qualification.offlineCases,26);assert.equal(qualification.customVerifierExit,0);
const sourceHashes=await read(`${repo}/${relative}source-git-blob-hashes.json`);
assert.equal(sourceHashes.testedCodeSha,input.testedCodeSha);
for(const [file,hash] of Object.entries(sourceHashes.files))
  assert.equal(createHash('sha256').update(git('show',head+':'+file)).digest('hex'),hash,file);
const result=await read(`${repo}/${relative}${service}-build-readback.json`);
assert.equal(result.verdict,'PASS');assert.equal(result.buildStatus,'SUCCEEDED');
assert.equal(result.sourceSha,input.sourceSha);assert.equal(result.service,service);
assert.equal(result.actualBuildspecSha256,input.services[service].buildspecSha256);
const expected=input.services[service].executedMarkers;
for(const marker of expected)assert.equal(result.executedMarkers.filter(m=>m.line===marker).length,1);
const base=`https://github.com/neo-capiro/capirov2/blob/${head}/${relative}`;
const buildUrl=base+`${service}-build-readback.json`;
const q={schemaVersion:1,service,sourceSha:input.sourceSha,image:result.image,status:'qualified',
 reviewer:'Codex integration owner; independent Hermes/Bedrock Kimi source reviews and actual local PostgreSQL/regression checks, followed by source-bound native ARM64 build verification. Image-only promotion preserves current service settings. Original full live acceptance remains NOT_RUN.',
 reviewedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+4*3600000).toISOString(),schemaChange:false,
 evidence:[base+'qualification.md',base+'qualification.json',base+'source-git-blob-hashes.json',buildUrl],
 checks:['build','automated-tests','retirement-compatibility'].map(name=>({name,status:'passed',sourceSha:input.sourceSha,image:result.image,url:name==='build'?buildUrl:base+(name==='automated-tests'?'qualification.json':'qualification.md')}))};
validateQualification(q,service,q.image);
await writeFile(`${root}/${service}-qualification.json`,JSON.stringify(q,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({service,sourceSha:q.sourceSha,image:q.image,evidenceSha:head}));
