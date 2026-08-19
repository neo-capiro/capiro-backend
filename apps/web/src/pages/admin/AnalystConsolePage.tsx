import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import { PeReconciliationPage } from './PeReconciliationPage.js';
import { ProgramMatchQueuePage } from '../program-element/ProgramMatchQueuePage.js';
import { PersonCandidatesPage } from '../program-element/PersonCandidatesPage.js';
import { PersonnelMergeTab } from '../capiro-admin/CapiroAdminPage.js';
import { ALIAS_TYPES, ageLabel, slaColor } from './analyst-console-shared.js';
import type {
  AliasType,
  AuditLog,
  AuditLogResponse,
  DuplicateAliasGroup,
  ProgramAlias,
  ProgramSearchRow,
  QuarantineResponse,
  QuarantineRow,
  QuarantineType,
  ReviewCounts,
} from './analyst-console-shared.js';

export type { ReviewCounts } from './analyst-console-shared.js';

const { Title, Paragraph, Text } = Typography;

// ── Shared types + SLA helpers ────────────────────────────────────────────────
// Extracted to analyst-console-shared.ts (UI-free) so the vNext console
// (vnext/pages/admin-misc) can reuse them; public API unchanged (ReviewCounts
// is re-exported below).

function SlaChip({ label, openCount, oldestOpenAt }: { label: string; openCount: number; oldestOpenAt: string | null }) {
  const color = openCount > 0 ? slaColor(oldestOpenAt) : 'green';
  const age = openCount > 0 ? ageLabel(oldestOpenAt) : 'clear';
  return (
    <Tag color={color} aria-label={`${label} ${openCount} open, oldest ${age}`}>
      {label}: {openCount} open{openCount > 0 ? ` · oldest ${age}` : ''}
    </Tag>
  );
}

/** A tab label with a trailing count badge. */
function TabLabel({ text, count }: { text: string; count?: number }) {
  return (
    <span>
      {text}
      {count != null && count > 0 ? (
        <Tag color="blue" style={{ marginLeft: 6, marginInlineEnd: 0 }} aria-label={`${count} items`}>
          {count > 999 ? '999+' : count}
        </Tag>
      ) : null}
    </span>
  );
}

// ── SLA / counts header ────────────────────────────────────────────────────────

function SlaHeader({ counts, loading, error }: { counts?: ReviewCounts; loading: boolean; error: boolean }) {
  if (loading) return <Card size="small" loading style={{ marginBottom: 16 }} />;
  if (error || !counts) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Could not load review counts"
        description="SLA badges are unavailable; the queues below still load independently."
        style={{ marginBottom: 16 }}
      />
    );
  }
  return (
    <Card size="small" style={{ marginBottom: 16 }} aria-label="Review SLA dashboard">
      <Space size={[8, 8]} wrap>
        <SlaChip label="Reconciliation" openCount={counts.reconciliation.openCount} oldestOpenAt={counts.reconciliation.oldestOpenAt} />
        <SlaChip label="PE→Program" openCount={counts.programMatch.openCount} oldestOpenAt={counts.programMatch.oldestOpenAt} />
        <SlaChip label="Person candidates" openCount={counts.personCandidate.openCount} oldestOpenAt={counts.personCandidate.oldestOpenAt} />
        <SlaChip label="Personnel merge" openCount={counts.personnelMerge.openCount} oldestOpenAt={counts.personnelMerge.oldestOpenAt} />
        <SlaChip label="Provision links" openCount={counts.provisionPeLink.candidateCount} oldestOpenAt={counts.provisionPeLink.oldestOpenAt} />
        <Tag color={counts.programMatch.quarantinedCount > 0 ? 'orange' : 'green'}>
          Program quarantine: {counts.programQuarantine.count}
        </Tag>
        <Tag color={counts.personnelQuarantine.count > 0 ? 'orange' : 'green'}>
          Personnel quarantine: {counts.personnelQuarantine.count}
        </Tag>
      </Space>
    </Card>
  );
}

// ── Alias manager tab ───────────────────────────────────────────────────────────

