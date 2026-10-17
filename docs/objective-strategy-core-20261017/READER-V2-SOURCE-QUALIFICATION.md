# Core Objective reader v2 adapters

Base: draft PR63 `6c97e0f993ab47d5cc5c94b8021c985b0399ef8a`.
Canonical Meri wire freeze: draft PR123
`b2f0a5d71e1c1b6a6cf79b1e9a496ad663ef641a`, tree
`3131379c8c258e1ac02b13b71524e49028598024`.

The generated `objective-reader-v2-contract.ts` consumes that exact public
contract artifact, SHA256
`d461baaaf2300aa7ffd363bc4b58295d22c437360c126884e96433e10ac16ec1`.
`qualification/emit-reader-v2-contract.mjs` verifies the frozen module/artifact
hashes before regeneration. No package manifest, lockfile or runtime asset
discovery is required.

`objective-reader-v2-jwt.ts` implements a distinct Ed25519 request signer and
verifier, canonical raw body/header/claims, bounded original request deadline
and separate issuer/key material for three purposes. It is a cryptographic
primitive: only a genuine current native/source decision and durable JTI owner
may call it. It creates no delegation or proof from caller JSON.

`objective-reader-v2-client.ts` uses fixed HTTPS routes, bounded/cancelled
response reads, strict Zod envelopes and actual canonical-owner parser ports.
It requires the same credential to be independently revalidated before and
after transport, validates observation freshness and original source/issuance
equality, and defaults closed before inspecting bindings or clocks. Historical
read expiry cannot renew original execution. Retained reads additionally
require the existing strict retained decoder. There is no generic JSON-schema
interpreter, legacy RS256 fallback or Temporal signer reuse.

Node **24.19.0**: two focused Jest suites **67/67**, scoped strict TypeScript
exit0 and whitespace checks pass. Independent review reproduced and verified
repairs for stale observations, backward clocks, disabled getters, purpose-key
reuse and inert array/byte accessors. The positive source fixture remains valid.

```powershell
node apps/api/node_modules/jest/bin/jest.js --config docs/objective-strategy-core-20261017/qualification/reader-v2.jest.cjs --runInBand
node apps/api/node_modules/typescript/bin/tsc -p docs/objective-strategy-core-20261017/qualification/reader-v2.tsconfig.json --noEmit
node docs/objective-strategy-core-20261017/qualification/emit-reader-v2-contract.mjs <reviewed-Meri-checkout>
node docs/objective-strategy-core-20261017/qualification/emit-reader-v2.cjs <new-absolute-qualification-output>
```

The explicit test-only emitter creates a new directory, records original,
rewritten and emitted hashes for eight actual source modules, and declares its
two import-only compatibility rewrites. It emits the actual new client/signer
and existing Core generation/shared-codec parsers. Meri's six
cross-repository composition tests use these emitted factories and mandatory actual
Admission/Binding parsers. The final manifest SHA256 is
`6f03cc85e9c6a33ae20b00ff2bb14b5d40fb36b16aac614d899922a0f8bcdec1`.
Meri's complete focused result is **130/130**. All credentials, storage and
authority HTTP replies are explicitly synthetic; production durability/native
identity and actual retained object capture remain unqualified.
The final Meri 130/130 rerun used its existing official ECS SDK 3.1151.0,
matching the runtime manifest, through a verified task-local read-only junction.
It supersedes the earlier 3.1141.0 resolution check. No shared install changed
and no SDK operation ran; a runtime image and live SDK capture remain unqualified.

No v2 source route/provider is mounted, and no environment flag activates it.
The actual durable Core v2 credential owner/later native adapters, genuine Meri
custody persistence, shared prepared-run splice, retained bridge and live key
pins remain integration dependencies. The Core delegation `enabled=false`
constraint and all existing authority holds remain. Existing PR53/56/v2 intake
browser contracts and default-off frontend receivers are unchanged.

No SQL/transaction implementation or historical migration changed. Preserve
the original `eef7cd1b` **39/39** PostgreSQL result; it was not rerun or relabeled.
No shared auth/session, first-chat shipping, AWS, credential provisioning,
deployment or activation change occurred.
