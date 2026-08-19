/**
 * vNext re-skin of pages/settings/SkillsPage.tsx (assistant-parity F6b):
 * firm-authored Meri skills. Identical endpoints, query keys, copy and
 * client-side validation rules (mirrors of the server LIMITS in
 * clio-firm-skills.helpers.ts); the API stays the security boundary.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { SvSwitch, SvTagInput, SvTextArea, useSvConfirm } from './settings-ui.js';

// Mirrors of the server-side LIMITS in clio-firm-skills.helpers.ts.
const SKILL_LIMITS = {
  idPattern: /^[a-z0-9_]{2,48}$/,
  name: 80,
  addendum: 2000,
  triggers: 5,
  tools: 12,
  sections: 12,
  sectionLen: 80,
  heading: 120,
};

interface MeriSkillDef {
  id: string;
  name: string;
  triggers: string[];
  systemAddendum: string;
  requiredTools: string[];
  template: { heading: string; sections: string[] } | null;
}

interface FirmSkillRow {
  id: string;
  skillId: string;
  name: string;
  skill: MeriSkillDef;
  version: number;
  versions: Array<{ version: number; savedAt: string }>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ToolManifestResponse {
  tools: Array<{ name: string; description: string }>;
}

interface SkillTestResponse {
  skillId: string;
  triggers: string[];
  systemAddendum: string;
  template: { heading: string; sections: string[] } | null;
  requiredTools: string[];
  note: string;
}

interface SkillFormState {
  id: string;
  name: string;
  triggers: string[];
  systemAddendum: string;
  requiredTools: string[];
  templateHeading: string;
  templateSections: string[];
}

const EMPTY_FORM: SkillFormState = {
  id: '',
  name: '',
  triggers: [],
  systemAddendum: '',
  requiredTools: [],
  templateHeading: '',
  templateSections: [],
};

export function VNextSkillsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<FirmSkillRow | null>(null);
  const [historyRow, setHistoryRow] = useState<FirmSkillRow | null>(null);
  const [form, setForm] = useState<SkillFormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof SkillFormState, string>>>({});
  const [testResult, setTestResult] = useState<{ name: string; result: SkillTestResponse } | null>(
    null,
  );

  const skills = useQuery<FirmSkillRow[]>({
    queryKey: ['meri-firm-skills'],
    queryFn: async () => (await api.get<FirmSkillRow[]>('/api/clio/firm-skills')).data,
  });

  const toolManifest = useQuery<ToolManifestResponse>({
    queryKey: ['meri-tools'],
    queryFn: async () => (await api.get<ToolManifestResponse>('/api/clio/tools')).data,
    staleTime: 5 * 60_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['meri-firm-skills'] });

  const save = useMutation({
    mutationFn: async (payload: { rowId: string | null; body: Record<string, unknown> }) =>
      payload.rowId
        ? (await api.patch(`/api/clio/firm-skills/${payload.rowId}`, payload.body)).data
        : (await api.post('/api/clio/firm-skills', payload.body)).data,
    onSuccess: (_data, payload) => {
      toast.success(payload.rowId ? 'Skill updated' : 'Skill created');
      setEditorOpen(false);
      setEditingRow(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const setEnabled = useMutation({
    mutationFn: async (payload: { rowId: string; enabled: boolean }) =>
      (
        await api.patch(`/api/clio/firm-skills/${payload.rowId}/enabled`, {
          enabled: payload.enabled,
        })
      ).data,
    onSuccess: (_data, payload) => {
      toast.success(payload.enabled ? 'Skill enabled' : 'Skill disabled');
      invalidate();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: async (rowId: string) => (await api.delete(`/api/clio/firm-skills/${rowId}`)).data,
    onSuccess: () => {
      toast.success('Skill deleted');
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const restore = useMutation({
    mutationFn: async (payload: { rowId: string; version: number }) =>
      (
        await api.post(`/api/clio/firm-skills/${payload.rowId}/restore`, {
          version: payload.version,
        })
      ).data,
    onSuccess: (_data, payload) => {
      toast.success(`Restored version ${payload.version}`);
      setHistoryRow(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const test = useMutation({
    mutationFn: async (row: FirmSkillRow) =>
      (await api.post<SkillTestResponse>(`/api/clio/firm-skills/${row.id}/test`)).data,
    onSuccess: (data, row) => setTestResult({ name: row.name, result: data }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Seed the editor form whenever it opens.
  useEffect(() => {
    if (!editorOpen) return;
    setFormErrors({});
    if (editingRow) {
      setForm({
        id: editingRow.skill.id,
        name: editingRow.skill.name,
        triggers: editingRow.skill.triggers,
        systemAddendum: editingRow.skill.systemAddendum,
        requiredTools: editingRow.skill.requiredTools,
        templateHeading: editingRow.skill.template?.heading ?? '',
        templateSections: editingRow.skill.template?.sections ?? [],
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [editorOpen, editingRow]);

  const openCreate = () => {
    setEditingRow(null);
    setEditorOpen(true);
  };

  const openEdit = (row: FirmSkillRow) => {
    setEditingRow(row);
    setEditorOpen(true);
  };

  const submitEditor = () => {
    // Same validation rules (and messages) as the canonical antd form rules.
    const errors: Partial<Record<keyof SkillFormState, string>> = {};
    const id = form.id.trim();
    if (!id) errors.id = 'Skill ID is required';
    else if (!SKILL_LIMITS.idPattern.test(id))
      errors.id = 'Use 2-48 chars: lowercase letters, digits, underscore';
    const name = form.name.trim();
    if (!name) errors.name = 'Name is required';
    else if (name.length > SKILL_LIMITS.name) errors.name = `Max ${SKILL_LIMITS.name} characters`;
    const triggerCount = form.triggers.filter((t) => t.trim()).length;
    if (triggerCount < 1 || triggerCount > SKILL_LIMITS.triggers)
      errors.triggers = `Add 1-${SKILL_LIMITS.triggers} trigger phrases`;
    const addendum = form.systemAddendum.trim();
    if (!addendum) errors.systemAddendum = 'Guidance is required';
    else if (addendum.length > SKILL_LIMITS.addendum)
      errors.systemAddendum = `Max ${SKILL_LIMITS.addendum} characters`;
    if (form.requiredTools.length > SKILL_LIMITS.tools)
      errors.requiredTools = `Max ${SKILL_LIMITS.tools} tools`;
    if (form.templateSections.length > SKILL_LIMITS.sections)
      errors.templateSections = `Max ${SKILL_LIMITS.sections} sections`;
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const heading = form.templateHeading.trim();
    const sections = form.templateSections.map((s) => s.trim()).filter(Boolean);
    const body = {
      id,
      name,
      triggers: form.triggers.map((t) => t.trim()).filter(Boolean),
      systemAddendum: addendum,
      requiredTools: form.requiredTools,
      template: heading && sections.length > 0 ? { heading, sections } : null,
    };
    save.mutate({ rowId: editingRow?.id ?? null, body });
  };

  const toolOptions = (toolManifest.data?.tools ?? []).map((tool) => ({
    value: tool.name,
    label: tool.name,
  }));

  return (
    <section className="stv-stack" aria-label="Meri Skills">
      <div className="stv-row stv-row--between stv-row--start">
        <div>
          <h2 className="stv-card__title" style={{ margin: 0 }}>
            Meri Skills
          </h2>
          <p className="stv-card__desc">
            Firm-authored playbooks Meri applies when a trigger phrase fires: extra guidance,
            required tools, and an optional response template. Built-in skills always win on
            conflicting triggers.
          </p>
        </div>
        <CapiroButton variant="primary" onClick={openCreate}>
          New skill
        </CapiroButton>
      </div>

      {skills.isLoading ? (
        <div className="stv-stack" aria-label="Loading skills">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="80%" />
        </div>
      ) : (skills.data ?? []).length === 0 ? (
        <CapiroEmptyState title="No firm skills yet. Create one to teach Meri your house playbooks." />
      ) : (
        <CapiroTableWrap>
          <CapiroTable>
            <CapiroTableHead>
              <tr>
                <CapiroTableHeaderCell>Skill</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Triggers</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Version</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Enabled</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Actions</CapiroTableHeaderCell>
              </tr>
            </CapiroTableHead>
            <CapiroTableBody>
              {(skills.data ?? []).map((row) => (
                <tr key={row.id}>
                  <CapiroTableCell>
                    <span className="stv-strong">{row.name}</span>
                    <div>
                      <code className="stv-code">{row.skillId}</code>
                    </div>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <span className="stv-row" style={{ gap: 4 }}>
                      {row.skill.triggers.map((trigger) => (
                        <CapiroBadge key={trigger}>{trigger}</CapiroBadge>
                      ))}
                    </span>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <span className="stv-muted">v{row.version}</span>
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <SvSwitch
                      checked={row.enabled}
                      aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${row.name}`}
                      disabled={setEnabled.isPending && setEnabled.variables?.rowId === row.id}
                      onChange={(checked) => setEnabled.mutate({ rowId: row.id, enabled: checked })}
                    />
                  </CapiroTableCell>
                  <CapiroTableCell>
                    <span className="stv-row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      <CapiroButton size="compact" onClick={() => openEdit(row)}>
                        Edit
                      </CapiroButton>
                      <CapiroButton
                        size="compact"
                        title="Dry-run: shows what this skill injects"
                        loading={test.isPending && test.variables?.id === row.id}
                        onClick={() => test.mutate(row)}
                      >
                        Test
                      </CapiroButton>
                      <CapiroButton
                        size="compact"
                        disabled={!row.versions.length}
                        title="Version history"
                        aria-label={`Version history for ${row.name}`}
                        onClick={() => setHistoryRow(row)}
                      >
                        History
                      </CapiroButton>
                      <CapiroButton
                        size="compact"
                        className="stv-btn-danger"
                        aria-label={`Delete ${row.name}`}
                        onClick={() =>
                          confirm({
                            title: `Delete "${row.name}"?`,
                            body: 'Meri stops applying this skill immediately. This cannot be undone.',
                            okText: 'Delete',
                            danger: true,
                            onOk: () => remove.mutateAsync(row.id),
                          })
                        }
                      >
                        Delete
                      </CapiroButton>
                    </span>
                  </CapiroTableCell>
                </tr>
              ))}
            </CapiroTableBody>
          </CapiroTable>
        </CapiroTableWrap>
      )}

      {editorOpen ? (
        <CapiroModal
          open
          title={editingRow ? `Edit skill: ${editingRow.name}` : 'New skill'}
          onClose={() => {
            setEditorOpen(false);
            setEditingRow(null);
          }}
        >
          <form
            className="stv-stack stv-modal-mid"
            onSubmit={(event) => {
              event.preventDefault();
              submitEditor();
            }}
          >
            <CapiroInput
              label="Skill ID"
              placeholder="earmark_request_memo"
              helpText="Stable identifier; 2-48 chars of lowercase letters, digits, underscore."
              error={formErrors.id}
              disabled={Boolean(editingRow)}
              value={form.id}
              onChange={(e) => setForm((c) => ({ ...c, id: e.target.value }))}
            />
            <CapiroInput
              label="Name"
              placeholder="Earmark request memo"
              maxLength={SKILL_LIMITS.name}
              error={formErrors.name}
              value={form.name}
              onChange={(e) => setForm((c) => ({ ...c, name: e.target.value }))}
            />
            <div>
              <span className="capiro-field__label" style={{ display: 'block', marginBottom: 6 }}>
                Trigger phrases
              </span>
              <SvTagInput
                value={form.triggers}
                onChange={(triggers) => setForm((c) => ({ ...c, triggers }))}
                placeholder="Type a phrase and press Enter"
                aria-label="Trigger phrases"
              />
              <span className="capiro-field__help">
                Meri applies the skill when the user's message contains one of these.
              </span>
              {formErrors.triggers ? (
                <span className="capiro-field__error" style={{ display: 'block' }}>
                  {formErrors.triggers}
                </span>
              ) : null}
            </div>
            <div>
              <SvTextArea
                label="System guidance"
                rows={5}
                maxLength={SKILL_LIMITS.addendum}
                showCount
                placeholder="When drafting an earmark request memo, always confirm the appropriations subcommittee…"
                value={form.systemAddendum}
                onChange={(systemAddendum) => setForm((c) => ({ ...c, systemAddendum }))}
              />
              <span className="capiro-field__help">
                Injected into Meri's system prompt when the skill fires.
              </span>
              {formErrors.systemAddendum ? (
                <span className="capiro-field__error" style={{ display: 'block' }}>
                  {formErrors.systemAddendum}
                </span>
              ) : null}
            </div>
            <div>
              <span className="capiro-field__label" style={{ display: 'block', marginBottom: 6 }}>
                Required tools
              </span>
              <select
                multiple
                className="capiro-select"
                style={{ minHeight: 88, width: '100%' }}
                aria-label="Required tools"
                value={form.requiredTools}
                onChange={(event) =>
                  setForm((c) => ({
                    ...c,
                    requiredTools: Array.from(event.target.selectedOptions).map((o) => o.value),
                  }))
                }
              >
                {toolOptions.map((tool) => (
                  <option key={tool.value} value={tool.value}>
                    {tool.label}
                  </option>
                ))}
              </select>
              <span className="capiro-field__help">
                Tools Meri must run before answering (optional).
              </span>
              {formErrors.requiredTools ? (
                <span className="capiro-field__error" style={{ display: 'block' }}>
                  {formErrors.requiredTools}
                </span>
              ) : null}
            </div>
            <CapiroInput
              label="Response template heading (optional)"
              placeholder="Earmark Request Memo"
              maxLength={SKILL_LIMITS.heading}
              helpText="With at least one section, structures Meri's answer. Leave blank for none."
              value={form.templateHeading}
              onChange={(e) => setForm((c) => ({ ...c, templateHeading: e.target.value }))}
            />
            <div>
              <span className="capiro-field__label" style={{ display: 'block', marginBottom: 6 }}>
                Template sections
              </span>
              <SvTagInput
                value={form.templateSections}
                onChange={(templateSections) => setForm((c) => ({ ...c, templateSections }))}
                placeholder="Type a section name and press Enter"
                aria-label="Template sections"
              />
              {formErrors.templateSections ? (
                <span className="capiro-field__error" style={{ display: 'block' }}>
                  {formErrors.templateSections}
                </span>
              ) : null}
            </div>
            <div className="stv-row stv-row--end">
              <CapiroButton
                onClick={() => {
                  setEditorOpen(false);
                  setEditingRow(null);
                }}
              >
                Cancel
              </CapiroButton>
              <CapiroButton variant="primary" type="submit" loading={save.isPending}>
                {editingRow ? 'Save' : 'Create'}
              </CapiroButton>
            </div>
          </form>
        </CapiroModal>
      ) : null}

      {testResult ? (
        <CapiroModal open title={`Test: ${testResult.name}`} onClose={() => setTestResult(null)}>
          <div className="stv-stack stv-modal-mid">
            <p className="stv-muted" style={{ margin: 0 }}>
              {testResult.result.note}
            </p>
            <div>
              <span className="stv-strong">Triggers</span>
              <div className="stv-row" style={{ margin: '4px 0 12px', gap: 4 }}>
                {testResult.result.triggers.map((trigger) => (
                  <CapiroBadge key={trigger}>{trigger}</CapiroBadge>
                ))}
              </div>
              <span className="stv-strong">System guidance</span>
              <pre className="stv-pre">{testResult.result.systemAddendum}</pre>
              {testResult.result.template ? (
                <>
                  <span className="stv-strong">Response template</span>
                  <div style={{ margin: '4px 0 12px' }}>
                    <span>{testResult.result.template.heading}</span>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                      {testResult.result.template.sections.map((section) => (
                        <li key={section}>{section}</li>
                      ))}
                    </ul>
                  </div>
                </>
              ) : null}
              {testResult.result.requiredTools.length ? (
                <>
                  <span className="stv-strong">Required tools</span>
                  <div className="stv-row" style={{ marginTop: 4, gap: 4 }}>
                    {testResult.result.requiredTools.map((tool) => (
                      <CapiroBadge key={tool}>{tool}</CapiroBadge>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <div className="stv-row stv-row--end">
              <CapiroButton variant="primary" onClick={() => setTestResult(null)}>
                Close
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}

      <CapiroDrawer
        open={Boolean(historyRow)}
        title={historyRow ? `Version history: ${historyRow.name}` : 'Version history'}
        onClose={() => setHistoryRow(null)}
      >
        {historyRow ? (
          <div className="stv-stack stv-stack--tight">
            <p className="stv-muted" style={{ margin: 0 }}>
              Current version: v{historyRow.version}. Restoring re-validates the snapshot and saves
              it as a new version.
            </p>
            {historyRow.versions.length ? (
              historyRow.versions.map((entry) => (
                <div
                  key={entry.version}
                  className="stv-row stv-row--between"
                  style={{ padding: '8px 0', borderBottom: '1px solid var(--stv-border)' }}
                >
                  <div>
                    <span className="stv-strong">v{entry.version}</span>
                    <div className="stv-muted stv-small">Saved {formatDateTime(entry.savedAt)}</div>
                  </div>
                  <CapiroButton
                    size="compact"
                    loading={restore.isPending && restore.variables?.version === entry.version}
                    onClick={() => restore.mutate({ rowId: historyRow.id, version: entry.version })}
                  >
                    Restore
                  </CapiroButton>
                </div>
              ))
            ) : (
              <span className="stv-muted">No previous versions.</span>
            )}
          </div>
        ) : null}
      </CapiroDrawer>

      {dialog}
    </section>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
