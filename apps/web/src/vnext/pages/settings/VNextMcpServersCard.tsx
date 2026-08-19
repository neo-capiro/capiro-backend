/**
 * vNext re-skin of pages/settings/McpServersCard.tsx (connector-library v1) —
 * identical endpoints, query keys, OAuth start/callback flows, catalog
 * filtering, scope rules and copy. The Claude-style connector library for
 * Meri: browse a curated catalog or add a custom MCP server, connect with one
 * click (OAuth where supported, API key otherwise), and manage connected
 * tools. Personal connectors are private to the user; firm-wide connectors are
 * admin-managed. Secrets are write-only.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bug,
  CheckSquare,
  Code,
  Contact,
  CreditCard,
  Database,
  FileText,
  Folder,
  Globe,
  Link as LinkIcon,
  MessageSquare,
  Plug,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
  Unplug,
} from 'lucide-react';
import { ROLE_RANK } from '@capiro/shared';
import { useMe } from '../../../lib/me.js';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { CapiroTooltip } from '../../components/menus/index.js';
import { CapiroDrawer, CapiroModal } from '../../components/overlays/index.js';
import { SvSegmented, SvSwitch, SvTagInput, useSvConfirm } from './settings-ui.js';

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
  oauthClientMode?: 'dynamic' | 'manual';
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
  oauthRedirectUri: string | null;
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
  folder: <Folder size={18} />,
  note: <FileText size={18} />,
  search: <Search size={18} />,
  browser: <Globe size={18} />,
  contacts: <Contact size={18} />,
  database: <Database size={18} />,
  card: <CreditCard size={18} />,
  task: <CheckSquare size={18} />,
  code: <Code size={18} />,
  bug: <Bug size={18} />,
  chat: <MessageSquare size={18} />,
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
      className="stv-tile"
      style={{ width: size, height: size, borderRadius: size / 3.6, background: color }}
    >
      {GLYPHS[glyph] ?? <Plug size={18} />}
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
      className="stv-tile stv-tile--logo"
      style={{ width: size, height: size, borderRadius: size / 3.6 }}
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
  const map: Record<ServerRow['connectionStatus'], { tone: CapiroBadgeTone; label: string }> = {
    connected: { tone: 'success', label: 'Connected' },
    pending: { tone: 'info', label: 'Awaiting authorization' },
    needs_reauth: { tone: 'warning', label: 'Needs reauthorization' },
    error: { tone: 'danger', label: 'Error' },
    disconnected: { tone: 'neutral', label: 'Disconnected' },
  };
  const { tone, label } = map[status];
  return <CapiroBadge tone={tone}>{label}</CapiroBadge>;
}

interface ConnectState {
  scope: Scope;
  endpoint: string;
  token: string;
  clientId: string;
  clientSecret: string;
}

interface CustomFormState {
  name: string;
  endpoint: string;
  authType: AuthType;
  authToken: string;
  oauthClientId: string;
  oauthClientSecret: string;
  toolAllowlist: string[];
  scope: Scope;
}

export function VNextMcpServersCard() {
  const api = useApi();
  const qc = useQueryClient();
  const me = useMe();
  const toast = useCapiroToast();
  const { confirm, dialog } = useSvConfirm();

  const isAdmin = Boolean(me.data && ROLE_RANK[me.data.role] >= ROLE_RANK.user_admin);
  const canUse = Boolean(me.data && ROLE_RANK[me.data.role] >= ROLE_RANK.standard_user);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | CatalogCategory>('all');
  const [drawerEntry, setDrawerEntry] = useState<CatalogEntry | null>(null);
  const [drawerServerId, setDrawerServerId] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectState>({
    scope: 'user',
    endpoint: '',
    token: '',
    clientId: '',
    clientSecret: '',
  });
  const [customOpen, setCustomOpen] = useState(false);
  const [customForm, setCustomForm] = useState<CustomFormState>({
    name: '',
    endpoint: '',
    authType: 'oauth',
    authToken: '',
    oauthClientId: '',
    oauthClientSecret: '',
    toolAllowlist: [],
    scope: 'user',
  });
  const [customErrors, setCustomErrors] = useState<Partial<Record<keyof CustomFormState, string>>>(
    {},
  );

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
      toast.success(`${params.get('mcp_connected')} connected`);
      invalidate();
    } else if (params.get('mcp_error')) {
      toast.error(`Connection failed: ${params.get('mcp_error')}`);
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
    toast.success('Connector already authorized');
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
            ...(vars.entry.oauthClientMode === 'manual'
              ? {
                  oauthClientId: vars.state.clientId.trim(),
                  oauthClientSecret: vars.state.clientSecret.trim(),
                }
              : {}),
          },
        )
      ).data,
    onSuccess: async (data, vars) => {
      if (data.oauthRequired) {
        try {
          const navigated = await startOAuth(data.id);
          if (!navigated) setDrawerEntry(null);
        } catch (e) {
          // Errors thrown in onSuccess don't route to onError — handle here so a
          // failed OAuth start surfaces instead of silently leaving 'pending'.
          toast.error(errorMessage(e));
          invalidate();
        }
        return;
      }
      toast.success(`${vars.entry.name} connected`);
      setDrawerEntry(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const addCustom = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await api.post<ServerRow>('/api/clio/mcp-servers', body)).data,
    onSuccess: async (data) => {
      if (data.authType === 'oauth') {
        try {
          await startOAuth(data.id);
          setCustomOpen(false);
        } catch (e) {
          toast.error(errorMessage(e));
          invalidate();
        }
        return;
      }
      toast.success('Connector added');
      setCustomOpen(false);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const patchServer = useMutation({
    mutationFn: async (vars: { id: string; body: Record<string, unknown> }) =>
      (await api.patch(`/api/clio/mcp-servers/${vars.id}`, vars.body)).data,
    onSuccess: () => invalidate(),
    onError: (err) => {
      toast.error(errorMessage(err));
      invalidate();
    },
  });

  const disconnect = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/clio/mcp-servers/${id}/oauth/disconnect`, {})).data,
    onSuccess: () => {
      toast.success('Disconnected');
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/clio/mcp-servers/${id}`)).data,
    onSuccess: () => {
      toast.success('Connector removed');
      setDrawerServerId(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
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
      toast.success(
        `${data.tools.length} tool${data.tools.length === 1 ? '' : 's'} available to Meri`,
      );
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!canUse) return null;

  const openConnect = (entry: CatalogEntry) => {
    setDrawerServerId(null);
    setConnect({
      scope: !isAdmin ? 'user' : entry.defaultScope,
      endpoint: entry.endpoint ?? '',
      token: '',
      clientId: '',
      clientSecret: '',
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
      color: entry?.brand.color ?? 'var(--capiro-color-bg-dark)',
      glyph: entry?.brand.glyph ?? 'api',
    };
  };

  const submitCustom = () => {
    const errors: Partial<Record<keyof CustomFormState, string>> = {};
    const name = customForm.name.trim();
    if (!name) errors.name = 'Name is required';
    else if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(name))
      errors.name = '2–64 chars, letters/numbers/-/_ only';
    const endpoint = customForm.endpoint.trim();
    if (!endpoint) errors.endpoint = 'Server URL is required';
    else if (!/^https:\/\//i.test(endpoint)) errors.endpoint = 'Must use https://';
    if (customForm.authType === 'token' && !customForm.authToken.trim())
      errors.authToken = 'Token is required';
    setCustomErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const body: Record<string, unknown> = {
      name,
      transport: 'http',
      endpoint,
      scope: customForm.scope,
      authType: customForm.authType,
      toolAllowlist: customForm.toolAllowlist,
    };
    if (customForm.authType === 'token' && customForm.authToken.trim())
      body.authToken = customForm.authToken.trim();
    if (
      customForm.authType === 'oauth' &&
      customForm.oauthClientId.trim() &&
      customForm.oauthClientSecret.trim()
    ) {
      body.oauthClientId = customForm.oauthClientId.trim();
      body.oauthClientSecret = customForm.oauthClientSecret.trim();
    }
    addCustom.mutate(body);
  };

  return (
    <section className="stv-card" aria-label="Connectors">
      <div className="stv-integration-top" style={{ marginBottom: 4 }}>
        <span className="stv-integration-icon">
          <Plug size={20} />
        </span>
        <div>
          <div className="stv-strong">Connectors</div>
          <div className="stv-muted stv-small">
            Connect Meri to external tools. Browse the library or add your own MCP server —
            connected tools become available to Meri across chat, research, and the workspace.
          </div>
        </div>
      </div>

      {/* toolbar */}
      <div className="stv-row" style={{ margin: '16px 0' }}>
        <span style={{ flex: '1 1 240px', maxWidth: 320 }}>
          <CapiroInput
            label="Search connectors"
            placeholder="Search connectors…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </span>
        <SvSegmented
          aria-label="Connector category"
          value={category}
          onChange={(v) => setCategory(v)}
          options={[
            { label: 'All', value: 'all' as const },
            ...(Object.entries(CATEGORY_LABELS) as Array<[CatalogCategory, string]>).map(
              ([value, label]) => ({ label, value }),
            ),
          ]}
        />
        <span className="stv-spacer" />
        <CapiroButton leadingIcon={<Plus size={14} />} onClick={() => setCustomOpen(true)}>
          Add custom connector
        </CapiroButton>
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
        onReconnect={(s) => startOAuth(s.id).catch((e) => toast.error(errorMessage(e)))}
        refreshing={refresh.isPending}
        onRefresh={() => refresh.mutate()}
      />

      {/* library */}
      <p className="stv-subhead" style={{ margin: '26px 0 12px' }}>
        Browse the library {catalog.data ? `· ${filtered.length}` : ''}
      </p>
      {catalog.isLoading ? (
        <div className="stv-stack" aria-label="Loading connector catalog">
          <CapiroSkeleton height={16} />
          <CapiroSkeleton height={16} width="70%" />
        </div>
      ) : (
        <div className="stv-catalog-grid">
          {filtered.map((entry) => (
            <CatalogCard key={entry.id} entry={entry} onClick={() => openConnect(entry)} />
          ))}
        </div>
      )}

      {/* connect drawer */}
      <CapiroDrawer
        open={Boolean(drawerEntry)}
        title={drawerEntry ? drawerEntry.name : 'Connect'}
        onClose={() => setDrawerEntry(null)}
      >
        {drawerEntry && (
          <>
            <DrawerTitle entry={drawerEntry} />
            <ConnectDrawerBody
              entry={drawerEntry}
              oauthConfigured={catalog.data?.oauthConfigured ?? false}
              oauthRedirectUri={catalog.data?.oauthRedirectUri ?? null}
              isAdmin={isAdmin}
              state={connect}
              setState={setConnect}
              pending={addFromCatalog.isPending}
              onConnect={() => addFromCatalog.mutate({ entry: drawerEntry, state: connect })}
            />
          </>
        )}
      </CapiroDrawer>

      {/* manage drawer */}
      <CapiroDrawer
        open={Boolean(drawerServer)}
        title={drawerServer ? displayName(drawerServer) : 'Manage connector'}
        onClose={() => setDrawerServerId(null)}
      >
        {drawerServer && (
          <ManageDrawerBody
            server={drawerServer}
            tile={<BrandTile {...tileFor(drawerServer)} size={32} />}
            onToggleEnabled={(enabled) =>
              patchServer.mutate({ id: drawerServer.id, body: { enabled } })
            }
            onSaveTools={(toolAllowlist) =>
              patchServer.mutate({ id: drawerServer.id, body: { toolAllowlist } })
            }
            onReconnect={() =>
              startOAuth(drawerServer.id).catch((e) => toast.error(errorMessage(e)))
            }
            onDisconnect={() => disconnect.mutate(drawerServer.id)}
            onRemove={() =>
              confirm({
                title: `Remove "${displayName(drawerServer)}"?`,
                body: 'Meri loses access to this connector’s tools immediately.',
                okText: 'Remove',
                danger: true,
                onOk: () => remove.mutateAsync(drawerServer.id),
              })
            }
            saving={patchServer.isPending}
          />
        )}
      </CapiroDrawer>

      {/* custom connector modal */}
      {customOpen ? (
        <CapiroModal open title="Add a custom connector" onClose={() => setCustomOpen(false)}>
          <div className="stv-stack">
            <p className="stv-muted" style={{ margin: 0 }}>
              Point Meri at any remote MCP server. Only the tools you allowlist are exposed.
            </p>
            <CapiroInput
              label="Name"
              placeholder="acme-research"
              error={customErrors.name}
              value={customForm.name}
              onChange={(e) => setCustomForm((c) => ({ ...c, name: e.target.value }))}
            />
            <CapiroInput
              label="Server URL"
              placeholder="https://mcp.example.com/mcp"
              error={customErrors.endpoint}
              value={customForm.endpoint}
              onChange={(e) => setCustomForm((c) => ({ ...c, endpoint: e.target.value }))}
            />
            <CapiroSelect
              label="Authentication"
              value={customForm.authType}
              onChange={(e) =>
                setCustomForm((c) => ({ ...c, authType: e.target.value as AuthType }))
              }
              options={[
                { value: 'oauth', label: 'OAuth 2.1 — auto-discover (recommended)' },
                { value: 'token', label: 'API key / Bearer token' },
                { value: 'none', label: 'None (public server)' },
              ]}
            />
            {customForm.authType === 'token' ? (
              <CapiroInput
                label="Token"
                type="password"
                placeholder="••••••••"
                autoComplete="new-password"
                error={customErrors.authToken}
                helpText="Stored encrypted (AES-256-GCM). Write-only."
                value={customForm.authToken}
                onChange={(e) => setCustomForm((c) => ({ ...c, authToken: e.target.value }))}
              />
            ) : null}
            {customForm.authType === 'oauth' ? (
              <>
                <CapiroInput
                  label="OAuth client ID (optional)"
                  placeholder="client id"
                  helpText="Only if the server requires a pre-registered app (no dynamic registration)."
                  value={customForm.oauthClientId}
                  onChange={(e) => setCustomForm((c) => ({ ...c, oauthClientId: e.target.value }))}
                />
                <CapiroInput
                  label="OAuth client secret (optional)"
                  type="password"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  value={customForm.oauthClientSecret}
                  onChange={(e) =>
                    setCustomForm((c) => ({ ...c, oauthClientSecret: e.target.value }))
                  }
                />
              </>
            ) : null}
            <div>
              <span className="capiro-field__label" style={{ display: 'block', marginBottom: 6 }}>
                Tool allowlist
              </span>
              <SvTagInput
                value={customForm.toolAllowlist}
                onChange={(toolAllowlist) => setCustomForm((c) => ({ ...c, toolAllowlist }))}
                placeholder="Type a tool name and press Enter"
                aria-label="Tool allowlist"
              />
              <span className="capiro-field__help">
                Only these tool names register with Meri. Leave empty and edit after discovery.
              </span>
            </div>
            <div>
              <span className="capiro-field__label" style={{ display: 'block', marginBottom: 6 }}>
                Who can use this connection?
              </span>
              <SvSegmented
                aria-label="Connector scope"
                value={customForm.scope}
                onChange={(scope) => setCustomForm((c) => ({ ...c, scope }))}
                options={[
                  { label: 'Just me', value: 'user' as const },
                  { label: 'Entire firm', value: 'tenant' as const, disabled: !isAdmin },
                ]}
              />
            </div>
            <div className="stv-row stv-row--end">
              <CapiroButton onClick={() => setCustomOpen(false)}>Cancel</CapiroButton>
              <CapiroButton variant="primary" loading={addCustom.isPending} onClick={submitCustom}>
                Connect
              </CapiroButton>
            </div>
          </div>
        </CapiroModal>
      ) : null}

      {dialog}
    </section>
  );
}

