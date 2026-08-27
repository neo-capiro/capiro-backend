# Advocacy History historical backfill

Advocacy History backfill runs inside the existing durable Fill completion task. Progress is stored in the existing `advocacy_history` source cursor under `watermark_jsonb.backfill`; the existing incremental watermarks remain separate top-level fields.

| Source                   | Historical capability and safe first-run horizon                               | Bounded unit                                                              | Checkpoint and completion                                                                                | Failure and confirmed mappings                                                                  |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| LDA                      | Full history held in `lda_filing` for the run's `selected_lda_ids`             | 250 filings and the shared 200-finding budget                             | Oldest-first `(scanAt, filingUuid, activityIndex)`; complete after the final short page                  | Query failure is `partial`; the selected LDA identity mapping remains authoritative             |
| FARA                     | Full canonical table evaluation                                                | 50 best role-aware candidates                                             | No cursor; one successful bounded full pass is complete                                                  | Query failure is `partial`; confirmed registration numbers bypass similarity                    |
| Testimony                | Full locally synced witness history                                            | 500 witness rows and the shared finding budget                            | Existing `(synced_at, hearingId::witness)` scan frontier; a final short fully examined batch is complete | Query failure is `partial`; confirmed compound keys use the cursor-independent bypass           |
| Regulations.gov          | Exact-phrase client search, not a corpus crawl                                 | One 10-result search page plus bounded detail fetches per invocation      | `nextPage`; complete at the reported end, or `partial` at the explicit 250-result product cap            | Missing key/timeouts are `partial`; confirmed comment IDs still bypass search                   |
| Client submissions       | Full tenant/client history                                                     | 100 rows and the shared finding budget                                    | Oldest-first `(created_at, id)`; final fully examined short page completes                               | Query failure is `partial`; canonical client records need no identity confirmation              |
| Private evidence         | Full accepted relationship-finding history, without copying bodies/transcripts | 250 rows and the shared finding budget                                    | Oldest-first `(applied_at, id)`; final fully examined short page completes                               | Tenant-scoped read failure is surfaced; accepted relationship evidence is already client-scoped |
| Federal Register         | Only docket-linked Matters with attributable evidence                          | 50 eligible Matters; existing suggestion method caps each at 50 documents | Matter-ID keyset; final short page completes                                                             | Source failure is `partial`; suggestions remain review-only with `causationClaimed:false`       |
| Bills / Program Elements | Not advocacy evidence; Matter anchors only                                     | Existing manual link operation                                            | No historical discovery checkpoint                                                                       | Existing mandatory manual rationale is unchanged                                                |

`backfill.status` is never inferred from an incremental timestamp. A source can therefore remain `in_progress` or `partial` while its incremental watermark is current. The extension task copies the per-source status, availability/error, examined count, candidate count, checkpoint, limitation, and completion time to `output_summary_jsonb` for the existing Fill UI/API contract.

## Incremental refresh and source health

Manual refresh and the existing `client_profile_fill_schedule` sweeper enqueue the same
durable Fill workflow. A completed historical checkpoint is never reset. Continuously
growing sources resume from their top-level live frontier; FARA performs its inexpensive
bounded canonical re-evaluation; Regulations.gov repeats the bounded client-scoped search
while reusing cached details; and Federal Register correlation evaluates only new or changed
docket-linked Matters after historical coverage completes.

Each source state also stores `availability`, `lastAttemptAt`, `lastSuccessAt`, `freshness`,
and `nextRefreshAt`. Failures preserve the prior successful timestamp and completed
historical status. Freshness is derived from the configured client schedule cadence:
continuously growing activity sources tolerate one cadence, while the low-frequency FARA
and Federal Register sources tolerate two. The API exposes the normalized contract through
`GET /clients/:clientId/fill-with-meri/advocacy-history/health`, including conservative overall
health, historical limitations, and pending/accepted/rejected Advocacy finding counts.

Schedule claiming is an atomic `UPDATE ... FROM` of due rows. This reserves the next due
time before the transaction releases its row lock; the existing active-run lookup then
provides a second idempotency guard for manual/scheduled overlap. Source errors are caught
inside the Advocacy task, so a Regulations.gov or FARA outage degrades only that source and
does not roll back successful LDA, testimony, client-submission, private-evidence, or Federal
Register progress. Task-level failures retain the existing bounded three-attempt exponential
backoff.
