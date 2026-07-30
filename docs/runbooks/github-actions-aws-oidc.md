# GitHub Actions → AWS OIDC deployment roles

Account: `967807252336` · Region: `us-east-1` · Repo: `neo-capiro/capirov2`

## Why this exists

GitHub Actions authenticates to AWS by exchanging a short-lived OIDC token for
STS credentials. There are no long-lived AWS access keys in this repository.

`capiro-dev` **is** Capiro production. `os-capiro` is defunct and the
`capiro-staging` ECS cluster does not exist despite its CloudFormation stack
reporting `CREATE_COMPLETE`. There is therefore no separate dev deploy target,
and no `dev` deploy role.

## Roles

| Role | Assumable from | Can it write? |
| --- | --- | --- |
| `capiro-gha-api` | any branch (`repo:neo-capiro/capirov2:*`) | ECR push only, plus a read-only LegiWatch verify probe. Pre-existing. |
| `CapiroGitHubReadOnlyRole` | any branch (`repo:neo-capiro/capirov2:*`) | No. Explicit `Deny` on `secretsmanager:GetSecretValue`. |
| `CapiroGitHubProductionDeployRole` | **only** `repo:neo-capiro/capirov2:environment:production` | Yes — see below. |
| `capiro-gha-prodos-deployer` | `main` **or** `environment:prod-os-capiro` | CDK bootstrap assume + CFN read. Targets the defunct env; candidate for deletion. |

### The production gate

`CapiroGitHubProductionDeployRole`'s trust policy matches the OIDC `sub` claim
with `StringEquals` on exactly:

```
repo:neo-capiro/capirov2:environment:production
```

Branch is deliberately **not** an alternative. A job cannot obtain these
credentials unless it declares `environment: production`, which routes it
through the GitHub environment's protection rules. Compare
`capiro-gha-prodos-deployer`, which OR-matches `ref:refs/heads/main` — that
lets any workflow on `main` bypass its environment gate entirely.

### What the production role can do

- **ECR**: push/pull the nine `capiro/dev/*` repos and the CDK container-assets repo. Cannot touch `capiro/prod-os-capiro/*`.
- **ECS**: `RegisterTaskDefinition` (no resource-level support in the API, so `*`), and `UpdateService` on exactly the nine `capiro-dev` services. Cannot update anything in `capiro-prod-os-capiro`.
- **ECS RunTask**: only these seven task-definition families, and only on the `capiro-dev` cluster:
  `capiro-dev-api-migrate`, `capiro-dev-intel-api-migrate`,
  `capiro-dev-api-strategy-migrate`, `capiro-dev-onboard-api-migrate`,
  `capiro-dev-workspace-migrate`, `capiro-dev-api-diag`,
  `capiro-dev-api-db-inspect`.
  Destructive one-offs such as `capiro-dev-api-sql-exec` and
  `capiro-dev-api-junk-delete` are **not** included.
- **PassRole**: only the eight `capiro-dev` task/execution roles, and only when
  `iam:PassedToService` is `ecs-tasks.amazonaws.com`.
- **CloudFormation / CDK**: assume the four `cdk-hnb659fds-*` bootstrap roles,
  and full CFN change-set/update. See the warning below.
- **Logs**: read `/capiro/*` only.
- **Secrets**: `GetSecretValue` on `capiro/dev/deploy/*` only. An explicit
  `Deny` with `NotResource` blocks every other secret, including
  `capiro/dev/aurora/master` and `capiro/dev/anthropic-api-key`. No secret
  under that prefix exists yet — the grant is forward-looking.
- **No IAM writes. No RDS writes.**

## ⚠️ CDK deploy is a live outage risk

The production role can assume the CDK bootstrap roles, which means CI is
capable of running `cdk deploy Capiro-dev-Compute`.

**Do not deploy that stack.** Its CloudFormation template holds values for an
ALB that no longer exists. A deploy that fails and rolls back reverts
production DNS — this has already caused a ~7 minute outage. This risk was
raised and accepted when the role was created; there is no stack-level `Deny`
guarding it.

Routine image rollouts do not need CDK at all: build → push to ECR →
`RegisterTaskDefinition` → `UpdateService`.

