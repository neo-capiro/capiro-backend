import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { Combobox, SegmentedControl, type ComboboxOption } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { DashboardIcon } from '../../components/untitledui/dashboard-icons.js';

// Same behavior as the legacy apps/web/src/components/QuickLog.tsx, verbatim
// — the two POST targets, the >= 2 character member gate, the 4000-character
// cap, the five invalidated query keys, the "Note logged" success message and
// the destination copy. Only the chrome is new (vnext modal/combobox/segmented
// control instead of antd Modal/Select/Segmented).

type Target = 'client' | 'member';
const NOTE_MAX = 4000;

interface ClientOption {
  id: string;
  name: string;
  status?: string;
}

interface DirectoryContactsResponse {
  contacts: Array<{
    id: string;
    fullName: string;
    office?: string | null;
    title?: string | null;
    state?: string | null;
  }>;
}

export function QuickNote() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target>('client');
  const [clientQuery, setClientQuery] = useState('');
  const [clientId, setClientId] = useState<string | undefined>();
  const [clientLabel, setClientLabel] = useState<string | undefined>();
  const [memberQuery, setMemberQuery] = useState('');
  const [memberId, setMemberId] = useState<string | undefined>();
  const [memberName, setMemberName] = useState<string | undefined>();
  const [note, setNote] = useState('');

  const reset = () => {
    setTarget('client');
    setClientQuery('');
    setClientId(undefined);
    setClientLabel(undefined);
    setMemberQuery('');
    setMemberId(undefined);
    setMemberName(undefined);
    setNote('');
  };

  const clients = useQuery<ClientOption[]>({
    enabled: open,
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientOption[]>('/api/clients')).data,
    staleTime: 60_000,
  });

  const memberSearch = memberQuery.trim();
  const members = useQuery<DirectoryContactsResponse>({
    enabled: open && target === 'member' && memberSearch.length >= 2,
    queryKey: ['quicklog-directory', memberSearch],
    queryFn: async () =>
      (
        await api.get<DirectoryContactsResponse>('/api/directory/contacts', {
          params: { q: memberSearch, pageSize: 20 },
        })
      ).data,
  });

  const clientOptions = useMemo<ComboboxOption[]>(() => {
    const q = clientQuery.trim().toLowerCase();
    return (clients.data ?? [])
      .filter((c) => c.status !== 'archived' && c.name?.trim())
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: c.name }));
  }, [clients.data, clientQuery]);

  const memberOptions = useMemo<ComboboxOption[]>(
    () =>
      (members.data?.contacts ?? []).map((c) => ({
        value: c.id,
        label: c.fullName,
        meta: c.office ?? undefined,
      })),
    [members.data],
  );

  const memberEmptyMessage = memberSearch.length < 2 ? 'Type at least 2 characters' : 'No members found';
  const canSave = note.trim().length > 0 && (target === 'client' ? !!clientId : !!memberId);

  const save = useMutation({
    mutationFn: async () => {
      const body = note.trim();
      if (target === 'client') {
        if (!clientId) throw new Error('Select a client');
        return (await api.post(`/api/clients/${clientId}/notes`, { body })).data;
      }
      if (!memberId) throw new Error('Select a member');
      return (
        await api.post(`/api/directory/contacts/${encodeURIComponent(memberId)}/notes`, {
          body,
          directoryContactName: memberName,
        })
      ).data;
    },
    onSuccess: () => {
      toast.success('Note logged');
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['client'] });
      qc.invalidateQueries({ queryKey: ['client-attachments'] });
      qc.invalidateQueries({ queryKey: ['directory-contact-notes'] });
      qc.invalidateQueries({ queryKey: ['outreach-pool-member-notes'] });
      setOpen(false);
      reset();
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        (err as Error)?.message;
      toast.error(typeof msg === 'string' ? msg : 'Could not log note');
    },
  });

  return (
    <>
      <CapiroButton
        variant="secondary"
        size="standard"
        className="capiro-vnext-quicknote"
        leadingIcon={<DashboardIcon name="Edit01" size={18} />}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="capiro-vnext-quicknote__label">Quick Note</span>
      </CapiroButton>

      <CapiroModal
        open={open}
        title="Quick Note"
        onClose={() => {
          if (save.isPending) return;
          setOpen(false);
          reset();
        }}
      >
        <p className="capiro-vnext-quicknote__desc">
          Jot a note onto a client or directory member without navigating there. Timestamped and
          attributed to you.
        </p>

        <div className="capiro-vnext-quicknote__body">
          <SegmentedControl
            ariaLabel="Note target"
            value={target}
            onChange={setTarget}
            options={[
              { value: 'client', label: 'Client', icon: <DashboardIcon name="Briefcase01" size={16} /> },
              { value: 'member', label: 'Member', icon: <DashboardIcon name="Users01" size={16} /> },
            ]}
          />

          {target === 'client' ? (
            <Combobox
              value={clientId}
              valueLabel={clientLabel}
              onChange={(option) => {
                setClientId(option.value);
                setClientLabel(option.label);
              }}
              options={clientOptions}
              loading={clients.isLoading}
              placeholder="Select a client…"
              searchValue={clientQuery}
              onSearchChange={setClientQuery}
              searchPlaceholder="Search clients…"
              emptyMessage="No clients match that search"
              leadingIcon={<DashboardIcon name="Briefcase01" size={16} />}
            />
          ) : (
            <Combobox
              value={memberId}
              valueLabel={memberName}
              onChange={(option) => {
                setMemberId(option.value);
                setMemberName(option.label);
              }}
              options={memberSearch.length < 2 ? [] : memberOptions}
              loading={members.isFetching && memberSearch.length >= 2}
              placeholder="Search members by name…"
              searchValue={memberQuery}
              onSearchChange={setMemberQuery}
              searchPlaceholder="Search members…"
              emptyMessage={memberEmptyMessage}
              leadingIcon={<DashboardIcon name="Users01" size={16} />}
            />
          )}

          <div className="capiro-field">
            <label className="capiro-field__label" htmlFor="quicknote-note">Note</label>
            <textarea
              id="quicknote-note"
              className="capiro-textarea capiro-vnext-quicknote__note"
              maxLength={NOTE_MAX}
              placeholder="Write your note…"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-describedby="quicknote-note-desc"
            />
            <div className="capiro-vnext-quicknote__field-foot">
              <span id="quicknote-note-desc" className="capiro-field__help">
                {target === 'client'
                  ? 'Saved to the client profile → Documents → Notes.'
                  : 'Saved to the member directory profile → Overview → Notes.'}
              </span>
              <span className="capiro-vnext-quicknote__charcount" data-near-limit={note.length > NOTE_MAX - 200 || undefined}>
                {note.length} / {NOTE_MAX}
              </span>
            </div>
          </div>
        </div>

        <div className="capiro-vnext-quicknote__foot">
          <CapiroButton
            variant="secondary"
            size="standard"
            onClick={() => {
              setOpen(false);
              reset();
            }}
            disabled={save.isPending}
          >
            Cancel
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="standard"
            disabled={!canSave}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Log note
          </CapiroButton>
        </div>
      </CapiroModal>
    </>
  );
}
