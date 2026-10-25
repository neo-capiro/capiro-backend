# Reserved migration source â€” not a Prisma deploy directory

The original four SQL files were moved byte-for-byte from the frozen `backend-import` tree `4ac54093d3dc477e08249ded10bc7a07972637e6` (published commit `51e265bd5b5170abffb32a62ffc39a52a788fe60`). They are absent from Fable's 546 FINISHED names and their inspected Core consumers are closed under source defaults. Three remain reserved. Prospect Contacts has been promoted under root allocation to `../migrations/20281024120000_portfolio_prospect_contacts/migration.sql`; its SQL DDL is unchanged, and the superseded reserved copy is removed. This source promotion does not authorize database execution.

See [the complete inventory](../../../../docs/core-migration-cleanup-20261021/README.md) for consumers, flags, limits and the unresolved migrations still in `migrations/`. The deploy folder remains blocked; moving these four is not a claim that the remaining folder is deployable.

| Directory | Original and retained SQL SHA256 |
|---|---|
| `20281011020000_portfolio_prospect_stages` | `fc3aeb539b0e75f2c1024346eb9b745ee185474e5ba4ed8ea3ff9a02da932f78` |
| `20281016010000_client_objective_workload_delegations` | `dd762e2a5c721261525f36ac80f70b232b62fc09f0171fa3fbd5a12d4d442430` |
| `20281018060000_meri_read_delegation` | `f6f6cf95c67ba0b3b1cf15191297989fe33111d4b4e370ad0118f91740a4fabe` |

A later Neo-approved restoration packet must:

1. Name the feature, owner, exact target ledger and catalog evidence, and permitted execution environment. Reconcile pre-existing/failed objects and the contacts exact-name gap before proposing runnable SQL. Do not request secrets.
2. Re-audit current runtime gates, source defaults, generated schema use and dependencies. Workload delegation depends on retained work-consent storage; stage/contact files depend on existing prospect storage. Confirm all predecessors and migration identity/order.
3. Restore the approved directory under `apps/api/prisma/migrations/<same name>/` while preserving these source bytes/hashes. If a forward reconciliation is required, propose it separately; never silently rewrite an already-applied migration or loosen its assertions.
4. Obtain the required isolated database, Core tests and Docker/runtime qualification before any authorized execution. Merely restoring a directory is not approval to run `prisma migrate deploy`, enable flags, merge or deploy. Agents never merge or deploy.

Keep feature defaults unchanged. Do not scan or execute this reserved directory from a deployment script, include it as an alternative Prisma migration path, or automatically restore it during a build.
