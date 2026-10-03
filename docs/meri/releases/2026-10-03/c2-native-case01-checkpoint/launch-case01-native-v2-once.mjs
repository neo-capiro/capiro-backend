import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { aws } from '../meri-fresh-20261003/auth-preflight.mjs';
import { runCase01Operator, buildCase01Scope } from './case01-native-bootstrap-v2/run-case01-native.mjs';
const root = 'C:/dev/main/outputs/meri-c2-20261003';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scopePath = root + '/case01-native-actual-scope-v1.json';
const output = root + '/case01-native-bd35c0f4-1604-4371-b7e9-a1338369e53f';
assert.equal(process.argv.length, 2);
assert.equal(existsSync(output), false, 'Prior run must be reconciled, never retried');
assert.equal(hash(readFileSync(root + '/case01-native-bootstrap-v2/run-case01-native.mjs')), '655cc278a1a76ff55cf7a0ceae96ccfc325a016e0e3a0d53c21f43f276c171d1');
const inspection = JSON.parse(readFileSync(root + '/case01-native-actual-scope-v1-inspection.json', 'utf8'));
assert.equal(inspection.status, 'ACTUAL_SETUP_SCOPE_STATIC_INSPECTION_PASS');
assert.equal(inspection.scopeSha256, hash(readFileSync(scopePath)));
buildCase01Scope(JSON.parse(readFileSync(scopePath, 'utf8')));
process.env.AWS_PROFILE = 'capiro-dev';
process.env.AWS_REGION = 'us-east-1';
assert.equal(aws(['sts', 'get-caller-identity']).Arn, 'arn:aws:iam::967807252336:user/capirocli');
const secret = aws(['secretsmanager', 'get-secret-value', '--secret-id', 'arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
assert.equal(typeof secret, 'string');
assert.equal(/^sk_/u.test(secret), true);
process.env.CLERK_SECRET_KEY = secret;
try {
  process.exitCode = await runCase01Operator(['--execute-original-case01-once', '--scope', scopePath,
    '--manifest', root + '/case01-recovered-auth-scope.private.json', '--out', output]);
} finally { delete process.env.CLERK_SECRET_KEY; }
