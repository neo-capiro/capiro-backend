import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const targets = [
 ['scripts/engagement-phase3-resilience.mjs', 'const EVIDENCE = required(', ['ENGAGEMENT_PHASE3_EVIDENCE_DIR','ENGAGEMENT_PHASE3_FIXTURE_FILE','ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE','ENGAGEMENT_PHASE3_DB_CONTAINER']],
 ['scripts/run-engagement-phase3-resilience.mjs', 'const ROOT = path.resolve(', ['DATABASE_URL','ENGAGEMENT_PHASE3_EVIDENCE_DIR']],
 ['scripts/verify-engagement-phase3-local-evidence.mjs', 'const ROOT = path.resolve(', ['ENGAGEMENT_PHASE3_EVIDENCE_DIR','RELEASE_SHA']],
];
const rows=[];
for(const [file,end,keys] of targets){
 const source=fs.readFileSync(file,'utf8');const at=source.indexOf(end);assert.ok(at>0);
 const code=source.slice(0,at).replace(/^#![^\n]*\n/,'').replace(/^import[\s\S]*?;\n/gm,'')+'\nthrow {stop:true};';
 const configured=Object.fromEntries(keys.map(k=>[k,'synthetic-not-used']));
 for(const [name,argv,env,expected]of[
  ['noargs',[],{},2],['help',['--help'],{},0],['short-help',['-h'],{},0],
  ['unknown',['--unknown'],{},2],['unsupported-run',['--run'],{},2],['mixed-help',['--help','--run'],{},2],
  ['blank-required-env',[],Object.fromEntries(keys.map(k=>[k,'   '])),2],
  ['configured-help',['--help'],configured,0],['configured-unknown',['--unknown'],configured,2],['configured-default-stops-before-work',[],configured,'stop'],
 ]){
  let result;const output=[];
  try{vm.runInNewContext(code,{process:{argv:['node',file,...argv],env,exit:code=>{throw {exit:code};}},console:{log:s=>output.push(['out',s]),error:s=>output.push(['err',s])}});assert.fail('must exit or stop');}
  catch(error){result=error?.stop?'stop':error?.exit;if(result===undefined)throw error;}
  assert.equal(result,expected,file+':'+name);rows.push({file,name,result,output});
 }
}
console.log(JSON.stringify({scope:'exact current CLI preflight projection only; imports and all work after first configuration constant excluded; no native/default body',pass:rows.length,rows},null,2));
