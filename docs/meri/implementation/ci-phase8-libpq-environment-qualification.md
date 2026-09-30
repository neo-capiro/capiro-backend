# Phase8 disposable libpq environment repair

Hosted foundation7823 jobs109217518316 and109217500498 failed with `psql: error: service file "" not found`. The owned-container fixture command set empty PGSERVICE/PGSERVICEFILE/PGOPTIONS. It now removes those variables inside the container with `env -u` before the same pinned psql invocation. Host, port, credentials, identity check, prerequisite SQL and SELF_MANAGED-only write boundary are unchanged.

The actual installed PostgreSQL16 client reproduces the empty-service-file failure. With these variables absent it attempts the explicit closed loopback port1 and refuses connection, demonstrating that the redirect settings are gone without contacting or mutating a database. Probe assertions exit0: `C:/dev/cap-meri-foundation-evidence/phase8-libpq-unset-proof.json`. Bash syntax exits0. Independent Hermes/Bedrock Kimi static review exits0 with SCOPED PASS for scopeB (`review-final-ui-libpq-maintenance*`).

Verdict: PASS for the bounded repair/probe; full Docker migration rehearsal NOT RUN locally because Docker is unavailable. Hosted full-ledger/RLS acceptance remains mandatory. No production migration, role, routing or deployment change.
