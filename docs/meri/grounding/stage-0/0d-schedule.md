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
