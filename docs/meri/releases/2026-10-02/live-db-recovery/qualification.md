# Meri live database recovery

The live Meri mailbox read returned HTTP503 while the Aurora writer stayed at100% CPU and its8ACU ceiling. A read-only PostgreSQL diagnostic found seven source-matched congressional bill COUNT queries still active after15–42minutes. The existing application Promise.race deadline did not cancel PostgreSQL work.

This candidate adds real transaction-local SQL deadlines: both bill keyword COUNT/page routines share5seconds, with a1second pool-acquisition cap and a15second inherited profile deadline to reject late fallbacks. Mail count/page/coverage share3.5seconds after transaction acquisition. Cancellation propagates honestly; no partial mailbox result or fabricated zero is returned. Query predicates, complete term sets, result fields, tenant/user boundaries and routing are preserved.

Qualified source: `afada905649b2fb790106466bc481060d6b05793`. Root integrated65tests in8suites passed with zero skips, including2actual localPostgreSQL mailbox tests;5additional realPostgreSQL bill checks passed; API typecheck and26deterministic Promptfoo cases plus custom verifier exited0. The5root command receipts and source blob hashes are included. Both independent Hermes/Bedrock Kimi reviews completed PASS/exit0; source comments and erased test-only type corrections after review are separately bound and peer-reviewed. Offline tests are not live product acceptance.

There is no schema or migration change. The449migration files and deployed retirement contract are unchanged from source42780caa. This image remains compatible with orchestrator95 and Web388; only API runtime SQL lifetimes change. Build publication and production promotion still require source/digest-bound receipts.

Operational mitigation: root increased only the existing Aurora cluster ceiling8→16ACU, minimum1unchanged. Actualcapacity reached16 butCPUremained100% while abandoned queries persisted. This is temporary infrastructure drift fromCDKMin1/Max8. It affects bothinstances and may increase spend. No failover/reboot/provider/routing/security/migration changes were made. Roll back ceiling to8 only after the stuckwork is removed, fresh workload sustainablyfits8 and live tool checks pass. Do not reboot solely for pendingmax_connections parameter status.

Live acceptance at qualification: NOT_RUN for this new code. Beforecandidate deployment, a bounded arithmetic check in the owner's signed-in browser succeeded but one nonsense mailboxsearch still returned503. A separate exactquery cancellation operator is being reviewed; its result is not inferred here. No customer message content, credentials, auth/session state or SQLbind values are archived.

The original Foundation File01 full live acceptance is still incomplete and remains a separate obligation. Previouslyqualified postapprovalresume sourcecd19ce13 is preserved on its own branch and excluded from this urgent candidate.
