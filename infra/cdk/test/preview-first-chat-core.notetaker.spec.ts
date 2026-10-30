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

// The exact five references observed on the live preview Core execution role.
const acceptedBinding = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../lib/preview/first-chat-core-notetaker-secrets.json'),
    'utf8',
  ),
) as { secretArns: Record<string, string> };
const secretArns = acceptedBinding.secretArns;

test('the committed binding carries exactly the five live references', () => {
  assert.deepEqual(Object.keys(secretArns).sort(), [
    ...FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES,
  ].sort());
  for (const name of FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES)
    assert.match(
      secretArns[name]!,
      /^arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro\/dev\/[a-z-]+-[A-Za-z0-9]{6}$/,
    );
});

test('adds only the SDK switch and the five credential references', () => {
  const overlay = firstChatCoreNoteTakerConfiguration({ secretArns });
  assert.deepEqual(overlay.environment, [{ name: 'MEETING_ARTIFACT_AGENT_SDK', value: 'true' }]);
  assert.deepEqual(
    overlay.secrets.map((secret) => secret.name),
    [...FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES],
  );
  assert.deepEqual(
    overlay.secrets.map((secret) => secret.valueFrom),
    FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES.map((name) => secretArns[name]),
  );
});

test('emits no posture, ownership, Recall, callback, fence or enablement value', () => {
  const overlay = firstChatCoreNoteTakerConfiguration({ secretArns });
  const names = overlay.environment.map((entry) => entry.name);
  for (const forbidden of [
    'ENGAGEMENT_PROCESS_MODE',
    'ENGAGEMENT_BACKGROUND_OWNER',
    'ENGAGEMENT_BACKGROUND_WORKER_RESTRICTION',
    'ENGAGEMENT_EXTERNAL_ACTIONS',
    'ENGAGEMENT_RECALL_WEBHOOK_ENABLED',
    'ENGAGEMENT_CALLBACKS_ENABLED',
    'ENGAGEMENT_MAIL_HANDOFF_FENCE_UTC',
    'ENGAGEMENT_MAIL_HANDOFF_GENERATION',
    'ENGAGEMENT_MAIL_HANDOFF_PHASE',
    'NOTETAKER_ENABLED',
  ])
    assert.equal(names.includes(forbidden), false, `${forbidden} must not be emitted`);
});

test('grants GetSecretValue only, on exactly the five references', () => {
  const overlay = firstChatCoreNoteTakerConfiguration({ secretArns });
  const statements = overlay.executionRolePolicy.Statement as any[];
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].Action, ['secretsmanager:GetSecretValue']);
  assert.deepEqual(statements[0].Resource, Object.values(secretArns));
  const serialized = JSON.stringify(overlay.executionRolePolicy);
  assert.equal(serialized.includes('DescribeSecret'), false);
  assert.equal(serialized.includes('kms:'), false);
  assert.equal(serialized.includes('"*"'), false);
});

test('rejects references that are not exact same-account secret ARNs', () => {
  const other = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:capiro/dev/x-AbCd01';
  assert.throws(
    () => firstChatCoreNoteTakerConfiguration({ secretArns: { ...secretArns, OPENAI_API_KEY: other } }),
    /complete same-account secret ARN required/,
  );
  assert.throws(
    () =>
      firstChatCoreNoteTakerConfiguration({
        secretArns: { ...secretArns, OPENAI_API_KEY: 'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/*' },
      }),
    /complete same-account secret ARN required/,
  );
});

test('rejects missing, extra and duplicate credentials', () => {
  const { OPENAI_API_KEY: _omit, ...missing } = secretArns;
  assert.throws(() => firstChatCoreNoteTakerConfiguration({ secretArns: missing }));
  assert.throws(() =>
    firstChatCoreNoteTakerConfiguration({
      secretArns: { ...secretArns, EXTRA_KEY: secretArns.OPENAI_API_KEY },
    }),
  );
  assert.throws(
    () =>
      firstChatCoreNoteTakerConfiguration({
        secretArns: { ...secretArns, ANTHROPIC_API_KEY: secretArns.OPENAI_API_KEY },
      }),
    /Distinct note taker secret references required/,
  );
});

test('refuses a KMS binding and unknown fields, so no unneeded grant returns', () => {
  // No secret declares a customer key, so a key list is not part of this contract.
  // Refusing it (rather than ignoring it) keeps a kms:Decrypt grant from creeping
  // back into a change that does not need one, and leaves the role's existing
  // conditional KMS statement as the only KMS statement.
  assert.throws(
    () =>
      firstChatCoreNoteTakerConfiguration({
        secretArns,
        kmsKeyArns: ['arn:aws:kms:us-east-1:967807252336:key/efe8a18d-192e-4f30-8eea-b3f65ae7755e'],
      }),
    /exact fields required/,
  );
  assert.throws(
    () => firstChatCoreNoteTakerConfiguration({ secretArns, extra: true }),
    /exact fields required/,
  );
});