// ── sub-components ──────────────────────────────────────────────────────────

function CatalogCard({ entry, onClick }: { entry: CatalogEntry; onClick: () => void }) {
  return (
    <button type="button" className="stv-catalog-card" onClick={onClick}>
      <div className="stv-row stv-row--start" style={{ gap: 12, flexWrap: 'nowrap' }}>
        <BrandTile id={entry.id} color={entry.brand.color} glyph={entry.brand.glyph} />
        <span className="stv-strong" style={{ flex: 1, minWidth: 0 }}>
          {entry.name}
        </span>
      </div>
      <span className="stv-muted stv-small" style={{ minHeight: 36 }}>
        {entry.description}
      </span>
      <div className="stv-row stv-row--between">
        <span className="stv-row" style={{ gap: 4 }}>
          <CapiroBadge>{CATEGORY_LABELS[entry.category]}</CapiroBadge>
          <CapiroBadge>{AUTH_LABEL[entry.authType]}</CapiroBadge>
          {entry.verified && (
            <CapiroTooltip content="Curated and reviewed by Capiro">
              <CapiroBadge tone="info">Verified</CapiroBadge>
            </CapiroTooltip>
          )}
        </span>
        {entry.connected ? (
          <CapiroBadge tone="success">Added</CapiroBadge>
        ) : (
          <span className="stv-strong" style={{ fontSize: 13 }}>
            Connect
          </span>
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
  if (loading) {
    return (
      <div className="stv-stack" aria-label="Loading connectors">
        <CapiroSkeleton height={16} />
        <CapiroSkeleton height={16} width="70%" />
      </div>
    );
  }
  return (
    <div>
      <div className="stv-row" style={{ marginBottom: 12 }}>
        <span className="stv-subhead" style={{ margin: 0 }}>
          Connected · {servers.length}
        </span>
        <span className="stv-spacer" />
        <CapiroButton
          size="compact"
          leadingIcon={<RefreshCcw size={13} />}
          loading={refreshing}
          disabled={!servers.some((s) => s.enabled)}
          onClick={onRefresh}
        >
          Refresh tools
        </CapiroButton>
      </div>
      {servers.length === 0 ? (
        <CapiroEmptyState title="No connectors yet — connect one from the library below." />
      ) : (
        <div className="stv-stack stv-stack--tight" style={{ gap: 10 }}>
          {servers.map((s) => {
            const needsAuth =
              s.connectionStatus === 'needs_reauth' || s.connectionStatus === 'pending';
            return (
              <div key={s.id} className="stv-server-row">
                <BrandTile {...tileFor(s)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="stv-strong">{displayName(s)}</span>
                  <div className="stv-muted stv-small">
                    {[
                      `${s.toolAllowlist?.length ?? 0} tools`,
                      s.scope === 'tenant' ? 'Firm-wide' : 'Personal',
                      s.lastError
                        ? s.lastError.slice(0, 60)
                        : s.lastSyncAt
                          ? `Synced ${formatDateTime(s.lastSyncAt)}`
                          : 'Not synced yet',
                    ].join(' · ')}
                  </div>
                </div>
                <div className="stv-row" style={{ gap: 6 }}>
                  <StatusChip status={s.connectionStatus} />
                  {s.canManage && s.authType === 'oauth' && needsAuth && (
                    <CapiroButton size="compact" variant="primary" onClick={() => onReconnect(s)}>
                      {s.connectionStatus === 'pending' ? 'Authorize' : 'Reconnect'}
                    </CapiroButton>
                  )}
                  {s.canManage && (
                    <CapiroButton size="compact" onClick={() => onManage(s)}>
                      Manage
                    </CapiroButton>
                  )}
                </div>
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
    <div className="stv-row stv-row--start" style={{ marginBottom: 16 }}>
      <BrandTile id={entry.id} color={entry.brand.color} glyph={entry.brand.glyph} size={36} />
      <div>
        <div className="stv-row" style={{ gap: 4, marginTop: 2 }}>
          <CapiroBadge>{CATEGORY_LABELS[entry.category]}</CapiroBadge>
          <CapiroBadge>{AUTH_LABEL[entry.authType]}</CapiroBadge>
          {entry.verified && <CapiroBadge tone="info">Verified</CapiroBadge>}
        </div>
      </div>
    </div>
  );
}

function ConnectDrawerBody({
  entry,
  oauthConfigured,
  oauthRedirectUri,
  isAdmin,
  state,
  setState,
  pending,
  onConnect,
}: {
  entry: CatalogEntry;
  oauthConfigured: boolean;
  oauthRedirectUri: string | null;
  isAdmin: boolean;
  state: ConnectState;
  setState: (s: ConnectState) => void;
  pending: boolean;
  onConnect: () => void;
}) {
  const needsEndpoint =
    entry.transport === 'http' && (entry.requiresEndpointInput || !entry.endpoint);
  const oauthBlocked = entry.authType === 'oauth' && !oauthConfigured;
  // Manual-client connectors need an admin-supplied OAuth app (client id/secret).
  const manualClient = entry.authType === 'oauth' && entry.oauthClientMode === 'manual';
  const canConnect =
    !oauthBlocked &&
    (!needsEndpoint || /^https:\/\//i.test(state.endpoint.trim())) &&
    (entry.authType !== 'token' || state.token.trim().length > 0) &&
    (!manualClient || (state.clientId.trim().length > 0 && state.clientSecret.trim().length > 0));

  return (
    <div className="stv-stack" style={{ gap: 22 }}>
      <p style={{ margin: 0 }}>{entry.longDescription}</p>

      {entry.setupNote && (
        <div className="stv-callout stv-callout--info">
          <span className="stv-callout__desc">{entry.setupNote}</span>
        </div>
      )}

      <Section label={`Tools Meri will get (${entry.suggestedTools.length})`}>
        <div className="stv-stack stv-stack--tight" style={{ gap: 6 }}>
          {entry.suggestedTools.map((t) => (
            <div key={t.name} className="stv-row stv-row--start" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <code className="stv-code">{t.name}</code>
              <span className="stv-muted stv-small">{t.description}</span>
              {t.readOnly && (
                <CapiroBadge style={{ marginLeft: 'auto' }}>read-only</CapiroBadge>
              )}
            </div>
          ))}
        </div>
        <span className="stv-muted stv-small">
          Only allowlisted tools are exposed to Meri (fail-closed). You can change these after
          connecting.
        </span>
      </Section>

      {needsEndpoint && (
        <Section label="Server URL">
          <CapiroInput
            label="Server URL"
            placeholder="https://mcp.example.com/mcp"
            value={state.endpoint}
            onChange={(e) => setState({ ...state, endpoint: e.target.value })}
          />
        </Section>
      )}

      {entry.authType === 'token' && (
        <Section label="API key">
          <CapiroInput
            label="API key"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            value={state.token}
            onChange={(e) => setState({ ...state, token: e.target.value })}
          />
          <span className="stv-muted stv-small">Stored encrypted (AES-256-GCM), write-only.</span>
        </Section>
      )}

      {manualClient && !oauthBlocked && (
        <Section label="OAuth app credentials">
          {oauthRedirectUri && (
            <div className="stv-callout stv-callout--info">
              <span className="stv-callout__desc">
                Add this redirect URL to your app:
                <code className="stv-code" style={{ display: 'block', marginTop: 4 }}>
                  {oauthRedirectUri}
                </code>
              </span>
            </div>
          )}
          <CapiroInput
            label="Client ID"
            placeholder="Client ID"
            value={state.clientId}
            onChange={(e) => setState({ ...state, clientId: e.target.value })}
          />
          <CapiroInput
            label="Client secret"
            type="password"
            placeholder="Client secret"
            autoComplete="new-password"
            value={state.clientSecret}
            onChange={(e) => setState({ ...state, clientSecret: e.target.value })}
          />
          <span className="stv-muted stv-small">
            From the app you created in {entry.name}. Stored encrypted (AES-256-GCM), write-only.
          </span>
        </Section>
      )}

      {oauthBlocked && (
        <span className="stv-warning-text stv-small">
          OAuth isn’t configured on this server yet (set CLIO_MCP_OAUTH_REDIRECT_URI). Ask your
          platform admin to enable it.
        </span>
      )}

      <Section label="Who can use this connection?">
        <SvSegmented
          block
          aria-label="Connection scope"
          value={state.scope}
          onChange={(scope) => setState({ ...state, scope })}
          options={[
            { label: 'Just me', value: 'user' as const },
            { label: 'Entire firm', value: 'tenant' as const, disabled: !isAdmin },
          ]}
        />
        <span className="stv-muted stv-small">
          {state.scope === 'user'
            ? 'A personal connection, private to your account.'
            : 'Shared with every Meri user in your firm.'}
        </span>
      </Section>

      <CapiroButton
        variant="primary"
        loading={pending}
        disabled={!canConnect}
        onClick={onConnect}
        leadingIcon={entry.authType === 'oauth' ? <LinkIcon size={14} /> : undefined}
      >
        {entry.authType === 'oauth' ? `Connect ${entry.name}` : 'Connect & enable tools'}
      </CapiroButton>
    </div>
  );
}

function ManageDrawerBody({
  server,
  tile,
  onToggleEnabled,
  onSaveTools,
  onReconnect,
  onDisconnect,
  onRemove,
  saving,
}: {
  server: ServerRow;
  tile: ReactNode;
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
    <div className="stv-stack" style={{ gap: 22 }}>
      <div className="stv-row">
        {tile}
        <StatusChip status={server.connectionStatus} />
        <CapiroBadge>{server.scope === 'tenant' ? 'Firm-wide' : 'Personal'}</CapiroBadge>
        <CapiroBadge>{AUTH_LABEL[server.authType]}</CapiroBadge>
      </div>

      {server.lastError && <span className="stv-danger-text stv-small">{server.lastError}</span>}

      <Section label="Enabled">
        <div className="stv-row">
          <SvSwitch checked={server.enabled} disabled={saving} onChange={onToggleEnabled} aria-label="Enable connector" />
          <span className="stv-muted stv-small">
            {server.enabled ? 'Meri can use this connector' : 'Paused — tools hidden from Meri'}
          </span>
        </div>
      </Section>

      <Section label="Tool allowlist">
        <SvTagInput
          value={tools}
          onChange={setTools}
          placeholder="Tool names exposed to Meri"
          aria-label="Tool allowlist"
        />
        <div className="stv-row">
          <CapiroButton
            size="compact"
            variant="primary"
            loading={saving}
            onClick={() => onSaveTools(tools)}
          >
            Save tools
          </CapiroButton>
        </div>
      </Section>

      <Section label="Connection">
        <div className="stv-row">
          {server.authType === 'oauth' && (
            <>
              <CapiroButton leadingIcon={<LinkIcon size={14} />} onClick={onReconnect}>
                {server.connectionStatus === 'connected' ? 'Re-authorize' : 'Connect'}
              </CapiroButton>
              {server.connectionStatus !== 'disconnected' && (
                <CapiroButton leadingIcon={<Unplug size={14} />} onClick={onDisconnect}>
                  Disconnect
                </CapiroButton>
              )}
            </>
          )}
          <CapiroButton
            className="stv-btn-danger"
            leadingIcon={<Trash2 size={14} />}
            onClick={onRemove}
          >
            Remove connector
          </CapiroButton>
        </div>
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="stv-stack stv-stack--tight" style={{ gap: 8 }}>
      <span className="stv-subhead" style={{ margin: 0 }}>
        {label}
      </span>
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
