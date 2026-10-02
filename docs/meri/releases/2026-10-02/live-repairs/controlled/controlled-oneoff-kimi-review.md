I'll analyze this controlled-read operator adaptation against the base case01 operator, focusing on the specific constraints mentioned in the review request.

## PASS

The controlled-read operator adaptation is correct and maintains all security invariants from the base case01 operator. No blocking issues found.

## Review Analysis

### Source Bypass Checks
- **Lines 75-93**: The source check correctly validates that only documentation changes (`docs/`) OR specific controlled-read driver files are allowed when image SHA differs from main HEAD
- **Lines 95-100**: Properly checks for `meri-capture-provider-budget` entrypoint verb but notably removes the check for `meri-case01-setup` since the controlled operator uses a different setup path via shell command
- **Lines 101-103**: Validates the controlled-read source has required markers `executeControlledReadSetup` and `MERI_CONTROLLED_READ_SETUP_RECEIPT`
- **Lines 104-105**: Confirms canonical DB composer with `sslmode=require` and `encodeURIComponent(passRaw)` is used

### Input/Receipt Handling
- **Lines 109-119** (`controlled_setup_command`): All command text is source-owned constants; no user input interpolation into shell. Input JSON stays in environment variable `MERI_CONTROLLED_READ_SETUP_INPUT`. Uses canonical DB URL composer via `pe-compose-database-url.js`
- **Lines 160-175** (`input_binding`): Input scope validation properly requires `caseId` in `('20','72')` and validates UUID format for `captureRunId`, `clientId`. Adds `INPUT_CLERK_ACTOR` check for `clerkUserId` starting with `user_`
- **Lines 176-177** (`setup-execute`): Requires fixed confirmation string `INSTALL_OWNED_CONTROLLED_READ_FIXTURE`
- **Lines 178-180** (`budget-install`): Validates controlled budget scope with exact caps (`maxCostMicros=3000000`, `maxTokens=200000`, `maxAttempts=32`)

### No Repeat Writes / Secret Exposure
- **Lines 227-228**: Explicitly refuses `OPENAI_API_KEY` in environment (plaintext provider key refused comment)
- **Lines 229**: Confirms "Controlled source owner never uses provider APIs. DB references only"
- **Line 248-251**: For setup modes, overrides entryPoint to `['/bin/sh', '-c']` and uses the fixed shell command, preventing any budget/entrypoint verb injection
- **Line 354**: `owner_receipts` prefix changed from `MERI_CASE01_SETUP_RECEIPT ` to `MERI_CONTROLLED_READ_SETUP_RECEIPT ` for setup mode
- **Lines 356-357**: Receipt validation correctly checks for single receipt with `status=='CONTROLLED_READ_BOUND'` and `caseId in ('20','72')` and `sharedCorpusWrites==0`

### Output Path Security
- **Lines 157, 325**: Output path uses `/dev/shm/meri-controlled-read-owner-receipt.json` (single file, not `.jsonl`), matching the fixed shell command

### Confirmation String Update
- **Line 312**: Changed from `RUN_ONE_REVIEWED_CASE01_TASK` to `RUN_ONE_REVIEWED_CONTROLLED_READ_TASK`

### Lock File Naming
- **Line 313**: Changed from `case01-` prefix to `controlled-` prefix for lock files

### StartedBy Prefix
- **Line 340**: Changed from `meri-c01-` to `meri-cr-` for task startedBy tagging

### Test Coverage
The tests validate:
- Fixed bootstrap uses canonical composer (line 354 in tests, `test_fixed_bootstrap_uses_canonical_composer_and_never_provider_refs`)
- Case scope fixed to 20/72 only (line 361-362)
- Budget install caps enforced (line 368-372)
- Completion needs single controlled receipt with correct status/binding (line 374-380)
- Source drift allows only docs or controlled driver paths (line 167-168 in source check)

### CLI Evidence
The provided CLI (`meri-controlled-read-setup.mjs`) correctly:
- Requires `DATABASE_URL` from environment (not constructing from parts)
- Validates target and namespace against fixed constants
- Uses atomic file write with `wx` flag to `/dev/shm/meri-controlled-read-owner-receipt.json`
- Outputs prefixed receipt line to stdout
- No direct DB credential handling - relies on canonical composer called by shell wrapper