import { useEffect, useMemo, useState } from 'react';
import type { ColumnsType } from 'antd/es/table';
import {
  Alert,
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
  UnorderedListOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import {
  TERM_TYPES,
  useAddTerm,
  useBrowseHearings,
  useCreateHearing,
  useCreateWatchlist,
  useHearingSessions,
  useRemoveTerm,
  useSetWatchlistActive,
  useUpcomingHearings,
  useWatchlists,
  type HearingScope,
  type UpcomingHearing,
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

/** Render the upcoming-hearing date. scheduledAt is a date-only 'YYYY-MM-DD'
 *  string; parse the parts explicitly to avoid a UTC→local day shift. */
function formatHearingDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  if (Number.isNaN(d.getTime())) return v ?? '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function prettyType(type: string): string {
  const t = (type ?? '').toLowerCase();
  if (t.includes('markup')) return 'Markup';
  if (t.includes('hearing')) return 'Hearing';
  if (t.includes('meeting')) return 'Meeting';
  return type;
}

/** A directly-ingestible media URL (HLS/MP4/audio) vs an event page. Only a media
 *  URL is pre-filled into the room's Stream URL; an event page is offered as a
 *  click-through reference to go find the actual C-SPAN/committee stream. */
function isMediaUrl(u?: string | null): boolean {
  if (!u) return false;
  return /\.(m3u8|mp4|m3u|aac|mp3|ts)(\?|#|$)/i.test(u) || /stream|manifest|playlist|\.m3u8/i.test(u);
}

/** C-SPAN video-search query for a hearing (committee + title), for the one-click finder. */
function watchSearchQuery(r: UpcomingHearing): string {
  return [r.committee, r.title].filter(Boolean).join(' ').slice(0, 160);
}

/** Shared columns for the Upcoming + All-hearings tables. */
function buildHearingColumns(onWatch: (r: UpcomingHearing) => void): ColumnsType<UpcomingHearing> {
  return [
    {
      title: 'When',
      dataIndex: 'scheduledAt',
      width: 170,
      render: (v: string, r) => (
        <span>
          {formatHearingDate(v)}
          {r.time ? <Text type="secondary"> · {r.time}</Text> : null}
        </span>
      ),
    },
    { title: 'Chamber', dataIndex: 'chamber', width: 90 },
    { title: 'Committee', dataIndex: 'committee', ellipsis: true },
    {
      title: 'Title',
      dataIndex: 'title',
      render: (v: string, r) => (
        <Space size={6} wrap>
          {r.type ? <Tag>{prettyType(r.type)}</Tag> : null}
          {r.url ? (
            <a href={r.url} target="_blank" rel="noreferrer">
              {v}
            </a>
          ) : (
            <span>{v}</span>
          )}
        </Space>
      ),
    },
    {
      title: '',
      key: 'act',
      width: 90,
      render: (_: unknown, r) => (
        <Button size="small" onClick={() => onWatch(r)}>
          Watch
        </Button>
      ),
    },
  ];
}

export function HearingWatchPage() {
  const enabled = useIntelFeatureEnabled('hearing_watch');
  const [view, setView] = useState<'hearings' | 'upcoming' | 'browse' | 'watchlists'>('hearings');

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
          { label: 'All hearings', value: 'browse', icon: <UnorderedListOutlined /> },
          { label: 'Watchlists', value: 'watchlists', icon: <PlusOutlined /> },
        ]}
        style={{ marginBottom: 16 }}
      />

      {view === 'hearings' && <HearingsTab />}
      {view === 'upcoming' && <UpcomingTab />}
      {view === 'browse' && <BrowseTab />}
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
  presetUrl,
  presetSearchQuery,
}: {
  open: boolean;
  onClose: () => void;
  presetTitle?: string;
  presetUrl?: string;
  presetSearchQuery?: string;
}) {
  const [form] = Form.useForm();
  const create = useCreateHearing();
  const { message } = AntApp.useApp();

  // A media URL (HLS/MP4/audio) can go straight into the stream field; a
  // congress.gov event page can't be ingested, so we keep it as a reference.
  const presetIsMedia = isMediaUrl(presetUrl);
  const eventPageUrl = presetUrl && !presetIsMedia ? presetUrl : undefined;
  // One-click jump to C-SPAN's video search for this hearing — the fastest way to
  // land on the committee/C-SPAN player and grab the direct stream URL.
  const cspanUrl = presetSearchQuery
    ? `https://www.c-span.org/search/?searchtype=Videos&query=${encodeURIComponent(presetSearchQuery)}`
    : undefined;

  // The modal stays mounted across opens, so initialValues alone won't refresh
  // the preset when a different row is picked. Set fields each time it opens.
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      title: presetTitle,
      sourceType: 'hearing',
      audioSource: 'stream_url',
      recordingPolicy: 'transcript_only',
      sourceUrl: presetIsMedia ? presetUrl : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetTitle, presetUrl]);

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
              sourceUrl: v.sourceUrl?.trim() || undefined,
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
          audioSource: 'stream_url',
          recordingPolicy: 'transcript_only',
        }}
      >
        {presetIsMedia ? (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 12 }}
            message="Stream URL pre-filled from the hearing — it will start transcribing on connect."
          />
        ) : eventPageUrl || cspanUrl ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Find the live stream"
            description={
              <span>
                Congress.gov doesn&apos;t publish a media URL. Grab the direct <Text code>.m3u8</Text>/MP4
                from{' '}
                {eventPageUrl ? (
                  <a href={eventPageUrl} target="_blank" rel="noreferrer">
                    the event page ↗
                  </a>
                ) : null}
                {eventPageUrl && cspanUrl ? ' or ' : ' '}
                {cspanUrl ? (
                  <a href={cspanUrl} target="_blank" rel="noreferrer">
                    C-SPAN ↗
                  </a>
                ) : null}
                , then paste it below.
              </span>
            }
          />
        ) : null}
        <Form.Item name="title" label="Hearing title" rules={[{ required: true }]}>
          <Input placeholder="e.g. Senate Energy Committee — Interconnection Reform" />
        </Form.Item>
        <Form.Item name="sourceType" label="Source type" rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'hearing', label: 'Hearing' },
              { value: 'markup', label: 'Markup' },
              { value: 'meeting', label: 'Meeting' },
              { value: 'webinar', label: 'Webinar' },
              { value: 'agency_session', label: 'Agency session' },
            ]}
          />
        </Form.Item>
        <Form.Item name="audioSource" label="Audio source" rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'stream_url', label: 'Live stream URL' },
              { value: 'browser_mic', label: 'Microphone / device' },
              { value: 'uploaded_audio', label: 'Uploaded recording' },
              { value: 'conference_bridge', label: 'Conference bridge' },
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
              { value: 'audio_and_transcript', label: 'Store transcript + audio' },
              { value: 'no_storage', label: 'No storage (live only)' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="sourceUrl"
          label="Stream / recording URL (optional)"
          tooltip="Direct media URL — HLS .m3u8, MP3/AAC, or MP4 (e.g. a C-SPAN or committee stream). If set, the room pre-fills it and starts transcribing on connect. Not a congress.gov event page."
        >
          <Input placeholder="https://…/hearing.m3u8  (leave blank to enter it in the room)" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---- Upcoming tab ----------------------------------------------------------

function UpcomingTab() {
  const upcoming = useUpcomingHearings();
  const [presetTitle, setPresetTitle] = useState<string | undefined>();
  const [presetUrl, setPresetUrl] = useState<string | undefined>();
  const [presetSearch, setPresetSearch] = useState<string | undefined>();
  const [open, setOpen] = useState(false);

  const onWatch = (r: UpcomingHearing) => {
    setPresetTitle(`${r.committee} — ${r.title}`);
    setPresetUrl(r.url ?? undefined);
    setPresetSearch(watchSearchQuery(r));
    setOpen(true);
  };

  return (
    <Card
      title="Upcoming public hearings"
      size="small"
      extra={
        <Tooltip title="Congress schedules hearings ~1 week ahead; the list is thin during a recess. Use “All hearings” to search the full archive.">
          <Text type="secondary" style={{ fontSize: 12 }}>
            forward window
          </Text>
        </Tooltip>
      }
    >
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
          columns={buildHearingColumns(onWatch)}
        />
      ) : (
        <Empty description="No upcoming hearings scheduled right now (Congress may be in recess). Try “All hearings” to browse the full schedule." />
      )}
      <NewHearingModal
        open={open}
        onClose={() => setOpen(false)}
        presetTitle={presetTitle}
        presetUrl={presetUrl}
        presetSearchQuery={presetSearch}
      />
    </Card>
  );
}

