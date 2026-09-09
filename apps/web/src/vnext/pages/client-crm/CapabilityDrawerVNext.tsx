import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CAPABILITY_TAG_SUGGESTIONS } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { attachmentContentType } from '../../../lib/attachment-content-type.js';
import type { ClientAttachment } from '../../../pages/clients/clientTypes.js';
import type { Capability } from '../../../pages/clients/capability-types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroDownloadIcon, CapiroFileTextIcon } from '../../components/icons/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import './capability-drawer-vnext.css';

/**
 * Capability editor — vNext (re-skin of `pages/clients/CapabilityDrawer.tsx`).
 *
 * Same props contract, endpoints, and behavior as the canonical drawer — only
 * the presentation moved off antd onto vNext primitives and scoped CSS. The
 * domain type comes from the shared UI-free `capability-types.ts`.
 *
 * Reproduced behavior, deliberately unchanged:
 *  - Renders nothing when `capability` is null (the canonical contract).
 *  - Profile tab: the clickable TRL 1–9 ladder (click sets, clicking the active
 *    step clears), tags with the shared suggestion list, the Step 2.3 PE-number
 *    and match-keyword token lists (PE codes uppercased), and click-to-edit
 *    Description / Notes. Every edit saves on blur via
 *    `PATCH /api/clients/:clientId/capabilities/:id` and invalidates
 *    `['client-capabilities', clientId]`.
 *  - Documents tab: per-capability uploads through the shared engagement-
 *    attachment flow (presigned S3 POST → confirm) tagged `capability:<id>` and
 *    the clientId, so files scope here AND appear in the client's Documents tab.
 *  - Toasts replace `AntApp.useApp().message` (success 'Document added',
 *    errors from the API message).
 */

const TYPE_TONE: Record<string, 'info' | 'success' | 'warning' | 'neutral'> = {
  product: 'info',
  service: 'success',
  platform: 'neutral',
  technology: 'warning',
};

export const TRL_LABELS = [
  'Basic principles',
  'Concept formulated',
  'Proof of concept',
  'Lab validated',
  'Relevant environment',
  'Prototype demonstrated',
  'System prototype',
  'System qualified',
  'Operational proven',
];

interface Props {
  capability: Capability | null;
  clientId: string;
  onClose: () => void;
  onUpdated: () => void;
  /** Optional: when provided, a delete control is shown in the panel header. */
  onDelete?: () => void;
}

export function CapabilityDrawerVNext({ capability, clientId, onClose, onUpdated, onDelete }: Props) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [drawerTab, setDrawerTab] = useState<'profile' | 'documents'>('profile');

  const patchCapability = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (await api.patch(`/api/clients/${clientId}/capabilities/${capability!.id}`, patch)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-capabilities', clientId] });
      onUpdated();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!capability) return null;

  return (
    <div className="capiro-capd">
      <div className="capiro-capd__head">
        <div className="capiro-capd__head-main">
          <div className="capiro-capd__name">{capability.name}</div>
          <div className="capiro-capd__head-tags">
            <CapiroBadge tone={TYPE_TONE[capability.type] ?? 'info'} className="capiro-capd__type">
              {capability.type}
            </CapiroBadge>
            {capability.sector ? <CapiroBadge>{capability.sector}</CapiroBadge> : null}
          </div>
        </div>
        <div className="capiro-capd__head-actions">
          {onDelete ? (
            <button
              type="button"
              className="capiro-capd__delete"
              onClick={onDelete}
              aria-label="Delete capability"
              title="Delete capability"
            >
              Delete
            </button>
          ) : null}
          <button
            type="button"
            className="capiro-capd__close"
            onClick={onClose}
            aria-label="Close drawer"
            title="Close"
          >
            ×
          </button>
        </div>
      </div>

      <div className="capiro-capd__tabs" role="tablist" aria-label="Capability sections">
        {(['profile', 'documents'] as const).map((tab) => (
          <button
            type="button"
            key={tab}
            className={`capiro-capd__tab${drawerTab === tab ? ' is-active' : ''}`}
            onClick={() => setDrawerTab(tab)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                // Two tabs only — either arrow activates (and focuses) the other one.
                event.preventDefault();
                setDrawerTab(tab === 'profile' ? 'documents' : 'profile');
                const sibling = (event.currentTarget.nextElementSibling ??
                  event.currentTarget.previousElementSibling) as HTMLElement | null;
                sibling?.focus();
              }
            }}
            role="tab"
            aria-selected={drawerTab === tab}
            tabIndex={drawerTab === tab ? 0 : -1}
          >
            {tab === 'profile' ? 'Profile' : 'Documents'}
          </button>
        ))}
      </div>

      <div className="capiro-capd__body">
        {drawerTab === 'profile' && (
          <ProfileTab capability={capability} onPatch={(p) => patchCapability.mutate(p)} />
        )}
        {drawerTab === 'documents' && (
          <CapabilityDocumentsTab clientId={clientId} capabilityId={capability.id} />
        )}
      </div>
    </div>
  );
}

