import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const repo = 'C:/dev/main/meri-c1-20261002';
const root = 'C:/dev/main/outputs/meri-c2-20261003';
const out = root + '/case01-recovery-local-checks-v1';
const node = 'C:/Program Files/nodejs/node.exe';
const python = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
const hash = b => createHash('sha256').update(b).digest('hex');
const journal = 'C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl';
const before = readFileSync(journal);
assert.equal(hash(before), '7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60');
const claim = root + '/case01-presubmission-recovery-claim-bd35c0f4-1604-4371-b7e9-a1338369e53f.json';
assert.equal(existsSync(claim), false);
mkdirSync(out);
const sourceFiles = ['evals/meri/live-v1/capture-spend-aggregate.mjs',
  'evals/meri/live-v1/case01-presubmission-recovery-authority.mjs',
  'evals/meri/live-v1/tests/case01-presubmission-recovery.test.mjs'];
const commands = [
  ...sourceFiles.map((path,i) => ({name:'syntax-'+i, exe:node,args:['--check',path]})),
  {name:'operator-syntax',exe:node,args:['--check',root+'/run-case01-native-recovery-v1.mjs']},
  {name:'recovery',exe:node,args:['--test','evals/meri/live-v1/tests/case01-presubmission-recovery.test.mjs']},
  {name:'authority-regressions',exe:node,args:['--test','evals/meri/live-v1/tests/case01-authority.test.mjs','evals/meri/live-v1/tests/case01-caller-authority.test.mjs','evals/meri/live-v1/tests/grade-case01-capture.test.mjs']},
  {name:'fresh-js-disposable-prefix',exe:node,args:['--test',root+'/case01-recovery-regressions-v1/capture-spend-fresh-copy.test.mjs']},
  {name:'fresh-native-disposable-prefix',exe:python,args:['-I',root+'/case01-recovery-regressions-v1/capture-spend-fresh-copy.unit.py']},
];
const results = [];
for (const command of commands) {
  const r = spawnSync(command.exe,command.args,{cwd:repo,encoding:'utf8',windowsHide:true,shell:false,timeout:180000,maxBuffer:8*1024*1024});
  const bytes = (r.stdout??'') + (r.stderr??'');
  const file = command.name+'.log';
  writeFileSync(out+'/'+file,bytes,{flag:'wx'});
  results.push({name:command.name,status:r.status,signal:r.signal,log:file,sha256:hash(bytes),error:r.error?.code??null});
  console.log(JSON.stringify(results.at(-1)));
}
const checkpoint = {status:results.every(r=>r.status===0&&!r.error)?'LOCAL_CHECKS_PASS':'LOCAL_CHECKS_FAILED',
  sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim(),
  sources:sourceFiles.map(path=>({path,sha256:hash(readFileSync(repo+'/'+path))})), results,
  journalUnchanged:readFileSync(journal).equals(before), liveRecoveryClaimAbsent:!existsSync(claim), completedAt:new Date().toISOString()};
writeFileSync(out+'/checkpoint.json',JSON.stringify(checkpoint,null,2)+'\n',{flag:'wx'});
assert.equal(checkpoint.journalUnchanged,true); assert.equal(checkpoint.liveRecoveryClaimAbsent,true);
process.exitCode = checkpoint.status==='LOCAL_CHECKS_PASS'?0:1;
