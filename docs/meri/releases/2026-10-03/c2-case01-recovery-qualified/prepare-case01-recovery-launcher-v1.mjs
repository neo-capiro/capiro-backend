import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const review=read(root+'/case01-recovery-independent-review-v1.json');
assert.equal(review.status,'PASS');
const checks=read(root+'/case01-recovery-local-checks-v1/checkpoint.json');
assert.equal(checks.status,'LOCAL_CHECKS_PASS');
assert.equal(checks.journalUnchanged,true); assert.equal(checks.liveRecoveryClaimAbsent,true);
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim(),'');
const operatorCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
const requiredPaths=[repo+'/evals/meri/live-v1/capture-spend-aggregate.mjs',
  repo+'/evals/meri/live-v1/case01-presubmission-recovery-authority.mjs',
  repo+'/evals/meri/live-v1/tests/case01-presubmission-recovery.test.mjs',
  root+'/run-case01-native-recovery-v1.mjs'];
for(const path of requiredPaths) {
  const r=review.files.find(row=>row.path===path); assert.ok(r); assert.equal(hash(readFileSync(path)),r.sha256);
}
for(const item of checks.sources) assert.equal(hash(readFileSync(repo+'/'+item.path)),item.sha256);
const files=[...requiredPaths,root+'/case01-native-bootstrap-v2/run-case01-native.mjs',
  root+'/case01-native-bootstrap-v2/case01-prepared-guards.mjs',root+'/case01-recovery-independent-review-v1.json',
  root+'/case01-recovery-local-checks-v1/checkpoint.json'].map(path=>({path,sha256:hash(readFileSync(path))}));
const input={status:'REVIEWED_CASE01_PRESUBMISSION_CONTINUATION',operatorCommit,files,
  captureRunId:'bd35c0f4-1604-4371-b7e9-a1338369e53f',conversationId:'f493355c-ee97-44a1-a0b0-e05e7b104b59',
  reservationId:'cf7ea1df-6996-4d29-a5d5-b98db9c85c61',ceilingMicros:15000000,
  preservePriorClaim:true,createConversation:false,newReserve:false,maximumNewTurns:1,automaticRetry:false,
  recordedAt:new Date().toISOString()};
const reviewPath=root+'/case01-native-recovery-v1-reviewed-input.json';
writeFileSync(reviewPath,JSON.stringify(input,null,2)+'\n',{flag:'wx'});
const launcher=`import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {runCase01RecoveryOperator} from './run-case01-native-recovery-v1.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(process.argv.length,2);
assert.equal(hash(readFileSync(${JSON.stringify(reviewPath)})),${JSON.stringify(hash(readFileSync(reviewPath)))});
assert.equal(hash(readFileSync(${JSON.stringify(root+'/run-case01-native-recovery-v1.mjs')})),${JSON.stringify(hash(readFileSync(root+'/run-case01-native-recovery-v1.mjs')))});
assert.equal(existsSync(${JSON.stringify(root+'/case01-native-recovery-v1-bd35c0f4-1604-4371-b7e9-a1338369e53f')}),false);
assert.equal(existsSync(${JSON.stringify(root+'/case01-presubmission-recovery-claim-bd35c0f4-1604-4371-b7e9-a1338369e53f.json')}),false);
assert.equal(hash(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')),'7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60');
process.env.AWS_PROFILE='capiro-dev';process.env.AWS_REGION='us-east-1';process.env.AWS_MAX_ATTEMPTS='1';
assert.equal(aws(['sts','get-caller-identity']).Arn,'arn:aws:iam::967807252336:user/capirocli');
const secret=aws(['secretsmanager','get-secret-value','--secret-id','arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
assert.equal(typeof secret,'string');assert.equal(/^sk_/u.test(secret),true);
process.env.CLERK_SECRET_KEY=secret;
try{process.exitCode=await runCase01RecoveryOperator(['--continue-same-unsubmitted-case01-once']);}
finally{delete process.env.CLERK_SECRET_KEY;}
`;
const launcherPath=root+'/launch-case01-native-recovery-v1-once.mjs';
writeFileSync(launcherPath,launcher,{flag:'wx'});
console.log(JSON.stringify({status:'LAUNCHER_PREPARED_NOT_EXECUTED',operatorCommit,reviewPath,
  reviewSha256:hash(readFileSync(reviewPath)),launcherPath,launcherSha256:hash(readFileSync(launcherPath))}));
