# Stage 1c paired-shadow report smoke

The offline report pipeline ran against `jev_claim_evidence_fixture_v1` with an empty live-events JSONL file and an empty replay recording store.

- Fixture cases / replay claim events: 24
- Live claim events: 0 (`No live events` section emitted)
- Jev replay misses: 24 (`not_checked` / `no_recording`)
- Rejected event lines: 0
- Output hash: `bc44827ab6fe7fb1`
- Network calls: none

Command from the repository root:

`pnpm --filter @capiro/meriv2-core eval:jev-shadow-report -- --events C:/dev/main/meri-grounding-stage0-laneb/tmp/s1c-empty-events.jsonl --out C:/dev/main/meri-grounding-stage0-laneb/tmp/s1c-shadow-smoke`

The generated JSON and Markdown remain local smoke artifacts; this deterministic summary is committed.
