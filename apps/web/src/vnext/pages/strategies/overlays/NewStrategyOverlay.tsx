/*
 * §7.10a — New strategy overlay. Route: /strategies/new (over the library).
 *
 * Client, objective type, goal, owner (required); target date + Meri context
 * (optional); starting point (empty timeline vs draft with Meri — draft
 * creates the strategy AND a draft proposal, never an applied plan);
 * available-context panel. Primary stays disabled until the required fields
 * are complete. Focus trap / Escape / dirty guard / route sync live in
 * StrategiesModalShell — this file is only the body.
 *
 * F06 (2026-09-10 remediation plan §4): context availability comes from the
 * server-backed availability projection (useStrategyContextAvailability),
 * scoped to the SELECTED client — never a client-side filter over the broad
 * 200-capped inventory list, which admitted other strategies' scoped
 * documents and treated a capped read as an authoritative total. The copy
 * says "available as working context" (eligibility), never "used for this
 * draft" (provenance only the draft operation itself can return).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSelect } from '../../../components/fields/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { OBJECTIVE_TYPES } from '../../../../pages/strategy/constants.js';
import type { StrategyType } from '../../../../pages/strategy/types.js';
import {
  useClientsLite,
  useCreateStrategy,
  useDraftStrategy,
  useFirmPhases,
  useStrategyContextAvailability,
  useTenantMembers,
} from '../strategies-api.js';
import { useShellClientContext } from '../../../adapters/legacy/useShellClientContext.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

type StartingPoint = 'empty' | 'draft';

export function NewStrategyOverlay() {
  const navigate = useNavigate();
  const clients = useClientsLite();
  const members = useTenantMembers();
  const phases = useFirmPhases();
  const shellClient = useShellClientContext();

  /*
   * F06 item 8: initialize the creation client from a valid selected
   * portfolio client. The initial value is the FORM BASELINE (not a user
   * edit), so opening and closing an untouched form is not dirty — the dirty
   * predicate below compares against this baseline.
   */
  const [clientId, setClientId] = useState(() =>
    shellClient.selectedClientId && (clients.data ?? []).some((c) => c.id === shellClient.selectedClientId)
      ? shellClient.selectedClientId
      : '',
  );
  const [type, setType] = useState<StrategyType | ''>('');
  const [goal, setGoal] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [meriContext, setMeriContext] = useState('');
  const [startingPoint, setStartingPoint] = useState<StartingPoint>('empty');

  const availability = useStrategyContextAvailability(clientId || null);
  const createStrategy = useCreateStrategy();
  const draftStrategy = useDraftStrategy();
  const busy = createStrategy.isPending || draftStrategy.isPending;
  const mutationError = createStrategy.error ?? draftStrategy.error;

  const requiredComplete = Boolean(clientId && type && goal.trim() && ownerUserId);
  /* F06: the initialized client is the baseline, not a pending edit — only
   * fields the USER changed make the form dirty. */
  const baselineClientId = useRef('');
  useEffect(() => {
    if (baselineClientId.current === '' && clientId !== '') baselineClientId.current = clientId;
  }, [clientId]);
  const dirty = Boolean(
    (clientId !== '' && clientId !== baselineClientId.current) ||
      type ||
      goal.trim() ||
      ownerUserId ||
      targetDate ||
      meriContext.trim(),
  );

  const submit = () => {
    if (!requiredComplete || busy) return;
    const base = {
      clientId,
      type: type as StrategyType,
      goal: goal.trim(),
      ownerUserId,
      targetDate: targetDate || undefined,
      meriContext: meriContext.trim() || undefined,
    };
    const onSuccess = (detail: { id: string }) => navigate(`/strategies/${detail.id}`);
    /* "Draft with Meri" creates the strategy AND a draft proposal — it never
     * produces an applied plan (§7.10a, governance §1: review required). */
    if (startingPoint === 'draft') draftStrategy.mutate(base, { onSuccess });
    else createStrategy.mutate(base, { onSuccess });
  };

  const clientOptions = [
    { value: '', label: clients.isLoading ? 'Loading clients…' : 'Select a client' },
    ...(clients.data ?? []).map((client) => ({ value: client.id, label: client.name })),
  ];
  const ownerOptions = [
    { value: '', label: members.isLoading ? 'Loading team…' : 'Select an owner' },
    ...(members.data ?? []).map((member) => ({ value: member.clerkUserId, label: member.name })),
  ];
  const typeOptions = [
    { value: '', label: 'Select an objective type' },
    ...OBJECTIVE_TYPES.map((t) => ({ value: t.id, label: t.label })),
  ];

  return (
    <StrategiesModalShell
      eyebrow="New strategy"
      title="What are you trying to achieve?"
      closeTo="/strategies"
      dirty={dirty && !busy}
      maxWidth={1000}
      primaryLabel={startingPoint === 'draft' ? 'Create strategy & draft' : 'Create strategy'}
      onPrimary={submit}
      primaryDisabled={!requiredComplete || busy}
      primaryBusy={busy}
      footerNote={
        startingPoint === 'draft'
          ? 'Draft with Meri creates the strategy and a draft proposal — review is required before anything is applied.'
          : 'Required fields must be complete before a plan can be created.'
      }
    >
      {mutationError ? (
        <p className="st-modal__alert" role="alert">
          The strategy could not be created. {(mutationError as Error).message || 'Please try again.'}
        </p>
      ) : null}

      <div className="st-cols">
        <div className="st-field-stack">
          <CapiroSelect
            label="Client · Required"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            options={clientOptions}
            error={clients.isError ? 'Clients could not be loaded.' : undefined}
            disabled={busy || clients.isLoading}
          />
          {clients.isError ? <CapiroButton onClick={() => void clients.refetch()}>Retry clients</CapiroButton> : null}
          {members.isError ? <div role="alert">Owners could not be loaded. <CapiroButton onClick={() => void members.refetch()}>Retry owners</CapiroButton></div> : null}
          <CapiroSelect
            disabled={busy}
            label="Objective type · Required"
            value={type}
            onChange={(event) => setType(event.target.value as StrategyType | '')}
            options={typeOptions}
          />
          <label className="capiro-field">
            <span className="capiro-field__label">Goal statement · Required</span>
            <textarea
              className="st-textarea st-textarea--tall"
              value={goal}
              maxLength={4000}
              disabled={busy}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="What outcome does this strategy have to produce?"
            />
          </label>
          <div className="st-field-row">
            <CapiroSelect
              label="Owner · Required"
              value={ownerUserId}
              disabled={busy || members.isLoading}
              onChange={(event) => setOwnerUserId(event.target.value)}
              options={ownerOptions}
            />
            <label className="capiro-field">
              <span className="capiro-field__label">Target outcome date · Optional</span>
              <input
                className="capiro-input"
                type="date"
                value={targetDate}
                disabled={busy}
                onChange={(event) => setTargetDate(event.target.value)}
              />
            </label>
          </div>
          <label className="capiro-field">
            <span className="capiro-field__label">Context for Meri · Optional</span>
            <textarea
              className="st-textarea st-textarea--short"
              value={meriContext}
              maxLength={8000}
              disabled={busy}
              onChange={(event) => setMeriContext(event.target.value)}
              placeholder="Prioritize verified budget evidence, committee jurisdiction and client-approved proof points."
            />
          </label>

          <div className="st-panel">
            <p className="st-panel__label">Grounding documents · Optional</p>
            <p className="st-ns__context-sub" style={{ margin: 0 }}>
              {/* F06: eligibility copy — "available as working context" — never
                  provenance ("used for this draft") or approval claims. */}
              {availability.data
                ? `${availability.data.truncated
                    ? `At least ${availability.data.eligibleDocumentIds.length} document${availability.data.eligibleDocumentIds.length === 1 ? '' : 's'}`
                    : `${availability.data.eligibleDocumentIds.length} document${availability.data.eligibleDocumentIds.length === 1 ? '' : 's'}`}
                  ${availability.data.truncated ? '(more than the first 500)' : ''} available as working context for this client.`
                : 'Select a client to review context.'}{' '}
              Upload memos, bill text or prior plans via Context → Upload after the strategy is created.
            </p>
            {availability.data && availability.data.truncated ? (
              <p className="st-ns__context-sub" style={{ marginTop: 4 }}>
                The inventory is large — these counts cover the most recent 500 documents.
              </p>
            ) : null}
          </div>
        </div>

        <aside>
          <p className="st-panel__label">Starting point</p>
          <div className="st-field-stack">
            <button
              type="button"
              className="st-option-card"
              disabled={busy}
              aria-pressed={startingPoint === 'empty'}
              onClick={() => setStartingPoint('empty')}
            >
              <span className="st-option-card__head">
                Create empty timeline
                {startingPoint === 'empty' ? <span aria-hidden="true">✓</span> : null}
              </span>
              <span className="st-option-card__desc">
                Start with firm phases and add each step manually.
              </span>
              <span className="st-option-card__foot">
                <span className="st-pill">Max control</span>
              </span>
            </button>
            <button
              type="button"
              className="st-option-card"
              disabled={busy}
              aria-pressed={startingPoint === 'draft'}
              onClick={() => setStartingPoint('draft')}
            >
              <span className="st-option-card__head">
                Draft with Meri
                {startingPoint === 'draft' ? <span aria-hidden="true">✓</span> : null}
              </span>
              <span className="st-option-card__desc">
                Create suggested steps in the working plan from approved context. Review them before including them in client reports.
              </span>
              <span className="st-option-card__foot">
                <span className="st-pill st-pill--warning">Review required</span>
              </span>
            </button>
            <p className="st-ns__note">
              Both options create a working plan you can edit after creation.
            </p>
          </div>

          <div className="st-panel" style={{ marginTop: 16 }}>
            <p className="st-panel__label">Available context</p>
            {!clientId ? (
              <p className="st-ns__context-sub" style={{ margin: 0 }}>
                Select a client to see the context Meri will ground on.
              </p>
            ) : availability.isLoading ? (
              <div className="st-skel-stack">
                <CapiroSkeleton height={28} width="60%" />
                <CapiroSkeleton height={14} />
                <CapiroSkeleton height={14} width="80%" />
              </div>
            ) : availability.isError ? (
              <CapiroErrorState
                title="Working context could not be checked"
                description="The availability projection could not be loaded. The strategy can still be created."
                onRetry={() => void availability.refetch()}
              />
            ) : availability.data ? (
              <>
                <div className="st-ns__context-stat">{availability.data.eligibleFactCount} facts</div>
                <p className="st-ns__context-sub">
                  {availability.data.truncated
                    ? `at least ${availability.data.eligibleDocumentIds.length} documents`
                    : `${availability.data.eligibleDocumentIds.length} document${availability.data.eligibleDocumentIds.length === 1 ? '' : 's'}`}{' '}
                  · {phases.data?.length ?? '…'} firm phases
                </p>
                {availability.data.excluded.strategyScoped > 0 ? (
                  <p className="st-ns__context-sub" style={{ marginTop: 4 }}>
                    {availability.data.excluded.strategyScoped} document
                    {availability.data.excluded.strategyScoped === 1 ? '' : 's'} linked to another
                    strategy — excluded until that strategy is chosen.
                  </p>
                ) : null}
                {availability.data.excluded.stale > 0 ? (
                  <p className="st-ns__context-sub" style={{ marginTop: 2 }}>
                    {availability.data.excluded.stale} needs updating and stays out of the draft.
                  </p>
                ) : null}
                {availability.data.excluded.nodeScoped > 0 ? (
                  <p className="st-ns__context-sub" style={{ marginTop: 2 }}>
                    {availability.data.excluded.nodeScoped} step-specific document
                    {availability.data.excluded.nodeScoped === 1 ? '' : 's'} not applicable here.
                  </p>
                ) : null}
                <CapiroButton
                  variant="quiet"
                  size="compact"
                  onClick={() => navigate(`/strategies/context?clientId=${encodeURIComponent(clientId)}`)}
                >
                  View all {(clients.data ?? []).find((c) => c.id === clientId)?.name ?? 'client'} documents
                </CapiroButton>
              </>
            ) : null}
          </div>
        </aside>
      </div>
    </StrategiesModalShell>
  );
}
