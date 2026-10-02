# Post451 same-owner EXPLAIN readback

Run only after the forward451 task is VERIFIED. This uses the existing API507/source429 application role, unchanged private owner scope, original1616 literal and fixed asOf. No ANALYZE or customer rows; only redacted catalog/plan metadata. Root owns execution.

Prepared source: runner `5bd8ec5ae963c43273023eea5f4f29451669a6e295d7d5a22cdc26a65dafe1f6`, wrapper `803246d8d0b22d62cba9bd6d1d1ae3884011b13e54068ddc581c30f5f319e615`. Local6 Node+7 Python checks exit0. Independent peer receipt is separate. Old probe and its one-shot claim remain untouched.

```powershell
& 'C:\ProgramData\Hermes\installs\404726bdd5a78951\environments\89b9c16e9db3445e8b190ec8bf8f65c5\venv\Scripts\python.exe' 'C:\dev\cap-meri-foundation-evidence\oct02-mail-postindex\mail-plan-oneoff.py' prepare --repo 'C:\dev\cap-meri-outcomes-validation' --proof 'C:\dev\cap-meri-foundation-evidence\oct02-mail-postindex\api-served-build-proof.json' --proof-sha256 '082e1501edfca2b0ae715498f1f9276671301b84062e9dfe8bde8edb5bdf70d2' --out 'C:\dev\cap-meri-foundation-evidence\oct02-mail-postindex\mail-postindex-task-plan.json'
```

Inspect the actual prepared plan, then:

```powershell
$mailPostIndexPlan = Get-Content -Raw 'C:\dev\cap-meri-foundation-evidence\oct02-mail-postindex\mail-postindex-task-plan.json' | ConvertFrom-Json
& 'C:\ProgramData\Hermes\installs\404726bdd5a78951\environments\89b9c16e9db3445e8b190ec8bf8f65c5\venv\Scripts\python.exe' 'C:\dev\cap-meri-foundation-evidence\oct02-mail-postindex\mail-plan-oneoff.py' run --repo 'C:\dev\cap-meri-outcomes-validation' --proof 'C:\dev\cap-meri-foundation-evidence\oct02-mail-postindex\api-served-build-proof.json' --proof-sha256 '082e1501edfca2b0ae715498f1f9276671301b84062e9dfe8bde8edb5bdf70d2' --plan 'C:\dev\cap-meri-foundation-evidence\oct02-mail-postindex\mail-postindex-task-plan.json' --plan-sha256 $mailPostIndexPlan.planHash --confirm RUN_ONE_READONLY_POSTINDEX_MAIL_EXPLAIN --out 'C:\dev\cap-meri-foundation-evidence\oct02-mail-postindex\mail-postindex-execution.json'
```

Do not retry an ambiguous acknowledgement. Preserve the task receipt for read-only reconciliation. A successful plan does not prove live query latency; the authorized mailbox retest remains separate.
