import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Outreach on os.capiro.ai is Classic Outreach (the V2 wizard) — owner
 * decision 2026-09-03. These tests pin the two halves of that:
 *
 *   1. the route shell mounts `VNextOutreachClassic` for EVERY
 *      `/engagement/outreach/*` shape (landing, `/new/wizard`, `/draft/:id`,
 *      the old V3 `/:campaignId`) and never the V3 builder/home; and
 *   2. the classic mount supplies its own antd `App` context, because
 *      main.tsx deliberately mounts none on the vNext surface and Classic's
 *      toasts/confirm modals are `App.useApp()` consumers.
 *
 * Every other Engagement body and the classic view itself are stubbed —
 * this is a routing/composition contract, not a wizard test (the V2 wizard
 * has its own suites under pages/engagement/outreach/v2).
 */

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ data: {} })),
  }),
}));
vi.mock('../../../state/client-filter.js', () => ({
  useClientFilter: () => ({ selectedClientId: null, setSelectedClientId: vi.fn() }),
}));
vi.mock('./VNextMeetingsWorkspace.js', () => ({
  VNextMeetingsWorkspace: () => <div data-testid="meetings-stub" />,
}));
vi.mock('./VNextMeetingLibrary.js', () => ({
  VNextMeetingLibrary: () => <div data-testid="library-stub" />,
}));
vi.mock('./VNextReportsTracker.js', () => ({
  VNextReportsTracker: () => <div data-testid="reports-stub" />,
}));
// The V3 builder + home must NOT be reachable from the shell any more. If a
// future edit re-imports them, these stubs render and the assertions below
// catch it.
vi.mock('./VNextOutreachCampaignBuilder.js', () => ({
  VNextOutreachCampaignBuilder: () => <div data-testid="v3-builder-stub" />,
}));
vi.mock('./VNextOutreachHome.js', () => ({
  VNextOutreachHome: () => <div data-testid="v3-home-stub" />,
}));
// Classic itself is stubbed to a probe that reports whether a real antd App
// context is present above it (the default context is an empty-object stub
// whose `message.success` is undefined — exactly the silent-toast failure
// the wrapper exists to prevent).
vi.mock('../../../pages/engagement/OutreachView.js', async () => {
  const antd = await import('antd');
  return {
    OutreachView: ({ aiConfigured }: { aiConfigured: boolean }) => {
      const { message } = antd.App.useApp();
      return (
        <div
          data-testid="classic-outreach-stub"
          data-has-message-api={typeof message.success === 'function' ? 'yes' : 'no'}
          data-ai-configured={aiConfigured ? 'yes' : 'no'}
        />
      );
    },
  };
});

import { VNextEngagementRoutes } from './VNextEngagementRoutes.js';

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <VNextEngagementRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextEngagementRoutes — Outreach renders Classic (V2)', () => {
  it.each([
    '/engagement/outreach',
    '/engagement/outreach/',
    '/engagement/outreach/new/wizard',
    '/engagement/outreach/draft/rec-123',
    '/engagement/outreach/draft-v3/sess-456',
    // A V3-era campaign URL: still the Outreach destination, still Classic.
    '/engagement/outreach/campaign-789',
  ])('mounts Classic Outreach for %s and never the V3 builder', async (path) => {
    renderAt(path);
    expect(await screen.findByTestId('classic-outreach-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('v3-builder-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('v3-home-stub')).not.toBeInTheDocument();
  });

  it('wraps Classic in a real antd App context so message/modal calls are live', async () => {
    renderAt('/engagement/outreach');
    const probe = await screen.findByTestId('classic-outreach-stub');
    expect(probe).toHaveAttribute('data-has-message-api', 'yes');
    // The classic mount point carries the scoping class every extracted
    // `.outreach-*` rule and the `--ov2-*` token bridge hang off.
    expect(probe.closest('.eng-outreach-classic')).not.toBeNull();
  });

  it('keeps the Engagement chrome (header + destination tabs) around the classic body', async () => {
    renderAt('/engagement/outreach');
    await screen.findByTestId('classic-outreach-stub');
    expect(screen.getByRole('heading', { name: 'Engagement' })).toBeInTheDocument();
    const outreachTab = screen.getByRole('button', { name: 'Outreach' });
    expect(outreachTab).toHaveAttribute('aria-current', 'page');
  });

  it('leaves the other three destinations on their vNext bodies', () => {
    renderAt('/engagement/meetings');
    expect(screen.getByTestId('meetings-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('classic-outreach-stub')).not.toBeInTheDocument();
  });
});

describe('VNextEngagementRoutes — source contract', () => {
  const shell = readFileSync(resolve(process.cwd(), 'src/vnext/pages/engagement/VNextEngagementRoutes.tsx'), 'utf8');

  it('does not import the V3 builder or home', () => {
    expect(shell).not.toMatch(/from\s+'\.\/VNextOutreachCampaignBuilder\.js'/);
    expect(shell).not.toMatch(/from\s+'\.\/VNextOutreachHome\.js'/);
    expect(shell).toMatch(/from\s+'\.\/VNextOutreachClassic\.js'/);
  });
});
