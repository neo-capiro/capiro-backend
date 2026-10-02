# Task-local synthetic Meri canary operator

Status: prepared and offline-qualified; no AWS mutation has been executed by this helper. Root must supply and review the exact promoted candidate proofs and fresh plan before each mutation phase. Scope is only the two previously approved synthetic tenants and their `meriv3.fullChat` flag; no global enablement change.

Files are all in `C:\dev\cap-meri-foundation-evidence\oct02-release-path`. Use the existing SDK interpreter:

```powershell
$py = 'C:\ProgramData\Hermes\installs\404726bdd5a78951\environments\2c00d1956f6f43129716679b6d1290bb\venv\Scripts\python.exe'
$root = 'C:\dev\cap-meri-foundation-evidence\oct02-release-path'
```

Qualification JSON fields:

```json
{
  "schemaVersion": "meri.synthetic-canary.codebuild.v1",
  "operatorSourceSha": "EXACT_CLEAN_OPERATOR_CHECKOUT_HEAD",
  "expectedCallerArn": "arn:aws:iam::967807252336:user/hermes-cli",
  "images": {
    "api": {
      "buildId": "capiro-build-web-dev:ACTUAL_BUILD_UUID",
      "sourceSha": "ACTUAL_IMAGE_SOURCE_SHA",
      "imageDigest": "sha256:ACTUAL_DIGEST",
      "buildspecPath": "ABSOLUTE_REVIEWED_BUILDSPEC_PATH",
      "buildspecSha256LF": "SHA256_OF_UTF8_LF_NORMALIZED_BUILDSPEC"
    },
    "meriv2-orchestrator": { "sameFieldsAsApi": "REPLACE_WITH_REAL_FIELDS" },
    "web-vnext": { "sameFieldsAsApi": "REPLACE_WITH_REAL_FIELDS" }
  }
}
```

This example is deliberately invalid; fill real proof values from successful CodeBuild receipts. Source SHA must be an ancestor of the clean operator checkout. The API's three image-owned fullChat command files must be byte-identical at the image source and checkout. All three actual live services must already serve the qualified digest, with Web's real application target healthy. The plan expires after one hour, preserves every service configuration field except documented volatile fields, and exposes existing cohort data only as hashes/counts.

Read-only prepare:

```powershell
& $py "$root\synthetic-canary-codebuild.py" prepare --repo 'EXACT_CLEAN_C_DRIVE_CHECKOUT' --qualification "$root\synthetic-canary-qualification.json" --output "$root\synthetic-canary-plan.json"
```

Root reviews the returned plan hash, full source/proof/health receipts, and only two additions. Each mutation command must use that hash and a unique output path. `flag-plan` registers a minimal image-owned diagnostic definition and launches only the fixed read-only flag query. It writes no tenant flags. The actual authoritative task and sanitized logs are required by apply.

```powershell
& $py "$root\synthetic-canary-codebuild.py" flag-plan --repo 'EXACT_CLEAN_C_DRIVE_CHECKOUT' --qualification "$root\synthetic-canary-qualification.json" --plan "$root\synthetic-canary-plan.json" --approve 'REVIEWED_PLAN_HASH' --confirm EXECUTE_FIXED_SYNTHETIC_FLAG_PLAN --output "$root\synthetic-canary-flags-before.json"
```

After review, apply sets the two fixed flags using the actual image-owned command and compares their original states, then appends only missing approved slugs to API and orchestrator cohort configuration. Each service registration/readback, update intent, returned deployment ID, stable task/digest identity and exact ALB target health are journaled. All roles, networks, images, existing cohort membership and other flags remain bound to the fresh baseline.

```powershell
& $py "$root\synthetic-canary-codebuild.py" apply --repo 'EXACT_CLEAN_C_DRIVE_CHECKOUT' --qualification "$root\synthetic-canary-qualification.json" --plan "$root\synthetic-canary-plan.json" --approve 'REVIEWED_PLAN_HASH' --confirm EXECUTE_FIXED_SYNTHETIC_APPLY --flags-receipt "$root\synthetic-canary-flags-before.json" --output "$root\synthetic-canary-apply.json"
```

Rollback requires root's explicit call. It restores the exact pre-canary task definitions (retaining the newly released image), then restores each flag's original absent/value state, derived again from the actual successful apply task and logs. A service still on its original deployment needs no update. Any third-party config or primary-deployment drift refuses automated rollback.

```powershell
& $py "$root\synthetic-canary-codebuild.py" rollback --repo 'EXACT_CLEAN_C_DRIVE_CHECKOUT' --qualification "$root\synthetic-canary-qualification.json" --plan "$root\synthetic-canary-plan.json" --approve 'REVIEWED_PLAN_HASH' --confirm EXECUTE_FIXED_SYNTHETIC_ROLLBACK --source-receipt "$root\synthetic-canary-apply.json" --output "$root\synthetic-canary-rollback.json"
```

Unknown acknowledgements and failed operations are never retried blindly. A per-plan/mode exclusive lock and exclusive initial receipt prevent duplicate executions even with different receipt filenames. Preserve all journals and locks for root's read-only reconciliation. Do not delete a lock or construct a new plan to evade an unresolved operation. No credentials or raw task definitions are written by the operator. Flag before/after receipts contain only the two approved synthetic identities and their single feature flag.

Live Playwright remains a separate root-released phase on `https://os.capiro.ai`, using the existing verified ordinary synthetic identities, with no old personal session reuse. No password is needed from the user. Full File01 acceptance is not implied by this bounded canary or by the offline adapter tests.
