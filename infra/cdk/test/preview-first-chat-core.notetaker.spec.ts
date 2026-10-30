import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES,
  firstChatCoreNoteTakerConfiguration,
} from '../lib/preview/first-chat-core';
import { main } from '../bin/preview-first-chat-core';

const secretArns = Object.fromEntries(
  FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES.map((name) => [
    name,
    `arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/${name.toLowerCase()}-AbCd01`,
  ]),
);
const kmsKeyArns = ['arn:aws:kms:us-east-1:967807252336:key/00000000-0000-4000-8000-000000000005'];
const binding = { secretArns, kmsKeyArns };

test('renders the five note-taker credentials and the explicit posture', () => {
  const overlay = firstChatCoreNoteTakerConfiguration(binding);
  assert.deepEqual(
    overlay.secrets.map((secret) => secret.name),
    [...FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES],
  );
  assert.deepEqual(
    overlay.secrets.map((secret) => secret.valueFrom),
    FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES.map((name) => secretArns[name]),
  );
  // The runtime requires every one of these to be true at once; a partial
  // posture leaves note-taker work denied rather than silently half-enabled.
  assert.deepEqual(overlay.environment, [
    { name: 'ENGAGEMENT_EXTERNAL_ACTIONS', value: 'integrations_and_notetaker' },
    { name: 'ENGAGEMENT_PROCESS_MODE', value: 'shadow' },
    { name: 'ENGAGEMENT_BACKGROUND_OWNER', value: 'api' },
    { name: 'ENGAGEMENT_CALLBACKS_ENABLED', value: 'true' },
    { name: 'ENGAGEMENT_RECALL_WEBHOOK_ENABLED', value: 'true' },
    { name: 'NOTETAKER_ENABLED', value: 'true' },
    { name: 'MEETING_ARTIFACT_AGENT_SDK', value: 'true' },
  ]);
});

test('grants exactly the five references and never a wildcard', () => {
  const overlay = firstChatCoreNoteTakerConfiguration(binding);
  const statements = overlay.executionRolePolicy.Statement as any[];
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[0].Action, [
    'secretsmanager:GetSecretValue',
    'secretsmanager:DescribeSecret',
  ]);
  assert.deepEqual(statements[0].Resource, Object.values(secretArns));
  assert.deepEqual(statements[1].Action, ['kms:Decrypt']);
  assert.deepEqual(statements[1].Resource, kmsKeyArns);
  assert.deepEqual(statements[1].Condition, {
    StringEquals: {
      'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com',
      'kms:EncryptionContext:SecretARN': Object.values(secretArns),
    },
  });
  const serialized = JSON.stringify(overlay.executionRolePolicy);
  assert.equal(serialized.includes('"*"'), false);
  assert.equal(serialized.includes('secretsmanager:*'), false);
});

test('omits the KMS statement when no customer-managed key is supplied', () => {
  const overlay = firstChatCoreNoteTakerConfiguration({ secretArns, kmsKeyArns: [] });
  assert.equal((overlay.executionRolePolicy.Statement as any[]).length, 1);
});

test('rejects references that are not exact same-account secret ARNs', () => {
  const other = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:capiro/dev/x-AbCd01';
  assert.throws(
    () => firstChatCoreNoteTakerConfiguration({ secretArns: { ...secretArns, OPENAI_API_KEY: other }, kmsKeyArns }),
    /complete same-account secret ARN required/,
  );
  assert.throws(
    () =>
      firstChatCoreNoteTakerConfiguration({
        secretArns: { ...secretArns, OPENAI_API_KEY: 'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/*' },
        kmsKeyArns,
      }),
    /complete same-account secret ARN required/,
  );
});

test('rejects missing, extra and duplicate credentials', () => {
  const { OPENAI_API_KEY: _omit, ...missing } = secretArns;
  assert.throws(() => firstChatCoreNoteTakerConfiguration({ secretArns: missing, kmsKeyArns }));
  assert.throws(() =>
    firstChatCoreNoteTakerConfiguration({
      secretArns: { ...secretArns, EXTRA_KEY: secretArns.OPENAI_API_KEY },
      kmsKeyArns,
    }),
  );
  assert.throws(
    () =>
      firstChatCoreNoteTakerConfiguration({
        secretArns: { ...secretArns, ANTHROPIC_API_KEY: secretArns.OPENAI_API_KEY },
        kmsKeyArns,
      }),
    /Distinct note taker secret references required/,
  );
});

test('rejects non-customer-managed key ARNs and unknown fields', () => {
  assert.throws(
    () =>
      firstChatCoreNoteTakerConfiguration({
        secretArns,
        kmsKeyArns: ['arn:aws:kms:us-east-1:967807252336:alias/aws/secretsmanager'],
      }),
    /Explicit same-account customer-managed key ARNs required/,
  );
  assert.throws(
    () => firstChatCoreNoteTakerConfiguration({ ...binding, extra: true }),
    /exact fields required/,
  );
});

test('renders the overlay through the CLI without touching AWS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-overlay-'));
  const input = path.join(dir, 'binding.json');
  const output = path.join(dir, 'overlay.json');
  fs.writeFileSync(input, JSON.stringify(binding));
  assert.equal(main(['--render-notetaker', input, output]), 0);
  const written = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(written.secrets.length, FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES.length);
  assert.equal(written.environment.some((entry: any) => entry.name === 'MEETING_ARTIFACT_AGENT_SDK'), true);
  // An existing output is never overwritten.
  assert.equal(main(['--render-notetaker', input, output]), 2);
});