// ---- All hearings (browse) tab ---------------------------------------------

function BrowseTab() {
  const [scope, setScope] = useState<HearingScope>('upcoming');
  const [search, setSearch] = useState('');
  const [chamber, setChamber] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const query = useBrowseHearings({
    scope,
    search: search || undefined,
    chamber: chamber || undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const [presetTitle, setPresetTitle] = useState<string | undefined>();
  const [presetUrl, setPresetUrl] = useState<string | undefined>();
  const [presetSearch, setPresetSearch] = useState<string | undefined>();
  const [open, setOpen] = useState(false);

  const onWatch = (r: UpcomingHearing) => {
    setPresetTitle(`${r.committee} — ${r.title}`);
    setPresetUrl(r.url ?? undefined);
    setPresetSearch(watchSearchQuery(r));
    setOpen(true);
  };

  const total = query.data?.total ?? 0;

  return (
    <Card
      title="All hearings"
      size="small"
      extra={
        query.data ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {total.toLocaleString()} hearings
          </Text>
        ) : null
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented
          value={scope}
          onChange={(v) => {
            setScope(v as HearingScope);
            setPage(1);
          }}
          options={[
            { label: 'Upcoming', value: 'upcoming' },
            { label: 'Past', value: 'past' },
            { label: 'All', value: 'all' },
          ]}
        />
        <Select
          value={chamber}
          style={{ width: 140 }}
          onChange={(v) => {
            setChamber(v);
            setPage(1);
          }}
          options={[
            { value: '', label: 'All chambers' },
            { value: 'House', label: 'House' },
            { value: 'Senate', label: 'Senate' },
            { value: 'Joint', label: 'Joint' },
          ]}
        />
        <Input.Search
          allowClear
          placeholder="Search title or committee"
          style={{ width: 300 }}
          onSearch={(v) => {
            setSearch(v.trim());
            setPage(1);
          }}
        />
      </Space>

      {query.isLoading ? (
        <Spin />
      ) : (
        <Table
          rowKey="id"
          size="small"
          dataSource={query.data?.items ?? []}
          columns={buildHearingColumns(onWatch)}
          locale={{ emptyText: <Empty description="No hearings match your filters." /> }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: false,
            onChange: (p) => setPage(p),
          }}
        />
      )}
      <NewHearingModal
        open={open}
        onClose={() => setOpen(false)}
        presetTitle={presetTitle}
        presetUrl={presetUrl}
        presetSearchQuery={presetSearch}
      />
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
