// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlannerViewPreferences } from './planner-view-preferences.js';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  org: 'org-a',
  user: 'me',
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ orgId: mocks.org, userId: mocks.user }),
}));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: mocks.get, post: mocks.post, patch: mocks.patch }),
}));
const data = {
  scope: 'project',
  projectId: 'project-a',
  view: 'list',
  expandedTaskIds: ['parent'],
  collapsedGroupIds: ['section:one'],
  hideUnscheduled: false,
};
const row = {
  id: 'prefs',
  kind: 'view_preferences',
  version: 7,
  archived: false,
  name: 'Layout',
  data,
};
const clients: QueryClient[] = [];
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  clients.push(client);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
beforeEach(() => {
  mocks.org = 'org-a';
  mocks.user = 'me';
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
});
describe('Strategies-backed personal view preferences', () => {
  it('resets to defaults by recoverably archiving the captured layout version', async () => {
    let resources = [row];
    mocks.get.mockImplementation(async () => ({ data: resources }));
    mocks.patch.mockImplementation(async (_path, body) => {
      resources = [{ ...row, version: 8, archived: body.archived }];
      return { data: resources[0] };
    });
    const { result } = renderHook(() => usePlannerViewPreferences('project', 'project-a', 'list'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.controls.disabled).toBe(false));
    act(() => result.current.reset?.());
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/strategy-api/planner/resources/prefs', {
        version: 7,
        archived: true,
      }),
    );
    await waitFor(() => expect(result.current.reset).toBeUndefined());
    expect(result.current.controls.data.expandedTaskIds).toEqual([]);
    expect(result.current.controls.data.collapsedGroupIds).toEqual([]);
    expect(result.current.controls.data.hideUnscheduled).toBe(false);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('suppresses repeated synchronous saves and ignores a late failure from the previous organization', async () => {
    mocks.get.mockImplementation(async () => ({ data: mocks.org === 'org-a' ? [row] : [] }));
    let rejectSave!: (error: Error) => void;
    mocks.patch.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const { result, rerender } = renderHook(
      () => usePlannerViewPreferences('project', 'project-a', 'list'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.controls.disabled).toBe(false));
    act(() => {
      result.current.controls.save({ expandedTaskIds: [] });
      result.current.controls.save({ expandedTaskIds: [] });
    });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    mocks.org = 'org-b';
    rerender();
    await waitFor(() => expect(result.current.controls.disabled).toBe(false));
    await act(async () => {
      rejectSave(new Error('Previous organization changed'));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.controls.data.expandedTaskIds).toEqual([]);
  });
  it('captures the opening version and preserves unrelated layout properties', async () => {
    let resources = [row];
    mocks.get.mockImplementation(async () => ({ data: resources }));
    mocks.patch.mockImplementation(async (_path, body) => {
      resources = [{ ...row, version: 8, data: body.data }];
      return { data: resources[0] };
    });
    const { result } = renderHook(() => usePlannerViewPreferences('project', 'project-a', 'list'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.controls.disabled).toBe(false));
    act(() => result.current.controls.save({ collapsedGroupIds: [] }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/strategy-api/planner/resources/prefs', {
        version: 7,
        kind: 'view_preferences',
        name: 'Personal view layout',
        data: { ...data, collapsedGroupIds: [] },
      }),
    );
    await waitFor(() => expect(result.current.controls.data.collapsedGroupIds).toEqual([]));
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('does not replace saved layout after a rejected stale update', async () => {
    mocks.get.mockResolvedValue({ data: [row] });
    mocks.patch.mockRejectedValue(new Error('The layout changed. Refresh.'));
    const { result } = renderHook(() => usePlannerViewPreferences('project', 'project-a', 'list'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.controls.disabled).toBe(false));
    act(() => result.current.controls.save({ expandedTaskIds: [] }));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.controls.data.expandedTaskIds).toEqual(['parent']);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
  it('uses independent organization, member, project and view keys', async () => {
    mocks.get.mockImplementation(async () => ({
      data: mocks.org === 'org-a' && mocks.user === 'me' ? [row] : [],
    }));
    const { result, rerender } = renderHook(
      ({ view, project }: { view: 'list' | 'board'; project: string }) =>
        usePlannerViewPreferences('project', project, view),
      {
        initialProps: { view: 'list' as 'list' | 'board', project: 'project-a' },
        wrapper: wrapper(),
      },
    );
    await waitFor(() => expect(result.current.controls.data.expandedTaskIds).toEqual(['parent']));
    rerender({ view: 'board', project: 'project-a' });
    expect(result.current.controls.data.expandedTaskIds).toEqual([]);
    rerender({ view: 'list', project: 'project-b' });
    expect(result.current.controls.data.expandedTaskIds).toEqual([]);
    mocks.org = 'org-b';
    rerender({ view: 'list', project: 'project-a' });
    await waitFor(() => expect(result.current.controls.disabled).toBe(false));
    expect(result.current.controls.data.expandedTaskIds).toEqual([]);
    mocks.org = 'org-a';
    mocks.user = 'someone-else';
    rerender({ view: 'list', project: 'project-a' });
    await waitFor(() => expect(result.current.controls.disabled).toBe(false));
    expect(result.current.controls.data.collapsedGroupIds).toEqual([]);
  });
});