## Repository variables

| Variable | Value |
| --- | --- |
| `AWS_READONLY_GHA_ROLE_ARN` | `arn:aws:iam::967807252336:role/CapiroGitHubReadOnlyRole` |
| `AWS_PROD_GHA_ROLE_ARN` | `arn:aws:iam::967807252336:role/CapiroGitHubProductionDeployRole` |
| `AWS_DEV_GHA_ROLE_ARN` | `arn:aws:iam::967807252336:role/capiro-gha-api` |
| `AWS_GHA_ROLE_ARN` | `arn:aws:iam::967807252336:role/capiro-gha-api` (legacy alias) |

## Workflow usage

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production        # REQUIRED — the AWS trust policy checks for this
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_PROD_GHA_ROLE_ARN }}
          aws-region: us-east-1
      - run: aws sts get-caller-identity
```

Removing or renaming `environment: production` does not merely skip the
approval — it makes the AWS role unassumable, and the job fails at the
credentials step.

## The `production` environment

Created and configured. Current state:

| Setting | Value |
| --- | --- |
| `deployment_branch_policy` | `custom_branch_policies: true` |
| allowed branches | `main` only |
| protection rules | `branch_policy` |
| required reviewers | **absent** — see below |
| `can_admins_bypass` | `true` |

So a production deploy requires **both** that the job declares
`environment: production` (enforced by the AWS trust policy) **and** that it
runs on `main` (enforced by the environment's branch policy).

Read it back with:

```bash
gh api repos/neo-capiro/capirov2/environments/production \
  --jq '{name,deployment_branch_policy,rules:[.protection_rules[].type]}'
gh api repos/neo-capiro/capirov2/environments/production/deployment-branch-policies \
  --jq '.branch_policies[]|{name,type}'
```

> **`gh api` gotcha:** use `-F` (typed) not `-f` (string) for the nested
> booleans. With `-f`, GitHub rejects them as `not of type boolean`; passing the
> body via `--input` can silently return
> `deployment_branch_policy: null` — the environment is created but
> *unrestricted*. Always read the config back rather than trusting the write.
>
> Note that `custom_branch_policies: true` with **zero** branch entries allows
> **nothing** to deploy. The `main` entry must exist.

## Open item: required reviewers

The `production` environment protection rule **"required reviewers"** is not
configured. The GitHub API rejects it on this repository:

> Failed to create the environment protection rule. Please ensure the billing
> plan supports the required reviewers protection rule. (HTTP 422)

`capirov2` is a **private** repo on a **free** personal plan. Required
reviewers — and `main` branch protection generally — need GitHub Pro or higher.
Until that is resolved:

- The OIDC `sub` gate holds: only a job declaring `environment: production` can assume the deploy role.
- The environment branch policy holds: only `main` can deploy.
- But there is **no human approval click** before a production deploy, and
  because `main` itself has no branch protection, a direct push to `main` is
  enough to reach the deploy role.

To close the gap, upgrade to GitHub Pro, then:

```bash
gh api -X PUT repos/neo-capiro/capirov2/environments/production \
  --input - <<'JSON'
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "reviewers": [{"type": "User", "id": 276034435}],
  "deployment_branch_policy": {"protected_branches": true, "custom_branch_policies": false}
}
JSON
```

`prevent_self_review` must stay `false` while there is a single maintainer,
otherwise no deployment can ever be approved.

## Verifying

`.github/workflows/oidc-verify.yml` (`workflow_dispatch`) asserts both the
positive and negative permissions of each role. The `deploy` job only runs when
dispatched with `check_deploy_role: true`, and requires the `production`
environment to exist.

To re-check the policies without running CI:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::967807252336:role/CapiroGitHubProductionDeployRole \
  --action-names ecs:UpdateService \
  --resource-arns arn:aws:ecs:us-east-1:967807252336:service/capiro-dev/capiro-dev-api \
  --profile capiro-dev
```

Note that `simulate-*` reports `implicitDeny` for `logs:GetLogEvents` when
given a *log-stream* ARN, even for `Resource: "*"`. That is a simulator
artifact — the action's resource type is `log-group`. Pass the log-group ARN.
