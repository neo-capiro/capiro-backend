import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import {
  clearRegistrationDraft,
  draftMatchesUser,
  readRegistrationDraft,
  REGISTRATION_DRAFT_TTL_MS,
  storeRegistrationDraft,
  type RegistrationDraft,
} from './funnel';

const V1_KEY = 'capiro-funnel-registration.v1';
const V0_KEY = 'capiro-funnel-registration';

const DRAFT: RegistrationDraft = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  orgName: 'Analytical Engines LLC',
  email: 'ada@example.com',
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('draftMatchesUser — fails CLOSED', () => {
  it('matches when the draft email equals the session email', () => {
    expect(draftMatchesUser(DRAFT, 'ada@example.com')).toBe(true);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(draftMatchesUser(DRAFT, '  ADA@Example.COM ')).toBe(true);
    expect(draftMatchesUser({ ...DRAFT, email: '  Ada@Example.com  ' }, 'ada@example.com')).toBe(
      true,
    );
  });

  it('rejects a different signed-in user (the shared-browser hijack)', () => {
    expect(draftMatchesUser(DRAFT, 'grace@example.com')).toBe(false);
  });

  // REGRESSION: v0 returned TRUE for all four of these, which is precisely how
  // an identity-less draft came to match whoever happened to be signed in.
  it('rejects a null draft', () => {
    expect(draftMatchesUser(null, 'ada@example.com')).toBe(false);
  });

  it('rejects a draft with no email', () => {
    expect(draftMatchesUser({ ...DRAFT, email: '' }, 'ada@example.com')).toBe(false);
  });

  it.each([[null], [undefined], ['']])('rejects an unresolved session email %p', (sessionEmail) => {
    expect(draftMatchesUser(DRAFT, sessionEmail as string | null | undefined)).toBe(false);
  });
});

describe('registration draft storage', () => {
  it('round-trips a stored draft', () => {
    storeRegistrationDraft(DRAFT);
    expect(readRegistrationDraft()).toEqual(DRAFT);
  });

  it('writes under the v1 key with a version and timestamp', () => {
    storeRegistrationDraft(DRAFT);
    const raw = JSON.parse(localStorage.getItem(V1_KEY) as string);
    expect(raw.v).toBe(1);
    expect(typeof raw.savedAt).toBe('number');
    expect(raw.email).toBe('ada@example.com');
  });

  it('PURGES a legacy v0 draft instead of migrating it', () => {
    // A v0 draft is identity-less by construction — exactly the artefact the
    // fix exists to remove. It must never be surfaced.
    localStorage.setItem(
      V0_KEY,
      JSON.stringify({ firstName: 'Mallory', lastName: 'X', orgName: 'Evil Corp' }),
    );
    expect(readRegistrationDraft()).toBeNull();
    expect(localStorage.getItem(V0_KEY)).toBeNull();
  });

  it('purges a legacy v0 draft even when a valid v1 draft exists', () => {
    localStorage.setItem(V0_KEY, JSON.stringify({ orgName: 'Evil Corp' }));
    storeRegistrationDraft(DRAFT);
    expect(readRegistrationDraft()).toEqual(DRAFT);
    expect(localStorage.getItem(V0_KEY)).toBeNull();
  });

  it('purges a legacy draft held in sessionStorage', () => {
    sessionStorage.setItem(V0_KEY, JSON.stringify({ orgName: 'Evil Corp' }));
    expect(readRegistrationDraft()).toBeNull();
    expect(sessionStorage.getItem(V0_KEY)).toBeNull();
  });

  it('rejects and clears a draft with no email', () => {
    localStorage.setItem(V1_KEY, JSON.stringify({ v: 1, savedAt: Date.now(), orgName: 'Acme' }));
    expect(readRegistrationDraft()).toBeNull();
    expect(localStorage.getItem(V1_KEY)).toBeNull();
  });

  it('rejects and clears a draft with an unknown schema version', () => {
    localStorage.setItem(
      V1_KEY,
      JSON.stringify({ ...DRAFT, v: 999, savedAt: Date.now() }),
    );
    expect(readRegistrationDraft()).toBeNull();
    expect(localStorage.getItem(V1_KEY)).toBeNull();
  });

  it('rejects and clears unparseable JSON', () => {
    localStorage.setItem(V1_KEY, '{not json');
    expect(readRegistrationDraft()).toBeNull();
    expect(localStorage.getItem(V1_KEY)).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(readRegistrationDraft()).toBeNull();
  });
});

describe('registration draft expiry', () => {
  it('still returns a draft just inside the TTL', () => {
    storeRegistrationDraft(DRAFT);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + REGISTRATION_DRAFT_TTL_MS - 60_000);
    expect(readRegistrationDraft()).toEqual(DRAFT);
  });

  it('discards and clears a draft past the TTL', () => {
    storeRegistrationDraft(DRAFT);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + REGISTRATION_DRAFT_TTL_MS + 60_000);
    expect(readRegistrationDraft()).toBeNull();
    expect(localStorage.getItem(V1_KEY)).toBeNull();
  });

  it('discards a draft with no savedAt stamp', () => {
    localStorage.setItem(V1_KEY, JSON.stringify({ ...DRAFT, v: 1 }));
    expect(readRegistrationDraft()).toBeNull();
  });

  it('uses a 24 hour TTL', () => {
    expect(REGISTRATION_DRAFT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('clearRegistrationDraft', () => {
  it('removes the v1 key and every legacy key from both storages', () => {
    storeRegistrationDraft(DRAFT);
    localStorage.setItem(V0_KEY, '{}');
    sessionStorage.setItem(V0_KEY, '{}');
    sessionStorage.setItem(V1_KEY, '{}');

    clearRegistrationDraft();

    expect(localStorage.getItem(V1_KEY)).toBeNull();
    expect(localStorage.getItem(V0_KEY)).toBeNull();
    expect(sessionStorage.getItem(V0_KEY)).toBeNull();
    expect(sessionStorage.getItem(V1_KEY)).toBeNull();
    expect(readRegistrationDraft()).toBeNull();
  });

  it('is safe to call when nothing is stored', () => {
    expect(() => clearRegistrationDraft()).not.toThrow();
  });
});