function ProfileTab({
  capability,
  onPatch,
}: {
  capability: Capability;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
      <TrlScale value={capability.trl} onSave={(v) => onPatch({ trl: v })} />

      <InlineTokenList
        label="Tags"
        placeholder="Pick or add tags"
        values={capability.tags ?? []}
        suggestions={[...CAPABILITY_TAG_SUGGESTIONS]}
        onSave={(tags) => onPatch({ tags })}
      />

      {/* Step 2.3 — explicit PE numbers (strongest relevance path) + match keywords. */}
      <InlineTokenList
        label="PE numbers"
        placeholder="e.g. 0604201A — add and press Enter"
        values={capability.peNumbers ?? []}
        upper
        onSave={(peNumbers) => onPatch({ peNumbers })}
      />

      <InlineTokenList
        label="Match keywords"
        placeholder="Keywords that match PE text (e.g. counter-UAS)"
        values={capability.keywords ?? []}
        onSave={(keywords) => onPatch({ keywords })}
      />

      <InlineTextArea
        label="Description"
        value={capability.description ?? ''}
        placeholder="Describe this capability..."
        onSave={(v) => onPatch({ description: v || null })}
      />

      <InlineTextArea
        label="Notes"
        value={capability.notes ?? ''}
        placeholder="Internal notes..."
        onSave={(v) => onPatch({ notes: v || null })}
      />
    </>
  );
}

/**
 * TRL as a clickable 1–9 ladder. Each step is a segment; segments up to the
 * current level are filled, the active one is ringed. Clicking a step sets it;
 * clicking the active step clears it.
 *
 * Exported so the create form (CapabilityCreateFormVNext) collects TRL with the
 * exact same control the editor uses, rather than a second number input that
 * would look and behave differently for the same field.
 */
