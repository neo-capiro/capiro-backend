// Phase D (remediation plan §3.d2/d6) — missingGoogleGrants is the pure check
// that stops a partial-consent Google grant from being persisted as
// `connected`. Google's granular consent lets a user uncheck Gmail read/send
// on the OAuth screen and still come back with a valid access token.

import { describe, expect, test } from '@jest/globals';
import { GOOGLE_WORKSPACE_REQUIRED_GRANTS, GOOGLE_WORKSPACE_SCOPES } from '@capiro/shared';
import { missingGoogleGrants } from './google-oauth.service.js';

describe('missingGoogleGrants', () => {
  test('the full canonical scope list grants everything required', () => {
    expect(missingGoogleGrants(GOOGLE_WORKSPACE_SCOPES.join(' '))).toEqual([]);
  });

  test('a grant missing gmail.readonly returns exactly that one scope', () => {
    const granted = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events.readonly'].join(' ');
    expect(missingGoogleGrants(granted)).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
    ]);
  });

  test('undefined or empty scope is missing all required grants', () => {
    expect(missingGoogleGrants(undefined)).toEqual([...GOOGLE_WORKSPACE_REQUIRED_GRANTS]);
    expect(missingGoogleGrants('')).toEqual([...GOOGLE_WORKSPACE_REQUIRED_GRANTS]);
  });

  test('a superset grant (include_granted_scopes) still passes — subset test, not equality', () => {
    const granted = [...GOOGLE_WORKSPACE_SCOPES, 'https://www.googleapis.com/auth/drive.readonly'].join(
      ' ',
    );
    expect(missingGoogleGrants(granted)).toEqual([]);
  });
});
