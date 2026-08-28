import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Check,
  CircleAlert,
  Copy,
  FileText,
  History,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  Search,
} from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import { OutreachTemplateWizard } from './OutreachTemplateWizard.js';
import {
  archiveOutreachTemplate,
  diffOutreachTemplateSpecs,
  duplicateOutreachTemplate,
  getOutreachTemplate,
  listOutreachTemplates,
  publishOutreachTemplate,
  updateOutreachTemplateMetadata,
  useOutreachTemplate,
  type OutreachTemplateApplicationReceipt,
  type OutreachTemplateDetail,
  type OutreachTemplateMetadataInput,
  type OutreachTemplateScope,
  type OutreachTemplateSortKey,
  type OutreachTemplateSpec,
  type OutreachTemplateSpecFieldDiff,
  type OutreachTemplateSummary,
  type OutreachTemplateVariable,
} from './outreach-v3-template-api.js';
import './outreach-builder.css';
import './outreach-v3-templates.css';

/**
 * Outreach home — the Templates library.
 *
 * Laid out exactly as the Engagement V2 prototype's `homeIsTemplates` branch:
 * mono eyebrow, heading, subline, a six-chip category row with a right-aligned
 * search, and a `minmax(280px,1fr)` card grid whose card carries one primary
 * action.
 *
 * Three prototype behaviours are deliberately NOT reproduced, all of them the
 * kind of fabrication the prototype can afford and a real library cannot:
 *
 *  - its `mine` filter has no branch at all, so "My templates" silently shows
 *    the whole library. Here it is the server's real `mineOnly` (owner = you).
 *  - its `archived` filter is a hardcoded `return false`. Here it is the real
 *    `includeArchived` read, filtered to the rows the server marked archived.
 *  - its unpublished card keeps the full primary gradient and swallows the
 *    click. Here the button is genuinely `disabled`.
 *
 * The `capiro` category IS still permanently empty, because that is true:
 * `outreach-template.contract.ts` deliberately ships no Capiro/system scope
 * (no seed or governance model exists yet), and its empty state says so.
 *
 * The prototype's card has one action and no authoring affordance anywhere.
 * The repo's six management actions and `Create template` are real, tested
 * capability, so they are moved rather than deleted — the six sit behind the
 * card's overflow menu, `Create template` and sort sit in the header.
 */

type LibraryCategory = 'all' | 'capiro' | 'firm' | 'client' | 'mine' | 'archived';

/** Chip order and labels are the prototype's, left to right. */
const CATEGORIES: ReadonlyArray<{ key: LibraryCategory; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'capiro', label: 'Capiro' },
  { key: 'firm', label: 'Firm' },
  { key: 'client', label: 'Client' },
  { key: 'mine', label: 'My templates' },
  { key: 'archived', label: 'Archived' },
];

const SCOPE_LABELS: Record<OutreachTemplateScope, string> = {
  private: 'Only me',
  client: 'Client',
  firm: 'Firm',
};

const SORT_OPTIONS: ReadonlyArray<{ key: OutreachTemplateSortKey; label: string }> = [
  { key: 'updated', label: 'Last updated' },
  { key: 'usage', label: 'Most used' },
  { key: 'last_used', label: 'Last used' },
  { key: 'name', label: 'Name' },
];

const CAPIRO_EMPTY = "Capiro-curated templates aren't available in this release yet.";
const NO_MATCH_EMPTY = 'No templates match this view. Try a different category or search.';

function requestKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return '00000000-0000-4000-8000-000000000000'.replace(/[018]/g, (value) =>
    (Number(value) ^ (Math.random() * 16 >> (Number(value) / 4))).toString(16),
  );
}

function templateSummary(template: OutreachTemplateSummary): string {
  const summary = template.previewSummary;
  if (!summary) return 'No published or draft strategy is available.';
  const values = [
    summary.topic,
    summary.tone ? `${summary.tone} tone` : null,
    summary.length !== 'undecided' ? `${summary.length} length` : null,
    summary.deliveryPattern !== 'undecided' ? summary.deliveryPattern.replaceAll('_', ' ') : null,
  ].filter(Boolean);
  return values.join(' · ') || 'Reusable campaign strategy and voice.';
}

