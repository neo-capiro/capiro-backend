import { useState } from 'react';
import {
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileTextOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Input,
  InputNumber,
  Select,
  Skeleton,
  Typography,
  Upload,
} from 'antd';
import { CAPABILITY_TAG_SUGGESTIONS } from '@capiro/shared';
import { useApi } from '../../lib/use-api.js';
import { attachmentContentType } from '../../lib/attachment-content-type.js';
import type { ClientAttachment } from './clientTypes.js';
import type { Capability, SubmissionHistory } from './capability-types.js';

// The domain types moved to the UI-free `capability-types.ts` so vNext modules
// can share them without a runtime path into this antd-carrying file. Existing
// importers of this module keep working through this re-export.
export type { Capability, SubmissionHistory } from './capability-types.js';

const OUTCOME_CSS: Record<string, string> = {
  success: 'she-outcome-success',
  partial: 'she-outcome-partial',
  failed: 'she-outcome-failed',
  in_progress: 'she-outcome-in_progress',
};

const DOT_CSS: Record<string, string> = {
  success: 'she-dot-success',
  partial: 'she-dot-partial',
  failed: 'she-dot-failed',
  in_progress: 'she-dot-in_progress',
};

const OUTCOME_LABELS: Record<string, string> = {
  success: 'Success',
  partial: 'Partial',
  failed: 'Failed',
  in_progress: 'In Progress',
};

const TYPE_CSS: Record<string, string> = {
  product: 'cap-type-product',
  service: 'cap-type-service',
  platform: 'cap-type-platform',
  technology: 'cap-type-technology',
};

