# Original benchmark planner repair and terminal reconciliation

The API image for source `324195f120df830efc9c7e9f557898304b5467dd` is
qualified at digest `sha256:3a7a67105998d88c44a43fd2c1edb6f8b301ab1e95413ee5def37ec849bcc722`.
Promotion and the repaired-version live retest remain pending at this checkpoint.

The planner now recognizes a selected client's possessive memory attributes,
including an abbreviated name only when it uniquely matches current authorized
client names. Ambiguous, foreign and mixed targets retain their previous scope.
There is no special-case override for the original test prompt. The strict
capture budget guard and normal client permission checks remain unchanged.

The final source passed111 focused tests. API type checking and all26 offline
cases passed before a final restrictive multi-clause guard; exact before/after
blob hashes and the limited delta are recorded in the qualification. Independent
Hermes/Bedrock Kimi reviewed that patch, and root reviewed the final restriction.
The built ARM64 image executed a network-disabled planner smoke against positive
and negative examples, checked runtime imports and all451 packaged migration
hashes, and matched the published ECR digest. GitHub Actions failed before any job;
the previously authorized AWS fallback built the exact merged main source.

This candidate builds on the already qualified combined source `ddb55a5a3e6bbf1c3f567119b66e18e0a92e60ab`.
Compared with the currently served API429 source, it also includes the previously
qualified hypothetical-assurance changes and migration451, which is already
applied. The included independent database receipt preserves all607 predecessor
rows. This release requires no new migration, provider setting or service config.

The original failed case01 has been reconciled through one append-only journal
event. Root independently reopened and verified the journal: no active run,
full$3 conservative charge retained, actual billing UNKNOWN, $27 remaining.
The failed run cannot be reused. No new model submission accompanied closure.

The shared02–05 collector and closure source are in main. Their combined21
targeted tests passed; the earlier closure suite passed99 tests including existing
suites, and the collector passed14. These are harness checks, not live benchmark
passes. The general bounded spending adapter remains under implementation.

Full75 acceptance is still incomplete. The24 indexed evidence files preserve
their original bytes; credentials and native journal capabilities are excluded.
