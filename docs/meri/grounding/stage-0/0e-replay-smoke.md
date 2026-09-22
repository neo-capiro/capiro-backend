# Stage 0e replay smoke run

Offline replay was run against `jev_claim_evidence_fixture_v1` with an empty recording store.

- Cases: 24 (12 tuning, 12 held-out)
- Jev replay misses: 24, each represented as `not_checked` / `no_recording`
- Legacy path: deterministic injected skeptic stub
- Output hash: `d487cfa16049098d`
- Estimated Jev input cost: $0.00000000
- Network calls: none
- Live mode: not run (no credential and no authorized shadow recording)

Command:

`pnpm --filter @capiro/meriv2-core eval:jev-replay -- --store tmp/empty-recordings.jsonl --output tmp/jev-smoke`

The raw results remain an uncommitted local smoke artifact; only this summary is committed.