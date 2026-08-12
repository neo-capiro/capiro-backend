import { describe, expect, test } from 'vitest';
import {
  mapPersistedAttachments,
  mapPersistedCharts,
  newestConversation,
  normalizeConversation,
  threadIdFromPath,
} from './meri-route-state.js';

describe('vNext Meri route state', () => {
  test('parses only durable thread routes and fails closed on malformed encodings', () => {
    expect(threadIdFromPath('/meri/t/abc-123')).toBe('abc-123');
    expect(threadIdFromPath('/meri/t/thread%20one')).toBe('thread one');
    expect(threadIdFromPath('/meri/new')).toBeNull();
    expect(threadIdFromPath('/meri/t/%E0%A4%A')).toBeNull();
  });

  test('normalizes server conversation rows without inventing scope or previews', () => {
    expect(
      normalizeConversation({
        id: 'conv-1',
        title: '',
        clientId: null,
        client: null,
        latestMessage: null,
        updatedAt: '2026-08-12T20:00:00.000Z',
      }),
    ).toEqual({
      id: 'conv-1',
      title: 'Untitled thread',
      clientId: null,
      client: null,
      latestMessage: null,
      updatedAt: '2026-08-12T20:00:00.000Z',
    });
    expect(normalizeConversation({ title: 'missing id' })).toBeNull();
  });

  test('resolves the newest durable conversation by server updatedAt', () => {
    const older = normalizeConversation({
      id: 'older',
      title: 'Older',
      updatedAt: '2026-08-11T20:00:00.000Z',
    });
    const newer = normalizeConversation({
      id: 'newer',
      title: 'Newer',
      updatedAt: '2026-08-12T20:00:00.000Z',
    });
    expect(older).toBeTruthy();
    expect(newer).toBeTruthy();
    expect(newestConversation([older!, newer!])?.id).toBe('newer');
  });

  test('restores only persisted attachments and analysis chart artifacts with ids', () => {
    const message = {
      metadata: {
        attachments: [
          { id: 'att-1', filename: 'memo.pdf', kind: 'document', status: 'parsed' },
          { filename: 'missing-id.pdf' },
        ],
      },
      artifacts: [
        { id: 'chart-1', kind: 'analysis_chart', title: 'Funding by year' },
        { id: 'doc-1', kind: 'document', title: 'Draft' },
      ],
    };
    expect(mapPersistedAttachments(message)).toEqual([
      { id: 'att-1', filename: 'memo.pdf', kind: 'document', status: 'parsed' },
    ]);
    expect(mapPersistedCharts(message)).toEqual([
      { id: 'chart-1', title: 'Funding by year' },
    ]);
  });
});
