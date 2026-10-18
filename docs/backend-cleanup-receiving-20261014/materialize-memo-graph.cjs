const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const crypto=require('node:crypto');
const ts=require('typescript');const root=path.resolve(__dirname,'../..');
const specs=['alert-memo-citations.spec.ts','alert-memo-held-gate.spec.ts','alert-memo-program-element.spec.ts','alert-memo-templates.spec.ts','alert-memo.service.spec.ts','district-brief.service.spec.ts','entailment-gate.spec.ts','governed-alert-deliverables.factory.spec.ts','governed-alert-deliverables.phase22.spec.ts','legiwatch-context-plane-architecture.contract.spec.ts','memo-sections-characterization.spec.ts','memo-sections-ownership.contract.spec.ts'].map(x=>'apps/api/src/intelligence/alert-memo/'+x).concat(['apps/api/src/reviews/reviews-di-cycle.spec.ts']);
const entries=new Map();for(const row of cp.execFileSync('git',['ls-tree','-rz','HEAD','--','apps','packages'],{cwd:root,maxBuffer:8*1024*1024}).toString().split('\0')){if(row){const i=row.indexOf('\t');entries.set(row.slice(i+1),row.slice(0,i));}}
const queue=[...specs];const visited=new Set();const excluded=new Set();const assets=[];
while(queue.length){
 const file=queue.shift();if(visited.has(file))continue;visited.add(file);
 if(file==='apps/api/src/engagement/engagement.service.ts'){excluded.add(file);continue;}
 const source=cp.execFileSync('git',['show','HEAD:'+file],{cwd:root});
 assets.push({path:file,tree_entry:entries.get(file),bytes:source.length,sha256:crypto.createHash('sha256').update(source).digest('hex')});
 if(!file.endsWith('.ts')&&!file.endsWith('.js')&&!file.endsWith('.cjs'))continue;
 for(const imp of ts.preProcessFile(source.toString(),true,true).importedFiles){
  if(!imp.fileName.startsWith('.'))continue;
  const stem=path.posix.normalize(path.posix.join(path.posix.dirname(file),imp.fileName));
  const possible=[stem,stem.replace(/\.js$/,'.ts'),stem+'.ts',stem+'.js',stem+'/index.ts',stem+'/index.js'];
  const dependency=possible.find(p=>entries.has(p));if(dependency)queue.push(dependency);
 }
}
const scopes=assets.map(a=>'/'+a.path).join('\n')+'\n';cp.execFileSync('git',['sparse-checkout','add','--stdin'],{cwd:root,input:scopes});
fs.writeFileSync(path.join(__dirname,'memo-test-scope.json'),JSON.stringify({source_head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),specs,expected_donor_cases:161,expected_suites:13,protected_reporting_opaque_token:true,full_application_graph_qualified:false},null,2)+'\n');
fs.writeFileSync(path.join(__dirname,'evidence/memo-materialization-scope.json'),JSON.stringify({assets,excluded_without_body_read:[...excluded],schema_or_migration_execution:false},null,2)+'\n');
console.log(JSON.stringify({specs:specs.length,source_assets:assets.length,protected_bodies_excluded:excluded.size}));
