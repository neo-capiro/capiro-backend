# API image build record contract

## Scope

`.github/workflows/api-image.yml` is the only producer covered by this contract. After its existing `docker/build-push-action@v6` step pushes the API image, the workflow passes that exact step's `outputs.digest` to `scripts/api-image-build-record.py`. The script resolves the checked-out commit with `git rev-parse HEAD`, requires it to equal the full 40-character `GITHUB_SHA`, and writes `api-image-build-record.json`.

The uploaded artifact is named:

`api-image-build-record-<github.run_id>-<github.run_attempt>`

The run ID plus attempt makes the name unique for each workflow attempt. `actions/upload-artifact@v4` artifacts are immutable after a successful upload. They remain subject to GitHub authorization, retention, and deletion; “immutable” does not mean permanent.

## Version 1 JSON

Version 1 is one UTF-8 JSON object with a trailing newline and exactly this shape:

```json
{
  "build": {
    "context": ".",
    "dockerfile": "apps/api/Dockerfile",
    "platform": "linux/arm64"
  },
  "environment": "dev|staging|prod",
  "image": {
    "digest": "sha256:<64 lowercase hex characters>",
    "repository": "<12-digit-account>.dkr.ecr.us-east-1.amazonaws.com/capiro/<environment>/api",
    "uri": "<repository>@<digest>"
  },
  "schemaVersion": "capiro.api-image-build-record.v1",
  "source": {
    "commit": "<40 lowercase hex characters>",
    "ref": "refs/heads/<name> or refs/tags/<name>",
    "repository": "neo-capiro/capirov2"
  },
  "workflow": {
    "name": "api-image",
    "path": ".github/workflows/api-image.yml",
    "runAttempt": 1,
    "runId": 123456789
  }
}
```

The producer hard-codes the repository, workflow identity, Dockerfile, context, platform, region, and ECR repository pattern. It accepts no command-line override for those values. It validates the environment allowlist, a path-free ECR registry for `us-east-1`, positive run identifiers, a canonical heads/tags ref, the source commit equality, and the digest syntax. A missing or malformed build digest fails before artifact upload and before the existing deploy steps. On any producer error, no receipt file is retained.

## Consumer requirements

Receipt fetching and trusted-run verification are deliberately outside this producer change and belong to the full-chat consumer. Before trusting a receipt, that consumer must independently use GitHub's authenticated run and artifact metadata to verify all of the following:

1. the repository is `neo-capiro/capirov2`;
2. the run used `.github/workflows/api-image.yml` from an approved revision and trusted event/ref;
3. the run ID and attempt match both the artifact name and receipt;
4. the artifact belongs to that exact successful workflow attempt;
5. the receipt has the exact Version 1 shape and values allowed above; and
6. any release decision uses `image.uri` (repository plus digest), not either mutable tag.

The consumer should reject unknown fields, duplicate JSON keys, non-integer run identifiers, mismatched artifact/run metadata, and future schema versions it does not explicitly support.

## Limitations

This record is a narrow workflow receipt, not a cryptographic attestation, signature, or SLSA provenance statement. The workflow intentionally retains `provenance: false`; no attestation permission, IAM permission, or provenance format is added. The record does not by itself prove who controlled the workflow or repository, that GitHub's runner was uncompromised, that the artifact was retained, or that the image still exists in ECR. Those trust decisions require the independent run verification above.

The digest comes from the completed build-and-push action, not from ECS metadata, `GIT_SHA`, a tag echo, or a later ECR lookup. Existing SHA/latest tags, cache settings, permissions, environment routing, and ECS deployment behavior are unchanged.
