# Portfolio baseline metrics

The approved baseline uses current visible active records. Overdue CRM work is an unsettled request or commitment whose saved due time is strictly before the observation in UTC. Recorded activity covers the inclusive prior 30 days. Funding retains its stated US federal fiscal year; prospect counts retain saved stages. Health scores, stage-weighted revenue and win rates remain unavailable until their formulas and inputs are defined.

GET /clients/metrics is an authenticated, no-store Core read. It uses current native account authority and the existing tenant/ethical-wall visibility rules. Prospect profiles and inactive or archived clients are excluded. Null legacy profile types remain clients. Counts cover full saved populations, without roster limits, display filters or pagination.

Four independent groups report either complete counts or unavailable:
- Visible active clients.
- Nondeleted objectives in draft, in_review or ready, with awaiting-review and ready subsets.
- Saved CRM activity in the 30-day UTC window and overdue unsettled requests/commitments across all dates.
- Saved bill watches: covered clients, complete eligible-client denominator, distinct client/bill pairs and distinct bills. A client with several watches contributes once to client coverage. An empty denominator has no percentage.

Each group runs through the canonical tenant-scoped Prisma owner and current membership checks. An unavailable source does not erase valid other groups or become zero. The actor is checked again before returning the result. Groups are independently observed; concurrent saves may produce small differences between group populations. The observedAt timestamp sets the shared time-window boundary, not a claim of one cross-source database snapshot.

The portfolio UI reads this endpoint independently of the displayed roster. It scopes its cache to tenant, user and role, validates returned scope and semantics, rechecks the current actor around the read, clears counts after refusal, refreshes on mount/focus and every 60 seconds, and offers manual refresh. Observations over two minutes old, including clock skew, are labeled stale. Definitions describe excluded sources and unsupported metrics.

Objective-linked work coverage, off-track indicators, Strategy/Planner totals and derived email or meeting activity are not inferred from capped pages or unrelated owners. They need their own complete, authorized source projections. This change does not qualify live deployments or upstream provider availability.
