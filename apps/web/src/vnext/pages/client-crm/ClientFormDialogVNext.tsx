import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SECTOR_LABELS,
  SECTOR_TAGS,
  SUBMISSION_TRACKS,
  SUBMISSION_TRACK_LABELS,
  GRANTS_GOV_APPLICANT_TYPES,
} from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import type { Client, ClientFormSubmit, ClientFormValues } from '../../../pages/clients/clientTypes.js';
import { SET_ASIDE_CERTIFICATION_OPTIONS } from '../../../pages/clients/client-registrations.js';
import {
  CLIENT_FORM_STEP_FIELDS,
  CLIENT_FORM_STEP_TITLES,
  SAM_STATUS_OPTIONS,
  clientToFormValues,
  formValuesToClientPayload,
  formatPhone,
} from '../../../pages/clients/client-form-mapping.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import './client-form-dialog.css';

/**
 * Client form wizard — vNext (re-skin of `pages/clients/ClientFormModal.tsx`).
 *
 * Same contract, endpoints, validation, and behavior as the canonical antd
 * wizard — only the presentation moved to vNext primitives (`CapiroModal`,
 * `CapiroInput`, `CapiroSelect`, `CapiroButton`) and scoped CSS. Both wizards
 * read the SAME step structure and form ⇄ payload mapping from the UI-free
 * `pages/clients/client-form-mapping.ts`, so what the form collects and how it
 * round-trips through `Client.intakeData` cannot drift between surfaces.
 *
 * Reproduced behavior, deliberately unchanged:
 *  - 3 steps (post cleanup, 2026-08-23 — see client-form-mapping.ts comment
 *    for the full list of removed/merged fields); Next validates only the
 *    current step's fields; the final submit validates everything and jumps
 *    to (and focuses) the step that owns the first errored field.
 *  - Every step stays mounted (inactive ones `display: none`) so values and
 *    validation state survive Back/Next.
 *  - Logo sits below the steps on every step; the file is collected locally
 *    and handed to the caller as a `File` (`ClientFormSubmit`) — the caller
 *    owns the upload mutation, exactly as with the canonical modal. Document
 *    upload moved out of the wizard (attach via the client's Files tab
 *    instead) — `ClientFormSubmit.documents` is always sent empty from here.
 *  - Grant applicant types / set-aside certifications are fixed-list picks
 *    (never free-typed) because District Nexus and SAM matching compare the
 *    exact strings; NAICS/PSC are free token lists normalized at submit.
 */

interface ClientFormDialogVNextProps {
  open: boolean;
  mode: 'create' | 'edit';
  client?: Client | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (submission: ClientFormSubmit) => void;
}

type FieldErrors = Partial<Record<keyof ClientFormValues, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Same rules the antd wizard declared: name/website/description required,
 * primaryContactEmail must parse as an email when present. Everything else is
 * optional. Returns the message to show, or undefined when valid.
 */
function validateField(field: keyof ClientFormValues, values: ClientFormValues): string | undefined {
  if (field === 'name' && !(values.name ?? '').trim()) return 'Legal name is required';
  if (field === 'website' && !(values.website ?? '').trim()) return 'Website is required';
  if (field === 'description' && !(values.description ?? '').trim())
    return 'Company description is required';
  if (field === 'primaryContactEmail') {
    const email = (values.primaryContactEmail ?? '').trim();
    if (email && !EMAIL_RE.test(email)) return 'Enter a valid email address';
  }
  return undefined;
}

function fieldId(field: keyof ClientFormValues): string {
  return `capiro-cform-${field}`;
}

