**PASS**

No defects found in the implementation. All concrete source-supported assertions pass verification:

**Source contract verification:**
- **apps/web/src/vnext/meri/meri-source-api.ts:17-28**: `controlled_read` kind validation correctly requires `clientId`, `conversationId`, version `v1`, section `page 14` with UUID format checks
- **Line 35**: `conversationId` properly propagated to result object only for `controlled_read` kind
- **Line 88**: `conversationId` included in URL search params alongside `threadId`, `clientId`, `section`, `version`

**Test coverage verification:**
- **meri-source-api.test.ts:11-33**: Tests validate all locator field requirements, URL construction with `conversationId` and `section` query params, and rejection of malformed variants

**Evaluator contract verification:**
- **controlled-read-receipt-joins.mjs:125-146**: Receipt joins enforce case-specific source requirements (R2-27 for 20 with tenant-global null client, MEMO-A-LATEST for 72)
- **Lines 148-150**: Source content SHA256 matches passage SHA256 for case 20's full read; empty for case 72's error fixture
- **Lines 265-280**: Source readback validation requires controlled_read kind, exact conversationId, clientId, and section for case 20
- **grade-controlled-read-capture.mjs:19-30**: Answer checks verify exact PE code 0912345T, FY27, $42M amount, President's Budget request text, source/page link
- **Lines 37-59**: Row 72 checks verify repeated failures (3+ attempts with identical response hash), `no_progress` suppression, truthful failure disclosure, rejection of false success claims

**Authority isolation verification:**
- **controlled-read-live-capture.mjs:424**: Capability `meri-controlled-read-live-session` frozen before WeakMap storage
- **Lines 438-439**: `executeControlledReadLiveCapture` requires authenticated capability from process-local WeakMap
- **Lines 593-603**: `currentControlledReadCaptureAuthority` requires outcome from local WeakMap plus artifact integrity verification

**Setup/qualification fencing:**
- **controlled-read-owner.test.mjs:76-106**: Transactional rollback on failure verified, stale plan detection, version CAS enforcement
- **Lines 141-153**: Stale plan rejection when concurrent modification detected
- **Lines 163-171**: Revocation/altered definition rejection during qualification
- **Lines 172-185**: Case 74 rejection, duplicate run prevention, confirmation gate

**No defects found** in authentication, tenant/actor/client/run fencing, current revocation handling, truthful provenance, concurrent binding replacement, provider reserve/actual usage verification, case01/ordinary behavior preservation, or acceptance false positive prevention.