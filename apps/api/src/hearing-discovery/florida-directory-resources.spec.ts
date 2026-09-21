import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadFloridaDirectoryResources,
  projectFloridaDirectoryResources,
} from './florida-directory-resources.js';

function reviewedManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      resolve(__dirname, '../../data/florida-legislative-directory/directory-enrichment.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

describe('Florida directory chamber resources', () => {
  it('exposes the reviewed office pages and rooms with exact source provenance', () => {
    const resources = loadFloridaDirectoryResources();

    expect(resources).toBe(loadFloridaDirectoryResources());
    expect(resources.jurisdiction).toBe('FL');
    expect(resources.legislativeSession).toBe('2026');
    expect(resources.officeDirectoryPages.filter((page) => page.chamber === 'house')).toHaveLength(
      31,
    );
    expect(resources.officeDirectoryPages.filter((page) => page.chamber === 'senate')).toHaveLength(
      5,
    );
    expect(resources.meetingRooms).toHaveLength(11);
    expect(resources.officeDirectoryPages[0]).toMatchObject({
      chamber: 'house',
      pageNumber: 7,
      lines: ['The Leadership', 'OF THE', 'Florida House of Representatives'],
      source: {
        document: 'HouseDirectory.pdf',
        sha256: 'd22307e5f0809fc19fb3e3964232542b288a95d868e021f8813ccbee893a37cc',
        asOfDate: '2026-06-04',
        textSha256: 'c76349c8c59a9fa0b3412d201bf58c90138ca1f80b6ae9196406d71fd7bb038a',
      },
    });
    expect(resources.meetingRooms[0]).toEqual({
      room: '110 Senate Building',
      description: 'Toni Jennings Committee Room, Entrance Level',
      source: {
        document: 'SDIR.pdf',
        sha256: 'f39f6880aef73025919a73eefbc12da6f1ba23b7d547766473f8a3d1a58c152d',
        asOfDate: '2026-08-26',
      },
    });
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.isFrozen(resources.officeDirectoryPages[0]?.lines)).toBe(true);
  });

  it('returns no invented identities or URLs', () => {
    const serialized = JSON.stringify(loadFloridaDirectoryResources());

    expect(serialized).not.toMatch(/"(?:id|url|profileUrl)":/i);
    expect(serialized).not.toContain('http://');
    expect(serialized).not.toContain('https://');
  });

  it('fails closed when reviewed source or page provenance changes', () => {
    const sourceTamper = reviewedManifest();
    ((sourceTamper.sources as Record<string, unknown>).houseDirectory as Record<string, unknown>)[
      'sha256'
    ] = 'a'.repeat(64);
    expect(() => projectFloridaDirectoryResources(sourceTamper)).toThrow(
      'Unreviewed Florida directory source',
    );

    const provenanceTamper = reviewedManifest();
    const house = provenanceTamper.house as {
      officeDirectoryPages: Array<Record<string, unknown>>;
    };
    (house.officeDirectoryPages[0]?.provenance as Record<string, unknown>)['pageNumber'] = 999;
    expect(() => projectFloridaDirectoryResources(provenanceTamper)).toThrow(
      'Invalid Florida directory provenance',
    );
  });
});
