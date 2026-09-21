import { describe, expect, test } from 'vitest';
import { clientProfileKeywordGroups } from './client-profile-keywords.js';

describe('client profile keyword import', () => {
  test('includes saved fields and capability program elements without duplicate tags or free-form notes', () => {
    const groups = clientProfileKeywordGroups(
      { sectorTag: 'Autonomous systems', naicsCodes: ['541715'], intakeData: { sectors: ['ENERGY'], sector: 'Defense electronics', tags: ['Robotics', 'robotics'], fundingPriorities: ['Battery storage'], peNumber: '0601234A', profileNotes: 'private note' } },
      [{ name: 'Autonomy stack', sector: 'Autonomous systems', tags: ['Sensor fusion'], keywords: ['robotics'], peNumbers: ['0605678B'] }],
    );
    expect(groups.map((group) => group.label)).toContain('Program elements');
    const terms = groups.flatMap((group) => group.terms);
    expect(terms).toEqual(expect.arrayContaining(['Autonomous systems', 'Defense electronics', 'ENERGY', 'Robotics', 'Battery storage', '0601234A', '0605678B', '541715', 'Sensor fusion']));
    expect(terms.filter((term) => term.toLowerCase() === 'robotics')).toHaveLength(1);
    expect(terms).not.toContain('private note');
  });
});
