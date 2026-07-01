import { useMemo, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AudioOutlined,
  DeleteOutlined,
  PlusOutlined,
  CalendarOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import {
  TERM_TYPES,
  useAddTerm,
  useCreateHearing,
  useCreateWatchlist,
  useHearingSessions,
  useRemoveTerm,
  useSetWatchlistActive,
  useUpcomingHearings,
  useWatchlists,
  type Watchlist,
} from '../../lib/hearing-watch-api.js';

const { Title, Text, Paragraph } = Typography;

const STATUS_COLOR: Record<string, string> = {
  live: 'red',
  scheduled: 'blue',
  paused: 'orange',
  ended: 'green',
  failed: 'default',
};

export function HearingWatchPage() {
  const enabled = useIntelFeatureEnabled('hearing_watch');
  const [view, setView] = useState<'hearings' | 'upcoming' | 'watchlists'>('hearings');

  if (!enabled) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description="Hearing Watch is not enabled for this workspace." />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1180 }}>
      <Title level={3} style={{ marginBottom: 4 }}>
        <AudioOutlined /> Hearing Watch
      </Title>
      <Paragraph type="secondary" style={{ marginTop: 0 }}>
        Client-ready intelligence from public hearings — track terms, watch hearings live, and get
        post-hearing briefs.
      </Paragraph>

      <Segmented
        value={view}
        onChange={(v) => setView(v as typeof view)}
        options={[
          { label: 'Hearings', value: 'hearings', icon: <AudioOutlined /> },
          { label: 'Upcoming', value: 'upcoming', icon: <CalendarOutlined /> },
          { label: 'Watchlists', value: 'watchlists', icon: <PlusOutlined /> },
        ]}
        style={{ marginBottom: 16 }}
      />

      {view === 'hearings' && <HearingsTab />}
      {view === 'upcoming' && <UpcomingTab />}
      {view === 'watchlists' && <WatchlistsTab />}
    </div>
  );
}

// ---- Hearings tab ----------------------------------------------------------

