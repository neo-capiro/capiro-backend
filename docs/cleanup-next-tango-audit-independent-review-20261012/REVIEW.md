# Independent Tango preconversion evidence and design review

The bounded pure-leaf design and packet bindings are accepted with the error-realm qualification below. This is a review of original source characterization and a proposed extraction. It does not accept an application implementation, retirement, shared HTTP transport, security change, native operation or full Cleanup gate.

Reviewed author commit: `ed43dbb5bad37763688a9553680253f9b756fca1`, tree `a11b987ee629d316a7074cd0587716216137599f`. Immutable base: PR 2412 `6a4b48e6286a270ab18c033eb4ccaf6f72f42c70`, tree `f14d6fa3f191645839414972063e1057fce557bf`. The independent worktree is `/workspace/capirov2-next-tango-audit-independent-review`; all new files are under this unique documentation directory.

## Packet, source and execution evidence

The author change contains exactly **17 added documentation paths** and no application change. All **16 indexed packet hashes**, the hash index's own committed bytes, and **28 frozen source hashes, file modes and Git blobs** match their declared identities. Those 28 source blobs match both the base and reviewed author commit. The original failed envelope harness, its raw failure log, earlier passing leaf packet, and selected-model capacity failure remain byte-exact. The capacity failure produced no acceptance and involved no model override; this independent review does not erase that failure.

The two author harnesses were inspected, copied byte-exact into this new packet, and executed there. Their output JSON files replay byte-for-byte: **68 main leaf cases × 3 clients = 204**, **3 effectful header probes × 3 = 9**, and **18 envelope cases × 3 = 54**, totaling **267 original fragment executions**. Both runs exited 0 with empty stderr. They use cached TypeScript to extract actual declarations or successful-parser/catch fragments, not an implementation of the proposed helper. Their only writes are the two copied scripts' output JSON files in this independent packet. Constructors, full clients, fetch, response.text, timers, sync entrypoints, providers and databases were not executed.

The independently reproduced AST inventory proves the nine selected declarations occupy **109 lines (35 + 35 + 39)**. Count and next-page declarations are byte-identical across all three; rate declarations are byte-identical only across DIBBS/SBIR. The repeated groups occupy 84 lines, of which redundant copies account for 49; neither number predicts the final extraction's net diff. The prior rough 123 estimate is not accepted. Current rate call counts are exactly **2/2/1**, and current fetch call counts exactly **1/1/1**. See [independent verification](evidence/independent-verification.json) and [AST/source proof](evidence/independent-leaf-line-and-call-proof.json).

## Four authored malformed-envelope messages require qualification

The authored envelope VM injects the host `Error` constructor while engine-generated TypeErrors inherit the VM's intrinsic Error. The original catch checks `error instanceof Error`; that check fails for these VM errors and selects `String(error)`, introducing a `TypeError: ` prefix. In a coherent realm the same original catch selects `error.message`.

The independent [challenge](evidence/error-realm-challenge.cjs) reuses all 18 authored input factories unchanged, the exact original parser slices, error classes and catch clauses. It verifies all 54 authored VM results and separately evaluates all 54 in one coherent host realm. **50 results agree; four differ only in the message prefix**. Error class, status, rate and recorded getter effects agree.

| Client / synthetic input | Authored VM message | Coherent-realm original message |
|---|---|---|
| DIBBS / changing results getter | `TypeError: parsed.results.filter is not a function` | `parsed.results.filter is not a function` |
| SBIR / changing results getter | `TypeError: parsed.results.filter is not a function` | `parsed.results.filter is not a function` |
| Subaward / null root | `TypeError: Cannot read properties of null (reading 'results')` | `Cannot read properties of null (reading 'results')` |
| Subaward / changing results getter | `TypeError: parsed.results.filter is not a function` | `parsed.results.filter is not a function` |

The complete [54-row coherent-realm supplement](evidence/error-realm-challenge-with-full-profiles.json) qualifies these four authored rows without modifying the original packet. These are synthetic original-parser observations in Node `v24.19.0`, not engine-independent production message goldens or full transport/error acceptance. A future candidate differential must run original and candidate code in coherent realms, preserve the source and inputs, and compare the error policy as well as messages. The four unsupplemented authored messages must not be used as authoritative preconversion goldens.

