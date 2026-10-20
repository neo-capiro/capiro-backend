# History-aware migration readiness for the sole shipping owner

Source pin: PR18 `91399fe1a205e37073cbeed2d7eb66a1fafd7fa2`, tree `b600ec81b333a41338bc94db0680bf5cb239c73a`. This is a read-only query/decision handoff. No SQL, Prisma command, DB connection or Docker operation ran here. All migration source names/bytes and first-chat owner pins remain unchanged.

## The five failures and where they came from

Core's existing yearOffset2/tolerance7 policy fails these names against old-main source frontier `20281008040000_federal_evidence_passage_search`. Each also sorts before that frontier. Source policy evidence is the retained [original receipt](../cleanup/core12-old-main-timestamp-policy.receipt.json).

| Name | Source history | Relative to PR17/18 |
| --- | --- | --- |
| 20261007010000_newsletter_outreach_format | Present in backend-import c76; first-add ancestor a247f7a02a9b94d95e9ee5a516b396202aea994b,2026-10-12 | Unchanged |
| 20261007020000_newsletter_review_email_delivery | Same preexisting import/ancestor | Unchanged |
| 20261007030000_newsletter_invitation_email_delivery | Same preexisting import/ancestor | Unchanged |
| 20261007040000_newsletter_account_invitations | Same preexisting import/ancestor | Unchanged |
| 20261014050000_user_portfolio_layout | Added by successor PR10, commit47213eb8924016f444c73c53cfbee47c0349a282,2026-10-14; absent c76 | Unchanged |

The other seven Core additions pass that source policy. Against backend-import c76, eleven Core names are already grandfathered and only layout is new. This is an allocation/source distinction, not proof any SQL was applied. PR17/18 introduced no migration SQL/name changes. All12 Core and13 Workspace histories remain **UNKNOWN** until the owner supplies authoritative results.

## Three query files; no business data

1. Run [discover-ledger.sql](discover-ledger.sql) independently with each service's existing authorized authoritative DB connection. Confirm its actual DATABASE_URL database/schema against the discovered ledger; neither source schema hardcodes a migration namespace. Do not assume public, separate physical databases, or the first returned table. Discovery records target/user/schema, replica status, SELECT/schema privilege and RLS visibility flags. Missing/ambiguous ledger, permission failure, filtered visibility or replica-only evidence means UNKNOWN.
2. After verification, replace the quoted `__VERIFIED_LEDGER_SCHEMA__` identifier in [core12-history.sql](core12-history.sql) or [workspace13-history.sql](workspace13-history.sql). Use only an existing SQL client/role; no new permissions/credentials. These files use one repeatable-read read-only transaction, local10s statement/1s lock bounds and end with ROLLBACK. Stop on errors; retain errors as evidence. No temporary tables, advisory locks, DDL/DML, history edits, migration CLI or raw log output.
3. Return labelled environment/service/ledger and observation time, the overview/global unfinished/duplicate-attempt results, and **every** selected match row. Matches cover exact name, stock-engine-compatible source checksums and same suffix; alternate suffix matches are candidates, not equivalent SQL proof. Preserve all attempts, finished/rolled-back timestamps, recorded checksums and logs-present boolean. Do not reduce to latest attempt or expose raw logs/connection strings.

[EXPECTED-HISTORY.json](EXPECTED-HISTORY.json) seals the exact25 name/blob/byte/checksum records. All25 source bytes independently match existing catalog SHA256 and Git blob IDs. Comparison variants reproduce stock Prisma5.22's LF/CRLF and historical unpadded checksum rendering; they change no SQL/ledger value and do not disable checksum checks. A nonmatching checksum requires the exact historical artifact, not normalization guesses. [Prisma5.22 checksum code](https://raw.githubusercontent.com/prisma/prisma-engines/5.22.0/schema-engine/connectors/schema-connector/src/checksum.rs)

The ledger snapshot is time-bounded evidence, not a lock on future runners. The owner must establish that no competing migration task is active and recheck immediately before any separately authorized deploy. A finished ledger row is not native schema/RLS acceptance or proof that a manually marked-applied script executed. Any unfinished row anywhere in the same ledger blocks the stock apply path. The engine determines unapplied work by **name**, so identical SQL under a new name can be executed again. [Prisma5.22 apply path](https://raw.githubusercontent.com/prisma/prisma-engines/5.22.0/schema-engine/core/src/commands/apply_migrations.rs), [ledger fields](https://raw.githubusercontent.com/prisma/prisma-engines/5.22.0/schema-engine/connectors/schema-connector/src/migration_persistence.rs)

## Resolution after actual history is supplied

| Observed history | Safe next source decision |
| --- | --- |
| Exact name, finished active record, compatible checksum, no ambiguity | Keep original name and SQL; stock deploy recognizes that name. Preserve actual history and qualify physical schema separately. Do not rename/reapply to satisfy an old-main naming comparison. |
| Any unfinished/failed, duplicate active completion, inconsistent timestamps or checksum mismatch | HOLD deploy/rename. Owner investigates exact historical artifact and partial effects through existing controlled recovery. This packet authorizes no repair. |
| Only rolled-back records | HOLD automatic reapplication. A rolled_back_at marker is not proof SQL effects were undone. Preserve attempts; require physical/history evidence and existing owner-approved recovery first. |
| Same SQL/checksum or suffix under another name | HOLD canonical application and global rename. Preserve the historical name/artifact and reconcile environment divergence; suffix alone cannot settle identity. Renaming the current source can otherwise run duplicate SQL. |
| No match in this target | UNKNOWN, not NEVER_APPLIED. Verify complete authoritative visibility, prior deployments/restores/retired environments and possible manual/unrecorded effects. |
| Complete current and historical owner evidence proves never attempted/applied/effective anywhere | A separately reviewed source-only allocation correction may move the five untouched scripts to unique names after the actual candidate frontier. Preserve old heads and exact SQL bytes, verify dependency order/collisions and existing policy at the real change date. No rename is implemented now. |

For that last case only, provisional source candidates are20281014010000/020000/030000/040000 for the four newsletter suffixes and20281014050000_user_portfolio_layout. They are **not reserved or implemented**. Re-evaluate actual frontier and author-date tolerance when preparing the change. Mixed histories preserve applied names; do not force every environment to share renamed files through direct history updates, deploy-time resolve/reset or guard offset changes. Any required data correction is forward/additive and independently reviewed; do not replay CREATE/backfill/GRANT statements blindly.

The immediate blocker is narrow: verified complete Core12/Workspace13 history and artifact checksums, then the corresponding conditional source allocation decision. Five source failures alone neither prove pending SQL nor justify an applied migration rename. The original failed source receipts stay intact.

The canonical first-client bootstrap proof remains at [FIRST-CLIENT-BOOTSTRAP-JOIN.md](../first-chat/FIRST-CLIENT-BOOTSTRAP-JOIN.md), with Core native actor/active owned conversation/current ACL joined to Meri's preapproved tuple. Native account/resource evidence remains separate. No new owner, store/auth layer, main merge or deployment is proposed by this packet.
