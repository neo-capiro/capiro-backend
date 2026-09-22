# Federal award date semantics

Verified against the public USAspending API on 2026-09-21. The search endpoint was
`POST /api/v2/search/spending_by_award/`; details were read from
`GET /api/v2/awards/<generated_unique_award_id>/`.

## Source-field semantics

| Concept | Search field | Detail field | Meaning and observed behavior |
| --- | --- | --- | --- |
| Latest transaction action | `Action Date` | Not exposed by the detail response tested; `latest_transaction_contract_data` contains contract attributes but no `action_date` key | A valid requested contract field, but null for all three incident awards. Never substitute another date. |
| Base award signed/obligation | `Base Obligation Date` | `date_signed` | Original/base award date. The two fields matched on all three incident records. |
| Performance start | `Start Date` | `period_of_performance.start_date` | Planned/actual period-of-performance start, distinct from signing. |
| Performance end | `End Date` | `period_of_performance.end_date` | Current period-of-performance end. The detail response also has a distinct `potential_end_date`. |
| Source-record update | `Last Modified Date` | `period_of_performance.last_modified_date` | USAspending record modification/update date. Search includes time; detail observations were date-only. It is not an award action or signing date. |
| Capiro fetch | None | None | Local ingestion time (`last_synced_at`), not a source business event. |

The search endpoint accepted all five requested names for contract award types A/B/C/D:
`Action Date`, `Start Date`, `End Date`, `Base Obligation Date`, and `Last Modified Date`.
`latest_transaction_contract_data` did not include `action_date` in any detail response;
for the inspected record its key set was contract classification/procurement metadata only.

## Incident award evidence

| PIID | Resolved | `generated_internal_id` | Action | Start | End | Base obligation / `date_signed` | Last modified (search / detail) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H9222216C0078 | Yes | `CONT_AWD_H9222216C0078_9700_-NONE-_-NONE-` | null | 2016-05-24 | 2021-05-25 | 2016-05-25 / 2016-05-25 | 2021-09-21 08:05:06 / 2021-09-21 |
| W9128Z26FA001 | Yes | `CONT_AWD_W9128Z26FA001_9700_W519TC25D0039_9700` | null | 2025-10-15 | 2029-05-31 | 2025-11-21 / 2025-11-21 | 2026-05-14 13:09:08 / 2026-05-14 |
| FA880625FB009 | Yes | `CONT_AWD_FA880625FB009_9700_FA880623D0015_9700` | null | 2025-06-16 | 2027-03-31 | 2025-05-15 / 2025-05-15 | 2026-05-29 01:29:14 / 2026-05-29 |

The detail endpoint's `period_of_performance` start/end values matched search values for
all three records. Its `latest_transaction_contract_data` had no action-date field, so no
action date can honestly be inferred from detail data.

## Database mapping

| Database column | Population |
| --- | --- |
| `base_award_signed_date` | Search `Base Obligation Date` (detail/backfill may use `date_signed`) |
| `latest_action_date` | Search `Action Date` only; null remains null |
| `source_last_modified_date` | Search `Last Modified Date` |
| `pop_start_date`, `pop_end_date` | Search `Start Date`, `End Date` |
| `date_semantics_version` | `1` for corrected future-ingestion mapping; null identifies legacy rows |
| `source_record_jsonb` | Verbatim search API result |
| `last_synced_at` | Capiro fetch timestamp |

Legacy `action_date`, `awarded_at`, and `raw_jsonb` intentionally keep their exact prior
population. In particular, `action_date` and `awarded_at` still receive the old fallback
from `Action Date` to `Last Modified Date`, and `raw_jsonb` remains the old mapped object.
This preserves off-flag behavior until consumers move.

## T5 handoff

T5 must backfill the new nullable fields from authoritative source records with dry-run as
the default, leave unverifiable action dates null, and set `date_semantics_version = 1`
only for rows populated under the corrected contract. Consumer labels, serialization,
sorting, prompts, and streaming must switch to these columns only under the evidence
accuracy feature contract. T5 must not reinterpret legacy `action_date` or `awarded_at`
as reliable transaction/base dates.

## Backfill runbook

The backfill is dry-run by default and re-reads the USAspending award detail endpoint;
it never derives corrected semantics from `raw_jsonb`.

Before rolling code that reads the corrected columns, apply the T4 migration and run
`prisma migrate status` against the target environment. Do not infer success from a
completed application deploy: this repository has a known trap where a deploy can
complete while its migration was silently not applied. Migration status must show the
award-date migration applied before the consumer code rolls.

1. Preview a highest-dollar batch and produce both reports:
   `tsx scripts/backfill-federal-award-dates.ts --limit 500 --report ./award-dates-batch-1.md`.
2. Review the Markdown and JSON impact reports, including fallback suspects, date-difference
   buckets, incident awards, and the top awards' before/after values.
3. Commit the reviewed batch with an append-only snapshot taken before writes:
   `tsx scripts/backfill-federal-award-dates.ts --commit --limit 500 --snapshot ./award-dates-batch-1.jsonl --report ./award-dates-batch-1-commit.md`.
   Continue in bounded batches using `--ids` or `--since` as appropriate.
4. If the review or post-write checks fail, restore exactly the corrected columns from the
   snapshot: `tsx scripts/backfill-federal-award-dates.ts --rollback ./award-dates-batch-1.jsonl`.

`--commit` requires `--snapshot`. Writes are limited to `base_award_signed_date`,
`latest_action_date`, `source_last_modified_date`, `pop_start_date`, `pop_end_date`, and
`date_semantics_version`; legacy columns and JSON are untouched. The detail rail leaves latest
action null because that endpoint does not expose an authoritative transaction action date.
The bulk rail is explicitly not implemented.

The Stage 0 implementation was **not executed against any database**. Its required three-record
acceptance dry run used the live public USAspending detail API with `DATABASE_URL` unset.
