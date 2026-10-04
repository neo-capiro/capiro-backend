const fs=require('node:fs'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const repo='C:/dev/main/meri-c1-20261002',req=createRequire(repo+'/package.json');
const files=['apps/api/src/retrieval/adapters/governed-memory-eligibility.helpers.ts','apps/api/src/retrieval/adapters/governed-memory-eligibility.helpers.spec.ts','apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts','apps/api/src/retrieval/adapters/case12-memory-eligibility.read.ts','evals/meri/live-v1/fixture-provisioning/case12-memory-eligibility-owner.mjs'];
(async()=>{const prettier=req('prettier'),results=[];
 for(const rel of files){const local=fs.readFileSync(__dirname+'/scratch/'+rel,'utf8'),current=fs.readFileSync(repo+'/'+rel,'utf8');
  const opts=await prettier.resolveConfig(repo+'/'+rel);const formatted=await prettier.format(local,{...opts,filepath:repo+'/'+rel});
  results.push({path:rel,scratchSha256:crypto.createHash('sha256').update(local).digest('hex'),repositorySha256:crypto.createHash('sha256').update(current).digest('hex'),exactAfterRepositoryPrettier:formatted===current});
 }
 fs.writeFileSync(__dirname+'/integrated-format-equivalence.json',JSON.stringify({repositoryWrites:0,results},null,2)+'\n');console.log(JSON.stringify(results));process.exitCode=results.every(r=>r.exactAfterRepositoryPrettier)?0:1;
})().catch(e=>{console.error(e.message);process.exitCode=1});
