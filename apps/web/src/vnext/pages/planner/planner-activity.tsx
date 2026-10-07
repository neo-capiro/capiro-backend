import { useState } from 'react';
import type { PlannerEvent, PlannerRole, PlannerTimeDetails } from '@capiro/strategy-verifier';
import { PlannerFormattedText, PlannerRichText } from './planner-rich-text.js';
import { plannerError, type usePlannerMutations } from './planner-api.js';

export function PlannerActivity({
  event,
  author,
  me,
  access,
  mutation,
}: {
  event: PlannerEvent;
  author: string;
  me: string;
  access: PlannerRole;
  mutation: Pick<
    ReturnType<typeof usePlannerMutations>['reviseEvent'],
    'mutateAsync' | 'isPending'
  >;
}) {
  const [draft, setDraft] = useState<{
    version: number;
    text: string;
    minutes: number | null;
    time?: PlannerTimeDetails;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const own = event.actorId === me;
  const canEdit =
    (own && event.kind === 'comment' && access !== 'viewer') ||
    (event.kind === 'time' &&
      (event.timeEditable ?? (own && ['admin', 'editor'].includes(access))));
  const revise = async (patch: {
    text?: string;
    minutes?: number;
    removed?: boolean;
    time?: Partial<PlannerTimeDetails>;
  }) => {
    setError(null);
    try {
      await mutation.mutateAsync({
        id: event.id,
        version: draft?.version ?? event.version ?? 0,
        ...patch,
      });
      setDraft(null);
    } catch (failure) {
      setError(failure);
    }
  };
  return (
    <article className="planner-activity">
      <header>
        <strong>{author}</strong>
        <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
        {event.editedAt && <span className="planner-muted">Edited</span>}
      </header>
      {draft ? (
        <div className="planner-activity-editor">
          <PlannerRichText
            label={event.kind === 'time' ? 'Edit time note' : 'Edit comment'}
            value={draft.text}
            rows={3}
            maxLength={20000}
            onChange={(text) => setDraft((old) => old && { ...old, text })}
          />
          {event.kind === 'time' && (
            <div>
              <label>
                Minutes
                <input
                  aria-label="Edit logged minutes"
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.minutes ?? ''}
                  onChange={(e) => {
                    const minutes = Number(e.target.value);
                    setDraft((old) => old && { ...old, minutes });
                  }}
                />
              </label>
              {draft.time && (
                <>
                  <label>
                    Work date
                    <input
                      aria-label="Edit work date"
                      type="date"
                      value={draft.time.workedOn}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        setDraft((old) =>
                          old && old.time
                            ? { ...old, time: { ...old.time, workedOn: value } }
                            : old,
                        );
                      }}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setDraft((old) =>
                          old && old.time
                            ? { ...old, time: { ...old.time, workedOn: value } }
                            : old,
                        );
                      }}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.time.billable}
                      onChange={(e) => {
                        const value = e.target.checked;
                        setDraft((old) =>
                          old && old.time
                            ? { ...old, time: { ...old.time, billable: value } }
                            : old,
                        );
                      }}
                    />
                    Billable time
                  </label>
                </>
              )}
            </div>
          )}
          <div className="planner-activity-actions">
            <button
              type="button"
              disabled={
                mutation.isPending ||
                !draft.text.trim() ||
                (event.kind === 'time' &&
                  (!Number.isInteger(draft.minutes) || draft.minutes! < 1 || draft.minutes! > 1440))
              }
              onClick={() =>
                void revise({
                  text: draft.text,
                  ...(event.kind === 'time'
                    ? { minutes: draft.minutes!, ...(draft.time ? { time: draft.time } : {}) }
                    : {}),
                })
              }
            >
              Save changes
            </button>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Cancel edit
            </button>
          </div>
        </div>
      ) : event.removed ? (
        <p className="planner-muted">
          {event.kind === 'time' ? 'Time entry removed.' : 'Comment removed.'}
        </p>
      ) : (
        <>
          {event.kind === 'time' && (
            <p className="planner-muted">
              {event.minutes} minutes logged
              {event.time
                ? ` · ${event.time.workedOn} · ${event.time.billable ? 'Billable' : 'Non-billable'}`
                : ''}
            </p>
          )}
          <PlannerFormattedText text={event.text} />
        </>
      )}
      {canEdit && !draft && (
        <div className="planner-activity-actions">
          {event.removed ? (
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => void revise({ removed: false })}
            >
              {event.kind === 'time' ? 'Restore time entry' : 'Restore comment'}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() => {
                  setError(null);
                  setDraft({
                    version: event.version ?? 0,
                    text: event.text,
                    minutes: event.minutes,
                    ...(event.time ? { time: event.time } : {}),
                  });
                }}
              >
                {event.kind === 'time' ? 'Edit time entry' : 'Edit comment'}
              </button>
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() => void revise({ removed: true })}
              >
                {event.kind === 'time' ? 'Remove time entry' : 'Remove comment'}
              </button>
            </>
          )}
        </div>
      )}
      {error != null && (
        <p role="alert" className="planner-error">
          {plannerError(error)}
        </p>
      )}
    </article>
  );
}
