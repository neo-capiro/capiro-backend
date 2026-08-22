import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Check,
  CircleAlert,
  Copy,
  FileText,
  History,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  ShieldCheck,
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
  type OutreachTemplateSpecFieldDiff,
  type OutreachTemplateSummary,
  type OutreachTemplateVariable,
} from './outreach-v3-template-api.js';
import './outreach-v3-templates.css';

type LibraryCategory = 'all' | 'capiro' | 'firm' | 'client' | 'mine' | 'archived';

const CATEGORY_LABELS: Record<LibraryCategory, string> = {
  all: 'All',
  capiro: 'Capiro',
  firm: 'Firm',
  client: 'Client',
  mine: 'My templates',
  archived: 'Archived',
};

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
  const latest = versions[0] ?? null;
  const compareTo = versions.find((v) => v.id === compareId) ?? versions[1] ?? null;
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
  const [campaignTypeFilter, setCampaignTypeFilter] = useState('');
  const [sort, setSort] = useState<OutreachTemplateSortKey>('updated');
  const [editing, setEditing] = useState<OutreachTemplateSummary | null>(null);
  const [wizard, setWizard] = useState<{ mode: 'create' } | { mode: 'edit'; template: OutreachTemplateSummary; detail: OutreachTemplateDetail } | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [pendingUse, setPendingUse] = useState<OutreachTemplateSummary | null>(null);
  const [useDetail, setUseDetail] = useState<OutreachTemplateDetail | null>(null);
  const [useError, setUseError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ sessionId: string; receipt: OutreachTemplateApplicationReceipt } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const templates = useQuery({
    queryKey: ['outreach-v3', 'templates', selectedClientId, category, search, campaignTypeFilter, sort],
    queryFn: () => listOutreachTemplates(api, {
      clientId: selectedClientId,
      includeArchived: category === 'archived',
      search: search || null,
      campaignType: campaignTypeFilter || null,
      mineOnly: category === 'mine',
      sort,
    }),
    retry: false,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['outreach-v3', 'templates'] });

  const allRows = templates.data ?? [];
  const rows = useMemo(() => {
    switch (category) {
      case 'firm': return allRows.filter((t) => t.scope === 'firm' && t.status === 'active');
      case 'client': return allRows.filter((t) => t.scope === 'client' && t.status === 'active');
      case 'archived': return allRows.filter((t) => t.status === 'archived');
      case 'capiro': return [];
      case 'mine': return allRows.filter((t) => t.status === 'active');
      default: return allRows.filter((t) => t.status === 'active');
    }
  }, [allRows, category]);
  const campaignTypeOptions = useMemo(
    () => Array.from(new Set(allRows.map((t) => t.campaignType).filter((v): v is string => Boolean(v)))).sort(),
    [allRows],
  );

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
        ?? detail.versions[0]?.spec;
      if (!spec) { setActionError('This template has no content to edit yet.'); return; }
      setWizard({ mode: 'edit', template, detail });
    } catch (error) {
      setActionError(safeOutreachV3Error(error));
    }
  };

  return (
    <section className="uui-template-library">
      <header>
        <div><span className="uui-eyebrow">Templates</span><h2>Start from an approved way of working</h2><p>Templates carry reusable strategy, questions, and guardrails. Recipients, evidence, context, approvals, and sending are refreshed in the new campaign.</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="uui-button" disabled={templates.isFetching} onClick={() => void templates.refetch()}>{templates.isFetching ? <Loader2 className="uui-spin" size={14} /> : <RefreshCcw size={14} />} Refresh</button>
          <button type="button" className="uui-button--primary" onClick={() => setWizard({ mode: 'create' })}><Plus size={14} /> Create template</button>
        </div>
      </header>

      <div className="uui-template-toolbar">
        <div className="uui-template-toolbar__categories">
          {(Object.keys(CATEGORY_LABELS) as LibraryCategory[]).map((key) => (
            <button key={key} type="button" data-active={category === key || undefined} onClick={() => setCategory(key)} disabled={key === 'client' && !selectedClientId}>
              {CATEGORY_LABELS[key]}
            </button>
          ))}
        </div>
        <div className="uui-template-toolbar__filters">
          <input placeholder="Search templates…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} aria-label="Search templates" />
          <select value={campaignTypeFilter} onChange={(e) => setCampaignTypeFilter(e.target.value)} aria-label="Campaign type">
            <option value="">All campaign types</option>
            {campaignTypeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as OutreachTemplateSortKey)} aria-label="Sort">
            <option value="updated">Last updated</option>
            <option value="usage">Most used</option>
            <option value="last_used">Last used</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      {actionError ? <div className="uui-outreach-home__error" role="alert"><CircleAlert size={16} />{actionError}</div> : null}
      {templates.isError ? <div className="uui-engagement-error uui-engagement-error--inside" role="alert"><strong>Templates could not be loaded</strong><p>{safeOutreachV3Error(templates.error)}</p></div> : null}
      {templates.isLoading ? <div className="uui-template-grid" aria-busy="true"><i /><i /><i /></div> : null}
      {!templates.isLoading && !templates.isError && category === 'capiro' ? (
        <div className="uui-template-empty-filtered">Capiro-curated templates aren't available in this release yet.</div>
      ) : null}
      {!templates.isLoading && !templates.isError && category !== 'capiro' && !rows.length ? (
        allRows.length ? (
          <div className="uui-template-empty-filtered">No templates match this view. Try a different category, search, or filter.</div>
        ) : (
          <div className="uui-outreach-home__empty"><FileText size={26} /><strong>No templates yet</strong><p>Create one from scratch, or finish a campaign and save its reusable approach from the Results screen.</p></div>
        )
      ) : null}

      {rows.length ? <div className="uui-template-grid">{rows.map((template) => {
        const published = Boolean(template.publishedVersionId);
        const busy = pendingUse?.id === template.id && (useTemplate.isPending || Boolean(useDetail));
        return <article key={template.id} className="uui-template-card">
          <header><span><ShieldCheck size={15} />{template.scope === 'private' ? 'Only me' : template.scope === 'client' ? 'Client' : 'Firm'}</span><small>{published ? `Published v${template.publishedVersionNumber}` : `Draft v${template.draftVersionNumber ?? 1}`}</small></header>
          <h3>{template.name}</h3>
          <p>{template.description || templateSummary(template)}</p>
          <dl>
            <div><dt>Approach</dt><dd>{templateSummary(template)}</dd></div>
            {template.campaignType ? <div><dt>Type</dt><dd>{template.campaignType}</dd></div> : null}
            <div><dt>Used</dt><dd className="uui-template-card__usage">{template.usageCount}× · last {formatWhen(template.lastUsedAt)}</dd></div>
            <div><dt>Fresh on use</dt><dd>Targets, evidence and context</dd></div>
          </dl>
          <footer>
            <button type="button" className="uui-button--primary" disabled={!template.capabilities.canUse || busy} onClick={() => startUse(template)}>{busy ? <Loader2 className="uui-spin" size={14} /> : <Play size={14} />}{published ? 'Use template' : 'Publish before use'}</button>
            {template.capabilities.canDuplicate ? <button type="button" className="uui-button" disabled={duplicate.isPending} onClick={() => duplicate.mutate(template.id)}><Copy size={14} />Duplicate</button> : null}
            {template.capabilities.canPublish && template.currentDraftVersionId ? <button type="button" className="uui-button" disabled={publish.isPending} onClick={() => publish.mutate(template.id)}><Check size={14} />Publish draft</button> : null}
            {template.capabilities.canEdit ? <button type="button" className="uui-button" onClick={() => void openEditContent(template)}><FileText size={14} />Edit content</button> : null}
            {template.capabilities.canEdit ? <button type="button" className="uui-button" onClick={() => setEditing(template)}><Pencil size={14} />Settings</button> : null}
            {template.capabilities.canInspect ? <button type="button" className="uui-button" onClick={() => setHistoryId(template.id)}><History size={14} />History</button> : null}
            {template.capabilities.canArchive ? <button type="button" className="uui-button uui-template-card__archive" disabled={archive.isPending} onClick={() => archive.mutate(template.id)}><Archive size={14} />Archive</button> : null}
          </footer>
        </article>;
      })}</div> : null}

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
            spec: wizard.detail.versions.find((v) => v.id === wizard.template.currentDraftVersionId)?.spec
              ?? wizard.detail.versions.find((v) => v.id === wizard.template.publishedVersionId)?.spec
              ?? wizard.detail.versions[0]!.spec,
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

      {useError && !useDetail ? <div className="uui-outreach-home__error" role="alert"><CircleAlert size={16} />{useError}</div> : null}

      {receipt ? (
        <ReceiptDialog receipt={receipt.receipt} onContinue={() => { const sessionId = receipt.sessionId; setReceipt(null); onOpenCampaign(sessionId); }} />
      ) : null}

      {historyId ? <HistoryDialog templateId={historyId} clientId={selectedClientId} onClose={() => setHistoryId(null)} /> : null}
    </section>
  );
}
