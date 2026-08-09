import { useEffect, useState } from 'react';
import { DeleteOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';
import { App as AntApp, Button, Form, Input, InputNumber, Modal, Select, Skeleton, Space } from 'antd';
import { CAPABILITY_TAG_SUGGESTIONS, SECTOR_LABELS, SECTOR_TAGS } from '@capiro/shared';
import { useApi } from '../../lib/use-api.js';
import type { ClientAttachment } from './clientTypes.js';
import { errorMessage, formatMoney, type CapabilityRecord } from './client-profile-crm-model.js';
import { ClientCapabilityDrawer } from './ClientCapabilityDrawer.js';

export function ClientProfileCapabilities({
  clientId,
  capabilities,
  documents,
  loading,
  canManage,
  onRefresh,
  uploadFiles,
  deleteDocument,
  createRequested = false,
  onCreateRequestHandled,
}: {
  clientId: string;
  capabilities: CapabilityRecord[];
  documents: ClientAttachment[];
  loading: boolean;
  canManage: boolean;
  onRefresh: () => void;
  uploadFiles: (files: File[], source?: string) => Promise<void>;
  deleteDocument: (document: ClientAttachment) => Promise<unknown>;
  createRequested?: boolean;
  onCreateRequestHandled?: () => void;
}) {
  const api = useApi();
  const { message, modal } = AntApp.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = capabilities.find((row) => row.id === selectedId) ?? null;

  useEffect(() => {
    if (!createRequested) return;
    setCreateOpen(true);
    onCreateRequestHandled?.();
  }, [createRequested, onCreateRequestHandled]);

  const create = useMutation({
    mutationFn: async (data: Record<string, unknown>) =>
      (await api.post<CapabilityRecord>(`/api/clients/${clientId}/capabilities`, data)).data,
    onSuccess: (created) => {
      message.success('Capability added');
      setCreateOpen(false);
      setSelectedId(created.id);
      onRefresh();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/api/clients/${clientId}/capabilities/${id}`)).data,
    onSuccess: () => {
      message.success('Capability removed');
      setSelectedId(null);
      onRefresh();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  return (
    <section className="crm-section-shell">
      <div className="crm-section-head">
        <div>
          <h2>Capabilities</h2>
          <p>Products and programs, with policy context and advocacy history.</p>
        </div>
        {canManage ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            Add capability
          </Button>
        ) : null}
      </div>

      <div className="crm-card">
        {loading ? (
          <div className="crm-card__body"><Skeleton active paragraph={{ rows: 5 }} /></div>
        ) : capabilities.length ? (
          <div className="crm-related-list">
            <div className="crm-related-list__head">
              <span>Name</span><span>Type</span><span>Readiness</span><span>Funding ask</span><span />
            </div>
            {capabilities.map((capability) => (
              <button
                key={capability.id}
                type="button"
                className="crm-related-list__row"
                onClick={() => setSelectedId(capability.id)}
              >
                <span>
                  <b>{capability.name}</b>
                  <small>{capability.description ?? 'No description yet.'}</small>
                </span>
                <span>{titleCase(capability.type || 'capability')}</span>
                <span>
                  {capability.trl != null ? `TRL ${capability.trl}` : '—'}
                  {capability.mrl != null ? ` · MRL ${capability.mrl}` : ''}
                </span>
                <span>{capability.fundingAsk != null ? formatMoney(capability.fundingAsk) : '—'}</span>
                <span onClick={(event) => event.stopPropagation()}>
                  {canManage ? (
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`Remove ${capability.name}`}
                      onClick={() =>
                        modal.confirm({
                          title: `Remove ${capability.name}?`,
                          content: 'Advocacy history is retained but will no longer be linked to this capability.',
                          okText: 'Remove',
                          okButtonProps: { danger: true },
                          onOk: () => remove.mutateAsync(capability.id),
                        })
                      }
                    />
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="crm-empty-state">
            <FolderOpenOutlined />
            <h3>No capabilities yet</h3>
            <p>Add a capability to connect the client to budget lines, policy issues and advocacy history.</p>
            {canManage ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                Add capability
              </Button>
            ) : null}
          </div>
        )}
      </div>

      <CapabilityCreateModal
        open={createOpen}
        submitting={create.isPending}
        onCancel={() => setCreateOpen(false)}
        onSubmit={(values) => create.mutate(values)}
      />
      <ClientCapabilityDrawer
        clientId={clientId}
        capability={selected}
        documents={documents}
        canManage={canManage}
        onClose={() => setSelectedId(null)}
        onUpdated={onRefresh}
        onUpload={uploadFiles}
        onDeleteDocument={deleteDocument}
      />
    </section>
  );
}

function CapabilityCreateModal({
  open,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  return (
    <Modal
      title="Add capability"
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      okText="Add capability"
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) =>
          onSubmit({ ...values, tags: values.tags ?? [], trl: values.trl ?? null, mrl: values.mrl ?? null })
        }
      >
        <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="type" label="Type" initialValue="product">
          <Select options={['product', 'service', 'platform', 'technology'].map((value) => ({ label: titleCase(value), value }))} />
        </Form.Item>
        <Form.Item name="sector" label="Sector">
          <Select allowClear options={SECTOR_TAGS.map((value) => ({ value, label: SECTOR_LABELS[value] }))} />
        </Form.Item>
        <Form.Item name="tags" label="Tags">
          <Select mode="tags" tokenSeparators={[',']} options={CAPABILITY_TAG_SUGGESTIONS.map((value) => ({ value, label: value }))} />
        </Form.Item>
        <Form.Item name="description" label="Description"><Input.TextArea rows={3} /></Form.Item>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="trl" label="TRL"><InputNumber min={1} max={9} /></Form.Item>
          <Form.Item name="mrl" label="MRL"><InputNumber min={1} max={10} /></Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}

function titleCase(value: string): string {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
