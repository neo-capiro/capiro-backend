import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import {
  FIRST_CHAT_CORE_GUARD_RULE_EXPORT,
  FIRST_CHAT_CORE_HOST,
  FIRST_CHAT_CORE_IMAGE_PINS,
  FIRST_CHAT_CORE_POST_PATHS,
  firstChatCoreImageBinding,
  previewFirstChatCoreApplication,
} from '../lib/preview/first-chat-core';
const pins = FIRST_CHAT_CORE_IMAGE_PINS;
const binding = {
  schemaVersion: 9,
  ...pins,
  internalServiceSecretArn:
    'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/internal-service-secret-6cEZG4',
  internalServiceSecretVersionId: '00000000-0000-4000-8000-000000000001',
  listener: { guardPriority: 7 },
  deployment: {
    databaseHost: 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com',
    desiredCount: 1,
  },
  assets: {
    tenantIds: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'],
  },
  ownerMemory: { tenantId: '00000000-0000-4000-8000-000000000002' },
};
function render(check: (s: any, g: any, a: any) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-operator-'));
  try {
    const { service, guard, assets, app } = previewFirstChatCoreApplication(binding, dir);
    assert.equal(assets.terminationProtection, true);
    check(
      Template.fromStack(service).toJSON(),
      Template.fromStack(guard).toJSON(),
      Template.fromStack(assets).toJSON(),
    );
    app.synth();
  } finally {
    const real = fs.realpathSync(dir);
    assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
    assert.ok(real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(real, { recursive: true });
  }
}
test('qualified closed binding refuses historical schemas, extra policy and wrong image', () => {
  assert.deepEqual(firstChatCoreImageBinding(binding), binding);
  const oneTenant = { ...binding, assets: { tenantIds: [binding.assets.tenantIds[0]] } };
  assert.deepEqual(firstChatCoreImageBinding(oneTenant), oneTenant);
  assert.throws(() => firstChatCoreImageBinding(binding, null));
  for (const patch of [
    { sourceHead: 'a'.repeat(40) },
    { imageDigest: `sha256:${'b'.repeat(64)}` },
    { schemaVersion: 5 },
    { schemaVersion: 6 },
    { schemaVersion: 7 },
    { schemaVersion: 8 },
    { profile: {} },
    { signers: {} },
    { retainedTrust: null },
    { previewTenantId: '00000000-0000-4000-8000-000000000002' },
  ])
    assert.throws(() => firstChatCoreImageBinding({ ...binding, ...patch }));
});
test('storage binding refuses implicit, empty, duplicate, wildcard and foreign storage configuration', () => {
  for (const assets of [
    undefined,
    null,
    {},
    { tenantIds: [] },
    { tenantIds: ['*'] },
    { tenantIds: ['../another-prefix'] },
    { tenantIds: [binding.assets.tenantIds[0], binding.assets.tenantIds[0]] },
    { tenantIds: [...binding.assets.tenantIds, '00000000-0000-4000-8000-000000000004'] },
    { tenantIds: binding.assets.tenantIds, bucketName: 'live-bucket' },
  ])
    assert.throws(() => firstChatCoreImageBinding({ ...binding, assets }));
});
test('owner memory binding refuses absent, global, multiple and unbound tenants', () => {
  for (const ownerMemory of [
    undefined,
    {},
    { tenantId: 'all' },
    { tenantId: '*' },
    { tenantId: binding.assets.tenantIds.join(',') },
    { tenantId: '00000000-0000-4000-8000-000000000004' },
    { tenantId: binding.ownerMemory.tenantId, all: true },
  ])
    assert.throws(() => firstChatCoreImageBinding({ ...binding, ownerMemory }));
});
test('production DB, scaling, guard moves and unbound service secret refuse', () => {
  for (const deployment of [
    { ...binding.deployment, databaseHost: 'production.example.invalid' },
    { ...binding.deployment, desiredCount: 0 },
    { ...binding.deployment, desiredCount: 2 },
    { ...binding.deployment, extra: true },
  ])
    assert.throws(() => firstChatCoreImageBinding({ ...binding, deployment }));
  for (const listener of [
    { guardPriority: 3 },
    { guardPriority: 4 },
    { guardPriority: 8 },
    { guardPriority: 7, memoryPostPriority: 4 },
  ])
    assert.throws(() => firstChatCoreImageBinding({ ...binding, listener }));
  for (const patch of [
    { internalServiceSecretArn: binding.internalServiceSecretArn.replace('6cEZG4', 'wrong0') },
    { internalServiceSecretVersionId: '' },
    { internalServiceSecretVersionId: 'AWSCURRENT' },
    { internalServiceSecretVersionId: undefined },
  ])
    assert.throws(() => firstChatCoreImageBinding({ ...binding, ...patch }));
});
test('nine live resource IDs and both outputs survive with only the Assets task policy added', () =>
  render((s) => {
    assert.deepEqual(
      Object.keys(s.Resources).sort(),
      [
        'ServeExecutionRole9B512BDC',
        'ServeExecutionRoleDefaultPolicyBD488DD2',
        'ServeTaskTaskRoleD6B44EC7',
        'ServeTaskTaskRoleDefaultPolicy46D4ED77',
        'ServeTaskF1990141',
        'ServeLogBCB89CA4',
        'CoreTarget234133C4',
        'HeldCoreServiceA6CD0E1D',
        'FirstChatPostsOnly',
        'FirstChatMembershipPostOnly',
      ].sort(),
    );
    assert.deepEqual(Object.keys(s.Outputs).sort(), [
      'CoreApiBaseUrl',
      'RequiredPreviewHostGuardRuleArn',
    ]);
    assert.deepEqual(s.Resources.ServeTaskF1990141.Properties.TaskRoleArn, {
      'Fn::GetAtt': ['ServeTaskTaskRoleD6B44EC7', 'Arn'],
    });
    assert.equal(s.Resources.ServeTaskTaskRoleD6B44EC7.Properties.Policies, undefined);
    assert.equal(JSON.stringify(s).includes('kms:Sign'), false);
  }));
test('qualified ARM task uses persistent clone, version-pinned canonical secret and original credentials', () =>
  render((s) => {
    const t = s.Resources.ServeTaskF1990141.Properties,
      c = t.ContainerDefinitions[0],
      e = Object.fromEntries(c.Environment.map((x: any) => [x.Name, x.Value])),
      se = Object.fromEntries(c.Secrets.map((x: any) => [x.Name, x.ValueFrom]));
    assert.equal(t.Cpu, '1024');
    assert.equal(t.Memory, '2048');
    assert.deepEqual(t.RuntimePlatform, {
      CpuArchitecture: 'ARM64',
      OperatingSystemFamily: 'LINUX',
    });
    assert.equal(
      c.Image,
      `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core@${pins.imageDigest}`,
    );
    assert.deepEqual(c.Command, ['serve']);
    assert.equal(e.RELEASE_SHA, pins.sourceHead);
    assert.equal(e.DB_HOST, binding.deployment.databaseHost);
    assert.equal(e.TRACKER_APP_BASE_URL, `https://${FIRST_CHAT_CORE_HOST}`);
    assert.equal(e.MERI_CONTROL_ORIGIN, 'https://control.meri-preview.internal');
    assert.equal(
      e.MERI_CONTROL_CA_SHA256,
      'e177a1bc059a0fd7c54740f6db6619c992af01d1fda804d6c2058f0bd53995d4',
    );
    assert.ok(e.MERI_CONTROL_CA_BASE64.length > 0);
    assert.equal(
      se.INTERNAL_SERVICE_SECRET,
      `${binding.internalServiceSecretArn}:::${binding.internalServiceSecretVersionId}`,
    );
    for (const [name, field] of [
      ['DB_USER', 'username'],
      ['DB_PASSWORD', 'password'],
    ] as const)
      assert.equal(
        se[name],
        `arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/app-zNPtsU:${field}::`,
      );
    assert.equal(
      se.CLERK_SECRET_KEY,
      'arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM',
    );
    const v = s.Resources.HeldCoreServiceA6CD0E1D.Properties;
    assert.deepEqual(v.LoadBalancers, [
      { ContainerName: 'core', ContainerPort: 4000, TargetGroupArn: { Ref: 'CoreTarget234133C4' } },
      {
        ContainerName: 'core',
        ContainerPort: 4000,
        TargetGroupArn: { 'Fn::ImportValue': 'Capiro-Preview-Services-Edge-CoreTargetArn' },
      },
    ]);
    assert.equal(v.DesiredCount, 1);
    assert.equal(v.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, 'DISABLED');
    assert.deepEqual(v.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups, [
      'sg-01def4e5c0fe44d4a',
      { 'Fn::ImportValue': 'Capiro-Preview-Services-Edge-MeriClientSecurityGroupId' },
    ]);
    assert.deepEqual(v.DeploymentConfiguration.DeploymentCircuitBreaker, {
      Enable: true,
      Rollback: true,
    });
  }));
test('standard canonical authentication remains mandatory and background/external actions stay inert', () =>
  render((s) => {
    const e = Object.fromEntries(
      s.Resources.ServeTaskF1990141.Properties.ContainerDefinitions[0].Environment.map((x: any) => [
        x.Name,
        x.Value,
      ]),
    );
    assert.equal(e.CORE_DEPLOYMENT_PROFILE, 'standard');
    assert.equal(e.NODE_ENV, 'production');
    assert.equal(e.MERI_TOOLS_REQUIRE_SERVICE_SECRET, 'true');
    assert.equal(e.PREVIEW_NATIVE_GETS_ENABLED, 'true');
    for (const n of [
      'MERI_TOOL_ALLOWLIST',
      'MERI_EXECUTION_MAX_TURNS',
      'MERI_ROUTINE_MAX_COST_MICROUSD',
      'RETAINED_READS_ENABLED',
    ])
      assert.equal(e[n], undefined);
    for (const n of [
      'ENGAGEMENT_CALLBACKS_ENABLED',
      'ENGAGEMENT_RECALL_WEBHOOK_ENABLED',
      'CLIENT_PROFILE_FILL_WORKER_ENABLED',
      'CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED',
      'MERI_JOB_SWEEPER_ENABLED',
      'RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED',
      'NEWSLETTER_REVIEW_EMAIL_ENABLED',
      'NEWSLETTER_INVITATION_EMAIL_ENABLED',
    ])
      assert.equal(e[n], 'false');
    assert.equal(e.ENGAGEMENT_BACKGROUND_OWNER, 'disabled');
    assert.equal(e.ENGAGEMENT_EXTERNAL_ACTIONS, 'disabled');
    assert.equal(e.ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED, undefined);
    assert.equal(e.MEMORY_GOVERNANCE_LIFECYCLE, 'enforce');
    assert.equal(e.MEMORY_GOVERNANCE_TENANTS, binding.ownerMemory.tenantId);
    for (const name of [
      'MEMORY_GOVERNANCE_ENFORCE',
      'MEMORY_GOVERNANCE_CENTER',
      'MEMORY_CLIENT_REVIEW',
    ])
      assert.equal(e[name], undefined);
  }));
test('ordinary Files receives only approved tenant engagement keys and the S3-scoped assets key', () =>
  render((s, _g, a) => {
    const env = Object.fromEntries(
      s.Resources.ServeTaskF1990141.Properties.ContainerDefinitions[0].Environment.map(
        (entry: any) => [entry.Name, entry.Value],
      ),
    );
    const bucketId = Object.keys(a.Resources).find(
      (id) => a.Resources[id].Type === 'AWS::S3::Bucket',
    );
    const keyId = Object.keys(a.Resources).find((id) => a.Resources[id].Type === 'AWS::KMS::Key');
    const bucketExport = Object.values(a.Outputs).find(
      (o: any) => o.Export && o.Value.Ref === bucketId,
    ) as any;
    const keyExport = Object.values(a.Outputs).find(
      (o: any) => o.Export && o.Value['Fn::GetAtt']?.[0] === keyId,
    ) as any;
    const bucketArnExport = Object.values(a.Outputs).find(
      (o: any) => o.Export && o.Value['Fn::GetAtt']?.[0] === bucketId,
    ) as any;
    assert.ok(bucketExport, 'Core must reference the canonical bucket name');
    assert.ok(keyExport, 'Core must reference the canonical assets key');
    assert.ok(bucketArnExport, 'Core must reference the canonical bucket ARN');
    assert.deepEqual(env.ASSETS_BUCKET, { 'Fn::ImportValue': bucketExport.Export.Name });
    const policies = Object.values(s.Resources).filter(
      (r: any) =>
        r.Type === 'AWS::IAM::Policy' &&
        r.Properties.Roles.some((role: any) => role.Ref === 'ServeTaskTaskRoleD6B44EC7'),
    ) as any[];
    assert.equal(policies.length, 1);
    assert.ok(
      s.Resources.HeldCoreServiceA6CD0E1D.DependsOn.includes(
        'ServeTaskTaskRoleDefaultPolicy46D4ED77',
      ),
    );
    const statements = policies[0].Properties.PolicyDocument.Statement;
    assert.equal(statements.length, 3);
    assert.deepEqual(statements[0], {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: binding.assets.tenantIds.map((id) => ({
        'Fn::Join': [
          '',
          [{ 'Fn::ImportValue': bucketArnExport.Export.Name }, `/tenants/${id}/engagement/*`],
        ],
      })),
    });
    assert.deepEqual(statements[1], {
      Effect: 'Allow',
      Action: 's3:ListBucket',
      Resource: { 'Fn::ImportValue': bucketArnExport.Export.Name },
      Condition: {
        StringLike: {
          's3:prefix': binding.assets.tenantIds.map((id) => `tenants/${id}/engagement/*`),
        },
      },
    });
    assert.deepEqual(statements[2], {
      Effect: 'Allow',
      Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
      Resource: { 'Fn::ImportValue': keyExport.Export.Name },
      Condition: { StringEquals: { 'kms:ViaService': 's3.us-east-1.amazonaws.com' } },
    });
    const execution = JSON.stringify(s.Resources.ServeExecutionRoleDefaultPolicyBD488DD2);
    assert.equal(execution.includes('s3:'), false);
    assert.equal(execution.includes(keyExport.Export.Name), false);
  }));
test('canonical Assets remain private, encrypted, retained, versioned and limited to the preview browser origin', () =>
  render((_s, _g, a) => {
    const resources = Object.values(a.Resources) as any[];
    assert.deepEqual(resources.map((r) => r.Type).sort(), [
      'AWS::KMS::Alias',
      'AWS::KMS::Key',
      'AWS::S3::Bucket',
      'AWS::S3::BucketPolicy',
    ]);
    const bucket = resources.find((r) => r.Type === 'AWS::S3::Bucket');
    const key = resources.find((r) => r.Type === 'AWS::KMS::Key');
    assert.equal(bucket.Properties.BucketName, 'capiro-preview-tenant-assets-967807252336');
    assert.equal(bucket.DeletionPolicy, 'Retain');
    assert.equal(bucket.UpdateReplacePolicy, 'Retain');
    assert.equal(key.DeletionPolicy, 'Retain');
    assert.equal(key.UpdateReplacePolicy, 'Retain');
    assert.equal(key.Properties.EnableKeyRotation, true);
    assert.equal(
      resources.find((r) => r.Type === 'AWS::KMS::Alias').Properties.AliasName,
      'alias/capiro/preview/assets',
    );
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    assert.deepEqual(bucket.Properties.VersioningConfiguration, { Status: 'Enabled' });
    const encryption = bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0];
    assert.equal(encryption.BucketKeyEnabled, true);
    assert.equal(encryption.ServerSideEncryptionByDefault.SSEAlgorithm, 'aws:kms');
    assert.deepEqual(bucket.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins, [
      'https://portfolio-preview.app.capiro.ai',
    ]);
    assert.deepEqual(bucket.Properties.CorsConfiguration.CorsRules[0].AllowedMethods, [
      'PUT',
      'POST',
      'GET',
      'HEAD',
    ]);
    const policy = resources.find((r) => r.Type === 'AWS::S3::BucketPolicy').Properties
      .PolicyDocument.Statement;
    assert.equal(policy.length, 1);
    assert.equal(policy[0].Effect, 'Deny');
    assert.deepEqual(policy[0].Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  }));
test('bounded P1 POST and unchanged P2 GET/HEAD fit ALB and leave Strategy P3 alone', () =>
  render((s) => {
    const p = s.Resources.FirstChatPostsOnly.Properties,
      r = s.Resources.FirstChatMembershipPostOnly.Properties;
    assert.equal(p.Priority, 1);
    assert.equal(r.Priority, 2);
    assert.deepEqual(p.Conditions, [
      { Field: 'host-header', HostHeaderConfig: { Values: [FIRST_CHAT_CORE_HOST] } },
      {
        Field: 'path-pattern',
        PathPatternConfig: { RegexValues: [...FIRST_CHAT_CORE_POST_PATHS] },
      },
      { Field: 'http-request-method', HttpRequestMethodConfig: { Values: ['POST'] } },
    ]);
    assert.equal(FIRST_CHAT_CORE_POST_PATHS.length + 2, 4);
    assert.ok(FIRST_CHAT_CORE_POST_PATHS.every((p) => p.length <= 128));
    assert.deepEqual(r.Conditions, [
      { Field: 'host-header', HostHeaderConfig: { Values: [FIRST_CHAT_CORE_HOST] } },
      { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } },
      { Field: 'http-request-method', HttpRequestMethodConfig: { Values: ['GET', 'HEAD'] } },
    ]);
  }));
test('independent priority7 host guard, export and retained log survive rollback', () =>
  render((s, g) => {
    const r = g.Resources.RejectOtherPreviewHostTraffic;
    assert.equal(r.Properties.Priority, 7);
    assert.deepEqual(r.Properties.Conditions, [
      { Field: 'host-header', HostHeaderConfig: { Values: [FIRST_CHAT_CORE_HOST] } },
    ]);
    assert.equal(r.Properties.Actions[0].FixedResponseConfig.StatusCode, '404');
    assert.equal(r.DeletionPolicy, 'Retain');
    assert.equal(r.UpdateReplacePolicy, 'Retain');
    assert.equal(g.Outputs.PreviewHostGuardRuleArn.Export.Name, FIRST_CHAT_CORE_GUARD_RULE_EXPORT);
    assert.deepEqual(s.Outputs.RequiredPreviewHostGuardRuleArn.Value, {
      'Fn::ImportValue': FIRST_CHAT_CORE_GUARD_RULE_EXPORT,
    });
    assert.equal(s.Resources.ServeLogBCB89CA4.DeletionPolicy, 'Retain');
  }));
