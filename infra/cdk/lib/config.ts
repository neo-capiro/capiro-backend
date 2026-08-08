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
  // Strategy Planner API (separate service; /strategy-api/*). Ships dark
  // behind per-tenant flags; owns the sp_* tables in the shared Aurora.
  apiStrategyCpu: number;
  apiStrategyMemoryMib: number;
  apiStrategyDesiredCount: number;
  apiStrategyMaxCount: number;
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
    // Google Workspace OAuth (capiro-gmail-integration GCP project). Live on
    // capiro-dev-api:59 and capiro-dev-onboard-api:4 OUT-OF-BAND since the Gmail
    // Phase-1 rollout; codified here so a future reconciliation cannot drop them
    // and flip GoogleOAuthService.capabilities().configured to false. NOTE the
    // secret names are UPPER_SNAKE (capiro/dev/GOOGLE_CLIENT_ID), unlike every
    // microsoft-* secret which is lower-kebab.
    googleClientId?: string;
    googleClientSecret?: string;
    // MakeGov/Tango (Funding Opportunities P16). OPTIONAL AND GATING, same
    // pattern as recallWebhookSecret above: compute-stack only wires
    // TANGO_API_KEY onto the ephemeral sync-job task definition when this ARN
    // is present, and onto NO other task (serve/web/workspace/migrate/Meri).
    // The secret is a top-level name — "tango", not "capiro/dev/tango-api-key"
    // — because that is the name it was actually created under; see the
    // comment on the dev entry below for the exact provenance.
    tangoApiKey?: string;
    // MakeGov/Tango WEBHOOK signing secret (Funding Opportunities P46).
    // OPTIONAL AND GATING, same pattern as the two above.
    //
    // A DIFFERENT CREDENTIAL FROM tangoApiKey, and it goes to the opposite
    // task. `tangoApiKey` is OUTBOUND (Capiro calling MakeGov) and is wired
    // only onto the ephemeral sync task; this one is INBOUND (MakeGov calling
    // Capiro) and is wired only onto API serve, because the serve task is the
    // only one that hosts an HTTP listener. No task ever holds both.
    //
    // Created together with the provider-side webhook endpoint, which is P50's
    // operator step — until then this stays unset and the receiver runs dark,
    // rejecting every delivery. Wiring a not-yet-existing secret would make
    // every new serve task fail to start ("unable to pull secrets" →
    // circuit-breaker rollback), which is exactly why this is ARN-gated.
    tangoWebhookSecret?: string;
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
  apiStrategyCpu: 256,
  apiStrategyMemoryMib: 512,
  apiStrategyDesiredCount: 2,
  apiStrategyMaxCount: 4,
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
            // Staging was the ONLY environment with no clerkJwtIssuer in CDK,
            // so compute-stack's `...(cfg.clerkJwtIssuer ? {...} : {})` spread
            // omitted the var entirely and nothing was pinned.
            //
            // This is deliberately NOT the prod issuer: staging authenticates
            // against its OWN Clerk instance. The value is taken from the live
            // staging task definition (the tracked staging-api-td.json snapshot
            // at the repo root sets CLERK_JWT_ISSUER to exactly this), not
            // assumed. The dev/prod block below warns against this instance for
            // dev/prod — where the pk_live key belongs to clerk.app.capiro.ai —
            // but for staging it is the correct one.
            clerkJwtIssuer: 'https://stirring-warthog-40.clerk.accounts.dev',
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
            apiStrategyDesiredCount: 1,
            apiStrategyMaxCount: 2,
            // Aligned to LIVE reality (verified 2026-07-17: MinACU 0.5 / MaxACU 4 /
            // 35-day backup) so a post-unstick `cdk diff` does NOT shrink Aurora or
            // cut backup retention (a SOC2 concern). See DRIFT-FINDINGS.md Step C.
            auroraMinAcu: 0.5,
            auroraMaxAcu: 4,
            auroraBackupRetentionDays: 35,
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
              googleClientId:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/GOOGLE_CLIENT_ID-Y59j1r',
              googleClientSecret:
                'arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/GOOGLE_CLIENT_SECRET-EBWpbt',
              // MakeGov/Tango API key (Funding Opportunities P16). Created
              // 2026-08-06 via the console/CLI as a TOP-LEVEL secret named
              // "tango" (not under the capiro/dev/ prefix other entries use —
              // that naming is this secret's actual provenance, not a
              // convention break to fix). Complete ARN, so no
              // ResourceInitializationError risk from a partial one:
              //   aws secretsmanager describe-secret --secret-id tango \
              //     --profile capiro-dev --region us-east-1 --query ARN --output text
              // Wiring this ARN does NOT itself deploy or grant anything live —
              // it only takes effect on the next `cdk deploy`, which P16's own
              // plan text defers until P17 is ready to use the key.
              tangoApiKey: 'arn:aws:secretsmanager:us-east-1:967807252336:secret:tango-c0YGNk',
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
