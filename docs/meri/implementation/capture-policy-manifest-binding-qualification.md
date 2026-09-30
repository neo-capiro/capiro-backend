# Capture policy readback and fixture content identity

This bounded change persists the independently issued API capture policy beside its signed receipt on the existing assistant message. Native and proxy producers use the same scoped persistence owner. The existing authenticated message read path validates the pair with the canonical HMAC verifier and rechecks current synthetic tenant, member, client, conversation, user-turn and assistant-row authority before returning capture metadata. Ordinary messages retain their report authorization and do not require capture service credentials.

The fixture contract now rejects incomplete or substituted frozen inventories even when a caller recomputes content hashes. The physical-map identity is the SHA-256 of the full manifest content, not a configurable collector projection. Seed, verify and reset IDs have the form `<receipt-kind>:sha256:<contentSha256>`, with exact kind, contract version and content-hash validation. An ID authenticates neither the producer nor lifecycle completion; incomplete receipts remain incomplete.

## Remaining acceptance prerequisites

The actual synthetic identity provisioning, shared database binding writer, canonical fixture lifecycle ports, per-row availability joins, immutable deployment proof and source/effect owner proofs remain separate work. No LIVE guard is opened, no fixture completion is fabricated, no arbitrary settings mutation endpoint is added, and no shared database or external system is mutated by this change. Private HMAC material stays in process memory and is never serialized into these artifacts. Routing, production model policy, roles and readonly dispatch boundaries are unchanged.

## Validation

Validation logs and exact source hashes are retained under `C:\dev\cap-meri-foundation-evidence` with the `capture-binding-` and `capture-policy-` prefixes. A bounded independent Hermes/Kimi review uses the exact inline diff and source. Final outcomes are recorded after actual process exit; initial stale generated dependencies, default-heap exhaustion and corrected test failures are retained separately from the final run.

- PASS: 30 fixture content/provisioning/runtime tests, exit 0.
- PASS: 90 API capture/proxy tests across two suites, exit 0.
- PASS: shared and core TypeScript builds, exit 0.
- PASS: independent Kimi static source review and bounded repair follow-up, both exit 0. The follow-up report's incidental claim about copying nested receipt unknown tags is not supported or adopted: this repair only copies policy fields and its expected-write string array.
- Initial setup failures are retained: stale generated package types, Node default-heap exhaustion, and an incorrect root Jest binary path. The later two JSONB readback assertion failures were corrected by copying the typed policy object and its sole mutable string array without changing strict structural equality. Two test array-index type errors were also corrected without weakening expected-value assertions.

- PASS: exact final API TypeScript check, scoped Prettier check and Git whitespace check, all exit 0. No database, AWS, deploy or provider calls were performed by validation; only the independent reviewer used Bedrock.
