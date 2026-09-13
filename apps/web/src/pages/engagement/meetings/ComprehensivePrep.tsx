import { useEffect, useState } from 'react';
import type { MeetingPrep } from './meetings-types.js';
import { PrepSourceLinks } from './PrepEvidence.js';
import { usePrepMondayMapping, useComprehensivePrepEnabled, type MeetingPrepDepth } from './meetings-api.js';

export const briefingSectionLabels: Record<string, string> = {
  recentDevelopments: 'Recent developments',
  importantEmails: 'Important email exchanges',
  previousConversations: 'Previous meetings and conversations',
  decisions: 'Decisions already made',
  unresolvedIssues: 'Outstanding questions and unresolved issues',
  upcomingDevelopments: 'Upcoming deadlines, meetings and legislative developments',
  commitments: 'What we committed to doing',
};

export function ComprehensivePrep({ prep }: { prep: MeetingPrep }) {
  const briefing = prep.generatedFrom?.briefing;
  if (!briefing || prep.generatedFrom?.grounding?.contentEdited) return null;
  const sources = (ids: string[]) =>
    briefing.facts.filter((fact) => ids.includes(fact.id)).map((fact) => fact.sourceId);
  return (
    <section aria-label="Comprehensive meeting briefing" style={{ fontSize: 13, lineHeight: 1.65 }}>
      <h3>Key takeaways</h3>
      <ul>
        {briefing.takeaways.map((item, index) => (
          <li key={index}>
            {item.text}
            <PrepSourceLinks prep={prep} section="summary" sourceIds={sources(item.factIds)} />
          </li>
        ))}
      </ul>
      {Object.entries(briefingSectionLabels).map(([key, label]) => {
        const section = briefing.sections[key];
        return (
          <section key={key} aria-label={label}>
            <h3>{label}</h3>
            {!!section?.items.length && (
              <ul>
                {section.items.map((item, index) => (
                  <li key={index}>
                    {item.text}
                    <PrepSourceLinks prep={prep} section={key} sourceIds={sources(item.factIds)} />
                  </li>
                ))}
              </ul>
            )}
            {section?.gap && <p role="note">{section.gap}</p>}
            {!section && <p role="note">This section was not available in the saved briefing.</p>}
          </section>
        );
      })}
      <p role="note">
        {briefing.coverage.partial
          ? 'Partial source coverage. '
          : 'Searched-source coverage complete. '}
        {briefing.coverage.reviewedFactCount} extracted facts checked for important omissions. This
        does not establish that every possible source was available.
      </p>
    </section>
  );
}

export function PrepSearchSettings({
  meetingId,
  clientId,
  depth,
  setDepth,
}: {
  meetingId: string;
  clientId: string | null;
  depth: MeetingPrepDepth;
  setDepth: (depth: MeetingPrepDepth) => void;
}) {
  const enabled = useComprehensivePrepEnabled();
  const { query, save } = usePrepMondayMapping(meetingId, !!clientId && enabled.data === true);
  const [boards, setBoards] = useState('');
  useEffect(() => {
    setBoards(query.data?.boardIds?.join(', ') ?? '');
  }, [meetingId, query.data]);
  if (!enabled.data) return null;
  return (
    <details style={{ fontSize: 12, marginBlock: 12 }}>
      <summary>Search depth and Monday.com context</summary>
      <label>
        Search depth{' '}
        <select
          value={depth}
          onChange={(event) => setDepth(event.target.value as MeetingPrepDepth)}
        >
          <option value="standard">
            Standard — 10 meetings / 90 days; 15 email threads / 30 days
          </option>
          <option value="deep">Deep — 25 meetings / 180 days; 100 email threads / 90 days</option>
          <option value="max">Max — 100 meetings; 300 email threads / 365 days</option>
        </select>
      </label>
      <p>
        Open tasks have no age cutoff. Standard and deep searches have a 1-hour budget; max
        searches have 2 hours. You can close this page while preparation runs.
      </p>
      {query.data && (
        <>
          <label>
            Monday.com board IDs for this client{' '}
            <input
              value={boards}
              onChange={(event) => setBoards(event.target.value)}
              placeholder="123456789, 987654321"
            />
          </label>
          <p>
            Only boards you explicitly map here are searched through your connected Monday.com
            account. Confirm each board belongs to this client.
          </p>
          <button
            type="button"
            className="btn sm"
            disabled={save.isPending}
            onClick={() => save.mutate(boards.split(/[\s,]+/).filter(Boolean))}
          >
            Save board mapping
          </button>
          {save.isError && (
            <p role="alert">
              Could not save the board mapping. Check the IDs and your client access.
            </p>
          )}
          {save.isSuccess && <p role="status">Board mapping saved.</p>}
        </>
      )}
    </details>
  );
}
