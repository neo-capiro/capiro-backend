# Fixture retirement CLI qualification

Source: 2f492ad9f31daa333a2496bec46bff3183fb724b.

The operator can plan, apply and verify retirement of a previously seeded pending-memory instance using the canonical withdrawal owner. The prior candidates and immutable audit history remain stored. A distinct replacement manifest is bound into the plan and every receipt; replacement creation remains a separately verified seed operation.

The plan reconstructs operations from both validated manifests and complete seed coverage. It refuses changed logical fixtures, actors, tenant/client bindings, owner availability, duplicate/missing seed records and rehashed operation omissions or redirects. Application uses the seed row version and current canonical readback, and the owner checks authority/content/holds atomically. A retry of the same plan recognizes already-retired rows only through audit-bound readback with the expected prior version. Any error after attempting a mutation is conservatively reported as unknown_outcome; it is not a claim of rollback or successful completion. Verification reads the canonical owner again and compares the retained-state proof.

The typed retirement plan, receipt and verification receipt are distinct from deletion/reset artifacts. They cannot satisfy an existing physical-reset receipt check. A complete retirement means all available records in this bounded manifest were reconciled; unavailable owners remain listed and fixtureComplete is always false. Non-memory present owners are explicitly unsupported. Approved or changed candidates still refuse the pending withdrawal path.

PASS, actual exit 0:

- 47 Node tests covering retirement state, existing fixture contracts and actual CLI invocation. Adverse cases include rehashed omission/duplication/redirection, incomplete seed evidence, offline authority, missing confirmation, changed versions, mismatched audit prior versions, verification drift and unknown-outcome recovery without repeated writes.
- 15 actual PostgreSQL owner tests, including a child-process CLI cycle through the built canonical application service. The cycle retires 13 pending candidates, retains 13 audit entries, retries without changing the retained rows or adding audit entries, verifies retirement, seeds the bound replacement, and verifies the replacement while preserving old content/provenance/row versions. The owned local schema and temporary CLI files are removed.
- The original 75-case frozen contract validates unchanged. This is contract validation, not execution of those cases.

The database uses a minimal isolated schema and local test-process governance opt-in. These checks do not qualify shared-environment permissions, full RLS, migrations, real provider sinks or complete tenant query isolation. No production flag, route, tenant cohort, model policy, AWS service or shared database changed. Existing LIVE capture gates remain closed.

Independent Hermes/Bedrock Kimi static review of the exact source: SCOPED PASS, exit 0. Lead qualifications: the canonical mutation and audit share a transaction, but retirement readback uses a separate transaction; the adapter's declared authority is not itself authorization, which remains enforced by the canonical service. The expected not-yet-retired readback error is intentionally handled as pending; other readback errors stop application. The reviewer did not execute tests. These corrections limit its summary without changing its no-blocker verdict.

Evidence under C:/dev/cap-meri-foundation-evidence: fixture-retirement-contract-final.log and exit receipt; fixture-retirement-postgres-first.log and exit receipt; review-fixture-retirement-cli.jsonl and exit receipt. The PostgreSQL log includes actual plan/retirement/replacement content addresses and retained candidate/audit counts.

## Operator commands

Use the old instance's exact config and complete seed receipt. Generate the replacement manifest from an otherwise identical config with a fresh lowercase UUIDv4 fixtureInstanceId. Keep credentials only in the existing runtime environment, never these JSON files. Each file argument below must be an absolute path. These commands require the existing canonical governance gates; they never enable those gates or authorize a broader cohort.

```powershell
$cli = 'C:\dev\cap-meri-foundation\evals\meri\live-v1\fixture-provisioning\cli.mjs'
$adapter = 'C:\dev\cap-meri-foundation\evals\meri\live-v1\fixture-provisioning\memory-candidate-runtime.mjs'
node $cli source-map --config $replacementConfig --out $replacementManifest
node $cli retirement-plan --config $oldConfig --adapter $adapter --seed-receipt $oldSeed --replacement-manifest $replacementManifest --out $retirementPlan
node $cli owned-retirement --config $oldConfig --adapter $adapter --seed-receipt $oldSeed --replacement-manifest $replacementManifest --retirement-plan $retirementPlan --confirm RETIRE_MANIFEST_LISTED_MERI_SYNTHETIC_FIXTURE --out $retirementReceipt
node $cli verify-retirement --config $oldConfig --adapter $adapter --seed-receipt $oldSeed --replacement-manifest $replacementManifest --retirement-plan $retirementPlan --retirement-receipt $retirementReceipt --out $retirementVerification
```

Replacement seeding still uses the existing plan/apply/verify commands with the replacement config. This receipt alone does not prove the replacement exists or that every previous active source is excluded. Approved-memory revocation, other fixture owners and trusted collector binding remain required before original served acceptance can pass.
