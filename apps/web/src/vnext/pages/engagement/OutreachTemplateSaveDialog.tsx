import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, FileText, Loader2, ShieldCheck } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import {
  createOutreachTemplateFromSession,
  publishOutreachTemplate,
  type OutreachTemplateScope,
  type OutreachTemplateVersion,
} from './outreach-v3-template-api.js';

export function OutreachTemplateSaveDialog({
  sessionId,
  defaultName,
  selectedClientId,
  onClose,
}: {
  sessionId: string;
  defaultName: string;
  selectedClientId: string | null;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState(`${defaultName} template`);
  const [description, setDescription] = useState('');
  const [campaignType, setCampaignType] = useState('');
  const [scope, setScope] = useState<OutreachTemplateScope>(selectedClientId ? 'client' : 'private');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [version, setVersion] = useState<OutreachTemplateVersion | null>(null);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createOutreachTemplateFromSession(api, {
      sessionId,
      name: name.trim(),
      description: description.trim() || null,
      campaignType: campaignType.trim() || null,
      scope,
      clientId: scope === 'client' ? selectedClientId : null,
    }),
    onSuccess: async (result) => {
      setTemplateId(result.template.id);
      setVersion(result.version);
      setError(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'templates'] });
    },
    onError: (cause) => setError(safeOutreachV3Error(cause)),
  });
  const publish = useMutation({
    mutationFn: () => publishOutreachTemplate(api, templateId!),
    onSuccess: async () => {
      setPublished(true);
      setError(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'templates'] });
    },
    onError: (cause) => setError(safeOutreachV3Error(cause)),
  });

  const pending = create.isPending || publish.isPending;
  return (
    <EngagementDialog
      open
      eyebrow="Save as template"
      title={version ? (published ? 'Published and ready' : 'Draft version created') : 'Keep this reusable approach'}
      description="The template stores the reusable setup only. Live records and delivery state stay with this session."
      width={600}
      busy={pending}
      dirty={!version && Boolean(name.trim())}
      onClose={onClose}
      footer={version ? (
        <>
          <button type="button" className="ov3p1-button is-secondary" onClick={onClose}>{published ? 'Done' : 'Keep as draft'}</button>
          {!published ? <button type="button" className="ov3p1-button is-primary" disabled={publish.isPending} onClick={() => publish.mutate()}>{publish.isPending ? <Loader2 className="ov3p1-spin" size={14} /> : <ShieldCheck size={14} />}Publish v{version.versionNumber}</button> : null}
        </>
      ) : (
        <>
          <button type="button" className="ov3p1-button is-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="ov3p1-button is-primary" disabled={pending || !name.trim() || (scope === 'client' && !selectedClientId)} onClick={() => create.mutate()}>{pending ? <Loader2 className="ov3p1-spin" size={14} /> : <FileText size={14} />}Create draft template</button>
        </>
      )}
    >
      {version ? (
        <div className="ov3p1-template-receipt">
          <span>{published ? <ShieldCheck size={20} /> : <Check size={20} />}</span>
          <div><strong>{name}</strong><p>Version {version.versionNumber} · {published ? 'published' : 'draft'} · source V{version.sourceStateVersion ?? '—'}</p></div>
          <p>Opening this template later starts a new session and asks for current records before drafting or sending.</p>
          {published ? <p className="ov3p1-success">This exact version is now available in Outreach → Templates.</p> : null}
        </div>
      ) : (
        <div className="uui-template-dialog-fields">
          <label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={160} /></label>
          <label>Description<textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} /></label>
          <label>Campaign type<input value={campaignType} onChange={(event) => setCampaignType(event.target.value)} maxLength={60} placeholder="e.g. Funding ask" /></label>
          <label>Access<select value={scope} onChange={(event) => setScope(event.target.value as OutreachTemplateScope)}><option value="private">Only me</option><option value="firm">The firm</option><option value="client" disabled={!selectedClientId}>This client</option></select></label>
        </div>
      )}
      {error ? <p className="ov3p1-error" role="alert">{error}</p> : null}
    </EngagementDialog>
  );
}
