# Phase 0 evidence index (immutable)

Created 2026-09-19 during the Phase 0/1 closeout. The Phase 0 evidence was **not modified**; this index describes it and makes it tamper-evident.

## Integrity

`evidence/SHA256SUMS.txt` lists a SHA-256 for each of the **179** evidence files across **10** run folders.

Manifest digest: `3f17214d04c6fc3816fa413104be5d0b4dd75fc3483e177651c9c06e0a62956a`

Verify at any time from `docs/meri/hermes/phase-0/evidence/`:

```
sha256sum -c SHA256SUMS.txt
```

A failure means an evidence file changed after this index was created and any claim resting on it must be re-established.

## Which run is authoritative for which check

Several checks failed on a first run, were fixed, and were re-run. **The later run is authoritative**; earlier folders are retained deliberately because they contain the original failure, which is itself evidence.

| Area | Checks | Authoritative run | Superseded / prior runs |
|---|---|---|---|
| Pilot gate, spoofing, isolation, flag-off; real turn; broker read/write | CAPS, D1, D2a, D2b, D2c, ISO1–ISO5 | `2026-09-19T13-48-15-436Z` | `13-31-25-072Z`, `13-41-59-818Z` (the latter holds the observed cross-scope broker refusal that motivated per-scope workers) |
| Personality, explicit skills, worker replacement, learning probe | D3a–D3d | `2026-09-19T13-53-10-659Z` | `13-50-39-611Z` (D3a persona failure, before the render-on-every-start fix) |
| File ingestion and artifact publication | D4 | `2026-09-19T13-57-09-201Z` | `13-53-10-659Z` (D4 plugin `**kwargs` failure) |
| Clarification and native approval | D5a–D5d | `2026-09-19T14-00-17-963Z` | `13-58-39-857Z` (functionally complete; failed only an HTTP 200-vs-201 assertion) |
| Stop, detach/reconnect, fresh worker start, session isolation probe | D6a–D6c, PROBE-session-isolation | `2026-09-19T14-07-11-015Z` | `14-00-58-074Z` (D6c session-binding failure that surfaced the per-conversation session-key defect) |

## Claims in this evidence that have since been corrected

Do not cite the following without also reading the **Corrections appendix** in `checks-report.md`:

- **ISO2** records a `409 NOT_ROUTED_TO_HERMES` refusal. That status was synthesized by the Phase 0 harness server and does not exist in shipped code (correction C1). The finding — an outside tenant cannot reach Hermes — stands; the status code does not.
- **D3d** is an *observed* probe, not a pass. Automatic background learning was never triggered (correction C3); it is Phase 2B.
- **D2b** shows a memory *proposal*, not a saved memory (correction C6).
- Any statement that run/event state is in-memory-only is superseded by the Phase 1 durable store (correction C4).

## Re-verification performed during closeout

The pin did not move, so Phase 0's compatibility checks were not re-run wholesale. The pinned build was re-checked live against the retained worker image `meri-hermes-worker:v2026.9.14-meri`, and the results are stored separately in `../phase-1/evidence/pinned-build-recheck/`:

- `/health` → `{"status":"ok","platform":"hermes-agent","version":"0.21.3"}` — pin intact.
- `/v1/capabilities` → matches the Phase 0 feature set, including `run_steer: true` and durable `runs_idempotency` with 86 400 s retention.
- `/v1/skills` → **HTTP 500**, reproducing the Phase 0 finding that skill listing is broken on this build.
