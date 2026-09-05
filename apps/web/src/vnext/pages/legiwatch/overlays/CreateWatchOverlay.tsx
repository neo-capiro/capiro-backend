/**
 * LegiWatch V2 Wave 2 (W2-4) — Create Watch, a real 5-step flow: Scope →
 * Signals → Triggers → Preview → Save. Replaces the permanently-disabled
 * placeholder (GAPS LW-G9).
 *
 * A preset SUPPLEMENTS the canonical client watchlist; it never generates a
 * live alert on its own. Every condition offered here is one of the five the
 * server enumerates and actually knows how to evaluate — there is no free-text
 * expression box. The Preview step runs a REAL backtest against real
 * historical data (never an estimate); Save persists the preset's lifecycle
 * row, which the header's watch-preset list can later pause/resume/archive.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { LwModal } from './LwModal.js';
import { LwPill, LwButton } from '../lib/primitives.js';
import { SOURCE_FAMILIES } from '../lib/types.js';
import {
  useCreateWatchPreset,
  useSubmitBacktest,
  useUpdateWatchPreset,
  w2Error,
  CONDITION_LABEL,
  CONDITION_TYPES,
  type BacktestResult,
  type ConditionType,
  type SignalFamily,
  type WatchCondition,
  type WatchPreset,
} from '../lib/wave2-api.js';

const STEPS = ['Scope', 'Signals', 'Triggers', 'Preview', 'Save'] as const;

/** Which condition types make sense to offer, given the selected families. */
function availableConditionTypes(families: Set<SignalFamily>, hasClient: boolean): ConditionType[] {
  const out: ConditionType[] = [];
  if (families.size > 0) out.push('KEYWORD_MATCH');
  if (families.has('bill') || families.has('state_bill') || families.has('hearing')) {
    out.push('STATUS_CHANGE');
  }
  if (families.has('program_element')) out.push('FUNDING_MOVEMENT');
  if (families.has('hearing')) out.push('HEARING_SCHEDULED');
  if (hasClient) out.push('CLIENT_RELEVANCE_HIGH');
  return CONDITION_TYPES.filter((t) => out.includes(t));
}