export function ClientFormDialogVNext({
  open,
  mode,
  client,
  submitting,
  onCancel,
  onSubmit,
}: ClientFormDialogVNextProps) {
  const [values, setValues] = useState<ClientFormValues>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    if (!open) return;
    setValues(clientToFormValues(client ?? undefined));
    setErrors({});
    setLogoFile(null);
    setCurrentStep(0);
  }, [client, open]);

  const isLastStep = currentStep === CLIENT_FORM_STEP_TITLES.length - 1;

  const set = <K extends keyof ClientFormValues>(field: K, value: ClientFormValues[K]) => {
    const next = { ...values, [field]: value };
    setValues(next);
    // A field that is currently showing an error re-validates as it changes,
    // so the message clears the moment the input becomes valid (antd's
    // post-failure validateTrigger behavior).
    setErrors((existing) =>
      existing[field] === undefined ? existing : { ...existing, [field]: validateField(field, next) },
    );
  };

  /** Validate one step's fields; merge messages into state; return the first errored field. */
  function validateStep(step: number): keyof ClientFormValues | null {
    const fields = CLIENT_FORM_STEP_FIELDS[step] ?? [];
    let first: keyof ClientFormValues | null = null;
    const found: FieldErrors = {};
    for (const field of fields) {
      const message = validateField(field, values);
      found[field] = message;
      if (message && first === null) first = field;
    }
    setErrors((existing) => ({ ...existing, ...found }));
    return first;
  }

  function focusField(field: keyof ClientFormValues) {
    // Defer until after the owning step re-renders out of display:none.
    setTimeout(() => {
      const el = document.getElementById(fieldId(field));
      el?.scrollIntoView?.({ block: 'center' });
      (el as HTMLElement | null)?.focus?.();
    }, 0);
  }

  function handleNext() {
    const invalid = validateStep(currentStep);
    if (invalid) {
      focusField(invalid);
      return;
    }
    setCurrentStep((s) => Math.min(s + 1, CLIENT_FORM_STEP_TITLES.length - 1));
  }

  function handleBack() {
    setCurrentStep((s) => Math.max(s - 1, 0));
  }

  // The final submit validates ALL steps; a failed field on a hidden
  // (display:none) step would otherwise give zero feedback. Jump to the step
  // that owns the first errored field, then focus/scroll it once visible.
  function handleSubmit() {
    for (let step = 0; step < CLIENT_FORM_STEP_FIELDS.length; step += 1) {
      const invalid = validateStep(step);
      if (invalid) {
        setCurrentStep(step);
        focusField(invalid);
        return;
      }
    }
    onSubmit({
      // Pass the existing client (edit mode) so intakeData merges over the
      // current blob instead of overwriting it — preserves wired keys the
      // wizard doesn't render (peNumber, profileNotes, governmentHistory,
      // dba, address, primaryNaics/additionalNaics — see
      // client-form-mapping.ts for the 2026-08-23 field removals).
      payload: formValuesToClientPayload(values, client ?? undefined),
      // Document upload moved out of the wizard — attach files via the
      // client's Files tab after saving instead.
      documents: [],
      logo: logoFile ?? undefined,
    });
  }

  if (!open) return null;

  return (
    <CapiroModal open title={mode === 'create' ? 'Add client' : 'Edit client'} onClose={onCancel}>
      <div className="capiro-cform">
        <ol className="capiro-cform__steps" aria-label="Form steps">
          {CLIENT_FORM_STEP_TITLES.map((title, index) => (
            <li
              key={title}
              className={`capiro-cform__step${index === currentStep ? ' is-active' : ''}${index < currentStep ? ' is-done' : ''}`}
              aria-current={index === currentStep ? 'step' : undefined}
            >
              <span className="capiro-cform__step-dot" aria-hidden>
                {index < currentStep ? '✓' : index + 1}
              </span>
              <span className="capiro-cform__step-title">{title}</span>
            </li>
          ))}
        </ol>

        {/* One value store spans all steps; every step stays mounted and the
            inactive ones hide with display:none rather than unmounting, so
            field values + validation state survive Back/Next. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (isLastStep) handleSubmit();
            else handleNext();
          }}
        >
          <div style={{ display: currentStep === 0 ? 'block' : 'none' }}>
            <CompanyInfoStep values={values} errors={errors} set={set} />
          </div>
          <div style={{ display: currentStep === 1 ? 'block' : 'none' }}>
            <GovRegistrationStep values={values} set={set} />
          </div>
          <div style={{ display: currentStep === 2 ? 'block' : 'none' }}>
            <SectorTracksStep values={values} set={set} enabled={open} />
          </div>

          {/* Logo — separate wired upload feature, shown on every step so it
              can be attached regardless of where the user is. Document
              upload moved to the Files tab. */}
          <div className="capiro-cform__divider" role="presentation">
            Logo
          </div>
          <FilePicker
            label="Client logo"
            buttonLabel="Select logo"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            files={logoFile ? [logoFile] : []}
            onAdd={(files) => setLogoFile(files[0] ?? null)}
            onRemove={() => setLogoFile(null)}
          />

          <div className="capiro-cform__footer">
            <CapiroButton variant="secondary" size="standard" onClick={onCancel}>
              Cancel
            </CapiroButton>
            {currentStep > 0 ? (
              <CapiroButton variant="secondary" size="standard" onClick={handleBack}>
                Back
              </CapiroButton>
            ) : null}
            {!isLastStep ? (
              <CapiroButton variant="primary" size="standard" onClick={handleNext}>
                Next
              </CapiroButton>
            ) : (
              <CapiroButton variant="primary" size="standard" type="submit" loading={submitting}>
                {mode === 'create' ? 'Add client' : 'Save changes'}
              </CapiroButton>
            )}
          </div>
        </form>
      </div>
    </CapiroModal>
  );
}

