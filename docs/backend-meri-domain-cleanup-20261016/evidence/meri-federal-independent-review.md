# Independent source review: Meri federal-legislation extraction

**Result: clear within the frozen three-path source scope. No concrete regression found.** This review does not establish native test, typecheck, application startup, image, deployment or live routing acceptance.

Reviewed current files against sealed PR32 `0483963adc5382202408e8398d8b1601f53d8525`, original `meri-tools.service.ts` blob `32a7a744ba9ab812337baaf6093a37540864333b`. Reviewed the pre-edit map and `meri-federal-implementation.json`. Only this review document was written; no production edits, Node, tests, parser or compiler were run.

## Independent preservation checks

Read the original Git object as raw stdout bytes and decoded UTF-8 explicitly. The original is 415,221 bytes, SHA256 `03052d70373c65f935c0885103a946123a621bd7898e023b45b9ddf10da5f267`, matching the manifest. This avoids Windows default text-decoding changes being mistaken for source differences.

Compared complete finite method blocks with ordinal text equality, including comments inside bodies, SQL indentation, template text, parameter bindings, return shapes and error strings. All seven comparisons passed after allowing only the five allocated `private async` → `public async` declaration changes:

| Method | Original inclusive lines | New domain inclusive lines | Result |
| --- | --- | --- | --- |
| `resolveBillId` | 3636–3642 | 56–62 | Exact declaration/body |
| `searchCongressBills` | 3702–3766 | 64–128 | Exact except visibility |
| `readBillText` | 3828–3954 | 130–256 | Exact except visibility |
| `locatedBillText` | 3961–4018 | 263–320 | Exact declaration/body |
| `getBillStatus` | 4020–4155 | 322–457 | Exact except visibility |
| `searchFloorVotes` | 4161–4317 | 459–615 | Exact except visibility |
| `searchCboCostEstimates` | 4323–4364 | 617–658 | Exact except visibility |

The four input declarations also compare exactly to the original after adding only `export `: `UUID_V4_RE`, `requiredString`, `optionalString`, and `clampInt`. Both owners import the same canonical bindings from `meri-tool-input.helpers.ts`; the old local declarations are removed. UUID v4 matching remains case-insensitive/nonstateful, and the scheduler's remaining uses bind that imported regexp. Required/optional string slicing, exception identity/message and numeric finite/truncation/clamp behavior remain unchanged.

## Construction and compatibility

- Legacy `MeriToolsService` constructor lines 367–410 are exactly equal to original lines 395–438, including positional and optional dependency order. No field initializer or constructor-time domain construction was introduced.
- Five private legacy facades remain at current lines 3660, 3724, 3728, 3736 and 3744, retaining their input signatures and async boundary. Each constructs the domain on invocation and delegates only its matching method.
- The domain constructor at lines 46–49 only assigns `prisma` and `ldaIntel`; dependency imports are type-only. It performs no calls, I/O, configuration resolution or provider registration. The sole domain dereference of `ldaIntel` is the unchanged Congress-discovery fallback at line 114.
- Existing prototype-only CBO harness (`meri-cbo-tool.spec.ts:10–18`) passes an object with only `prisma`. Its facade reads an absent `ldaIntel` as `undefined`; the plain domain constructor stores it without dereferencing it, and CBO itself uses only Prisma. The extraction therefore does not create an eager LDA prerequisite for that path. This is a source argument, not an executed test result.
- Cursor revision/hash binding, base64url admission, parameterized SQL, ordering/limits, surrogate-safe paging, provenance/coverage fields, status/no-vote honesty, ambiguous-member refusal, LIS crosswalk and absent-CBO responses are unchanged by the exact body comparison.

## Registry and authority preservation

Additional complete finite-block comparisons passed:

| Boundary | Original lines | Current lines |
| --- | --- | --- |
| Constructor | 395–438 | 367–410 |
| Schemas, authenticated execution, registry and domain dispatch | 439–3629 | 411–3601 |
| State-bill resolution/live fallback | 3644–3701 | 3602–3659 |
| FedRAMP handler and inherited surrounding comments | 3767–3827 | 3663–3723 |

Thus the five dispatch keys still invoke their existing facade names (`2614–2619`); RP current-use authorization closure (`2557–2565`), Florida/LegiWatch delegation (`2588–2599`), schemas and ordinary execution entrypoints are unchanged. No new dispatch route, schema, capability or authority field is introduced by the plain internal domain class. The previously misplaced bill-status comment adjacent to certification remains unchanged rather than being opportunistically corrected.

An exact-path `git diff --name-only 048...` returned no changes for the local dispatch selector, Meri controller/module, governed tools proxy, RP transport, research producer/replay/provenance consumers, bill-text owner, native status/CBO/source-family specs, or shared index/read-outcome contracts. The legacy callable facade retains the existing constructor/prototype/current-domain consumers; no test IDs or mocks were rewritten to force acceptance.

The facade diff contains only the two new imports, moved bill-text/shared imports/type/input declarations, seven allocated moved methods, and five short delegates. `git diff --check -- apps/api/src/meri/meri-tools.service.ts` returned exit 0.

## Frozen file identities and remaining qualification

Independent SHA256 reads match all three implementation-manifest entries:

- `apps/api/src/meri/meri-tools.service.ts`: `d71aaba113fdd4b84466ef820821b5db5e1aa60a2d679da8cb38e04e955d6372`.
- `apps/api/src/meri/meri-federal-legislation-tools.ts`: `95de3fe70064ebcd664e1b30362f4d81c946a3d157602c0495669884c691a0f0`.
- `apps/api/src/meri/meri-tool-input.helpers.ts`: `a21c1ac62814eb7991b3a5cb19b448086173bd0aa6c473a86e707e898052d8fe`.

No source-review blocker identified. Root still owns queued focused native/type/source qualification and integration review. This review does not promote public domain method visibility into a new external API, claim all Meri behavior qualified, or authorize broader raw-loop/provider retirement.
