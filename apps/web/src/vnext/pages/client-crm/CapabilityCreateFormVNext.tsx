import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CAPABILITY_TAG_SUGGESTIONS, SECTOR_LABELS, SECTOR_TAGS } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import type { Capability } from '../../../pages/clients/capability-types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { TRL_LABELS } from './CapabilityDrawerVNext.js';
import './capability-drawer-vnext.css';

/**
 * Capability CREATE form — vNext.
 *
 * `CapabilityDrawerVNext` is an editor: it renders nothing when `capability` is
 * null and saves each field on blur through
 * `PATCH …/capabilities/:id`, which needs a record that already exists. The
 * Capabilities tab nonetheless opened it with `capability={null}` for "Add
 * capability", so the modal came up titled "Capability — New capability" with an
 * EMPTY body and no way to create anything. This is the missing half: it collects
 * the fields `CreateCapabilityDto` accepts and POSTs
 * `/api/clients/:clientId/capabilities`, then hands the created record to the
 * caller so the editor can open on it (PE numbers, match keywords, and documents
 * live there and all need an id).
 *
 * Field set mirrors the canonical antd `AddCapabilityModal`
 * (pages/clients/ClientProfilePage.tsx) — name (required), type, sector, tags,
 * description, TRL — so both surfaces create the same shape. TRL reuses the
 * editor's own 1–9 ladder rather than a bare number input.
 *
 * Empty strings are sent as `null`/omitted: the API's `@IsOptional()` skips only
 * null/undefined, so `''` would fail validation with a 400 (the same trap the
 * canonical form documents in its `orNull` helper).
 */

const TYPE_OPTIONS = [
  { value: 'product', label: 'Product' },
  { value: 'service', label: 'Service' },
  { value: 'platform', label: 'Platform' },
  { value: 'technology', label: 'Technology' },
] as const;

export function CapabilityCreateFormVNext({
  clientId,
  onCancel,
  onCreated,
}: {
  clientId: string;
  onCancel: () => void;
  /** The freshly created record — the caller opens the editor on it. */
  onCreated: (capability: Capability) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();

  const [name, setName] = useState('');
  const [type, setType] = useState<string>('product');
  const [sector, setSector] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [trl, setTrl] = useState<number | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  // A tag typed but not yet committed with Enter must still count at submit:
  // clicking the submit button blurs the input, and reading committed state from
  // the click handler would race that blur's setState. The ref is read directly.
  const pendingTagRef = useRef('');

  const create = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      (await api.post<Capability>(`/api/clients/${clientId}/capabilities`, payload)).data,
    onSuccess: (capability) => {
      toast.success('Capability added');
      void qc.invalidateQueries({ queryKey: ['client-capabilities', clientId] });
      onCreated(capability);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Give the capability a name');
      return;
    }
    setNameError(null);
    const pending = pendingTagRef.current.trim();
    const allTags = normalizeTags(pending ? [...tags, ...pending.split(',')] : tags);
    create.mutate({
      name: trimmed,
      type,
      ...(sector ? { sector } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(allTags.length ? { tags: allTags } : {}),
      ...(trl != null ? { trl } : {}),
    });
  };

  return (
    <form
      className="capiro-capc"
      // `required` stays on the name input so assistive tech announces it, but
      // native constraint validation is off: it would swallow the submit event
      // and replace this form's own inline, design-system-styled message with a
      // browser bubble. Same split the client wizard uses (custom `fieldError`).
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="capiro-capd__hint" style={{ marginTop: 0 }}>
        Name it and save — PE numbers, match keywords, and documents open next, on the saved record.
      </p>

      <div className="capiro-capc__grid">
        <div className="capiro-capc__span2">
          <CapiroInput
            label="Name"
            placeholder="e.g. JaiaBot Hydro"
            required
            autoFocus
            value={name}
            error={nameError ?? undefined}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError(null);
            }}
          />
        </div>

        <CapiroSelect
          label="Type"
          value={type}
          options={TYPE_OPTIONS}
          onChange={(event) => setType(event.target.value)}
        />

        <CapiroSelect
          label="Sector"
          value={sector}
          helpText="Drives downstream agency and policy matching."
          options={[
            { value: '', label: 'Not set' },
            ...SECTOR_TAGS.map((tag) => ({ value: tag, label: SECTOR_LABELS[tag] })),
          ]}
          onChange={(event) => setSector(event.target.value)}
        />
      </div>

      <TagPicker
        values={tags}
        onChange={setTags}
        onPendingChange={(value) => {
          pendingTagRef.current = value;
        }}
      />

      <TrlPicker value={trl} onChange={setTrl} />

      <div className="capiro-capd__field">
        <label className="capiro-capd__field-label" htmlFor="capiro-capc-description">
          Description
        </label>
        <textarea
          id="capiro-capc-description"
          className="capiro-input capiro-capd__textarea"
          rows={3}
          placeholder="Describe this capability..."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="capiro-capc__footer">
        <CapiroButton variant="secondary" size="compact" type="button" onClick={onCancel}>
          Cancel
        </CapiroButton>
        <CapiroButton variant="primary" size="compact" type="submit" loading={create.isPending}>
          Add capability
        </CapiroButton>
      </div>
    </form>
  );
}

