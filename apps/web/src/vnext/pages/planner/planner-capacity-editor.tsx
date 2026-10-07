import { useState, type ReactNode } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import {
  PLANNER_DEFAULT_CAPACITY_PLAN,
  plannerCapacityDateShift,
  type PlannerBootstrap,
  type PlannerCapacityPlan,
  type PlannerCapacityCatalog,
  type PlannerCapacityAllocation,
  type PlannerCapacityAllocationData,
  type PlannerStaffTeam,
  type PlannerStaffPlaceholder,
  type PlannerResource,
} from '@capiro/strategy-verifier';
import { plannerError } from './planner-api.js';
import { plannerToday } from './planner-views.js';
export type CapacityEditor =
  | { kind: 'plans'; row?: PlannerCapacityPlan }
  | { kind: 'teams'; row?: PlannerStaffTeam }
  | { kind: 'placeholders'; row?: PlannerStaffPlaceholder }
  | {
      kind: 'allocation';
      row?: PlannerCapacityAllocation;
      initial?: { projectId?: string; data: Partial<PlannerCapacityAllocationData> };
    };
function Frame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className="planner-modal-overlay"
    >
      <Modal className="planner-modal">
        <Dialog aria-label={title}>
          <header className="planner-dialog-head">
            <Heading slot="title">{title}</Heading>
            <button type="button" aria-label={`Close ${title}`} onClick={onClose}>
              ×
            </button>
          </header>
          <div className="planner-dialog-body">{children}</div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
