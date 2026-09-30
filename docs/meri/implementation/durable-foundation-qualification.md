# Durable coordinator and UI qualification

Base: `6da9414dd99c2ed78874575fe7beef7bb5659b2c`. Donor: `854d3a254ca4b4705056c795952d26ee08482491`.

The foundation now combines durable per-step coordination and editable steering/Stop/reconnect UI with provider/tool aggregate budgets and current-owner result authorization. Replay charges the canonical owner input while matching the original logical step input. Failure transitions check the current goal revision. Browser responses from an earlier account authority cannot overwrite the current observer.

PASS (actual exit 0): shared/core/strategy builds; API/runtime/web type checks; 131 API tests across ten suites, including owned PostgreSQL concurrency and local HTTP controls; 133 runtime tests across three suites; six current-authority reservation tests; 26 web tests across three suites; scoped formatting. Earlier API fixture failures were corrected by admitting coordinator state, using a priced mock model, and keeping positive-plan budget allocations consistent. Production admission and unknown-price accounting remain strict.

The late account-authority response test failed against the original donor hook (expected exit 1), then passed with the scope guard. This is separate from the passing final gates.

Independent Hermes/Kimi static review: final scoped PASS after reviewing both backend and UI, resolving the goal-revision guard finding and adjudicating the earlier concerns. Review is static and relies on the separately recorded lead test exits; it is not live acceptance or release approval. Pre-coordinator legacy cancellation retains its existing atomic terminal fence; admitted durable research uses request/observation states.

Evidence: `C:/dev/cap-meri-foundation-evidence/durable-foundation-gates.json`, `durable-foundation-api-tests.log`, `durable-foundation-runtime-tests.log`, `durable-direct-tests.json`, `durable-direct-final-gates.json`, `durable-direct-web-final.log`, `durable-account-scope-regression-before.log`, and `review-durable-final-disposition-report.md`.

Side effects: local owned temporary PostgreSQL schemas, local HTTP test server, and worker-process kill/reclaim regression only. No shared-environment provisioning, routing, migration, or deployment occurred. Full File01 acceptance, source-family/child/telemetry integration, both-main integration, owner acceptance, and deployment remain NOT RUN or incomplete as recorded in the task queue.
