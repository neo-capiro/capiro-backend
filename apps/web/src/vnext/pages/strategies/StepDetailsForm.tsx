import { useEffect, useMemo, useState } from 'react';
import { CapiroButton } from '../../components/actions/index.js';
import { useAddNode, useDeleteNode, useTenantMembers, useUpdateNode } from './strategies-api.js';
import {
  useClientTargetsLite,
  targetDisplayLabel,
  targetRefFromClientTarget,
} from '../../../pages/strategy/client-targets-lite.js';
import { NODE_STATUS_OPTIONS } from '../../../pages/strategy/constants.js';
import type {
  NodeKind,
  NodeStatus,
  NodeSubject,
  StrategyNode,
  UpdateNodeInput,
} from '../../../pages/strategy/types.js';

const KINDS: NodeKind[] = ['action', 'gate', 'milestone', 'decision', 'risk'];
const SUBJECTS: NodeSubject[] = [
  'deliverable',
  'submission',
  'member',
  'committee',
  'ask',
  'agency',
  'outcome',
  'optics',
];
const label = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');

/** Manual edits use the same versioned node services as all other writers. */
export function StepDetailsForm({
  strategyId,
  clientId,
  step,
  siblings,
  onDone,
  onDirtyChange,
  onSavingChange,
  onRequestLeave,
}: {
  strategyId: string;
  clientId?: string;
  step: StrategyNode | null;
  siblings: StrategyNode[];
  onDone: () => void;
  /**
   * F09 (2026-09-10 plan §7): the form reports its dirty state up so the
   * editor can guard EVERY transition that would discard it. `dirty` is
   * computed against the captured initial model — save semantics
   * normalization (trimmed strings, null-for-empty, unordered dependency ids)
   * so reverting a field returns the form to clean and default new-step
   * values never count as edits.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * F09: saving state reports up so the guard can block conflicting
   * close/discard actions while a mutation is in flight.
   */
  onSavingChange?: (saving: boolean) => void;
  /**
   * F09: the guard's requestLeave — Cancel editing routes through it so a
   * dirty draft asks Keep/Discard instead of discarding silently.
   */
  onRequestLeave?: (action: () => void) => void;
}) {
  const add = useAddNode(strategyId);
  const update = useUpdateNode(strategyId);
  const remove = useDeleteNode(strategyId);
  const members = useTenantMembers();
  const targets = useClientTargetsLite(clientId);
  const [reviewedVersion] = useState(step?.updatedAt);
  const [title, setTitle] = useState(step?.title ?? '');
  const [note, setNote] = useState(step?.note ?? '');
  const [kind, setKind] = useState<NodeKind>(step?.kind ?? 'action');
  const [subject, setSubject] = useState<NodeSubject>(step?.subject ?? 'deliverable');
  const [owner, setOwner] = useState(step?.ownerUserId ?? '');
  const [status, setStatus] = useState<NodeStatus>(step?.status ?? 'draft');
  const [startsOn, setStartsOn] = useState(step?.startsOn.slice(0, 10) ?? '');
  const [endsOn, setEndsOn] = useState(step?.endsOn?.slice(0, 10) ?? '');
  const [openEnded, setOpenEnded] = useState(step?.openEnded ?? false);
  const [dependsOnIds, setDependsOnIds] = useState(step?.dependsOnIds ?? []);
  const [target, setTarget] = useState(step?.targetRef ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = add.isPending || update.isPending || remove.isPending;
  useEffect(() => {
    onSavingChange?.(busy);
  }, [busy, onSavingChange]);

  /*
   * F09 dirty model — the baseline is the SAVED step, normalized exactly the
   * way `save()` serializes it: trimmed title/note, empty→null owner, risk
   * open-ended end handling, sorted dependency ids, and the target reference.
   * An untouched NEW form matches its own defaults and is therefore clean.
   */
  const dirty = useMemo(() => {
    const baseline = step
      ? {
          title: step.title,
          note: step.note ?? '',
          kind: step.kind,
          subject: step.subject,
          owner: step.ownerUserId ?? '',
          status: step.status,
          startsOn: step.startsOn.slice(0, 10),
          endsOn: (step.kind === 'risk' && step.openEnded ? null : step.endsOn?.slice(0, 10)) ?? '',
          openEnded: step.openEnded ?? false,
          dependsOnIds: [...step.dependsOnIds].sort(),
          target: step.targetRef ?? null,
        }
      : null;
    const current = {
      title: title.trim(),
      note: note.trim(),
      kind,
      subject,
      owner,
      status,
      startsOn,
      endsOn: kind === 'risk' && openEnded ? '' : endsOn,
      openEnded,
      dependsOnIds: [...dependsOnIds].sort(),
      target,
    };
    if (!baseline) {
      // New step: default values must not make an untouched form dirty —
      // only a deviation from the defaults does.
      const defaults = {
        title: '',
        note: '',
        kind: 'action' as NodeKind,
        subject: 'deliverable' as NodeSubject,
        owner: '',
        status: 'draft' as NodeStatus,
        startsOn: '',
        endsOn: '',
        openEnded: false,
        dependsOnIds: [] as string[],
        target: null,
      };
      return (
        current.title !== defaults.title ||
        current.note !== defaults.note ||
        current.kind !== defaults.kind ||
        current.subject !== defaults.subject ||
        current.owner !== defaults.owner ||
        current.status !== defaults.status ||
        current.startsOn !== defaults.startsOn ||
        current.endsOn !== defaults.endsOn ||
        current.openEnded !== defaults.openEnded ||
        current.dependsOnIds.join(',') !== defaults.dependsOnIds.join(',') ||
        current.target !== defaults.target
      );
    }
    return (
      current.title !== baseline.title ||
      current.note !== baseline.note ||
      current.kind !== baseline.kind ||
      current.subject !== baseline.subject ||
      current.owner !== baseline.owner ||
      current.status !== baseline.status ||
      current.startsOn !== baseline.startsOn ||
      current.endsOn !== baseline.endsOn ||
      current.openEnded !== baseline.openEnded ||
      current.dependsOnIds.join(',') !== baseline.dependsOnIds.join(',') ||
      current.target !== baseline.target
    );
  }, [step, title, note, kind, subject, owner, status, startsOn, endsOn, openEnded, dependsOnIds, target]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const fail = (cause: unknown) => {
    const response = (cause as { response?: { data?: { message?: string | string[] } } })?.response
      ?.data?.message;
    setError(
      Array.isArray(response)
        ? response.join(' ')
        : response || (cause as Error)?.message || 'The step could not be saved.',
    );
  };
  const badWindow = Boolean(endsOn && !(kind === 'risk' && openEnded) && endsOn < startsOn);
  const save = () => {
    if (busy || !title.trim() || !startsOn || badWindow) return;
    setError(null);
    const input: UpdateNodeInput = {
      title: title.trim(),
      note: note.trim() || null,
      kind,
      subject,
      ownerUserId: owner || null,
      status,
      startsOn,
      endsOn: kind === 'risk' && openEnded ? null : endsOn || null,
      openEnded: kind === 'risk' && openEnded,
      dependsOnIds,
      targetRef: target,
    };
    if (step)
      update.mutate(
        {
          nodeId: step.id,
          input: {
            ...input,
            expectedUpdatedAt: reviewedVersion,
            changeNote: `Updated ${title.trim()}`,
          },
        },
        {
          // F09: a successful save clears the guard BEFORE the form leaves
          // edit mode (no second confirmation); failed saves keep the draft.
          onSuccess: () => {
            onDirtyChange?.(false);
            onDone();
          },
          onError: fail,
        },
      );
    else
      add.mutate(
        { ...input, title: title.trim(), kind, subject, startsOn },
        {
          onSuccess: () => {
            onDirtyChange?.(false);
            onDone();
          },
          onError: fail,
        },
      );
  };

  return (
    <form
      className="st-step-form"
      aria-label={step ? 'Edit step details' : 'New step details'}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <fieldset disabled={busy}>
        <legend>{step ? 'Edit step' : 'Add step'}</legend>
        <label>
          Title
          <input
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Description
          <textarea
            rows={4}
            maxLength={8000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="st-step-form__pair">
          <label>
            Kind
            <select value={kind} onChange={(event) => setKind(event.target.value as NodeKind)}>
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Subject
            <select
              value={subject}
              onChange={(event) => setSubject(event.target.value as NodeSubject)}
            >
              {SUBJECTS.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Owner
          <select value={owner} onChange={(event) => setOwner(event.target.value)}>
            <option value="">Unassigned</option>
            {owner && !(members.data ?? []).some((member) => member.clerkUserId === owner) ? (
              <option value={owner}>Current owner (unavailable)</option>
            ) : null}
            {(members.data ?? []).map((member) => (
              <option key={member.clerkUserId} value={member.clerkUserId}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
        {members.isError ? (
          <p role="alert">Owners could not be loaded. Keep the current owner or try again.</p>
        ) : null}
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value as NodeStatus)}>
            {NODE_STATUS_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="st-purpose">
          Active, In progress and Completed steps appear in client reports. Use Draft or Internal
          review to exclude a step. Completed work no longer counts as overdue.
        </p>
        <div className="st-step-form__pair">
          <label>
            Start date
            <input
              required
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
          </label>
          <label>
            End date
            <input
              type="date"
              min={startsOn || undefined}
              disabled={kind === 'risk' && openEnded}
              value={endsOn}
              onChange={(event) => setEndsOn(event.target.value)}
            />
          </label>
        </div>
        {kind === 'risk' ? (
          <label className="st-step-form__check">
            <input
              type="checkbox"
              checked={openEnded}
              onChange={(event) => setOpenEnded(event.target.checked)}
            />
            Ongoing risk
          </label>
        ) : null}
        {badWindow ? <p role="alert">End date must be on or after start date.</p> : null}
        <label>
          Stakeholder target
          <select
            value={target?.clientTargetId ?? (target ? '__current__' : '')}
            onChange={(event) => {
              if (!event.target.value) setTarget(null);
              const selected = targets.data?.find((item) => item.id === event.target.value);
              if (selected) setTarget(targetRefFromClientTarget(selected));
            }}
          >
            <option value="">No target</option>
            {target && !(targets.data ?? []).some((item) => item.id === target.clientTargetId) ? (
              <option value={target.clientTargetId ?? '__current__'}>
                {targetDisplayLabel(target)}
              </option>
            ) : null}
            {(targets.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.memberName || item.memberId}
              </option>
            ))}
          </select>
        </label>
        {targets.isError ? (
          <p role="alert">Client targets could not be loaded. Your existing target is retained.</p>
        ) : null}
        <fieldset className="st-step-form__dependencies">
          <legend>Prerequisite steps</legend>
          <p>Select work or decisions this step relies on. Actions may overlap; a gate or decision should resolve before dependent work starts. Review warnings on the timeline after saving.</p>
          {siblings
            .filter((node) => node.id !== step?.id)
            .map((node) => (
              <label key={node.id} className="st-step-form__check">
                <input
                  type="checkbox"
                  checked={dependsOnIds.includes(node.id)}
                  disabled={!dependsOnIds.includes(node.id) && dependsOnIds.length >= 20}
                  onChange={(event) =>
                    setDependsOnIds((current) =>
                      event.target.checked
                        ? [...current, node.id]
                        : current.filter((id) => id !== node.id),
                    )
                  }
                />
                {node.title}
              </label>
            ))}
          {siblings.filter((node) => node.id !== step?.id).length === 0 ? (
            <p>No other steps in this plan.</p>
          ) : null}
        </fieldset>
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
      <div className="st-inspector__actions">
        <CapiroButton
          type="submit"
          variant="primary"
          disabled={busy || !title.trim() || !startsOn || badWindow}
        >
          {busy ? 'Saving…' : step ? 'Save step' : 'Add step'}
        </CapiroButton>
        <CapiroButton
          type="button"
          disabled={busy}
          onClick={() => (onRequestLeave ? onRequestLeave(onDone) : onDone())}
        >
          Cancel editing
        </CapiroButton>
      </div>
      {step ? (
        <div className="st-step-form__delete">
          {confirmDelete ? (
            <div role="alertdialog" aria-label="Delete this step?">
              <p>Remove this step from the plan? Its history and created outputs are retained.</p>
              <CapiroButton
                type="button"
                disabled={busy}
                onClick={() => remove.mutate(step.id, { onSuccess: onDone, onError: fail })}
              >
                Confirm delete step
              </CapiroButton>
              <CapiroButton type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Keep step
              </CapiroButton>
            </div>
          ) : (
            <CapiroButton type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete step
            </CapiroButton>
          )}
        </div>
      ) : null}
    </form>
  );
}