function formatWhen(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

/** The prototype's `Aug 14` — month short + day, no year, no time. */
function formatUsedOn(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * `usage + '× · last ' + (lastUsed || 'never')` — U+00D7 multiplication sign,
 * U+00B7 middle dot, both from the prototype.
 */
function usageLabel(template: OutreachTemplateSummary): string {
  return `${template.usageCount}× · last ${template.lastUsedAt ? formatUsedOn(template.lastUsedAt) : 'never'}`;
}

/**
 * `Published v3` / `Draft v1`. The prototype's seed always carries a number;
 * a real row may not — a non-manager never learns the draft version number —
 * so the bare word is used rather than inventing a `v1`.
 */
function versionLabel(template: OutreachTemplateSummary): string {
  if (template.publishedVersionId) {
    return template.publishedVersionNumber != null
      ? `Published v${template.publishedVersionNumber}`
      : 'Published';
  }
  return template.draftVersionNumber != null ? `Draft v${template.draftVersionNumber}` : 'Draft';
}

interface CardMenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * The card's overflow menu. It exists only because the prototype's single
 * action would otherwise delete six working, capability-gated controls; at
 * rest the card still reads as the prototype's.
 */
function TemplateCardMenu({ templateName, items }: { templateName: string; items: CardMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!items.length) return null;
  return (
    <div className="otl-menu" ref={wrap}>
      <button
        type="button"
        className="otl-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Manage ${templateName}`}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <div className="otl-menu__list" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="otl-menu__item"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EditTemplateDialog({
  template,
  selectedClientId,
  pending,
  onClose,
  onSave,
}: {
  template: OutreachTemplateSummary;
  selectedClientId: string | null;
  pending: boolean;
  onClose: () => void;
  onSave: (input: OutreachTemplateMetadataInput) => void;
}) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const [campaignType, setCampaignType] = useState(template.campaignType ?? '');
  const [scope, setScope] = useState<OutreachTemplateScope>(template.scope);
  const clientId = scope === 'client' ? template.clientId || selectedClientId : null;
  return (
    <EngagementDialog
      open
      eyebrow="Template settings"
      title="Edit template"
      description="Metadata can change. Published strategy versions remain immutable."
      width={580}
      busy={pending}
      dirty={name !== template.name || description !== (template.description ?? '') || scope !== template.scope}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="uui-button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="uui-button--primary"
            disabled={pending || !name.trim() || (scope === 'client' && !clientId)}
            onClick={() => onSave({
              name: name.trim(),
              description: description.trim() || null,
              campaignType: campaignType.trim() || null,
              scope,
              clientId,
            })}
          >
            {pending ? <Loader2 className="uui-spin" size={14} /> : <Check size={14} />}
            Save settings
          </button>
        </>
      }
    >
      <div className="uui-template-dialog-fields">
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} /></label>
        <label>Description<textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} /></label>
        <label>Campaign type<input value={campaignType} onChange={(event) => setCampaignType(event.target.value)} maxLength={60} /></label>
        <label>Who can use it<select value={scope} onChange={(event) => setScope(event.target.value as OutreachTemplateScope)}><option value="private">Only me</option><option value="firm">The firm</option><option value="client" disabled={!selectedClientId && !template.clientId}>This client</option></select></label>
        {scope === 'client' ? <p>This template remains inside the selected client scope.</p> : null}
      </div>
    </EngagementDialog>
  );
}

function VariablePromptDialog({
  templateName,
  variables,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  templateName: string;
  variables: OutreachTemplateVariable[];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(variables.map((v) => [v.key, v.defaultValue ?? ''])),
  );
  const missing = variables.filter((v) => v.required && !values[v.key]?.trim());
  return (
    <EngagementDialog
      open
      eyebrow="Before you start"
      title={`Answer a few questions for "${templateName}"`}
      description="These answers are recorded on this campaign only — never stored back on the template."
      width={600}
      busy={pending}
      error={error}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="uui-button" onClick={onClose}>Cancel</button>
          <button type="button" className="uui-button--primary" disabled={pending || missing.length > 0} onClick={() => onSubmit(values)}>
            {pending ? <Loader2 className="uui-spin" size={14} /> : <Play size={14} />} Start campaign
          </button>
        </>
      }
    >
      <div className="uui-template-dialog-fields">
        {variables.map((variable) => (
          <label key={variable.key}>
            {variable.label}{variable.required ? ' *' : ''}
            {variable.resolutionPolicy === 'meri_can_determine' ? <span className="uui-template-card__badge"> Meri can determine</span> : null}
            {variable.question ? <p>{variable.question}</p> : null}
            {variable.type === 'choice' ? (
              <select value={values[variable.key] ?? ''} onChange={(e) => setValues((prev) => ({ ...prev, [variable.key]: e.target.value }))}>
                <option value="">Choose…</option>
                {(variable.choices ?? []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
              </select>
            ) : (
              <input
                type={variable.type === 'number' ? 'number' : variable.type === 'date' ? 'date' : variable.type === 'email' ? 'email' : variable.type === 'url' ? 'url' : 'text'}
                value={values[variable.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [variable.key]: e.target.value }))}
                placeholder={variable.resolutionPolicy === 'always_ask' ? 'Answer every time' : undefined}
              />
            )}
          </label>
        ))}
      </div>
    </EngagementDialog>
  );
}

