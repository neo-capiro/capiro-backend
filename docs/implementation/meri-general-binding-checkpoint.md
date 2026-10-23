# Meri General binding source checkpoint

This increment adds explicit immutable `general` / `client` bootstrap bindings and current authority for General conversations. Version 1 bootstrap remains client-only. Version 2 requires an explicit scope; existing null-client prospect/research conversations are not reclassified.

The native conversation and owner-scoped idempotency receipt commit together. A receipt survives hard conversation deletion as a tombstone and cannot allocate a replacement. Tenant/actor/client/scope binding is immutable. Client deletion may clear the conversation foreign key while the receipt preserves its original client binding; that orphan is never General. The capability receipt is a short-lived UI hint and never replaces current checks at bootstrap/write.

Migration `20281023010000_meri_general_conversation_binding` is source only. Prisma's ledger remains the deployment owner. The SQL is atomic and validates expected existing definitions on rerun rather than hiding a conflicting definition. `apps/api/scripts/verify-meri-general-binding.mjs` is a disposable synthetic PostgreSQL 16 rehearsal, including two applications, failed immutable-binding changes, client deletion, conversation tombstones and tenant cascade. No shared or live database is authorized by this checkpoint.

Validation: 27 focused bootstrap and explicit General authority tests passed locally. Native PostgreSQL rehearsal is independently owned by the root lane; its result must be attached separately. The full historical authority suite and exact-base comparison are not claimed qualified here.

Remaining full-wave work is separate: versioned owner title/list/CAS/archive/30-day Trash composition; signed General read delegation and personal/firm-only memory release; runtime admission/current-authority integration; frozen gateway receiving changes; UI/browser and full build gates. This checkpoint activates none of those paths and is not a deploy-ready or complete Wave2 claim.
