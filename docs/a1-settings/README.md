# A1 Settings backend safety fixes

Base: `neo-capiro/capiro-backend` `backend-import` at `8d9958f75ba2fefe8edcf5e21a459ae97187ac8a`.

## Changes

- **ST-01:** generic branding updates accept name only. The service also rejects unknown fields for internal callers. Logo upload retains the presigned POST flow with a unique exact tenant key, signed ownership/issuance metadata and a five-minute confirmation window. Confirmation checks actual HEAD MIME, nonempty size, metadata and object identity before persistence. A tenant row lock prevents a superseded upload from replacing a later confirmed logo; same-key confirmation does not repeat the write. Signed reads suppress foreign/nonbranding/corrupt persisted keys; exact legacy own-tenant logo keys remain readable.
- **ST-02:** tenant-team removal refuses protected `capiro_admin` targets inside the removal transaction, including staff callers. The existing HQ personnel lifecycle remains the intended separate path. Current ordinary-admin membership/role is rechecked under actor/target row locks; local removal and the existing identity outbox still commit together. An already removed target returns success without repeating the removal/outbox effect.
- **ST-24 receipt support:** HQ invitation resend normalizes the requested email and verifies the provider-returned organization, recipient, admin role and nonempty invitation ID. A verified receipt includes the current tenant ID, provider recipient and normalized role; an unverified provider result returns 502 so the frontend holds the uncertain write instead of displaying success or replaying it.
- **X-04:** service negatives cover wrong tenant, self, ordinary callers, removed/downgraded admin, protected target, and corrupt storage ownership with zero downstream effects. Real Nest HTTP tests retain route guards/validation and use the actual services with inert DB/provider fixtures. Those tests start at the trusted tenant-context seam; they do not replace or claim to qualify Core authentication/session admission.

Nothing is enabled. No migrations, OAuth/token code, Core auth/session code, Meri files, AWS configuration or GitHub Actions are changed.

## Verification

All 18 new tests pass. Four existing tenant-admin audit tests also pass (22/22 total across five suites). Against the exact base, 10/12 original new service tests and all three original HTTP negative tests fail. Three follow-up tests fail against checkpoint `213374bcaec250a93805a293e3a19e51bdfab1ac`, including direct HTTP superseded-logo and unqualified HQ invitation receipt negatives. Fifteen explicit production mutations are killed; each of the 18 new tests kills at least one mutation. `validation.json` records the mapping. The same-millisecond upload fixture was strengthened after the initial constant-UUID mutant survived; the final run kills it.

The focused run used the repository-local inert ts-jest configuration, cached dependencies and one worker (1 GB Node heap). It restricts roots to branding and tenant-admin, avoiding unrelated historical files. Run:

```sh
pnpm -C apps/api exec jest --config jest.a1-settings.config.cjs --runInBand --forceExit
```

The mutation changes exercised upload UUID reuse, removal of key admission, HEAD validation, expiry, changing the finalized key, bypassing the generic service field guard, removing both generic DTO/service guards, discarding name updates, removing protected-target/current-admin/caller-role checks, replaying an already removed membership, allowing superseded logos, removing provider receipt qualification, and attributing a verified receipt to the wrong recipient. Every mutation was restored before the final 22-test green run. HQ direct HTTP also proves a nonstaff caller is denied before any provider call.

## Review and deployment gates still required

Fable owns independent review, merge and staging deployment. This source commit does **not** close the whole A1 phase or frontend ST-24.

Not run here: real PostgreSQL row-lock/concurrency qualification; full repository typecheck/build; live S3/IAM/CORS/browser upload qualification; staging/current-session and full-flow chat checks. Review existing persisted logo keys in a separately authorized operational step; this patch does not enumerate, rewrite or delete them. Old still-valid presigned URLs retain their existing five-minute expiry. Live approval and feature activation remain with Fable.