export function CreateWatchOverlay({
  onClose,
  onConfigure,
  defaultClientId,
  editPreset,
}: {
  onClose: () => void;
  onConfigure: () => void;
  defaultClientId?: string;
  /** When set, the wizard edits this existing preset instead of creating one. */
  editPreset?: WatchPreset;
}) {
  const api = useApi();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(editPreset?.name ?? '');
  const [clientIds, setClientIds] = useState<string[]>(
    editPreset?.clientIds ?? (defaultClientId ? [defaultClientId] : []),
  );
  const [families, setFamilies] = useState<Set<SignalFamily>>(
    new Set(editPreset?.signalFamilies ?? ['bill', 'hearing']),
  );
  const [conditions, setConditions] = useState<WatchCondition[]>(editPreset?.conditions ?? []);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const activeClients = useMemo(
    () => (clients.data ?? []).filter((c) => c.status !== 'archived'),
    [clients.data],
  );

  const backtest = useSubmitBacktest();
  const create = useCreateWatchPreset();
  const update = useUpdateWatchPreset();
  const saving = create.isPending || update.isPending;

  const conditionTypes = availableConditionTypes(families, clientIds.length > 0);
  // Conditions referencing a family the user has since deselected (or
  // CLIENT_RELEVANCE_HIGH after clearing clientIds) are dropped rather than
  // silently kept — Triggers must always reflect the CURRENT Signals scope.
  const validConditions = conditions.filter(
    (c) => !c.family || families.has(c.family),
  );

  const toggleFamily = (f: SignalFamily) => {
    setFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
    setBacktestResult(null);
  };

  const toggleClient = (id: string) => {
    setClientIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
    setBacktestResult(null);
  };

  const addCondition = (type: ConditionType) => {
    const defaultFamily = type === 'FUNDING_MOVEMENT' || type === 'HEARING_SCHEDULED' || type === 'CLIENT_RELEVANCE_HIGH'
      ? undefined
      : ([...families][0] as SignalFamily | undefined);
    setConditions((prev) => [...prev, { type, family: defaultFamily }]);
    setBacktestResult(null);
  };

  const updateCondition = (index: number, patch: Partial<WatchCondition>) => {
    setConditions((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
    setBacktestResult(null);
  };

  const removeCondition = (index: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== index));
    setBacktestResult(null);
  };

  const canAdvance = [
    // Scope
    name.trim().length > 0,
    // Signals
    families.size > 0,
    // Triggers
    validConditions.length > 0,
    // Preview
    backtestResult !== null,
    // Save (handled by the primary action itself)
    true,
  ];

  const runBacktest = () => {
    setError(null);
    backtest.mutate(
      { clientIds, signalFamilies: [...families], conditions: validConditions, windowDays: 30 },
      {
        onSuccess: (job) => {
          if (job.result) setBacktestResult(job.result);
          else setError(`Backtest is still ${job.status}. Try again in a moment.`);
        },
        onError: (err) => setError(w2Error(err)),
      },
    );
  };

  const save = () => {
    setError(null);
    const body = { name: name.trim(), clientIds, signalFamilies: [...families], conditions: validConditions };
    if (editPreset) {
      update.mutate(
        { id: editPreset.id, ...body },
        { onSuccess: () => onClose(), onError: (err) => setError(w2Error(err)) },
      );
    } else {
      create.mutate(body, { onSuccess: () => onClose(), onError: (err) => setError(w2Error(err)) });
    }
  };

  const primaryLabel =
    step === 3 ? (backtest.isPending ? 'Running preview…' : backtestResult ? 'Next →' : 'Run preview') :
    step === 4 ? (saving ? 'Saving…' : editPreset ? 'Save changes' : 'Create watch') :
    'Next →';

  const onPrimary = () => {
    if (step === 3) {
      if (!backtestResult) {
        runBacktest();
        return;
      }
      setStep(4);
      return;
    }
    if (step === 4) {
      save();
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  return (
    <LwModal
      kind="watch"
      eyebrow={`${editPreset ? 'Editing' : 'New'} LegiWatch preset — ${STEPS[step]} (${step + 1} of ${STEPS.length})`}
      title={editPreset ? 'Edit watch' : 'Create watch'}
      subtitle="A fast alert definition that can supplement — not replace — the client's full watchlist."
      note="Presets are additive. Client watchlist targeting remains the canonical relevance source."
      primaryLabel={primaryLabel}
      onPrimary={onPrimary}
      primaryDisabled={!canAdvance[step] || backtest.isPending || saving}
      onClose={onClose}
      width={640}
    >
      <nav aria-label="Create watch steps" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {STEPS.map((s, i) => (
          <button
            key={s}
            type="button"
            className={`lw-pill lw-pill--${i === step ? 'brand' : 'gray'}`}
            style={{ cursor: i < step ? 'pointer' : 'default' }}
            onClick={() => {
              if (i < step) setStep(i);
            }}
            disabled={i > step}
            aria-current={i === step ? 'step' : undefined}
          >
            {i + 1}. {s}
          </button>
        ))}
      </nav>

      {step === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="lw-block__label" style={{ marginBottom: 6 }}>Name</div>
            <input
              aria-label="Watch name"
              style={{ width: '100%', height: 38, padding: '0 12px', borderRadius: 8 }}
              placeholder="e.g. Autonomy funding movement"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <div className="lw-block__label" style={{ marginBottom: 6 }}>Clients (optional)</div>
            <p className="lw-card__meta" style={{ marginTop: 0, fontSize: 12 }}>
              Required only for the "High client relevance" trigger. Otherwise this preset previews
              across all public data.
            </p>
            {clients.isError ? (
              <p role="alert" className="lw-card__meta">
                Client list could not be loaded.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {activeClients.map((c) => (
                  <li key={c.id}>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                      <input
                        type="checkbox"
                        checked={clientIds.includes(c.id)}
                        onChange={() => toggleClient(c.id)}
                      />
                      {c.name}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <LwButton onClick={onConfigure}>Open the client's full watchlist →</LwButton>
        </div>
      ) : step === 1 ? (
        <div>
          <div className="lw-block__label" style={{ marginBottom: 6 }}>Signal families</div>
          <p className="lw-card__meta" style={{ marginTop: 0, fontSize: 12 }}>
            Each family is a real, enumerated Capiro data source — never a free-text query.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {SOURCE_FAMILIES.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`lw-btn${families.has(f.id as SignalFamily) ? ' lw-btn--primary' : ''}`}
                aria-pressed={families.has(f.id as SignalFamily)}
                onClick={() => toggleFamily(f.id as SignalFamily)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      ) : step === 2 ? (
        <div>
          <div className="lw-block__label" style={{ marginBottom: 6 }}>Triggers</div>
          <p className="lw-card__meta" style={{ marginTop: 0, fontSize: 12 }}>
            Every trigger is one of the enumerated condition types this system already knows how to
            evaluate.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {conditionTypes.map((t) => (
              <LwButton key={t} onClick={() => addCondition(t)}>
                + {CONDITION_LABEL[t]}
              </LwButton>
            ))}
          </div>
          {conditions.length === 0 ? (
            <p className="lw-card__meta" style={{ fontSize: 13 }}>
              Add at least one trigger above.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {conditions.map((c, i) => {
                const dropped = c.family && !families.has(c.family);
                return (
                  <li key={i} className="lw-card" style={{ padding: 10, opacity: dropped ? 0.5 : 1 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <LwPill tone="brand" size="22">
                        {CONDITION_LABEL[c.type]}
                      </LwPill>
                      {dropped ? (
                        <span className="lw-card__meta" style={{ fontSize: 11 }}>
                          (needs a family no longer selected — remove or reselect it in Signals)
                        </span>
                      ) : null}
                      {c.type === 'KEYWORD_MATCH' ? (
                        <input
                          aria-label={`Keyword for trigger ${i + 1}`}
                          placeholder="keyword"
                          value={c.keyword ?? ''}
                          onChange={(e) => updateCondition(i, { keyword: e.target.value })}
                          style={{ flex: 1, minWidth: 120 }}
                        />
                      ) : null}
                      {(c.type === 'KEYWORD_MATCH' || c.type === 'STATUS_CHANGE') && !dropped ? (
                        <select
                          aria-label={`Family for trigger ${i + 1}`}
                          value={c.family ?? ''}
                          onChange={(e) => updateCondition(i, { family: e.target.value as SignalFamily })}
                        >
                          {[...families].map((f) => (
                            <option key={f} value={f}>
                              {SOURCE_FAMILIES.find((sf) => sf.id === f)?.label ?? f}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {c.type === 'HEARING_SCHEDULED' ? (
                        <input
                          aria-label={`Committee system code for trigger ${i + 1}`}
                          placeholder="committee system code (optional)"
                          value={c.committeeSystemCode ?? ''}
                          onChange={(e) => updateCondition(i, { committeeSystemCode: e.target.value })}
                          style={{ flex: 1, minWidth: 160 }}
                        />
                      ) : null}
                      <LwButton onClick={() => removeCondition(i)}>Remove</LwButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : step === 3 ? (
        <div className="lw-watch-cols">
          <div>
            <p style={{ fontSize: 13 }}>
              Preview runs a REAL query against the last 30 days of historical data — never an
              estimate.
            </p>
            <LwButton onClick={runBacktest} disabled={backtest.isPending}>
              {backtest.isPending ? 'Running…' : backtestResult ? 'Re-run preview' : 'Run preview'}
            </LwButton>
          </div>
          <div style={{ background: 'var(--lw-ink)', borderRadius: 11, padding: 16, color: '#fff' }}>
            <div className="lw-eyebrow" style={{ color: 'var(--lw-faint)' }}>
              Preview · last 30 days
            </div>
            {backtest.isPending ? (
              <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--lw-faint)' }}>Running…</p>
            ) : backtestResult ? (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <LwPill tone="brand" size="22">
                  {backtestResult.totalMatched} match{backtestResult.totalMatched === 1 ? '' : 'es'}
                </LwPill>
                {backtestResult.unknownOrUnsupportedConditions.length > 0 ? (
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--lw-faint)' }}>
                    {backtestResult.unknownOrUnsupportedConditions.length} trigger(s) UNSUPPORTED —
                    not counted as zero matches:{' '}
                    {backtestResult.unknownOrUnsupportedConditions.map((u) => u.reason).join(' ')}
                  </p>
                ) : null}
                {backtestResult.sampleMatches.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: '#fff' }}>
                    {backtestResult.sampleMatches.slice(0, 5).map((m) => (
                      <li key={m.packetId}>
                        {m.canonicalObject.label} — {m.occurredAt.slice(0, 10)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--lw-faint)' }}>
                    Zero real matches in the last 30 days for this definition.
                  </p>
                )}
              </div>
            ) : (
              <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--lw-faint)' }}>
                Run the preview to see real matches.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div>
          <p style={{ fontSize: 13 }}>
            <strong>{name}</strong> will watch {[...families].map((f) => SOURCE_FAMILIES.find((sf) => sf.id === f)?.label ?? f).join(', ')}{' '}
            with {validConditions.length} trigger{validConditions.length === 1 ? '' : 's'}
            {clientIds.length ? ` for ${clientIds.length} client${clientIds.length === 1 ? '' : 's'}` : ''}.
          </p>
          <p className="lw-card__meta" style={{ fontSize: 12 }}>
            {editPreset
              ? 'Its status (active/paused/archived) is unchanged by this edit — change that from the watch presets list.'
              : 'Saved as active. Pause, resume, or archive it later from the watch presets list.'}
          </p>
        </div>
      )}

      {error ? (
        <p role="alert" className="lw-card__meta" style={{ marginTop: 12, color: 'var(--lw-danger, #b42318)' }}>
          {error}
        </p>
      ) : null}
    </LwModal>
  );
}
