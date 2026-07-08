import * as cdk from 'aws-cdk-lib';

export type EnvName = 'dev' | 'staging' | 'prod';

export interface EnvConfig {
  envName: EnvName;
  account: string;
  region: string;
  // DNS
  hostedZoneDomain: string; // Route 53 zone that owns the records.
  rootDomain: string; // capiro.ai (prod) | app-dev.capiro.ai (dev)
  appHost: string; // app.capiro.ai (prod) | app-dev.capiro.ai (dev)
  wildcardHost: string; // *.app.capiro.ai (prod) | *.app-dev.capiro.ai (dev)
  // Clerk JWT issuer URL, injected into the ECS task as CLERK_JWT_ISSUER.
  // Set after creating the Clerk instance for each env. If absent, the API
  // skips issuer validation (acceptable during initial bootstrap only).
  clerkJwtIssuer?: string;
  // Aurora
  auroraMinAcu: number;
  auroraMaxAcu: number;
  auroraBackupRetentionDays: number;
  // ECS service sizing
  apiCpu: number;
  apiMemoryMib: number;
  apiDesiredCount: number;
  apiMaxCount: number;
  webCpu: number;
  webMemoryMib: number;
  webDesiredCount: number;
  webMaxCount: number;
  marketingCpu: number;
  marketingMemoryMib: number;
  marketingDesiredCount: number;
  marketingMaxCount: number;
  workspaceCpu: number;
  workspaceMemoryMib: number;
  workspaceDesiredCount: number;
  workspaceMaxCount: number;
  // MeriV2 orchestrator (Option B strangler-fig service; /meri-api/*).
  meriv2OrchestratorCpu: number;
  meriv2OrchestratorMemoryMib: number;
  meriv2OrchestratorDesiredCount: number;
  meriv2OrchestratorMaxCount: number;
  // Hardening
  protectFromDestroy: boolean; // true for prod, false for dev to allow iteration
  logRetentionDays: number;
  externalSecretArns?: {
    microsoftClientId: string;
    microsoftTenantId: string;
    microsoftCertThumbprint: string;
    microsoftCertPrivateKey: string;
    oauthTokenEncryptionKey: string;
    oauthStateSecret: string;
    openaiApiKey: string;
    anthropicApiKey: string;
    notesEncryptionKey: string;
    samGovApiKey?: string;
    aiCredentialEncryptionKey?: string;
    recallApiKey?: string;
    // Meeting-notetaker webhook signing secret. OPTIONAL AND GATING: the
    // compute stack only wires RECALL_WEBHOOK_SECRET onto the serve task when
    // this ARN is present. The secret is created together with the Recall
    // dashboard webhook endpoint (go-live checklist item E) — wiring a
    // not-yet-existing secret would make every new task fail to start
    // ("unable to pull secrets" → circuit-breaker rollback).
    recallWebhookSecret?: string;
  };
}

const BASE: Omit<EnvConfig, 'envName' | 'account' | 'region'> = {
  hostedZoneDomain: 'capiro.ai',
  rootDomain: 'capiro.ai',
  appHost: 'app.capiro.ai',
  wildcardHost: '*.app.capiro.ai',
  auroraMinAcu: 0.5,
  auroraMaxAcu: 4,
  auroraBackupRetentionDays: 35,
  apiCpu: 512,
  apiMemoryMib: 1024,
  apiDesiredCount: 2,
  apiMaxCount: 6,
  webCpu: 256,
  webMemoryMib: 512,
  webDesiredCount: 2,
  webMaxCount: 4,
  marketingCpu: 256,
  marketingMemoryMib: 512,
  marketingDesiredCount: 2,
  marketingMaxCount: 4,
  workspaceCpu: 256,
  workspaceMemoryMib: 512,
  workspaceDesiredCount: 2,
  workspaceMaxCount: 4,
  meriv2OrchestratorCpu: 256,
  meriv2OrchestratorMemoryMib: 512,
  meriv2OrchestratorDesiredCount: 2,
  meriv2OrchestratorMaxCount: 4,
  protectFromDestroy: false,
  logRetentionDays: 90,
};

