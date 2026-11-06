# LegiWatch tracker impact deployment

This change provides source, offline configuration rendering and local tests.
It does not establish a deployed release. No AWS credentials or AWS CLI were
available during implementation; no secret values were fetched, no provider or
Claude calls were made, and no live database or schedule was changed.

Core owns tenant/member/client/wall authorization and durable impact records.
The impact service uses the existing Claude Agent SDK harness. The refresh
worker reevaluates authorized tracked bills when retained source evidence or
client context changes. It does not fetch missing bill text itself. Existing
source jobs remain the owners of metadata, immutable versions and extraction.

## Credential and model bindings

Secrets Manager values stay in ECS `secrets`, never ordinary environment
variables, JSON binding files, logs or source. Resolve existing complete ARNs
from fresh account inventory; do not create replacement secrets or guess ARN
suffixes. The following are exact runtime environment names:

| Environment name | Source binding present in this checkout | Tasks |
| --- | --- | --- |
| `GOVINFO_API_KEY` | `capiro/<env>/govinfo_api_key` | Serving API, ingestion and its existing migration-worker binding |
| `LEGISCAN_API_KEY` | `capiro/<env>/legiscan_api_key` | Serving API and ingestion |
| `CENSUS_API_KEY` | `capiro/<env>/census_api_key` | Ingestion only |
| `CONGRESS_API_KEY` | Explicit `congressApiKeyArn` CDK context or preview binding; the existing FY26 release operator references `capiro/dev/congress_gov_api_key` | Serving API and ingestion |
| `REGULATIONS_GOV_API_KEY` | Explicit `regulationsGovApiKeyArn` CDK context or preview binding; no name is inferred | Serving API and ingestion |
| `ANTHROPIC_API_KEY` | Existing `externalSecretArns.anthropicApiKey` or explicit preview binding | Existing serving consumer; refresh worker only with explicit Anthropic selection |

Federal Register, USAspending and Census Geocoder do not require a key in these
adapters. Census ACS does. The preview renderer omits Census ACS from serving
tasks. Congress and Regulations references are optional for a generic Compute
synthesis and omitted when unset. Do not treat that omission as configured
source coverage. `env=dev` Compute describes the historical production service;
deploying it does not update the dedicated preview Core service.

`LEGIWATCH_AGENT_PROVIDER` accepts `bedrock` or `anthropic`, defaulting to
`bedrock`. `LEGIWATCH_AGENT_MODEL` selects the reviewed provider model. The
Bedrock impact path can use the existing `PORTFOLIO_AGENT_MODEL`; Anthropic
requires an explicit LegiWatch model and injected key. No new model ID is
assumed. The unattended refresh CLI requires explicit provider and model even
for Bedrock. Other Portfolio agents retain their existing provider default.

| Runtime bound | Default | Allowed range |
| --- | ---: | ---: |
| `LEGIWATCH_AGENT_TIMEOUT_MS` | 90,000 | 1,000–120,000 |
| `LEGIWATCH_AGENT_MAX_TURNS` | 4 | 1–8 |
| `LEGIWATCH_AGENT_MAX_BUDGET_USD` | 0.50 | 0.03–2.00 |
| `LEGIWATCH_IMPACT_REFRESH_TIMEOUT_MS` | 240,000 | 60,000–900,000 |

The extraction and review stages share the configured aggregate impact budget.
The refresh CLI also requires its cycle timeout to be at least the configured
agent timeout plus 120,000 ms for discovery, authorization and persistence.
The proposed refresh cycle runs every 15 minutes with `--limit 10` and
`--discovery-limit 100`. Changed analyses can make paid model calls; local tests
do not establish quota, provider availability, spend or answer quality.

## Render the preview task overlays

Use the existing `infra/cdk/bin/preview-first-chat-core.ts` entrypoint:

```sh
npx --yes pnpm@9.12.0 --filter @capiro/infra-cdk exec ts-node bin/preview-first-chat-core.ts --render-legiwatch "$BINDING" "$OVERLAY"
```

Both paths must be absolute. The output must be a fresh `.json` file. Exit 0
means rendered; exit 2 means invalid arguments, binding or output. This command
makes no AWS calls. The binding has exactly these fields:

