# Portfolio layout source preparation

Base: private backend PR7 `9b9f98d86aebe79721b3655e5a619b27be9a43e9`, tree `8e715d78793b5e2642f67cd7bfa8c0f3c373b336`.

The parent allocated Users controller/helpers/tests, UsersModule, optional Prisma transaction isolation support/controls, Core schema, and source migration `20261014050000_user_portfolio_layout` in this separate branch. Catalog policy is awaiting the user's explicit roster-versus-wall decision. Controller binding, catalog SQL, module registration, and publication are held. No request handler or partial feature is claimed usable yet.

Prepared independent source:

- Exact three-key PUT parser with finite integer/version limits, dense unique lowercase `client:<UUID>` array, native proxy refusal, own-data descriptor snapshot, and no string coercion or normalization.
- Native row decoder and exact six-key receipt; virtual version zero exists only without a persisted row.
- Deterministic retain/remove/append reconciliation; same-order PUT increments, stale/Catalog mismatch conflicts, capacity/exhaustion fails unavailable without truncation or mutation.
- Focused Users-owned `UserPortfolioLayout` Prisma model, compound tenant/user primary key, separate Tenant/User cascade FKs, UUID array uniqueness/capacity/version source checks, reused tenant/user RLS helpers and update timestamp trigger. No schema/migration execution or generation.
- Only `PrismaService.withSystem` gains an optional transaction isolation operand; existing ordinary tenant helpers/defaults and original retry/tenant-scope tests remain intact.

Focused Jest uses roots only under Users and Prisma, no setup files, Node test environment, cached installed ts-jest with isolated transformation, and a source refusal preload. It executes actual pure functions and the actual withSystem prototype against an inert transaction port; it never constructs PrismaService, connects a pool, reads protected reporting source, runs default bootstrap/database setup, or invokes a provider. The separate strict/noUnchecked/noEmit check uses actual cached Prisma/Nest declarations. It does not qualify newly generated model metadata, native SQL/constraints/RLS, HTTP routing, session-provider freshness, concurrent transactions, restart persistence, or full Core startup.

Initial failures are preserved: the new helper spec first had an unmatched parenthesis, so its suite failed to load while 14 original Prisma cases and four new transaction controls passed; the first strict parse failed on the same typo. After correction, strict typing exposed the new fixture's widened `contractVersion` literal; the fixture annotation was corrected. These are author/test errors, not native acceptance evidence.

The final preparation checkpoint is `9d562aa0625e18733bb87a22c807d6377f8e4143`, tree `03e5e3ad4d0d680f644406421d0622bcd4d5f391`, with exactly six source paths. Focused tests: 75/75 (57 helper/schema-source cases, 14 original Prisma cases, four new transaction controls), zero skipped/pending; strict/noUnchecked typecheck exit 0; selected host refusal controls 12/12. A self-review found that the initial catalog helper called Array.isArray before refusing a revoked proxy. One permanent control reproduces the original helper failure (1 failed, 56 deliberately unselected) and passes on the corrected source. The first historical-helper replay failed on a private test-host dependency resolution error; that raw failure is retained too.

The first source commit `a2c0b6e55244bb22852c4168912a783fcc8487db` included five paths because Git declined the newly allocated migration outside the sparse pattern. The exact authorized migration was added with `git add --sparse` in append-only `32424d995f072300b0c09b61a8611c71c3e720e4`; no sparse definition or Git config was changed. Both heads remain ancestors.

Next source after the catalog decision will use the existing authority proof plus actor-bound lock supersets in one canonical system transaction. There is no auth middleware edit or new membership search/permission owner. Existing fresh Clerk reader and second pooled recheck connection remain disclosed runtime dependencies. Raw SQL will bind native tenant/user explicitly even inside a bypass scope. All final source remains subject to independent review and root draft publication.
