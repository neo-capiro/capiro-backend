# Fixed case01 one-off operator

Prepared only. Root is the sole executor. Final helper SHA256: `886712dc55e47cd19420e8f938b79f8dc59d3728e145beebc63f182037308f37`. Independent source review PASS; 12 offline fake-AWS tests passed. No AWS, auth or live database operation was performed by this helper preparation.

Use the existing boto3 runtime:

`C:\ProgramData\Hermes\installs\404726bdd5a78951\environments\89b9c16e9db3445e8b190ec8bf8f65c5\venv\Scripts\python.exe`

Run `case01-oneoff.py` from this evidence directory. The four allowed modes are `setup-plan`, `setup-execute`, `budget-plan`, and `budget-install`. There is no arbitrary command or environment interface.

Prepare a fresh reviewed operation:

```text
python case01-oneoff.py prepare --mode <fixed-mode> --repo <clean-C-drive-main> --proof <bare-API-CodeBuild-proof.json> --proof-sha256 <proof-file-SHA256> --input <reviewed-owner-input.json> --input-sha256 <input-file-SHA256> --out <new-absolute-plan.json>
```

The proof object has the existing reviewed adapter fields `sourceSha`, `imageDigest`, `buildId`, `buildspecPath`, and `buildspecSha256LF`. They must come from the actual qualified image/build. The source build must include `OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS`. Do not substitute invented/example values.

`prepare` makes read-only AWS calls. It requires the current API service to be steady and healthy on that exact immutable image, with the exact synthetic governance cohort enabled and namespace configured. The image source must equal clean local/GitHub-tracking main, or be its ancestor with only `docs/` changes. The plan separately records the operator main commit and the image source.

After reviewing the concrete plan, run once:

```text
python case01-oneoff.py run --mode <same-fixed-mode> --repo <same-clean-main> --proof <same-proof.json> --proof-sha256 <same-proof-file-SHA256> --input <same-input.json> --input-sha256 <same-input-file-SHA256> --plan <prepared-plan.json> --plan-sha256 <planHash-field> --out <new-absolute-execution.json> --confirm RUN_ONE_REVIEWED_CASE01_TASK
```

The `--plan-sha256` value is the prepared JSON's `planHash`, not a hash of its formatted file. Proof/input hashes are raw file SHA256 values. All output paths must be new `.json` files directly in this evidence directory. Preserve the operation claim, input, plan, execution receipt and all earlier attempts.

Setup plan uses `{recipe: ...}`. Setup execute adds `expectedPlanSha256` from the actual owner plan receipt. Budget inputs use the source-owned target/namespace/context and installer contract; the install input must use real current binding/version hashes and reviewed provider rate evidence. Inputs are nonsecret, at most 6000 UTF-8 bytes; serialized ECS overrides are capped at 8192 bytes. The image entrypoint composes the database URL internally from existing secret references.

Each run registers one single-container task definition, then submits at most one task. It inherits the current API roles/network/platform and only the required DB/configuration references. Setup execution may inherit the existing OpenAI secret reference for optional legacy embedding; native institutional projection uses the existing task role. No service update, migration, cron or global queue drain is exposed.

The execution receipt records durable register/run intents, acknowledged IDs, actual container exit and sanitized source-owned structured receipts. A nonzero exit, missing receipt, task drift, uncertain acknowledgement or 900-second wait expiry yields `RECONCILIATION_REQUIRED`. A timed-out task may still run. Reconcile its saved task ID or startedBy and any committed owner stages before deciding whether to stop it; never automatically resubmit a setup/install or delete its claim. Setup/budget success is not live case01 or original 75-case acceptance.