/**
 * Tags with the shared suggestion list. Reports every commit up immediately
 * (rather than the editor's save-on-blur) because the parent owns the draft
 * until submit, and also streams the uncommitted text so submit can pick it up.
 */
function TagPicker({
  values,
  onChange,
  onPendingChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  onPendingChange: (pending: string) => void;
}) {
  const [pending, setPending] = useState('');

  const commit = (raw: string) => {
    const next = normalizeTags([...values, ...raw.split(',')]);
    if (next.length !== values.length) onChange(next);
    setPending('');
    onPendingChange('');
  };

  return (
    <div className="capiro-capd__field">
      <div className="capiro-capd__field-label">Tags</div>
      {values.length ? (
        <div className="capiro-capd__chips">
          {values.map((token) => (
            <span className="capiro-capd__chip" key={token}>
              {token}
              <button
                type="button"
                className="capiro-capd__chip-x"
                aria-label={`Remove ${token}`}
                onClick={() => onChange(values.filter((t) => t !== token))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        className="capiro-input capiro-capd__token-input"
        placeholder="Pick or add tags"
        aria-label="Tags"
        list="capiro-capc-tag-suggestions"
        value={pending}
        onChange={(event) => {
          setPending(event.target.value);
          onPendingChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            // Enter must not submit the form while a tag is being typed.
            event.preventDefault();
            if (pending.trim()) commit(pending);
          } else if (event.key === 'Backspace' && !pending && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (pending.trim()) commit(pending);
        }}
      />
      <datalist id="capiro-capc-tag-suggestions">
        {CAPABILITY_TAG_SUGGESTIONS.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
    </div>
  );
}

/** The editor's TRL ladder, driving local draft state instead of a PATCH. */
function TrlPicker({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const label = value != null ? (TRL_LABELS[value - 1] ?? '') : '';
  return (
    <div className="capiro-capd__trl">
      <div className="capiro-capd__trl-head">
        <span className="capiro-capd__field-label">Technology Readiness Level</span>
        <span className="capiro-capd__trl-value">
          {value != null ? `TRL ${value}${label ? ` · ${label}` : ''}` : 'Not set — optional'}
        </span>
      </div>
      <div className="capiro-capd__trl-scale">
        {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => {
          const filled = value != null && n <= value;
          const selected = value === n;
          return (
            <button
              type="button"
              key={n}
              title={`TRL ${n}: ${TRL_LABELS[n - 1] ?? ''}`}
              aria-label={`TRL ${n}: ${TRL_LABELS[n - 1] ?? ''}`}
              aria-pressed={selected}
              onClick={() => onChange(selected ? null : n)}
              className={`capiro-capd__trl-step${filled ? ' is-filled' : ''}${selected ? ' is-selected' : ''}`}
            >
              {n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Trim, drop blanks, de-dupe — preserving first-seen order. */
function normalizeTags(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const cleaned = raw.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Could not add the capability';
}