The first independent challenge output remains alongside the later additive full-profile output. The independent binding verifier also initially selected an error-class constructor instead of the client constructor. Its failed source and raw log remain; the corrected verifier selects the named client class and uses the capacity receipt's actual `modelOverride` field. No production source or assertion expectation was changed to fix these tooling errors.

## Bounded proposed seam

The proposed owner `apps/api/src/external/tango/tango-rest-page.ts` and its new spec can own only `asCount`, `nextPageOf` and profile-preserving `rateOf`. The only proposed existing application consumers are the three current REST client files. Reuse `TangoRateMetadata` from the existing error owner; add no service, store, dependency or transport. This proposes five application paths and accepts no edits to them.

Explicit literal rate profiles are required at all five calls: DIBBS/SBIR `interleaved`, Subaward `captured`. Independent assertions check the exact stable object coercion traces, early-throw traces and mutation-sensitive values. DIBBS/SBIR get/coerce each numeric header in sequence; Subaward gets all four before numeric coercion. The first throwing coercion therefore occurs after 2 trace events versus 5. A coercion that changes later gets yields limit 1 versus 0. Valid `Headers#get` values agree in the recorded corpus, but these malformed inputs expose real ordering differences that the extraction must preserve. Repeated `get` property lookup and receiver binding remain observable; no prebinding, module-time sampling or retained mutable state is proposed.

Count conversion and rate conversion have separate policies: a null count becomes 0, while a null numeric rate field becomes null. Preserve finite/truncation/clamping rules, inherited values and coercion throws. Next-page parsing returns only the positive integer page; it does not fetch or follow a supplied URL. Its existing other-host, HTTP, opaque and prototype-looking inputs are compatibility observations, not host authorization decisions.

## Untouched boundaries and remaining gates

The constructors and class bodies are frozen source, including key trimming, base/default capture, timeout and fetch capture timing. Their configured check, URL construction outside the try, exact GET/auth headers, one fetch per call, per-call abort notification, finally cleanup, own error identities, success-envelope distinctions, repeated-secret redaction differences and no client retry remain outside the extraction. No new hardening or security acceptance is inferred. The coherent supplement executes only successful-parser/catch fragments; it does not execute constructor, non-OK transport or abort paths.

The existing DIBBS and SBIR sync callers retain their own typed-429 retry wrappers, five retries after the initial attempt, retryAfter/resetIn/default-35-second choice and 120-second cap. DIBBS additionally retains its request-attempt count and per-endpoint request budget. Subaward has no retry wrapper. Diagnostics retain their construction and no-retry behavior; the SDK/resilience path has separate breaker, retry classification, accounting and rate semantics and is not a compatible replacement for these REST leaves. All caller, dispatcher, package, configuration, SDK, existing test and plan source blobs in the author preservation index are unchanged. Existing client/sync/probe/diagnostic specs were inspected/inventoried; they were not run by this evidence/design audit.

Parent retirement-map/path coordination is still pending. Candidate implementation, same-change root-owned canonical-consumer/data ratchets and CI, independent adversarial candidate review, applicable inert existing specs and strict checks remain gates. This audit does not verify the root's separate Strategy-only guard or extend its profile to Tango, accept any application conversion, retire any source, compose another source candidate, or claim native PostgreSQL/RLS/provider/model/security/full-gate acceptance. No parent-coordination answer is inferred from elapsed time.

## Reproduction

Run from this independent worktree with the existing cached dependencies; each command below writes only its indicated files in this packet. The author harnesses are exact copies of reviewed source and were inspected before execution. The verifier's Git subprocesses only read source objects.

```sh
node docs/cleanup-next-tango-audit-independent-review-20261012/evidence/author-replay/original-leaf-differential.mjs
node docs/cleanup-next-tango-audit-independent-review-20261012/evidence/author-replay/original-envelope-profiles.mjs
node docs/cleanup-next-tango-audit-independent-review-20261012/evidence/error-realm-challenge.cjs
node docs/cleanup-next-tango-audit-independent-review-20261012/evidence/verify-frozen-packet.cjs
```

The [receipt](RECEIPT.json) binds the executed commands and exit statuses. [SHA256.json](SHA256.json) covers every new packet file except itself; exact committed head/tree are supplied after this evidence-only commit.