/* ── Step 1: Company Info ────────────────────────────────────────────────── */

interface StepProps {
  values: ClientFormValues;
  errors?: FieldErrors;
  set: <K extends keyof ClientFormValues>(field: K, value: ClientFormValues[K]) => void;
}

function CompanyInfoStep({ values, errors = {}, set }: StepProps) {
  return (
    <>
      <p className="capiro-cform__section-hint">Company Information</p>
      <div className="capiro-cform__grid">
        <CapiroInput
          id={fieldId('name')}
          label="Legal name"
          placeholder="Acme Defense Systems, Inc."
          value={values.name ?? ''}
          error={errors.name}
          onChange={(e) => set('name', e.target.value)}
        />
        <CapiroInput
          id={fieldId('website')}
          label="Website"
          placeholder="example.com"
          value={values.website ?? ''}
          error={errors.website}
          onChange={(e) => set('website', e.target.value)}
        />
        <div className="capiro-cform__span2">
          <CformTextArea
            id={fieldId('description')}
            label="Company description"
            rows={3}
            maxLength={600}
            value={values.description ?? ''}
            error={errors.description}
            onChange={(v) => set('description', v)}
          />
        </div>
      </div>

      <div className="capiro-cform__divider" role="presentation">
        Company contact
      </div>
      <div className="capiro-cform__grid">
        <CapiroInput
          id={fieldId('primaryContactEmail')}
          label="Main company email"
          placeholder="info@example.com"
          value={values.primaryContactEmail ?? ''}
          error={errors.primaryContactEmail}
          onChange={(e) => set('primaryContactEmail', e.target.value)}
        />
        <CapiroInput
          id={fieldId('primaryContactPhone')}
          label="Main company phone"
          placeholder="+1 202-555-0142"
          value={values.primaryContactPhone ?? ''}
          onChange={(e) => set('primaryContactPhone', e.target.value)}
          onBlur={(e) => set('primaryContactPhone', formatPhone(e.target.value))}
        />
      </div>

      <div className="capiro-cform__divider" role="presentation">
        Small Business Classification
      </div>
      <div className="capiro-cform__checkgrid">
        <CformCheck label="Small Business (SB)" checked={values.sbSb} onChange={(v) => set('sbSb', v)} />
        <CformCheck label="WOSB" checked={values.sbWosb} onChange={(v) => set('sbWosb', v)} />
        <CformCheck label="SDVOSB" checked={values.sbSdvosb} onChange={(v) => set('sbSdvosb', v)} />
        <CformCheck label="HUBZone" checked={values.sbHubzone} onChange={(v) => set('sbHubzone', v)} />
        <CformCheck label="8(a)" checked={values.sbEightA} onChange={(v) => set('sbEightA', v)} />
        <CformCheck label="Large Business" checked={values.sbLarge} onChange={(v) => set('sbLarge', v)} />
        <CformCheck
          label="Foreign-owned"
          checked={values.sbForeignOwned}
          onChange={(v) => set('sbForeignOwned', v)}
        />
      </div>
    </>
  );
}

/* ── Step 2: Gov't Registration ──────────────────────────────────────────── */

