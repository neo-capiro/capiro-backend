import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiOutlined,
  BugOutlined,
  CheckSquareOutlined,
  CodeOutlined,
  CreditCardOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  FileTextOutlined,
  FolderOutlined,
  GlobalOutlined,
  LinkOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateFilled,
  SearchOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ROLE_RANK } from '@capiro/shared';
import { useMe } from '../../lib/me.js';
import { useApi } from '../../lib/use-api.js';

/**
 * Settings → Integrations → "Connectors" (connector-library v1).
 *
 * The Claude-style connector library for Meri: browse a curated catalog or add
 * a custom MCP server, connect with one click (OAuth where supported, API key
 * otherwise), and manage connected tools. Personal connectors are private to
 * the user; firm-wide connectors are admin-managed. Secrets are write-only.
 */

type AuthType = 'none' | 'token' | 'oauth';
type Scope = 'tenant' | 'user';
type CatalogCategory = 'productivity' | 'research' | 'crm' | 'developer' | 'communication';

interface CatalogTool {
  name: string;
  description: string;
  readOnly?: boolean;
}
interface CatalogEntry {
  id: string;
  name: string;
  category: CatalogCategory;
  description: string;
  longDescription: string;
  transport: 'http' | 'stdio';
  endpoint: string | null;
  authType: AuthType;
  verified: boolean;
  defaultScope: Scope;
  suggestedTools: CatalogTool[];
  docsUrl?: string;
  requiresEndpointInput?: boolean;
  setupNote?: string;
  brand: { color: string; glyph: string };
  connected: boolean;
}
interface CatalogResponse {
  oauthConfigured: boolean;
  connectors: CatalogEntry[];
}
interface ServerRow {
  id: string;
  name: string;
  transport: 'http' | 'stdio';
  endpoint: string | null;
  command: string | null;
  args: string[] | null;
  toolAllowlist: string[] | null;
  readOnlyTools: string[] | null;
  enabled: boolean;
  scope: Scope;
  catalogId: string | null;
  authType: AuthType;
  connectionStatus: 'connected' | 'pending' | 'needs_reauth' | 'error' | 'disconnected';
  isOwner: boolean;
  canManage: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  hasAuthToken: boolean;
}

const GLYPHS: Record<string, ReactNode> = {
  folder: <FolderOutlined />,
  note: <FileTextOutlined />,
  search: <SearchOutlined />,
  browser: <GlobalOutlined />,
  contacts: <TeamOutlined />,
  database: <DatabaseOutlined />,
  card: <CreditCardOutlined />,
  task: <CheckSquareOutlined />,
  code: <CodeOutlined />,
  bug: <BugOutlined />,
  chat: <MessageOutlined />,
};

const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  productivity: 'Documents',
  research: 'Research',
  crm: 'CRM & Sales',
  developer: 'Developer',
  communication: 'Communication',
};

const AUTH_LABEL: Record<AuthType, string> = {
  oauth: 'OAuth',
  token: 'API key',
  none: 'No auth',
};

function Tile({ color, glyph, size = 42 }: { color: string; glyph: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size / 3.6,
        background: color,
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        fontSize: size / 2.3,
        flex: 'none',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.14)',
      }}
    >
      {GLYPHS[glyph] ?? <ApiOutlined />}
    </span>
  );
}

// Catalog id → the brand's domain, used to fetch the company's own logo. We
// render each vendor's real favicon at runtime (identifying the connector,
// like any integrations directory) and fall back to the colored glyph tile if
// the image can't load.
const LOGO_DOMAIN: Record<string, string> = {
  'google-drive': 'drive.google.com',
  sharepoint: 'sharepoint.com',
  notion: 'notion.so',
  box: 'box.com',
  dropbox: 'dropbox.com',
  tavily: 'tavily.com',
  exa: 'exa.ai',
  firecrawl: 'firecrawl.dev',
  chrome: 'google.com',
  hubspot: 'hubspot.com',
  salesforce: 'salesforce.com',
  stripe: 'stripe.com',
  apollo: 'apollo.io',
  atlassian: 'atlassian.com',
  linear: 'linear.app',
  asana: 'asana.com',
  github: 'github.com',
  sentry: 'sentry.io',
  slack: 'slack.com',
};

function logoUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}

