import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Empty, Modal, Select, Space, Typography, message } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { getEngagementContacts, linkProgramElementPersonToCrm } from './api.js';
import type { EngagementContactListItem } from './types.js';

const { Text } = Typography;

export interface LinkCrmContactModalProps {
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

/**
 * Picks a real CRM (engagement) contact and links it to an acquisition-personnel
 * record. Replaces the previous hardcoded placeholder contact id, which always
 * failed the backend's ownership check.
 */
export function LinkCrmContactModal({
  open,
  personId,
  personName,
  peCode,
  onClose,
  onLinked,
}: LinkCrmContactModalProps) {
  const api = useApi();
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
      message.success('Linked to CRM contact');
      queryClient.invalidateQueries({ queryKey: ['engagement-contacts'] }).catch(() => undefined);
      onLinked?.();
      handleClose();
    },
    onError: () => {
      message.error('Unable to link CRM contact. Please try again.');
    },
  });

  function handleClose() {
    setSearch('');
    setSelectedContactId(null);
    onClose();
  }

  const contacts = contactsQuery.data ?? [];
  const options = contacts.map((contact) => ({ value: contact.id, label: contactLabel(contact) }));
  const showEmpty =
    open && !contactsQuery.isLoading && contacts.length === 0 && search.trim().length === 0;

  return (
    <Modal
      title="Link to CRM contact"
      open={open}
      onCancel={handleClose}
      okText="Link contact"
      okButtonProps={{ disabled: !selectedContactId, loading: linkMutation.isPending }}
      onOk={() => {
        if (selectedContactId) linkMutation.mutate(selectedContactId);
      }}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {personName ? (
          <Text type="secondary">
            Link <Text strong>{personName}</Text> to a contact in your CRM.
          </Text>
        ) : null}
        {showEmpty ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No CRM contacts yet. Add contacts in the Engagement workspace first."
          />
        ) : (
          <Select
            showSearch
            autoFocus
            style={{ width: '100%' }}
            placeholder="Search contacts by name, email, or organization"
            loading={contactsQuery.isLoading}
            filterOption={false}
            notFoundContent={contactsQuery.isLoading ? 'Searching…' : 'No matching contacts'}
            onSearch={setSearch}
            onChange={(value: string) => setSelectedContactId(value)}
            value={selectedContactId ?? undefined}
            options={options}
          />
        )}
      </Space>
    </Modal>
  );
}
