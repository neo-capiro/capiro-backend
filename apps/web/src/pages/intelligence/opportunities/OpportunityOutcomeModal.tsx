import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Checkbox, DatePicker, Input, List, Modal, Space, Tag, Typography } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import {
  OUTCOME_REASON_CODES,
  OUTCOME_REASON_CODE_LABELS,
  outcomeApiPath,
  type OutcomeHistoryResultView,
  type PursuitOutcomeKindView,
  type RecordOutcomeResultView,
} from './funding-opportunities-api.js';

const { Paragraph, Text } = Typography;

/**
 * Outcome capture and governed learning candidate (P36).
 *
 * ── This is additional, not the pipeline's own reason prompt ─────────────────
 *
 * The pipeline board already requires a free-text reason before it will move a
 * card to `won`/`lost`/`passed` — that gate exists whether or not this modal is
 * ever opened. This one is richer and optional-feeling in the UI (a person can
 * close it without submitting, and the stage move already committed): bounded
 * reason codes a report can group by, a vehicle/partner outcome, and a source
 * award link, which together seed a governed learning candidate.
 *
 * ── Every recorded outcome is visible, not just the newest ─────────────────
 *
 * The history list at the bottom shows every prior submission for this
 * opportunity, most recent first, with the current one tagged. Nothing here
 * lets a person edit or delete an old entry — resubmitting adds a new one, and
 * the old one stays exactly as written. That is the whole "reopening preserves
 * the prior version" rule, visible on screen rather than merely true in the
 * database.
 *
 * ── The learning candidate is stated, not hidden ──────────────────────────────
 *
 * After a successful submit, the response says whether a learning candidate
 * was proposed. If the memory store was unavailable, the outcome is still
 * recorded — the modal says so rather than implying the whole action failed.
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
  // Plain ISO date STRING, not a dayjs object — this app has no direct dayjs
  // dependency (antd's DatePicker carries its own transitively), and reading
  // the string callback avoids importing a package that is not declared,
  // matching how ChangesInboxPage.tsx's own RangePicker already does this.
  const [outcomeDate, setOutcomeDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
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
    <Modal
      open={open}
      title="Capture the outcome"
      okText="Record outcome"
      okButtonProps={{ disabled: !canSubmit }}
      onCancel={onClose}
      onOk={() => submit.mutate()}
      data-testid="fo-outcome-modal"
    >
      <Paragraph style={{ fontSize: 12 }} type="secondary">
        This feeds a client-scoped learning candidate for review. Nothing here is shared across
        clients, and nothing is added to active memory automatically.
      </Paragraph>

      {submit.data?.state === 'recorded' ? (
        <Alert
          type="success"
          showIcon
          data-testid="fo-outcome-recorded"
          message="Outcome recorded"
          description={
            submit.data.memoryCandidateProposed
              ? 'A learning candidate was proposed for review.'
              : 'The outcome was recorded. The learning candidate could not be proposed right now — this does not affect the recorded outcome.'
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {submit.data && submit.data.state !== 'recorded' ? (
        <Alert
          type="warning"
          showIcon
          data-testid="fo-outcome-refused"
          message={submit.data.explanation}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div>
          <Text type="secondary" className="fo-fact__label">
            Outcome date
          </Text>
          <DatePicker
            value={null}
            defaultValue={undefined}
            // Reads the plain ISO STRING from the second callback argument,
            // never the dayjs object — see the state declaration's own note.
            onChange={(_, dateString) => {
              const value = Array.isArray(dateString) ? dateString[0] : dateString;
              if (value) setOutcomeDate(value);
            }}
            style={{ width: '100%' }}
            aria-label="Outcome date"
            data-testid="fo-outcome-date"
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {outcomeDate}
          </Text>
        </div>

        <div>
          <Text type="secondary" className="fo-fact__label">
            Reason ({reasonCodes.length}/5)
          </Text>
          <Checkbox.Group
            value={reasonCodes}
            onChange={(v) => setReasonCodes((v as string[]).slice(0, 5))}
            data-testid="fo-outcome-reasons"
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            {codes.map((code) => (
              <Checkbox key={code} value={code} data-testid={`fo-outcome-reason-${code}`}>
                {OUTCOME_REASON_CODE_LABELS[code] ?? code}
              </Checkbox>
            ))}
          </Checkbox.Group>
        </div>

        <div>
          <Text type="secondary" className="fo-fact__label">
            Note
          </Text>
          <Input.TextArea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Outcome note"
            data-testid="fo-outcome-note"
          />
        </div>

        <div>
          <Text type="secondary" className="fo-fact__label">
            Vehicle/partner outcome (optional)
          </Text>
          <Input
            value={vehicleOutcome}
            onChange={(e) => setVehicleOutcome(e.target.value)}
            aria-label="Vehicle or partner outcome"
            data-testid="fo-outcome-vehicle"
          />
        </div>

        <div>
          <Text type="secondary" className="fo-fact__label">
            Source award link (optional)
          </Text>
          <Input
            value={sourceAwardLink}
            onChange={(e) => setSourceAwardLink(e.target.value)}
            aria-label="Source award link"
            data-testid="fo-outcome-award-link"
          />
        </div>

        <div data-testid="fo-outcome-history">
          <Text type="secondary" className="fo-fact__label">
            Prior outcomes for this opportunity
          </Text>
          {history.data?.outcomes?.length ? (
            <List
              size="small"
              dataSource={history.data.outcomes}
              renderItem={(record) => (
                <List.Item>
                  <Space direction="vertical" size={0} style={{ width: '100%' }}>
                    <Space size={4} wrap>
                      <Tag>{record.kind}</Tag>
                      {record.current ? <Tag color="blue">Current</Tag> : null}
                      <Text style={{ fontSize: 11 }}>{record.outcomeDate.slice(0, 10)}</Text>
                    </Space>
                    <Text style={{ fontSize: 12 }}>{record.note}</Text>
                  </Space>
                </List.Item>
              )}
            />
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {history.isPending ? 'Loading…' : 'No outcome recorded yet.'}
            </Text>
          )}
        </div>
      </Space>
    </Modal>
  );
}
