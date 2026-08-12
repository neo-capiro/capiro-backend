/*
 * §7.10a — New strategy overlay. Route: /strategies/new (over the library).
 *
 * Client, objective type, goal, owner (required); target date + Meri context
 * (optional); grounding documents; starting point (empty timeline vs draft with
 * Meri — draft creates the strategy AND a draft proposal, never an applied
 * plan); available-context panel. Primary stays disabled until the required
 * fields are complete. Focus trap / Escape / dirty guard / route sync live in
 * StrategiesModalShell — this file is only the body.
 *
 * GAP (grounding documents): the design's attach row implies a document
 * picker, but no attachment upload/list endpoint exists in this module
 * (DraftStrategyInput.attachmentIds has no source of ids here). The row is
 * rendered informational: it reports how many active client context documents
 * will already ground the draft, and points at Context → Upload.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroSelect } from '../../../components/fields/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { OBJECTIVE_TYPES } from '../../../../pages/strategy/constants.js';
import type { StrategyType } from '../../../../pages/strategy/types.js';
import {
  useClientsLite,
  useContextDocuments,
  useContextFacts,
  useContextHealth,
  useCreateStrategy,
  useDraftStrategy,
  useFirmPhases,
  useTenantMembers,
} from '../strategies-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

type StartingPoint = 'empty' | 'draft';

export function NewStrategyOverlay() {
  const navigate = useNavigate();
  const clients = useClientsLite();
  const members = useTenantMembers();
  const phases = useFirmPhases();
  const documents = useContextDocuments();
  const facts = useContextFacts();

  const [clientId, setClientId] = useState('');
  const [type, setType] = useState<StrategyType | ''>('');
  const [goal, setGoal] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [meriContext, setMeriContext] = useState('');
  const [startingPoint, setStartingPoint] = useState<StartingPoint>('empty');

  const health = useContextHealth(clientId || null);
  const createStrategy = useCreateStrategy();
  const draftStrategy = useDraftStrategy();
  const busy = createStrategy.isPending || draftStrategy.isPending;
  const mutationError = createStrategy.error ?? draftStrategy.error;

  const clientDocuments = useMemo(
    () =>
      (documents.data ?? []).filter(
        (doc) => doc.state === 'active' && (doc.clientId === clientId || doc.clientId === null),
      ),
    [documents.data, clientId],
  );
  const clientFacts = useMemo(
    () =>
      (facts.data ?? []).filter(
        (fact) => fact.state === 'active' && (fact.clientId === clientId || fact.clientId === null),
      ),
    [facts.data, clientId],
  );

  const requiredComplete = Boolean(clientId && type && goal.trim() && ownerUserId);
  const dirty = Boolean(clientId || type || goal.trim() || ownerUserId || targetDate || meriContext.trim());

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
      size="lg"
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
            error={clients.isError ? 'Clients could not be loaded — retry from the library.' : undefined}
          />
          <CapiroSelect
            label="Objective type · Required"
            value={type}
            onChange={(event) => setType(event.target.value as StrategyType | '')}
            options={typeOptions}
          />
          <label className="capiro-field">
            <span className="capiro-field__label">Goal statement · Required</span>
            <textarea
              className="st-textarea"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="e.g. Restore the FY27 Ground Robotics reduction and protect related procurement through conference."
            />
          </label>
          <div className="st-field-row">
            <CapiroSelect
              label="Owner · Required"
              value={ownerUserId}
              onChange={(event) => setOwnerUserId(event.target.value)}
              options={ownerOptions}
            />
            <label className="capiro-field">
              <span className="capiro-field__label">Target outcome date · Optional</span>
              <input
                className="capiro-input"
                type="date"
                value={targetDate}
                onChange={(event) => setTargetDate(event.target.value)}
              />
            </label>
          </div>
          <label className="capiro-field">
            <span className="capiro-field__label">Context for Meri · Optional</span>
            <textarea
              className="st-textarea"
              value={meriContext}
              onChange={(event) => setMeriContext(event.target.value)}
              placeholder="Prioritize verified budget evidence, committee jurisdiction and client-approved proof points."
            />
          </label>

          <div className="st-panel">
            <p className="st-panel__label">Grounding documents · Optional</p>
            <p className="st-ns__context-sub" style={{ margin: 0 }}>
              {clientId
                ? `${clientDocuments.length} linked context document${clientDocuments.length === 1 ? '' : 's'} will already be available to Meri.`
                : 'Select a client to see which context documents will ground the draft.'}{' '}
              Upload memos, bill text or prior plans via Context → Upload after the strategy is created.
            </p>
          </div>
        </div>

        <aside>
          <p className="st-panel__label">Starting point</p>
          <div className="st-field-stack">
            <button
              type="button"
              className="st-option-card"
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
              aria-pressed={startingPoint === 'draft'}
              onClick={() => setStartingPoint('draft')}
            >
              <span className="st-option-card__head">
                Draft with Meri
                {startingPoint === 'draft' ? <span aria-hidden="true">✓</span> : null}
              </span>
              <span className="st-option-card__desc">
                Generate proposed phases, gates and actions from approved context. Nothing is applied
                automatically.
              </span>
              <span className="st-option-card__foot">
                <span className="st-pill st-pill--warning">Review required</span>
              </span>
            </button>
            <p className="st-ns__note">
              You can change the starting point later. Both options preserve the same strategy model.
            </p>
          </div>

          <div className="st-panel" style={{ marginTop: 16 }}>
            <p className="st-panel__label">Available context</p>
            {!clientId ? (
              <p className="st-ns__context-sub" style={{ margin: 0 }}>
                Select a client to see the context Meri will ground on.
              </p>
            ) : facts.isLoading || documents.isLoading ? (
              <div className="st-skel-stack">
                <CapiroSkeleton height={28} width="60%" />
                <CapiroSkeleton height={14} />
                <CapiroSkeleton height={14} width="80%" />
              </div>
            ) : facts.isError || documents.isError ? (
              <CapiroErrorState
                title="Context unavailable"
                description="The context inventory could not be loaded. The strategy can still be created."
                onRetry={() => {
                  void facts.refetch();
                  void documents.refetch();
                }}
              />
            ) : (
              <>
                <div className="st-ns__context-stat">{clientFacts.length} facts</div>
                <p className="st-ns__context-sub">
                  {clientDocuments.length} client doc{clientDocuments.length === 1 ? '' : 's'} ·{' '}
                  {phases.data?.length ?? '…'} firm phases
                </p>
                {health.data ? (
                  health.data.status === 'ok' ? (
                    <span className="st-pill st-pill--success">Healthy</span>
                  ) : health.data.status === 'conflicted' ? (
                    <span className="st-pill st-pill--danger">
                      {health.data.openMaterialConflicts.length} open conflict
                      {health.data.openMaterialConflicts.length === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="st-pill st-pill--warning">Degraded context</span>
                  )
                ) : null}
              </>
            )}
          </div>
        </aside>
      </div>
    </StrategiesModalShell>
  );
}
