# Bounded child research integration

This change integrates candidate `9f1ec149cb91bde5b52a718e68bda50c0e01fe31` into the source/durable/provider foundation `c4fbb2198d3e3552dc2ee52ed1328adf732b01b4`. Meri can persist two bounded read-only leaf tasks on the existing approved research runtime. Children retain the parent tenant, user, conversation, client, run, lease, goal revision, tool allowance, and aggregate budget references; they cannot delegate or select a provider fallback.

The combined implementation retains the current coordinator and canonical source gates. Parent dispatch re-admits the current plan and goal after child execution and source reauthorization, before using child findings. Child deadlines abort pending streams and reject first completions arriving at or after the deadline. Cancellation propagates from the parent without child timeout cancelling the parent.

## PASS

- Shared/core builds, API typecheck, and scoped formatting: exit 0.
- Combined child, continuity, replay, provider-budget, and tool-budget verification: 150 tests in nine suites, exit 0, including owned native PostgreSQL CAS tests.
- The late-completion defect was reproduced against the original implementation (one failing regression: completion did not throw), then corrected. Additional tests cover child stream timeout, parent cancellation, and new goal/plan arrival during child work.
- Independent Hermes/Kimi review of the final combined source: scoped static PASS. The earlier review searched the wrong checkout and its missing-file claims were invalid; the final review used prepared source snapshots and their existence/hash manifest.

Evidence is under `C:/dev/cap-meri-foundation-evidence`: `child-integration-gates.json`, `child-integration-child-api-tests.log`, `child-deadline-before.log`, `child-conflict-resolutions.json`, `child-final-source-manifest.json`, and `review-child-final-report.md`.

## NOT RUN

Full live/offline acceptance, external provider acceptance, main integration, and deployment remain pending. No production model setting, routing, flag, shared database, or AWS resource changed during this qualification. The separate JEV experiment is not part of this implementation.
