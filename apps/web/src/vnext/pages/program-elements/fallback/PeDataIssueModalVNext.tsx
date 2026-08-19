/**
 * Report data issue — native vNext port of
 * `pages/program-element/ProgramElementDataIssueModal.tsx` (re-skin: same
 * endpoint/payload/validation/copy; antd Form → controlled vNext fields).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { createProgramElementDataIssue } from '../../../../pages/program-element/api.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput, CapiroSelect } from '../../../components/fields/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';

const ISSUE_TYPES = [
  { value: 'value_incorrect', label: 'Value incorrect' },
  { value: 'missing_value', label: 'Missing value' },
  { value: 'wrong_source', label: 'Wrong source' },
  { value: 'wrong_stage_or_vehicle', label: 'Wrong stage or vehicle' },
  { value: 'wrong_pe_attribution', label: 'Wrong PE attribution' },
  { value: 'other', label: 'Other' },
] as const;

const FIELD_OPTIONS = [
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

export interface PeDataIssueModalVNextProps {
  open: boolean;
  peCode: string;
  defaultFy?: number | null;
  defaultFieldName?: string | null;
  onClose: () => void;
  onCreated?: (issueId: string) => void;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function PeDataIssueModalVNext({
  open,
  peCode,
  defaultFy = null,
  defaultFieldName = null,
  onClose,
  onCreated,
}: PeDataIssueModalVNextProps) {
  const api = useApi();
  const toast = useCapiroToast();
  const queryClient = useQueryClient();

  const [issueType, setIssueType] = useState<string>('value_incorrect');
  const [fy, setFy] = useState<string>(defaultFy != null ? String(defaultFy) : '');
  const [fieldName, setFieldName] = useState<string>(defaultFieldName ?? '');
  const [description, setDescription] = useState('');
  const [suggestedSourceUrl, setSuggestedSourceUrl] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  // Mirror antd Form's initialValues semantics: reset the fields whenever the
  // modal (re)opens with new defaults.
  useEffect(() => {
    if (open) {
      setIssueType('value_incorrect');
      setFy(defaultFy != null ? String(defaultFy) : '');
      setFieldName(defaultFieldName ?? '');
      setDescription('');
      setSuggestedSourceUrl('');
      setShowErrors(false);
    }
  }, [open, defaultFy, defaultFieldName]);

  const fyNumber = fy.trim() === '' ? null : Number.parseInt(fy, 10);
  const fyInvalid =
    fy.trim() !== '' && (!Number.isFinite(fyNumber) || fyNumber! < 1900 || fyNumber! > 2200);
  const descriptionError = !description.trim()
    ? 'Describe the issue'
    : description.length > 4000
      ? 'Max 4000 characters'
      : null;
  const urlError =
    suggestedSourceUrl.trim() && !isHttpUrl(suggestedSourceUrl.trim())
      ? 'Must be an http(s) URL'
      : null;
  const valid = !descriptionError && !urlError && !fyInvalid;

  const mutation = useMutation({
    mutationFn: async () => {
      return createProgramElementDataIssue(api, peCode, {
        issueType,
        description,
        fy: fyInvalid ? null : fyNumber,
        fieldName: fieldName || null,
        suggestedSourceUrl: suggestedSourceUrl.trim() || null,
      });
    },
    onSuccess: async (created) => {
      toast.success(`Data issue reported (${created.id.slice(0, 8)}…)`);
      await queryClient.invalidateQueries({ queryKey: ['program-element-data-issues', peCode] });
      onCreated?.(created.id);
      onClose();
    },
    onError: () => {
      toast.error('Unable to report data issue. Check fields and try again.');
    },
  });

  const submit = () => {
    setShowErrors(true);
    if (!valid) return;
    mutation.mutate();
  };

  if (!open) return null;

  return (
    <CapiroModal open={open} title={`Report data issue — ${peCode}`} onClose={onClose}>
      <div className="pe-fb-form" data-testid="pe-data-issue-modal">
        <span className="pe-fb-muted" style={{ display: 'block', marginBottom: 12 }}>
          Reports are tenant-scoped feedback. Submitting does not change canonical Program Element
          values — resolution still requires the reconciliation / override path.
        </span>
        <CapiroSelect
          label="Issue type"
          value={issueType}
          onChange={(event) => setIssueType(event.target.value)}
          options={[...ISSUE_TYPES]}
        />
        <CapiroInput
          label="Fiscal year (optional)"
          type="number"
          min={1900}
          max={2200}
          placeholder="e.g. 2026"
          value={fy}
          error={showErrors && fyInvalid ? 'Enter a year between 1900 and 2200' : undefined}
          onChange={(event) => setFy(event.target.value)}
        />
        <CapiroSelect
          label="Field / claim (optional)"
          value={fieldName}
          onChange={(event) => setFieldName(event.target.value)}
          options={[{ value: '', label: 'Select a field' }, ...FIELD_OPTIONS]}
        />
        <label className="capiro-field">
          <span className="capiro-field__label">Description</span>
          <textarea
            className="pe-fb-textarea"
            rows={4}
            maxLength={4000}
            placeholder="What looks wrong, and why?"
            value={description}
            aria-invalid={Boolean(showErrors && descriptionError)}
            onChange={(event) => setDescription(event.target.value)}
          />
          <span className="pe-fb-muted" style={{ fontSize: 11, alignSelf: 'flex-end' }}>
            {description.length} / 4000
          </span>
          {showErrors && descriptionError ? (
            <span className="capiro-field__error">{descriptionError}</span>
          ) : null}
        </label>
        <CapiroInput
          label="Official source URL (optional)"
          placeholder="https://…"
          value={suggestedSourceUrl}
          error={showErrors && urlError ? urlError : undefined}
          onChange={(event) => setSuggestedSourceUrl(event.target.value)}
        />
        <div className="pe-fb-modal-footer">
          <CapiroButton onClick={onClose}>Cancel</CapiroButton>
          <CapiroButton variant="primary" loading={mutation.isPending} onClick={submit}>
            Submit report
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}