* `provider`: `bedrock` or `anthropic`.
* `model`: the explicit reviewed model identifier.
* `secretArns`: complete same-account, same-region ARNs keyed by the five source
  environment names above, plus `ANTHROPIC_API_KEY` for Anthropic. There is no
  plaintext-key or inferred-name alternative.
* `kmsKeyArns`: distinct customer-managed key ARNs needed by these secrets,
  or an explicit empty array when none are needed.
* Optional `refresh`: the schedule binding described below.

The result contains separate `serve` and `syncWorker` overlays with environment,
secret references and execution-role grants. Merge by environment/secret name
onto freshly inspected task definitions; preserve unrelated configuration.
Keep existing database/Clerk secrets and execution-role ECR/logs/KMS grants.
The serving task keeps its image, resource settings, command, database and
service topology until the separately qualified release updates its image.

Register a dedicated `capiro-preview-legiwatch-impact` worker from the reviewed
preview API image and existing application database role. Keep ARM64 Linux,
Fargate `awsvpc`, 512 CPU and 1,024 MiB, one essential container and the image's
entrypoint. Pin its image to the qualified `capiro/preview-core@sha256:…` digest,
set `RELEASE_SHA`, and apply the `syncWorker` overlay. Its ordinary environment
must set `DB_HOST` to the existing preview clone, `DB_NAME=capiro`,
`DB_PORT=5432`; `DB_USER`/`DB_PASSWORD` must reference the existing application
secret's `username`/`password` fields. Do not inject another `DATABASE_URL` or
override these checked settings through secrets.

Keep the task IAM permission for the selected Bedrock model when using Bedrock.
The Anthropic SDK child receives its task-injected key through its explicit
provider configuration. The ECS execution role needs the rendered source-key
grants, the existing application DB-secret grant and any required KMS decrypt
grants. Verify the application database role can read client/profile/evidence
tables and read/write the impact/refresh tables after their forward migrations.
Task IAM is not a substitute for these database grants or Core authorization.

## Render and activate the bounded refresh schedule

The optional `refresh` binding contains exactly:

* `taskDefinition`: the inner `taskDefinition` object from a fresh ECS describe
  of the registered dedicated worker, including environment and secret ARN
  references but never resolved values.
* `sourceHead` and `imageDigest`: the independently qualified commit and digest.
* `clusterArn`: the existing `capiro-dev` cluster ARN.
* `invocationRoleArn`: an inspected EventBridge invocation role in this account.
* `subnetIds` and `securityGroupIds`: the inspected preview private network.

The renderer checks task family/account/region, exact image/source pins,
ARM64/resource bounds, provider/model/credential parity and clone DB metadata.
It cannot verify private routing, actual IAM policies, database grants, image
qualification or current AWS state offline. The schedule payload is deliberately
separate from the historical `INGESTION_JOBS` matrix, which can target production.

The output `refresh` object has complete AWS API request bodies:

| JSON field | AWS CLI operation |
| --- | --- |
| `putInvocationRolePolicyRequest` | `iam put-role-policy` |
| `runTaskRequest` | `ecs run-task` |
| `putRuleRequest` | `events put-rule` (creates the rule disabled) |
| `putTargetsRequest` | `events put-targets` |
| `enableRuleRequest` | `events enable-rule` |
| `disableRuleRequest` | `events disable-rule` |

Each body can be extracted to a file and passed as `--cli-input-json file://…`
with AWS profile `default`, region `us-east-1`, after verifying caller account
`967807252336`. EventBridge retries are disabled; the next bounded cycle owns
recovery through the durable refresh queue. The invocation policy permits only
the exact task definition and the two exact task roles. Verify its trust policy
allows `events.amazonaws.com` for this rule and preserve any unrelated grants.

Root's release sequence is: acquire the preview release lock; qualify the exact
ARM64 image and scan; snapshot the persistent clone; apply forward migrations;
verify actual DB grants; register the reviewed task; render from its fresh
describe; apply scoped execution/invocation role grants; run the exact canary;
inspect container exit, processed/failed counts and persisted results; create
the disabled rule and target; check `FailedEntryCount=0` and full readback;
enable only after successful canary; observe a later timer-triggered run.
Preserve the pre-change task/rule/role snapshot for rollback. Disable this exact
rule to pause refresh. Do not modify existing live rules or the source job quota.

