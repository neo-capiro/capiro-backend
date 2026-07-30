# GitHub OIDC IAM policy documents

Source of truth for the two GitHub Actions OIDC roles in account
`967807252336`. These were applied with the AWS CLI, **not** CDK — they are not
part of any CloudFormation stack, so this directory is the only record of their
intended contents.

See `docs/runbooks/github-actions-aws-oidc.md` for the rationale, the accepted
CDK outage risk, and the outstanding required-reviewers gap.

## Files

| File | Applied as |
| --- | --- |
| `trust-readonly.json` | trust policy of `CapiroGitHubReadOnlyRole` |
| `perm-readonly.json` | inline policy `readonly-inspect` |
| `trust-proddeploy.json` | trust policy of `CapiroGitHubProductionDeployRole` |
| `perm-deploy-ecr-s3.json` | inline policy `deploy-ecr-and-s3` |
| `perm-deploy-ecs.json` | inline policy `deploy-ecs` |
| `perm-deploy-cdk.json` | inline policy `deploy-cdk-cloudformation` |
| `perm-deploy-observability.json` | inline policy `deploy-observability-and-secrets` |

## Re-apply after editing

```bash
cd infra/iam/github-oidc

aws iam update-assume-role-policy --role-name CapiroGitHubReadOnlyRole \
  --policy-document file://trust-readonly.json --profile capiro-dev
aws iam put-role-policy --role-name CapiroGitHubReadOnlyRole \
  --policy-name readonly-inspect \
  --policy-document file://perm-readonly.json --profile capiro-dev

aws iam update-assume-role-policy --role-name CapiroGitHubProductionDeployRole \
  --policy-document file://trust-proddeploy.json --profile capiro-dev
aws iam put-role-policy --role-name CapiroGitHubProductionDeployRole \
  --policy-name deploy-ecr-and-s3 \
  --policy-document file://perm-deploy-ecr-s3.json --profile capiro-dev
aws iam put-role-policy --role-name CapiroGitHubProductionDeployRole \
  --policy-name deploy-ecs \
  --policy-document file://perm-deploy-ecs.json --profile capiro-dev
aws iam put-role-policy --role-name CapiroGitHubProductionDeployRole \
  --policy-name deploy-cdk-cloudformation \
  --policy-document file://perm-deploy-cdk.json --profile capiro-dev
aws iam put-role-policy --role-name CapiroGitHubProductionDeployRole \
  --policy-name deploy-observability-and-secrets \
  --policy-document file://perm-deploy-observability.json --profile capiro-dev
```

## Drift check

```bash
aws iam get-role-policy --role-name CapiroGitHubProductionDeployRole \
  --policy-name deploy-ecs --profile capiro-dev --query PolicyDocument \
  | diff - <(python -c "import json,sys;print(json.dumps(json.load(open('perm-deploy-ecs.json')),indent=4))")
```

## Hard-coded identifiers

The ECS task and execution role ARNs in `perm-deploy-ecs.json` carry
CloudFormation-generated suffixes (e.g.
`Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ`). If the
`Capiro-dev-Compute` stack ever replaces those roles, the `PassRole` grant
silently stops matching and ECS deploys fail with `AccessDenied` on
`iam:PassRole`. Re-resolve with:

```bash
aws ecs describe-task-definition --task-definition capiro-dev-api \
  --profile capiro-dev --query 'taskDefinition.[taskRoleArn,executionRoleArn]'
```
