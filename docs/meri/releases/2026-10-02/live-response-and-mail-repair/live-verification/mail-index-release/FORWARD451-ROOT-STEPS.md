This preparation has not called AWS, authenticated to the app, or accessed the shared database. Root is the sole release operator. Candidate source/image/build evidence remains UNSEALED.

The fixed operator adds only migration `20281006010000_mail_threads_owned_connection_covering` through the qualified image's packaged `prisma migrate deploy`. It uses migration task definition135's approved database references and API507's current network/runtime baseline. Candidate451 and served450 image qualifications stay separate. It does not invoke entrypoint `migrate`, seed templates, resolve/reset migration history, or issue ledger DML.

Before execution, publish the exact reviewed source through C-drive main and GitHub main; qualify the new API image and actual451 migration marker. Populate new `forward451-input.json` and `forward451-proof.json` from the templates, bind exact input/runner/recipe hashes and actual candidate source/digest/build, set proof status READY only after independent review. The operator refuses template UNSEALED values. Preserve served API507 until migration completion.

Use the existing boto3 Python runtime:

```powershell
$python = 'C:\ProgramData\Hermes\installs\404726bdd5a78951\environments\89b9c16e9db3445e8b190ec8bf8f65c5\venv\Scripts\python.exe'
$operator = 'C:\dev\cap-meri-foundation-evidence\oct02-mail-index-release\forward451-oneoff.py'
$root = 'C:\dev\cap-meri-foundation-evidence\oct02-mail-index-release'
$proofHash = (Get-FileHash -Algorithm SHA256 "$root\forward451-proof.json").Hash.ToLowerInvariant()
$inputHash = (Get-FileHash -Algorithm SHA256 "$root\forward451-input.json").Hash.ToLowerInvariant()
& $python $operator prepare --repo C:\dev\cap-meri-outcomes-validation --proof "$root\forward451-proof.json" --proof-sha256 $proofHash --input-sha256 $inputHash --out "$root\forward451-task-plan.json"
```

Prepare performs authoritative read-only AWS checks of source/build/current service and the successful prior450 task/definition/log receipt. Review its concrete plan and fresh baseline. Root may then execute exactly once:

```powershell
$plan = Get-Content "$root\forward451-task-plan.json" -Raw | ConvertFrom-Json
& $python $operator run --repo C:\dev\cap-meri-outcomes-validation --proof "$root\forward451-proof.json" --proof-sha256 $proofHash --input-sha256 $inputHash --plan "$root\forward451-task-plan.json" --plan-sha256 $plan.planHash --out "$root\forward451-execution.json" --confirm RUN_ONE_FORWARD451_PRISMA_DEPLOY
```

Expected owner receipts are PREFLIGHT/VERIFIED, PRISMA_DEPLOY/INTENT, COMPLETE/VERIFIED, with actual container exit0. Preflight verifies the authoritative606 historical rows plus finished450, no active unfinished entries, absent target index and bounded ownership/lock checks. It captures the full607-row hash. Postcheck requires exactly608 rows, only one new451 entry, every prior607 row unchanged at microsecond precision, unchanged memory CHECKs and the exact valid/ready covering index. It reads no customer/mail rows or fixture settings.

The migration is not concurrent. Its bounded5-second lock wait and30-second statement timeout can refuse a busy/slow build. Preserve partial receipts and the operation-wide once claim on any error or ambiguous acknowledgement; do not retry, resolve, reset, or modify the ledger. Root must reconcile actual task/DB state before any further action. Service promotion follows independently verified migration success.

Local qualification: five Node tests, including actual isolated PostgreSQL index DDL and history guards;13 Python fake-AWS lifecycle tests. Both final exits0. The initial name-array decode failure is preserved. These checks do not substitute for the eventual actual shared migration or final app acceptance.