Deploy the corresponding Core and retained Intel serving changes after the
forward migrations. Verify the new tracker/detail endpoints and retained owner
access checks before deploying the companion frontend. Its shared tracker
requires the new Core contract; an independent frontend-first rollout is not
compatible. Run the refresh canary and enable its timer only after the serving
pair and source prerequisites pass acceptance.

## Source coverage prerequisites

| Existing owner | Scope and prerequisite |
| --- | --- |
| `sync-federal-bill-inventory` | Congress 119, preview clone only. `--stage refresh` uses bounded known-parent refresh with `--limit` and `--request-cap`; initial inventory requires eight exact archive hashes and the frozen amendment manifest. Metadata/inventory/refresh require Congress credentials. |
| `sync-federal-legislative-evidence` | Existing FY26 federal-text operator uses `BILLS`, Congress 119, `--full --historical --cap 400`; other evidence collection rules remain dark under their separate qualification gates. |
| `sync-legiscan-masterlist` / `sync-legiscan-bills` | Existing scoped source jobs own known-parent changes. Wide FY26 refresh requires retained discovery/session receipts and explicit existing wide/dataset-refresh options; no new allowance is implied. |
| `sync-state-text-drain` | Explicit states and 1–1,000 document cap, existing clone guard. Publisher-first exact-version hydration; `--publisher-only` forbids LegiScan fallback. Retained metadata is required. |
| `embed-bill-passages` | FY26 federal/state retained texts; run `--phase extract` before model analysis needs structured text, then embedding as separately qualified. Optional state filters preserve separate checkpoints. |

The historical FY26 operator owns three existing hourly targets: federal text
at `:00`, federal passages at `:10`, and state passages at `:20`. Its inspection,
canary and replacement rules remain in [fy26-bill-ingestion.md](fy26-bill-ingestion.md).
The runbook records a November LegiScan capacity hold; inspect the current
checkpoint/account allowance before enabling any API fallback. Publisher-only
work and retained extraction do not remove that hold. No initial archive import,
all-state API backfill, allowance increase or dark collection activation is
performed by this change. Missing evidence must remain visible as a gap.

## Local qualification and remaining acceptance

The source review covered both repositories, the frozen public contract and
the retained tracker authorization repairs. Core's combined focused suite passed
152 tests; retained Intel tracker checks passed 49 tests. PostgreSQL 16.15 ran
the four source SQL tests without skips and applied both new migrations unchanged.
Thirteen synthetic migration verification groups checked grants, forced RLS,
tenant isolation, walls/revocation, authorized CRUD and constraints. The two
migration SHA-256 values are `73ff3f32467568aa32932c09a000245e4e997f1bac074ed2b4460292e5138442`
and `0f902788d87dce24d3d9b47748cd7efd6a804490b6fdd0d955b62908d2f741f9`.
Synthetic schemas and roles were removed and the local database server stopped.

Frontend typecheck and production build passed, along with 91 focused tests,
34 architecture tests, scoped lint/format checks and nine public-package tests.
Its architecture scan retains the same 29 existing errors as its base; no new
task boundary error was introduced. CDK typecheck, 30 compute/schedule tests
and 32 preview-renderer tests passed. The three new API configuration tests
passed; the existing engagement-owner configuration assertion also fails on
the untouched backend base.

Core and Intel production builds passed, and Intel typecheck passed. Core's
broad typecheck has five diagnostics in three existing profile test
files, reproduced identically on base `6d3250053aa6e3748d3440f5838c3b0446826d52`;
later configurations in that chained command are not reached. The configured
API lint command cannot execute because the installed dependency graph has no
ESLint executable. These failures were preserved rather than weakening checks.
The full historical Bill360 PostgreSQL migration-chain suite was not run;
the new isolated SQL checks use minimal synthetic dependencies. Browser tests
could not launch Chromium in this executor, so rendered interaction is unverified.

Source and synthetic tests are not live acceptance. Remaining release gates
include runtime-closure/image probes and exact-digest scan; snapshot-first clone
migration; fresh secret-reference/KMS/IAM/network inspection; real source
hydration and extraction canaries within provider allowance; an authorized
Claude impact canary and citation review; deployed tenant/client/revocation
negative checks; serving UI/API acceptance; and timer-triggered refresh after
both a source change and a client-profile change. Record results without
credentials or customer-linked identifiers. No claim of production-wide or
all-state refresh is justified until those observations exist.
