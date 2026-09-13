import { useState } from 'react';
import { useApi } from '../../lib/use-api.js';
type Mapping = {
  priorClaimId: string;
  classification: string;
  claimIds: string[];
  rationale: string;
};
export function HearingRecordCorrectionReview({
  base,
  briefId,
  contentHash,
  claims,
  priorBriefs,
  sessionId,
  publicationId,
  busy,
  act,
  onSaved,
}: {
  base: string;
  briefId: string;
  contentHash: string;
  claims: Array<{ id: string; text: string }>;
  priorBriefs: Array<{ id: string; version: number }>;
  sessionId: string;
  publicationId: string;
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<void>;
  onSaved: (id: string) => void;
}) {
  const api = useApi(),
    [selected, setSelected] = useState(''),
    [source, setSource] = useState<{
      priorId: string;
      priorKind: string;
      sessionId?: string;
      priorHash: string;
      priorCreatedAt: string;
      claims: Array<{ id: string; text: string }>;
    } | null>(null),
    [items, setItems] = useState<Mapping[]>([]),
    [attest, setAttest] = useState(false),
    [reason, setReason] = useState('');
  return (
    <details className="hr-review">
      <summary>Create a correction or follow-up to an earlier version</summary>
      <p>
        Preserve what was reported. Classify an error at the time separately from a later change,
        and map it to the current reviewed statements.
      </p>
      <label>
        Earlier version
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setSource(null);
            setItems([]);
            setAttest(false);
          }}
        >
          <option value="">Choose exact earlier version</option>
          {publicationId && sessionId ? (
            <option value={'publication:' + publicationId}>
              Selected earlier unofficial recap
            </option>
          ) : null}
          {priorBriefs
            .filter((b) => b.id !== briefId)
            .map((b) => (
              <option key={b.id} value={'brief:' + b.id}>
                Published-record brief v{b.version} · {b.id}
              </option>
            ))}
        </select>
      </label>
      <button
        disabled={busy || !selected}
        onClick={() =>
          void act(async () => {
            const [priorKind, priorId] = selected.split(':');
            setSource(
              (await api.post(base + '/correction-source', { priorKind, priorId, sessionId })).data,
            );
          })
        }
      >
        Load preserved statements
      </button>
      {source ? (
        <>
          <p>
            Earlier content hash <code>{source.priorHash}</code> ·{' '}
            {new Date(source.priorCreatedAt).toLocaleString()}
          </p>
          {source.claims.map((c) => {
            const item = items.find((i) => i.priorClaimId === c.id),
              update = (patch: Partial<Mapping>) => {
                setItems(items.map((i) => (i.priorClaimId === c.id ? { ...i, ...patch } : i)));
                setAttest(false);
              };
            return (
              <article key={c.id} className="hr-claim">
                <label className="hr-inline">
                  <input
                    type="checkbox"
                    checked={!!item}
                    onChange={() => {
                      setItems(
                        item
                          ? items.filter((i) => i.priorClaimId !== c.id)
                          : [
                              ...items,
                              {
                                priorClaimId: c.id,
                                classification: 'uncertain',
                                claimIds: [],
                                rationale: '',
                              },
                            ],
                      );
                      setAttest(false);
                    }}
                  />
                  Previously reported: {c.text}
                </label>
                {item ? (
                  <>
                    <label>
                      Staff assessment
                      <select
                        value={item.classification}
                        onChange={(e) => update({ classification: e.target.value })}
                      >
                        <option value="uncertain">Still uncertain</option>
                        <option value="wrong_then">Wrong at the time</option>
                        <option value="later_change">Later legislative change</option>
                        <option value="still_supported">Still supported</option>
                      </select>
                    </label>
                    <fieldset>
                      <legend>Current statements that explain the finding</legend>
                      {claims.map((now) => (
                        <label key={now.id} className="hr-inline">
                          <input
                            type="checkbox"
                            checked={item.claimIds.includes(now.id)}
                            onChange={() =>
                              update({
                                claimIds: item.claimIds.includes(now.id)
                                  ? item.claimIds.filter((id) => id !== now.id)
                                  : [...item.claimIds, now.id],
                              })
                            }
                          />
                          {now.text}
                        </label>
                      ))}
                    </fieldset>
                    <label>
                      Evidence and chronology rationale
                      <textarea
                        value={item.rationale}
                        onChange={(e) => update({ rationale: e.target.value })}
                      />
                    </label>
                  </>
                ) : null}
              </article>
            );
          })}
          <label>
            Reason for this version
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label className="hr-inline">
            <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
            I checked the exact earlier version, event, client, source dates and the distinction
            between an error and a later change.
          </label>
          <button
            disabled={
              busy ||
              !attest ||
              !items.length ||
              !reason.trim() ||
              items.some(
                (i) =>
                  !i.rationale.trim() || (!i.claimIds.length && i.classification !== 'uncertain'),
              )
            }
            onClick={() =>
              void act(async () => {
                const result = (
                  await api.post<{ id: string }>(base + '/briefs/' + briefId + '/versions', {
                    contentHash,
                    claims,
                    rationale: reason,
                    correction: { ...source, items, attestChronology: attest },
                  })
                ).data;
                onSaved(result.id);
                setSource(null);
                setItems([]);
                setAttest(false);
              })
            }
          >
            Save correction draft for approval
          </button>
        </>
      ) : null}
    </details>
  );
}
