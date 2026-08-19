import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroInput } from '../../components/fields/index.js';
import { useApi } from '../../../lib/use-api.js';
import {
  OUTCOME_REASON_CODES,
  OUTCOME_REASON_CODE_LABELS,
  outcomeApiPath,
  type OutcomeHistoryResultView,
  type PursuitOutcomeKindView,
  type RecordOutcomeResultView,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovModal, FovPill } from './fov-ui.js';

/**
 * Outcome capture and governed learning candidate (P36) — vNext port of the
 * canonical OpportunityOutcomeModal.
 *
 * Unchanged semantics: this is additional to the pipeline's own reason prompt
 * (the stage move already committed before this opens); every recorded outcome
 * stays visible in the history list and nothing here edits or deletes an old
 * entry; the learning candidate result is stated, not hidden.
 *
 * The date field is a native `<input type="date">` — it reads/writes the plain
 * ISO string directly, which is the same contract the canonical DatePicker was
 * carefully coerced into (it read the string callback to avoid a dayjs
 * dependency).
 */
export function OpportunityOutcomeModal({
  open,
  onClose,
  clientId,
  source,
  sourceRecordId,
  kind,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  source: string;
  sourceRecordId: string;
  kind: PursuitOutcomeKindView;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [outcomeDate, setOutcomeDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [reasonCodes, setReasonCodes] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [vehicleOutcome, setVehicleOutcome] = useState('');
  const [sourceAwardLink, setSourceAwardLink] = useState('');

  const history = useQuery<OutcomeHistoryResultView>({
    queryKey: ['funding-opportunity-outcome-history', clientId, source, sourceRecordId],
    queryFn: async () =>
      (await api.get<OutcomeHistoryResultView>(outcomeApiPath(clientId, source, sourceRecordId)))
        .data,
    enabled: open,
    retry: false,
  });

  const submit = useMutation<RecordOutcomeResultView>({
    mutationFn: async () =>
      (
        await api.post<RecordOutcomeResultView>(outcomeApiPath(clientId, source, sourceRecordId), {
          kind,
          outcomeDate: new Date(`${outcomeDate}T00:00:00.000Z`).toISOString(),
          reasonCodes,
          note,
          vehicleOutcome: vehicleOutcome.trim() || undefined,
          sourceAwardLink: sourceAwardLink.trim() || undefined,
        })
      ).data,
    onSuccess: (result) => {
      if (result.state === 'recorded') {
        setReasonCodes([]);
        setNote('');
        setVehicleOutcome('');
        setSourceAwardLink('');
        void qc.invalidateQueries({
          queryKey: ['funding-opportunity-outcome-history', clientId, source, sourceRecordId],
        });
      }
    },
  });

  const codes = OUTCOME_REASON_CODES[kind];
  const canSubmit = reasonCodes.length > 0 && note.trim().length > 0 && !submit.isPending;

  return (
    <FovModal
      open={open}
      title="Capture the outcome"
      okText="Record outcome"
      okDisabled={!canSubmit}
      onCancel={onClose}
      onOk={() => submit.mutate()}
      testId="fo-outcome-modal"
    >
      <p className="fov-muted" style={{ marginTop: 0 }}>
        This feeds a client-scoped learning candidate for review. Nothing here is shared across
        clients, and nothing is added to active memory automatically.
      </p>

      {submit.data?.state === 'recorded' ? (
        <FovAlert
          tone="success"
          testId="fo-outcome-recorded"
          message="Outcome recorded"
          description={
            submit.data.memoryCandidateProposed
              ? 'A learning candidate was proposed for review.'
              : 'The outcome was recorded. The learning candidate could not be proposed right now — this does not affect the recorded outcome.'
          }
          className="fov-outcome-alert"
        />
      ) : null}
      {submit.data && submit.data.state !== 'recorded' ? (
        <FovAlert tone="warning" testId="fo-outcome-refused" message={submit.data.explanation} />
      ) : null}

      <div className="fov-stack fov-stack--10">
        <div>
          <span className="fov-fact__label">Outcome date</span>
          <input
            type="date"
            className="capiro-input"
            style={{ width: '100%' }}
            value={outcomeDate}
            onChange={(event) => {
              if (event.target.value) setOutcomeDate(event.target.value);
            }}
            aria-label="Outcome date"
            data-testid="fo-outcome-date"
          />
          <span className="fov-micro">{outcomeDate}</span>
        </div>

        <div>
          <span className="fov-fact__label">Reason ({reasonCodes.length}/5)</span>
          <div className="fov-checklist" data-testid="fo-outcome-reasons">
            {codes.map((code) => (
              <label key={code}>
                <input
                  type="checkbox"
                  checked={reasonCodes.includes(code)}
                  data-testid={`fo-outcome-reason-${code}`}
                  onChange={(event) =>
                    setReasonCodes((current) =>
                      (event.target.checked
                        ? [...current, code]
                        : current.filter((entry) => entry !== code)
                      ).slice(0, 5),
                    )
                  }
                />
                {OUTCOME_REASON_CODE_LABELS[code] ?? code}
              </label>
            ))}
          </div>
        </div>

        <div>
          <span className="fov-fact__label">Note</span>
          <textarea
            className="capiro-input"
            rows={3}
            style={{ width: '100%', resize: 'vertical' }}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            aria-label="Outcome note"
            data-testid="fo-outcome-note"
          />
        </div>

        <CapiroInput
          label="Vehicle/partner outcome (optional)"
          value={vehicleOutcome}
          onChange={(event) => setVehicleOutcome(event.target.value)}
          aria-label="Vehicle or partner outcome"
          data-testid="fo-outcome-vehicle"
        />

        <CapiroInput
          label="Source award link (optional)"
          value={sourceAwardLink}
          onChange={(event) => setSourceAwardLink(event.target.value)}
          aria-label="Source award link"
          data-testid="fo-outcome-award-link"
        />

        <div data-testid="fo-outcome-history">
          <span className="fov-fact__label">Prior outcomes for this opportunity</span>
          {history.data?.outcomes?.length ? (
            <ul className="fov-stack fov-stack--6" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
              {history.data.outcomes.map((record) => (
                <li key={`${record.kind}-${record.outcomeDate}-${record.current}`}>
                  <div className="fov-stack">
                    <span className="fov-row">
                      <FovPill>{record.kind}</FovPill>
                      {record.current ? <FovPill tone="blue">Current</FovPill> : null}
                      <span className="fov-micro">{record.outcomeDate.slice(0, 10)}</span>
                    </span>
                    <span style={{ fontSize: 12 }}>{record.note}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <span className="fov-muted">
              {history.isPending ? 'Loading…' : 'No outcome recorded yet.'}
            </span>
          )}
        </div>
      </div>
    </FovModal>
  );
}