export function TrlScale({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const label = value != null ? (TRL_LABELS[value - 1] ?? '') : '';
  return (
    <div className="capiro-capd__trl">
      <div className="capiro-capd__trl-head">
        <span className="capiro-capd__field-label">Technology Readiness Level</span>
        <span className="capiro-capd__trl-value">
          {value != null ? `TRL ${value}${label ? ` · ${label}` : ''}` : 'Not set — click to set'}
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
              onClick={() => onSave(selected ? null : n)}
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

/**
 * Inline editable token list (tags / PE numbers / match keywords) — the
 * vNext-native equivalent of the canonical drawer's `Select mode="tags"` rows.
 * Enter/comma stages a token locally; blur commits it and SAVES once, only if
 * changed (one PATCH per typing session, not per keystroke). Optional `upper`
 * uppercases each token (PE codes); tokens are de-duped. `suggestions` feed a
 * native datalist so curated tags stay one keystroke away.
 *
 * Removal (Q05) can't wait for that same blur: clicking a chip's × is often
 * the ONLY interaction with the field, so the token `<input>` never gets
 * focus, never blurs, and a remove that only touched `draft` silently never
 * reached the server. `remove` PATCHes immediately instead; `add` keeps
 * deferring to blur since typing implies more interaction with the input.
 */
function InlineTokenList({
  label,
  placeholder,
  values,
  suggestions,
  upper = false,
  onSave,
}: {
  label: string;
  placeholder: string;
  values: string[];
  suggestions?: string[];
  upper?: boolean;
  onSave: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>(values);
  const [pending, setPending] = useState('');
  const [dirty, setDirty] = useState(false);
  const listId = suggestions ? `capiro-capd-suggest-${label.replace(/\W+/g, '-')}` : undefined;

  // Keep local draft in sync when the underlying capability changes (after a
  // save re-fetches), unless the user is mid-edit.
  if (!dirty && draft !== values && draft.join('\0') !== values.join('\0')) {
    setDraft(values);
  }

  function normalize(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const cleaned = upper ? raw.trim().toUpperCase() : raw.trim();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
    return out;
  }

  const add = (raw: string): string[] => {
    const tokens = raw
      .split(/[,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tokens.length) return draft;
    const next = [...draft];
    for (const token of tokens) if (!next.includes(token)) next.push(token);
    setDirty(true);
    setDraft(next);
    return next;
  };

  // Saves immediately (Q05, see doc comment above). Stays `dirty` so the
  // resync-from-props check above doesn't stomp this optimistic update
  // before the PATCH's refetch lands a fresh value.
  const remove = (token: string) => {
    const next = normalize(draft.filter((t) => t !== token));
    setDirty(true);
    setDraft(next);
    onSave(next);
  };

  return (
    <div className="capiro-capd__field">
      <div className="capiro-capd__field-label">{label}</div>
      {draft.length ? (
        <div className="capiro-capd__chips">
          {draft.map((token) => (
            <span className="capiro-capd__chip" key={token}>
              {token}
              <button
                type="button"
                className="capiro-capd__chip-x"
                aria-label={`Remove ${token}`}
                onClick={() => remove(token)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        className="capiro-input capiro-capd__token-input"
        placeholder={placeholder}
        aria-label={label}
        value={pending}
        list={listId}
        onChange={(e) => setPending(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(pending);
            setPending('');
          } else if (e.key === 'Backspace' && !pending && draft.length) {
            remove(draft[draft.length - 1]!);
          }
        }}
        onBlur={() => {
          // Commit anything still typed, then save once — only when changed.
          const next = pending.trim() ? add(pending) : draft;
          setPending('');
          if (dirty || next !== draft) onSave(normalize(next));
          setDirty(false);
        }}
      />
      {suggestions ? (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

/** Click-to-edit multiline text (Description / Notes). Saves on blur. */
function InlineTextArea({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  return (
    <div className="capiro-capd__field">
      <div className="capiro-capd__field-label">{label}</div>
      {editing ? (
        <textarea
          className="capiro-input capiro-capd__textarea"
          value={draft}
          placeholder={placeholder}
          rows={3}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            onSave(draft);
          }}
        />
      ) : (
        <button
          type="button"
          className={`capiro-capd__text-view${value ? '' : ' is-empty'}`}
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          title="Click to edit"
        >
          {value || placeholder || '-'}
        </button>
      )}
    </div>
  );
}

/**
 * Per-capability documents. Uploads go through the shared engagement-attachment
 * flow (presigned S3 POST → confirm) tagged with source `capability:<id>` AND the
 * clientId — so each file is scoped to this capability here AND automatically
 * shows up in the client's Documents tab.
 */
function CapabilityDocumentsTab({
  clientId,
  capabilityId,
}: {
  clientId: string;
  capabilityId: string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const source = `capability:${capabilityId}`;

  const docs = useQuery<ClientAttachment[]>({
    queryKey: ['capability-documents', clientId, capabilityId],
    queryFn: async () =>
      (
        await api.get<ClientAttachment[]>('/api/engagement/attachments', {
          params: { clientId },
        })
      ).data,
    select: (rows) => rows.filter((r) => r.source === source),
  });

  const uploadOne = async (file: File) => {
    // See attachment-content-type.ts: an empty file.type (common for .txt/.csv/
    // .docx depending on OS picker) must not fall back to
    // 'application/octet-stream' — that is the one content type the server's
    // allowlist rejects, so the upload 400'd on files the server would have
    // happily accepted, and the drawer had nothing to show for why.
    const contentType = attachmentContentType(file);
    const presigned = (
      await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
        '/api/engagement/attachments/upload-url',
        { clientId, fileName: file.name, contentType, contentLength: file.size },
      )
    ).data;
    const form = new FormData();
    Object.entries(presigned.fields).forEach(([k, v]) => form.append(k, v));
    form.append('file', file);
    const s3Res = await fetch(presigned.url, { method: 'POST', body: form });
    if (!s3Res.ok) throw new Error('Upload to storage failed');
    await api.post('/api/engagement/attachments/confirm', {
      clientId,
      fileName: file.name,
      contentType,
      s3Key: presigned.s3Key,
      source,
    });
  };

  const uploadMutation = useMutation({
    mutationFn: uploadOne,
    onSuccess: () => {
      toast.success('Document added');
      void qc.invalidateQueries({ queryKey: ['capability-documents', clientId, capabilityId] });
      void qc.invalidateQueries({ queryKey: ['client-attachments', clientId] });
      void qc.invalidateQueries({ queryKey: ['client-attachments-count', clientId] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const list = docs.data ?? [];

  return (
    <div>
      <FileUploadButton
        accept=".pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.csv,image/*"
        loading={uploadMutation.isPending}
        onFiles={(files) => {
          for (const file of files) void uploadMutation.mutateAsync(file);
        }}
      />
      <p className="capiro-capd__hint">
        Documents added here are scoped to this capability and also appear in the client&apos;s
        Documents tab.
      </p>

      {docs.isLoading ? (
        <div className="capiro-capd__doc-skeleton" aria-busy="true" aria-label="Loading documents" />
      ) : list.length ? (
        <div className="capiro-capd__docs">
          {list.map((d) => (
            <div key={d.id} className="capiro-capd__doc">
              <CapiroFileTextIcon />
              <span className="capiro-capd__doc-name">{d.fileName}</span>
              {d.downloadUrl ? (
                <a
                  href={d.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Download"
                  aria-label={`Download ${d.fileName}`}
                  className="capiro-capd__doc-download"
                >
                  <CapiroDownloadIcon />
                </a>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="capiro-capd__empty">No documents yet for this capability.</p>
      )}
    </div>
  );
}

/** Hidden-input file trigger — collects Files and hands them to the caller. */
function FileUploadButton({
  accept,
  loading,
  onFiles,
}: {
  accept: string;
  loading: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <>
      <CapiroButton
        variant="secondary"
        size="compact"
        loading={loading}
        onClick={() =>
          (document.getElementById('capiro-capd-upload') as HTMLInputElement | null)?.click()
        }
      >
        Upload document
      </CapiroButton>
      <input
        id="capiro-capd-upload"
        type="file"
        multiple
        accept={accept}
        style={{ display: 'none' }}
        aria-label="Upload document"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) onFiles(files);
          event.target.value = '';
        }}
      />
    </>
  );
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
