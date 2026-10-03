# Setup inner v2 / dispatcher v5 — preparation only

The retained read-only diagnostic failed with Prisma P2028 at HYDRATE_PREVIOUS and timeoutMentioned=true. Its task stopped and definition became INACTIVE; only START/FAILURE events exist. V5 pins both result and full receipt bytes and asserts those facts before any cloud action. All old attempts remain untouched.

The new full inner derives from the original v1, retaining both plan and execute. Only createCaptureBindingOwner receives an inline frozen forwarding object. It accepts exactly three arguments, requires the fixed T1/Pat identity and a function callback, and invokes the original real factory.deps.prisma.withTenantUser method with the unchanged callback and `{timeoutMs:30000}`. No transaction or source proof is substituted. There is no retry. savedState, runtime dependencies, provider-budget owners, rates and every mutation retain their previous behavior.

Diagnostic substage labels and sanitized failure fields are carried forward from the proved diagnostic. They add no success events. Original plan retains two events; successful execute retains the original six. Actual SQL, error message, Prisma metadata and assertion values are omitted.

Dispatcher v5 changes package to case01-native-setup-v2, exclusive output directories to plan-v3/execute-v3 and execute's prior plan to plan-v3. It pins the new inner and prior diagnostic; original reconciliation and normalization helper pins remain. Wrapper serialization, receipt assembly, task image/configuration guards and one-attempt cleanup behavior are unchanged.

Validation: 16/16 focused offline tests PASS, syntax0 for inner and dispatcher. Tests extract the exact inline function and prove scope/options/callback/receiver/30second forwarding, zero calls for rejected arguments, identical error propagation without retry, unchanged original code after stripping declared additions, new paths/pins and unchanged wrapper/receipt-success contract. These are pure local tests, not Prisma/DB runtime qualification. The real retained P2028 is the before-fix reproduction; no repaired transaction has run.

Review the two diffs, mirrored sources, checkpoint and exact receipts. Do not import or run the dispatcher/inner during read-only review. Root owns any live plan/execute and must preserve uncertain outcomes. No cloud, provider, DB, auth, journal or repository actions were performed by this preparation.
