import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {runCase01RecoveryOperator} from './run-case01-native-recovery-v1.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(process.argv.length,2);
assert.equal(hash(readFileSync("C:/dev/main/outputs/meri-c2-20261003/case01-native-recovery-v1-reviewed-input.json")),"7601f4bdd2c5b0559e0eb7a24f5036e921bcd3b0b88f2ea23fd9bf7bcefd333d");
assert.equal(hash(readFileSync("C:/dev/main/outputs/meri-c2-20261003/run-case01-native-recovery-v1.mjs")),"678e3108726a273afe0af7343060d6809518f9497282c1c8599fbee8bb13687a");
assert.equal(existsSync("C:/dev/main/outputs/meri-c2-20261003/case01-native-recovery-v1-bd35c0f4-1604-4371-b7e9-a1338369e53f"),false);
assert.equal(existsSync("C:/dev/main/outputs/meri-c2-20261003/case01-presubmission-recovery-claim-bd35c0f4-1604-4371-b7e9-a1338369e53f.json"),false);
assert.equal(hash(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')),'7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60');
process.env.AWS_PROFILE='capiro-dev';process.env.AWS_REGION='us-east-1';process.env.AWS_MAX_ATTEMPTS='1';
assert.equal(aws(['sts','get-caller-identity']).Arn,'arn:aws:iam::967807252336:user/capirocli');
const secret=aws(['secretsmanager','get-secret-value','--secret-id','arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
assert.equal(typeof secret,'string');assert.equal(/^sk_/u.test(secret),true);
process.env.CLERK_SECRET_KEY=secret;
try{process.exitCode=await runCase01RecoveryOperator(['--continue-same-unsubmitted-case01-once']);}
finally{delete process.env.CLERK_SECRET_KEY;}
