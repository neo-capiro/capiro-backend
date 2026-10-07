import type { PlannerBootstrap, PlannerTimesheet } from '@capiro/strategy-verifier';
import { plannerError, usePlannerTimesheetHistory } from './planner-api.js';
import { PlannerFormattedText } from './planner-rich-text.js';
export function PlannerTimesheetHistory({
  sheet,
  people,
}: {
  sheet: PlannerTimesheet;
  people: PlannerBootstrap['people'];
}) {
  const query = usePlannerTimesheetHistory(sheet.weekOn, sheet.userId, sheet.revision);
  const pages = query.data?.pages ?? [],
    stale = pages.some((p) => p.revision !== sheet.revision);
  if (query.isError || stale)
    return (
      <p role="alert" className="planner-error">
        {stale ? 'Time changed while loading. Refresh this timesheet.' : plannerError(query.error)}
      </p>
    );
  const events = pages.flatMap((p) => p.history);
  return (
    <>
      {!pages.length ? (
        <p role="status">Loading status activity…</p>
      ) : events.length ? (
        events.map((e) => (
          <article key={e.id} className="planner-activity">
            <strong>{people.find((p) => p.id === e.actorId)?.name ?? 'Member'}</strong>
            <time>{new Date(e.createdAt).toLocaleString()}</time>
            <PlannerFormattedText text={e.text} />
          </article>
        ))
      ) : (
        <p>No status changes yet.</p>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more status activity
        </button>
      )}
    </>
  );
}