/** Company-logo tile (real favicon) with the colored glyph tile as fallback. */
function BrandTile({
  id,
  color,
  glyph,
  size = 42,
}: {
  id?: string | null;
  color: string;
  glyph: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const domain = id ? LOGO_DOMAIN[id] : undefined;
  if (!domain || failed) return <Tile color={color} glyph={glyph} size={size} />;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size / 3.6,
        background: '#fff',
        border: '1px solid #e4e8ee',
        display: 'grid',
        placeItems: 'center',
        flex: 'none',
        overflow: 'hidden',
      }}
    >
      <img
        src={logoUrl(domain)}
        alt=""
        width={Math.round(size * 0.6)}
        height={Math.round(size * 0.6)}
        style={{ objectFit: 'contain' }}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function StatusChip({ status }: { status: ServerRow['connectionStatus'] }) {
  const map: Record<ServerRow['connectionStatus'], { color: string; label: string }> = {
    connected: { color: 'green', label: 'Connected' },
    pending: { color: 'blue', label: 'Awaiting authorization' },
    needs_reauth: { color: 'orange', label: 'Needs reauthorization' },
    error: { color: 'red', label: 'Error' },
    disconnected: { color: 'default', label: 'Disconnected' },
  };
  const { color, label } = map[status];
  return <Tag color={color}>{label}</Tag>;
}

interface ConnectState {
  scope: Scope;
  endpoint: string;
  token: string;
}

