import { describe, expect, it } from 'vitest';
import {
  briefContextText,
  briefToSectionState,
  briefToWorkspaceConfig,
  textToHtml,
} from './brief-workspace.js';
import type { HearingBrief } from './wave1-api.js';

const brief: HearingBrief = {
  title: 'Hearing brief — Shipbuilding',
  mode: 'recap',
  sections: [
    {
      name: 'Executive summary',
      content: 'The chair pressed on **multiyear** funding.\n\nSecond paragraph.',
    },
    { name: 'Key exchanges', content: '- Chair: funding\n- Witness: workforce' },
    { name: 'Key exchanges', content: '1. First\n2. Second' },
  ],
  keyMoments: [
    { startMs: 65_000, speaker: 'Chair', summary: 'Tied workforce to funding.' },
    { summary: 'Closing remarks.' },
  ],
  sources: [{ kind: 'hearing', id: 'h-1' }],
  contextPacket: { hearing: { id: 'h-1' } },
  lowConfidence: true,
};

describe('textToHtml', () => {
  it('escapes markup and keeps paragraphs, bold, headings and lists', () => {
    expect(textToHtml('a <b>& "c"')).toBe('<p>a &lt;b&gt;&amp; &quot;c&quot;</p>');
    expect(textToHtml('One **two** three\n\nFour')).toBe(
      '<p>One <strong>two</strong> three</p><p>Four</p>',
    );
    expect(textToHtml('## Heading\nBody line')).toBe('<h3>Heading</h3><p>Body line</p>');
    expect(textToHtml('- a\n* b\n\n1. x\n2) y')).toBe(
      '<ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>',
    );
    expect(textToHtml('Line one\r\nLine two')).toBe('<p>Line one<br>Line two</p>');
    expect(textToHtml('')).toBe('');
  });

  it('does not treat a bold-led line as a bullet', () => {
    expect(textToHtml('**Ask:** $10M')).toBe('<p><strong>Ask:</strong> $10M</p>');
  });

  it('closes a list when prose follows it inside the same block', () => {
    expect(textToHtml('- a\nThen prose')).toBe('<ul><li>a</li></ul><p>Then prose</p>');
  });
});

describe('briefToSectionState', () => {
  it('converts every section to reviewed HTML and keeps duplicate names distinct', () => {
    const state = briefToSectionState(brief);
    expect(state.sections).toEqual(['Executive summary', 'Key exchanges', 'Key exchanges 2']);
    expect(state.content['Executive summary']).toBe(
      '<p>The chair pressed on <strong>multiyear</strong> funding.</p><p>Second paragraph.</p>',
    );
    expect(state.content['Key exchanges']).toBe(
      '<ul><li>Chair: funding</li><li>Witness: workforce</li></ul>',
    );
    expect(state.content['Key exchanges 2']).toBe('<ol><li>First</li><li>Second</li></ol>');
    expect(state.meta).toEqual({
      'Executive summary': { status: 'review' },
      'Key exchanges': { status: 'review' },
      'Key exchanges 2': { status: 'review' },
    });
  });
});

describe('briefToWorkspaceConfig', () => {
  it('shapes the config the Workspace editor reads, from the REVIEWED state', () => {
    const state = {
      sections: ['A'],
      content: { A: '<p>edited</p>' },
      meta: { A: { status: 'review' as const } },
    };
    expect(
      briefToWorkspaceConfig({
        hearingId: 'h-1',
        clientId: 'c-1',
        mode: 'recap',
        sources: brief.sources,
        state,
      }),
    ).toEqual({
      legiwatch: { mode: 'hearing-brief', hearingId: 'h-1', clientId: 'c-1', briefMode: 'recap' },
      sources: brief.sources,
      sections: ['A'],
      sectionContent: { A: '<p>edited</p>' },
      sectionMeta: { A: { status: 'review' } },
    });
  });
});

describe('briefContextText', () => {
  it('carries the mode, timecoded key moments, the context packet and the sources', () => {
    const text = briefContextText(brief);
    expect(text).toContain('LegiWatch recap brief — Hearing brief — Shipbuilding.');
    expect(text).toContain('- 0:01:05 Chair: Tied workforce to funding.');
    expect(text).toContain('- Closing remarks.');
    expect(text).toContain('low confidence');
    expect(text).toContain(JSON.stringify(brief.contextPacket));
    expect(text).toContain(JSON.stringify(brief.sources));
  });

  it('omits the confidence caveat and moments when there are none', () => {
    const text = briefContextText({ ...brief, lowConfidence: false, keyMoments: [] });
    expect(text).not.toContain('low confidence');
    expect(text).not.toContain('Key moments');
  });
});
