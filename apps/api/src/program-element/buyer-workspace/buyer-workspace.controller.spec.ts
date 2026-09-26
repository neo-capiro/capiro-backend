import { BuyerWorkspaceController } from './buyer-workspace.controller.js';
import type { BuyerWorkspaceService } from './buyer-workspace.service.js';

describe('BuyerWorkspaceController', () => {
  it('forwards both independent federal evidence cursors with the pinned scope', () => {
    const read = jest.fn();
    const controller = new BuyerWorkspaceController({ read } as unknown as BuyerWorkspaceService);
    const query = {
      asOfFy: 2026,
      knownAt: '2026-09-24T00:00:00.000Z',
      mentionsCursor: 'mention-cursor',
      lifecycleCursor: 'lifecycle-cursor',
    };

    controller.read('0601234a', query);

    expect(read).toHaveBeenCalledWith({ peCode: '0601234a', ...query });
  });
});
