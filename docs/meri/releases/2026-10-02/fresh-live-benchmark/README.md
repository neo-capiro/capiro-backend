# Fresh live benchmark — October 2, 2026

The user explicitly requested a rerun and then a fresh independent run. **Five live memory cases were collected through the deployed authenticated Meri API.** All five preserved one prompt/one answer, verified unchanged canonical memory before/after, and settled against the actual server provider ledger. These are live model results, not offline fixture outputs.

**Confirmed findings:** case02 omitted the pending SMS proposal that Pat can read. Case03 appended an unrelated fiscal-year budget-delta warning to the proper name “Office Delta.” The first is a failed original row assertion; the second is a coverage relevance defect. Full original acceptance is not claimed.

| Case | Observed result | Budget-accounted cost | Evidence |
|---|---|---:|---|
| 01 | Monthly/FY/stage/citations/owner returned; current record and canonical version hash verified. | $1.490802 | [saved answer](case01-capture/messages-after.json) |
| 02 | FAIL: pending SMS proposal omitted although the same ordinary actor can read it; not asserted as approved. | $1.503301 | [saved answer](case02-capture/messages-after.json) |
| 03 | Revoked memory not recommended or cited; unrelated fiscal-year delta footer reproduced. | $3.086726 | [saved answer](case03-capture/messages-after.json) |
| 04 | Monthly is current; older weekly schedule is not presented as current. | $1.499326 | [saved answer](case04-capture/messages-after.json) |
| 05 | Aster-only saved citations and inspected response; no Bluehaven name or negative IDs observed. Full client-wall acceptance remains incomplete. | $2.261126 | [saved answer](case05-capture/messages-after.json) |

Total accounted provider usage: **$9.841281**, under the fresh **$30 aggregate / $15 per-case** ceilings, concurrency1. All five reservations settled; none remain unknown in this new run. The figures use the reviewed conservative rate sheet and are not billing statements. Prior-run unknown billing and journals remain separate and unchanged.

## What actually ran

- API515, source `6be5a560d5addaa1844f0687898c34a249089f76`; orchestrator105, source `7c04ca368fbccc84d33c720ce7a20b9201bf6e99`; WebVNext388, source `78ad5805679a3045b1fc10fb19beafa7f76e4e64`. See saved release inspections and image pin in the one-off definition.
- Ordinary `standard_user` Pat in synthetic T1, Aster selected. Existing canonical MA1-v2, pending MA2, revoked MA3, superseded MA1-v1 and client-wall corpus were read and preserved. No fixture seed, reset, approval or projection was run.
- New owned conversation for each case; existing `executeMemoryReadCase` transport/recorder, existing synthetic budget installer, and real `createMemoryReadServerBudgetReader` settlement. Original prompt text was unchanged. Each stream POST ran once, without retry.
- Requested Standard, model `gpt-6-astra`; existing automatic escalation may select Deep/high for relationship/comprehensive queries. Per-turn metadata and actual provider calls are retained. No model, flag or service deployment was changed.
- Short-lived synthetic logins were created using the existing AWS-configured Clerk secret and revoked. No credentials are saved. Temporary DB-only ECS operator tasks are stopped and their task definition deregistered; no ECS service was updated.

## Findings and limits

1. **Pending governance state not surfaced (case02).** [Authenticated ordinary proposal readback](case02-pending-authority-readback.json) shows current MA2 `dc61a9a5-5130-5c67-a7e8-19906259c34f`, pending and unrestricted. The answer only says no approved SMS preference was confirmed. [Assertion review](case02-review.json). Retain the failure while distinguishing chat/governance integration from the synthetic delegated-tool restriction during repair.
2. **Office Delta misclassified as a budget delta (case03).** The standalone `delta` expression in `packages/meriv2-core/src/assurance/evidence-plan.ts` creates an essential budget comparison requirement; the footer appends it despite no financial comparison being requested. [Review and actual evidence](case03-review.json). Five additional delegated tools returned errors consistent with the existing synthetic budget guard, which admits only `search_memory`; this is not proof of mailbox/provider outages. Initial context retrieval is separate.
3. **Current version is verified despite a stale fixture title.** Citation `content:` hashes deliberately bind snippet text, NUL, and canonical memory-version. This recomputation matches MA1-v2. The displayed `APPROVED-MA1-V1` title is copied from the original fixture title, not evidence that weekly/superseded content was retrieved. [Exact join](case01-citation-review.json).
4. **Observed client scope held in case05.** The saved answer, citations, trace, manifest and context packet contain no Bluehaven name, client ID or negative memory ID. The two citations identify Aster and its current MA1-v2. This does not prove all client-wall assertions. The client citation has no passage, so active/profile-field claims remain unverified by passage review. [Scope review](case05-review.json).

This first batch does not complete the original 75 cases, CD7, CW8, mode/JEV variants/repeats, full effect audit or human rubric. The runtime semantic clock was not overridden; the original September26-noon frozen-clock requirement is still unproved. Do not count `COLLECTED_NOT_GRADED` or these 15 capture checks as original-case acceptance. Cases01/03/04/05 remain incomplete, case02 has a known failed assertion, and cases06–75 have not run in this batch.

All machine details, saved answers, canonical proofs, stream events, current terminal ledgers, cost settlements, task receipts and cleanup are preserved here. [Machine summary](summary.json), [fresh spending journal](fresh-spend.jsonl), [artifact hashes](index.json). The earlier C0 and historical evidence remain unchanged.
