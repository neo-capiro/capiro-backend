# Web vNext — os.capiro.ai operator runbook

This runbook covers the isolated Capiro web-vNext presentation surface at `os.capiro.ai`.

## Safety boundary

`os.capiro.ai` is an additive frontend-only surface. It shares the canonical API, Aurora database, Clerk environment, Workspace backend, Meri backend, Strategy backend and business data.

Do **not** create or deploy a second API, database, auth system, Workspace/Meri/Strategy backend, Prisma schema or duplicate client/program/engagement model.

The standalone WebVNext CDK app imports the existing network, ECS cluster, service security group, HTTPS listener, Clerk public-key secret and dedicated web-vNext ECR repository. It creates/owns only the isolated web-vNext task/service, target group, listener rule and logs required by the presentation surface.

The existing production-facing `env=dev` compute stack has historical/manual drift. For this vNext path:

- never deploy `Capiro-dev-Compute` as part of a web-vNext release;
- never use a broad `cdk deploy --all` command;
- never deploy the canonical `capiro-dev-web` service to publish vNext;
- never change `app.capiro.ai` DNS/routing as part of a vNext deploy;
- preserve the existing backend path rules (`/api/*`, `/health`, `/workspace-api/*`, `/meri*`, `/strategy-api/*`) ahead of the web host rule.

## Runtime identity

The vNext ECS task must inject:

```text
WEB_SURFACE=vnext
CAPIRO_WEB_RELEASE_SHA=<exact 40-character git SHA>
```

`apps/web/nginx/entrypoint.sh` writes those values into `/runtime-config.js` as:

```text
webSurface: 'vnext'
releaseSha: '<exact deployed SHA>'
```

Do not add `WEB_SURFACE=vnext` to the canonical web task. Production surface selection is runtime-config based, not hostname based.

## Release preparation

Use the exact reviewed commit SHA. Do not deploy a floating working tree or a mutable source ref.

Build the web image for the ECS runtime architecture used by the existing WebVNext service (ARM64 in the standalone stack), tag it with the exact SHA, push it to the dedicated repository `capiro/dev/web-vnext`, and resolve the pushed image to its immutable `sha256:` digest.

Record all three values in the deployment handoff:

```text
RELEASE_SHA=<40-char git SHA>
IMAGE_TAG=<same SHA or approved immutable release tag>
IMAGE_DIGEST=sha256:<64 hex chars>
```

Do not deploy by mutable `latest` alone.

## Standalone CDK commands

From the repository root, with the normal CDK environment/account credentials available:

```bash
pnpm --filter @capiro/infra-cdk typecheck
pnpm --filter @capiro/infra-cdk synth:web-vnext -- \
  -c env=dev \
  -c releaseSha="$RELEASE_SHA" \
  -c webVnextImageDigest="$IMAGE_DIGEST" \
  -c existingVpcId="$EXISTING_VPC_ID" \
  -c existingPrivateSubnetIds="$EXISTING_PRIVATE_SUBNET_IDS" \
  -c existingPrivateSubnetAzs="$EXISTING_PRIVATE_SUBNET_AZS" \
  -c existingServiceSecurityGroupId="$EXISTING_SERVICE_SG_ID" \
  -c existingHttpsListenerArn="$EXISTING_HTTPS_LISTENER_ARN" \
  -c webVnextCertificateArn="$WEB_VNEXT_CERTIFICATE_ARN" \
  -c existingClerkPublishableKeyArn="$EXISTING_CLERK_PUBLISHABLE_KEY_ARN" \
  -c existingSecretsKeyArn="$EXISTING_SECRETS_KEY_ARN" \
  -c webVnextListenerPriority="$WEB_VNEXT_LISTENER_PRIORITY"
```

Use the same context for `diff:web-vnext`. Inspect the diff before deployment. It must be limited to the standalone WebVNext stack and must not propose replacements/deletions of canonical API/database/auth resources.

Only after the diff is clean:

```bash
pnpm --filter @capiro/infra-cdk deploy:web-vnext -- <same context>
```

The standalone app requires `releaseSha` to be exactly 40 hexadecimal characters and `webVnextImageDigest` to be an immutable SHA-256 digest. The hostname is fixed to `os.capiro.ai`; the listener priority must remain below the web host catch-all in precedence terms and, by code contract, greater than 20 so established backend path rules retain precedence.

## Post-deploy verification

Do not call the release complete until all of the following are recorded for the exact deployed SHA.

### 1. Service health

```text
https://os.capiro.ai/healthz  -> 200 from the web container
https://os.capiro.ai/health   -> canonical API health response
```

### 2. Runtime config identity

Inspect:

```text
https://os.capiro.ai/runtime-config.js
```

It must report:

```text
webSurface: 'vnext'
releaseSha: '<exact RELEASE_SHA>'
```

A missing/blank `webSurface`, a mismatched release SHA, or hostname-based selection is a failed deployment.

### 3. vNext presentation selection

Sign in to `os.capiro.ai` and verify that the authenticated presentation root has `data-web-surface="vnext"`. Existing data, routes, permissions, billing gates, Workspace, Strategies and Meri behavior should continue through the shared application/business layer.

### 4. Canonical isolation

Open `app.capiro.ai` independently and confirm:

- the existing canonical application still renders;
- its runtime config does not identify itself as `vnext`;
- vNext CSS is not eagerly loaded/applied to the canonical presentation;
- normal auth, tenant, routing and data behavior is unchanged.

A change to the canonical presentation is a release blocker and should be rolled back before further page implementation.

## Foundation visual regression

The foundation owns only two browser-test subjects:

1. the vNext component workshop;
2. the empty vNext shell scaffold.

Run the visual capture instructions in `apps/web/src/vnext/testing/visual/README.md`. Do not baseline Dashboard, Program Elements, Client Profile, Engagement Manager or any other product screen until that screen is explicitly implemented from its canonical Figma node.

## Rollback

Rollback means redeploying the last known-good immutable WebVNext image digest to the standalone WebVNext service/stack. Do not solve a vNext regression by modifying the canonical web service, API, database or authentication system.

After rollback, repeat `/healthz`, `/health`, runtime-config identity and canonical-isolation verification.
