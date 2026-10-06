import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { isWorkspaceVNextRoute, WorkspaceVNextRoutes } from './WorkspaceVNextRoutes.js';

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({}) }));
vi.mock('./api/transport-bridge.js', () => ({ installWorkspaceTransportBridge: () => () => undefined }));
vi.mock('./hillday/HillDayLibrary.js', () => ({ HillDayLibrary: () => <div>Hill Day library</div> }));
vi.mock('./editor/WorkspaceEditorStabilized.js', () => ({
  WorkspaceEditorStabilized: ({ draftId }: { draftId: string }) => <div>Draft editor {draftId}</div>,
}));

const DRAFT_ID = '3f0c2a9e-1b7d-4c55-9a10-2d6e8f4b7c21';

function Probe() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <WorkspaceVNextRoutes />
    </MemoryRouter>,
  );
}

describe('Workspace is Hill Day–only', () => {
  it.each([
    '/workspace',
    '/workspace/new',
    '/workspace/shares',
    '/workspace/studio',
    `/workspace/studio/${DRAFT_ID}/${DRAFT_ID}`,
    '/workspace/library',
    '/workspace/setup',
  ])('sends %s to the Hill Day library', async (path) => {
    expect(isWorkspaceVNextRoute(path)).toBe(true);
    renderAt(path);
    expect(await screen.findByText('Hill Day library')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/workspace/documents');
  });

  it('still opens an existing draft linked from elsewhere in the app', async () => {
    renderAt(`/workspace/${DRAFT_ID}`);
    expect(await screen.findByText(`Draft editor ${DRAFT_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent(`/workspace/${DRAFT_ID}`);
  });

  it('leaves legacy draft deep links to the existing application', () => {
    for (const path of [
      `/workspace/draft/${DRAFT_ID}`,
      `/workspace/setup/${DRAFT_ID}`,
      `/workspace/context/${DRAFT_ID}`,
      `/workspace/preview/${DRAFT_ID}`,
      `/workspace/collab/${DRAFT_ID}`,
    ]) {
      expect(isWorkspaceVNextRoute(path)).toBe(false);
    }
  });
});
