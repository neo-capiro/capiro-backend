/**
 * Link to CRM contact — native vNext port of
 * `pages/program-element/LinkCrmContactModal.tsx`. Picks a real CRM
 * (engagement) contact and links it to an acquisition-personnel record. Same
 * endpoints (`getEngagementContacts` search + `linkProgramElementPersonToCrm`),
 * same query keys, same copy.
 *
 * Deliberate deviation: antd's searchable Select becomes a search input + a
 * results list (the vNext field kit has no combobox primitive) — the server
 * -side search contract is unchanged.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import {
  getEngagementContacts,
  linkProgramElementPersonToCrm,
} from '../../../../pages/program-element/api.js';
import type { EngagementContactListItem } from '../../../../pages/program-element/types.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroInput } from '../../../components/fields/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import { PeFbEmpty } from './pe-fallback-ui.js';

export interface PeLinkCrmContactModalVNextProps {
  open: boolean;
  personId: string | null;
  personName?: string | null;
  /** Exact PE code from the watch page (required by CRM link gate). */
  peCode: string;
  onClose: () => void;
  onLinked?: () => void;
}

function contactLabel(contact: EngagementContactListItem): string {
  const primary = contact.fullName?.trim() || contact.email?.trim() || 'Unnamed contact';
  const secondary = [contact.title, contact.organization].filter(Boolean).join(', ');
  return secondary ? `${primary} — ${secondary}` : primary;
}

export function PeLinkCrmContactModalVNext({
  open,
  personId,
  personName,
  peCode,
  onClose,
  onLinked,
}: PeLinkCrmContactModalVNextProps) {
  const api = useApi();
  const toast = useCapiroToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

  const contactsQuery = useQuery({
    queryKey: ['engagement-contacts', search.trim()],
    queryFn: () => getEngagementContacts(api, { q: search.trim() || undefined, limit: 50 }),
    enabled: open,
    staleTime: 60_000,
  });

  const linkMutation = useMutation({
    mutationFn: (contactId: string) => {
      if (!personId) throw new Error('No person selected');
      return linkProgramElementPersonToCrm(api, personId, contactId, peCode);
    },
    onSuccess: () => {
      toast.success('Linked to CRM contact');
      queryClient.invalidateQueries({ queryKey: ['engagement-contacts'] }).catch(() => undefined);
      onLinked?.();
      handleClose();
    },
    onError: () => {
      toast.error('Unable to link CRM contact. Please try again.');
    },
  });

  function handleClose() {
    setSearch('');
    setSelectedContactId(null);
    onClose();
  }

  const contacts = contactsQuery.data ?? [];
  const showEmpty =
    open && !contactsQuery.isLoading && contacts.length === 0 && search.trim().length === 0;

  if (!open) return null;

  return (
    <CapiroModal open={open} title="Link to CRM contact" onClose={handleClose}>
      <div className="pe-fb-form">
        {personName ? (
          <span className="pe-fb-muted">
            Link <strong>{personName}</strong> to a contact in your CRM.
          </span>
        ) : null}
        {showEmpty ? (
          <PeFbEmpty description="No CRM contacts yet. Add contacts in the Engagement workspace first." />
        ) : (
          <>
            <CapiroInput
              label="Search contacts"
              placeholder="Search contacts by name, email, or organization"
              value={search}
              autoFocus
              onChange={(event) => {
                setSearch(event.target.value);
                setSelectedContactId(null);
              }}
            />
            <div className="pe-fb-contact-results" role="listbox" aria-label="Matching contacts">
              {contactsQuery.isLoading ? (
                <span className="pe-fb-muted">Searching…</span>
              ) : contacts.length === 0 ? (
                <span className="pe-fb-muted">No matching contacts</span>
              ) : (
                contacts.map((contact) => (
                  <button
                    key={contact.id}
                    type="button"
                    role="option"
                    aria-selected={selectedContactId === contact.id}
                    className={`pe-fb-contact-option${selectedContactId === contact.id ? ' selected' : ''}`}
                    onClick={() => setSelectedContactId(contact.id)}
                  >
                    {contactLabel(contact)}
                  </button>
                ))
              )}
            </div>
          </>
        )}
        <div className="pe-fb-modal-footer">
          <CapiroButton onClick={handleClose}>Cancel</CapiroButton>
          <CapiroButton
            variant="primary"
            disabled={!selectedContactId}
            loading={linkMutation.isPending}
            onClick={() => {
              if (selectedContactId) linkMutation.mutate(selectedContactId);
            }}
          >
            Link contact
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}