test('composes onto the accepted posture without disturbing any existing entry', () => {
  // Shape of the accepted running candidate: process active, owner api, external
  // actions enabled, Recall off, worker restricted to integration_sync_scheduler,
  // and the role's existing conditional KMS statement over its two keys.
  const environment = [
    { name: 'CAPIRO_SERVICE_NAME', value: 'api' },
    { name: 'ENGAGEMENT_PROCESS_MODE', value: 'active' },
    { name: 'ENGAGEMENT_BACKGROUND_OWNER', value: 'api' },
    { name: 'ENGAGEMENT_EXTERNAL_ACTIONS', value: 'enabled' },
    { name: 'ENGAGEMENT_CALLBACKS_ENABLED', value: 'true' },
    { name: 'ENGAGEMENT_RECALL_WEBHOOK_ENABLED', value: 'false' },
    { name: 'ENGAGEMENT_BACKGROUND_WORKER_RESTRICTION', value: 'integration_sync_scheduler' },
    { name: 'NOTETAKER_ENABLED', value: 'true' },
    { name: 'OPENAI_MODEL', value: 'gpt-6-astra' },
  ];
  const secrets = [
    {
      name: 'DB_PASSWORD',
      valueFrom:
        'arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/app-zNPtsU:password::',
    },
  ];
  const statements = [
    { Effect: 'Allow', Action: ['ecr:GetAuthorizationToken'], Resource: '*' },
    {
      Effect: 'Allow',
      Action: ['kms:Decrypt'],
      Resource: [
        'arn:aws:kms:us-east-1:967807252336:key/efe8a18d-192e-4f30-8eea-b3f65ae7755e',
        'arn:aws:kms:us-east-1:967807252336:key/f47b4c53-b9c0-4d91-ad57-4d882f87767e',
      ],
      Condition: { StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' } },
    },
  ];

  const overlay = firstChatCoreNoteTakerConfiguration({ secretArns });
  const addMissing = (base: any[], additions: any[]) => [
    ...base,
    ...additions.filter((entry) => !base.some((existing) => existing.name === entry.name)),
  ];
  const composedEnvironment = addMissing(environment, overlay.environment);
  const composedSecrets = addMissing(secrets, overlay.secrets);
  const composedStatements = [
    ...statements,
    ...overlay.executionRolePolicy.Statement.filter(
      (entry) => !statements.some((existing) => JSON.stringify(existing) === JSON.stringify(entry)),
    ),
  ];

  // Exactly one new env entry, five new secret references, one new statement.
  assert.equal(composedEnvironment.length, environment.length + 1);
  assert.deepEqual(composedEnvironment.slice(0, environment.length), environment);
  assert.equal(composedSecrets.length, secrets.length + 5);
  assert.deepEqual(composedSecrets.slice(0, secrets.length), secrets);
  assert.equal(composedStatements.length, statements.length + 1);
  assert.deepEqual(composedStatements.slice(0, statements.length), statements);
  // The pre-existing conditional KMS statement survives untouched.
  assert.deepEqual(composedStatements[1], statements[1]);

  const byName = Object.fromEntries(composedEnvironment.map((entry: any) => [entry.name, entry.value]));
  assert.equal(byName['ENGAGEMENT_PROCESS_MODE'], 'active');
  assert.equal(byName['ENGAGEMENT_BACKGROUND_OWNER'], 'api');
  assert.equal(byName['ENGAGEMENT_EXTERNAL_ACTIONS'], 'enabled');
  assert.equal(byName['ENGAGEMENT_RECALL_WEBHOOK_ENABLED'], 'false');
  assert.equal(byName['ENGAGEMENT_BACKGROUND_WORKER_RESTRICTION'], 'integration_sync_scheduler');
  assert.equal(byName['NOTETAKER_ENABLED'], 'true');
  assert.equal(byName['MEETING_ARTIFACT_AGENT_SDK'], 'true');
});

test('renders the overlay through the CLI without touching AWS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-overlay-'));
  const input = path.join(dir, 'binding.json');
  const output = path.join(dir, 'overlay.json');
  fs.writeFileSync(input, JSON.stringify({ secretArns }));
  assert.equal(main(['--render-notetaker', input, output]), 0);
  const written = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(written.secrets.length, FIRST_CHAT_CORE_NOTETAKER_SECRET_NAMES.length);
  assert.deepEqual(written.environment, [{ name: 'MEETING_ARTIFACT_AGENT_SDK', value: 'true' }]);
  // An existing output is never overwritten.
  assert.equal(main(['--render-notetaker', input, output]), 2);
});
