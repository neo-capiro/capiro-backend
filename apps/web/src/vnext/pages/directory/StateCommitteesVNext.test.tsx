import { describe, expect, test } from 'vitest';
import { chamberLabel } from './StateCommitteesVNext.js';

describe('state committee directory labels', () => {
  test.each([
    ['lower', 'House'], ['house', 'House'],
    ['upper', 'Senate'], ['senate', 'Senate'],
    ['joint', 'Joint'], [null, 'Chamber unconfirmed'],
  ])('renders %s as %s', (raw, label) => {
    expect(chamberLabel(raw)).toBe(label);
  });
});


describe('linked committee records', () => {
  test('uses chamber-specific labels for preserved legacy links', () => {
    const related = [
      { id: 'FL-lower-example', chamber: 'lower' },
      { id: 'FL-upper-example', chamber: 'upper' },
    ];
    expect(related.map((body) => `${chamberLabel(body.chamber)} record`)).toEqual(['House record', 'Senate record']);
  });
});
