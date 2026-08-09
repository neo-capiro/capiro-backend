import { useEffect, useState } from 'react';
import { DeleteOutlined, DownloadOutlined, EditOutlined, FolderOpenOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Drawer, Empty, Form, Input, InputNumber, Segmented, Select, Skeleton, Space, Typography, Upload } from 'antd';
import { SECTOR_LABELS, SECTOR_TAGS } from '@capiro/shared';
import { useApi } from '../../lib/use-api.js';
import type { ClientAttachment } from './clientTypes.js';
import { cleanObject, errorMessage, formatDate, type CapabilityRecord, type SubmissionHistory } from './client-profile-crm-model.js';
import { ClientCapabilityHistoryModal } from './ClientCapabilityHistoryModal.js';

export function ClientCapabilityDrawer({
  clientId,
  capability,
  documents,
  canManage,
  onClose,
  onUpdated,
  onUpload,
  onDeleteDocument,
}: {
  clientId: string;
  capability: CapabilityRecord | null;
  documents: ClientAttachment[];
  canManage: boolean;
  onClose: () => void;
  onUpdated: () => void;
  onUpload: (files: File[], source?: string) => Promise<void>;
  onDeleteDocument: (document: ClientAttachment) => Promise<unknown>;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [tab, setTab] = useState<'overview' | 'policy' | 'history' | 'documents'>('overview');
  const [historyModal, setHistoryModal] = useState<{ open: boolean; row: SubmissionHistory | null }>({
    open: false,
    row: null,
  });

  useEffect(() => {
    if (!capability) return;
    form.resetFields();
    form.setFieldsValue({ ...capability, fundingAsk: capability.fundingAsk ?? undefined });
    setTab('overview');
  }, [capability, form]);

  const history = useQuery<SubmissionHistory[]>({
    queryKey: ['capability-history', clientId, capability?.id],
    queryFn: async () =>
      (await api.get<SubmissionHistory[]>(`/api/clients/${clientId}/capabilities/${capability!.id}/history`)).data,
    enabled: Boolean(capability),
  });

  const saveCapability = useMutation({
    mutationFn: async (values: Record<string, unknown>) =>
      (await api.patch(`/api/clients/${clientId}/capabilities/${capability!.id}`, cleanObject(values))).data,
    onSuccess: () => {
      message.success('Capability updated');
      onUpdated();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const saveHistory = useMutation({
    mutationFn: async ({ row, values }: { row: SubmissionHistory | null; values: Record<string, unknown> }) =>
      row
        ? (await api.patch(`/api/clients/${clientId}/history/${row.id}`, cleanObject(values))).data
        : (await api.post(`/api/clients/${clientId}/capabilities/${capability!.id}/history`, cleanObject(values))).data,
    onSuccess: () => {
      message.success(historyModal.row ? 'History updated' : 'History added');
      setHistoryModal({ open: false, row: null });
      void qc.invalidateQueries({ queryKey: ['capability-history', clientId, capability?.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const deleteHistory = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/clients/${clientId}/history/${id}`)).data,
    onSuccess: () => {
      message.success('History entry removed');
      void qc.invalidateQueries({ queryKey: ['capability-history', clientId, capability?.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const capabilityDocs = documents.filter((document) => document.source === `capability:${capability?.id}`);

  return (
    <>
      <Drawer
        title={capability?.name ?? 'Capability'}
        width={760}
        open={Boolean(capability)}
        onClose={onClose}
        extra={canManage && (tab === 'overview' || tab === 'policy') ? (
          <Button type="primary" loading={saveCapability.isPending} onClick={() => form.submit()}>Save</Button>
        ) : null}
      >
        <Segmented
          block
          value={tab}
          options={[
            { label: 'Overview', value: 'overview' },
            { label: 'Budget & policy', value: 'policy' },
            { label: 'Advocacy history', value: 'history' },
            { label: 'Documents', value: 'documents' },
          ]}
          onChange={(value) => setTab(value as typeof tab)}
          style={{ marginBottom: 18 }}
        />

        <Form form={form} layout="vertical" disabled={!canManage} onFinish={(values) => saveCapability.mutate(values)}>
          {tab === 'overview' ? (
            <>
              <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
              <Space style={{ display: 'flex' }} align="start" wrap>
                <Form.Item name="type" label="Type">
                  <Select style={{ width: 150 }} options={['product', 'service', 'platform', 'technology'].map((value) => ({ label: titleCase(value), value }))} />
                </Form.Item>
                <Form.Item name="sector" label="Sector">
                  <Select allowClear style={{ width: 190 }} options={SECTOR_TAGS.map((value) => ({ value, label: SECTOR_LABELS[value] }))} />
                </Form.Item>
                <Form.Item name="trl" label="TRL"><InputNumber min={1} max={9} /></Form.Item>
                <Form.Item name="mrl" label="MRL"><InputNumber min={1} max={10} /></Form.Item>
              </Space>
              <Form.Item name="tags" label="Tags"><Select mode="tags" tokenSeparators={[',']} /></Form.Item>
              <Form.Item name="description" label="Description"><Input.TextArea rows={4} /></Form.Item>
              <Form.Item name="notes" label="Internal notes"><Input.TextArea rows={3} /></Form.Item>
            </>
          ) : null}
          {tab === 'policy' ? (
            <>
              <Form.Item name="peNumbers" label="Program Element numbers"><Select mode="tags" tokenSeparators={[',', ' ']} /></Form.Item>
              <Form.Item name="keywords" label="Match keywords"><Select mode="tags" tokenSeparators={[',']} /></Form.Item>
              <Space style={{ display: 'flex' }} align="start" wrap>
                <Form.Item name="appropriationAccount" label="Appropriation account"><Input /></Form.Item>
                <Form.Item name="serviceBranch" label="Service branch"><Input /></Form.Item>
                <Form.Item name="targetSubcommittee" label="Target subcommittee"><Input /></Form.Item>
              </Space>
              <Space style={{ display: 'flex' }} align="start" wrap>
                <Form.Item name="fundingAsk" label="Funding ask"><InputNumber min={0} prefix="$" style={{ width: 220 }} /></Form.Item>
                <Form.Item name="fundingAskLabel" label="Funding ask label"><Input /></Form.Item>
              </Space>
              <Form.Item name="justification" label="Justification"><Input.TextArea rows={4} /></Form.Item>
              <Form.Item name="districtNexus" label="District nexus"><Input.TextArea rows={3} /></Form.Item>
              <Form.Item name="existingContracts" label="Existing contracts"><Input.TextArea rows={3} /></Form.Item>
            </>
          ) : null}
        </Form>

        {tab === 'history' ? (
          <div>
            <div className="crm-drawer-section-head">
              <div>
                <h3>Advocacy & funding history</h3>
                <p>Public evidence may support an entry; attribution and outcomes stay human-reviewable.</p>
              </div>
              {canManage ? (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setHistoryModal({ open: true, row: null })}>Add entry</Button>
              ) : null}
            </div>
            {history.isLoading ? (
              <Skeleton active paragraph={{ rows: 4 }} />
            ) : history.data?.length ? (
              <div className="crm-history-list">
                {history.data.map((entry) => (
                  <article key={entry.id} className="crm-history-row">
                    <span className="crm-history-year">{entry.fiscalYear}</span>
                    <span className={`crm-history-dot is-${entry.outcomeType}`} />
                    <span className="crm-history-content">
                      <b>{entry.title}</b>
                      {entry.meta ? <small>{entry.meta}</small> : null}
                      {entry.outcome ? <p>{entry.outcome}</p> : null}
                      {entry.notes ? <p className="muted">{entry.notes}</p> : null}
                    </span>
                    {canManage ? (
                      <span>
                        <Button type="text" icon={<EditOutlined />} onClick={() => setHistoryModal({ open: true, row: entry })} />
                        <Button
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() =>
                            modal.confirm({
                              title: 'Remove history entry?',
                              okText: 'Remove',
                              okButtonProps: { danger: true },
                              onOk: () => deleteHistory.mutateAsync(entry.id),
                            })
                          }
                        />
                      </span>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : <Empty description="No advocacy history yet." />}
          </div>
        ) : null}

        {tab === 'documents' ? (
          <div>
            {canManage ? (
              <Upload
                multiple
                showUploadList={false}
                beforeUpload={(file, fileList) => {
                  if (file.uid === fileList[0]?.uid) {
                    void onUpload(fileList.map((item) => item as File), `capability:${capability!.id}`)
                      .then(() => message.success('Capability document added'))
                      .catch((error) => message.error(errorMessage(error)));
                  }
                  return false;
                }}
              >
                <Button icon={<UploadOutlined />}>Upload document</Button>
              </Upload>
            ) : null}
            <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
              Capability documents also appear in Files; this view is only the capability filter.
            </Typography.Paragraph>
            {capabilityDocs.length ? capabilityDocs.map((document) => (
              <div key={document.id} className="crm-file-row">
                <span className="crm-file-icon"><FolderOpenOutlined /></span>
                <span className="crm-file-info"><b>{document.fileName}</b><small>{formatDate(document.createdAt)}</small></span>
                <span />
                <span className="crm-file-actions">
                  {document.downloadUrl ? <Button type="text" icon={<DownloadOutlined />} href={document.downloadUrl} target="_blank" /> : null}
                  {canManage ? <Button type="text" danger icon={<DeleteOutlined />} onClick={() => void onDeleteDocument(document)} /> : null}
                </span>
              </div>
            )) : <Empty description="No documents for this capability." />}
          </div>
        ) : null}
      </Drawer>

      <ClientCapabilityHistoryModal
        open={historyModal.open}
        row={historyModal.row}
        submitting={saveHistory.isPending}
        onCancel={() => setHistoryModal({ open: false, row: null })}
        onSubmit={(values) => saveHistory.mutate({ row: historyModal.row, values })}
      />
    </>
  );
}

function titleCase(value: string): string {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
