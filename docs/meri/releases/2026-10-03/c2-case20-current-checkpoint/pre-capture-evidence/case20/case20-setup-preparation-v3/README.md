# Case20 setup v3 — two review corrections

Use only [dispatcher](supervised-candidate/run-case20-native-setup.mjs) and [unchanged inner](supervised-candidate/case20-native-setup-inner.mjs) from this freeze. V2 remains retained. [Original operation, evidence-index and materializer instructions](../case20-setup-preparation-v2/README.md) still apply; setup modes are `plan|execute`, separate future budget modes are `plan|install`. Runtime output roots remain `case20-native-setup-plan-v1` and `case20-native-setup-execute-v1` because no real setup was run by this author.

The current `run-authorization.json` and `fresh-spend.jsonl` sizes/hashes must match the exact saved 22-event checkpoint at local admission, immediately before registration, and immediately before RunTask. This is read-only freshness, not a distributed lock or journal authority. These runtime checks were exercised only with injected in-memory fake bytes during qualification; the actual live journal was not read or changed by these tests.

An execute result reports the prior qualification cleared only when the canonical successful native owner receipt is validated. Before any RunTask dispatch it reports `UNCHANGED_BEFORE_DISPATCH`; uncertain dispatch without proven success reports `NOT_PROVED`. A successful owner receipt can prove its committed change even when subsequent cleanup or service readback makes the overall result fail.

Same exact test bytes: retained v2 source gives 29 PASS/7 FAIL; v3 gives 36 PASS/0 FAIL. Two `node --check` commands passed. AWS, canonical owner and service observations are injected fakes; no cloud/DB/auth/provider/fixture/journal operations or operator execution occurred. All broader v2 limitations remain.
