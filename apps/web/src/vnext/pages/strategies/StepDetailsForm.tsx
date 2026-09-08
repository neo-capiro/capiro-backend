import { useState } from 'react';
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
}: {
  strategyId: string;
  clientId?: string;
  step: StrategyNode | null;
  siblings: StrategyNode[];
  onDone: () => void;
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
  const badWindow = Boolean(endsOn && !(kind === 'risk' && openEnded) && endsOn < startsOn);
  const fail = (cause: unknown) => {
    const response = (cause as { response?: { data?: { message?: string | string[] } } })?.response
      ?.data?.message;
    setError(
      Array.isArray(response)
        ? response.join(' ')
        : response || (cause as Error)?.message || 'The step could not be saved.',
    );
  };
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
        { onSuccess: onDone, onError: fail },
      );
    else
      add.mutate(
        { ...input, title: title.trim(), kind, subject, startsOn },
        { onSuccess: onDone, onError: fail },
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
        <CapiroButton type="button" disabled={busy} onClick={onDone}>
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
