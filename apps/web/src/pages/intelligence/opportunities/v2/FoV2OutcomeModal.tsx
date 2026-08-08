/**
 * Funding Opportunities v2 — Record outcome modal.
 *
 * The mockup's "Record outcome" dialog (Won / Lost / No award, outcome date, award
 * reference, reason codes, what the team learned, and the governed memory-candidate
 * note) over the real P36 outcome API. Reason codes are the API's closed
 * vocabulary per outcome kind; the "No award" choice maps to `passed`.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { useApi } from '../../../../lib/use-api.js';
import {
  OUTCOME_REASON_CODES,
  OUTCOME_REASON_CODE_LABELS,
  outcomeApiPath,
  type PursuitOutcomeKindView,
  type RecordOutcomeResultView,
} from '../funding-opportunities-api.js';

const CHOICES: Array<{ key: PursuitOutcomeKindView; label: string }> = [
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
  { key: 'passed', label: 'No award' },
];

export function FoV2OutcomeModal({
  clientId,
  source,
  sourceRecordId,
  title,
  onClose,
  onRecorded,
}: {
  clientId: string;
  source: string;
  sourceRecordId: string;
  title: string;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const [kind, setKind] = useState<PursuitOutcomeKindView>('won');
  const [outcomeDate, setOutcomeDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [awardRef, setAwardRef] = useState('');
  const [reasonCodes, setReasonCodes] = useState<string[]>([]);
  const [note, setNote] = useState('');

  const submit = useMutation<RecordOutcomeResultView>({
    mutationFn: async () =>
      (
        await api.post<RecordOutcomeResultView>(outcomeApiPath(clientId, source, sourceRecordId), {
          kind,
          outcomeDate: new Date(`${outcomeDate}T00:00:00.000Z`).toISOString(),
          reasonCodes,
          note,
          sourceAwardLink: awardRef.trim() || undefined,
        })
      ).data,
    onSuccess: (result) => {
      if (result.state === 'recorded') {
        notification.success({
          message: 'Outcome recorded',
          description: result.memoryCandidateProposed
            ? 'A learning candidate was proposed for review.'
            : 'Recorded without a learning candidate.',
        });
        void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
        void qc.invalidateQueries({ queryKey: ['fo-v2-pipeline'] });
        onRecorded();
        onClose();
      } else {
        notification.warning({ message: 'Outcome not recorded', description: result.explanation });
      }
    },
    onError: () => notification.error({ message: 'Outcome failed' }),
  });

  const codes = OUTCOME_REASON_CODES[kind];
  const canSubmit = reasonCodes.length > 0 && note.trim().length > 0 && !submit.isPending;

  function toggleCode(code: string) {
    setReasonCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  return (
    <div
      className="fo-v2-modal-mask"
      role="dialog"
      aria-modal="true"
      aria-label="Record outcome"
      data-testid="fo-v2-outcome-modal"
      onClick={onClose}
    >
      <div className="fo-v2-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fo-v2-modal-head">
          <span className="fo-v2-modal-title">Record outcome</span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="fo-v2-icon-btn"
            onClick={onClose}
            aria-label="Close"
            style={{ width: 26, height: 26 }}
          >
            ✕
          </button>
        </div>

        <div className="fo-v2-modal-idband">
          <div
            className="fo-v2-mono"
            style={{ fontSize: 11, letterSpacing: '0.07em', color: 'var(--fov2-secondary)' }}
          >
            {sourceRecordId.toUpperCase()}
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 5, lineHeight: 1.4 }}>
            {title}
          </div>
        </div>

        <div className="fo-v2-modal-body">
          <div>
            <div className="fo-v2-field-label">
              Outcome<span className="fo-v2-field-req">*</span>
            </div>
            <div style={{ display: 'flex', gap: 7, marginTop: 7 }}>
              {CHOICES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`fo-v2-choice${kind === c.key ? ' on' : ''}`}
                  aria-pressed={kind === c.key}
                  onClick={() => {
                    setKind(c.key);
                    setReasonCodes([]);
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
            <div>
              <div className="fo-v2-field-label">
                Outcome date<span className="fo-v2-field-req">*</span>
              </div>
              <div className="fo-v2-field" style={{ marginTop: 7 }}>
                <input
                  type="date"
                  aria-label="Outcome date"
                  value={outcomeDate}
                  onChange={(e) => setOutcomeDate(e.target.value)}
                  style={{ fontFamily: 'var(--fov2-mono)', fontSize: 12.5 }}
                />
              </div>
            </div>
            <div>
              <div className="fo-v2-field-label">Award reference</div>
              <div className="fo-v2-field" style={{ marginTop: 7 }}>
                <input
                  type="text"
                  aria-label="Award reference"
                  placeholder="Optional"
                  value={awardRef}
                  onChange={(e) => setAwardRef(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div>
            <div className="fo-v2-field-label">
              Reason codes<span className="fo-v2-field-req">*</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
              {codes.map((code) => (
                <button
                  key={code}
                  type="button"
                  className={`fo-v2-code-chip${reasonCodes.includes(code) ? ' on' : ''}`}
                  aria-pressed={reasonCodes.includes(code)}
                  onClick={() => toggleCode(code)}
                >
                  {OUTCOME_REASON_CODE_LABELS[code]?.toUpperCase() ?? code.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="fo-v2-field-label">
              What the team learned<span className="fo-v2-field-req">*</span>
            </div>
            <div
              className="fo-v2-field"
              style={{ marginTop: 7, minHeight: 74, alignItems: 'flex-start' }}
            >
              <textarea
                aria-label="What the team learned"
                placeholder="Two sentences on why this went the way it did."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                style={{ resize: 'vertical', minHeight: 64 }}
              />
            </div>
          </div>

          <div className="fo-v2-unsupported">
            <div className="fo-v2-unsupported-tag">● PROPOSED FOR INSTITUTIONAL MEMORY</div>
            <div
              style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--fov2-body)', marginTop: 6 }}
            >
              Saving creates a memory candidate scoped to this client. It stays pending until a
              reviewer approves it; rejecting the candidate keeps the recorded outcome.
            </div>
          </div>
        </div>

        <div className="fo-v2-modal-foot">
          <div style={{ flex: 1, fontSize: 12, color: 'var(--fov2-body)' }}>
            Won and lost cannot be saved without a date, a reason code and a note.
          </div>
          <button type="button" className="fo-v2-btn fo-v2-btn-outline-strong" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="fo-v2-btn fo-v2-btn-primary"
            disabled={!canSubmit}
            onClick={() => submit.mutate()}
            data-testid="fo-v2-outcome-save"
          >
            Save outcome
          </button>
        </div>
      </div>
    </div>
  );
}
