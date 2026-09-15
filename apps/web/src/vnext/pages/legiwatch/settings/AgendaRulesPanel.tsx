import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import {
  AGENDA_ALERTS_FEATURE,
  useIntelFeatureEnabled,
} from '../../../../lib/intel-feature-flags.js';
import { RuleEditor } from '../reports/ReportWorkspace.js';
import type { Rule } from '../reports/report-api.js';
import { FOLDER_BASE, type Folder } from '../bills/folder-api.js';
import { CapiroButton } from '../../../components/actions/index.js';
const BASE = '/intel-api/legiwatch/agenda-rules';
export function AgendaRulesPanel() {
  const api = useApi(),
    scope = useApiScope(),
    enabled = useIntelFeatureEnabled(AGENDA_ALERTS_FEATURE),
    cache = useQueryClient();
  const [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const rules = useQuery({
    queryKey: ['lw-agenda-rules', scope],
    enabled,
    queryFn: async () => (await api.get<Rule[]>(BASE)).data,
    retry: false,
  });
  const folders = useQuery({
    queryKey: ['lw-agenda-folders', scope],
    enabled,
    queryFn: async () => (await api.get<Folder[]>(FOLDER_BASE)).data,
    retry: false,
  });
  const capabilities = useQuery({
    queryKey: ['lw-agenda-capabilities', scope],
    enabled,
    queryFn: async () => (await api.get<{ canPromote: boolean }>(`${BASE}/capabilities`)).data,
    retry: false,
  });
  const staged = useQuery({
    queryKey: ['lw-agenda-staged', scope],
    enabled: enabled && capabilities.data?.canPromote === true,
    queryFn: async () =>
      (
        await api.get<
          Array<{ id: string; sourceId: string; payload: { name?: string; audit_key?: string } }>
        >(`${BASE}/staged`)
      ).data,
    retry: false,
  });
  if (!enabled) return null;
  const rule = rules.data?.find((r) => r.id === selected);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await cache.invalidateQueries({ queryKey: ['lw-agenda-rules', scope] });
      await cache.invalidateQueries({ queryKey: ['lw-agenda-staged', scope] });
      await cache.invalidateQueries({ queryKey: ['legiwatch-reports', scope, 'readiness'] });
    } catch {
      setError('This change could not be saved. Refresh current mappings and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="lw-card" style={{ padding: 18 }} aria-label="Tagged bill agenda alerts">
      <h2 className="lw-card__title">Tagged bill agenda alerts</h2>
      <p className="lw-agenda-intro">
        Review agenda rules, current folder targets, staff channels, and delivery cadence.
        Activation starts from the reviewed baseline.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {rules.isError ? (
        <div role="alert">
          <p>Agenda rules could not be loaded.</p>
          <CapiroButton size="compact" onClick={() => void rules.refetch()}>
            Retry agenda rules
          </CapiroButton>
        </div>
      ) : null}
      {folders.isError ? (
        <div role="alert">
          <p>Folder targets could not be loaded. Reload them before editing a rule.</p>
          <CapiroButton size="compact" onClick={() => void folders.refetch()}>
            Retry folder targets
          </CapiroButton>
        </div>
      ) : null}
      {rules.isPending ? (
        <p role="status">Loading agenda rules…</p>
      ) : rules.data && rules.data.length > 0 ? (
        /* No card box around the chips — the parent section is already the
           white card; a nested lw-controls renders an empty bordered strip
           when there are no rules. Reference settings.png shows plain chips. */
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {(rules.data ?? []).map((r) => (
            <CapiroButton key={r.id} size="compact" onClick={() => setSelected(r.id)}>
              {r.name} · {r.state}
            </CapiroButton>
          ))}
        </div>
      ) : null}
      {rules.isSuccess && rules.data.length === 0 ? (
        <p>No agenda rules have been created yet.</p>
      ) : null}
      {rule && folders.isSuccess ? (
        <RuleEditor
          initial={rule}
          folders={folders.data ?? []}
          scope={scope}
          busy={busy}
          apiBase={BASE}
          save={async (draft) =>
            run(() => api.put(`${BASE}/${rule.id}`, { ...draft, expectedVersion: rule.version }))
          }
          activate={async (enabled) =>
            run(() =>
              api.post(`${BASE}/${rule.id}/activation`, { enabled, expectedVersion: rule.version }),
            )
          }
        />
      ) : null}
      {capabilities.isError ? (
        <div role="alert">
          <p>Import review access could not be checked. Existing agenda rules remain available.</p>
          <CapiroButton size="compact" onClick={() => void capabilities.refetch()}>
            Retry import review access
          </CapiroButton>
        </div>
      ) : null}
      {capabilities.isSuccess && !capabilities.data.canPromote ? (
        <p>Captured definitions can be reconciled by a tenant administrator.</p>
      ) : null}
      {capabilities.data?.canPromote ? (
        <details className="lw-settings__disclosure">
          <summary className="lw-settings__disclosure-summary">
            Captured definitions awaiting reconciliation
          </summary>
          <p>
            Creating a review draft preserves the capture and leaves delivery inactive. Current
            staff mappings and channels must be reviewed in the draft.
          </p>
          {staged.isPending ? <p role="status">Loading captured definitions…</p> : null}
          {staged.isError ? (
            <div role="alert">
              <p>
                {(staged.error as { response?: { status?: number } })?.response?.status === 403
                  ? 'Administrator access could not be verified. Refresh your session and retry captured definitions.'
                  : 'Captured definitions could not be loaded. Existing agenda rules remain available.'}
              </p>
              <CapiroButton size="compact" onClick={() => void staged.refetch()}>
                Retry captured definitions
              </CapiroButton>
            </div>
          ) : null}
          {staged.isSuccess && staged.data.length === 0 ? (
            <p>No captured definitions are awaiting reconciliation.</p>
          ) : null}
          <ul>
            {(staged.data ?? []).map((s) => (
              <li key={s.id}>
                {s.payload.audit_key} · {s.payload.name}
                <CapiroButton
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = (
                        await api.post<{ id?: string; state?: string }>(
                          `${BASE}/promote/${s.id}`,
                          {},
                        )
                      ).data;
                      if (result.id) setSelected(result.id);
                      else
                        setError(
                          'This capture needs reconciliation with an existing rule before a new draft can be created.',
                        );
                    })
                  }
                >
                  Create review draft
                </CapiroButton>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
