Based on my analysis of the three exact source files provided, here is my read-only review report:

---

## REVIEW REPORT: case01-reconcile-oneoff.py wrapper

**Reviewer:** Bedrock moonshotai.kimi-k2.5
**Scope:** New wrapper (`case01-reconcile-oneoff.py`) + fixed read-only script (`case01-reconcile-readonly.mjs`) interactions with frozen base (`case01-oneoff.py`)
**Constraint:** No tools invoked; evaluation based on exact provided source only

---

### BASELINE CONFIRMED
- **Base file `case01-oneoff.py`** (SHA256: `4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a`) is frozen and was independently reviewed/tested 16/16
- **Adapter SHA** `02098e0d9209f7313a66c4e73eb0689332af2edd7ba2a2ecf6e6daa58b0671f6` is unchanged
- **New wrapper** binds to base via `importlib.util` with strict SHA verification before any code execution

---

### WRAPPER ANALYSIS: PASS

The wrapper preserves the exact `4df` lifecycle via isolated loaded module functions:

1. **Module Isolation & Binding** (lines 33-44):
   - Uses `importlib.util.spec_from_file_location` and `module_from_spec` to load base
   - Sets `m.__file__ = __file__` so base logging/reporting shows wrapper identity
   - Updates `FAMILY`, `CONTAINER`, `MODES` for reconcile-specific values
   - Original lifecycle functions preserved: `original_source_check`, `original_task_request`, `original_qualify`

2. **Fixed Input/Task/Receipts Override** (lines 46-130):
   - `fixed_files()`: Validates all three fixed files (script, input, failed execution) by SHA256
   - `source_check()`: Pinned to `SOURCE = 'c11c83fe1759183254b24d11a9087ccc89595a73'`
   - `input_binding()`: Enforces `MODE = 'reconcile-read'` and fixed `INPUT` path/hash
   - `task_request()`: Overrides container entrypoint to execute read-only script inline via `node --eval`
   - `owner_receipts()`: Validates single-receipt constraint with `MERI_CASE01_RECONCILE_RECEIPT ` prefix

3. **One-task/no-retry/durable journal preserved**:
   - No retry logic added
   - `prepare()` and `run()` flow unchanged from base
   - Journal writes via `create()`/`save()` use same filesystem atomicity
   - Verification at lines 125-127 enforces exactly one receipt (`len(entries) <= 1`)

---

### READ-ONLY SCRIPT ANALYSIS: PASS

**File:** `case01-reconcile-readonly.mjs` (SHA256: `fbfa5799b1cee3b5619af545ef3d115dfc1a19b9498374c7092e5ba3f39aded3`)

1. **Native ECS Args/Schema**:
   - Reads from `process.env.MERI_CASE01_RECONCILE_INPUT` (matches `VARIABLE` in wrapper)
   - No CLI args; pure environment-driven
   - Entrypoint set by wrapper: `['node', '--input-type=module', '--eval', SCRIPT.read_text()]`

2. **Read-only Transaction Path**:
   - Line 22: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`
   - Lines 23-25: Statement timeouts (10s query, 30s idle)
   - Line 29: Verifies `transaction_read_only = 'on'`
   - Line 65: `ROLLBACK` (never commits)
   - All queries are SELECT-only against tenant-scoped tables

3. **Imports** (lines 3-7):
   - Only Node.js built-ins (`assert`, `module`, `child_process`, `crypto`)
   - Repo-internal modules (`manifest.mjs`, `approved-memory-runtime.mjs`, `artifact-collector.mjs`)
   - `pg` Client via `createRequire` (no external network deps)

4. **Output**:
   - Single line to stdout: `MERI_CASE01_RECONCILE_RECEIPT <json>`
   - JSON structure matches `owner_receipts()` validation in wrapper
   - No secrets in output: database connection composed via subprocess, never logged

5. **No Secret Leaks**:
   - `connectionString` captured from subprocess output (line 32)
   - Never assigned to environment variable that could appear in error traces
   - Error handler outputs only `stage`, `code`, `readOnly`, `mutations`, `liveAcceptance` — no error message text or stack

---

### INTEGRATION WITH FROZEN BASE: PASS

| Aspect | Verification |
|--------|-------------|
| **SHA binding** | Base SHA checked before module load; script/input/failed SHA checked before all overrides |
| **Source lineage** | `source_check` validates `SOURCE` SHA matches expected failed execution |
| **ECS override size** | `input_binding` validates `<= 8192` bytes (line 72) |
| **Container secrets** | Only `DB_REFS` allowed; no `OPENAI_API_KEY` or provider credentials (line 103-104) |
| **Environment filtering** | Whitelist: `DB_NAME`, `GIT_SHA`, `RELEASE_SHA`, `TMPDIR` only (line 97-98) |
| **Entrypoint override** | Container `entryPoint` set to Node.js eval; `command` cleared (line 99-100) |

---

### SCHEMA VALIDATION IN RECEIPTS: PASS

`owner_receipts()` enforces strict row key sets for all tables:
- `actors`: `{'id','role','status'}`
- `grants`: `{'id','user_id','client_id','permissions','status','expires_at','unexpired','reason_present'}`
- `walls`: `{'client_id','user_id'}`
- `expectedCandidates`/`candidates`/`items`/`outbox`/`embeddings`: Exact key sets match read-only script SELECT projections

---

### CONCIS CONCLUSION

| Component | Status |
|-----------|--------|
| Wrapper lifecycle preservation | **PASS** |
| Read-only transaction safety | **PASS** |
| Fixed input/task/receipt binding | **PASS** |
| Native ECS args/schema | **PASS** |
| Imports/output hygiene | **PASS** |
| No secret leaks | **PASS** |
| Integration with frozen base `4df` | **PASS** |

**OVERALL: PASS**

Authority preserved: The wrapper composes a fixed, read-only diagnostic task using the exact reviewed one-off lifecycle. No mutation path exists; database transaction is explicitly read-only with rollback; receipts are immutable and bounded; journal durable; no provider credentials or generic command interfaces present.