function GovRegistrationStep({ values, set }: StepProps) {
  return (
    <div className="capiro-cform__grid">
      <CapiroInput
        id={fieldId('cageCode')}
        label="CAGE Code"
        placeholder="1ABC2"
        maxLength={5}
        value={values.cageCode ?? ''}
        onChange={(e) => set('cageCode', e.target.value.toUpperCase())}
      />
      <CapiroInput
        id={fieldId('uei')}
        label="UEI"
        placeholder="ABC123DEF456"
        maxLength={12}
        value={values.uei ?? ''}
        onChange={(e) => set('uei', e.target.value.toUpperCase())}
      />
      <CapiroSelect
        id={fieldId('samStatus')}
        label="SAM.gov status"
        value={values.samStatus ?? ''}
        options={[{ value: '', label: 'Select status' }, ...SAM_STATUS_OPTIONS]}
        onChange={(e) => set('samStatus', e.target.value || undefined)}
      />
      <CapiroInput
        id={fieldId('samExpirationDate')}
        label="SAM.gov expiration date"
        type="date"
        value={values.samExpirationDate ?? ''}
        onChange={(e) => set('samExpirationDate', e.target.value)}
      />
      <CapiroInput
        id={fieldId('ldaRegistrantName')}
        label="LDA registrant name"
        placeholder="Registrant on LDA filings"
        value={values.ldaRegistrantName ?? ''}
        onChange={(e) => set('ldaRegistrantName', e.target.value)}
      />
      <CapiroInput
        id={fieldId('ein')}
        label="EIN"
        placeholder="12-3456789"
        value={values.ein ?? ''}
        onChange={(e) => set('ein', e.target.value)}
      />
      {/* Step 2.3 — first-class NAICS / PSC code lists. These drive client ⇄ PE
          relevance matching (procurement codes). The legacy free-text
          primaryNaics/additionalNaics pair was removed from the wizard
          2026-08-23 — this is the only NAICS input now. */}
      <TagListField
        id={fieldId('naicsCodes')}
        label="NAICS codes"
        placeholder="541330, 541512"
        helpText="Procurement NAICS codes for this client. Type a code and press Enter; used for client ⇄ Program-Element relevance matching."
        values={values.naicsCodes ?? []}
        onChange={(list) => set('naicsCodes', list)}
      />
      <TagListField
        id={fieldId('pscCodes')}
        label="PSC codes"
        placeholder="R425, AC12"
        helpText="Product/Service codes for this client. Type a code and press Enter; used for client ⇄ Program-Element relevance matching."
        values={values.pscCodes ?? []}
        onChange={(list) => set('pscCodes', list)}
      />
      {/* Grant eligibility. A fixed-list picker, deliberately NOT a free token
          input like the two above: District Nexus compares these strings
          directly against federal_grant.eligibility, so a free-typed value
          ("Small Business", "23") would save happily and then match nothing —
          leaving a client that looks configured and still never evaluates as
          eligible, which is worse than leaving it empty. */}
      <div className="capiro-cform__span2">
        <MultiCheckField
          id={fieldId('applicantTypes')}
          label="Grant applicant types"
          helpText="What this client qualifies as on Grants.gov. Drives the District Nexus grant-eligibility column — until it is set, every opportunity reads “needs review” rather than eligible."
          options={GRANTS_GOV_APPLICANT_TYPES.map((t) => ({ value: t, label: t }))}
          values={values.applicantTypes ?? []}
          onChange={(list) => set('applicantTypes', list)}
        />
      </div>
      <div className="capiro-cform__span2">
        <MultiCheckField
          id={fieldId('setAsideCertifications')}
          label="Federal set-aside certifications"
          helpText="Verified certifications used to evaluate SAM.gov set-aside eligibility. Select only certifications the client currently holds."
          // Shared with the read-side Registrations card (client-registrations.ts)
          // so the picked label and the rendered label are one list.
          options={[...SET_ASIDE_CERTIFICATION_OPTIONS]}
          values={values.setAsideCertifications ?? []}
          onChange={(list) => set('setAsideCertifications', list)}
        />
      </div>
    </div>
  );
}

/* ── Step 3: Sector & Tracks ─────────────────────────────────────────────── */