export function McpServersCard() {
  const api = useApi();
  const qc = useQueryClient();
  const me = useMe();
  const { message, modal } = App.useApp();

  const isAdmin = Boolean(me.data && ROLE_RANK[me.data.role] >= ROLE_RANK.user_admin);
  const canUse = Boolean(me.data && ROLE_RANK[me.data.role] >= ROLE_RANK.standard_user);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | CatalogCategory>('all');
  const [drawerEntry, setDrawerEntry] = useState<CatalogEntry | null>(null);
  const [drawerServerId, setDrawerServerId] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectState>({ scope: 'user', endpoint: '', token: '' });
  const [customOpen, setCustomOpen] = useState(false);
  const [customForm] = Form.useForm();

  const catalog = useQuery<CatalogResponse>({
    queryKey: ['meri-mcp-catalog'],
    queryFn: async () => (await api.get<CatalogResponse>('/api/clio/mcp-catalog')).data,
    enabled: canUse,
  });
  const servers = useQuery<ServerRow[]>({
    queryKey: ['meri-mcp-servers'],
    queryFn: async () => (await api.get<ServerRow[]>('/api/clio/mcp-servers')).data,
    enabled: canUse,
  });

  const catalogById = useMemo(() => {
    const m = new Map<string, CatalogEntry>();
    for (const c of catalog.data?.connectors ?? []) m.set(c.id, c);
    return m;
  }, [catalog.data]);

  // Derive the managed row from live query data so the drawer reflects mutations
  // (toggle / save tools / disconnect / reconnect) without a stale snapshot.
  const drawerServer = useMemo(
    () => (servers.data ?? []).find((s) => s.id === drawerServerId) ?? null,
    [servers.data, drawerServerId],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['meri-mcp-servers'] });
    qc.invalidateQueries({ queryKey: ['meri-mcp-catalog'] });
  };

  // Surface the OAuth callback result (mirrors the Microsoft integration flow).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('provider') !== 'mcp') return;
    if (params.get('mcp_connected')) {
      message.success(`${params.get('mcp_connected')} connected`);
      invalidate();
    } else if (params.get('mcp_error')) {
      message.error(`Connection failed: ${params.get('mcp_error')}`);
    }
    const url = new URL(window.location.href);
    ['provider', 'mcp_connected', 'mcp_error'].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState({}, '', url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Returns true if it navigated to the provider; false if already authorized.
  const startOAuth = async (serverId: string): Promise<boolean> => {
    const { authUrl } = (
      await api.post<{ authUrl: string | null; alreadyConnected?: boolean }>(
        `/api/clio/mcp-servers/${serverId}/oauth/start`,
        {},
      )
    ).data;
    if (authUrl) {
      window.location.href = authUrl;
      return true;
    }
    message.success('Connector already authorized');
    invalidate();
    return false;
  };

  const addFromCatalog = useMutation({
    mutationFn: async (vars: { entry: CatalogEntry; state: ConnectState }) =>
      (
        await api.post<ServerRow & { oauthRequired: boolean }>(
          '/api/clio/mcp-servers/from-catalog',
          {
            catalogId: vars.entry.id,
            scope: vars.state.scope,
            ...(vars.entry.requiresEndpointInput || !vars.entry.endpoint
              ? { endpoint: vars.state.endpoint.trim() }
              : {}),
            ...(vars.entry.authType === 'token' ? { authToken: vars.state.token.trim() } : {}),
          },
        )
      ).data,
    onSuccess: async (data, vars) => {
      if (data.oauthRequired) {
        try {
          message.loading({ content: `Redirecting to ${vars.entry.name}…`, key: 'mcp-oauth' });
          const navigated = await startOAuth(data.id);
          if (!navigated) setDrawerEntry(null);
        } catch (e) {
          // Errors thrown in onSuccess don't route to onError — handle here so a
          // failed OAuth start surfaces instead of silently leaving 'pending'.
          message.error({ content: errorMessage(e), key: 'mcp-oauth' });
          invalidate();
        }
        return;
      }
      message.success(`${vars.entry.name} connected`);
      setDrawerEntry(null);
      invalidate();
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const addCustom = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await api.post<ServerRow>('/api/clio/mcp-servers', body)).data,
    onSuccess: async (data) => {
      if (data.authType === 'oauth') {
        try {
          message.loading({ content: 'Redirecting to authorize…', key: 'mcp-oauth' });
          await startOAuth(data.id);
          setCustomOpen(false);
          customForm.resetFields();
        } catch (e) {
          message.error({ content: errorMessage(e), key: 'mcp-oauth' });
          invalidate();
        }
        return;
      }
      message.success('Connector added');
      setCustomOpen(false);
      customForm.resetFields();
      invalidate();
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const patchServer = useMutation({
    mutationFn: async (vars: { id: string; body: Record<string, unknown> }) =>
      (await api.patch(`/api/clio/mcp-servers/${vars.id}`, vars.body)).data,
    onSuccess: () => invalidate(),
    onError: (err) => {
      message.error(errorMessage(err));
      invalidate();
    },
  });

  const disconnect = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/clio/mcp-servers/${id}/oauth/disconnect`, {})).data,
    onSuccess: () => {
      message.success('Disconnected');
      invalidate();
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/clio/mcp-servers/${id}`)).data,
    onSuccess: () => {
      message.success('Connector removed');
      setDrawerServerId(null);
      invalidate();
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  const refresh = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ tools: string[]; refreshedAt: string }>(
          '/api/clio/mcp-servers/refresh',
          {},
          { timeout: 60_000 },
        )
      ).data,
    onSuccess: (data) => {
      invalidate();
      message.success(
        `${data.tools.length} tool${data.tools.length === 1 ? '' : 's'} available to Meri`,
      );
    },
    onError: (err) => message.error(errorMessage(err)),
  });

  if (!canUse) return null;

  const openConnect = (entry: CatalogEntry) => {
    setDrawerServerId(null);
    setConnect({
      scope: !isAdmin ? 'user' : entry.defaultScope,
      endpoint: entry.endpoint ?? '',
      token: '',
    });
    setDrawerEntry(entry);
  };

  const filtered = (catalog.data?.connectors ?? []).filter(
    (c) =>
      (category === 'all' || c.category === category) &&
      c.name.toLowerCase().includes(search.toLowerCase().trim()),
  );

  const displayName = (s: ServerRow) =>
    (s.catalogId && catalogById.get(s.catalogId)?.name) || s.name;
  const tileFor = (s: ServerRow) => {
    const entry = s.catalogId ? catalogById.get(s.catalogId) : undefined;
    return {
      id: s.catalogId ?? undefined,
      color: entry?.brand.color ?? '#1c2e4a',
      glyph: entry?.brand.glyph ?? 'api',
    };
  };

  return (
    <section className="settings-integration-card" style={{ marginTop: 24, display: 'block' }}>
      <div className="settings-integration-top" style={{ marginBottom: 4 }}>
        <span className="settings-integration-icon">
          <ApiOutlined />
        </span>
        <div>
          <Typography.Text strong>Connectors</Typography.Text>
          <Typography.Text type="secondary">
            Connect Meri to external tools. Browse the library or add your own MCP server —
            connected tools become available to Meri across chat, research, and the workspace.
          </Typography.Text>
        </div>
      </div>

      {/* toolbar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
          margin: '16px 0',
        }}
      >
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: '#9aa3b2' }} />}
          placeholder="Search connectors…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: '1 1 240px', maxWidth: 320 }}
        />
        <Segmented
          value={category}
          onChange={(v) => setCategory(v as 'all' | CatalogCategory)}
          options={[
            { label: 'All', value: 'all' },
            ...Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ label, value })),
          ]}
        />
        <span style={{ flex: 1 }} />
        <Button icon={<PlusOutlined />} onClick={() => setCustomOpen(true)}>
          Add custom connector
        </Button>
      </div>

      {/* connected */}
      <ConnectedSection
        servers={servers.data ?? []}
        loading={servers.isLoading}
        displayName={displayName}
        tileFor={tileFor}
        onManage={(s) => {
          setDrawerEntry(null);
          setDrawerServerId(s.id);
        }}
        onReconnect={(s) => startOAuth(s.id).catch((e) => message.error(errorMessage(e)))}
        refreshing={refresh.isPending}
        onRefresh={() => refresh.mutate()}
      />

      {/* library */}
      <Typography.Text
        type="secondary"
        style={{
          display: 'block',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          fontSize: 12,
          fontWeight: 700,
          margin: '26px 0 12px',
        }}
      >
        Browse the library {catalog.data ? `· ${filtered.length}` : ''}
      </Typography.Text>
      {catalog.isLoading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))',
            gap: 14,
          }}
        >
          {filtered.map((entry) => (
            <CatalogCard key={entry.id} entry={entry} onClick={() => openConnect(entry)} />
          ))}
        </div>
      )}

      {/* connect drawer */}
      <Drawer
        width={460}
        open={Boolean(drawerEntry)}
        onClose={() => setDrawerEntry(null)}
        title={drawerEntry ? <DrawerTitle entry={drawerEntry} /> : null}
        styles={{ body: { paddingTop: 12 } }}
      >
        {drawerEntry && (
          <ConnectDrawerBody
            entry={drawerEntry}
            oauthConfigured={catalog.data?.oauthConfigured ?? false}
            isAdmin={isAdmin}
            state={connect}
            setState={setConnect}
            pending={addFromCatalog.isPending}
            onConnect={() => addFromCatalog.mutate({ entry: drawerEntry, state: connect })}
          />
        )}
      </Drawer>

      {/* manage drawer */}
      <Drawer
        width={460}
        open={Boolean(drawerServer)}
        onClose={() => setDrawerServerId(null)}
        title={
          drawerServer ? (
            <Space>
              <BrandTile {...tileFor(drawerServer)} size={32} />
              <span>{displayName(drawerServer)}</span>
            </Space>
          ) : null
        }
      >
        {drawerServer && (
          <ManageDrawerBody
            server={drawerServer}
            onToggleEnabled={(enabled) =>
              patchServer.mutate({ id: drawerServer.id, body: { enabled } })
            }
            onSaveTools={(toolAllowlist) =>
              patchServer.mutate({ id: drawerServer.id, body: { toolAllowlist } })
            }
            onReconnect={() =>
              startOAuth(drawerServer.id).catch((e) => message.error(errorMessage(e)))
            }
            onDisconnect={() => disconnect.mutate(drawerServer.id)}
            onRemove={() =>
              modal.confirm({
                title: `Remove "${displayName(drawerServer)}"?`,
                content: 'Meri loses access to this connector’s tools immediately.',
                okText: 'Remove',
                okButtonProps: { danger: true },
                onOk: () => remove.mutateAsync(drawerServer.id),
              })
            }
            saving={patchServer.isPending}
          />
        )}
      </Drawer>

      {/* custom connector modal */}
      <Modal
        title="Add a custom connector"
        open={customOpen}
        onCancel={() => setCustomOpen(false)}
        onOk={() => customForm.submit()}
        okText="Connect"
        confirmLoading={addCustom.isPending}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
          Point Meri at any remote MCP server. Only the tools you allowlist are exposed.
        </Typography.Paragraph>
        <Form
          form={customForm}
          layout="vertical"
          initialValues={{ authType: 'oauth', scope: isAdmin ? 'tenant' : 'user' }}
          onFinish={(v) => {
            const body: Record<string, unknown> = {
              name: String(v.name).trim(),
              transport: 'http',
              endpoint: String(v.endpoint).trim(),
              scope: v.scope,
              authType: v.authType,
              toolAllowlist: v.toolAllowlist ?? [],
            };
            if (v.authType === 'token' && v.authToken?.trim()) body.authToken = v.authToken.trim();
            addCustom.mutate(body);
          }}
        >
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true, message: 'Name is required' },
              {
                pattern: /^[a-z0-9][a-z0-9-_]{1,63}$/i,
                message: '2–64 chars, letters/numbers/-/_ only',
              },
            ]}
          >
            <Input placeholder="acme-research" />
          </Form.Item>
          <Form.Item
            name="endpoint"
            label="Server URL"
            rules={[
              { required: true, message: 'Server URL is required' },
              {
                validator: (_r, value: string | undefined) =>
                  !value || /^https:\/\//i.test(value.trim())
                    ? Promise.resolve()
                    : Promise.reject(new Error('Must use https://')),
              },
            ]}
          >
            <Input placeholder="https://mcp.example.com/mcp" />
          </Form.Item>
          <Form.Item name="authType" label="Authentication">
            <Select
              options={[
                { value: 'oauth', label: 'OAuth 2.1 — auto-discover (recommended)' },
                { value: 'token', label: 'API key / Bearer token' },
                { value: 'none', label: 'None (public server)' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.authType !== c.authType}>
            {({ getFieldValue }) =>
              getFieldValue('authType') === 'token' ? (
                <Form.Item
                  name="authToken"
                  label="Token"
                  rules={[{ required: true, message: 'Token is required' }]}
                  extra="Stored encrypted (AES-256-GCM). Write-only."
                >
                  <Input.Password placeholder="••••••••" autoComplete="new-password" />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item
            name="toolAllowlist"
            label="Tool allowlist"
            tooltip="Only these tool names register with Meri. Leave empty and edit after discovery."
          >
            <Select mode="tags" placeholder="Type a tool name and press Enter" open={false} />
          </Form.Item>
          <Form.Item name="scope" label="Who can use this connection?">
            <Segmented
              options={[
                { label: 'Just me', value: 'user' },
                { label: 'Entire firm', value: 'tenant', disabled: !isAdmin },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

// ── sub-components ──────────────────────────────────────────────────────────

function CatalogCard({ entry, onClick }: { entry: CatalogEntry; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: '#fff',
        border: '1px solid #e4e8ee',
        borderRadius: 14,
        padding: 16,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 11,
        font: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <BrandTile id={entry.id} color={entry.brand.color} glyph={entry.brand.glyph} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong>{entry.name}</Typography.Text>
        </div>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12.8, minHeight: 36 }}>
        {entry.description}
      </Typography.Text>
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <Space size={4} wrap>
          <Tag style={{ marginInlineEnd: 0 }}>{CATEGORY_LABELS[entry.category]}</Tag>
          <Tag style={{ marginInlineEnd: 0 }}>{AUTH_LABEL[entry.authType]}</Tag>
          {entry.verified && (
            <Tooltip title="Curated and reviewed by Capiro">
              <Tag color="blue" style={{ marginInlineEnd: 0 }} icon={<SafetyCertificateFilled />}>
                Verified
              </Tag>
            </Tooltip>
          )}
        </Space>
        {entry.connected ? (
          <Tag color="green" style={{ marginInlineEnd: 0 }}>
            Added
          </Tag>
        ) : (
          <span style={{ color: '#1c2e4a', fontWeight: 600, fontSize: 13 }}>Connect</span>
        )}
      </div>
    </button>
  );
}

function ConnectedSection({
  servers,
  loading,
  displayName,
  tileFor,
  onManage,
  onReconnect,
  refreshing,
  onRefresh,
}: {
  servers: ServerRow[];
  loading: boolean;
  displayName: (s: ServerRow) => string;
  tileFor: (s: ServerRow) => { id?: string; color: string; glyph: string };
  onManage: (s: ServerRow) => void;
  onReconnect: (s: ServerRow) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (loading) return <Spin />;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Typography.Text
          type="secondary"
          style={{
            textTransform: 'uppercase',
            letterSpacing: '.06em',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          Connected · {servers.length}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={refreshing}
          disabled={!servers.some((s) => s.enabled)}
          onClick={onRefresh}
        >
          Refresh tools
        </Button>
      </div>
      {servers.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No connectors yet — connect one from the library below."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {servers.map((s) => {
            const needsAuth =
              s.connectionStatus === 'needs_reauth' || s.connectionStatus === 'pending';
            return (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  background: '#fff',
                  border: '1px solid #e4e8ee',
                  borderRadius: 14,
                  padding: '12px 16px',
                }}
              >
                <BrandTile {...tileFor(s)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Typography.Text strong>{displayName(s)}</Typography.Text>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {[
                        `${s.toolAllowlist?.length ?? 0} tools`,
                        s.scope === 'tenant' ? 'Firm-wide' : 'Personal',
                        s.lastError
                          ? s.lastError.slice(0, 60)
                          : s.lastSyncAt
                            ? `Synced ${formatDateTime(s.lastSyncAt)}`
                            : 'Not synced yet',
                      ].join(' · ')}
                    </Typography.Text>
                  </div>
                </div>
                <Space>
                  <StatusChip status={s.connectionStatus} />
                  {s.canManage && s.authType === 'oauth' && needsAuth && (
                    <Button size="small" type="primary" onClick={() => onReconnect(s)}>
                      {s.connectionStatus === 'pending' ? 'Authorize' : 'Reconnect'}
                    </Button>
                  )}
                  {s.canManage && (
                    <Button size="small" onClick={() => onManage(s)}>
                      Manage
                    </Button>
                  )}
                </Space>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DrawerTitle({ entry }: { entry: CatalogEntry }) {
  return (
    <Space align="start">
      <BrandTile id={entry.id} color={entry.brand.color} glyph={entry.brand.glyph} size={36} />
      <div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{entry.name}</div>
        <Space size={4} style={{ marginTop: 2 }}>
          <Tag style={{ marginInlineEnd: 0 }}>{CATEGORY_LABELS[entry.category]}</Tag>
          <Tag style={{ marginInlineEnd: 0 }}>{AUTH_LABEL[entry.authType]}</Tag>
          {entry.verified && (
            <Tag color="blue" style={{ marginInlineEnd: 0 }} icon={<SafetyCertificateFilled />}>
              Verified
            </Tag>
          )}
        </Space>
      </div>
    </Space>
  );
}

function ConnectDrawerBody({
  entry,
  oauthConfigured,
  isAdmin,
  state,
  setState,
  pending,
  onConnect,
}: {
  entry: CatalogEntry;
  oauthConfigured: boolean;
  isAdmin: boolean;
  state: ConnectState;
  setState: (s: ConnectState) => void;
  pending: boolean;
  onConnect: () => void;
}) {
  const needsEndpoint =
    entry.transport === 'http' && (entry.requiresEndpointInput || !entry.endpoint);
  const oauthBlocked = entry.authType === 'oauth' && !oauthConfigured;
  const canConnect =
    !oauthBlocked &&
    (!needsEndpoint || /^https:\/\//i.test(state.endpoint.trim())) &&
    (entry.authType !== 'token' || state.token.trim().length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        {entry.longDescription}
      </Typography.Paragraph>

      {entry.setupNote && (
        <div
          style={{
            display: 'flex',
            gap: 9,
            fontSize: 12.5,
            color: '#475569',
            background: '#f1f4f8',
            borderRadius: 9,
            padding: '10px 12px',
          }}
        >
          <ApiOutlined style={{ marginTop: 2 }} />
          <span>{entry.setupNote}</span>
        </div>
      )}

      <Section label={`Tools Meri will get (${entry.suggestedTools.length})`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {entry.suggestedTools.map((t) => (
            <div key={t.name} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <Typography.Text code>{t.name}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t.description}
              </Typography.Text>
              {t.readOnly && <Tag style={{ marginLeft: 'auto', fontSize: 10 }}>read-only</Tag>}
            </div>
          ))}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          Only allowlisted tools are exposed to Meri (fail-closed). You can change these after
          connecting.
        </Typography.Text>
      </Section>

      {needsEndpoint && (
        <Section label="Server URL">
          <Input
            placeholder="https://mcp.example.com/mcp"
            value={state.endpoint}
            onChange={(e) => setState({ ...state, endpoint: e.target.value })}
          />
        </Section>
      )}

      {entry.authType === 'token' && (
        <Section label="API key">
          <Input.Password
            placeholder="••••••••"
            autoComplete="new-password"
            value={state.token}
            onChange={(e) => setState({ ...state, token: e.target.value })}
          />
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            Stored encrypted (AES-256-GCM), write-only.
          </Typography.Text>
        </Section>
      )}

      {oauthBlocked && (
        <Typography.Text type="warning" style={{ fontSize: 12.5 }}>
          OAuth isn’t configured on this server yet (set CLIO_MCP_OAUTH_REDIRECT_URI). Ask your
          platform admin to enable it.
        </Typography.Text>
      )}

      <Section label="Who can use this connection?">
        <Segmented
          block
          value={state.scope}
          onChange={(v) => setState({ ...state, scope: v as Scope })}
          options={[
            { label: 'Just me', value: 'user' },
            { label: 'Entire firm', value: 'tenant', disabled: !isAdmin },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {state.scope === 'user'
            ? 'A personal connection, private to your account.'
            : 'Shared with every Meri user in your firm.'}
        </Typography.Text>
      </Section>

      <Button
        type="primary"
        size="large"
        block
        loading={pending}
        disabled={!canConnect}
        onClick={onConnect}
      >
        {entry.authType === 'oauth' ? (
          <>
            <LinkOutlined /> Connect {entry.name}
          </>
        ) : (
          'Connect & enable tools'
        )}
      </Button>
    </div>
  );
}

function ManageDrawerBody({
  server,
  onToggleEnabled,
  onSaveTools,
  onReconnect,
  onDisconnect,
  onRemove,
  saving,
}: {
  server: ServerRow;
  onToggleEnabled: (enabled: boolean) => void;
  onSaveTools: (tools: string[]) => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  saving: boolean;
}) {
  const [tools, setTools] = useState<string[]>(server.toolAllowlist ?? []);
  useEffect(() => setTools(server.toolAllowlist ?? []), [server.id, server.toolAllowlist]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <Space>
        <StatusChip status={server.connectionStatus} />
        <Tag>{server.scope === 'tenant' ? 'Firm-wide' : 'Personal'}</Tag>
        <Tag>{AUTH_LABEL[server.authType]}</Tag>
      </Space>

      {server.lastError && (
        <Typography.Text type="danger" style={{ fontSize: 12.5 }}>
          {server.lastError}
        </Typography.Text>
      )}

      <Section label="Enabled">
        <Space>
          <Switch
            checked={server.enabled}
            loading={saving}
            onChange={onToggleEnabled}
            aria-label="Enable connector"
          />
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            {server.enabled ? 'Meri can use this connector' : 'Paused — tools hidden from Meri'}
          </Typography.Text>
        </Space>
      </Section>

      <Section label="Tool allowlist">
        <Select
          mode="tags"
          open={false}
          value={tools}
          onChange={setTools}
          style={{ width: '100%' }}
          placeholder="Tool names exposed to Meri"
        />
        <Button
          size="small"
          type="primary"
          style={{ marginTop: 8 }}
          loading={saving}
          onClick={() => onSaveTools(tools)}
        >
          Save tools
        </Button>
      </Section>

      <Section label="Connection">
        <Space wrap>
          {server.authType === 'oauth' && (
            <>
              <Button icon={<LinkOutlined />} onClick={onReconnect}>
                {server.connectionStatus === 'connected' ? 'Re-authorize' : 'Connect'}
              </Button>
              {server.connectionStatus !== 'disconnected' && (
                <Button icon={<DisconnectOutlined />} onClick={onDisconnect}>
                  Disconnect
                </Button>
              )}
            </>
          )}
          <Button danger icon={<DeleteOutlined />} onClick={onRemove}>
            Remove connector
          </Button>
        </Space>
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Typography.Text
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: '#6B7280',
        }}
      >
        {label}
      </Typography.Text>
      {children}
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
