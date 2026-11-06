import { completeExternalSecretArn, legiwatchAgentEnvironment } from '../config';
import { firstChatCoreLegiwatchRefreshPlan } from './first-chat-core-legiwatch-refresh';

const account = '967807252336';
const region = 'us-east-1';
export const LEGIWATCH_SOURCE_SECRET_NAMES = [
  'GOVINFO_API_KEY', 'CONGRESS_API_KEY', 'LEGISCAN_API_KEY',
  'REGULATIONS_GOV_API_KEY', 'CENSUS_API_KEY',
] as const;

function exactRecord(input: unknown, names: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== names.length || names.some((key) => !Object.hasOwn(input, key)))
    throw new Error(`${label}: exact fields required`);
  return input as Record<string, unknown>;
}

/** Offline configuration overlay. The operator merges it onto freshly inspected
 * preview tasks; it neither selects an image/database nor starts a task. */
export function firstChatCoreLegiwatchConfiguration(input: unknown) {
  const binding = exactRecord(input, ['provider', 'model', 'secretArns', 'kmsKeyArns',
    ...(input && typeof input === 'object' && Object.hasOwn(input, 'refresh') ? ['refresh'] : []),
  ], 'LegiWatch binding');
  if (binding.provider !== 'bedrock' && binding.provider !== 'anthropic')
    throw new Error('LegiWatch provider must be bedrock or anthropic');
  if (typeof binding.model !== 'string' || !binding.model.trim())
    throw new Error('An explicit reviewed LegiWatch model is required');
  const environment = Object.entries(legiwatchAgentEnvironment({
    legiwatchAgentProvider: binding.provider, legiwatchAgentModel: binding.model,
  })).map(([name, value]) => ({ name, value }));
  const names = [
    ...LEGIWATCH_SOURCE_SECRET_NAMES,
    ...(binding.provider === 'anthropic' ? ['ANTHROPIC_API_KEY'] : []),
  ];
  const references = exactRecord(binding.secretArns, names, 'LegiWatch secret references');
  const secretArns = Object.fromEntries(Object.entries(references).map(([name, value]) => [
    name, completeExternalSecretArn(value, { account, region }, name),
  ]));
  const kmsKeyArns = binding.kmsKeyArns;
  if (!Array.isArray(kmsKeyArns) || kmsKeyArns.length > names.length ||
      new Set(kmsKeyArns).size !== kmsKeyArns.length || kmsKeyArns.some((arn) =>
        typeof arn !== 'string' || !new RegExp(
          `^arn:aws:kms:${region}:${account}:key/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$`,
        ).test(arn)))
    throw new Error('Explicit same-account customer-managed key ARNs required (or an empty list)');

  const overlay = (taskNames: string[]) => {
    const resources = [...new Set(taskNames.map((name) => secretArns[name]!))];
    const statements: Record<string, unknown>[] = [{
      Effect: 'Allow', Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      Resource: resources,
    }];
    if (kmsKeyArns.length) statements.push({
      Effect: 'Allow', Action: ['kms:Decrypt'], Resource: kmsKeyArns,
      Condition: { StringEquals: {
        'kms:ViaService': `secretsmanager.${region}.amazonaws.com`,
        'kms:EncryptionContext:SecretARN': resources,
      } },
    });
    return {
      environment,
      secrets: taskNames.map((name) => ({ name, valueFrom: secretArns[name]! })),
      executionRolePolicy: { Version: '2012-10-17', Statement: statements },
    };
  };
  return {
    // Census ACS remains on ingestion workers; serving reads retained facts.
    serve: overlay(names.filter((name) => name !== 'CENSUS_API_KEY')),
    syncWorker: overlay(names),
    ...(binding.refresh === undefined ? {} : {
      refresh: firstChatCoreLegiwatchRefreshPlan(binding.refresh, { environment, secretArns }),
    }),
  };
}