function HearingsTab() {
  const sessions = useHearingSessions();
  const [open, setOpen] = useState(false);

  return (
    <Card
      title="Hearing sessions"
      size="small"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          New Hearing
        </Button>
      }
    >
      {sessions.isLoading ? (
        <Spin />
      ) : sessions.data && sessions.data.length > 0 ? (
        <List
          dataSource={sessions.data}
          renderItem={(s) => (
            <List.Item
              actions={[
                <Tag key="st" color={STATUS_COLOR[s.status] ?? 'default'}>
                  {s.status}
                </Tag>,
                <Link key="open" to={`/intelligence/hearing-watch/${s.id}`}>
                  Open room
                </Link>,
              ]}
            >
              <List.Item.Meta
                title={s.title}
                description={
                  <Text type="secondary">
                    {s.sourceType}
                    {s.startedAt ? ` · started ${new Date(s.startedAt).toLocaleString()}` : ''}
                  </Text>
                }
              />
            </List.Item>
          )}
        />
      ) : (
        <Empty description="No hearing sessions yet. Start one with “New Hearing”." />
      )}
      <NewHearingModal open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

function NewHearingModal({
  open,
  onClose,
  presetTitle,
}: {
  open: boolean;
  onClose: () => void;
  presetTitle?: string;
}) {
  const [form] = Form.useForm();
  const create = useCreateHearing();
  const { message } = AntApp.useApp();

  return (
    <Modal
      title="Start a hearing session"
      open={open}
      onCancel={onClose}
      okText="Create"
      confirmLoading={create.isPending}
      onOk={() => {
        form.validateFields().then((v) => {
          create.mutate(
            {
              title: v.title,
              sourceType: v.sourceType,
              audioSource: v.audioSource,
              recordingPolicy: v.recordingPolicy,
            },
            {
              onSuccess: () => {
                message.success('Hearing session created');
                form.resetFields();
                onClose();
              },
              onError: (e: unknown) =>
                message.error(`Could not create session: ${(e as Error).message}`),
            },
          );
        });
      }}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          title: presetTitle,
          sourceType: 'hearing',
          audioSource: 'live_stream',
          recordingPolicy: 'transcript_only',
        }}
      >
        <Form.Item name="title" label="Hearing title" rules={[{ required: true }]}>
          <Input placeholder="e.g. Senate Energy Committee — Interconnection Reform" />
        </Form.Item>
        <Form.Item name="sourceType" label="Source type" rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'hearing', label: 'Hearing' },
              { value: 'markup', label: 'Markup' },
              { value: 'floor', label: 'Floor proceeding' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </Form.Item>
        <Form.Item name="audioSource" label="Audio source" rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'live_stream', label: 'Live stream URL' },
              { value: 'mic', label: 'Microphone / device' },
              { value: 'upload', label: 'Uploaded recording' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="recordingPolicy"
          label="Recording policy"
          rules={[{ required: true }]}
          tooltip="Controls what is stored. Transcript-only never persists audio."
        >
          <Select
            options={[
              { value: 'transcript_only', label: 'Transcript only (no audio stored)' },
              { value: 'store_segments', label: 'Store transcript segments' },
              { value: 'no_store', label: 'No storage (live only)' },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---- Upcoming tab ----------------------------------------------------------

function UpcomingTab() {
  const upcoming = useUpcomingHearings();
  const [presetTitle, setPresetTitle] = useState<string | undefined>();
  const [open, setOpen] = useState(false);

  return (
    <Card title="Upcoming public hearings" size="small">
      {upcoming.isLoading ? (
        <Spin />
      ) : upcoming.isError ? (
        <Empty description="Upcoming-hearings feed is not available yet." />
      ) : upcoming.data && upcoming.data.length > 0 ? (
        <Table
          rowKey="id"
          size="small"
          pagination={{ pageSize: 10 }}
          dataSource={upcoming.data}
          columns={[
            { title: 'When', dataIndex: 'scheduledAt', render: (v: string) => new Date(v).toLocaleString(), width: 190 },
            { title: 'Chamber', dataIndex: 'chamber', width: 90 },
            { title: 'Committee', dataIndex: 'committee' },
            { title: 'Title', dataIndex: 'title' },
            {
              title: '',
              key: 'act',
              width: 90,
              render: (_: unknown, r) => (
                <Button
                  size="small"
                  onClick={() => {
                    setPresetTitle(`${r.committee} — ${r.title}`);
                    setOpen(true);
                  }}
                >
                  Watch
                </Button>
              ),
            },
          ]}
        />
      ) : (
        <Empty description="No upcoming hearings scheduled." />
      )}
      <NewHearingModal open={open} onClose={() => setOpen(false)} presetTitle={presetTitle} />
    </Card>
  );
}

// ---- Watchlists tab --------------------------------------------------------

function WatchlistsTab() {
  const watchlists = useWatchlists();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Watchlist | null>(null);
  const setActive = useSetWatchlistActive();

  return (
    <Card
      title="Client watchlists"
      size="small"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          New Watchlist
        </Button>
      }
    >
      {watchlists.isLoading ? (
        <Spin />
      ) : watchlists.data && watchlists.data.length > 0 ? (
        <List
          dataSource={watchlists.data}
          renderItem={(wl) => (
            <List.Item
              actions={[
                <a key="edit" onClick={() => setEditing(wl)}>
                  Edit terms
                </a>,
                <a
                  key="tog"
                  onClick={() => setActive.mutate({ id: wl.id, active: !wl.active })}
                >
                  {wl.active ? 'Deactivate' : 'Activate'}
                </a>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    {wl.name}
                    {wl.active ? <Tag color="green">active</Tag> : <Tag>paused</Tag>}
                  </Space>
                }
                description={
                  <span>
                    {wl.terms.slice(0, 10).map((t) => (
                      <Tag key={t.id}>{t.value}</Tag>
                    ))}
                    {wl.terms.length > 10 ? (
                      <Text type="secondary">+{wl.terms.length - 10} more</Text>
                    ) : null}
                    {wl.terms.length === 0 ? <Text type="secondary">no terms yet</Text> : null}
                  </span>
                }
              />
            </List.Item>
          )}
        />
      ) : (
        <Empty description="No watchlists yet. Create one to start tracking terms." />
      )}
      <CreateWatchlistModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <EditTermsDrawer watchlist={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function CreateWatchlistModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  const create = useCreateWatchlist();
  const { message } = AntApp.useApp();

  return (
    <Modal
      title="New watchlist"
      open={open}
      onCancel={onClose}
      okText="Create"
      confirmLoading={create.isPending}
      onOk={() => {
        form.validateFields().then((v) => {
          const terms = (v.terms || '')
            .split('\n')
            .map((s: string) => s.trim())
            .filter(Boolean)
            .map((value: string) => ({ termType: v.defaultType, value }));
          create.mutate(
            { clientId: v.clientId, name: v.name, terms },
            {
              onSuccess: () => {
                message.success('Watchlist created');
                form.resetFields();
                onClose();
              },
              onError: (e: unknown) =>
                message.error(`Could not create: ${(e as Error).message}`),
            },
          );
        });
      }}
    >
      <Form form={form} layout="vertical" initialValues={{ defaultType: 'topic' }}>
        <Form.Item name="name" label="Watchlist name" rules={[{ required: true }]}>
          <Input placeholder="e.g. Energy — SB 410 tracking" />
        </Form.Item>
        <Form.Item
          name="clientId"
          label="Client ID"
          rules={[{ required: true }]}
          tooltip="The client this watchlist scopes relevance to."
        >
          <Input placeholder="client UUID" />
        </Form.Item>
        <Form.Item name="defaultType" label="Default term type">
          <Select options={TERM_TYPES.map((t) => ({ value: t, label: t }))} />
        </Form.Item>
        <Form.Item name="terms" label="Terms (one per line)">
          <Input.TextArea
            rows={5}
            placeholder={'SB 410\ninterconnection queue\nratepayer impact\ndata centers'}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function EditTermsDrawer({
  watchlist,
  onClose,
}: {
  watchlist: Watchlist | null;
  onClose: () => void;
}) {
  const addTerm = useAddTerm();
  const removeTerm = useRemoveTerm();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const wl = watchlist;
  const terms = useMemo(() => wl?.terms ?? [], [wl]);

  return (
    <Drawer
      title={wl ? `Terms — ${wl.name}` : ''}
      open={!!wl}
      onClose={onClose}
      width={440}
    >
      {wl && (
        <>
          <Form
            form={form}
            layout="inline"
            style={{ marginBottom: 16 }}
            initialValues={{ termType: 'topic' }}
            onFinish={(v) => {
              addTerm.mutate(
                { watchlistId: wl.id, termType: v.termType, value: v.value },
                {
                  onSuccess: () => {
                    message.success('Term added');
                    form.setFieldValue('value', '');
                  },
                  onError: (e: unknown) => message.error((e as Error).message),
                },
              );
            }}
          >
            <Form.Item name="termType">
              <Select
                style={{ width: 140 }}
                options={TERM_TYPES.map((t) => ({ value: t, label: t }))}
              />
            </Form.Item>
            <Form.Item name="value" rules={[{ required: true }]}>
              <Input placeholder="term" style={{ width: 150 }} />
            </Form.Item>
            <Form.Item>
              <Button htmlType="submit" type="primary" icon={<PlusOutlined />} loading={addTerm.isPending} />
            </Form.Item>
          </Form>
          <List
            size="small"
            dataSource={terms}
            locale={{ emptyText: 'No terms yet' }}
            renderItem={(t) => (
              <List.Item
                actions={[
                  <Tooltip key="d" title="Remove">
                    <DeleteOutlined
                      onClick={() =>
                        removeTerm.mutate(t.id, {
                          onSuccess: () => message.success('Term removed'),
                        })
                      }
                    />
                  </Tooltip>,
                ]}
              >
                <Space>
                  <Tag>{t.termType}</Tag>
                  {t.value}
                </Space>
              </List.Item>
            )}
          />
        </>
      )}
    </Drawer>
  );
}

export default HearingWatchPage;
