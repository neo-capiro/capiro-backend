import { useId, useState } from 'react';
import type { MeetingPrep } from './meetings-types.js';
import { PrepSourceLinks } from './PrepEvidence.js';
import { errorMessage } from '../../../lib/error-message.js';
import {
  usePrepMondayMapping,
  useComprehensivePrepEnabled,
  useMeetingPrepIdentity,
  type MeetingPrepDepth,
} from './meetings-api.js';

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

interface PrepSearchSettingsProps {
  meetingId: string;
  clientId: string | null;
  depth: MeetingPrepDepth;
  setDepth: (depth: MeetingPrepDepth) => void;
}

export function PrepSearchSettings(props: PrepSearchSettingsProps) {
  const identity = useMeetingPrepIdentity();
  // Reset drafts and mutation feedback synchronously when the person, tenant,
  // meeting, or assigned client changes. Late responses stay in their old scope.
  return (
    <ScopedPrepSearchSettings
      key={JSON.stringify([identity, props.meetingId, props.clientId])}
      {...props}
    />
  );
}

function ScopedPrepSearchSettings({
  meetingId,
  clientId,
  depth,
  setDepth,
}: PrepSearchSettingsProps) {
  const helpId = useId();
  const enabled = useComprehensivePrepEnabled();
  const { query, save } = usePrepMondayMapping(
    meetingId,
    clientId,
    !!clientId && enabled.data === true,
  );
  // A null draft follows server data. Once edited, background refreshes must
  // not replace the user's input; a successful save adopts the saved response.
  const [boards, setBoards] = useState<string | null>(null);
  const canEdit =
    !!clientId && enabled.data === true && query.isSuccess && !!query.data && !save.isPending;
  const boardValue = boards ?? query.data?.boardIds.join(', ') ?? '';

  return (
    <section aria-label="Meeting preparation sources" style={{ fontSize: 12, marginBlock: 12 }}>
      <div style={{ display: 'grid', gap: 8 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          Monday.com board IDs for this client
          <input
            value={boardValue}
            disabled={!canEdit}
            onChange={(event) => {
              setBoards(event.target.value);
              save.reset();
            }}
            placeholder="123456789, 987654321"
            aria-describedby={helpId}
          />
        </label>
        <p id={helpId} style={{ margin: 0 }}>
          Enter the task board IDs to include in meeting prep, separated by commas. Meri reads these
          boards through your own connected Monday.com account. Confirm each board belongs to this
          client, then save before generating prep.
        </p>
        {!clientId ? (
          <p role="note" style={{ margin: 0 }}>
            Assign this meeting to a client to add Monday.com board IDs.
          </p>
        ) : enabled.isPending ? (
          <p role="status" style={{ margin: 0 }}>
            Checking meeting preparation settings…
          </p>
        ) : enabled.isError ? (
          <div role="alert">
            Could not load meeting preparation settings.{' '}
            <button type="button" className="btn sm" onClick={() => void enabled.refetch()}>
              Retry preparation settings
            </button>
          </div>
        ) : !enabled.data ? (
          <p role="note" style={{ margin: 0 }}>
            Monday.com meeting preparation is unavailable for this workspace.
          </p>
        ) : query.isPending ? (
          <p role="status" style={{ margin: 0 }}>
            Loading your Monday.com board IDs…
          </p>
        ) : query.isError || !query.data ? (
          <div role="alert">
            {query.isError
              ? errorMessage(query.error, 'Could not load your Monday.com board IDs.')
              : 'Monday.com board settings are currently unavailable.'}{' '}
            <button type="button" className="btn sm" onClick={() => void query.refetch()}>
              Retry board settings
            </button>
          </div>
        ) : null}
        <div>
          <button
            type="button"
            className="btn sm"
            disabled={!canEdit}
            onClick={() =>
              save.mutate(boardValue.split(/[\s,]+/).filter(Boolean), {
                onSuccess: () => setBoards(null),
              })
            }
          >
            {save.isPending ? 'Saving board mapping…' : 'Save board mapping'}
          </button>
        </div>
        {save.isError && (
          <p role="alert" style={{ margin: 0 }}>
            {errorMessage(
              save.error,
              'Could not save the board mapping. Check the IDs and your client access.',
            )}
          </p>
        )}
        {save.isSuccess && (
          <p role="status" style={{ margin: 0 }}>
            Board mapping saved.
          </p>
        )}
      </div>
      {enabled.data === true && (
        <details style={{ marginTop: 12 }}>
          <summary>Search depth</summary>
          <label>
            Search depth{' '}
            <select
              value={depth}
              onChange={(event) => setDepth(event.target.value as MeetingPrepDepth)}
            >
              <option value="standard">
                Standard — 10 meetings / 90 days; 15 email threads / 30 days
              </option>
              <option value="deep">
                Deep — 25 meetings / 180 days; 100 email threads / 90 days
              </option>
              <option value="max">Max — 100 meetings; 300 email threads / 365 days</option>
            </select>
          </label>
          <p>
            Open tasks have no age cutoff. Standard and deep searches have a 1-hour budget; max
            searches have 2 hours. You can close this page while preparation runs.
          </p>
        </details>
      )}
    </section>
  );
}
