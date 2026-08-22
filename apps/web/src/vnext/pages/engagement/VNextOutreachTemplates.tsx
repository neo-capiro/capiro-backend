import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Check,
  CircleAlert,
  FileText,
  Loader2,
  Pencil,
  Play,
  RefreshCcw,
  ShieldCheck,
} from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import {
  archiveOutreachTemplate,
  listOutreachTemplates,
  publishOutreachTemplate,
  updateOutreachTemplateMetadata,
  useOutreachTemplate,
  type OutreachTemplateMetadataInput,
  type OutreachTemplateScope,
  type OutreachTemplateSummary,
} from './outreach-v3-template-api.js';
import './outreach-v3-templates.css';

function requestKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return '00000000-0000-4000-8000-000000000000'.replace(/[018]/g, (value) =>
    (Number(value) ^ (Math.random() * 16 >> (Number(value) / 4))).toString(16),
  );
}

function templateSummary(template: OutreachTemplateSummary): string {
  const spec = template.previewSpec;
  if (!spec) return 'No published or draft strategy is available.';
  const values = [
    spec.goal.topic,
    spec.strategy.tone ? `${spec.strategy.tone} tone` : null,
    spec.strategy.length !== 'undecided' ? `${spec.strategy.length} length` : null,
    spec.delivery.pattern !== 'undecided'
      ? spec.delivery.pattern.replaceAll('_', ' ')
      : null,
  ].filter(Boolean);
  return values.join(' · ') || 'Reusable campaign strategy and voice.';
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
        <label>Who can use it<select value={scope} onChange={(event) => setScope(event.target.value as OutreachTemplateScope)}><option value="private">Only me</option><option value="firm">The firm</option><option value="client" disabled={!selectedClientId && !template.clientId}>This client</option></select></label>
        {scope === 'client' ? <p>This template remains inside the selected client scope.</p> : null}
      </div>
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
  const [editing, setEditing] = useState<OutreachTemplateSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const templates = useQuery({
    queryKey: ['outreach-v3', 'templates', selectedClientId],
    queryFn: () => listOutreachTemplates(api, { clientId: selectedClientId }),
    retry: false,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['outreach-v3', 'templates'] });

  const useTemplate = useMutation({
    mutationFn: (template: OutreachTemplateSummary) =>
      useOutreachTemplate(api, template.id, {
        requestKey: requestKey(),
        title: template.name,
        clientId: selectedClientId,
      }),
    onSuccess: (result) => {
      setActionError(null);
      onOpenCampaign(result.sessionId);
    },
    onError: (error) => setActionError(safeOutreachV3Error(error)),
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

  const rows = templates.data ?? [];
  return (
    <section className="uui-template-library">
      <header>
        <div><span className="uui-eyebrow">Templates</span><h2>Start from an approved way of working</h2><p>Templates carry reusable strategy and voice. Recipients, evidence, context, approvals, and sending are refreshed in the new campaign.</p></div>
        <button type="button" className="uui-button" disabled={templates.isFetching} onClick={() => void templates.refetch()}>{templates.isFetching ? <Loader2 className="uui-spin" size={14} /> : <RefreshCcw size={14} />} Refresh</button>
      </header>

      {actionError ? <div className="uui-outreach-home__error" role="alert"><CircleAlert size={16} />{actionError}</div> : null}
      {templates.isError ? <div className="uui-engagement-error uui-engagement-error--inside" role="alert"><strong>Templates could not be loaded</strong><p>{safeOutreachV3Error(templates.error)}</p></div> : null}
      {templates.isLoading ? <div className="uui-template-grid" aria-busy="true"><i /><i /><i /></div> : null}
      {!templates.isLoading && !templates.isError && !rows.length ? (
        <div className="uui-outreach-home__empty"><FileText size={26} /><strong>No templates yet</strong><p>Finish a campaign, then save its reusable approach from the Results screen. The first version stays a draft until you publish it.</p></div>
      ) : null}

      {rows.length ? <div className="uui-template-grid">{rows.map((template) => {
        const published = Boolean(template.publishedVersionId);
        const busy = useTemplate.isPending && useTemplate.variables?.id === template.id;
        return <article key={template.id} className="uui-template-card">
          <header><span><ShieldCheck size={15} />{template.scope === 'private' ? 'Only me' : template.scope === 'client' ? 'Client' : 'Firm'}</span><small>{published ? `Published v${template.publishedVersionNumber}` : `Draft v${template.draftVersionNumber ?? 1}`}</small></header>
          <h3>{template.name}</h3>
          <p>{template.description || templateSummary(template)}</p>
          <dl><div><dt>Approach</dt><dd>{templateSummary(template)}</dd></div><div><dt>Fresh on use</dt><dd>Targets, evidence and context</dd></div></dl>
          <footer>
            <button type="button" className="uui-button--primary" disabled={!published || busy} onClick={() => useTemplate.mutate(template)}>{busy ? <Loader2 className="uui-spin" size={14} /> : <Play size={14} />}{published ? 'Use template' : 'Publish before use'}</button>
            {template.currentDraftVersionId ? <button type="button" className="uui-button" disabled={publish.isPending} onClick={() => publish.mutate(template.id)}><Check size={14} />Publish draft</button> : null}
            <button type="button" className="uui-button" onClick={() => setEditing(template)}><Pencil size={14} />Edit</button>
            <button type="button" className="uui-button uui-template-card__archive" disabled={archive.isPending} onClick={() => archive.mutate(template.id)}><Archive size={14} />Archive</button>
          </footer>
        </article>;
      })}</div> : null}

      {editing ? <EditTemplateDialog template={editing} selectedClientId={selectedClientId} pending={update.isPending} onClose={() => setEditing(null)} onSave={(input) => update.mutate({ id: editing.id, input })} /> : null}
    </section>
  );
}
