import { Link, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import {
  useIntelFeatureEnabled,
  STATE_CALENDAR_FEATURE,
} from '../../../../lib/intel-feature-flags.js';
import { useCreatePreparation, useCalendarFolderScope } from '../lib/calendar-preparation-api.js';
import type { CanonicalHearingEvent } from '../lib/canonical-hearings.js';
import { LwButton, LwPill } from '../lib/primitives.js';
import { safeOfficialHttpUrl } from '../lib/canonical-hearings.js';

export function PreparationPanel({
  event,
  clientId,
  folderId,
}: {
  event: CanonicalHearingEvent;
  clientId?: string;
  folderId?: string;
}) {
  const enabled = useIntelFeatureEnabled(STATE_CALENDAR_FEATURE),
    create = useCreatePreparation(event.id);
  const choices = useCalendarFolderScope(
    { clientId, jurisdiction: event.geographicJurisdiction ?? 'US' },
    enabled,
  );
  const [routeParams] = useSearchParams();
  const [selectedFolders, setSelectedFolders] = useState<string[]>(() => {
    const ids = routeParams.getAll('folder').filter(Boolean);
    return ids.length ? ids : folderId ? [folderId] : [];
  });
  if (!enabled) return null;
  const items = event.agenda ?? [],
    checked = event.calendarCheckedAt;
  const stale =
    !checked ||
    Date.now() - Date.parse(checked) > 86400000 ||
    event.calendarCheckState !== 'complete';
  return (
    <section className="lw-card" style={{ padding: 18 }} aria-label="Agenda and preparation">
      <div className="lw-card__head">
        <h2 className="lw-card__title">Agenda & preparation</h2>
        <LwPill tone={stale ? 'gray' : 'brand'} size="22">
          {stale ? 'Check source' : 'Published agenda'}
        </LwPill>
      </div>
      <p className="lw-card__meta">
        {event.geographicJurisdiction === 'FL' ? 'Florida' : 'Federal'} ·{' '}
        {event.legislativeSession ?? event.congress ?? 'Session unconfirmed'}
        {' · '}Revision {event.calendarRevision ?? 0}
        {checked
          ? ` · Checked ${new Date(checked).toLocaleString()}`
          : ' · Source check unavailable'}
      </p>
      {event.stateCommitteeId ? (
        <p>
          <Link to={`/directory/state-committees/${encodeURIComponent(event.stateCommitteeId)}`}>
            Committee profile and calendar
          </Link>
        </p>
      ) : null}
      {event.timePrecision === 'relative' || event.timePrecision === 'unknown' ? (
        <p>Start time is not confirmed. Check the published notice before attending.</p>
      ) : null}
      {items.length ? (
        <ol style={{ paddingLeft: 24, display: 'grid', gap: 12 }}>
          {[...items]
            .sort((a, b) => a.position - b.position)
            .map((item) => (
              <li key={item.key}>
                {item.bill ? (
                  <Link to={`/bills/${encodeURIComponent(item.bill.id)}`}>{item.title}</Link>
                ) : (
                  <span>{item.title}</span>
                )}
                {item.kind === 'unresolved_bill' ? (
                  <small style={{ display: 'block', color: 'var(--lw-meta)' }}>
                    Bill reference awaiting resolution
                  </small>
                ) : null}
                {safeOfficialHttpUrl(item.sourceUrl) ? (
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginLeft: 10 }}
                  >
                    Source
                  </a>
                ) : null}
              </li>
            ))}
        </ol>
      ) : (
        <p>
          No resolved agenda items are available. Use the original notice for the published
          schedule.
        </p>
      )}
      {event.documents?.length ? (
        <ul>
          {event.documents.map((d) => (
            <li key={d.id ?? d.sourceUrl}>
              {safeOfficialHttpUrl(d.sourceUrl) ? (
                <a href={d.sourceUrl} target="_blank" rel="noreferrer">
                  {d.title}
                </a>
              ) : (
                d.title
              )}
              {d.publishedAt ? (
                <small> · Published {new Date(d.publishedAt).toLocaleString()}</small>
              ) : null}
              {d.deadlines?.map((deadline, i) => (
                <p key={i}>{deadline}</p>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="lw-card__meta">
        Create a preparation draft from the published agenda, current bill facts, and your permitted
        folder context. Each draft keeps the source revision used to prepare it.
      </p>
      <label style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
        Private folders for this preparation
        <select
          multiple
          aria-label="Private folders for this preparation"
          value={selectedFolders}
          disabled={!choices.isSuccess}
          onChange={(e) =>
            setSelectedFolders(Array.from(e.target.selectedOptions, (option) => option.value))
          }
        >
          {(choices.data?.folders ?? []).map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </label>
      {choices.isPending ? (
        <p role="status">Checking permitted folders…</p>
      ) : choices.isError ? (
        <p role="alert">
          Folder access could not be checked.{' '}
          <button onClick={() => void choices.refetch()}>Retry</button>
        </p>
      ) : (
        <p className="lw-card__meta">
          {selectedFolders.length
            ? `${selectedFolders.length} private folder${selectedFolders.length === 1 ? '' : 's'} selected. Notes stay in internal preparation context.`
            : 'No private folders selected. The draft will use public facts only.'}
        </p>
      )}
      <LwButton
        disabled={create.isPending || !choices.isSuccess}
        onClick={() =>
          create.mutate({ ...(clientId ? { clientId } : {}), folderIds: selectedFolders })
        }
      >
        {create.isPending ? 'Preparing…' : 'Create prep draft'}
      </LwButton>
      {create.isError ? (
        <p role="alert">
          Preparation could not be created. Your access or the source data may have changed. Try
          again after refreshing.
        </p>
      ) : null}
      {create.data ? (
        <p role="status">
          Preparation draft created.{' '}
          <Link to={`/workspace/draft/${encodeURIComponent(create.data.draftId)}`}>
            Open in Workspace
          </Link>
        </p>
      ) : null}
    </section>
  );
}