function Multi({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="planner-capacity-choices">
      <legend>{label}</legend>
      {options.map((p) => (
        <label key={p.id}>
          <input
            type="checkbox"
            checked={value.includes(p.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, p.id] : value.filter((id) => id !== p.id))
            }
          />
          {p.name}
        </label>
      ))}
      {!options.length && <small>No available {label.toLowerCase()}.</small>}
    </fieldset>
  );
}
export function PlannerCapacityEditor({
  editor,
  catalog,
  bootstrap,
  portfolios,
  plan,
  onClose,
  onSave,
}: {
  editor: CapacityEditor;
  catalog: PlannerCapacityCatalog;
  bootstrap: PlannerBootstrap;
  portfolios: PlannerResource[];
  plan?: PlannerCapacityPlan;
  onClose: () => void;
  onSave: (body: any) => Promise<void>;
}) {
  const [name, setName] = useState(editor.row?.name ?? '');
  const [newId] = useState(() => crypto.randomUUID());
  const initial =
    editor.kind === 'plans'
      ? (editor.row?.data ?? PLANNER_DEFAULT_CAPACITY_PLAN)
      : editor.kind === 'teams'
        ? (editor.row?.data ?? { privacy: 'private', members: [], peopleIds: [], jobTitles: {} })
        : editor.kind === 'placeholders'
          ? (editor.row?.data ?? {
              teamId: catalog.teams.find((t) => !t.archived && t.access === 'admin')?.id ?? '',
              jobTitle: '',
              weeklyMinutes: 2400,
            })
          : (editor.row?.data ?? {
              userId: bootstrap.me.id,
              placeholderId: null,
              startOn: plannerToday(),
              endOn: plannerCapacityDateShift(plannerToday(), 6),
              effort: { unit: 'percent', value: 100 },
              ...(editor.kind === 'allocation' ? editor.initial?.data : {}),
            });
  const [data, setData] = useState<any>(structuredClone(initial));
  const [projectId, setProjectId] = useState(
    editor.kind === 'allocation'
      ? (editor.row?.projectId ?? editor.initial?.projectId ?? plan?.data.projectIds[0] ?? '')
      : '',
  );
  const [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  const set = (key: string, value: unknown) => setData((d: any) => ({ ...d, [key]: value }));
  const title =
    editor.kind === 'allocation'
      ? editor.row
        ? 'Edit allocation'
        : 'Allocate project work'
      : `${editor.row ? 'Edit' : 'New'} ${editor.kind === 'plans' ? 'capacity plan' : editor.kind === 'teams' ? 'Planner team' : 'staffing placeholder'}`;
  return (
    <Frame title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          try {
            const bodyData =
              editor.kind === 'teams'
                ? {
                    ...data,
                    jobTitles: Object.fromEntries(
                      Object.entries(data.jobTitles).filter(([id]) => data.peopleIds.includes(id)),
                    ),
                  }
                : data;
            await onSave({
              id: editor.row?.id ?? newId,
              ...(editor.row ? { version: editor.row.version } : {}),
              ...(editor.kind === 'allocation' ? { projectId } : { name }),
              data: bodyData,
            });
            onClose();
          } catch (err) {
            setError(err);
          } finally {
            setPending(false);
          }
        }}
      >
        {editor.kind !== 'allocation' && (
          <label className="planner-field">
            Name
            <input
              required
              maxLength={500}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {(editor.kind === 'plans' || editor.kind === 'teams') && (
          <>
            {editor.kind === 'plans' && (
              <label className="planner-field">
                Description
                <textarea
                  value={data.description}
                  maxLength={50000}
                  onChange={(e) => set('description', e.target.value)}
                />
              </label>
            )}
            <label className="planner-field">
              Visibility
              <select value={data.privacy} onChange={(e) => set('privacy', e.target.value)}>
                <option value="private">Private to invited members</option>
                <option value="team">Organization members can view</option>
              </select>
            </label>
            <fieldset className="planner-capacity-choices">
              <legend>Sharing</legend>
              {bootstrap.people
                .filter((p) => p.id !== (editor.row?.ownerId ?? bootstrap.me.id))
                .map((p) => (
                  <label key={p.id}>
                    <span>{p.name}</span>
                    <select
                      aria-label={`Sharing role for ${p.name}`}
                      value={data.members.find((m: any) => m.userId === p.id)?.role ?? ''}
                      onChange={(e) =>
                        set('members', [
                          ...data.members.filter((m: any) => m.userId !== p.id),
                          ...(e.target.value ? [{ userId: p.id, role: e.target.value }] : []),
                        ])
                      }
                    >
                      <option value="">No invitation</option>
                      <option value="viewer">Viewer</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>
                ))}
            </fieldset>
            <Multi
              label="People"
              options={bootstrap.people}
              value={data.peopleIds}
              onChange={(v) => set('peopleIds', v)}
            />
            {editor.kind === 'teams' && (
              <fieldset className="planner-capacity-choices">
                <legend>Planner job titles</legend>
                {bootstrap.people
                  .filter((p) => data.peopleIds.includes(p.id))
                  .map((p) => (
                    <label key={p.id}>
                      {p.name}
                      <input
                        aria-label={`Job title for ${p.name}`}
                        maxLength={200}
                        value={data.jobTitles[p.id] ?? ''}
                        onChange={(e) =>
                          set('jobTitles', { ...data.jobTitles, [p.id]: e.target.value })
                        }
                      />
                    </label>
                  ))}
              </fieldset>
            )}
            {editor.kind === 'plans' && (
              <>
                <Multi
                  label="Projects"
                  options={bootstrap.projects.filter((p) => !p.archived)}
                  value={data.projectIds}
                  onChange={(v) => set('projectIds', v)}
                />
                <Multi
                  label="Live portfolios"
                  options={portfolios}
                  value={data.portfolioIds}
                  onChange={(v) => set('portfolioIds', v)}
                />
                <Multi
                  label="Planner teams"
                  options={catalog.teams.filter((t) => !t.archived)}
                  value={data.teamIds}
                  onChange={(v) => set('teamIds', v)}
                />
              </>
            )}
          </>
        )}
        {editor.kind === 'placeholders' && (
          <>
            <label className="planner-field">
              Planner team
              <select
                required
                disabled={!!editor.row}
                value={data.teamId}
                onChange={(e) => set('teamId', e.target.value)}
              >
                <option value="">Choose a team</option>
                {catalog.teams
                  .filter((t) => !t.archived && t.access === 'admin')
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="planner-field">
              Job title
              <input
                value={data.jobTitle}
                maxLength={200}
                onChange={(e) => set('jobTitle', e.target.value)}
              />
            </label>
            <label className="planner-field">
              Weekly capacity (hours)
              <input
                type="number"
                min={0}
                max={168}
                step={1 / 60}
                required
                value={data.weeklyMinutes / 60}
                onChange={(e) => set('weeklyMinutes', Math.round(Number(e.target.value) * 60))}
              />
            </label>
          </>
        )}
        {editor.kind === 'allocation' && (
          <>
            <label className="planner-field">
              Project
              <select required value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Choose a project</option>
                {bootstrap.projects
                  .filter((p) => !p.archived && ['admin', 'editor'].includes(p.access))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="planner-field">
              Person or placeholder
              <select
                required
                value={data.userId ?? data.placeholderId ?? ''}
                onChange={(e) => {
                  const placeholder = catalog.placeholders.some((p) => p.id === e.target.value);
                  setData({
                    ...data,
                    userId: placeholder ? null : e.target.value,
                    placeholderId: placeholder ? e.target.value : null,
                  });
                }}
              >
                {bootstrap.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {catalog.placeholders
                  .filter((p) => !p.archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · Placeholder
                    </option>
                  ))}
              </select>
            </label>
            <div className="planner-capacity-form-grid">
              <label className="planner-field">
                Start date
                <input
                  type="date"
                  required
                  value={data.startOn}
                  onChange={(e) => set('startOn', e.target.value)}
                />
              </label>
              <label className="planner-field">
                End date
                <input
                  type="date"
                  required
                  min={data.startOn}
                  value={data.endOn}
                  onChange={(e) => set('endOn', e.target.value)}
                />
              </label>
            </div>
            <div className="planner-capacity-form-grid">
              <label className="planner-field">
                Effort unit
                <select
                  value={data.effort.unit}
                  onChange={(e) => set('effort', { ...data.effort, unit: e.target.value })}
                >
                  <option value="percent">Percent of weekly capacity</option>
                  <option value="hours">Total hours</option>
                </select>
              </label>
              <label className="planner-field">
                Effort
                <input
                  type="number"
                  required
                  min={0.01}
                  max={data.effort.unit === 'percent' ? 1000 : 1000000}
                  step="any"
                  value={data.effort.value}
                  onChange={(e) => set('effort', { ...data.effort, value: Number(e.target.value) })}
                />
              </label>
            </div>
            <p className="planner-muted">
              Hours are distributed over Monday–Friday. Percent uses the person’s weekly capacity.
              This allocation is shared across plans that include its project or person.
            </p>
          </>
        )}
        {error ? (
          <p role="alert" className="planner-error">
            {plannerError(error)}
          </p>
        ) : null}
        <button className="planner-primary" disabled={pending}>
          Save{' '}
          {editor.kind === 'allocation'
            ? 'allocation'
            : editor.kind === 'plans'
              ? 'plan'
              : editor.kind === 'teams'
                ? 'team'
                : 'placeholder'}
        </button>
      </form>
    </Frame>
  );
}
