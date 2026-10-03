# Governed artifact MAC test fixture correction

The first complete native orchestrator run at `5b086a6b` passed 1,551 tests, failed one, and skipped the existing two live tests. The failed case 46 transport test supplied a signed governed artifact policy without the semantic clock or compiler clock evidence now required by the shared verifier. Its MAC and real-time expiry were valid. The exact original test and failed build log are retained here.

The test fixture now supplies matching synthetic owner/compiler clock evidence. It also checks that a valid signature cannot admit missing semantic clock evidence, missing compiler evidence, or a different current corpus hash. Existing turn, image, page-write and tampering refusals remain. The positive path reaches the stubbed assistant exactly once. The test explicitly does not establish actual case 46 clock capture acceptance.

Only one test file changed; all frozen production clock and provider source hashes remain identical. The corrected file passes its two local tests. [Independent review](independent-review.json) and [qualification](qualification.json) record the bounded result. The immutable API image from `5b086a6b` can be retained; the orchestrator must be rebuilt from this test correction before release.

The prepared retry specification preserves every existing probe and publication check, raises the passing-test floor to 1,552, and requires the formerly failing test by name. It has not run at this checkpoint. [Artifact hashes](artifacts.json) preserve the failure and correction; no service, provider, database or journal was changed.