const TRL_LABELS = [
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

const MRL_LABELS = [
  'Manufacturing implications',
  'Concepts identified',
  'Proof of concept',
  'Lab environment',
  'Prototype capability',
  'Relevant environment',
  'Production environment',
  'Pilot line',
  'Low rate production',
  'Full rate production',
];

interface Props {
  capability: Capability | null;
  clientId: string;
  onClose: () => void;
  onUpdated: () => void;
  /** Optional: when provided, a delete control is shown in the drawer header. */
  onDelete?: () => void;
}

export function CapabilityDrawer({ capability, clientId, onClose, onUpdated, onDelete }: Props) {
  const api = useApi();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const [drawerTab, setDrawerTab] = useState<'profile' | 'documents'>('profile');

  const patchCapability = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (await api.patch(`/api/clients/${clientId}/capabilities/${capability!.id}`, patch)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-capabilities', clientId] });
      onUpdated();
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  if (!capability) return null;

  const typeClass = TYPE_CSS[capability.type] ?? 'cap-type-product';

  return (
    <div className="cap-drawer">
      <div className="cap-drawer-hd">
        <div style={{ flex: 1 }}>
          <div className="cap-drawer-name">{capability.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className={`cap-type-tag ${typeClass}`} style={{ textTransform: 'capitalize' }}>
              {capability.type}
            </span>
            {capability.sector ? <span className="cap-sector-tag">{capability.sector}</span> : null}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {onDelete ? (
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              onClick={onDelete}
              aria-label="Delete capability"
              title="Delete capability"
            />
          ) : null}
          <button
            className="cap-drawer-close"
            onClick={onClose}
            aria-label="Close drawer"
            title="Close"
          >
            <CloseOutlined style={{ fontSize: 13 }} />
          </button>
        </div>
      </div>

      <div className="cap-drawer-tabs" role="tablist" aria-label="Capability sections">
        {(['profile', 'documents'] as const).map((tab) => (
          <div
            key={tab}
            className={`cap-drawer-tab${drawerTab === tab ? ' active' : ''}`}
            onClick={() => setDrawerTab(tab)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setDrawerTab(tab);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
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
          </div>
        ))}
      </div>

      <div className="cap-drawer-body">
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

      <InlineTags tags={capability.tags ?? []} onSave={(tags) => onPatch({ tags })} />

      {/* Step 2.3 — explicit PE numbers (strongest relevance path) + match keywords. */}
      <InlineCodeTags
        label="PE numbers"
        placeholder="e.g. 0604201A — add and press Enter"
        values={capability.peNumbers ?? []}
        upper
        onSave={(peNumbers) => onPatch({ peNumbers })}
      />

      <InlineCodeTags
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

      <div style={{ marginTop: 8 }}>
        <InlineTextArea
          label="Notes"
          value={capability.notes ?? ''}
          placeholder="Internal notes..."
          onSave={(v) => onPatch({ notes: v || null })}
        />
      </div>
    </>
  );
}

/**
 * TRL as a clickable 1–9 ladder (replaces the old single thin bar). Each step is a
 * segment; segments up to the current level are filled, the active one is ringed.
 * Clicking a step sets it; clicking the active step clears it.
 */
function TrlScale({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const label = value != null ? (TRL_LABELS[value - 1] ?? '') : '';
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 6,
          gap: 8,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
          Technology Readiness Level
        </span>
        <span style={{ fontSize: 12, color: '#888', textAlign: 'right' }}>
          {value != null ? `TRL ${value}${label ? ` · ${label}` : ''}` : 'Not set — click to set'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => {
          const filled = value != null && n <= value;
          const selected = value === n;
          return (
            <button
              type="button"
              key={n}
              title={`TRL ${n}: ${TRL_LABELS[n - 1] ?? ''}`}
              aria-label={`TRL ${n}: ${TRL_LABELS[n - 1] ?? ''}`}
              onClick={() => onSave(selected ? null : n)}
              style={{
                flex: 1,
                height: 30,
                borderRadius: 6,
                border: selected ? '2px solid #1677ff' : '1px solid #d9d9d9',
                background: filled ? '#1677ff' : '#f5f5f5',
                color: filled ? '#fff' : '#999',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                padding: 0,
              }}
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
  const { message } = AntApp.useApp();
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
      message.success('Document added');
      void qc.invalidateQueries({ queryKey: ['capability-documents', clientId, capabilityId] });
      void qc.invalidateQueries({ queryKey: ['client-attachments', clientId] });
      void qc.invalidateQueries({ queryKey: ['client-attachments-count', clientId] });
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const list = docs.data ?? [];

  return (
    <div>
      <Upload
        multiple
        showUploadList={false}
        accept=".pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.csv,image/*"
        beforeUpload={(file) => {
          void uploadMutation.mutateAsync(file as File);
          return false;
        }}
      >
        <Button icon={<UploadOutlined />} loading={uploadMutation.isPending} size="small">
          Upload document
        </Button>
      </Upload>
      <Typography.Paragraph type="secondary" style={{ fontSize: 11.5, margin: '8px 0 12px' }}>
        Documents added here are scoped to this capability and also appear in the client&apos;s
        Documents tab.
      </Typography.Paragraph>

      {docs.isLoading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : list.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((d) => (
            <div
              key={d.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                border: '1px solid #f0f0f0',
                borderRadius: 8,
              }}
            >
              <FileTextOutlined style={{ color: '#888' }} />
              <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {d.fileName}
              </span>
              {d.downloadUrl ? (
                <a href={d.downloadUrl} target="_blank" rel="noreferrer" title="Download">
                  <DownloadOutlined />
                </a>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          No documents yet for this capability.
        </Typography.Text>
      )}
    </div>
  );
}

function HistoryTab({
  history,
  loading,
  addingHistory,
  onAdd,
  onCancelAdd,
  onCreateHistory,
  onDeleteHistory,
  creating,
}: {
  history: SubmissionHistory[];
  loading: boolean;
  addingHistory: boolean;
  onAdd: () => void;
  onCancelAdd: () => void;
  onCreateHistory: (data: {
    fiscalYear: string;
    title: string;
    meta?: string;
    outcomeType?: string;
    notes?: string;
  }) => void;
  onDeleteHistory: (id: string) => void;
  creating: boolean;
}) {
  const [fy, setFy] = useState('');
  const [title, setTitle] = useState('');
  const [meta, setMeta] = useState('');
  const [outcomeType, setOutcomeType] = useState('in_progress');
  const [notes, setNotes] = useState('');

  const resetForm = () => {
    setFy('');
    setTitle('');
    setMeta('');
    setOutcomeType('in_progress');
    setNotes('');
    onCancelAdd();
  };

  if (loading) return <Skeleton active paragraph={{ rows: 4 }} />;

  return (
    <>
      {history.length === 0 && !addingHistory ? (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          No submission history yet.
        </Typography.Text>
      ) : null}

      {history.map((entry) => (
        <div className="sub-hist-entry" key={entry.id}>
          <div className="she-year">{entry.fiscalYear}</div>
          <div className={`she-dot ${DOT_CSS[entry.outcomeType] ?? 'she-dot-in_progress'}`} />
          <div className="she-content">
            <div className="she-title">{entry.title}</div>
            {entry.meta ? <div className="she-meta">{entry.meta}</div> : null}
            <span
              className={`she-outcome ${OUTCOME_CSS[entry.outcomeType] ?? 'she-outcome-in_progress'}`}
            >
              {OUTCOME_LABELS[entry.outcomeType] ?? entry.outcomeType}
            </span>
            {entry.notes ? <div className="she-notes">{entry.notes}</div> : null}
          </div>
          <Button
            size="small"
            type="text"
            icon={<DeleteOutlined />}
            danger
            onClick={() => onDeleteHistory(entry.id)}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
        </div>
      ))}

      {addingHistory ? (
        <div
          style={{
            border: '1px solid #e8e8e8',
            borderRadius: 8,
            padding: '14px 16px',
            marginTop: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <Typography.Text strong style={{ fontSize: 12 }}>
            New Entry
          </Typography.Text>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              placeholder="FY27"
              value={fy}
              onChange={(e) => setFy(e.target.value)}
              style={{ width: 80 }}
              size="small"
            />
            <Input
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ flex: 1 }}
              size="small"
            />
          </div>
          <Input
            placeholder="Meta (committee, member, PE)"
            value={meta}
            onChange={(e) => setMeta(e.target.value)}
            size="small"
          />
          <Select
            size="small"
            value={outcomeType}
            onChange={setOutcomeType}
            options={[
              { label: 'In Progress', value: 'in_progress' },
              { label: 'Success', value: 'success' },
              { label: 'Partial', value: 'partial' },
              { label: 'Failed', value: 'failed' },
            ]}
          />
          <Input.TextArea
            placeholder="Notes..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            size="small"
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="small" onClick={resetForm}>
              Cancel
            </Button>
            <Button
              size="small"
              type="primary"
              loading={creating}
              disabled={!fy.trim() || !title.trim()}
              onClick={() => {
                onCreateHistory({
                  fiscalYear: fy.trim(),
                  title: title.trim(),
                  meta: meta.trim() || undefined,
                  outcomeType,
                  notes: notes.trim() || undefined,
                });
                resetForm();
              }}
            >
              Add
            </Button>
          </div>
        </div>
      ) : (
        <button className="she-add-btn" onClick={onAdd}>
          <PlusOutlined /> Add submission entry
        </button>
      )}
    </>
  );
}

function ReadinessItem({
  label,
  value,
  max,
  labels,
  onSave,
}: {
  label: string;
  value: number | null;
  max: number;
  labels: string[];
  onSave: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);
  const pct = value != null ? Math.round((value / max) * 100) : 0;
  const desc = value != null ? (labels[value - 1] ?? '') : '';

  return (
    <div className="rm-item">
      <div className="rm-label">{label}</div>
      {editing ? (
        <InputNumber
          min={1}
          max={max}
          value={draft ?? undefined}
          onChange={(v) => setDraft(v ?? null)}
          onBlur={() => {
            setEditing(false);
            onSave(draft);
          }}
          onPressEnter={() => {
            setEditing(false);
            onSave(draft);
          }}
          size="small"
          style={{ width: 70 }}
          autoFocus
        />
      ) : (
        <div
          className="rm-val"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          style={{ cursor: 'pointer' }}
          title="Click to edit"
        >
          {value != null ? value : '-'}
        </div>
      )}
      <div className="rm-bar">
        <div className="rm-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {desc ? <div className="rm-desc">{desc}</div> : null}
    </div>
  );
}

function InlineFieldRow({
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
    <div className="cap-field-row">
      <span className="cap-field-key">{label}</span>
      {editing ? (
        <Input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            onSave(draft);
          }}
          onPressEnter={() => {
            setEditing(false);
            onSave(draft);
          }}
          size="small"
          autoFocus
          style={{ flex: 1 }}
        />
      ) : (
        <span
          className="cap-field-val"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          style={{ cursor: 'pointer', minHeight: 18 }}
          title="Click to edit"
        >
          {value || (
            <span style={{ color: '#bfbfbf', fontStyle: 'italic' }}>{placeholder ?? '-'}</span>
          )}
        </span>
      )}
    </div>
  );
}

function InlineNumberRow({
  label,
  value,
  onSave,
}: {
  label: string;
  value: number | null;
  onSave: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(value);

  const display = value != null ? `$${value.toLocaleString()}` : null;

  return (
    <div className="cap-field-row">
      <span className="cap-field-key">{label}</span>
      {editing ? (
        <InputNumber
          value={draft ?? undefined}
          onChange={(v) => setDraft(v ?? null)}
          onBlur={() => {
            setEditing(false);
            onSave(draft);
          }}
          onPressEnter={() => {
            setEditing(false);
            onSave(draft);
          }}
          size="small"
          autoFocus
          style={{ flex: 1 }}
          formatter={(v) => (v ? `$${Number(v).toLocaleString()}` : '')}
          parser={(v) => Number(v?.replace(/[^0-9]/g, '') ?? 0)}
          min={0}
        />
      ) : (
        <span
          className="cap-field-val"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          style={{ cursor: 'pointer', minHeight: 18 }}
          title="Click to edit"
        >
          {display ?? <span style={{ color: '#bfbfbf', fontStyle: 'italic' }}>-</span>}
        </span>
      )}
    </div>
  );
}

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
    <div style={{ marginBottom: 12 }}>
      <div className="ps-title" style={{ marginBottom: 6 }}>
        {label}
      </div>
      {editing ? (
        <Input.TextArea
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            onSave(draft);
          }}
          rows={3}
          autoFocus
        />
      ) : (
        <div
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          style={{
            fontSize: 12.5,
            color: value ? '#262626' : '#bfbfbf',
            fontStyle: value ? 'normal' : 'italic',
            cursor: 'pointer',
            lineHeight: 1.6,
            padding: '4px 0',
            minHeight: 22,
          }}
          title="Click to edit"
        >
          {value || placeholder || '-'}
        </div>
      )}
    </div>
  );
}

/**
 * Editable tag row for a capability. Tags drive bill matching and intelligence
 * triage, so they must be editable after creation (not only in the add modal).
 * Saves on blur to avoid a PATCH per keystroke; tags are normalized server-side.
 */
function InlineTags({ tags, onSave }: { tags: string[]; onSave: (tags: string[]) => void }) {
  const [draft, setDraft] = useState<string[]>(tags);
  const [dirty, setDirty] = useState(false);

  // Keep local draft in sync when the underlying capability changes (e.g. after
  // a successful save re-fetches), unless the user is mid-edit.
  if (!dirty && draft !== tags && draft.join('\0') !== tags.join('\0')) {
    setDraft(tags);
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="ps-title" style={{ marginBottom: 6 }}>
        Tags
      </div>
      <Select
        mode="tags"
        allowClear
        size="small"
        style={{ width: '100%' }}
        placeholder="Pick or add tags"
        tokenSeparators={[',']}
        value={draft}
        options={CAPABILITY_TAG_SUGGESTIONS.map((t) => ({ label: t, value: t }))}
        onChange={(v) => {
          setDirty(true);
          setDraft(v as string[]);
        }}
        onBlur={() => {
          if (dirty) onSave(draft);
          setDirty(false);
        }}
      />
    </div>
  );
}

/**
 * Step 2.3 — inline editor for a free code/keyword list (PE numbers, match keywords).
 * Mirrors InlineTags but without the curated tag suggestions; optionally uppercases each
 * token (PE codes). Saves on blur, only when the draft changed.
 */
function InlineCodeTags({
  label,
  placeholder,
  values,
  upper = false,
  onSave,
}: {
  label: string;
  placeholder: string;
  values: string[];
  upper?: boolean;
  onSave: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>(values);
  const [dirty, setDirty] = useState(false);

  // Keep local draft in sync when the underlying capability changes (after a save
  // re-fetches), unless the user is mid-edit.
  if (!dirty && draft !== values && draft.join(' ') !== values.join(' ')) {
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

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="ps-title" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <Select
        mode="tags"
        allowClear
        size="small"
        style={{ width: '100%' }}
        placeholder={placeholder}
        tokenSeparators={[',', ' ']}
        value={draft}
        options={[]}
        onChange={(v) => {
          setDirty(true);
          setDraft(v as string[]);
        }}
        onBlur={() => {
          if (dirty) onSave(normalize(draft));
          setDirty(false);
        }}
      />
    </div>
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
