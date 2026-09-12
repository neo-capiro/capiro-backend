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
  const staged = useQuery({
    queryKey: ['lw-agenda-staged', scope],
    enabled,
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
      <p>
        Review the eight captured definitions, current folder targets, staff channels, and a Capiro
        cadence. Activation starts from the reviewed baseline.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {rules.isError || folders.isError || staged.isError ? (
        <p role="alert">Agenda rule configuration could not be loaded.</p>
      ) : null}
      {rules.isPending ? (
        <p role="status">Loading agenda rules…</p>
      ) : (
        <div className="lw-controls">
          {(rules.data ?? []).map((r) => (
            <CapiroButton key={r.id} size="compact" onClick={() => setSelected(r.id)}>
              {r.name} · {r.state}
            </CapiroButton>
          ))}
        </div>
      )}
      {rule ? (
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
      <details>
        <summary>Captured definitions awaiting reconciliation</summary>
        <p>
          Creating a review draft preserves the capture and leaves delivery inactive. Current staff
          mappings and channels must be reviewed in the draft.
        </p>
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
                      await api.post<{ id?: string; state?: string }>(`${BASE}/promote/${s.id}`, {})
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
    </section>
  );
}