function SectorTracksStep({ values, set, enabled }: StepProps & { enabled: boolean }) {
  const api = useApi();
  // LDA issue-code reference list (code + English name), for the client-level
  // matching override below.
  const issuesQuery = useQuery<Array<{ code: string; name: string }>>({
    queryKey: ['lda-issues-options', 'client-form'],
    queryFn: async () =>
      (await api.get<Array<{ code: string; name: string }>>('/api/lda-intel/issues')).data,
    staleTime: 30 * 60 * 1000,
    enabled,
  });
  return (
    <>
      <CheckGroupField
        label="Sector tags"
        helpText="Multi-select. The first sector chosen becomes the primary sector that drives sector-adaptive intelligence panels and comment-period alerts."
        options={SECTOR_TAGS.map((t) => ({ value: t, label: SECTOR_LABELS[t] }))}
        values={values.sectors ?? []}
        onChange={(list) => set('sectors', list)}
      />

      <CheckGroupField
        label="Active submission tracks"
        helpText="Which legislative / advocacy vehicles this client uses. Drives the insight generator."
        options={SUBMISSION_TRACKS.map((t) => ({ value: t, label: SUBMISSION_TRACK_LABELS[t] }))}
        values={values.submissionTracks ?? []}
        onChange={(list) => set('submissionTracks', list)}
      />

      <MultiCheckField
        id={fieldId('issueCodes')}
        label="LDA issue codes (bill/policy matching)"
        helpText="Federal lobbying issue areas used to auto-match this client to bills and regulations. These normally fill in automatically from the client's LDA match — set them here to add or correct codes when that match is thin or missing."
        searchable
        loading={issuesQuery.isLoading}
        options={(issuesQuery.data ?? []).map((issue) => ({
          value: issue.code,
          label: `${issue.code} — ${issue.name}`,
        }))}
        values={values.issueCodes ?? []}
        onChange={(list) => set('issueCodes', list)}
      />

      <div className="capiro-cform__grid" style={{ marginTop: 12 }}>
        <CapiroInput
          id={fieldId('engagementStartDate')}
          label="Engagement start date"
          type="date"
          value={values.engagementStartDate ?? ''}
          onChange={(e) => set('engagementStartDate', e.target.value)}
        />
        <CapiroInput
          id={fieldId('primaryContactName')}
          label="Primary POC at client"
          placeholder="Jane Smith"
          value={values.primaryContactName ?? ''}
          onChange={(e) => set('primaryContactName', e.target.value)}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <CformTextArea
          id={fieldId('internalNotes')}
          label="Internal notes"
          rows={3}
          maxLength={2000}
          value={values.internalNotes ?? ''}
          onChange={(v) => set('internalNotes', v)}
        />
      </div>
    </>
  );
}

/* ── Local field controls (vNext-native, no design-system dependency) ─────── */

function CformTextArea({
  id,
  label,
  value,
  rows,
  maxLength,
  error,
  onChange,
}: {
  id?: string;
  label: string;
  value: string;
  rows: number;
  maxLength: number;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="capiro-field" htmlFor={id}>
      <span className="capiro-field__label">{label}</span>
      <textarea
        id={id}
        className="capiro-input capiro-cform__textarea"
        rows={rows}
        maxLength={maxLength}
        value={value}
        aria-invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="capiro-cform__count" aria-hidden>
        {value.length} / {maxLength}
      </span>
      {error ? <span className="capiro-field__error">{error}</span> : null}
    </label>
  );
}

