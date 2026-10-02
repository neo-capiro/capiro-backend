PASS

Reviewing the provided files against the user's authorization specification:

**Scope verification:**
- Case 17 v5 is confirmed as exact frozen v4 with only suffix/newgate import changes (`-v4` → `-v5`, `./live-operator-gates.mjs` → `./case17-v5-gates.mjs`)
- `case17-v5-gates.test.mjs` line 36-37 validates this transformation precisely
- All v4→v5 path changes are isolated (execution file, lock file, artifact directory, review request files)

**Pin and build verification:**
- `TESTED_CODE` = `ce66c9239ab5aee7d0daac1f9a710c3ddbd76db3` (includes reviewed enum fix and collector mount fix per user)
- `WEB_SOURCE` = `78ad5805679a3045b1fc10fb19beafa7f76e4e64` (unchanged per user "Web stays78ad")

**Gate structure verification:**
- `inspectV5Pins()` requires all 256-bit hashes: `gatesSha256`, `driverSha256`, `reviewedBuildInputSha256`, `apiBuildReadbackSha256`
- Root seals pins only after actual API image built and deployed; `loadRelease()` fails closed with `ENOENT` when `case17-v5-release-pins.json` absent (confirmed by test line 24-25)
- `V5_BUILD_MARKERS_REQUIRED` enforces exact migration markers from reviewed build input

**Auth/write bounds:**
- `maxSynthesisSubmissions: 0`, `maxApplicationWrites: 0` enforced in driver (line 107)
- `ONE_OWNED_TICKET_ONLY`, `ONE_OWNED_AUTH_ONLY` gates prevent multiple sessions
- `revokeOwned()` ensures session cleanup in all paths
- Noturn UI collector pattern confirmed: `originalPromptSubmission: 'NOT_RUN'`, `fullOriginalRow17Acceptance: false`

**Source ancestry verification:**
- `V5_CLEAN_CURRENT_MAIN_REQUIRED` enforces clean main at operator HEAD
- `merge-base --is-ancestor` checks for both `TESTED_CODE` and `sourceSha` ancestry
- `assertDocsOnly()` gates prevent code drift between tested code and release source

**Tests pass (4/4):**
1. Pin shape validation rejects wrong target, tested code, or web source
2. Prior case cleanup verified via `readPriorCase17()`
3. Unsealed v5 correctly blocked, v4 driver rejected
4. v4→v5 transformation matches exactly

**Concrete finding:** Files conform to specification. Ready for root execution pending actual API release pins after future build+rollout.
