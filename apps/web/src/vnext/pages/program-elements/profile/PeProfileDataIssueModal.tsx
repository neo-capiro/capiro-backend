/**
 * Program Elements vNext profile — Report data issue modal.
 * Native port of ProgramElementDataIssueModal on CapiroModal + Capiro fields:
 * same endpoint (POST /api/program-elements/:peCode/data-issues via
 * createProgramElementDataIssue), same validation rules and messages, same
 * success/error toast copy, same query invalidation.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CapiroModal } from '../../../components/overlays/index.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect } from '../../../components/fields/index.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import { useApi } from '../../../../lib/use-api.js';
import { createProgramElementDataIssue } from '../../../../pages/program-element/api.js';

const ISSUE_TYPES = [
  { value: 'value_incorrect', label: 'Value incorrect' },
  { value: 'missing_value', label: 'Missing value' },
  { value: 'wrong_source', label: 'Wrong source' },
  { value: 'wrong_stage_or_vehicle', label: 'Wrong stage or vehicle' },
  { value: 'wrong_pe_attribution', label: 'Wrong PE attribution' },
  { value: 'other', label: 'Other' },
] as const;

const FIELD_OPTIONS = [
  { value: '', label: 'Select a field' },
  { value: 'request', label: 'Request' },
  { value: 'hascMark', label: 'HASC mark' },
  { value: 'sascMark', label: 'SASC mark' },
  { value: 'hacDMark', label: 'HAC-D mark' },
  { value: 'sacDMark', label: 'SAC-D mark' },
  { value: 'conference', label: 'Approps conference' },
  { value: 'ndaaConference', label: 'NDAA conference' },
  { value: 'enacted', label: 'Enacted' },
  { value: 'reprogrammed', label: 'Reprogrammed' },
  { value: 'executed', label: 'Executed' },
  { value: 'title', label: 'Title' },
  { value: 'description', label: 'Description' },
  { value: 'fundingSummary', label: 'Funding summary' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'personnel', label: 'Personnel' },
  { value: 'contractors', label: 'Contractors' },
  { value: 'other', label: 'Other / not sure' },
] as const;

export interface PeProfileDataIssueModalProps {
  open: boolean;
  peCode: string;
  defaultFy?: number | null;
  defaultFieldName?: string | null;
  onClose: () => void;
  onCreated?: (issueId: string) => void;
}

interface FormErrors {
  description?: string;
  suggestedSourceUrl?: string;
}

function validate(description: string, suggestedSourceUrl: string): FormErrors {
  const errors: FormErrors = {};
  if (!description.trim()) errors.description = 'Describe the issue';
  else if (description.length > 4000) errors.description = 'Max 4000 characters';
  const url = suggestedSourceUrl.trim();
  if (url && !/^https?:\/\/.+/i.test(url)) errors.suggestedSourceUrl = 'Must be an http(s) URL';
  return errors;
}

export function PeProfileDataIssueModal({
  open,
  peCode,
  defaultFy = null,
  defaultFieldName = null,
  onClose,
  onCreated,
}: PeProfileDataIssueModalProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useCapiroToast();

  const [issueType, setIssueType] = useState<string>('value_incorrect');
  const [fy, setFy] = useState<string>(defaultFy != null ? String(defaultFy) : '');
  const [fieldName, setFieldName] = useState<string>(defaultFieldName ?? '');
  const [description, setDescription] = useState('');
  const [suggestedSourceUrl, setSuggestedSourceUrl] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [touched, setTouched] = useState(false);

  const resetFields = () => {
    setIssueType('value_incorrect');
    setFy(defaultFy != null ? String(defaultFy) : '');
    setFieldName(defaultFieldName ?? '');
    setDescription('');
    setSuggestedSourceUrl('');
    setErrors({});
    setTouched(false);
  };

  // Mirror antd's destroyOnHidden: a fresh form every time the modal opens.
  useEffect(() => {
    if (open) resetFields();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      const parsedFy = fy.trim() === '' ? null : Number.parseInt(fy, 10);
      return createProgramElementDataIssue(api, peCode, {
        issueType,
        description,
        fy: parsedFy != null && Number.isFinite(parsedFy) ? parsedFy : null,
        fieldName: fieldName || null,
        suggestedSourceUrl: suggestedSourceUrl.trim() || null,
      });
    },
    onSuccess: async (created) => {
      toast.success(`Data issue reported (${created.id.slice(0, 8)}…)`);
      await queryClient.invalidateQueries({ queryKey: ['program-element-data-issues', peCode] });
      onCreated?.(created.id);
      resetFields();
      onClose();
    },
    onError: () => {
      toast.error('Unable to report data issue. Check fields and try again.');
    },
  });

  const submit = () => {
    setTouched(true);
    const nextErrors = validate(description, suggestedSourceUrl);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    mutation.mutate();
  };

  if (!open) return null;

  const liveErrors = touched ? validate(description, suggestedSourceUrl) : errors;

  return (
    <CapiroModal
      open={open}
      title={`Report data issue — ${peCode}`}
      onClose={() => {
        resetFields();
        onClose();
      }}
    >
      <div data-testid="pe-data-issue-modal" style={{ display: 'grid', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--capiro-color-text-body-secondary)' }}>
          Reports are tenant-scoped feedback. Submitting does not change canonical Program Element
          values — resolution still requires the reconciliation / override path.
        </p>
        <CapiroSelect
          label="Issue type"
          options={[...ISSUE_TYPES]}
          value={issueType}
          onChange={(event) => setIssueType(event.target.value)}
        />
        <CapiroInput
          label="Fiscal year (optional)"
          type="number"
          min={1900}
          max={2200}
          placeholder="e.g. 2026"
          value={fy}
          onChange={(event) => setFy(event.target.value)}
        />
        <CapiroSelect
          label="Field / claim (optional)"
          options={[...FIELD_OPTIONS]}
          value={fieldName}
          onChange={(event) => setFieldName(event.target.value)}
        />
        <label className="capiro-field">
          <span className="capiro-field__label">Description</span>
          <textarea
            className="capiro-input"
            rows={4}
            maxLength={4000}
            placeholder="What looks wrong, and why?"
            value={description}
            aria-invalid={Boolean(liveErrors.description)}
            onChange={(event) => setDescription(event.target.value)}
            style={{ resize: 'vertical', minHeight: 92, font: 'inherit' }}
          />
          {liveErrors.description ? (
            <span className="capiro-field__error">{liveErrors.description}</span>
          ) : (
            <span className="capiro-field__help">{description.length} / 4000</span>
          )}
        </label>
        <CapiroInput
          label="Official source URL (optional)"
          placeholder="https://…"
          value={suggestedSourceUrl}
          error={liveErrors.suggestedSourceUrl}
          onChange={(event) => setSuggestedSourceUrl(event.target.value)}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
          <CapiroButton
            onClick={() => {
              resetFields();
              onClose();
            }}
          >
            Cancel
          </CapiroButton>
          <CapiroButton variant="primary" loading={mutation.isPending} onClick={submit}>
            Submit report
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}