function ReceiptDialog({
  receipt,
  onContinue,
}: {
  receipt: OutreachTemplateApplicationReceipt;
  onContinue: () => void;
}) {
  return (
    <EngagementDialog
      open
      eyebrow="Template applied"
      title={`${receipt.templateName} · v${receipt.templateVersionNumber}`}
      width={620}
      onClose={onContinue}
      footer={<button type="button" className="uui-button--primary" onClick={onContinue}>Continue to campaign</button>}
    >
      <div className="uui-template-receipt-list">
        {receipt.inherited.length ? (
          <div><h4>Inherited</h4><ul>{receipt.inherited.map((item) => <li key={item.field}><strong>{item.label}</strong><span>{item.detail}</span></li>)}</ul></div>
        ) : null}
        {receipt.refreshed.length ? (
          <div><h4>Refreshed for this campaign</h4><ul>{receipt.refreshed.map((item) => <li key={item.field}><strong>{item.label}</strong><span>{item.detail}</span></li>)}</ul></div>
        ) : null}
        {receipt.unresolved.length ? (
          <div><h4>Needs your decision</h4><ul>{receipt.unresolved.map((item) => <li key={item.field}><strong>{item.label}</strong><span>{item.detail ?? 'Open in Plan.'}</span></li>)}</ul></div>
        ) : null}
      </div>
    </EngagementDialog>
  );
}

function HistoryDialog({
  templateId,
  clientId,
  onClose,
}: {
  templateId: string;
  clientId: string | null;
  onClose: () => void;
}) {
  const api = useApi();
  const [compareId, setCompareId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ['outreach-v3', 'templates', 'detail', templateId, clientId],
    queryFn: () => getOutreachTemplate(api, templateId, clientId),
  });
  const versions = detail.data?.versions ?? [];
  const latest = versions.at(0) ?? null;
  const compareTo = versions.find((v) => v.id === compareId) ?? versions.at(1) ?? null;
  const diff: OutreachTemplateSpecFieldDiff[] = useMemo(
    () => (latest && compareTo ? diffOutreachTemplateSpecs(compareTo.spec, latest.spec) : []),
    [latest, compareTo],
  );
  return (
    <EngagementDialog open eyebrow="Version history" title={detail.data?.template.name ?? 'Template history'} width={680} onClose={onClose} footer={<button type="button" className="uui-button" onClick={onClose}>Close</button>}>
      {detail.isLoading ? <p><Loader2 className="uui-spin" size={14} /> Loading…</p> : null}
      {detail.isError ? <p role="alert">{safeOutreachV3Error(detail.error)}</p> : null}
      <div className="uui-template-version-list">
        {versions.map((version) => (
          <div key={version.id} className="uui-template-version-row" data-lifecycle={version.lifecycle}>
            <span>v{version.versionNumber} · {version.lifecycle}{version.publishedAt ? ` · ${formatWhen(version.publishedAt)}` : ''}</span>
            <button type="button" className="uui-button" onClick={() => setCompareId(version.id)}>Compare</button>
          </div>
        ))}
        {!detail.isLoading && !versions.length ? <p>No version history yet.</p> : null}
      </div>
      {latest && compareTo && latest.id !== compareTo.id ? (
        <div className="uui-template-diff">
          <p>v{compareTo.versionNumber} → v{latest.versionNumber}</p>
          {diff.length ? diff.map((row) => (
            <div key={row.field} className="uui-template-diff-row">
              <span>{row.field}</span><span className="before">{row.before}</span><span>→</span><span className="after">{row.after}</span>
            </div>
          )) : <p>No reusable-field differences.</p>}
        </div>
      ) : null}
    </EngagementDialog>
  );
}

