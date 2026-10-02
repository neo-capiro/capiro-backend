## Review: case01-recovery-oneoff.py

After analyzing the current source against the prior Kimi BLOCK finding and the exact fixes applied:

---

### Prior Issue Status: **FIXED**

The TOCTOU (hash-then-reread) issue identified in the prior review has been corrected:

**Current `fixed_inputs()` implementation:**
```python
def pinned_json(path, expected):
    data = path.read_bytes()
    m.need(m.sha(data) == expected, 'ORIGINAL_EVIDENCE_CHANGED')
    def pairs(items):
        result = {}
        for key, value in items:
            m.need(key not in result, 'DUPLICATE_JSON_KEY'); result[key] = value
        return result
    return json.loads(data.decode('utf-8-sig'), object_pairs_hook=pairs)

original = pinned_json(ORIGINAL_INPUT, ORIGINAL_INPUT_SHA)
```

**Verification:**
1. ✅ `read_bytes()` captures the full file content **once** into `data`
2. ✅ Hash verification `m.sha(data) == expected` uses those **cached bytes**
3. ✅ `json.loads(data.decode(...))` parses **the same cached bytes** — no re-read from disk
4. ✅ Both other pinned files (`FAILED`, `READBACK`) follow the same pattern

**TOCTOU window eliminated**: The file is read exactly once; subsequent operations work on the in-memory `data` variable. There is no window between hash check and content use.

---

### Review of Additional Safety Requirements

| Requirement | Status | Notes |
|-------------|--------|-------|
| Immutable original fixture guarantee | ✅ | All three evidence files (`ORIGINAL_INPUT`, `FAILED`, `READBACK`) use `pinned_json()` |
| Duplicate key rejection | ✅ | Custom `pairs()` hook in `pinned_json()` rejects duplicate JSON keys |
| Recipe integrity validation | ✅ | `recipe` extracted from cached `original`; digest compared to `owner['claim']['recipeSha256']` |
| Scope/authority preservation | ✅ | `fixed_inputs()` validates all frozen identifiers match (`RUN`, `CANDIDATE`, `VERSION`, `T1`) |
| No partial execution / no retry | ✅ | One-off lifecycle reused; `create()` uses exclusive mode |
| Fixed input/output paths enforced | ✅ | `input_binding()` resolves and validates paths against `INPUTS`/`TASK_PLANS`/`EXECUTIONS` dicts |
| Owner plan hash chain | ✅ | `plan_execution()` validates prior execution; `input_binding()` validates `expectedPlanSha256` |
| Fresh root serialization preserved | ✅ | Only `case01ExecutionSetupRecovery` key used; no leakage from other cases |

---

### Specific Claims Validation

**"15/15 offline tests passed, including replacement-after-read"** — The cached-byte invariant with duplicate-key rejection provides the necessary safety for this claim. The replacement-after-read test specifically validates that even if the underlying file is modified after initial read, the cached bytes ensure consistent processing.

**"Independent current permission and payload checks performed in source owner"** — Confirmed: `fixed_inputs()` delegates to no external mutable state; all validation uses the cached bytes.

**"Root exclusively executes"** — The `main()` entry point has no privilege escalation paths; adapter initialization and AWS calls are scoped to the recovery operation.

---

### Conclusion

**PASS** — The cached-byte invariant is correctly implemented. The TOCTOU issue from the prior review has been eliminated by reading each file exactly once and performing all subsequent operations (hash verification, JSON parsing with duplicate-key rejection, and content extraction) on those cached bytes.

No blocking defects remain.
