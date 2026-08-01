import { describe, expect, it } from 'vitest';
import {
  applyWorkspaceAssistantEdits,
  diffReviewText,
  resolveCanonicalSection,
} from './edit-review.js';

describe('resolveCanonicalSection', () => {
  it('matches section names without case or whitespace drift', () => {
    expect(resolveCanonicalSection(['Executive Summary', 'Policy Ask'], '  policy   ask ')).toBe(
      'Policy Ask',
    );
  });
});

describe('diffReviewText', () => {
  it('marks word-level additions and removals', () => {
    const diff = diffReviewText('Request $10 million.', 'Request $12 million now.');
    expect(diff.some((part) => part.type === 'removed' && part.value.includes('10'))).toBe(true);
    expect(diff.some((part) => part.type === 'added' && part.value.includes('12'))).toBe(true);
    expect(diff.some((part) => part.type === 'added' && part.value.includes('now'))).toBe(true);
  });
});

describe('applyWorkspaceAssistantEdits', () => {
  const state = {
    sections: ['Overview', 'Policy Ask', 'Conclusion'],
    content: {
      Overview: '<p>Old overview</p>',
      'Policy Ask': '<p>Old ask</p>',
      Conclusion: '<p>Old conclusion</p>',
    },
    meta: {},
  };

  it('uses the same canonical resolver for replacement and insert positioning', () => {
    const result = applyWorkspaceAssistantEdits(state, [
      {
        op: 'replace_section',
        section: ' policy   ask ',
        content: '<p>New ask</p>',
      },
      {
        op: 'insert_section',
        name: 'Implementation',
        afterSection: ' OVERVIEW ',
        content: '<p>Steps</p>',
      },
    ]);

    expect(result.state.content['Policy Ask']).toBe('<p>New ask</p>');
    expect(result.state.sections).toEqual(['Overview', 'Implementation', 'Policy Ask', 'Conclusion']);
    expect(result.skipped).toHaveLength(0);
  });

  it('creates inverse edits that restore replaced, inserted, and removed content', () => {
    const applied = applyWorkspaceAssistantEdits(state, [
      { op: 'replace_section', section: 'Overview', content: '<p>New overview</p>' },
      { op: 'remove_section', section: 'Conclusion' },
      { op: 'insert_section', name: 'Risks', afterSection: 'Policy Ask', content: '<p>Risk</p>' },
    ]);
    const undone = applyWorkspaceAssistantEdits(applied.state, applied.inverseEdits);
    expect(undone.state.sections).toEqual(state.sections);
    expect(undone.state.content).toEqual(state.content);
  });

  it('reports stale target failures instead of creating ghost sections', () => {
    const result = applyWorkspaceAssistantEdits(state, [
      { op: 'replace_section', section: 'Missing section', content: '<p>Never apply</p>' },
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/no longer exists/i);
    expect(result.state.sections).toEqual(state.sections);
  });
});
