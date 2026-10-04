# Independent patch review

Verdict: NEEDS CHANGES. The source-level repair is not sufficient for strict Case 14 receipt acceptance. This is not an acceptance of the retained run: its evidence remains BLOCKED / NOT_RUN.

## Actionable findings

1. **[P1] Case 14 does not verify source bytes against the canonical content hash.** In `evidence/evals/meri/live-v1/case01-receipt-joins.mjs:239-250`, the Case 14 branch checks the readback text against `fixture.approvedText` and compares `provenance.contentHash` to `source.contentSha256`, but never computes `sha256Bytes(sourceReadback.text)` and compares it to that canonical hash. The Case 01 branch does perform this byte-to-hash check. Thus mutually consistent but incorrect fixture/readback hash metadata can pass even though it does not describe the approved bytes. Add the independent byte-hash equality and a negative test that changes both fixture hash copies and readback provenance hash while leaving the text unchanged.

2. **[P2] Ellipsis normalization is corrupted and rejects valid citations.** The same file at line 261 tests the mojibake string `â€¦` instead of the Unicode ellipsis `…` present in the source. A citation ending in a real ellipsis will not have the suffix removed before the prefix check, causing a valid truncated citation to fail. Restore the actual ellipsis character and retain a regression test for it. The changed logic applies to Case 01 as well as Case 14.

## Evidence boundary

The retained diagnostics show the old run is still blocked: `observed-summary.json` reports `acceptanceStatus: NOT_RUN` with semantic-clock API/tool-join and source-tenant-authority blockers. The retained assistant message also reports incomplete retrieval and a semantic-date inconsistency. Do not treat source fixes or supplied unit-test logs as a successful capture/replay. Supplied logs report API 29/29 and Node 76/76 passing; I did not run tests, per instruction.

Reviewed the supplied diff, changed-source snapshots, observed source/message/conversation diagnostics, and retained test logs. No source files were edited; only this review was written.
