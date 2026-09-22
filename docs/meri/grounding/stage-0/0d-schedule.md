# Deterministic schedule arithmetic

Stage 0 moves deadline arithmetic out of model prompts and into `@capiro/shared`.

## Deadline semantics

- An explicit datetime is preserved as an ISO instant. Its `basis` is `explicit_datetime`; `timeZone` is present only when the source supplies a named zone.
- A date-only federal deadline means the end of that calendar date in `America/New_York`, including daylight-saving transitions. Its `basis` is `date_only_end_of_day`. Callers may supply another IANA zone when the source states one.
- Missing, invalid, rolling, continuous, or TBD text is never guessed. It produces null normalized fields and `basis: unknown`; serializers retain the source's raw text.
- `daysRemaining` and `status` use the caller/envelope `asOf`, never an internal serializer clock. A deadline is open through its exact normalized instant.

## Validation

`validateSchedule` returns deterministic issues:

- `deadline_passed`: a deadline precedes `asOf`.
- `milestone_after_deadline`: a milestone falls after the earliest applicable deadline.
- `milestone_before_as_of`: a milestone is already past.
- `order_conflict`: a milestone is scheduled before one of its dependencies.
- `insufficient_runway`: the available interval cannot contain every supplied milestone.

`proposeFeasibleSchedule` works backward from a deadline. When the requested offsets exceed the available runway, it scales them proportionally and reports that compression. A passed or invalid deadline is infeasible and does not manufacture milestones.

## Rollout and T10

Structured tool deadlines and action-plan feasibility are additive only when the Stage 0 evidence-accuracy mode resolves to `enforce` for the tenant and `chat` surface. Off and shadow retain legacy payloads. T10 can consume normalized deadline facts, validation issues, and proposed schedules during synthesis instead of asking the model to calculate dates.

## Synthesis constraints and correction notes

When evidence accuracy is enforced, research/chat synthesis receives a deterministic line beginning
`Schedule constraints (computed): today=<YYYY-MM-DD zone>` followed by each opportunity title,
normalized deadline, source zone, days remaining, open/closed status, and suggested 21/14/10/5-day
milestones. The block ends by requiring every milestone to be on/before its deadline and forbidding
plans against passed deadlines. Shadow logs the truncated block as `meri.evidence_accuracy.shadow`;
off does not alter the prompt.

After synthesis, ISO dates and `Month D, YYYY` dates in capture-plan, timeline, roadmap, or schedule
sections are checked. A conflict appends a precise note such as:
`Correction: 'Submit proposal — Nov 20, 2026' falls after the DIU deadline of 2026-11-14 (America/New_York); the feasible submission date is on or before 2026-11-14.`
The issues are logged as `meri.schedule_integrity`; Stage 0 does not regenerate the answer.

Strategy prompts use the same block when their server-computed context contains deadlines. The shared
strategy verifier accepts `verifyPlan(input, { enforcePastDates: true })`, which emits the distinct
`milestone-past-date` error for milestone starts before `fiscal.today`. The option defaults false, so
API Strategy and all legacy callers preserve existing behavior unless they have an enrolled tenant.
