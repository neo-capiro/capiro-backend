# Meri File01 acceptance, simplified (October 5, 2026)

**Status:** this contract replaces the C2/C4 acceptance procedure in `01-Meri-Foundation-Closeout-Plan-2026-10-02.md`. The user directed the change on October 5, 2026:

- "make it as simple as you can while still producing a successful outcome; raise the budget anywhere as needed."
- "Use neo@capiro.ai in capiro-internal for all testing."

It keeps the same behaviors: the 75 original cases in `evals/meri/live-v1/cases.mjs` and CD-01–CD-07. It drops the per-case proof machinery that took most of the time. One Case46 attempt needed a sealed capture binding, a native hash-chained spend journal, rate evidence, a setup owner, a retirement record, a terminal readback and, at times, an API release. Five attempts in about twelve hours produced no accepted case. The synthetic fixture tenant also forced every conversation into governed capture. It is no longer used.

## 1. What a case is

Each original case keeps its behavior and pass condition. Its prompt is adapted to real capiro-internal clients and records in `evals/meri/simple/capiro-internal-cases.mjs`. For example, "Aster" becomes L3 Harris, and a synthetic program element becomes a real one. The original prompt is kept beside each adaptation.

A case passes when:

1. **All its automatic checks pass** (section 3).
2. **The user gives a pass verdict** on the saved answer (section 4).

File01 closes when all 82 cases (75 + 7) pass, or when the user explicitly accepts or defers each remaining case. The report always shows **passed / 75** and **passed / 7**.

## 2. How a case runs

There are three modes. Each case uses exactly one.

### LIVE: the ordinary product path

- **Session.** The runner (`evals/meri/simple/run-cases.mjs`) signs in as **neo@capiro.ai in capiro-internal** through a short-lived Clerk sign-in token. It refuses any other account or organization and revokes the session afterwards.
- **Turns.** It opens a conversation titled `[acceptance] case NN …` with the case's client selected and sends each turn to the endpoint the web app uses: `POST /api/clio/conversations/:id/stream`.
- **Saved evidence.** The runner saves the stream, messages, tool steps, citations and proposals.
- **Approvals.** The runner never approves or dismisses anything.
- **Clock.** Real time is used.
- **Retries.** Allowed. Every attempt is kept; the graded attempt is the latest one after the relevant fix.
- **Pacing.** One turn at a time.

### TEST: deterministic integration tests

Some cases need injected faults, worker kills, a second identity or a large seeded set. They run as integration tests of the real services in the repository suites. Production is never fault-injected.

| Case | What the test covers |
| --- | --- |
| 06 | Cross-tenant user |
| 07 | Ethically walled user |
| 12 | 500-candidate cap |
| 16 | Non-reviewer |
| 19 | Approval non-2xx |
| 25 | 45-turn constraint |
| 51 | Approval non-2xx (the proposal itself is LIVE) |
| 54 | Fetch failure |
| 56 | JEV enabled versus shadow |
| 62 | Duplicate event |
| 63 | Revoke and resume |
| 67 | Enrichment timeout |
| 71–75 | Retry, error body, stop, worker kill, provider `incomplete` |

The test account is `capiro_admin`, so it cannot stand in for the cross-tenant, walled or non-reviewer users that 06, 07 and 16 need. These cases move to LIVE if the user later provides such an account.

## 3. Automatic checks (`evals/meri/simple/checks.mjs`)

| Check | Rule |
| --- | --- |
| Operation | **read:** zero proposals. **Write kinds:** exactly one proposal, plus one effect after the user approves. |
| Terminal state | Each turn ends in an allowed state. An honest partial answer is accepted only where the original case allows it. |
| Scope | The answer does not name other workspace clients unless the prompt asks about them. After a client switch, the previous client is not used. |
| Citations | Answers that rely on workspace knowledge cite it. |
| No false completion | No claim that an action happened when nothing was executed. |
| Downloads | A displayed link downloads the expected content. |

## 4. Human review

The user reviews saved answers in batches, one family at a time. For each case the review page shows:

- the original and adapted prompts;
- the pass condition;
- the answer and its citations;
- the automatic check results.

The verdict is **pass** or **fail**, with an optional note. The five rubric dimensions are shown as guidance only. Only the user's verdict counts; automation never records one.

## 5. Data

- **Read-only cases** use real clients and records:
  - L3 Harris is the primary client (most approved memory);
  - Anduril is the second client for scope checks;
  - federal budget, bill, opportunity and web cases use real records already in Capiro.
- **State-changing setup** uses only the test client **ZZ-QA-Meri1651-Test-DoNotUse**: pending, revoked or superseded memory, memory review, uploads and exports. Real client records are never changed.
- **External effects:** a proposal that would reach an outside party (email, invite) is never approved; the case is graded on the proposal and on the refusal to act without approval.

## 6. Budget

There is no per-case cap. Each turn's provider cost is estimated from its `usage` event at the settled gpt-6-astra rates and reported after every batch. The native spend journal (`fresh-spend.jsonl`, event 49, $44.71 committed) is preserved unchanged as history and is no longer extended. The user authorized raising the budget wherever needed (October 5, 2026).

## 7. Order

1. **Batch 1:** memory and scope (01, 05, 08–11) on real clients.
2. **Batch 2:** memory lifecycle and in-Meri review (02–04, 13–15, 17–18) on the QA client.
3. **Batch 3:** budget/PE (20–24, 26–27), bills (28–34) and opportunities (35–39) on real records.
4. **Batch 4:** files and artifacts (40–46, including the Case46 export with approval and download), meetings (47–51), web and JEV (52–53, 55, 57–58), research (59–61), BD (64–66), district (68–70).
5. **Then:** CD-01–07, and the TEST-mode cases.

After each batch: fix product failures, rerun the failed cases, then send the batch's answers for review.

## 8. Deferred (unchanged requirements, later stage)

- Three-times repeats.
- Standard versus Deep variants.
- CW-01–08 and M01–M20.
- The 26 offline historical cases.
- Trace-join and latency/cost targets.

These stay recorded in the closeout plan. They are not part of the 82-case denominator.
