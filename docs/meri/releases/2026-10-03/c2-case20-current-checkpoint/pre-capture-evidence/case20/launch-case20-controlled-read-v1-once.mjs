import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {runControlledReadOperator} from '../../meri-c1-20261002/evals/meri/live-v1/run-controlled-read.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const repo='C:/dev/main/meri-c1-20261002';
const run='f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b';
const scopePath=root+'/case20-live-scope-v1.json';
const out=root+'/case20-native-'+run;
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(process.argv.length,2);
assert.equal(existsSync(out),false,'Existing run must be reconciled; no replay');
assert.equal(existsSync('C:/dev/cap-meri-foundation-evidence/controlled-read-claims/20-'+run+'.json'),false,'Existing claim must not be reused');
assert.equal(sha(readFileSync(repo+'/evals/meri/live-v1/run-controlled-read.mjs')),'d8d429a7e4e1b5fc5d731e7cb4dee098a3075d4764fa0886c745cace43bf7c83');
const manifestPath=root+'/case01-recovered-auth-scope.private.json';
assert.equal(sha(readFileSync(manifestPath)),'ed9c3b1c11014825b29ee2879796e20b3f0023959ed9e478337180b96ed7a062');
const scope=JSON.parse(readFileSync(scopePath,'utf8'));
assert.equal(scope.config.caseId,'20');assert.equal(scope.config.captureRunId,run);
assert.equal(scope.config.conversationId,null);assert.equal(scope.config.limits.maxSpendUsd,15);
assert.equal(scope.config.limits.concurrency,1);assert.equal(scope.operatorSourceSha,'af7aa8aff4777a2d4809e882c2b797fbb2cd51a2');
assert.equal(scope.config.deployment.apiSha,'4f0253874357c272fda1ae2a5271ee4af645f0bc');
assert.equal(scope.config.deployment.orchestratorSha,scope.config.deployment.apiSha);
const checkpoint=JSON.parse(readFileSync(root+'/case01-terminal-cost-executed-v1/aggregate-checkpoint.json','utf8'));
assert.deepEqual(scope.aggregateCheckpoint,checkpoint);
assert.equal(checkpoint.snapshot.eventCount,22);assert.equal(checkpoint.snapshot.activeRun,null);
for(const name of ['run-authorization.json','fresh-spend.jsonl']) {
 const bytes=readFileSync('C:/dev/main/outputs/meri-fresh-20261003/'+name);
 assert.equal(bytes.length,checkpoint.state.files[name].bytes);assert.equal(sha(bytes),checkpoint.state.files[name].sha256);
}
process.env.AWS_PROFILE='capiro-dev';process.env.AWS_REGION='us-east-1';
assert.equal(aws(['sts','get-caller-identity']).Arn,'arn:aws:iam::967807252336:user/capirocli');
const secret=aws(['secretsmanager','get-secret-value','--secret-id','arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
assert.equal(typeof secret,'string');assert.ok(/^sk_/u.test(secret));
process.env.CLERK_SECRET_KEY=secret;
try {process.exitCode=await runControlledReadOperator(['--execute-original-controlled-read-once','--scope',scopePath,'--manifest',manifestPath,'--out',out]);}
finally {delete process.env.CLERK_SECRET_KEY;}
