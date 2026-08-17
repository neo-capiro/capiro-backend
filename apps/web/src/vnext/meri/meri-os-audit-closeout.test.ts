import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { meriStartWorkCards } from './meri-start-work.js';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('Meri os wire-audit closeout contracts', () => {
  test('conversation no longer keeps a dead hardcoded PROMPT_LIBRARY', () => {
    const source = readMeri('VNextMeriConversation.tsx');
    expect(source).not.toContain('PROMPT_LIBRARY');
    expect(source).not.toContain('libraryPage');
    expect(source).toContain('<MeriStartWork');
  });

  test('copy-link control uses a link icon and does not advertise a bookmark product', () => {
    const source = readMeri('VNextMeriConversation.tsx');
    expect(source).toContain('aria-label="Copy thread link"');
    expect(source).toContain('name="Link03"');
    expect(source).not.toContain('name="BookmarkAdd"');
    expect(source).toContain('navigator.clipboard');
    expect(source).not.toMatch(/bookmark|pin this thread/i);
  });

  test('Start Work maps live skills and saved prompts, never hardcoded landing cards', () => {
    const source = readMeri('MeriStartWork.tsx');
    expect(source).toContain("get('/api/clio/v3/skills'");
    expect(source).toContain('listMeriSavedPrompts');
    expect(source).toContain("['meri-vnext'");
    expect(source).toContain("'saved-prompts'");
    expect(source).not.toContain('SKILL_CARDS');
    expect(source).not.toContain('PROMPT_CARDS');
    expect(source).toContain('clientName: selectedClient?.name');
    expect(source).not.toContain('sendMessage(');
    expect(readMeri('VNextMeriConversation.tsx')).toContain('meri-fill-draft');
  });

  test('Start Work card mapper hydrates skills and saved prompts without fabricating missing ones', () => {
    const cards = meriStartWorkCards({
      skills: {
        enabled: true,
        skills: [
          {
            id: 'portfolio_changes',
            label: 'Portfolio Changes',
            description: 'What moved across clients.',
            starterPrompt: 'What changed for {{clientName}}?',
            quickAction: true,
            requiresClient: false,
          },
          {
            id: 'hidden',
            label: 'Hidden',
            description: 'Not a quick action',
            starterPrompt: 'Ignore',
            quickAction: false,
          },
        ],
      },
      prompts: [
        { id: 'p1', title: 'HAC-D prep', body: 'Prepare me for HAC-D.' },
        { id: 'blank', title: 'Empty', body: '   ' },
      ],
    });

    expect(cards.skills).toEqual([
      expect.objectContaining({
        id: 'portfolio_changes',
        title: 'Portfolio Changes',
        fill: 'What changed for the client selected in SCOPE?',
        kind: 'skill',
      }),
    ]);
    expect(cards.prompts).toEqual([
      expect.objectContaining({
        id: 'p1',
        title: 'HAC-D prep',
        fill: 'Prepare me for HAC-D.',
        kind: 'prompt',
      }),
    ]);

    expect(
      meriStartWorkCards({
        skills: {
          enabled: true,
          skills: [
            {
              id: 'client_changes',
              label: 'Client Changes',
              description: 'What moved.',
              starterPrompt: 'What changed for {{clientName}}?',
              quickAction: true,
              requiresClient: true,
            },
          ],
        },
        clientName: 'Lockheed Martin',
      }).skills[0]?.fill,
    ).toBe('What changed for Lockheed Martin?');
  });

  test('unmounted fixture files stay out of the live shell and conversation', () => {
    const shell = readMeri('VNextMeriShell.tsx');
    const conversation = readMeri('VNextMeriConversation.tsx');
    const composer = readMeri('VNextMeriComposer.tsx');
    const mounted = `${shell}\n${conversation}\n${composer}`;
    for (const fixture of [
      'MeriActionProposal',
      'MeriCommandPalette',
      'MeriManageContext',
      'MeriSourceDetail',
      'MeriAnalysisCard',
    ]) {
      expect(mounted).not.toContain(fixture);
    }
  });
});