function CformCheck({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="capiro-cform__check">
      <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** A labeled inline checkbox group (sectors, submission tracks). */
function CheckGroupField({
  label,
  helpText,
  options,
  values,
  onChange,
}: {
  label: string;
  helpText?: string;
  options: Array<{ value: string; label: string }>;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const toggle = (value: string, on: boolean) =>
    onChange(on ? [...values, value] : values.filter((v) => v !== value));
  return (
    <div className="capiro-field" style={{ marginBottom: 12 }}>
      <span className="capiro-field__label">{label}</span>
      {helpText ? <span className="capiro-field__help">{helpText}</span> : null}
      <div className="capiro-cform__checkgrid">
        {options.map((option) => (
          <CformCheck
            key={option.value}
            label={option.label}
            checked={values.includes(option.value)}
            onChange={(on) => toggle(option.value, on)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Fixed-list multi-select rendered as a bounded, scrollable checklist —
 * the vNext-native equivalent of antd's `Select mode="multiple"`. Values are
 * always picks from `options`; nothing can be free-typed (see the applicant-
 * types comment above for why that matters). `searchable` adds a filter box
 * for long lists (the LDA issue codes).
 */
function MultiCheckField({
  id,
  label,
  helpText,
  options,
  values,
  onChange,
  searchable = false,
  loading = false,
}: {
  id?: string;
  label: string;
  helpText?: string;
  options: Array<{ value: string; label: string }>;
  values: string[];
  onChange: (values: string[]) => void;
  searchable?: boolean;
  loading?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [filter, options]);
  const toggle = (value: string, on: boolean) =>
    onChange(on ? [...values, value] : values.filter((v) => v !== value));
  // Selections whose option is not in the (possibly still-loading) list are
  // real data — keep them visible and removable rather than silently hiding.
  const orphans = values.filter((v) => !options.some((o) => o.value === v));
  return (
    <div className="capiro-field" style={{ marginBottom: 12 }}>
      <span className="capiro-field__label">{label}</span>
      {helpText ? <span className="capiro-field__help">{helpText}</span> : null}
      {values.length ? (
        <div className="capiro-cform__chips">
          {values.map((v) => (
            <span className="capiro-cform__chip" key={v}>
              {options.find((o) => o.value === v)?.label ?? v}
              <button
                type="button"
                className="capiro-cform__chip-x"
                aria-label={`Remove ${v}`}
                onClick={() => toggle(v, false)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {searchable ? (
        <input
          id={id}
          className="capiro-input"
          placeholder={loading ? 'Loading issue codes…' : 'Filter the list'}
          aria-label={`Filter ${label}`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      ) : null}
      <div className="capiro-cform__checklist" role="group" aria-label={label} id={searchable ? undefined : id}>
        {loading ? (
          <span className="capiro-field__help">Loading…</span>
        ) : visible.length === 0 ? (
          <span className="capiro-field__help">No options match.</span>
        ) : (
          visible.map((option) => (
            <CformCheck
              key={option.value}
              label={option.label}
              checked={values.includes(option.value)}
              onChange={(on) => toggle(option.value, on)}
            />
          ))
        )}
        {orphans.length > 0 && !loading
          ? orphans.map((v) => (
              <CformCheck key={v} label={v} checked onChange={(on) => toggle(v, on)} />
            ))
          : null}
      </div>
    </div>
  );
}

/**
 * Free token-list input (NAICS/PSC codes) — the vNext-native equivalent of
 * antd's `Select mode="tags"`. Enter, comma, or space commits the pending
 * token; blur commits it too, so nothing typed is silently lost. Values are
 * kept as typed here; the shared payload mapping trims/uppercases/dedupes at
 * submit (`normalizeCodes`).
 */
function TagListField({
  id,
  label,
  placeholder,
  helpText,
  values,
  onChange,
}: {
  id?: string;
  label: string;
  placeholder?: string;
  helpText?: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [pending, setPending] = useState('');
  const commit = (raw: string) => {
    const tokens = raw
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tokens.length) return;
    const next = [...values];
    for (const token of tokens) if (!next.includes(token)) next.push(token);
    onChange(next);
  };
  return (
    <label className="capiro-field" htmlFor={id}>
      <span className="capiro-field__label">{label}</span>
      {values.length ? (
        <div className="capiro-cform__chips">
          {values.map((v) => (
            <span className="capiro-cform__chip" key={v}>
              {v}
              <button
                type="button"
                className="capiro-cform__chip-x"
                aria-label={`Remove ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        id={id}
        className="capiro-input"
        placeholder={placeholder}
        value={pending}
        onChange={(e) => setPending(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
            e.preventDefault();
            commit(pending);
            setPending('');
          } else if (e.key === 'Backspace' && !pending && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => {
          commit(pending);
          setPending('');
        }}
      />
      {helpText ? <span className="capiro-field__help">{helpText}</span> : null}
    </label>
  );
}

/**
 * Local file collector — mirrors the canonical `Upload` usage: `beforeUpload`
 * returned false there, so files were only COLLECTED, never posted, until the
 * caller's submit mutation uploads them. Same here: a hidden input feeds the
 * list, and removal is local.
 */
function FilePicker({
  label,
  buttonLabel,
  accept,
  multiple = false,
  files,
  onAdd,
  onRemove,
}: {
  label: string;
  buttonLabel: ReactNode;
  accept?: string;
  multiple?: boolean;
  files: File[];
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    if (picked.length) onAdd(picked);
    // Reset so picking the same file again re-fires change.
    event.target.value = '';
  };
  return (
    <div className="capiro-field capiro-cform__files">
      <span className="capiro-field__label">{label}</span>
      <div>
        <CapiroButton variant="secondary" size="compact" onClick={() => inputRef.current?.click()}>
          {buttonLabel}
        </CapiroButton>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleChange}
          style={{ display: 'none' }}
          aria-label={label}
        />
      </div>
      {files.length ? (
        <ul className="capiro-cform__filelist">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="capiro-cform__file">
              <span className="capiro-cform__file-name">{file.name}</span>
              <button
                type="button"
                className="capiro-cform__chip-x"
                aria-label={`Remove ${file.name}`}
                onClick={() => onRemove(index)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
