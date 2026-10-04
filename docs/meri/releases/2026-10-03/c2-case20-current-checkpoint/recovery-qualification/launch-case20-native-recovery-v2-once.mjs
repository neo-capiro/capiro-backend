import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {runCase20RecoveryOperator} from './run-case20-native-recovery-v2.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(process.argv.length,2);
assert.equal(hash(readFileSync("C:/dev/main/outputs/meri-c2-20261003/case20-native-recovery-v2-reviewed-input.json")),"3d9785bd20ebfb035cc89a594dbc09824bf7e334c82691427abf9f8118dd9439");
assert.equal(hash(readFileSync("C:/dev/main/outputs/meri-c2-20261003/run-case20-native-recovery-v2.mjs")),"c7bdbacd9f5cfef151c5d950d0e34c486dd7c795ccdb61c6dcd2e26418ecb2e8");
assert.equal(existsSync("C:/dev/main/outputs/meri-c2-20261003/case20-native-recovery-v2-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b"),false);
assert.equal(existsSync("C:/dev/main/outputs/meri-c2-20261003/case20-presubmission-recovery-claim-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b.json"),false);
assert.equal(hash(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')),'d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b');
process.env.AWS_PROFILE='capiro-dev';process.env.AWS_REGION='us-east-1';process.env.AWS_MAX_ATTEMPTS='1';
assert.equal(aws(['sts','get-caller-identity']).Arn,'arn:aws:iam::967807252336:user/capirocli');
const secret=aws(['secretsmanager','get-secret-value','--secret-id','arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
assert.equal(typeof secret,'string');assert.equal(/^sk_/u.test(secret),true);
process.env.CLERK_SECRET_KEY=secret;
try{process.exitCode=await runCase20RecoveryOperator(['--continue-same-unsubmitted-case20-once']);}
finally{delete process.env.CLERK_SECRET_KEY;}
