import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider, theme as antdTheme, type ThemeConfig } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { OutreachView } from '../../../pages/engagement/OutreachView.js';
import './outreach-classic.css';
import './outreach-classic-bridge.css';

/**
 * Classic Outreach (the V2 wizard) mounted on the vNext surface.
 *
 * Owner decision 2026-09-03: os.capiro.ai renders Classic Outreach in place
 * of the V3 campaign builder — V2 is the flow the firm actually uses; V3 is
 * kept in the tree (code, routes, backend) but is no longer the vNext
 * default. `OutreachView` is the SAME component the canonical app mounts in
 * EngagementPage's Outreach tab, so drafts, generation jobs, send intents,
 * templates and the `/engagement/outreach/draft/:id` deep links behave
 * identically on both hosts and against the same `OutreachRecord` rows.
 *
 * What this wrapper owns, and why it exists instead of mounting OutreachView
 * directly from VNextEngagementRoutes:
 *
 *  - antd context. main.tsx deliberately mounts NO antd `ConfigProvider`/
 *    `App` on the vNext surface (`main.legacy-chrome.contract.test.ts`), and
 *    OutreachView + the V2 steps call `App.useApp()` for message/modal/
 *    notification. Without a provider those are inert `{}` stubs — every
 *    "Draft saved" / "Campaign sent" toast and every delete-confirm modal
 *    silently does nothing. So the providers are mounted HERE, scoped to
 *    this subtree, themed onto the Engagement module's tokens.
 *  - the `aiConfigured` capability read, which EngagementPage does for its
 *    own tab and VNextEngagementRoutes does not otherwise need.
 *  - the stylesheet pair that replaces theme.css for this surface
 *    (`outreach-classic.css` = the extracted page/list/frame block;
 *    `outreach-classic-bridge.css` = the `--ov2-*` token bridge).
 *
 * `OutreachView` reads its mode (landing / wizard / readonly) from the URL
 * itself (`/engagement/outreach`, `/new/wizard`, `/draft/:id`,
 * `/draft-v3/:id`) and writes it back with `navigate(..., { replace })`, so
 * no step/campaign-id plumbing is needed from the route shell.
 */

interface EngagementCapabilities {
  ai: { activeProvider: 'openai' | 'anthropic' | null };
}

export interface VNextOutreachClassicProps {
  clients: Client[];
  selectedClientId: string | null;
}

/**
 * antd tokens for the classic subtree, aligned to the Engagement module's
 * Untitled UI values (engagement.css / tokens.css) rather than the classic
 * app's brand navy in `theme-antd.ts`: same type family the rest of
 * os.capiro.ai renders in, the module's confirmed accent, control radii
 * matching `--capiro-radius-control`.
 */
const CLASSIC_ON_VNEXT_ANTD_THEME: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    // Owner direction 2026-09-06: every button in the wizard renders metallic
    // black, not navy. The wizard's own primary actions already use the
    // btn-dark gradient (v2/ui/tailwind.css); these antd tokens cover the
    // antd-rendered buttons (Continue, Modal OK, checked checkboxes) so no
    // blue primary survives anywhere in the flow. Ramp mirrors btn-dark's
    // gradient stops (#39424f → #1b2430 → #0e141c).
    colorPrimary: '#1b2430',
    colorPrimaryHover: '#39424f',
    colorPrimaryActive: '#0e141c',
    colorLink: '#294e68',
    colorLinkHover: '#1f3d52',
    colorText: '#101828',
    colorTextSecondary: '#475467',
    colorBorder: '#d0d5dd',
    colorBorderSecondary: '#e4e7ec',
    colorBgLayout: '#eff1f5',
    borderRadius: 8,
    fontFamily:
      "'Hanken Grotesk', 'Instrument Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontFamilyCode: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  },
  components: {
    Typography: { titleMarginBottom: 0.5 },
    Button: { borderRadius: 8, fontWeight: 600 },
    Input: { borderRadius: 8 },
    Select: { borderRadius: 8 },
    Card: { borderRadiusLG: 10 },
  },
};

export function VNextOutreachClassic({ clients, selectedClientId }: VNextOutreachClassicProps) {
  const api = useApi();
  const capabilities = useQuery<EngagementCapabilities>({
    // Same key EngagementPage uses so both surfaces share the cache entry.
    queryKey: ['engagement-capabilities'],
    queryFn: async () => (await api.get<EngagementCapabilities>('/api/engagement/capabilities')).data,
    staleTime: 60_000,
  });
  const aiConfigured = Boolean(capabilities.data?.ai.activeProvider);
  const themeConfig = useMemo(() => CLASSIC_ON_VNEXT_ANTD_THEME, []);

  return (
    <div className="eng-outreach-classic" data-testid="vnext-outreach-classic">
      <ConfigProvider theme={themeConfig}>
        <AntApp>
          <OutreachView clients={clients} selectedClientId={selectedClientId} aiConfigured={aiConfigured} />
        </AntApp>
      </ConfigProvider>
    </div>
  );
}
