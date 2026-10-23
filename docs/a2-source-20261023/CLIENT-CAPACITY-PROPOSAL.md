# PF18 canonical capacity prerequisite — proposed allocation

The existing new-client path is not serialized across capacity consumers. A lock in the prospect conversion alone would not fix it. No capacity code or policy change is implemented in this proposal.

## Existing policy and actual writers

- `apps/api/src/config/config.schema.ts` defines `BILLING_ENFORCED`, default false; `1/true/yes/on` enables it. Keep this switch, do not infer enforcement from Stripe configuration.
- `ClientsService.createInTransaction` (`apps/api/src/clients/clients.service.ts`) reads tenant billing status/client slots and active client count, then inserts without a common capacity lock. It is used by ordinary `create` and prospect conversion. `comped` tenants bypass the limit. `effectiveClientSlots` in `packages/shared/src/index.ts` gives trialing tenants at least the existing ten-slot allowance; otherwise it uses the recorded slot count. The counted population is `status != archived`, not profileStatus.
- The same service's `bulkImport` computes `remainingSlots` once outside each row transaction and inserts directly. Concurrent creates/imports can use the same apparent remaining slot. Preserve its per-row success/error semantics and duplicate/name/funding-profile checks.
- `apps/api/src/intelligence/firm-onboarding.service.ts::importClients` directly inserts LDA clients. Its existing advisory lock covers one `(tenant,LDA id)`, not tenant capacity. It reads slot policy before the loop and recounts in each row transaction without a shared capacity lock. Preserve the firm's own-filing restriction, per-LDA duplicate lock, mapping insert and post-commit enrichment.
- `ClientsService.update` can restore `status: active` via `PUT /clients/:id`, currently without a slot check; `archive` delegates `status: archived` to it. A restore increases the same active population as create. Other examined production client updates affect canonical identity, notes, logos or the fixed enrichment fields (`naicsCodes`, `pscCodes`, `setAsideCertifications`, `cageCode`), not status/tenant. Source-wide direct insert search found these three production insert locations; scripts/fixtures are not production admissions.

## Minimal reusable transaction owner

Allocate new `apps/api/src/clients/client-capacity.ts` and focused unit/native PostgreSQL specs, plus narrow edits to `clients.service.ts` and `intelligence/firm-onboarding.service.ts`. No schema migration or new product limit is needed.

The helper takes the caller's existing transaction, tenant ID and validated `billingEnforced` boolean. It acquires a transaction advisory lock keyed only by tenant capacity, reads the current tenant billing/slot row `FOR SHARE`, and checks the active client count immediately before the consuming insert/restore in that same transaction. Reuse `effectiveClientSlots` and the existing structured 402 `CLIENT_SLOT_LIMIT` error. The advisory lock serializes all participating capacity writers; the row SHARE lock stabilizes concurrent billing/comp changes without a SHARE-to-UPDATE upgrade. A missing tenant fails through the existing tenant boundary rather than inventing an unlimited allowance.

All four entry families must use the owner:

1. `createInTransaction`: lock/check before insert, including PF18. Existing validation and returned enrichment metadata remain intact.
2. CSV import: retain per-row transactions; replace the stale local budget as admission authority with the helper for each candidate. Formatting and error collection stay with the importer.
3. LDA import: retain its existing duplicate lock/check, then capacity lock/check and client+mapping insert together. Re-read current policy per row. Keep a single consistent order: LDA identity lock before capacity lock; the capacity owner never acquires an LDA lock.
4. Status update: for an actual archived-to-nonarchived transition, acquire capacity lock, lock/re-read the current client and check one slot before update. Archive also uses the capacity lock so the active count and slot release serialize. Ordinary profile edits do not need a capacity lock. Duplicate restore of an already active row consumes no extra slot.

Do not take a tenant UPDATE lock for every admission: current prospect/resource owners hold tenant SHARE locks and client row locks, so an unnecessary tenant UPDATE lock would create avoidable order conflicts. Audit the real create/restore/import/conversion order against current client/member/resource locks and billing writers before implementation. Existing-client conversion consumes no slot and must remain independent of this owner.

## Required evidence

Root's isolated PostgreSQL gate should run actual owner functions against the final schema/Prisma client: simultaneous ordinary create and PF18 new-client conversion for the last slot; two different-prospect conversions; CSV versus LDA import; restore versus create; duplicate restore; archive then admission; enforcement off; comped; trial floor; foreign tenant; failed client/mapping/audit insertion rollback; billing/comp changes during a blocked admission. Exactly one last-slot consumer may commit under enforcement. A sequential mocked count is not concurrency proof. Native provider requests, billing changes and real database execution remain prohibited in this lane.