export function loadConfig(app: cdk.App): EnvConfig {
  const envName = (app.node.tryGetContext('env') as EnvName | undefined) ?? 'dev';
  if (!['dev', 'staging', 'prod'].includes(envName)) {
    throw new Error(`Unknown env=${envName}`);
  }
  const account =
    (app.node.tryGetContext('account') as string | undefined) ?? process.env.CDK_DEFAULT_ACCOUNT;
  if (!account) {
    throw new Error(
      'AWS account not set. Pass --context account=<id> or export CDK_DEFAULT_ACCOUNT.',
    );
  }
  const region =
    (app.node.tryGetContext('region') as string | undefined) ??
    process.env.CDK_DEFAULT_REGION ??
    'us-east-1';

  const overrides: Partial<EnvConfig> =
    envName === 'prod'
      ? {
          auroraMinAcu: 1,
          auroraMaxAcu: 8,
          apiDesiredCount: 3,
          apiMaxCount: 12,
          webDesiredCount: 2,
          webMaxCount: 6,
          protectFromDestroy: true,
          logRetentionDays: 365,
          clerkJwtIssuer: 'https://clerk.app.capiro.ai',
        }
      : envName === 'staging'
        ? {
            // Staging serves the app at app.staging.capiro.ai and the marketing
            // site at staging.capiro.ai. The base config defaults appHost to
            // `app.capiro.ai` (prod), which makes the API derive a
            // MICROSOFT_REDIRECT_URI pointing at prod and breaks the Microsoft
            // 365 OAuth callback from staging tenants (the callback lands on
            // the wrong stack, hits the wrong Aurora cluster, throws
            // "Record not found" trying to update the IntegrationConnection,
            // and returns 500 to the user). Pin the host explicitly here so
            // every host-derived env var (MICROSOFT_REDIRECT_URI,
            // MICROSOFT_GRAPH_NOTIFICATION_URL, APP_SIGN_IN_URL, WEB_ORIGIN)
            // points at staging's own ALB.
            // staging.capiro.ai is a delegated Route 53 zone in this same
            // account. Point the DNS lookup at it so the A/AAAA records
            // CDK manages for staging land in the delegated zone instead of
            // the parent capiro.ai zone (where they would be shadowed by
            // the NS delegation and silently fail to resolve).
            hostedZoneDomain: 'staging.capiro.ai',
            appHost: 'app.staging.capiro.ai',
            wildcardHost: '*.app.staging.capiro.ai',
            rootDomain: 'staging.capiro.ai',
            protectFromDestroy: true,
          }
        : {
            // Dev/prod account: 967807252336  region: us-east-1
            // Aligned to live production reality (see infra/cdk/DRIFT-FINDINGS.md).
            // The env=dev stacks ARE prod and serve app.capiro.ai / capiro.ai —
            // NOT app-dev.*. appHost + wildcardHost feed WEB_ORIGIN and the
            // invitation redirect (tenant-admin uses WEB_ORIGIN.split(',')[0]);
            // leaving these as app-dev produced invitation links to a dead host,
            // so invited users could never complete sign-up. cdk diff before deploy.
            appHost: 'app.capiro.ai',
            wildcardHost: '*.app.capiro.ai',
            rootDomain: 'capiro.ai',
            // Single replicas for dev, no HA needed.
            apiDesiredCount: 1,
            apiMaxCount: 2,
            webDesiredCount: 1,
            webMaxCount: 2,
            marketingDesiredCount: 1,
            marketingMaxCount: 2,
            workspaceDesiredCount: 1,
            workspaceMaxCount: 2,
            meriv2OrchestratorDesiredCount: 1,
            meriv2OrchestratorMaxCount: 2,
            auroraMinAcu: 0.5,
            auroraMaxAcu: 2,
            auroraBackupRetentionDays: 7,
            // NOTE: the env=dev stacks (cluster `capiro-dev`) ARE the live
            // production deployment serving app.capiro.ai. The running API and
            // the web's pk_live publishable key both use the PROD Clerk instance
            // `clerk.app.capiro.ai`. This issuer MUST match it — pointing it at
            // the throwaway dev instance (stirring-warthog-40.clerk.accounts.dev)
            // would make every live user token fail validation (401 / logged
            // out) on the next `cdk deploy`. Do not change without rotating the
            // web publishable key + API secret to the same instance.
            clerkJwtIssuer: 'https://clerk.app.capiro.ai',
            //
            // Fill in after creating each secret in account 967807252336.
            // Slash-delimited names require complete ARNs; partial ARNs cause
            // ECS task startup failures (ResourceInitializationError).
            // Run for each: aws secretsmanager describe-secret \
            //   --secret-id capiro/dev/<name> --query ARN --output text
            externalSecretArns: {
              microsoftClientId:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/microsoft-client-id-AU8xuO',
              microsoftTenantId:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/microsoft-tenant-id-cC9TIB',
              microsoftCertThumbprint:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/microsoft-cert-thumbprint-gJsG0v',
              microsoftCertPrivateKey:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/microsoft-cert-private-key-rW9ERB',
              oauthTokenEncryptionKey:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/oauth-token-encryption-key-VQCjD8',
              oauthStateSecret:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/oauth-state-secret-XOOzYB',
              openaiApiKey:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/openai-api-key-7nAmib',
              anthropicApiKey:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/anthropic-api-key-3nhKhF',
              notesEncryptionKey:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/notes-encryption-key-Vf2rhI',
              samGovApiKey:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/sam-gov-api-key-0gcMpp',
              aiCredentialEncryptionKey:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/ai-credential-encryption-key-ohnjaH',
              // Meeting notetaker (Recall.ai). Both secrets hold real values and
              // are live on the serve task (wired out-of-band as task-def rev 37,
              // 2026-07-08 — see the go-live checklist item C / drift warning).
              // These entries keep a future CDK reconciliation from dropping them.
              recallApiKey:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/recall-api-key-WDNzEP',
              recallWebhookSecret:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/recall-webhook-secret-FxKv9v',
            },
          };

  return { ...BASE, envName, account, region, ...overrides };
}

export function stackName(envName: EnvName, suffix: string): string {
  return `Capiro-${envName}-${suffix}`;
}

export function awsEnv(cfg: EnvConfig): cdk.Environment {
  return { account: cfg.account, region: cfg.region };
}

export function commonTags(cfg: EnvConfig): Record<string, string> {
  return {
    Project: 'capiro',
    Environment: cfg.envName,
    ManagedBy: 'cdk',
  };
}