export function VNextOutreachTemplates({
  selectedClientId,
  onOpenCampaign,
}: {
  selectedClientId: string | null;
  onOpenCampaign: (sessionId: string) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [category, setCategory] = useState<LibraryCategory>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<OutreachTemplateSortKey>('updated');
  const [editing, setEditing] = useState<OutreachTemplateSummary | null>(null);
  const [wizard, setWizard] = useState<
    { mode: 'create' } | { mode: 'edit'; template: OutreachTemplateSummary; spec: OutreachTemplateSpec } | null
  >(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [pendingUse, setPendingUse] = useState<OutreachTemplateSummary | null>(null);
  const [useDetail, setUseDetail] = useState<OutreachTemplateDetail | null>(null);
  const [useError, setUseError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ sessionId: string; receipt: OutreachTemplateApplicationReceipt } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The prototype filters a module constant on every keystroke. This search is
  // a server read, so it is debounced — the field itself still updates at once.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Only two categories change what the server is asked for; the rest are
  // client-side views of the same read, so switching them is instant the way
  // the prototype's chips are.
  const includeArchived = category === 'archived';
  const mineOnly = category === 'mine';

  const templates = useQuery({
    queryKey: ['outreach-v3', 'templates', selectedClientId, includeArchived, mineOnly, search, sort],
    queryFn: () => listOutreachTemplates(api, {
      clientId: selectedClientId,
      includeArchived,
      search: search || null,
      mineOnly,
      sort,
    }),
    retry: false,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['outreach-v3', 'templates'] });

  const allRows = useMemo(() => templates.data ?? [], [templates.data]);
  const rows = useMemo(() => {
    const active = allRows.filter((t) => t.status === 'active');
    switch (category) {
      // No `capiro` scope exists — see the contract note quoted in the file
      // header. Never ask the server for one, never fabricate a row.
      case 'capiro': return [];
      case 'firm': return active.filter((t) => t.scope === 'firm');
      case 'client': return active.filter((t) => t.scope === 'client');
      // The server already restricted this read to templates you own.
      case 'mine': return active;
      case 'archived': return allRows.filter((t) => t.status === 'archived');
      default: return active;
    }
  }, [allRows, category]);

  const useTemplate = useMutation({
    mutationFn: ({ template, variableValues }: { template: OutreachTemplateSummary; variableValues: Record<string, string> }) =>
      useOutreachTemplate(api, template.id, {
        requestKey: requestKey(),
        title: template.name,
        clientId: selectedClientId,
        variableValues,
      }),
    onSuccess: (result) => {
      setUseError(null);
      setPendingUse(null);
      setUseDetail(null);
      setReceipt({ sessionId: result.sessionId, receipt: result.receipt });
    },
    onError: (error) => setUseError(safeOutreachV3Error(error)),
  });
  const publish = useMutation({
    mutationFn: (templateId: string) => publishOutreachTemplate(api, templateId),
    onSuccess: async () => { setActionError(null); await invalidate(); },
    onError: (error) => setActionError(safeOutreachV3Error(error)),
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: OutreachTemplateMetadataInput }) =>
      updateOutreachTemplateMetadata(api, id, input),
    onSuccess: async () => { setActionError(null); setEditing(null); await invalidate(); },
    onError: (error) => setActionError(safeOutreachV3Error(error)),
  });
  const archive = useMutation({
    mutationFn: (templateId: string) => archiveOutreachTemplate(api, templateId),
    onSuccess: async () => { setActionError(null); await invalidate(); },
    onError: (error) => setActionError(safeOutreachV3Error(error)),
  });
  const duplicate = useMutation({
    mutationFn: (templateId: string) => duplicateOutreachTemplate(api, templateId, { clientId: selectedClientId }),
    onSuccess: async () => { setActionError(null); await invalidate(); },
    onError: (error) => setActionError(safeOutreachV3Error(error)),
  });

  const startUse = async (template: OutreachTemplateSummary) => {
    setUseError(null);
    setPendingUse(template);
    try {
      const detail = await getOutreachTemplate(api, template.id, selectedClientId);
      const publishedSpec = detail.versions.find((v) => v.id === template.publishedVersionId)?.spec;
      if (!publishedSpec || !publishedSpec.variables.length) {
        useTemplate.mutate({ template, variableValues: {} });
        setPendingUse(null);
        return;
      }
      setUseDetail(detail);
    } catch (error) {
      setUseError(safeOutreachV3Error(error));
    }
  };

  const openEditContent = async (template: OutreachTemplateSummary) => {
    try {
      const detail = await getOutreachTemplate(api, template.id, selectedClientId);
      const spec = detail.versions.find((v) => v.id === template.currentDraftVersionId)?.spec
        ?? detail.versions.find((v) => v.id === template.publishedVersionId)?.spec
        ?? detail.versions.at(0)?.spec;
      if (!spec) { setActionError('This template has no content to edit yet.'); return; }
      setWizard({ mode: 'edit', template, spec });
    } catch (error) {
      setActionError(safeOutreachV3Error(error));
    }
  };

  const busyList = templates.isLoading;
  const showCapiroEmpty = !busyList && !templates.isError && category === 'capiro';
  const showNoMatch = !busyList && !templates.isError && category !== 'capiro' && !rows.length;

  return (
    <section className="otl">
      <div className="otl__head">
        <div className="otl__headings">
          <span className="ocb-eyebrow">Templates</span>
          <h2 className="otl__title">Start from an approved way of working</h2>
          <p className="ocb-prose otl__sub">
            Templates carry reusable strategy, questions, and guardrails. Recipients, evidence, context,
            approvals, and sending are refreshed in the new campaign.
          </p>
        </div>
        {/* The prototype has no authoring affordance at all. Creating and
            sorting are real here, so they sit in the header rather than in the
            card row the prototype specifies. */}
        <div className="otl__head-actions">
          <select
            className="ocb-select otl__sort"
            aria-label="Sort templates"
            value={sort}
            onChange={(event) => setSort(event.target.value as OutreachTemplateSortKey)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="ocb-btn ocb-btn--secondary"
            disabled={templates.isFetching}
            onClick={() => void templates.refetch()}
          >
            {templates.isFetching ? <Loader2 className="uui-spin" size={14} /> : <RefreshCcw size={14} />}
            Refresh
          </button>
          <button type="button" className="ocb-btn ocb-btn--primary" onClick={() => setWizard({ mode: 'create' })}>
            <Plus size={16} />
            Create template
          </button>
        </div>
      </div>

      <div className="otl__controls">
        {CATEGORIES.map((entry) => {
          // Client-scoped templates are only visible to a request that asserts
          // a client, so without one this chip could only ever be empty. A
          // disabled chip says that; the prototype's live-but-empty chip does
          // not.
          const unavailable = entry.key === 'client' && !selectedClientId;
          return (
            <button
              key={entry.key}
              type="button"
              className="ocb-chip"
              data-active={category === entry.key || undefined}
              aria-pressed={category === entry.key}
              disabled={unavailable}
              title={unavailable ? 'Choose a client to see client-scoped templates.' : undefined}
              onClick={() => setCategory(entry.key)}
            >
              {entry.label}
            </button>
          );
        })}
        <span className="otl__spacer" />
        <div className="ocb-search otl__search">
          <Search size={16} />
          <input
            type="text"
            aria-label="Search templates"
            placeholder="Search templates…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
      </div>

      {actionError ? <div className="otl-error" role="alert"><CircleAlert size={16} />{actionError}</div> : null}
      {useError && !useDetail ? <div className="otl-error" role="alert"><CircleAlert size={16} />{useError}</div> : null}
      {templates.isError ? (
        <div className="uui-engagement-error uui-engagement-error--inside" role="alert">
          <strong>Templates could not be loaded</strong>
          <p>{safeOutreachV3Error(templates.error)}</p>
        </div>
      ) : null}
      {busyList ? <div className="otl-grid" aria-busy="true"><i /><i /><i /></div> : null}

      {showCapiroEmpty ? <div className="ocb-card ocb-empty--center otl-empty">{CAPIRO_EMPTY}</div> : null}
      {showNoMatch ? <div className="ocb-card ocb-empty--center otl-empty">{NO_MATCH_EMPTY}</div> : null}

      {rows.length ? (
        <div className="otl-grid">
          {rows.map((template) => {
            const published = Boolean(template.publishedVersionId);
            const busy = pendingUse?.id === template.id && (useTemplate.isPending || Boolean(useDetail));
            const caps = template.capabilities;
            const menuItems: CardMenuItem[] = [];
            if (caps.canDuplicate) menuItems.push({ key: 'duplicate', label: 'Duplicate', icon: <Copy size={14} />, disabled: duplicate.isPending, onSelect: () => duplicate.mutate(template.id) });
            if (caps.canPublish && template.currentDraftVersionId) menuItems.push({ key: 'publish', label: 'Publish draft', icon: <Check size={14} />, disabled: publish.isPending, onSelect: () => publish.mutate(template.id) });
            if (caps.canEdit) menuItems.push({ key: 'edit', label: 'Edit content', icon: <FileText size={14} />, onSelect: () => void openEditContent(template) });
            if (caps.canEdit) menuItems.push({ key: 'settings', label: 'Settings', icon: <Pencil size={14} />, onSelect: () => setEditing(template) });
            if (caps.canInspect) menuItems.push({ key: 'history', label: 'History', icon: <History size={14} />, onSelect: () => setHistoryId(template.id) });
            if (caps.canArchive) menuItems.push({ key: 'archive', label: 'Archive', icon: <Archive size={14} />, disabled: archive.isPending, onSelect: () => archive.mutate(template.id) });
            return (
              <article key={template.id} className="ocb-card otl-card">
                <div className="otl-card__top">
                  {/* The lock is on every card in the prototype: shorthand for
                      "governed template", not a private-only marker. */}
                  <span className="otl-card__scope"><Lock size={13} aria-hidden="true" />{SCOPE_LABELS[template.scope]}</span>
                  <span className="otl-card__trail">
                    <span className="otl-card__version">{versionLabel(template)}</span>
                    <TemplateCardMenu templateName={template.name} items={menuItems} />
                  </span>
                </div>
                <h3 className="otl-card__name">{template.name}</h3>
                <p className="ocb-prose otl-card__desc">{template.description || templateSummary(template)}</p>
                <div className="otl-card__meta">
                  <div className="otl-card__meta-row">
                    <span className="otl-card__meta-key">Type</span>
                    <span className="otl-card__meta-value" data-unset={template.campaignType ? undefined : 'true'}>
                      {template.campaignType || 'Not set'}
                    </span>
                  </div>
                  <div className="otl-card__meta-row">
                    <span className="otl-card__meta-key">Used</span>
                    <span className="otl-card__meta-value">{usageLabel(template)}</span>
                  </div>
                </div>
                {/* The prototype leaves the unpublished card's button live and
                    silently returns. Refusing once, visibly, is the same rule
                    a keyboard and a screen reader can also perceive. */}
                <button
                  type="button"
                  className="ocb-btn ocb-btn--sm ocb-btn--primary otl-card__use"
                  disabled={!published || !caps.canUse || busy}
                  onClick={() => void startUse(template)}
                >
                  {busy ? <Loader2 className="uui-spin" size={14} /> : null}
                  {published ? 'Use template' : 'Publish before use'}
                </button>
              </article>
            );
          })}
        </div>
      ) : null}

      {editing ? <EditTemplateDialog template={editing} selectedClientId={selectedClientId} pending={update.isPending} onClose={() => setEditing(null)} onSave={(input) => update.mutate({ id: editing.id, input })} /> : null}

      {wizard ? (
        <OutreachTemplateWizard
          mode={wizard.mode}
          existing={wizard.mode === 'edit' ? {
            templateId: wizard.template.id,
            name: wizard.template.name,
            description: wizard.template.description,
            campaignType: wizard.template.campaignType,
            scope: wizard.template.scope,
            clientId: wizard.template.clientId,
            spec: wizard.spec,
          } : undefined}
          onClose={() => setWizard(null)}
          onSaved={async () => { setWizard(null); await invalidate(); }}
        />
      ) : null}

      {useDetail && pendingUse ? (
        <VariablePromptDialog
          templateName={pendingUse.name}
          variables={useDetail.versions.find((v) => v.id === pendingUse.publishedVersionId)?.spec.variables ?? []}
          pending={useTemplate.isPending}
          error={useError}
          onClose={() => { setUseDetail(null); setPendingUse(null); }}
          onSubmit={(values) => useTemplate.mutate({ template: pendingUse, variableValues: values })}
        />
      ) : null}

      {receipt ? (
        <ReceiptDialog receipt={receipt.receipt} onContinue={() => { const sessionId = receipt.sessionId; setReceipt(null); onOpenCampaign(sessionId); }} />
      ) : null}

      {historyId ? <HistoryDialog templateId={historyId} clientId={selectedClientId} onClose={() => setHistoryId(null)} /> : null}
    </section>
  );
}
