import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileText, Loader2, ShieldCheck } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import {
  createOutreachTemplateVersionFromSession,
  diffOutreachTemplateSpecs,
  getOutreachTemplate,
  listOutreachTemplates,
  publishOutreachTemplate,
  type OutreachTemplateSpecFieldDiff,
  type OutreachTemplateVersion,
} from './outreach-v3-template-api.js';

export function OutreachTemplateUpdateDialog({
  sessionId,
  selectedClientId,
  onClose,
}: {
  sessionId: string;
  selectedClientId: string | null;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState('');
  const [version, setVersion] = useState<OutreachTemplateVersion | null>(null);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = useQuery({
    queryKey: ['outreach-v3', 'templates', selectedClientId],
    queryFn: () => listOutreachTemplates(api, { clientId: selectedClientId }),
    retry: false,
  });
  // Only offer templates the actor can actually create a version on — the
  // server enforces this regardless, but the picker should not invite a
  // guaranteed-to-fail choice (closeout runbook 3.4/5.14).
  const manageable = useMemo(
    () => (templates.data ?? []).filter((template) => template.capabilities.canCreateVersion),
    [templates.data],
  );
  const selected = useMemo(
    () => manageable.find((template) => template.id === selectedId) ?? null,
    [selectedId, manageable],
  );
  const [diff, setDiff] = useState<OutreachTemplateSpecFieldDiff[] | null>(null);
  const createVersion = useMutation({
    mutationFn: async () => {
      // Read the current best-known spec BEFORE creating the new version, so
      // the receipt can show a meaningful before/after (closeout runbook
      // 6.11/7.6) — this detail read is authorized the same way `selected`
      // itself was (canCreateVersion implies canInspect).
      const before = await getOutreachTemplate(api, selectedId, selectedClientId);
      const beforeSpec = before.versions.find((v) => v.id === (before.template.currentDraftVersionId ?? before.template.publishedVersionId))?.spec
        ?? before.versions[0]?.spec
        ?? null;
      const result = await createOutreachTemplateVersionFromSession(api, selectedId, sessionId);
      return { result, beforeSpec };
    },
    onSuccess: async ({ result, beforeSpec }) => {
      setVersion(result.version);
      setDiff(beforeSpec ? diffOutreachTemplateSpecs(beforeSpec, result.version.spec) : null);
      setError(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'templates'] });
    },
    onError: (cause) => setError(safeOutreachV3Error(cause)),
  });
  const publish = useMutation({
    mutationFn: () => publishOutreachTemplate(api, selectedId),
    onSuccess: async () => {
      setPublished(true);
      setError(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'templates'] });
    },
    onError: (cause) => setError(safeOutreachV3Error(cause)),
  });
  const pending = createVersion.isPending || publish.isPending;

  return (
    <EngagementDialog
      open
      eyebrow="Update template"
      title={version ? (published ? 'New version published' : 'New draft version created') : 'Create a version from this session'}
      description="The existing published version stays unchanged until you explicitly publish the new draft."
      width={600}
      busy={pending}
      dirty={!version && Boolean(selectedId)}
      onClose={onClose}
      footer={version ? (
        <>
          <button type="button" className="ov3p1-button is-secondary" onClick={onClose}>{published ? 'Done' : 'Keep as draft'}</button>
          {!published ? <button type="button" className="ov3p1-button is-primary" disabled={publish.isPending} onClick={() => publish.mutate()}>{publish.isPending ? <Loader2 className="ov3p1-spin" size={14} /> : <ShieldCheck size={14} />}Publish v{version.versionNumber}</button> : null}
        </>
      ) : (
        <>
          <button type="button" className="ov3p1-button is-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="ov3p1-button is-primary" disabled={pending || !selectedId} onClick={() => createVersion.mutate()}>{pending ? <Loader2 className="ov3p1-spin" size={14} /> : <FileText size={14} />}Create draft version</button>
        </>
      )}
    >
      {version ? (
        <>
          <div className="ov3p1-template-receipt">
            <span>{published ? <ShieldCheck size={20} /> : <Check size={20} />}</span>
            <div><strong>{selected?.name ?? 'Template'}</strong><p>Version {version.versionNumber} · {published ? 'published' : 'draft'} · source V{version.sourceStateVersion ?? '—'}</p></div>
            <p>The prior published version remains in immutable history.</p>
          </div>
          {diff && diff.length ? (
            <div className="uui-template-diff">
              {diff.map((row) => (
                <div key={row.field} className="uui-template-diff-row">
                  <span>{row.field}</span>
                  <span className="before">{row.before}</span>
                  <span>→</span>
                  <span className="after">{row.after}</span>
                </div>
              ))}
            </div>
          ) : diff ? <p>No reusable-field changes from the current version.</p> : null}
        </>
      ) : (
        <div className="uui-template-dialog-fields">
          <label>Template<select autoFocus value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="">Choose a template</option>{manageable.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.publishedVersionNumber ? `published v${template.publishedVersionNumber}` : 'draft only'}</option>)}</select></label>
          <p>This snapshots the current reusable setup into a new draft version. It does not alter the current published version.</p>
          {templates.isLoading ? <p><Loader2 className="ov3p1-spin" size={13} /> Loading templates…</p> : null}
          {!templates.isLoading && !manageable.length ? <p>You do not manage any templates yet. Save this campaign as a new template instead.</p> : null}
        </div>
      )}
      {error ? <p className="ov3p1-error" role="alert">{error}</p> : null}
    </EngagementDialog>
  );
}
