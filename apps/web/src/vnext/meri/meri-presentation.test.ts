import { describe, expect, test } from 'vitest';
import {
  displayThreadTitle,
  isPlaceholderThreadTitle,
  threadKindIcon,
  threadScopeLabel,
  threadScopeSubline,
  visibleMarkdown,
} from './meri-presentation.js';
import { MERI_ICON_DATA } from './meri-icons.js';

const REQUIRED_ICONS = [
  'SearchLg',
  'Plus',
  'HelpCircle',
  'Lightbulb02',
  'Minus',
  'Maximize01',
  'Minimize01',
  'XClose',
  'LayoutAlt01',
  'Building01',
  'ChevronDown',
  'Diamond01',
  'DotsHorizontal',
  'Attachment01',
  'ArrowNarrowUp',
  'StopCircle',
  'ShieldTick',
  'Sliders02',
  'PuzzlePiece01',
  'BookmarkAdd',
  'ChevronUp',
  'ChevronLeft',
  'ChevronRight',
  'MessageTextSquare01',
  'File05',
  'Stars02',
  'Edit01',
  'Copy01',
  'Trash01',
  'AlertTriangle',
  'AlertCircle',
  'Check',
  'DotsGrid',
  'DotsVertical',
  'ArrowUpRight',
] as const;

describe('meri presentation helpers', () => {
  test('falls back from Chat session to the first user text', () => {
    expect(isPlaceholderThreadTitle('Chat session')).toBe(true);
    expect(displayThreadTitle('Chat session', 'What moved in markup this week?')).toBe(
      'What moved in markup this week?',
    );
    expect(displayThreadTitle('Monday brief', 'ignored')).toBe('Monday brief');
    expect(displayThreadTitle('Chat session', 'x'.repeat(60))).toBe(`${'x'.repeat(48)}…`);
  });

  test('renders the thread sub-line in Inter sentence case', () => {
    expect(threadScopeSubline('LEGISTORM')).toBe('Client context · Legistorm');
    expect(threadScopeSubline(null)).toBe('Portfolio · All clients');
  });

  test('threadScopeLabel reflects the backend retrieval subjectScope', () => {
    // client → CLIENT · <name>, using the client name from the selector
    expect(threadScopeLabel('Legistorm', { subjectScope: 'client' })).toBe('CLIENT · Legistorm');
    // Falls back to targetHint when no client name is available
    expect(threadScopeLabel(null, { subjectScope: 'client', targetHint: 'Legistorm' })).toBe(
      'CLIENT · Legistorm',
    );
    // Falls back to a placeholder when neither is available
    expect(threadScopeLabel(null, { subjectScope: 'client' })).toBe('CLIENT · Unknown Client');

    // portfolio → PORTFOLIO · ALL CLIENTS (ignores client name)
    expect(threadScopeLabel('Legistorm', { subjectScope: 'portfolio' })).toBe(
      'PORTFOLIO · ALL CLIENTS',
    );
    expect(threadScopeLabel(null, { subjectScope: 'portfolio' })).toBe('PORTFOLIO · ALL CLIENTS');

    // external_entity → EXTERNAL RESEARCH · <targetHint or entity>
    expect(
      threadScopeLabel(null, { subjectScope: 'external_entity', targetHint: 'CRS REPORT R45678' }),
    ).toBe('EXTERNAL RESEARCH · Crs Report R45678');
    // No targetHint → generic external-source label
    expect(threadScopeLabel(null, { subjectScope: 'external_entity' })).toBe(
      'EXTERNAL RESEARCH · External Source',
    );
    // Client name is ignored for external research scope
    expect(
      threadScopeLabel('Legistorm', { subjectScope: 'external_entity', targetHint: 'CRS' }),
    ).toBe('EXTERNAL RESEARCH · Crs');

    // general → null (no misleading client-scope badge)
    expect(threadScopeLabel('Legistorm', { subjectScope: 'general' })).toBeNull();
    expect(threadScopeLabel(null, { subjectScope: 'general' })).toBeNull();
  });

  test('threadScopeLabel falls back to the legacy sub-line when no retrieval metadata is sent', () => {
    // No retrieval at all — backward-compat path
    expect(threadScopeLabel('LEGISTORM', undefined)).toBe('Client context · Legistorm');
    expect(threadScopeLabel('LEGISTORM', null)).toBe('Client context · Legistorm');
    expect(threadScopeLabel(null, undefined)).toBe('Portfolio · All clients');
    // Unknown subjectScope value — defensive fall-back, not a wrong badge
    expect(threadScopeLabel('Legistorm', { subjectScope: 'mystery_scope' })).toBe(
      'Client context · Legistorm',
    );
  });

  test('maps thread kind to a real UIcon, never a bare dot', () => {
    expect(threadKindIcon({ isNew: true })).toBe('Stars02');
    expect(threadKindIcon({ isResearch: true })).toBe('SearchLg');
    expect(threadKindIcon({ hasArtifact: true })).toBe('File05');
    expect(threadKindIcon({})).toBe('MessageTextSquare01');
  });

  test('buffers an unterminated markdown fence while streaming', () => {
    const source = 'Intro\n\n```text\nnot yet closed';
    expect(visibleMarkdown(source, true)).toBe('Intro');
    expect(visibleMarkdown(source, true)).not.toContain('```');
    expect(visibleMarkdown('**bold** and done', false)).toBe('**bold** and done');
    expect(visibleMarkdown('```js\nconst x = 1;\n```', true)).toContain('const x = 1;');
  });

  test('ships every required Untitled UI icon from the purchased set', () => {
    expect(Object.keys(MERI_ICON_DATA)).toHaveLength(164);
    for (const name of REQUIRED_ICONS) {
      expect(MERI_ICON_DATA[name], name).toBeTruthy();
    }
  });
});