function AliasManagerTab() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [search, setSearch] = useState('');
  const [selectedProgram, setSelectedProgram] = useState<ProgramSearchRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editAlias, setEditAlias] = useState<ProgramAlias | null>(null);
  const [mergeFor, setMergeFor] = useState<DuplicateAliasGroup | null>(null);
  const [mergeKeepId, setMergeKeepId] = useState<string | null>(null);
  const [addForm] = Form.useForm<{ alias: string; aliasType: AliasType; source?: string }>();
  const [editForm] = Form.useForm<{ alias: string; aliasType: AliasType }>();

  const programs = useQuery({
    queryKey: ['analyst-console', 'program-search', search],
    queryFn: async (): Promise<{ data: ProgramSearchRow[]; total: number }> =>
      (await api.get('/api/programs', { params: { q: search || undefined, limit: 25 } })).data,
    staleTime: 30_000,
  });

  const aliases = useQuery({
    queryKey: ['analyst-console', 'aliases', selectedProgram?.id],
    enabled: !!selectedProgram,
    queryFn: async (): Promise<{ programId: string; data: ProgramAlias[]; total: number }> =>
      (await api.get(`/api/programs/admin/${encodeURIComponent(selectedProgram!.id)}/aliases`)).data,
  });

  const duplicates = useQuery({
    queryKey: ['analyst-console', 'duplicate-aliases'],
    queryFn: async (): Promise<{ data: DuplicateAliasGroup[]; total: number }> =>
      (await api.get('/api/programs/admin/duplicate-aliases')).data,
    staleTime: 30_000,
  });

  const createAlias = useMutation({
    mutationFn: async (input: { alias: string; aliasType: AliasType; source?: string }) =>
      (await api.post(`/api/programs/admin/${encodeURIComponent(selectedProgram!.id)}/aliases`, input)).data,
    onSuccess: () => {
      message.success('Alias added.');
      setAddOpen(false);
      addForm.resetFields();
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'aliases', selectedProgram?.id] });
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'duplicate-aliases'] });
    },
    onError: (e) => message.error((e as Error).message),
  });

  const updateAlias = useMutation({
    mutationFn: async (input: { id: string; alias?: string; aliasType?: AliasType }) =>
      (await api.patch(`/api/programs/admin/aliases/${encodeURIComponent(input.id)}`, { alias: input.alias, aliasType: input.aliasType })).data,
    onSuccess: () => {
      message.success('Alias updated.');
      setEditAlias(null);
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'aliases', selectedProgram?.id] });
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'duplicate-aliases'] });
    },
    onError: (e) => message.error((e as Error).message),
  });

  const deleteAlias = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/programs/admin/aliases/${encodeURIComponent(id)}`)).data,
    onSuccess: () => {
      message.success('Alias deleted.');
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'aliases', selectedProgram?.id] });
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'duplicate-aliases'] });
    },
    onError: (e) => message.error((e as Error).message),
  });

  const merge = useMutation({
    mutationFn: async (input: { keepProgramId: string; mergeProgramId: string }) =>
      (await api.post('/api/programs/admin/merge', input)).data as Promise<{
        merged: true;
        keepProgramId: string;
        mergeProgramId: string;
        repointed: { matches: number; roles: number; officeLinks: number; provisionLinks: number };
        aliasesCopied: number;
      }>,
    onSuccess: (res) => {
      const r = res.repointed;
      message.success(
        `Merged. Repointed ${r.matches} matches, ${r.roles} roles, ${r.officeLinks} office links, ${r.provisionLinks} provision links; ${res.aliasesCopied} aliases copied.`,
      );
      setMergeFor(null);
      setMergeKeepId(null);
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'duplicate-aliases'] });
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'aliases'] });
    },
    onError: (e) => message.error((e as Error).message),
  });

  const aliasColumns: ColumnsType<ProgramAlias> = useMemo(
    () => [
      { title: 'Alias', dataIndex: 'alias', key: 'alias', render: (v: string) => <Text strong>{v}</Text> },
      { title: 'Type', dataIndex: 'aliasType', key: 'aliasType', width: 140, render: (v: string) => <Tag>{v}</Tag> },
      { title: 'Source', dataIndex: 'source', key: 'source', width: 140, render: (v: string | null) => v ?? '—' },
      {
        title: 'Confidence',
        dataIndex: 'confidence',
        key: 'confidence',
        width: 100,
        render: (v: number) => `${Math.round((v ?? 0) * 100)}%`,
      },
      {
        title: 'Action',
        key: 'action',
        width: 170,
        render: (_v, r) => (
          <Space size="small">
            <Button
              size="small"
              onClick={() => {
                editForm.setFieldsValue({ alias: r.alias, aliasType: r.aliasType as AliasType });
                setEditAlias(r);
              }}
            >
              Edit
            </Button>
            <Popconfirm
              title="Delete this alias?"
              okText="Delete"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteAlias.mutate(r.id)}
            >
              <Button size="small" danger loading={deleteAlias.isPending}>
                Delete
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [deleteAlias, editForm],
  );

  const mergeOptions = mergeFor?.programs ?? [];
  const keeper = mergeOptions.find((p) => p.programId === mergeKeepId) ?? null;
  const loser = mergeOptions.find((p) => p.programId !== mergeKeepId) ?? null;

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <Title level={4} style={{ marginTop: 0 }}>
          Alias manager
        </Title>
        <Paragraph type="secondary">
          Find a program, then review / add / edit / delete its aliases. Aliases drive PE→Program matching, so
          changes here directly affect the match queue.
        </Paragraph>
        <Space style={{ marginBottom: 12 }} wrap>
          <Input.Search
            allowClear
            placeholder="Search programs by name or alias…"
            aria-label="program search"
            style={{ width: 320 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select<string>
            showSearch
            allowClear
            filterOption={false}
            placeholder="Pick a program"
            aria-label="select program"
            loading={programs.isLoading}
            style={{ width: 360 }}
            value={selectedProgram?.id}
            onSearch={(v) => setSearch(v)}
            onChange={(id) => setSelectedProgram((programs.data?.data ?? []).find((p) => p.id === id) ?? null)}
            options={(programs.data?.data ?? []).map((p) => ({
              value: p.id,
              label: `${p.canonicalName}${p.mdapCode ? ` · MDAP ${p.mdapCode}` : ''}${p.component ? ` · ${p.component}` : ''}`,
            }))}
          />
          {selectedProgram ? (
            <Button
              type="primary"
              onClick={() => {
                addForm.resetFields();
                setAddOpen(true);
              }}
            >
              Add alias
            </Button>
          ) : null}
        </Space>

        {selectedProgram ? (
          <Table<ProgramAlias>
            rowKey="id"
            size="small"
            loading={aliases.isLoading}
            columns={aliasColumns}
            dataSource={aliases.data?.data ?? []}
            pagination={false}
            locale={{ emptyText: 'No aliases for this program yet.' }}
          />
        ) : (
          <Empty description="Search and select a program to manage its aliases." />
        )}
      </Card>

      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          Duplicate-alias detector
        </Title>
        <Paragraph type="secondary">
          Normalized aliases shared across more than one program — usually two program records that should be one.
          Merge the duplicate into the canonical record; FK references are repointed and the loser is retired.
        </Paragraph>
        {duplicates.isError && <Alert type="error" message="Failed to load duplicate aliases." style={{ marginBottom: 12 }} />}
        {duplicates.isLoading ? (
          <Card loading />
        ) : (duplicates.data?.data ?? []).length === 0 ? (
          <Empty description="No duplicate aliases — the program graph is clean." />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {(duplicates.data?.data ?? []).map((g) => (
              <Card key={g.aliasNormalized} size="small" title={<Text code>{g.aliasNormalized}</Text>}>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {g.programs.map((p) => (
                    <div key={p.programId} style={{ fontSize: 13 }}>
                      <Text strong>{p.canonicalName ?? '(unknown program)'}</Text>{' '}
                      <Tag color={p.status === 'merged' ? 'default' : 'green'}>{p.status ?? '—'}</Tag>
                    </div>
                  ))}
                </Space>
                <div style={{ marginTop: 8 }}>
                  <Button
                    size="small"
                    onClick={() => {
                      setMergeKeepId(g.programs[0]?.programId ?? null);
                      setMergeFor(g);
                    }}
                  >
                    Merge programs
                  </Button>
                </div>
              </Card>
            ))}
          </Space>
        )}
      </Card>

      {/* Add alias modal */}
      <Modal
        title={`Add alias — ${selectedProgram?.canonicalName ?? ''}`}
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={() => addForm.submit()}
        confirmLoading={createAlias.isPending}
        okText="Add alias"
      >
        <Form form={addForm} layout="vertical" onFinish={(v) => createAlias.mutate(v)}>
          <Form.Item name="alias" label="Alias" rules={[{ required: true, message: 'Enter the alias text' }]}>
            <Input placeholder="e.g. Patriot Advanced Capability" />
          </Form.Item>
          <Form.Item name="aliasType" label="Alias type" rules={[{ required: true }]}>
            <Select options={ALIAS_TYPES.map((t) => ({ value: t, label: t }))} />
          </Form.Item>
          <Form.Item name="source" label="Source (optional)">
            <Input placeholder="e.g. analyst" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit alias modal */}
      <Modal
        title="Edit alias"
        open={!!editAlias}
        onCancel={() => setEditAlias(null)}
        onOk={() => editForm.submit()}
        confirmLoading={updateAlias.isPending}
        okText="Save"
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(v) => editAlias && updateAlias.mutate({ id: editAlias.id, alias: v.alias, aliasType: v.aliasType })}
        >
          <Form.Item name="alias" label="Alias" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="aliasType" label="Alias type" rules={[{ required: true }]}>
            <Select options={ALIAS_TYPES.map((t) => ({ value: t, label: t }))} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Merge confirm modal */}
      <Modal
        title="Merge programs"
        open={!!mergeFor}
        onCancel={() => {
          setMergeFor(null);
          setMergeKeepId(null);
        }}
        onOk={() =>
          keeper && loser && merge.mutate({ keepProgramId: keeper.programId, mergeProgramId: loser.programId })
        }
        okText="Merge"
        okButtonProps={{ danger: true, disabled: !keeper || !loser }}
        confirmLoading={merge.isPending}
      >
        <Paragraph type="secondary">
          Choose which program to KEEP. The other is retired (status=merged); its matches, roles, links and aliases
          are repointed to the keeper. This is audit-logged and cannot be auto-undone.
        </Paragraph>
        <Form layout="vertical">
          <Form.Item label="Keep (canonical)">
            <Select
              value={mergeKeepId ?? undefined}
              aria-label="keep program"
              onChange={(v) => setMergeKeepId(v)}
              options={mergeOptions.map((p) => ({
                value: p.programId,
                label: p.canonicalName ?? p.programId,
              }))}
            />
          </Form.Item>
        </Form>
        {keeper && loser ? (
          <Alert
            type="info"
            showIcon
            message={
              <span>
                Keep <Text strong>{keeper.canonicalName ?? keeper.programId}</Text> · retire{' '}
                <Text strong>{loser.canonicalName ?? loser.programId}</Text>
              </span>
            }
          />
        ) : (
          <Alert type="warning" showIcon message="Pick the program to keep." />
        )}
      </Modal>
    </>
  );
}

// ── Quarantine tab ───────────────────────────────────────────────────────────

function QuarantineTab() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [type, setType] = useState<QuarantineType>('program_element');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<QuarantineRow | null>(null);
  const limit = 25;

  const queue = useQuery({
    queryKey: ['analyst-console', 'quarantine', type, source, page],
    queryFn: async (): Promise<QuarantineResponse> =>
      (
        await api.get('/api/capiro-admin/quarantine', {
          params: { type, source: source || undefined, page, limit },
        })
      ).data,
  });

  const reprocess = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/capiro-admin/quarantine/${type}/${encodeURIComponent(id)}/reprocess`)).data as Promise<{
        reprocessed: boolean;
        accepted: boolean;
        reason?: string;
      }>,
    onSuccess: (res) => {
      if (res.accepted) {
        message.success('Reprocessed and accepted — record promoted.');
        void qc.invalidateQueries({ queryKey: ['analyst-console', 'quarantine'] });
      } else {
        message.warning(`Still invalid: ${res.reason ?? 'reprocess rejected'}`);
      }
    },
    onError: (e) => message.error((e as Error).message),
  });

  const discard = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/capiro-admin/quarantine/${type}/${encodeURIComponent(id)}/discard`)).data,
    onSuccess: () => {
      message.success('Discarded.');
      void qc.invalidateQueries({ queryKey: ['analyst-console', 'quarantine'] });
    },
    onError: (e) => message.error((e as Error).message),
  });

  const columns: ColumnsType<QuarantineRow> = useMemo(
    () => [
      { title: 'Source', dataIndex: 'source', key: 'source', width: 160 },
      {
        title: 'Reason',
        dataIndex: 'reason',
        key: 'reason',
        render: (v: string | null) => v ?? <Text type="secondary">—</Text>,
      },
      {
        title: 'Quarantined',
        dataIndex: 'quarantinedAt',
        key: 'quarantinedAt',
        width: 200,
        render: (v: string) => new Date(v).toLocaleString(),
      },
      {
        title: 'Raw record',
        key: 'raw',
        width: 90,
        render: (_v, r) => (
          <Button size="small" onClick={() => setViewing(r)}>
            View
          </Button>
        ),
      },
      {
        title: 'Action',
        key: 'action',
        width: 200,
        render: (_v, r) => (
          <Space size="small">
            <Popconfirm
              title="Reprocess this record?"
              description="Re-runs writer validation; promotes it if it now passes."
              okText="Reprocess"
              onConfirm={() => reprocess.mutate(r.id)}
            >
              <Button type="primary" size="small" loading={reprocess.isPending}>
                Reprocess
              </Button>
            </Popconfirm>
            <Popconfirm
              title="Discard this record?"
              description="Permanently deletes the quarantined record."
              okText="Discard"
              okButtonProps={{ danger: true }}
              onConfirm={() => discard.mutate(r.id)}
            >
              <Button size="small" danger loading={discard.isPending}>
                Discard
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [reprocess, discard],
  );

  return (
    <Card>
      <Title level={4} style={{ marginTop: 0 }}>
        Quarantine
      </Title>
      <Paragraph type="secondary">
        Ingestion records the writer rejected (invalid PE code, missing name, etc.). Inspect the raw record, then
        reprocess to retry validation or discard if it is junk.
      </Paragraph>
      <Space style={{ marginBottom: 16 }} wrap>
        <Text>Type:</Text>
        <Select<QuarantineType>
          value={type}
          aria-label="quarantine type"
          style={{ width: 220 }}
          onChange={(v) => {
            setType(v);
            setPage(1);
          }}
          options={[
            { value: 'program_element', label: 'Program element' },
            { value: 'acquisition_personnel', label: 'Acquisition personnel' },
          ]}
        />
        <Input.Search
          allowClear
          placeholder="Filter by source…"
          aria-label="source filter"
          style={{ width: 240 }}
          onSearch={(v) => {
            setSource(v.trim());
            setPage(1);
          }}
        />
      </Space>
      {queue.isError && <Alert type="error" message="Failed to load the quarantine queue." showIcon style={{ marginBottom: 16 }} />}
      <Table<QuarantineRow>
        rowKey="id"
        size="small"
        loading={queue.isLoading}
        columns={columns}
        dataSource={queue.data?.data ?? []}
        pagination={{
          current: page,
          pageSize: limit,
          total: queue.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        locale={{ emptyText: 'No quarantined records.' }}
      />
      <Modal
        title="Raw record"
        open={!!viewing}
        onCancel={() => setViewing(null)}
        footer={<Button onClick={() => setViewing(null)}>Close</Button>}
        width={720}
      >
        <pre style={{ maxHeight: 480, overflow: 'auto', background: '#0000000a', padding: 12, borderRadius: 6 }}>
          {viewing ? JSON.stringify(viewing.rawRecord, null, 2) : ''}
        </pre>
      </Modal>
    </Card>
  );
}

// ── Audit log tab ───────────────────────────────────────────────────────────

function AuditLogTab() {
  const api = useApi();
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<AuditLog | null>(null);
  const limit = 25;

  const logs = useQuery({
    queryKey: ['analyst-console', 'audit-logs', action, entityType, page],
    queryFn: async (): Promise<AuditLogResponse> =>
      (
        await api.get('/api/capiro-admin/audit-logs', {
          params: { action: action || undefined, entityType: entityType || undefined, page, limit },
        })
      ).data,
  });

  const columns: ColumnsType<AuditLog> = useMemo(
    () => [
      {
        title: 'When',
        dataIndex: 'occurredAt',
        key: 'occurredAt',
        width: 200,
        render: (v: string) => new Date(v).toLocaleString(),
      },
      { title: 'Action', dataIndex: 'action', key: 'action', render: (v: string) => <Tag color="blue">{v}</Tag> },
      { title: 'Entity', dataIndex: 'entityType', key: 'entityType', width: 150 },
      {
        title: 'Entity id',
        dataIndex: 'entityId',
        key: 'entityId',
        width: 180,
        render: (v: string | null) => (v ? <Text code>{v}</Text> : '—'),
      },
      { title: 'Actor role', dataIndex: 'actorRole', key: 'actorRole', width: 130, render: (v: string) => <Tag>{v}</Tag> },
      {
        title: 'Detail',
        key: 'detail',
        width: 90,
        render: (_v, r) => (
          <Button size="small" onClick={() => setViewing(r)}>
            View
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <Card>
      <Title level={4} style={{ marginTop: 0 }}>
        Audit log
      </Title>
      <Paragraph type="secondary">
        Analyst actions recorded under your tenant — newest first. Filter by action or entity type and expand any row
        to see the before/after snapshot.
      </Paragraph>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          allowClear
          placeholder="action (e.g. program.merge)"
          aria-label="action filter"
          style={{ width: 240 }}
          onSearch={(v) => {
            setAction(v.trim());
            setPage(1);
          }}
        />
        <Input.Search
          allowClear
          placeholder="entity type (e.g. program)"
          aria-label="entity type filter"
          style={{ width: 240 }}
          onSearch={(v) => {
            setEntityType(v.trim());
            setPage(1);
          }}
        />
      </Space>
      {logs.isError && <Alert type="error" message="Failed to load the audit log." showIcon style={{ marginBottom: 16 }} />}
      <Table<AuditLog>
        rowKey="id"
        size="small"
        loading={logs.isLoading}
        columns={columns}
        dataSource={logs.data?.data ?? []}
        pagination={{
          current: page,
          pageSize: limit,
          total: logs.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        locale={{ emptyText: 'No audit-log entries match.' }}
      />
      <Modal
        title={viewing ? `${viewing.action} · ${viewing.entityType}` : ''}
        open={!!viewing}
        onCancel={() => setViewing(null)}
        footer={<Button onClick={() => setViewing(null)}>Close</Button>}
        width={760}
      >
        {viewing ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Text type="secondary">Before</Text>
              <pre style={{ maxHeight: 240, overflow: 'auto', background: '#0000000a', padding: 12, borderRadius: 6 }}>
                {JSON.stringify(viewing.before, null, 2)}
              </pre>
            </div>
            <div>
              <Text type="secondary">After</Text>
              <pre style={{ maxHeight: 240, overflow: 'auto', background: '#0000000a', padding: 12, borderRadius: 6 }}>
                {JSON.stringify(viewing.after, null, 2)}
              </pre>
            </div>
          </Space>
        ) : null}
      </Modal>
    </Card>
  );
}

// ── Honest placeholder tabs ─────────────────────────────────────────────────

function ProvisionLinksTab({ count }: { count: number }) {
  return (
    <Card>
      <Result
        status="info"
        title="Provision → PE links"
        subTitle={
          <span>
            {count} candidate link{count === 1 ? '' : 's'} awaiting review. Review UI pending — there is no
            provision-link review endpoint yet.
          </span>
        }
      />
    </Card>
  );
}

function SamMatchesTab() {
  return (
    <Card>
      <Result
        status="info"
        title="SAM.gov matches"
        subTitle="Pending SAM.gov integration (Step 3.1). No data is available yet — this tab is a placeholder."
      />
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

/**
 * Step 3.5 — Unified analyst console (capiro_admin only). One home for every
 * review queue plus an SLA/counts header. Existing review-queue pages are mounted
 * as tab children (they self-fetch + self-gate); the alias manager, quarantine
 * and audit-log tabs are new. Provision links + SAM are honest placeholders.
 *
 * Client-side gating here is an affordance only; the server's RolesGuard on every
 * endpoint is the security boundary.
 */
export function AnalystConsolePage() {
  const me = useMe();
  const api = useApi();
  const isCapiroAdmin = me.data?.role === 'capiro_admin';

  const counts = useQuery({
    queryKey: ['analyst-console', 'review-counts'],
    enabled: isCapiroAdmin,
    queryFn: async (): Promise<ReviewCounts> => (await api.get('/api/capiro-admin/review-counts')).data,
    staleTime: 30_000,
  });

  const c = counts.data;
  const programMatchCount = c ? c.programMatch.openCount + c.programMatch.quarantinedCount : undefined;
  const quarantineCount = c ? c.programQuarantine.count + c.personnelQuarantine.count : undefined;

  const items = useMemo(
    () => [
      {
        key: 'reconciliation',
        label: <TabLabel text="Reconciliation" count={c?.reconciliation.openCount} />,
        children: <PeReconciliationPage />,
      },
      {
        key: 'program-matches',
        label: <TabLabel text="Program matches" count={programMatchCount} />,
        children: <ProgramMatchQueuePage />,
      },
      { key: 'alias-manager', label: 'Alias manager', children: <AliasManagerTab /> },
      {
        key: 'person-candidates',
        label: <TabLabel text="Person candidates" count={c?.personCandidate.openCount} />,
        children: <PersonCandidatesPage />,
      },
      {
        key: 'merge-candidates',
        label: <TabLabel text="Merge candidates" count={c?.personnelMerge.openCount} />,
        children: <PersonnelMergeTab />,
      },
      {
        key: 'quarantine',
        label: <TabLabel text="Quarantine" count={quarantineCount} />,
        children: <QuarantineTab />,
      },
      { key: 'audit-log', label: 'Audit log', children: <AuditLogTab /> },
      {
        key: 'provision-links',
        label: <TabLabel text="Provision links" count={c?.provisionPeLink.candidateCount} />,
        children: <ProvisionLinksTab count={c?.provisionPeLink.candidateCount ?? 0} />,
      },
      { key: 'sam', label: 'SAM', children: <SamMatchesTab /> },
    ],
    [c, programMatchCount, quarantineCount],
  );

  if (me.isLoading) return <Spin />;
  if (!isCapiroAdmin) {
    return (
      <Result status="403" title="403" subTitle="The analyst console is restricted to Capiro administrators." />
    );
  }

  return (
    <section>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }}>
        <Title level={3} style={{ margin: 0 }}>
          Analyst Console
        </Title>
        <Tooltip title="Refresh SLA counts">
          <Button size="small" loading={counts.isFetching} onClick={() => counts.refetch()}>
            Refresh counts
          </Button>
        </Tooltip>
      </Space>
      <SlaHeader counts={counts.data} loading={counts.isLoading} error={counts.isError} />
      <Tabs defaultActiveKey="reconciliation" items={items} destroyInactiveTabPane />
    </section>
  );
}

export default AnalystConsolePage;
