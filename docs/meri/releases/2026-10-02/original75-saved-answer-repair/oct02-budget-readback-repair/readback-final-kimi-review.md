Reviewing this patch. Key changes:

1. **meri-capture-policy-readback.ts**: Adds logic to detect budget-only turns (no signed capture policy/evidence) and routes them to a new `authorizeSyntheticReadBudgetMessageReadback` function. Also updates `validateMeriCapturePolicyPair` to allow optional `syntheticReadBudget` field.

2. **meri-synthetic-read-budget-owner.ts**: New `authorizeSyntheticReadBudgetMessageReadback` function that validates read access to saved budget-only answers by checking:
   - Actor scope (standard_user, tenant match, conversation ownership)
   - Conversation ownership via `lockOwner`
   - Receipt validation (timestamps, policyId format, hash match)
   - Qualification metadata integrity
   - Terminal state validation (completion within deadline, all attempts settled)
   - Message integrity (user prompt hash match, assistant message receipt hash match)
   - Final authority check to detect concurrent changes

3. **meri-synthetic-read-budget.ts**: Relaxes `validateSyntheticReadBudgetQualification` to accept a `Pick` type rather than full policy, enabling use in readback validation where full policy fields aren't available.

4. **Test updates**: Comprehensive tests covering expired but completed reads, expired admission denial, revoked actor, late/inflight/foreign IDs, unknown fields, and legacy signed capture expiry.

**Findings**:

1. **Strict scope validation**: The readback requires `ctx.role !== 'standard_user'` - this excludes service accounts or elevated roles from reading budget-only answers, which is correct per the "ordinary private history" semantics.

2. **Receipt time bounds**: The validation enforces `expiresAt - issuedAt <= 30 minutes` (30 * 60_000), matching the admission window. Completion must be within `issuedAt..expiresAt`.

3. **Concurrent modification check**: The final re-read of `currentCaptureAuthorityRows` with metadata hash comparison prevents time-of-check vs time-of-use issues.

4. **No fabrication of request/trace IDs**: The function correctly only uses fields retained by the accounting owner (qualification, state, terminal).

5. **Legacy capture expiry unchanged**: The test confirms `validateMeriCapturePolicyPair(policy, signed, policy.expiresAt+1)` still throws, preserving existing behavior for signed captures.

**Potential concern**: The `lockOwner` function within `meri-synthetic-read-budget-owner.ts` is not shown in the patch context but is used by `authorizeSyntheticReadBudgetMessageReadback`. Based on the reference code, it properly locks tenants, users, memberships, conversations, and clients.

**Conclusion**: The patch correctly implements read-only access to completed synthetic budget-only turns without over-privileging, maintains separation between budget-only and signed-capture paths, and preserves all existing security properties. Tests verify the edge cases.

PASS