/**
 * vNext re-skin of pages/admin/ClientsPage.tsx — identical endpoints, query
 * keys (['clients','all'] with includeArchived), upload flow, and the
 * slot-limit (402) upsell into the Stripe portal. The create form reuses the
 * already-ported ClientFormDialogVNext (PR #1068), which has the same props
 * contract as the legacy ClientFormModal.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { CLIENT_SLOT_LIMIT_CODE } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { usePortal } from '../../../lib/billing.js';
import type { Client, ClientFormSubmit } from '../../../pages/clients/clientTypes.js';
import { ClientFormDialogVNext } from '../client-crm/ClientFormDialogVNext.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { SvPagination, useSvConfirm, useSvPagination } from './settings-ui.js';

export function VNextClientsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const portal = usePortal();
  const [open, setOpen] = useState(false);
  const { confirm, dialog } = useSvConfirm();

  // The admin management table is the one surface that intentionally shows
  // archived clients (note the Status column), so it opts in via
  // includeArchived. A distinct query key avoids colliding with the
  // active-only ['clients'] cache the rest of the app reads; invalidating
  // ['clients'] still prefix-matches and refreshes this table.
  const list = useQuery<Client[]>({
    queryKey: ['clients', 'all'],
    queryFn: async () =>
      (await api.get<Client[]>('/api/clients', { params: { includeArchived: true } })).data,
  });

  const create = useMutation({
    mutationFn: async (input: ClientFormSubmit) => {
      const created = (await api.post<Client>('/api/clients', input.payload)).data;
      if (input.logo) await uploadClientLogo(api, created.id, input.logo);
      for (const document of input.documents) {
        await uploadClientDocument(api, created.id, document);
      }
      return created;
    },
    onSuccess: () => {
      toast.success('Client added');
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (err) => {
      // Slot-limit (402) → offer a one-click upgrade into the Stripe portal
      // (where they can raise the quantity) instead of a dead-end error toast.
      const ax = err as AxiosError<{ code?: string; message?: string }>;
      const data = ax.response?.data;
      if (ax.response?.status === 402 && data?.code === CLIENT_SLOT_LIMIT_CODE) {
        confirm({
          title: 'Client slot limit reached',
          body:
            data.message ??
            "You've used all the client slots on your plan. Add more slots to create another client.",
          okText: 'Add client slots',
          onOk: () => portal.mutate(),
        });
        return;
      }
      toast.error((err as Error).message);
    },
  });

  const rows = list.data ?? [];
  const { pageRows, currentPage, pageCount, setPage } = useSvPagination(rows, 20);

  return (
    <div className="stv-stack">
      <div className="stv-row stv-row--end">
        <CapiroButton variant="primary" onClick={() => setOpen(true)}>
          Add client
        </CapiroButton>
      </div>

      {list.isLoading ? (
        <div className="stv-stack" aria-label="Loading clients">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : (
        <>
          <CapiroTableWrap>
            <CapiroTable>
              <CapiroTableHead>
                <tr>
                  <CapiroTableHeaderCell>Name</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Website</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Primary contact</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Status</CapiroTableHeaderCell>
                  <CapiroTableHeaderCell>Added</CapiroTableHeaderCell>
                </tr>
              </CapiroTableHead>
              <CapiroTableBody>
                {pageRows.map((record) => (
                  <tr key={record.id}>
                    <CapiroTableCell>{record.name}</CapiroTableCell>
                    <CapiroTableCell>
                      {record.website ? (
                        <a
                          href={
                            record.website.startsWith('http')
                              ? record.website
                              : `https://${record.website}`
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          {record.website}
                        </a>
                      ) : (
                        '-'
                      )}
                    </CapiroTableCell>
                    <CapiroTableCell>
                      {record.primaryContactName
                        ? `${record.primaryContactName}${
                            record.primaryContactEmail ? ` <${record.primaryContactEmail}>` : ''
                          }`
                        : '-'}
                    </CapiroTableCell>
                    <CapiroTableCell>{record.status}</CapiroTableCell>
                    <CapiroTableCell>{record.createdAt}</CapiroTableCell>
                  </tr>
                ))}
              </CapiroTableBody>
            </CapiroTable>
          </CapiroTableWrap>
          <SvPagination currentPage={currentPage} pageCount={pageCount} onPage={setPage} />
        </>
      )}

      <ClientFormDialogVNext
        open={open}
        mode="create"
        client={null}
        submitting={create.isPending}
        onCancel={() => setOpen(false)}
        onSubmit={(submission) => create.mutate(submission)}
      />

      {dialog}
    </div>
  );
}

async function uploadClientLogo(api: ReturnType<typeof useApi>, clientId: string, file: File) {
  const presigned = (
    await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
      `/api/clients/${clientId}/logo/upload-url`,
      { contentType: file.type, contentLength: file.size },
    )
  ).data;
  await uploadToS3(presigned, file);
  await api.post(`/api/clients/${clientId}/logo/confirm`, {
    s3Key: presigned.s3Key,
    contentType: file.type,
  });
}

async function uploadClientDocument(api: ReturnType<typeof useApi>, clientId: string, file: File) {
  const contentType = file.type || 'application/octet-stream';
  const presigned = (
    await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
      '/api/engagement/attachments/upload-url',
      { clientId, fileName: file.name, contentType, contentLength: file.size },
    )
  ).data;
  await uploadToS3(presigned, file);
  await api.post('/api/engagement/attachments/confirm', {
    clientId,
    fileName: file.name,
    contentType,
    s3Key: presigned.s3Key,
  });
}

async function uploadToS3(presigned: { url: string; fields: Record<string, string> }, file: File) {
  const form = new FormData();
  for (const [key, value] of Object.entries(presigned.fields)) form.append(key, value);
  form.append('file', file);
  const response = await fetch(presigned.url, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
}
