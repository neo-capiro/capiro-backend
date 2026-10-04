# Case20 canonical budget preparation

Frozen output-only successor of the independently reviewed setup v3 transport. No budget owner, cloud, authentication, provider, fixture, journal or capture operation was performed by this preparation. Independent source review is required before root invokes this draft.

Use [dispatcher](supervised-candidate/run-case20-native-budget.mjs) with sole mode `plan` or `install`. It invokes the packaged `apps/api/scripts/meri-capture-provider-budget.mjs`, never the setup owner. Fixed source is `4f0253874357c272fda1ae2a5271ee4af645f0bc`; run remains `f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b`. No second setup/binding or journal reservation occurs. Current authority, tenant xmin/current binding/prior qualification CAS, and transactional readback remain owned by that existing native CLI.

The host validates actual `case20-native-setup-execute-v1/{result.json,cleanup.json,inner-owner-receipt.json,inner-owner-transport.json,materializer-receipt.json}` and canonical setup scope before deriving budget inputs with `controlledReadBudgetPlanInput` / `controlledReadBudgetInstallInput`. It requires the exact current release approval, healthy pair receipts and live task/config/image/source before and after. The two current accounting files must still match the saved 22-event checkpoint before register and RunTask. Rates and setup/prior-plan evidence are reread before those mutations. These are point-in-time fences, not a distributed lock.

Rates remain the exact `reviewed-rates-c2-v2-20261003.json`, SHA256 `3531e09dfcce9f66b4ea2b3564db47bd72dc507cdcf1aecdda277b838007704e`, expiring `2026-10-04T05:29:01.587Z` with more than 15 minutes required. The existing bounds are 15,000,000 micros, 500,000 tokens and 32 attempts; no provider/model/config change. Qualification installation is not a reservation or paid capture.

## Actual result and materializer paths

- Plan output root: `../case20-native-budget-plan-v1`; successful outer status `BUDGET_PLAN_ONLY`, native `inner-owner-receipt.json` status `READY_FOR_RATE_QUALIFICATION`.
- Install output root: `../case20-native-budget-install-v1`; successful outer status `BUDGET_QUALIFICATION_INSTALLED`, native status `PROVIDER_QUALIFICATION_INSTALLED`. Install requires the same successful native budget plan and actual setup bytes.
- Each root saves `result.json`, `cleanup.json`, exact compact staged `owner-input.json`, exact native receipt, transport and task evidence. Existing roots refuse replay; ambiguous operations remain blocked.
- Root creates each `materializer-receipt.json` only after verifying actual task and child exit 0, exact source/image/input/owner bytes and scope, no fatal uncertainty, and STOPPED/INACTIVE cleanup. Preserve originals. Wrapper shape is `{ "status": "VERIFIED", "containerExitCode": 0, "ownerReceipts": [{ "receipt": <actual native receipt object> }] }`.
- The existing materializer consumes `budgetPlanPath`, `budgetInstallInputPath` (install root `owner-input.json`), `budgetInstallReceiptPath`, and `reviewedRatesPath`; stage names are `budget-plan`, `budget-install`, then separately `live-scope`. A new evidence index should hash actual filenames above and exact release, setup, rates and input bindings. An index/wrapper asserts consistency only.

## Local evidence and Hermes usage

Hermes used its unchanged configured `openai/gpt-6-luna` through OpenRouter in fresh session `20261003_203228_43eeac`, completed normally, 32 API calls, estimated $0.034081535. Its raw inner, prompt, response, usage and execution provenance remain in `hermes-draft`. Coding-agent inference is separate from the product journal.

Supervisor corrections removed an erroneous expected `caseId` from the actual native install result (that result has none) and pinned the exact reviewed rate rows. Same final test bytes against the retained raw Hermes inner show 27 PASS/2 FAIL; corrected inner shows 29 PASS/0 FAIL. A subsequent host-only change saves the exact compact staged input bytes instead of equivalent pretty JSON; `final-exact-input/receipt.json` binds the final host and repeats 29 PASS/0 FAIL. Both final files pass syntax checking. Original failed loader/import and earlier runs are retained.

Tests read the actual saved setup receipt and rates locally. Budget plan/installed examples are explicitly synthetic; extracted functions run without dispatcher/inner mains, network, DB or subprocess. Existing runtime transport qualification is inherited from setup v3; it was not rerun against cloud or a packaged task here. No actual budget result or acceptance claim is created.
