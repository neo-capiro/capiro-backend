import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { useApi } from '../../../lib/use-api.js';
import { useUrlState } from '../../../pages/intelligence/opportunities/funding-opportunities-url-state.js';
import {
  encodeOpportunityRef,
  type InboxSource,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FovAlert, FovCard, FovModal } from './fov-ui.js';
import { refreshOpportunityQueries } from './opportunity-query-cache.js';

interface Client {
  id: string;
  name: string;
  status?: string;
}
interface Member {
  id: string;
  name: string | null;
  email: string;
}
type Action = 'save' | 'watch' | 'pass' | 'restore' | 'review' | 'pursuit' | 'plan';

/** The same client-scoped actions for catalog and Tango records. */
export function OpportunityClientActions({
  source,
  sourceRecordId,
  clientId,
  title,
  isActive,
  canPursue = false,
  workflowStatus,
  notes: existingNotes,
  ownerUserId: existingOwner,
  nextAction: existingNextAction,
  nextActionDueAt: existingDueAt,
  pursuitLabel = 'Pursue',
}: {
  source: InboxSource;
  sourceRecordId: string;
  clientId: string | null;
  title: string;
  isActive: boolean;
  canPursue?: boolean;
  workflowStatus?: string | null;
  notes?: string | null;
  ownerUserId?: string | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  pursuitLabel?: string;
}) {
  const api = useApi();
  const cache = useQueryClient();
  const toast = useCapiroToast();
  const url = useUrlState();
  const [selectedClient, setSelectedClient] = useState('');
  const [form, setForm] = useState<'review' | 'pursuit' | 'plan' | null>(null);
  const [nextAction, setNextAction] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [owner, setOwner] = useState('');
  const [notes, setNotes] = useState('');
  const [initial, setInitial] = useState({ owner: '', notes: '', nextAction: '', dueDate: '' });
  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    enabled: !clientId,
    staleTime: 60_000,
  });
  const members = useQuery<Member[]>({
    queryKey: ['tenant-members'],
    queryFn: async () => (await api.get<Member[]>('/api/tenant-members')).data,
    enabled: Boolean(clientId && form),
    staleTime: 60_000,
  });
  const terminal = ['won', 'lost', 'dismissed', 'expired'].includes(workflowStatus ?? '');
  const pursuing = workflowStatus === 'pursuing';
  const saved = workflowStatus === 'saved' || pursuing || terminal;
  const mutate = useMutation({
    mutationFn: async (action: Action) => {
      if (!clientId) throw new Error('Select a client first.');
      const base = `/api/intelligence/clients/${encodeURIComponent(clientId)}/opportunities/${source}/${encodeURIComponent(sourceRecordId)}`;
      if (action === 'save') return (await api.post(`${base}/save`, { status: 'saved' })).data;
      if (action === 'watch')
        return (await api.post(`${base}/decision`, { decision: 'monitor' })).data;
      if (action === 'pass') return (await api.post(`${base}/dismiss`, {})).data;
      if (action === 'restore') return (await api.post(`${base}/restore`, {})).data;
      if (action === 'plan') {
        const patch: Record<string, string | null> = {};
        if (owner !== initial.owner) patch.ownerUserId = owner || null;
        if (notes.trim() !== initial.notes.trim()) patch.notes = notes.trim() || null;
        if (nextAction.trim() !== initial.nextAction.trim())
          patch.nextAction = nextAction.trim() || null;
        if (dueDate !== initial.dueDate)
          patch.nextActionDueAt = dueDate ? `${dueDate}T12:00:00.000Z` : null;
        // Clearing an action clears its date in the same transaction.
        if (patch.nextAction === null) patch.nextActionDueAt = null;
        return (await api.patch(base, patch)).data;
      }
      return (
        await api.post<{ reused?: boolean }>(`${base}/action`, {
          intent: action,
          nextAction:
            nextAction.trim() ||
            `${action === 'pursuit' ? 'Pursue' : 'Review'}: ${title}`.slice(0, 500),
          ...(owner ? { ownerUserId: owner } : {}),
          ...(dueDate ? { nextActionDueAt: `${dueDate}T12:00:00.000Z` } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        })
      ).data;
    },
    onSuccess: async (result, action) => {
      setForm(null);
      await refreshOpportunityQueries(cache);
      const reused = (result as { reused?: boolean } | undefined)?.reused;
      toast.success(
        reused
          ? 'Existing task kept with its owner and follow-up date.'
          : action === 'pass'
            ? 'Passed. You can restore this item here or in Tracking.'
            : action === 'watch'
              ? 'Watching. Find this opportunity in Tracking.'
              : action === 'save'
                ? 'Saved. Find this opportunity in Tracking.'
                : action === 'plan'
                  ? 'Team plan updated.'
                  : action === 'restore'
                    ? 'Opportunity restored.'
                    : 'Next action recorded.',
      );
    },
    onError: (error) =>
      toast.error(
        (error as { response?: { data?: { message?: string } } }).response?.data?.message ??
          'The action could not be saved. Please try again.',
      ),
  });

  const openForm = (kind: 'review' | 'pursuit' | 'plan') => {
    setNextAction(
      kind === 'plan'
        ? (existingNextAction ?? '')
        : `${kind === 'pursuit' ? pursuitLabel : 'Review'}: ${title}`.slice(0, 500),
    );
    setDueDate(kind === 'plan' ? (existingDueAt?.slice(0, 10) ?? '') : '');
    setOwner(existingOwner ?? '');
    setNotes(kind === 'plan' ? (existingNotes ?? '') : '');
    setInitial({
      owner: existingOwner ?? '',
      notes: existingNotes ?? '',
      nextAction: existingNextAction ?? '',
      dueDate: existingDueAt?.slice(0, 10) ?? '',
    });
    setForm(kind);
  };

  if (!clientId)
    return (
      <FovCard title="Save for a client">
        <p className="fov-muted">
          Browse freely. Choose a client to check the fit and keep your team's work together.
        </p>
        <label className="fov-stack">
          <span>Client</span>
          <select
            className="capiro-input"
            value={selectedClient}
            onChange={(event) => setSelectedClient(event.target.value)}
          >
            <option value="">Select a client</option>
            {(clients.data ?? [])
              .filter((client) => client.status !== 'archived')
              .map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
          </select>
        </label>
        {clients.isError ? (
          <FovAlert
            tone="error"
            message="Clients could not be loaded"
            description="Try loading your client list again."
            action={<CapiroButton onClick={() => void clients.refetch()}>Retry</CapiroButton>}
          />
        ) : null}
        <CapiroButton
          disabled={!selectedClient}
          onClick={() =>
            url.set({
              clientId: selectedClient,
              ...(url.get('detail')
                ? {
                    detail: encodeOpportunityRef({
                      source,
                      sourceRecordId,
                      clientId: selectedClient,
                    }),
                  }
                : {}),
            })
          }
        >
          Use this client
        </CapiroButton>
      </FovCard>
    );

  return (
    <>
      <FovCard title="Next action" testId="fo-client-actions">
        <div className="fov-row" style={{ flexWrap: 'wrap' }}>
          {!saved ? (
            <CapiroButton loading={mutate.isPending} onClick={() => mutate.mutate('save')}>
              Save
            </CapiroButton>
          ) : null}
          {isActive && !pursuing && !terminal ? (
            <CapiroButton loading={mutate.isPending} onClick={() => mutate.mutate('watch')}>
              Watch
            </CapiroButton>
          ) : null}
          {isActive && canPursue && !pursuing && !terminal ? (
            <CapiroButton onClick={() => openForm('pursuit')}>{pursuitLabel}</CapiroButton>
          ) : null}
          <CapiroButton onClick={() => openForm('review')}>Create review task</CapiroButton>
          {workflowStatus === 'dismissed' ? (
            <CapiroButton loading={mutate.isPending} onClick={() => mutate.mutate('restore')}>
              Restore
            </CapiroButton>
          ) : !terminal ? (
            <CapiroButton loading={mutate.isPending} onClick={() => mutate.mutate('pass')}>
              Pass
            </CapiroButton>
          ) : null}
          {workflowStatus && workflowStatus !== 'suggested' ? (
            <CapiroButton onClick={() => openForm('plan')}>Edit team plan</CapiroButton>
          ) : null}
        </div>
        {source === 'agency_forecast' ? (
          <p className="fov-micro">
            Watch this agency plan and set your own follow-up date. It is not open for applications.
          </p>
        ) : null}
      </FovCard>
      <FovModal
        open={form != null}
        title={
          form === 'plan'
            ? 'Edit team plan'
            : form === 'pursuit'
              ? pursuitLabel === 'Pursue'
                ? 'Start pursuit'
                : pursuitLabel
              : 'Review opportunity'
        }
        onCancel={() => setForm(null)}
        onOk={() => {
          if (form) mutate.mutate(form);
        }}
        okText="Save"
        okLoading={mutate.isPending}
        okDisabled={
          !form ||
          (form === 'plan'
            ? (!nextAction.trim() && Boolean(dueDate)) ||
              (owner === initial.owner &&
                notes.trim() === initial.notes.trim() &&
                nextAction.trim() === initial.nextAction.trim() &&
                dueDate === initial.dueDate)
            : !nextAction.trim())
        }
      >
        <div className="fov-stack">
          <>
            <label className="fov-stack">
              <span>Next action</span>
              <input
                className="capiro-input"
                maxLength={500}
                value={nextAction}
                onChange={(event) => {
                  setNextAction(event.target.value);
                  if (form === 'plan' && !event.target.value.trim()) setDueDate('');
                }}
              />
            </label>
            <label className="fov-stack">
              <span>Owner</span>
              <select
                className="capiro-input"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
              >
                <option value="">Unassigned</option>
                {owner && !(members.data ?? []).some((member) => member.id === owner) ? (
                  <option value={owner}>Current owner</option>
                ) : null}
                {(members.data ?? []).map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name ?? member.email}
                  </option>
                ))}
              </select>
            </label>
            {members.isError ? (
              <span className="fov-muted">
                Owners could not be loaded. Your current selection will be preserved unless you
                change it.
              </span>
            ) : null}
            <label className="fov-stack">
              <span>Follow-up date (optional)</span>
              <input
                className="capiro-input"
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </label>
            <span className="fov-micro">
              This is your team's follow-up date, separate from the opportunity's deadline.
            </span>
          </>
          <label className="fov-stack">
            <span>Notes</span>
            <textarea
              className="capiro-input"
              rows={4}
              maxLength={form === 'plan' ? 4000 : 2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
        </div>
      </FovModal>
    </>
  );
}

/** Resolve an existing assignment without mistaking a missing name for no owner. */
export function OpportunityOwnerLabel({ ownerUserId }: { ownerUserId: string | null | undefined }) {
  const api = useApi();
  const members = useQuery<Member[]>({
    queryKey: ['tenant-members'],
    queryFn: async () => (await api.get<Member[]>('/api/tenant-members')).data,
    enabled: Boolean(ownerUserId),
    staleTime: 60_000,
  });
  if (ownerUserId === undefined) return <>Owner unavailable</>;
  if (ownerUserId === null) return <>Unassigned</>;
  const member = members.data?.find((entry) => entry.id === ownerUserId);
  return <>{member?.name ?? member?.email ?? 'Assigned team member'}</>;
}
