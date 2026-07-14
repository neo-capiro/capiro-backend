import { describe, expect, test } from '@jest/globals';
import {
  memberPhotoRecords,
  parsePhotoOverlay,
  resolveMemberPhoto,
  resolveStaffPhoto,
} from './directory-photo.js';

describe('resolveMemberPhoto', () => {
  test('prefers public directory, then public primary, then any public', () => {
    expect(
      resolveMemberPhoto([
        { url: 'primary.jpg', status: 'public', is_primary: true },
        { url: 'directory.jpg', status: 'public', is_directory: true },
      ]),
    ).toEqual({ url: 'directory.jpg', source: 'legistorm' });
    expect(
      resolveMemberPhoto([
        { url: 'other.jpg', status: 'public' },
        { url: 'primary.jpg', status: 'public', is_primary: true },
      ]),
    ).toEqual({ url: 'primary.jpg', source: 'legistorm' });
    expect(resolveMemberPhoto([{ url: 'any.jpg', status: 'public' }])).toEqual({
      url: 'any.jpg',
      source: 'legistorm',
    });
  });

  test('a source photo always beats a non-override overlay', () => {
    const overlay = { url: 'o.jpg', source: 's', sourceUrl: null, addedAt: '', addedBy: '', manualOverride: false };
    expect(resolveMemberPhoto([{ url: 'src.jpg', status: 'public', is_directory: true }], overlay)).toEqual({
      url: 'src.jpg',
      source: 'legistorm',
    });
  });

  test('overlay is honored only when manualOverride and no eligible source photo', () => {
    const override = { url: 'o.jpg', source: 's', sourceUrl: null, addedAt: '', addedBy: '', manualOverride: true };
    expect(resolveMemberPhoto([{ url: 'x.jpg', status: 'private' }], override)).toEqual({
      url: 'o.jpg',
      source: 'capiro_overlay',
    });
    const nonOverride = { ...override, manualOverride: false };
    expect(resolveMemberPhoto([], nonOverride)).toEqual({ url: null, source: null });
  });

  test('no photos and no overlay -> null (initials fallback)', () => {
    expect(resolveMemberPhoto(null)).toEqual({ url: null, source: null });
  });
});

describe('resolveStaffPhoto', () => {
  test('uses a real source photo when present', () => {
    expect(resolveStaffPhoto('staff.jpg')).toEqual({ url: 'staff.jpg', source: 'legistorm' });
  });
  test('falls back to a preserved overlay, else null; never a member photo', () => {
    const overlay = { url: 'staff-overlay.jpg', source: 's', sourceUrl: null, addedAt: '', addedBy: '', manualOverride: false };
    expect(resolveStaffPhoto(null, overlay)).toEqual({ url: 'staff-overlay.jpg', source: 'capiro_overlay' });
    expect(resolveStaffPhoto(null)).toEqual({ url: null, source: null });
    expect(resolveStaffPhoto('')).toEqual({ url: null, source: null });
  });
});

describe('memberPhotoRecords', () => {
  test('preserves all photo metadata, not just the selected URL', () => {
    const records = memberPhotoRecords([
      { id: 1, url: 'a.jpg', status: 'public', is_primary: true, is_directory: false, updated_at: '2026-07-01T00:00:00Z' },
      { id: 2, url: 'b.jpg', status: 'inactive' },
    ]);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      id: 1,
      url: 'a.jpg',
      status: 'public',
      isPrimary: true,
      isDirectory: false,
      updatedAt: '2026-07-01T00:00:00Z',
    });
    expect(records[1]!.status).toBe('inactive');
    expect(memberPhotoRecords(undefined)).toEqual([]);
  });
});

describe('parsePhotoOverlay', () => {
  test('parses valid entries and ignores malformed ones', () => {
    const overlay = parsePhotoOverlay({
      _meta: { version: '1.0.0' },
      people: {
        'member-1': { url: 'u.jpg', source: 'src', sourceUrl: 'https://x', addedAt: 't', addedBy: 'neo', manualOverride: true },
        'member-2': { source: 'no-url' }, // no url -> dropped
      },
    });
    expect(overlay.people['member-1']).toMatchObject({ url: 'u.jpg', manualOverride: true });
    expect(overlay.people['member-2']).toBeUndefined();
    expect(parsePhotoOverlay(null)).toEqual({ people: {} });
  });
});
