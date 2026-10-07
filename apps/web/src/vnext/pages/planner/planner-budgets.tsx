import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import { X } from 'lucide-react';
import {
  plannerBudgetAmounts,
  plannerMoneyFormat,
  plannerMoneyInput,
  plannerMoneyMinor,
  type PlannerProjectBudget,
  type PlannerPortfolioBudgets,
  type PlannerBootstrap,
  type PlannerBudgetData,
  type PlannerBudgetAlert,
} from '@capiro/strategy-verifier';
import { useApi } from '../../../lib/use-api.js';
import { usePlannerKey, plannerError } from './planner-api.js';

const BASE = '/strategy-api/planner';
const hours = (minutes: number) =>
  `${(minutes / 60).toLocaleString('en-US', { maximumFractionDigits: 2 })} h`;
function ErrorMessage({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="planner-error">
      {plannerError(error)}
    </p>
  ) : null;
}
function BudgetDialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && close()}
      className="planner-modal-overlay"
    >
      <Modal className="planner-modal">
        <Dialog aria-label={title}>
          <div className="planner-dialog-head">
            <Heading slot="title">{title}</Heading>
            <button aria-label={`Close ${title}`} onClick={close}>
              <X size={18} />
            </button>
          </div>
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
export function PlannerBudget({
  bootstrap,
  projectId,
}: {
  bootstrap: PlannerBootstrap;
  projectId: string;
}) {
  const api = useApi(),
    key = usePlannerKey(),
    client = useQueryClient();
  const project = bootstrap.projects.find((p) => p.id === projectId);
  const query = useQuery({
    queryKey: [...key, 'budget', projectId],
    enabled: project?.access === 'admin',
    queryFn: async ({ signal }) =>
      (await api.get<PlannerProjectBudget>(`${BASE}/projects/${projectId}/budget`, { signal }))
        .data,
    refetchInterval: 30_000,
  });
  const [editing, setEditing] = useState<{
    kind: 'budget' | 'rates' | 'alert';
    budget: PlannerProjectBudget;
  } | null>(null);
  const save = useMutation({
    mutationFn: async (input: {
      version: number;
      data: Partial<PlannerBudgetData> | Omit<PlannerBudgetAlert, 'version'>;
      alert?: boolean;
    }) =>
      (
        await api.patch<PlannerProjectBudget>(
          `${BASE}/projects/${projectId}/budget${input.alert ? '/alert' : ''}`,
          { version: input.version, data: input.data },
        )
      ).data,
    onSuccess: async (data) => {
      setEditing(null);
      client.setQueryData([...key, 'budget', projectId], data);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  if (project?.access !== 'admin')
    return <p>Project admin access is required to view budgets, rates and costs.</p>;
  if (query.isError)
    return (
      <>
        <ErrorMessage error={query.error} />
        <button onClick={() => void query.refetch()}>Refresh budget</button>
      </>
    );
  if (!query.data) return <p role="status">Loading project budget…</p>;
  const budget = query.data,
    amounts = plannerBudgetAmounts(budget),
    cost = budget.data.measurement === 'cost';
  const display = (value: string) =>
    cost ? plannerMoneyFormat(value, budget.data.currency) : hours(Number(value));
  const percent =
    amounts.budget && BigInt(amounts.budget) > 0n
      ? Number((BigInt(amounts.actual) * 10000n) / BigInt(amounts.budget)) / 100
      : null;
  const remaining =
    amounts.budget === null ? null : (BigInt(amounts.budget) - BigInt(amounts.actual)).toString();
  const canEdit = !project.archived;
  return (
    <div className="planner-budget" aria-label="Project budget">
      <div className="planner-head-actions">
        <h3>Budget and costs</h3>
        <button
          disabled={!canEdit}
          onClick={() => {
            save.reset();
            setEditing({ kind: 'budget', budget });
          }}
        >
          Set budget
        </button>
        <button
          disabled={!canEdit}
          onClick={() => {
            save.reset();
            setEditing({ kind: 'rates', budget });
          }}
        >
          Manage rates
        </button>
        <button
          disabled={!canEdit}
          onClick={() => {
            save.reset();
            setEditing({ kind: 'alert', budget });
          }}
        >
          My budget alert
        </button>
      </div>
      <p className="planner-muted">
        Project admins only · Estimated time from tasks · Actual time:{' '}
        {budget.data.actualFilter === 'all'
          ? 'all entries'
          : budget.data.actualFilter === 'billable'
            ? 'billable entries'
            : 'non-billable entries'}
      </p>
      <div className="planner-budget-metrics">
        <article>
          <span>Budget</span>
          <strong>{amounts.budget === null ? 'No limit set' : display(amounts.budget)}</strong>
        </article>
        <article>
          <span>
            {cost && budget.unratedEstimatedMinutes ? 'Rated estimated cost' : 'Estimated'}
          </span>
          <strong>{display(amounts.estimated)}</strong>
        </article>
        <article>
          <span>{cost && budget.unratedActualMinutes ? 'Rated actual cost' : 'Actual'}</span>
          <strong>{display(amounts.actual)}</strong>
        </article>
        <article>
          <span>{remaining !== null && BigInt(remaining) < 0n ? 'Over budget' : 'Remaining'}</span>
          <strong>
            {remaining === null
              ? '—'
              : display(BigInt(remaining) < 0n ? (-BigInt(remaining)).toString() : remaining)}
          </strong>
        </article>
      </div>
      {percent !== null && (
        <div>
          <progress max={100} value={Math.min(100, percent)} aria-label="Budget used" />
          <p>
            {percent.toLocaleString('en-US', { maximumFractionDigits: 2 })}% used
            {cost && !amounts.complete ? ' · Based on rated time' : ''}
          </p>
        </div>
      )}
      {(budget.unratedEstimatedMinutes > 0 || budget.unratedActualMinutes > 0) && (
        <p className="planner-budget-notice">
          Unrated time: {hours(budget.unratedEstimatedMinutes)} estimated ·{' '}
          {hours(budget.unratedActualMinutes)} actual. Add rates to include it in costs. Cost alerts
          require rates for actual time and, when comparing with an estimate, estimated time.
        </p>
      )}
      <p className="planner-muted">
        {budget.alert.enabled
          ? `My alert: ${budget.alert.percent}% of ${budget.alert.comparison} · Planner Inbox and notification bell`
          : 'My budget alert is off'}
      </p>
      <p>
        Estimated time {hours(budget.estimatedMinutes)} · Actual time {hours(budget.actualMinutes)}{' '}
        · Billable {hours(budget.billableMinutes)} · Non-billable {hours(budget.nonbillableMinutes)}
      </p>
      <div className="planner-table-scroll">
        <table className="planner-budget-table">
          <caption>People and costs · {budget.data.currency}</caption>
          <thead>
            <tr>
              <th>Person</th>
              <th>Hourly rate</th>
              <th>Estimated time</th>
              <th>Actual time</th>
              <th>Estimated cost</th>
              <th>Actual cost</th>
            </tr>
          </thead>
          <tbody>
            {budget.people.map((p) => (
              <tr key={p.userId ?? 'unassigned'}>
                <td>
                  {p.name}
                  {p.userId && !p.active ? ' · Former member' : ''}
                </td>
                <td>
                  {p.hourlyMinor === null
                    ? 'Unrated'
                    : plannerMoneyFormat(p.hourlyMinor, budget.data.currency)}
                </td>
                <td>{hours(p.estimatedMinutes)}</td>
                <td>{hours(p.actualMinutes)}</td>
                <td>
                  {p.estimatedMinor === null
                    ? 'Unrated'
                    : plannerMoneyFormat(p.estimatedMinor, budget.data.currency)}
                </td>
                <td>
                  {p.actualMinor === null
                    ? 'Unrated'
                    : plannerMoneyFormat(p.actualMinor, budget.data.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <BudgetDialog
          title={
            editing.kind === 'budget'
              ? 'Set project budget'
              : editing.kind === 'rates'
                ? 'Project rates'
                : 'My budget alert'
          }
          close={() => setEditing(null)}
        >
          {editing.kind === 'budget' ? (
            <BudgetEditor
              budget={editing.budget}
              pending={save.isPending}
              error={save.error}
              onSave={(data) => save.mutate({ version: editing.budget.version, data })}
            />
          ) : editing.kind === 'rates' ? (
            <RateEditor
              budget={editing.budget}
              bootstrap={bootstrap}
              pending={save.isPending}
              error={save.error}
              onSave={(data) => save.mutate({ version: editing.budget.version, data })}
            />
          ) : (
            <AlertEditor
              alert={editing.budget.alert}
              pending={save.isPending}
              error={save.error}
              onSave={(data) =>
                save.mutate({ version: editing.budget.alert.version, data, alert: true })
              }
            />
          )}
        </BudgetDialog>
      )}
    </div>
  );
}
function BudgetEditor({
  budget,
  onSave,
  pending,
  error,
}: {
  budget: PlannerProjectBudget;
  onSave: (data: Partial<PlannerBudgetData>) => void;
  pending: boolean;
  error: unknown;
}) {
  const [measurement, setMeasurement] = useState(budget.data.measurement),
    [time, setTime] = useState(
      budget.data.budgetMinutes === null ? '' : String(budget.data.budgetMinutes / 60),
    ),
    [money, setMoney] = useState(
      budget.data.budgetMinor === null ? '' : plannerMoneyInput(budget.data.budgetMinor),
    ),
    [actualFilter, setFilter] = useState(budget.data.actualFilter);
  const limitMinutes =
    time.trim() === ''
      ? null
      : /^\d+(?:\.\d{1,8})?$/.test(time.trim())
        ? Math.round(Number(time) * 60)
        : NaN;
  const limitMinor = money.trim() === '' ? null : plannerMoneyMinor(money);
  const valid =
    measurement === 'time'
      ? limitMinutes === null ||
        (Number.isSafeInteger(limitMinutes) && limitMinutes > 0 && limitMinutes <= 100_000_000)
      : money.trim() === '' || (limitMinor !== null && BigInt(limitMinor) > 0n);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid)
      onSave({
        measurement,
        actualFilter,
        ...(measurement === 'time' ? { budgetMinutes: limitMinutes } : { budgetMinor: limitMinor }),
      });
  };
  return (
    <form onSubmit={submit} className="planner-editor">
      <label className="planner-field">
        <span>Budget measurement</span>
        <select
          value={measurement}
          onChange={(e) => setMeasurement(e.target.value as 'time' | 'cost')}
        >
          <option value="time">Hours</option>
          <option value="cost">Cost · {budget.data.currency}</option>
        </select>
      </label>
      <label className="planner-field">
        <span>
          {measurement === 'time' ? 'Budget hours' : `Budget cost (${budget.data.currency})`}
        </span>
        <input
          inputMode="decimal"
          value={measurement === 'time' ? time : money}
          onChange={(e) =>
            measurement === 'time' ? setTime(e.target.value) : setMoney(e.target.value)
          }
        />
      </label>
      <p className="planner-muted">
        Leave the amount empty for no budget limit. Currency is fixed when the project budget is
        first saved.
      </p>
      <label className="planner-field">
        <span>Actual time included</span>
        <select
          value={actualFilter}
          onChange={(e) => setFilter(e.target.value as PlannerBudgetData['actualFilter'])}
        >
          <option value="all">All time</option>
          <option value="billable">Billable time</option>
          <option value="nonbillable">Non-billable time</option>
        </select>
      </label>
      <ErrorMessage error={error} />
      {!valid && <p role="alert">Enter a positive budget amount.</p>}
      <button className="planner-primary" disabled={pending || !valid}>
        {pending ? 'Saving…' : 'Save budget'}
      </button>
    </form>
  );
}
function RateEditor({
  budget,
  bootstrap,
  onSave,
  pending,
  error,
}: {
  budget: PlannerProjectBudget;
  bootstrap: PlannerBootstrap;
  onSave: (data: Partial<PlannerBudgetData>) => void;
  pending: boolean;
  error: unknown;
}) {
  const [rates, setRates] = useState(
      budget.data.rates.map((r) => ({ ...r, value: plannerMoneyInput(r.hourlyMinor) })),
    ),
    [person, setPerson] = useState('');
  const valid = rates.every((r) => plannerMoneyMinor(r.value) !== null);
  return (
    <form
      className="planner-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid)
          onSave({
            rates: rates.map((r) => ({
              userId: r.userId,
              name: r.name,
              hourlyMinor: plannerMoneyMinor(r.value)!,
            })),
          });
      }}
    >
      <p>
        Rates are per hour in {budget.data.currency}, rounded to two decimals. Adding a rate does
        not grant project access.
      </p>
      <label className="planner-field">
        <span>Add person</span>
        <select value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Choose a person</option>
          {bootstrap.people
            .filter((p) => !rates.some((r) => r.userId === p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!person || rates.length >= 500}
        onClick={() => {
          const p = bootstrap.people.find((p) => p.id === person)!;
          setRates([...rates, { userId: p.id, name: p.name, hourlyMinor: '0', value: '0.00' }]);
          setPerson('');
        }}
      >
        Add to rate pool
      </button>
      {rates.map((r, i) => (
        <div className="planner-budget-rate" key={r.userId}>
          <label className="planner-field">
            <span>
              {r.name}
              {!bootstrap.people.some((p) => p.id === r.userId) ? ' · Former member' : ''}
            </span>
            <input
              aria-label={`Hourly rate for ${r.name}`}
              inputMode="decimal"
              value={r.value}
              onChange={(e) =>
                setRates(rates.map((row, j) => (j === i ? { ...row, value: e.target.value } : row)))
              }
            />
          </label>
          <button
            type="button"
            aria-label={`Remove rate for ${r.name}`}
            onClick={() => setRates(rates.filter((_, j) => i !== j))}
          >
            Remove
          </button>
        </div>
      ))}
      <p className="planner-muted">
        {rates.length}/500 people. Former members keep their saved rate until removed.
      </p>
      <ErrorMessage error={error} />
      {!valid && <p role="alert">Enter a non-negative hourly rate for each person.</p>}
      <button className="planner-primary" disabled={pending || !valid}>
        {pending ? 'Saving…' : 'Save rates'}
      </button>
    </form>
  );
}
function AlertEditor({
  alert,
  onSave,
  pending,
  error,
}: {
  alert: PlannerBudgetAlert;
  onSave: (data: Omit<PlannerBudgetAlert, 'version'>) => void;
  pending: boolean;
  error: unknown;
}) {
  const [enabled, setEnabled] = useState(alert.enabled),
    [percent, setPercent] = useState(String(alert.percent)),
    [comparison, setComparison] = useState(alert.comparison);
  const valid = /^\d+$/.test(percent) && Number(percent) >= 1 && Number(percent) <= 1000;
  return (
    <form
      className="planner-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave({ enabled, percent: Number(percent), comparison });
      }}
    >
      <label className="planner-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Notify me when actual work reaches the threshold
      </label>
      <label className="planner-field">
        <span>Threshold percent</span>
        <input inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value)} />
      </label>
      <label className="planner-field">
        <span>Compare actual work with</span>
        <select
          value={comparison}
          onChange={(e) => setComparison(e.target.value as 'budget' | 'estimate')}
        >
          <option value="budget">Project budget</option>
          <option value="estimate">Estimated time or cost</option>
        </select>
      </label>
      <p>
        Delivery appears in your Planner Inbox and notification bell. Each saved configuration
        alerts once. Project admin access is required.
      </p>
      <ErrorMessage error={error} />
      <button className="planner-primary" disabled={pending || !valid}>
        {pending ? 'Saving…' : 'Save my alert'}
      </button>
    </form>
  );
}
export function PlannerPortfolioBudget({
  id,
  onProject,
}: {
  id: string;
  onProject: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false),
    api = useApi(),
    key = usePlannerKey();
  const query = useQuery({
    queryKey: [...key, 'portfolio-budgets', id],
    enabled: expanded,
    queryFn: async ({ signal }) =>
      (await api.get<PlannerPortfolioBudgets>(`${BASE}/portfolios/${id}/budgets`, { signal })).data,
    refetchInterval: expanded ? 30_000 : false,
  });
  return (
    <div className="planner-portfolio-budget">
      <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        Budget rollup
      </button>
      {expanded && (
        <>
          <p className="planner-muted">
            Includes projects where you have project admin access. Costs stay in each project's
            currency.
          </p>
          <ErrorMessage error={query.error} />
          {query.isPending ? (
            <p role="status">Loading budgets…</p>
          ) : (
            !query.isError &&
            query.data && (
              <>
                <p>
                  {hours(query.data.estimatedMinutes)} estimated · {hours(query.data.actualMinutes)}{' '}
                  actual · {hours(query.data.budgetMinutes)} time budget
                </p>
                {query.data.currencies.map((c) => (
                  <p key={c.currency}>
                    {c.currency}: {plannerMoneyFormat(c.estimatedMinor, c.currency)} rated estimate
                    · {plannerMoneyFormat(c.actualMinor, c.currency)} rated actual ·{' '}
                    {plannerMoneyFormat(c.budgetMinor, c.currency)} cost budget
                    {c.unratedActualMinutes || c.unratedEstimatedMinutes
                      ? ` · ${hours(c.unratedEstimatedMinutes)} estimated / ${hours(c.unratedActualMinutes)} actual unrated`
                      : ''}
                  </p>
                ))}
                {query.data.projects.map((p) => (
                  <button
                    key={p.projectId}
                    className="planner-related-link"
                    onClick={() => onProject(p.projectId)}
                  >
                    {p.projectName} · Budget and costs
                  </button>
                ))}
                {!query.data.projects.length && <p>No projects available for budget reporting.</p>}
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
