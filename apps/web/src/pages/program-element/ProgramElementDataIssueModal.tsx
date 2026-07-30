import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Form, Input, InputNumber, Modal, Select, Typography, message } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { createProgramElementDataIssue } from './api.js';

const { Text } = Typography;
const { TextArea } = Input;

const ISSUE_TYPES = [
  { value: 'value_incorrect', label: 'Value incorrect' },
  { value: 'missing_value', label: 'Missing value' },
  { value: 'wrong_source', label: 'Wrong source' },
  { value: 'wrong_stage_or_vehicle', label: 'Wrong stage or vehicle' },
  { value: 'wrong_pe_attribution', label: 'Wrong PE attribution' },
  { value: 'other', label: 'Other' },
] as const;

const FIELD_OPTIONS = [
  { value: 'request', label: 'Request' },
  { value: 'hascMark', label: 'HASC mark' },
  { value: 'sascMark', label: 'SASC mark' },
  { value: 'hacDMark', label: 'HAC-D mark' },
  { value: 'sacDMark', label: 'SAC-D mark' },
  { value: 'conference', label: 'Approps conference' },
  { value: 'ndaaConference', label: 'NDAA conference' },
  { value: 'enacted', label: 'Enacted' },
  { value: 'reprogrammed', label: 'Reprogrammed' },
  { value: 'executed', label: 'Executed' },
  { value: 'title', label: 'Title' },
  { value: 'description', label: 'Description' },
  { value: 'fundingSummary', label: 'Funding summary' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'personnel', label: 'Personnel' },
  { value: 'contractors', label: 'Contractors' },
  { value: 'other', label: 'Other / not sure' },
] as const;

export interface ProgramElementDataIssueModalProps {
  open: boolean;
  peCode: string;
  defaultFy?: number | null;
  defaultFieldName?: string | null;
  onClose: () => void;
  onCreated?: (issueId: string) => void;
}

export function ProgramElementDataIssueModal({
  open,
  peCode,
  defaultFy = null,
  defaultFieldName = null,
  onClose,
  onCreated,
}: ProgramElementDataIssueModalProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{
    issueType: string;
    description: string;
    fy?: number | null;
    fieldName?: string | null;
    suggestedSourceUrl?: string | null;
  }>();

  const mutation = useMutation({
    mutationFn: async () => {
      const values = await form.validateFields();
      return createProgramElementDataIssue(api, peCode, {
        issueType: values.issueType,
        description: values.description,
        fy: values.fy ?? null,
        fieldName: values.fieldName ?? null,
        suggestedSourceUrl: values.suggestedSourceUrl?.trim() || null,
      });
    },
    onSuccess: async (created) => {
      message.success(`Data issue reported (${created.id.slice(0, 8)}…)`);
      await queryClient.invalidateQueries({ queryKey: ['program-element-data-issues', peCode] });
      onCreated?.(created.id);
      form.resetFields();
      onClose();
    },
    onError: () => {
      message.error('Unable to report data issue. Check fields and try again.');
    },
  });

  return (
    <Modal
      title={`Report data issue — ${peCode}`}
      open={open}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      okText="Submit report"
      confirmLoading={mutation.isPending}
      onOk={() => mutation.mutate()}
      destroyOnHidden
      data-testid="pe-data-issue-modal"
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        Reports are tenant-scoped feedback. Submitting does not change canonical Program Element
        values — resolution still requires the reconciliation / override path.
      </Text>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          issueType: 'value_incorrect',
          fy: defaultFy ?? undefined,
          fieldName: defaultFieldName ?? undefined,
        }}
      >
        <Form.Item
          name="issueType"
          label="Issue type"
          rules={[{ required: true, message: 'Select an issue type' }]}
        >
          <Select options={[...ISSUE_TYPES]} />
        </Form.Item>
        <Form.Item name="fy" label="Fiscal year (optional)">
          <InputNumber min={1900} max={2200} style={{ width: '100%' }} placeholder="e.g. 2026" />
        </Form.Item>
        <Form.Item name="fieldName" label="Field / claim (optional)">
          <Select allowClear options={[...FIELD_OPTIONS]} placeholder="Select a field" />
        </Form.Item>
        <Form.Item
          name="description"
          label="Description"
          rules={[
            { required: true, message: 'Describe the issue' },
            { max: 4000, message: 'Max 4000 characters' },
          ]}
        >
          <TextArea rows={4} maxLength={4000} showCount placeholder="What looks wrong, and why?" />
        </Form.Item>
        <Form.Item
          name="suggestedSourceUrl"
          label="Official source URL (optional)"
          rules={[
            {
              type: 'url',
              message: 'Must be an http(s) URL',
            },
          ]}
        >
          <Input placeholder="https://…" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
