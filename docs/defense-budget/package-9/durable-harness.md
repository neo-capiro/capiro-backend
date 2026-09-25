# Package 9 disposable database qualification harness

Run from the repository root with:

```powershell
pnpm --filter @capiro/api qualify:package9:durable
```

The runner starts a uniquely named `pgvector/pgvector:pg16` container, publishes PostgreSQL on a dynamically assigned loopback-only port, creates a random local password, applies the current `apps/api/prisma` migration ledger, and removes only the container bearing its unique run label in a `finally` block. It mounts no volume and does not use `capiro-postgres`, AWS, paid providers, or external source/provider services. The migration command receives a fresh container-only `DATABASE_URL`; any inherited URL is overridden.

It seeds 100 synthetic outbox rows across RDT&E, procurement, O&M, and MILCON. It uses the production Prisma outbox repository SQL and production drain worker with a local `pg` driver adapter. Evidence and logical-notification identities are written transactionally into separate synthetic append-only ledger tables. The harness then:

- kills a child worker after the evidence/notification transaction commits and before outbox acknowledgement, verifies the durable row remains leased, advances the test clock past lease expiry, and recovers it;
- holds a stale worker after its evidence commit, reclaims its expired lease with a replacement worker, and verifies stale acknowledgement is fenced;
- runs bounded retry/recovery subruns for a transient source outage and local provider timeout, 429, malformed response, and 5xx;
- drains the remaining rows with four concurrent workers and reconciles all 100 stable fact IDs and notification keys from PostgreSQL.

The generated run report is written under `docs/defense-budget/package-9/evidence/` and contains raw repository/fixture query timings, queue state samples, scenario results, worker concurrency, and ledger reconciliation. Timing records are local elapsed samples; they do not establish common interactive query p95 or sustained production latency.

## Retained deployed-revision run

The retained [`PASS_LIMITED_SCOPE` report](./evidence/durable-run-p9-20260925024117927-2c727e.json) is bound to deployed source revision `8d50b9671f01fc034ec712dc7696e9fe3b1c08d0` and has SHA-256 `2b6adbffe6cfb4ee048901e30314d313cb31121aa77388418337e1bf01f6aeeb`. All eight declared local recovery scenarios and four measured reconciliation checks passed: 100 evidence identities, 100 logical notification keys, no missing identities, no duplicate logical keys, a 100-row peak, and at most four concurrent workers. Its 651 database-operation timing samples are harness diagnostics only, not the product-query or sustained-load latency gate.

## Explicit limits

This harness tests local durable database transitions and synthetic evidence/notification identity behavior. The bridge and readiness ports are local stubs; it does not execute source adapters, model/provider SDKs, real notification delivery, canonical publication, or buyer workflows. A run does not measure or qualify sustained 30-minute throughput, oldest-age alarms, alarm receiver delivery, projection/routing rollback, AWS cost, paid-provider economics, independent accuracy, or buyer outcomes. Those fields remain `NOT_RUN` in every report. A limited-scope pass cannot change Package 9's release decision from `NO_GO` or permit activation beyond shadow-only.
