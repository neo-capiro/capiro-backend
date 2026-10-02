I'll conduct a thorough source safety review of the fixed Meri synthetic case01 recovery one-off operator. Let me analyze the code against the security and safety requirements.

## Source Safety Review: case01-recovery-oneoff.py

### Executive Summary

After careful analysis of the source code against the shared policy and the specific requirements for this bounded canonical recovery operator, I identify **one blocking issue** related to fresh root serialization during plan→execute.

---

### BLOCK: Fresh Root Serialization - Concurrent Mutation Risk

**Location:** `case01-recovery-oneoff.py`, `fixed_inputs()` function (lines 58-75)

**Issue:** The `fixed_inputs()` function reads `ORIGINAL_INPUT` (setup-execute-input.json) at both plan and execute time, using `m.read_json(ORIGINAL_INPUT)` for recipe validation. However, the original recipe JSON file is **not** protected against concurrent modification between plan materialization and execute materialization.

**Evidence:**

```python
def fixed_inputs():
    for path, expected in [(BASE, BASE_SHA), (ORIGINAL_INPUT, ORIGINAL_INPUT_SHA), (FAILED, FAILED_SHA), (READBACK, READBACK_SHA)]:
        m.need(m.file_sha(path) == expected, 'ORIGINAL_EVIDENCE_CHANGED')
    # ... 
    recipe = m.read_json(ORIGINAL_INPUT)['recipe']  # <- Reads mutable file
    m.need(recipe['captureRunId'] == RUN and recipe['ctx']['tenantId'] == m.T1
           and m.digest(recipe) == owner['claim']['recipeSha256'], 'ORIGINAL_RECIPE_CHANGED')
```

**Risk:** While the file hash is checked against `ORIGINAL_INPUT_SHA` at the start of `fixed_inputs()`, this SHA check only validates the file content at that moment. Between plan and execute phases, the underlying file could theoretically be replaced by:

1. A concurrent process on the same Windows host
2. A different operator instance using the same worktree
3. A manual file system operation

The recovery operator's security model relies on **exact original fixture** immutability (as stated in docstring: "Only the exact original fixture may be planned/recovered"). The current implementation checks hash at function entry but then performs `read_json()` which re-reads from disk.

**Why this matters for case01 recovery specifically:**

The recovery flow requires:
- `materialize-plan-input` → creates `case01-recovery-plan-input.json`
- `prepare` (plan mode) → creates task plan with `originalClaimSha256`
- `run` (plan mode) → executes plan, produces receipt
- `materialize-execute-input` → creates `case01-recovery-execute-input.json` (re-reads ORIGINAL_INPUT)
- `run` (execute mode) → re-qualifies using `fixed_inputs()` again

The `originalClaimSha256` in the execute input is derived from the recipe digest. If `ORIGINAL_INPUT` were modified between plan and execute materialization, the execute input would contain a mismatched expectation.

**Severity:** MEDIUM-HIGH (can cause recovery to fail with unclear error, or in worst case, if hash collision achieved, could cause recovery against wrong fixture)

---

### Other Areas Evaluated: PASS

1. **Race/Freshness Scope:** ✅ PLANNED
   - `plan_execution()` validates prior plan receipt before execute
   - `qualify()` in EXECUTE_MODE re-reads actual ECS task/logs for verification
   - Image digest and source SHA binding between plan→execute is enforced

2. **One-Shot Durability:** ✅ VERIFIED
   - `create()` uses `'x'` mode (exclusive create) - atomic file creation prevents clobbering
   - Lock file created with UUID-based name in `run()`
   - No retry/resume - reconciliation required on any failure

3. **Partial Failure Preservation:** ✅ VERIFIED
   - Journal saved after each phase (CLAIMED, REGISTER_INTENT, REGISTERED, RUN_INTENT, RUNNING, STOPPED)
   - Partial journals include `ownerReceipts` even when incomplete
   - `RECONCILIATION_REQUIRED` status set on exception before re-raise

4. **Safe Outputs:** ✅ VERIFIED
   - `sanitize()` function filters sensitive keys (password, secret, credential, etc.)
   - `sanitize()` limits string length to 2000 chars and array length to 1000
   - Only `MERI_CASE01_SETUP_RECEIPT` prefixed lines are parsed from logs

5. **Source/Digest/Input Binding:** ✅ VERIFIED
   - BASE_SHA pins the oneoff lifecycle (4df33ccc...)
   - ORIGINAL_INPUT_SHA pins input (2abd4569...)
   - FAILED_SHA and READBACK_SHA pin evidence files
   - SOURCE_HASHES pins two production blobs from commit a729
   - `source_check()` validates production source and pins specific file hashes

6. **Command/Secret-Reference Surface:** ✅ VERIFIED
   - Only `recover-plan` and `recover-execute` commands allowed (via MODES)
   - PLAN_MODE uses only DB_REFS secrets; EXECUTE_MODE adds OPENAI_API_KEY via secret ref (not env)
   - `PLAINTEXT_PROVIDER_KEY_REFUSED` check prevents credential leakage
   - ECS override byte limit enforced (8192 bytes)

7. **Environment Sorting:** ✅ VERIFIED (already reviewed per policy)
   - `definition_projection()` sorts environment entries by name
   - Witnessed ECS normalization preserved

8. **Receipt Parser:** ✅ ACCEPTABLE
   - Full stage sequence enforced (RECOVERY_ADMISSION through READBACK)
   - All 19 entries required for success (9 stages × 2 phases + COMPLETE)
   - Binding/map joins validated with exact field matching
   - Does NOT declare projection or live acceptance complete (documented limitation)

9. **Root Serialization:** ✅ VERIFIED for other cases
   - Comment explicitly notes: "Fresh root serialization excludes other case17/20 setting writes during plan→execute"
   - Only `case01ExecutionSetupRecovery` key is used for recovery claim

---

### Conclusion

**BLOCK** - The `ORIGINAL_INPUT` file is re-read from disk after hash verification in `fixed_inputs()`, creating a TOCTOU (time-of-check to time-of-use) window where the file could be modified between hash check and content read. While the hash check at function entry provides some protection, the subsequent `read_json()` call re-reads the file.

**Recommended fix:** Cache the validated recipe content after hash check and use the cached copy:

```python
def fixed_inputs():
    # ... existing validations ...
    recipe_content = ORIGINAL_INPUT.read_bytes()
    m.need(hashlib.sha256(recipe_content).hexdigest() == ORIGINAL_INPUT_SHA, 'ORIGINAL_EVIDENCE_CHANGED')
    recipe = json.loads(recipe_content)['recipe']  # Use cached content, not re-read
    # ... rest of validation ...
```

This ensures the recipe used for validation matches the hash-checked bytes exactly, eliminating the race window.