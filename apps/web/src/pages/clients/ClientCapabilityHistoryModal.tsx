import { useEffect } from 'react';
import { Form, Input, Modal, Select, Space } from 'antd';
import type { SubmissionHistory } from './client-profile-crm-model.js';

export function ClientCapabilityHistoryModal({
  open,
  row,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  row: SubmissionHistory | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      fiscalYear: row?.fiscalYear,
      title: row?.title,
      meta: row?.meta,
      outcomeType: row?.outcomeType ?? 'in_progress',
      outcome: row?.outcome,
      notes: row?.notes,
    });
  }, [form, open, row]);
  return (
    <Modal
      title={row ? 'Edit advocacy history' : 'Add advocacy history'}
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="fiscalYear" label="Fiscal year" rules={[{ required: true }]}><Input placeholder="FY27" /></Form.Item>
          <Form.Item name="outcomeType" label="Status" initialValue="in_progress">
            <Select options={[
              { label: 'In progress', value: 'in_progress' },
              { label: 'Success', value: 'success' },
              { label: 'Partial', value: 'partial' },
              { label: 'Failed', value: 'failed' },
            ]} />
          </Form.Item>
        </Space>
        <Form.Item name="title" label="Effort / submission" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="meta" label="Vehicle, committee or evidence"><Input placeholder="HAC-D · PE 0605053A · LDA Q2" /></Form.Item>
        <Form.Item name="outcome" label="Outcome"><Input.TextArea rows={3} /></Form.Item>
        <Form.Item name="notes" label="Internal notes"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Modal>
  );
}
